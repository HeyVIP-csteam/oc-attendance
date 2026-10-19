// Session assignment (which work date an event belongs to) and recomputation of computed tables.
// Everything derived — attendance_sessions, break_sessions, computed exceptions, events.sm_result — is rebuilt here
// from the immutable events + admin adjustments + the shift instance in force. Re-running it is always safe.

import { exceptionSeverity, FIXED, type EventType, type OtAnswer, type Rules } from '../../shared/codes';
import { computeSession, type EngineEvent, type EngineInstance, flagKey, hasMajor, runStateMachine, sortEvents, type SessionSummary } from '../../shared/engine';
import { addDays, fmtDateTime, HOUR, localDate, MIN, zonedToUtc } from '../../shared/time';
import { all, bumpVersion, chunk, stmt } from './db';

export type Key = [employeeId: number, workDate: string];
export const keyStr = (k: Key) => `${k[0]}|${k[1]}`;

export interface InstanceRow {
  id: number; employee_id: number; shift_date: string; shift_id: number; shift_code: string; shift_name: string; timezone: string;
  scheduled_start_at: number; scheduled_end_at: number; late_grace_min: number; early_grace_min: number; break_minutes: number | null;
  source: string; source_assignment_id: number | null; adjustment_status: string;
}

export interface CtxEvent { id: number; type: EventType; ts: number; tgMessageId: number | null; workDate: string; source: 'TELEGRAM' | 'ADMIN' }

/** OR-of-pairs condition. SQLite uses the (employee_id, work_date) index for each OR term. Max 50 pairs per statement. */
export function pairsWhere(pairs: Key[], a = 'employee_id', b = 'work_date'): { sql: string; params: unknown[] } {
  return { sql: '(' + pairs.map(() => `(${a} = ? AND ${b} = ?)`).join(' OR ') + ')', params: pairs.flatMap((p) => [p[0], p[1]]) };
}

export const toEngineInstance = (i: InstanceRow): EngineInstance => ({
  id: i.id, startAt: i.scheduled_start_at, endAt: i.scheduled_end_at, lateGraceMin: i.late_grace_min, earlyGraceMin: i.early_grace_min, breakMinutes: i.break_minutes,
});

/**
 * Chooses the work date for an event:
 *   1. BREAK / RESUME / OUT join a session that is still open (started < 20 h earlier);
 *   2. otherwise the shift instance whose window [start − W, end + W] contains the event (closest start wins; W = FIXED.shiftWindowHours);
 *   3. otherwise an open session (duplicate IN);
 *   4. otherwise the business-time-zone calendar date (an unscheduled punch).
 */
export function chooseWorkDate(ev: { type: EventType; ts: number }, ctx: CtxEvent[], instances: InstanceRow[], tz: string): string {
  const openDate = (): string | null => {
    const by = new Map<string, CtxEvent[]>();
    for (const c of ctx) {
      if (c.ts > ev.ts || ev.ts - c.ts > FIXED.openSessionMaxHours * HOUR) continue;
      const l = by.get(c.workDate) ?? [];
      l.push(c);
      by.set(c.workDate, l);
    }
    const dates = [...by.keys()].sort().reverse().slice(0, 4);
    for (const d of dates) {
      const evs = by.get(d)!.map((c) => ({ id: c.id, type: c.type, ts: c.ts, tgMessageId: c.tgMessageId, receivedAt: c.ts, source: c.source, voided: false }) as EngineEvent).sort(sortEvents);
      const sm = runStateMachine(evs);
      if ((sm.state === 'WORKING' || sm.state === 'ON_BREAK') && sm.inT != null && ev.ts - sm.inT < FIXED.openSessionMaxHours * HOUR) return d;
    }
    return null;
  };
  const findInstance = (): InstanceRow | null => {
    const W = FIXED.shiftWindowHours * HOUR;
    let best: InstanceRow | null = null;
    let bestD = Infinity;
    for (const i of instances) {
      if (i.adjustment_status === 'CANCELLED') continue;
      if (ev.ts >= i.scheduled_start_at - W && ev.ts <= i.scheduled_end_at + W) {
        const d = Math.abs(ev.ts - i.scheduled_start_at);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return best;
  };
  if (ev.type !== 'CLOCK_IN') { const d = openDate(); if (d) return d; }
  const inst = findInstance();
  if (inst) return inst.shift_date;
  return openDate() ?? localDate(ev.ts, tz);
}

/** Loads the context needed to assign one new event for an employee. */
export async function assignmentContext(db: D1Database, employeeId: number, ts: number): Promise<{ ctx: CtxEvent[]; instances: InstanceRow[] }> {
  const [evs, insts] = await db.batch([
    stmt(db, `SELECT id, event_type, event_ts, tg_message_id, work_date, source FROM attendance_events
              WHERE employee_id = ? AND is_voided = 0 AND event_ts BETWEEN ? AND ?`, employeeId, ts - FIXED.openSessionMaxHours * HOUR - HOUR, ts + HOUR),
    stmt(db, `SELECT * FROM shift_instances WHERE employee_id = ? AND adjustment_status <> 'CANCELLED'
              AND scheduled_start_at BETWEEN ? AND ?`, employeeId, ts - 40 * HOUR, ts + 16 * HOUR),
  ]);
  const ctx = (evs.results as { id: number; event_type: EventType; event_ts: number; tg_message_id: number | null; work_date: string; source: 'TELEGRAM' | 'ADMIN' }[])
    .map((r) => ({ id: r.id, type: r.event_type, ts: r.event_ts, tgMessageId: r.tg_message_id, workDate: r.work_date, source: r.source }));
  return { ctx, instances: insts.results as unknown as InstanceRow[] };
}

/**
 * Re-assigns Telegram events of the given employees between two business dates (after a roster change) and returns
 * the event updates plus every session key that has to be recomputed.
 */
export async function reassignEvents(db: D1Database, employeeIds: number[], fromDate: string, toDate: string, o: { rules: Rules; byCur?: Record<string, Rules> }, tz: string): Promise<{ updates: D1PreparedStatement[]; keys: Key[] }> {
  void o; // the matching window is fixed (FIXED.shiftWindowHours); the rules are not needed to assign events
  const updates: D1PreparedStatement[] = [];
  const keys = new Map<string, Key>();
  const add = (k: Key) => keys.set(keyStr(k), k);
  const fromTs = zonedToUtc(addDays(fromDate, -1), '00:00', tz);
  const toTs = zonedToUtc(addDays(toDate, 2), '00:00', tz);
  for (const ids of chunk([...new Set(employeeIds)], 40)) {
    const ph = ids.map(() => '?').join(',');
    const [evRes, instRes] = await db.batch([
      stmt(db, `SELECT id, employee_id, event_type, event_ts, tg_message_id, work_date, source FROM attendance_events
                WHERE employee_id IN (${ph}) AND is_voided = 0 AND event_ts BETWEEN ? AND ? ORDER BY event_ts, tg_message_id, id`, ...ids, fromTs, toTs),
      stmt(db, `SELECT * FROM shift_instances WHERE employee_id IN (${ph}) AND shift_date BETWEEN ? AND ? AND adjustment_status <> 'CANCELLED'`, ...ids, addDays(fromDate, -2), addDays(toDate, 2)),
    ]);
    const instByEmp = new Map<number, InstanceRow[]>();
    for (const i of instRes.results as unknown as InstanceRow[]) instByEmp.set(i.employee_id, [...(instByEmp.get(i.employee_id) ?? []), i]);
    const evByEmp = new Map<number, { id: number; employee_id: number; event_type: EventType; event_ts: number; tg_message_id: number | null; work_date: string; source: 'TELEGRAM' | 'ADMIN' }[]>();
    for (const e of evRes.results as never[] as { id: number; employee_id: number; event_type: EventType; event_ts: number; tg_message_id: number | null; work_date: string; source: 'TELEGRAM' | 'ADMIN' }[]) {
      evByEmp.set(e.employee_id, [...(evByEmp.get(e.employee_id) ?? []), e]);
    }
    for (const [empId, evs] of evByEmp) {
      const ctx: CtxEvent[] = [];
      for (const e of evs) {
        let d = e.work_date;
        if (e.source === 'TELEGRAM') d = chooseWorkDate({ type: e.event_type, ts: e.event_ts }, ctx, instByEmp.get(empId) ?? [], tz);
        ctx.push({ id: e.id, type: e.event_type, ts: e.event_ts, tgMessageId: e.tg_message_id, workDate: d, source: e.source });
        if (d !== e.work_date) {
          updates.push(stmt(db, 'UPDATE attendance_events SET work_date = ? WHERE id = ?', d, e.id));
          add([empId, e.work_date]);
          add([empId, d]);
        }
      }
    }
  }
  return { updates, keys: [...keys.values()] };
}

/** rules = fallback; byCur = per-currency rules (each employee is computed with the rules of their currency). */
export interface RecomputeOpts { now: number; tz: string; rules: Rules; byCur?: Record<string, Rules> }

/** Employee id → currency, for the employees given. */
export async function empCurrencies(db: D1Database, ids: number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  for (const part of chunk([...new Set(ids)], 90)) {
    const r = await all<{ id: number; currency_code: string | null }>(db, `SELECT id, currency_code FROM employees WHERE id IN (${part.map(() => '?').join(',')})`, ...part);
    for (const e of r) out.set(e.id, e.currency_code);
  }
  return out;
}

/** Returns a lookup employee id → rules (the rules of the employee's currency). */
export async function rulesLookup(db: D1Database, ids: number[], o: { rules: Rules; byCur?: Record<string, Rules> }): Promise<(empId: number) => Rules> {
  if (!o.byCur || !Object.keys(o.byCur).length || !ids.length) return () => o.rules;
  const cur = await empCurrencies(db, ids);
  return (id) => { const c = cur.get(id); return (c && o.byCur![c]) || o.rules; };
}

interface EvRow { id: number; employee_id: number; work_date: string; event_type: EventType; event_ts: number; tg_message_id: number | null; received_at: number; source: 'TELEGRAM' | 'ADMIN'; is_voided: number; sm_result: string | null; message_id: number | null }
interface ExRow { id: number; employee_id: number; work_date: string; dedupe_key: string; status: string; occurred_at: number; detail: string | null }
interface BrRow { session_id: number; employee_id: number; work_date: string; seq: number; start_at: number; end_at: number | null; duration_ms: number | null; status: string }

export interface Recomputed { key: Key; summary: SessionSummary | null; instance: InstanceRow | null }

/**
 * Recomputes sessions for the given keys. Reads are done with a constant number of statements per 40 keys and all
 * writes for a chunk go into one atomic batch.
 */
export async function recomputeMany(db: D1Database, keys: Key[], o: RecomputeOpts): Promise<Map<string, Recomputed>> {
  const out = new Map<string, Recomputed>();
  const uniq = [...new Map(keys.map((k) => [keyStr(k), k])).values()];
  const rulesOf = await rulesLookup(db, uniq.map((k) => k[0]), o);
  for (const part of chunk(uniq, 40)) {
    const w = pairsWhere(part);
    const wi = pairsWhere(part, 'employee_id', 'shift_date');
    const ws = pairsWhere(part, 's.employee_id', 's.work_date');
    const wm = pairsWhere(part, 'employee_id', 'mark_date');
    const [instR, evR, brR, exR, adjR, mkR, qR] = await db.batch([
      stmt(db, `SELECT * FROM shift_instances WHERE adjustment_status <> 'CANCELLED' AND ${wi.sql}`, ...wi.params),
      // a message imported from a Telegram export was not "delivered late": its arrival time is its Telegram time
      stmt(db, `SELECT id, employee_id, work_date, event_type, event_ts, tg_message_id,
                  CASE WHEN EXISTS (SELECT 1 FROM telegram_messages t WHERE t.id = attendance_events.message_id AND t.source = 'IMPORT') THEN event_ts ELSE received_at END AS received_at,
                  source, is_voided, sm_result, message_id
                FROM attendance_events WHERE ${w.sql}`, ...w.params),
      stmt(db, `SELECT b.session_id, s.employee_id, s.work_date, b.seq, b.start_at, b.end_at, b.duration_ms, b.status
                FROM break_sessions b JOIN attendance_sessions s ON s.id = b.session_id WHERE ${ws.sql}`, ...ws.params),
      stmt(db, `SELECT id, employee_id, work_date, dedupe_key, status, occurred_at, detail FROM attendance_exceptions
                WHERE source = 'COMPUTED' AND ${w.sql}`, ...w.params),
      stmt(db, `SELECT employee_id, work_date, COUNT(*) AS n FROM attendance_adjustments WHERE ${w.sql} GROUP BY employee_id, work_date`, ...w.params),
      // roster code OT = overtime on a day off
      stmt(db, `SELECT employee_id, mark_date FROM roster_marks WHERE code = 'OT' AND ${wm.sql}`, ...wm.params),
      stmt(db, `SELECT employee_id, work_date, kind, answer, asked_at FROM ot_questions WHERE ${w.sql}`, ...w.params),
    ]);
    const otDays = new Set((mkR.results as { employee_id: number; mark_date: string }[]).map((r) => `${r.employee_id}|${r.mark_date}`));
    const group = <T extends { employee_id: number }>(rows: T[], dateField: keyof T) => {
      const m = new Map<string, T[]>();
      for (const r of rows) { const k = `${r.employee_id}|${r[dateField] as string}`; m.set(k, [...(m.get(k) ?? []), r]); }
      return m;
    };
    const insts = group(instR.results as unknown as InstanceRow[], 'shift_date');
    const qs = group(qR.results as unknown as { employee_id: number; work_date: string; kind: 'EARLY' | 'LATE'; answer: OtAnswer | null; asked_at: number }[], 'work_date');
    const evs = group(evR.results as unknown as EvRow[], 'work_date');
    const brs = group(brR.results as unknown as BrRow[], 'work_date');
    const exs = group(exR.results as unknown as ExRow[], 'work_date');
    const adjs = new Map((adjR.results as { employee_id: number; work_date: string; n: number }[]).map((r) => [`${r.employee_id}|${r.work_date}`, r.n]));

    const writes: D1PreparedStatement[] = [];
    for (const key of part) {
      const [empId, date] = key;
      const ks = keyStr(key);
      const inst = insts.get(ks)?.[0] ?? null;
      const evRows = evs.get(ks) ?? [];
      const engineEvents: EngineEvent[] = evRows.map((e) => ({ id: e.id, type: e.event_type, ts: e.event_ts, tgMessageId: e.tg_message_id, receivedAt: e.received_at, source: e.source, voided: e.is_voided === 1 }));
      const summary = computeSession({ events: engineEvents, instance: inst ? toEngineInstance(inst) : null, now: o.now, rules: rulesOf(empId), tz: o.tz, otDay: otDays.has(ks),
        questions: (qs.get(ks) ?? []).map((q) => ({ kind: q.kind, answer: q.answer, askedAt: q.asked_at })) });
      out.set(ks, { key, summary, instance: inst });
      const existingEx = exs.get(ks) ?? [];

      // event state-machine results
      for (const e of evRows) {
        const r = e.is_voided ? null : (summary?.eventResults.get(e.id) ?? null);
        if ((e.sm_result ?? null) !== r) writes.push(stmt(db, 'UPDATE attendance_events SET sm_result = ? WHERE id = ?', r, e.id));
      }

      if (!summary) {
        writes.push(stmt(db, 'DELETE FROM attendance_sessions WHERE employee_id = ? AND work_date = ?', empId, date));
        for (const x of existingEx) if (x.status === 'OPEN') writes.push(stmt(db, 'DELETE FROM attendance_exceptions WHERE id = ?', x.id));
        continue;
      }
      const s = summary;
      writes.push(stmt(db, `INSERT INTO attendance_sessions (employee_id, work_date, shift_instance_id, state, status, missing, scheduled_start_at, scheduled_end_at,
          actual_in_at, actual_out_at, late_min, early_min, break_count, open_break_count, total_break_ms, shift_duration_ms, net_worked_ms, break_exceeded,
          exception_count, has_major_exception, adjusted, event_count, next_check_at, computed_at, ot_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (employee_id, work_date) DO UPDATE SET shift_instance_id = excluded.shift_instance_id, state = excluded.state, status = excluded.status,
          missing = excluded.missing, scheduled_start_at = excluded.scheduled_start_at, scheduled_end_at = excluded.scheduled_end_at, actual_in_at = excluded.actual_in_at,
          actual_out_at = excluded.actual_out_at, late_min = excluded.late_min, early_min = excluded.early_min, break_count = excluded.break_count,
          open_break_count = excluded.open_break_count, total_break_ms = excluded.total_break_ms, shift_duration_ms = excluded.shift_duration_ms,
          net_worked_ms = excluded.net_worked_ms, break_exceeded = excluded.break_exceeded, exception_count = excluded.exception_count,
          has_major_exception = excluded.has_major_exception, adjusted = excluded.adjusted, event_count = excluded.event_count,
          next_check_at = excluded.next_check_at, computed_at = excluded.computed_at, ot_ms = excluded.ot_ms`,
        empId, date, inst?.id ?? null, s.state, s.status, s.missing, s.schedIn, s.schedOut, s.inT, s.outT, s.lateMin, s.earlyMin, s.breakCount, s.openBreakCount,
        s.totalBreakMs, s.shiftDurMs, s.netMs, s.breakExceeded == null ? null : s.breakExceeded ? 1 : 0, s.flags.length, hasMajor(s.flags) ? 1 : 0,
        (adjs.get(ks) ?? 0) > 0 ? 1 : 0, s.eventCount, s.nextCheckAt, o.now, s.otMs || null));

      // breaks: rewrite only when they changed
      const oldB = (brs.get(ks) ?? []).sort((a, b) => a.seq - b.seq);
      const same = oldB.length === s.breaks.length && oldB.every((b, i) => b.start_at === s.breaks[i].start && b.end_at === s.breaks[i].end && b.duration_ms === s.breaks[i].durMs && b.status === s.breaks[i].status);
      if (!same) {
        writes.push(stmt(db, 'DELETE FROM break_sessions WHERE session_id = (SELECT id FROM attendance_sessions WHERE employee_id = ? AND work_date = ?)', empId, date));
        for (const b of s.breaks) {
          writes.push(stmt(db, `INSERT INTO break_sessions (session_id, seq, start_at, end_at, duration_ms, status)
                                VALUES ((SELECT id FROM attendance_sessions WHERE employee_id = ? AND work_date = ?), ?, ?, ?, ?, ?)`,
            empId, date, b.seq, b.start, b.end, b.durMs, b.status));
        }
      }

      // computed exceptions: insert new, refresh changed, drop open ones that no longer apply
      const byKey = new Map(existingEx.map((x) => [x.dedupe_key, x]));
      const msgOf = new Map(evRows.map((e) => [e.id, e.message_id]));
      const wanted = new Set<string>();
      for (const f of s.flags) {
        const dk = flagKey(empId, date, f);
        if (wanted.has(dk)) continue;
        wanted.add(dk);
        const detail = f.detail ? JSON.stringify(f.detail) : null;
        const cur = byKey.get(dk);
        if (!cur) {
          writes.push(stmt(db, `INSERT INTO attendance_exceptions (dedupe_key, source, code, severity, employee_id, work_date, occurred_at, message_id, event_id, detail, status, created_at, updated_at)
                                VALUES (?, 'COMPUTED', ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
            dk, f.code, exceptionSeverity(f.code), empId, date, f.ts, f.eventId ? (msgOf.get(f.eventId) ?? null) : null, f.eventId, detail, o.now, o.now));
        } else if (cur.occurred_at !== f.ts || cur.detail !== detail) {
          writes.push(stmt(db, 'UPDATE attendance_exceptions SET occurred_at = ?, detail = ?, updated_at = ? WHERE id = ?', f.ts, detail, o.now, cur.id));
        }
      }
      for (const x of existingEx) if (!wanted.has(x.dedupe_key) && x.status === 'OPEN') writes.push(stmt(db, 'DELETE FROM attendance_exceptions WHERE id = ?', x.id));
    }
    if (writes.length) {
      writes.push(bumpVersion(db, o.now));
      for (const c of chunk(writes, 90)) await db.batch(c);
    }
  }
  return out;
}

/** Marks sessions for asynchronous recomputation by the cron job (creates a placeholder when missing). */
export function markDirtyStmts(db: D1Database, keys: Key[]): D1PreparedStatement[] {
  return keys.map(([e, d]) => stmt(db, `INSERT INTO attendance_sessions (employee_id, work_date, state, status, computed_at, next_check_at)
      VALUES (?, ?, 'NOT_STARTED', 'SCHEDULED', 0, 0) ON CONFLICT (employee_id, work_date) DO UPDATE SET next_check_at = 0`, e, d));
}

/** Recompute inline when the set is small; otherwise leave it to the cron job (keeps every request well inside CPU/query limits). */
export async function recomputeOrDefer(db: D1Database, keys: Key[], o: RecomputeOpts, inlineMax = 40): Promise<{ inline: number; deferred: number }> {
  const uniq = [...new Map(keys.map((k) => [keyStr(k), k])).values()];
  const inline = uniq.slice(0, inlineMax);
  const rest = uniq.slice(inlineMax);
  if (inline.length) await recomputeMany(db, inline, o);
  if (rest.length) for (const c of chunk(markDirtyStmts(db, rest), 90)) await db.batch(c);
  return { inline: inline.length, deferred: rest.length };
}

export interface Snapshot { status: string; actual_in: string | null; actual_out: string | null; total_break_min: number; net_min: number | null }
export const snapshot = (s: SessionSummary | null | undefined, tz: string): Snapshot | null => s ? {
  status: s.status,
  actual_in: s.inT != null ? fmtDateTime(s.inT, tz) : null,
  actual_out: s.outT != null ? fmtDateTime(s.outT, tz) : null,
  total_break_min: Math.round(s.totalBreakMs / MIN),
  net_min: s.netMs == null ? null : Math.round(s.netMs / MIN),
} : null;

/** Session keys whose stored values may be stale: time-based re-checks, explicit dirty marks and crash recovery. */
export async function dueSessionKeys(db: D1Database, now: number, limit = 200): Promise<Key[]> {
  const [due, heal] = await db.batch([
    stmt(db, 'SELECT employee_id, work_date FROM attendance_sessions WHERE next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at LIMIT ?', now, limit),
    stmt(db, `SELECT DISTINCT e.employee_id, e.work_date FROM attendance_events e
              LEFT JOIN attendance_sessions s ON s.employee_id = e.employee_id AND s.work_date = e.work_date
              WHERE e.created_at > ? AND (s.id IS NULL OR s.computed_at < e.created_at) LIMIT 100`, now - 2 * HOUR),
  ]);
  const keys = new Map<string, Key>();
  for (const r of [...(due.results as { employee_id: number; work_date: string }[]), ...(heal.results as { employee_id: number; work_date: string }[])]) {
    keys.set(`${r.employee_id}|${r.work_date}`, [r.employee_id, r.work_date]);
  }
  return [...keys.values()];
}

export { all };
