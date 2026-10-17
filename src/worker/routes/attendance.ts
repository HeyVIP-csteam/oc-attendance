import { Hono } from 'hono';
import { z } from 'zod';
import { EVENT_TYPES } from '../../shared/codes';
import { buildKeywordIndex, punchRemark } from '../../shared/parser';
import { addDays, dayDiff, fmtDateTime, isDate, localDate, MIN, zonedToUtc } from '../../shared/time';
import type { AppBindings } from '../env';
import { auditStmt } from '../lib/audit';
import { all, first, stmt } from '../lib/db';
import { bad, body, clientIp, intParam, notFound, query, requireAdminRole } from '../lib/http';
import { keyStr, recomputeMany, snapshot } from '../lib/sessions';
import { bizTz, loadSettings } from '../lib/settings';

export const attendanceRoutes = new Hono<AppBindings>();

const dateStr = z.string().refine(isDate, 'YYYY-MM-DD');
const PageSize = z.coerce.number().int().refine((n) => [10, 20, 30, 50, 100].includes(n)).default(10);

const Filters = z.object({
  from: dateStr, to: dateStr,
  cur: z.string().max(10).optional().default(''),
  shift: z.string().max(10).optional().default(''),
  status: z.string().max(20).optional().default(''),
  q: z.string().max(80).optional().default(''),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  size: PageSize,
  sort: z.string().max(20).optional().default('workDate'),
  dir: z.coerce.number().int().refine((n) => n === 1 || n === -1).default(-1),
});
type Filters = z.infer<typeof Filters>;

const SORT: Record<string, string> = {
  emp: 'e.employee_code', name: 'e.name', cur: 'e.currency_code', workDate: 's.work_date', shiftName: 'i.shift_name', schedIn: 's.scheduled_start_at', inT: 's.actual_in_at',
  lateMin: 's.late_min', schedOut: 's.scheduled_end_at', outT: 's.actual_out_at', earlyMin: 's.early_min', completedBreaks: 's.break_count',
  totalBreak: 's.total_break_ms', net: 's.net_worked_ms', status: 's.status', flags: 's.exception_count',
};

export const ROW_SELECT = `SELECT s.employee_id, s.work_date, e.employee_code, e.name, e.currency_code, i.shift_id, i.shift_code, i.shift_name, i.adjustment_status,
  s.scheduled_start_at, s.actual_in_at, s.late_min, s.scheduled_end_at, s.actual_out_at, s.early_min, s.break_count, s.open_break_count, s.total_break_ms,
  s.shift_duration_ms, s.net_worked_ms, s.status, s.state, s.missing, s.exception_count, s.has_major_exception, s.adjusted, s.break_exceeded, s.id AS session_id
  FROM attendance_sessions s JOIN employees e ON e.id = s.employee_id LEFT JOIN shift_instances i ON i.id = s.shift_instance_id`;

const likeEsc = (q: string) => `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;

export function sessionWhere(f: { from: string; to: string; cur?: string; shift?: string; status?: string; q?: string }, today: string): { sql: string; params: unknown[] } {
  if (dayDiff(f.to, f.from) > 400 || dayDiff(f.from, f.to) > 400) throw bad('RANGE', '日期范围最多 400 天', 'Date range is limited to 400 days');
  const [from, to] = f.from <= f.to ? [f.from, f.to] : [f.to, f.from];
  const c: string[] = ['s.work_date BETWEEN ? AND ?', 's.work_date <= ?'];
  const p: unknown[] = [from, to, today];
  if (f.cur) { c.push('e.currency_code = ?'); p.push(f.cur); }
  if (f.shift === 'none') c.push('s.shift_instance_id IS NULL');
  else if (f.shift) { c.push('i.shift_id = ?'); p.push(Number(f.shift)); }
  if (f.status === 'MISSING') c.push("s.missing <> 'NONE'");
  else if (f.status) { c.push('s.status = ?'); p.push(f.status); }
  if (f.q) { c.push("(e.employee_code LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\')"); p.push(likeEsc(f.q), likeEsc(f.q)); }
  return { sql: c.join(' AND '), params: p };
}

const todayOf = (c: { env: { BIZ_TZ?: string } }) => localDate(Date.now(), c.env.BIZ_TZ || 'Asia/Colombo');

// ---------------------------------------------------------------- Overview
attendanceRoutes.get('/overview', async (c) => {
  const f = query(c, z.object({ date: dateStr, cur: z.string().max(10).optional().default(''), shift: z.string().max(10).optional().default('') }));
  const db = c.env.DB;
  const now = Date.now();
  const from14 = addDays(f.date, -13);
  const empCond = f.cur ? ' AND e.currency_code = ?' : '';
  const empP = f.cur ? [f.cur] : [];
  const shiftCond = f.shift && f.shift !== 'none' ? ' AND i.shift_id = ?' : f.shift === 'none' ? ' AND 0' : '';
  const shiftP = f.shift && f.shift !== 'none' ? [Number(f.shift)] : [];
  const sShift = f.shift === 'none' ? ' AND s.shift_instance_id IS NULL' : f.shift ? ' AND i.shift_id = ?' : '';
  const [emps, exp, agg, trendI, trendS] = await db.batch([
    stmt(db, `SELECT COUNT(*) AS n FROM employees e WHERE e.employment_status = 'ACTIVE'${empCond}`, ...empP),
    stmt(db, `SELECT COUNT(*) AS expected, SUM(i.scheduled_start_at <= ?) AS started,
                SUM(i.scheduled_start_at <= ? AND EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.employee_id = i.employee_id AND s.work_date = i.shift_date AND s.actual_in_at IS NOT NULL)) AS started_present
              FROM shift_instances i JOIN employees e ON e.id = i.employee_id
              WHERE i.shift_date = ? AND i.adjustment_status <> 'CANCELLED'${empCond}${shiftCond}`, now, now, f.date, ...empP, ...shiftP),
    stmt(db, `SELECT SUM(s.status = 'WORKING') AS working, SUM(s.status = 'ON_BREAK') AS on_break, SUM(s.late_min > 0) AS late, SUM(COALESCE(s.late_min, 0)) AS late_min,
                SUM(s.early_min > 0) AS early, SUM(COALESCE(s.early_min, 0)) AS early_min, SUM(s.actual_in_at IS NOT NULL) AS clocked_in
              FROM attendance_sessions s JOIN employees e ON e.id = s.employee_id LEFT JOIN shift_instances i ON i.id = s.shift_instance_id
              WHERE s.work_date = ?${empCond}${sShift}`, f.date, ...empP, ...shiftP),
    stmt(db, `SELECT i.shift_date AS d, COUNT(*) AS expected FROM shift_instances i JOIN employees e ON e.id = i.employee_id
              WHERE i.shift_date BETWEEN ? AND ? AND i.adjustment_status <> 'CANCELLED'${empCond}${shiftCond} GROUP BY i.shift_date`, from14, f.date, ...empP, ...shiftP),
    stmt(db, `SELECT s.work_date AS d, SUM(s.actual_in_at IS NOT NULL) AS present, SUM(s.late_min > 0) AS late
              FROM attendance_sessions s JOIN employees e ON e.id = s.employee_id LEFT JOIN shift_instances i ON i.id = s.shift_instance_id
              WHERE s.work_date BETWEEN ? AND ?${empCond}${sShift} GROUP BY s.work_date`, from14, f.date, ...empP, ...shiftP),
  ]);
  const n = (v: unknown) => Number(v ?? 0);
  const e = exp.results[0] as Record<string, unknown>;
  const a = agg.results[0] as Record<string, unknown>;
  const ti = new Map((trendI.results as { d: string; expected: number }[]).map((r) => [r.d, r.expected]));
  const ts = new Map((trendS.results as { d: string; present: number; late: number }[]).map((r) => [r.d, r]));
  const trend = Array.from({ length: 14 }, (_, k) => {
    const d = addDays(from14, k);
    return { date: d, expected: n(ti.get(d)), present: n(ts.get(d)?.present), late: n(ts.get(d)?.late) };
  });
  return c.json({
    totalEmployees: n((emps.results[0] as { n: number }).n), expected: n(e.expected), started: n(e.started), startedPresent: n(e.started_present),
    working: n(a.working), onBreak: n(a.on_break), late: n(a.late), lateMin: n(a.late_min), early: n(a.early), earlyMin: n(a.early_min), clockedIn: n(a.clocked_in),
    trend,
  });
});

// ---------------------------------------------------------------- Attendance list + export
attendanceRoutes.get('/attendance', async (c) => {
  const f = query(c, Filters);
  const w = sessionWhere(f, todayOf(c));
  const order = `${SORT[f.sort] ?? 's.work_date'} ${f.dir > 0 ? 'ASC' : 'DESC'}, s.work_date DESC, e.employee_code ASC`;
  const db = c.env.DB;
  const [cnt, rows] = await db.batch([
    stmt(db, `SELECT COUNT(*) AS n FROM attendance_sessions s JOIN employees e ON e.id = s.employee_id LEFT JOIN shift_instances i ON i.id = s.shift_instance_id WHERE ${w.sql}`, ...w.params),
    stmt(db, `${ROW_SELECT} WHERE ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...w.params, f.size, (f.page - 1) * f.size),
  ]);
  return c.json({ total: (cnt.results[0] as { n: number }).n, rows: rows.results });
});

attendanceRoutes.get('/attendance/export', async (c) => {
  const f = query(c, Filters.omit({ page: true, size: true }));
  const w = sessionWhere(f, todayOf(c));
  const rows = await all(c.env.DB, `${ROW_SELECT} WHERE ${w.sql} ORDER BY s.work_date DESC, e.employee_code ASC LIMIT 20000`, ...w.params);
  const now = Date.now();
  await auditStmt(c.env.DB, { actor: c.get('admin').username, action: 'DATA_EXPORTED', entityType: 'report', entityId: `attendance_${f.from}_${f.to}`, after: { rows: rows.length, filters: f }, ip: clientIp(c), at: now }).run();
  return c.json({ rows });
});

// ---------------------------------------------------------------- Session detail
attendanceRoutes.get('/sessions/:emp/:date', async (c) => {
  const emp = intParam(c, 'emp');
  const date = c.req.param('date');
  if (!isDate(date)) throw bad('VALIDATION', '日期无效', 'Invalid date');
  const db = c.env.DB;
  const [empR, instR, sessR, evR, brR, exR, adjR] = await db.batch([
    stmt(db, 'SELECT id, employee_code, name, currency_code, employment_status FROM employees WHERE id = ?', emp),
    stmt(db, 'SELECT * FROM shift_instances WHERE employee_id = ? AND shift_date = ?', emp, date),
    stmt(db, 'SELECT * FROM attendance_sessions WHERE employee_id = ? AND work_date = ?', emp, date),
    stmt(db, `SELECT ev.id, ev.event_type, ev.event_ts, ev.source, ev.is_voided, ev.sm_result, ev.adjustment_id, ev.voided_by_adjustment_id, ev.received_at,
                m.id AS raw_id, m.raw_text, m.message_id AS tg_message_id, m.message_thread_id, m.from_user_id, m.telegram_message_ts, m.received_at AS raw_received_at, m.processed_at
              FROM attendance_events ev LEFT JOIN telegram_messages m ON m.id = ev.message_id
              WHERE ev.employee_id = ? AND ev.work_date = ? ORDER BY ev.event_ts, ev.tg_message_id, ev.id`, emp, date),
    stmt(db, `SELECT b.seq, b.start_at, b.end_at, b.duration_ms, b.status, ${BREAK_TEXT} AS start_text FROM break_sessions b JOIN attendance_sessions s ON s.id = b.session_id WHERE s.employee_id = ? AND s.work_date = ? ORDER BY b.seq`, emp, date),
    stmt(db, 'SELECT id, code, severity, occurred_at, detail, status, source FROM attendance_exceptions WHERE employee_id = ? AND work_date = ? ORDER BY occurred_at', emp, date),
    stmt(db, 'SELECT id, action, event_type, event_ts, target_event_id, reason, before_json, after_json, created_by, created_at FROM attendance_adjustments WHERE employee_id = ? AND work_date = ? ORDER BY id', emp, date),
  ]);
  const employee = empR.results[0];
  if (!employee) throw notFound('Employee not found');
  return c.json({
    employee, workDate: date, instance: instR.results[0] ?? null, session: sessR.results[0] ?? null,
    events: evR.results, breaks: await withRemarks(db, brR.results as { start_text: string | null }[]), exceptions: exR.results, adjustments: adjR.results,
  });
});

const AdjSchema = z.object({
  action: z.enum(['ADD_EVENT', 'VOID_EVENT']),
  eventType: z.enum(EVENT_TYPES).optional(),
  ts: z.number().int().optional(),
  targetEventId: z.number().int().optional(),
  reason: z.string().trim().min(4).max(500),
});

export async function applyAdjustment(env: AppBindings['Bindings'], actor: string, ip: string, emp: number, date: string, a: z.infer<typeof AdjSchema>) {
  const db = env.DB;
  const tz = bizTz(env);
  const now = Date.now();
  const employee = await first<{ id: number; employee_code: string }>(db, 'SELECT id, employee_code FROM employees WHERE id = ?', emp);
  if (!employee) throw notFound('Employee not found');
  const settings = await loadSettings(db);
  const before = (await recomputeMany(db, [[emp, date]], { now, tz, rules: settings.rules })).get(keyStr([emp, date]))?.summary ?? null;
  const ins = `INSERT INTO attendance_adjustments (employee_id, work_date, action, event_type, event_ts, target_event_id, reason, before_json, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`;
  const beforeSnap = snapshot(before, tz);
  const statements: D1PreparedStatement[] = [];
  if (a.action === 'ADD_EVENT') {
    if (!a.eventType || a.ts == null) throw bad('VALIDATION', '请选择事件类型和时间', 'Event type and time are required');
    const lo = zonedToUtc(addDays(date, -1), '00:00', tz);
    const hi = zonedToUtc(addDays(date, 2), '00:00', tz);
    if (a.ts < lo || a.ts >= hi) throw bad('TIME_RANGE', '时间必须在该考勤日前后 1 天内', 'The time must be within one day of the work date');
    if (a.ts > now + MIN) throw bad('TIME_FUTURE', '不能补录未来的时间', 'Cannot add an event in the future');
    statements.push(
      stmt(db, ins, emp, date, 'ADD_EVENT', a.eventType, a.ts, null, a.reason, JSON.stringify(beforeSnap), actor, now),
      stmt(db, `INSERT INTO attendance_events (adjustment_id, employee_id, work_date, event_type, event_ts, received_at, source, created_at)
                VALUES (last_insert_rowid(), ?, ?, ?, ?, ?, 'ADMIN', ?)`, emp, date, a.eventType, a.ts, now, now),
    );
  } else {
    if (!a.targetEventId) throw bad('VALIDATION', '缺少要作废的事件', 'targetEventId is required');
    const ev = await first<{ id: number; is_voided: number }>(db, 'SELECT id, is_voided FROM attendance_events WHERE id = ? AND employee_id = ? AND work_date = ?', a.targetEventId, emp, date);
    if (!ev) throw notFound('Event not found in this session');
    if (ev.is_voided) throw bad('ALREADY_VOIDED', '此事件已作废', 'This event is already voided');
    statements.push(
      stmt(db, ins, emp, date, 'VOID_EVENT', null, null, a.targetEventId, a.reason, JSON.stringify(beforeSnap), actor, now),
      stmt(db, 'UPDATE attendance_events SET is_voided = 1, voided_by_adjustment_id = last_insert_rowid() WHERE id = ?', a.targetEventId),
    );
  }
  await db.batch(statements);
  const after = (await recomputeMany(db, [[emp, date]], { now: Date.now(), tz, rules: settings.rules })).get(keyStr([emp, date]))?.summary ?? null;
  const afterSnap = snapshot(after, tz);
  const what = a.action === 'ADD_EVENT' ? `Added ${a.eventType} @ ${fmtDateTime(a.ts!, tz)}` : `Voided event #${a.targetEventId}`;
  await db.batch([
    stmt(db, 'UPDATE attendance_adjustments SET after_json = ? WHERE id = (SELECT MAX(id) FROM attendance_adjustments WHERE employee_id = ? AND work_date = ? AND created_at = ?)', JSON.stringify(afterSnap), emp, date, now),
    auditStmt(db, { actor, action: 'ATTENDANCE_ADJUSTED', entityType: 'attendance_session', entityId: `${employee.employee_code}@${date}`, before: beforeSnap, after: afterSnap, note: `${what}; reason: ${a.reason}`, ip, at: now }),
  ]);
  return { before: beforeSnap, after: afterSnap };
}

attendanceRoutes.post('/sessions/:emp/:date/adjustments', async (c) => {
  requireAdminRole(c);
  const emp = intParam(c, 'emp');
  const date = c.req.param('date');
  if (!isDate(date)) throw bad('VALIDATION', '日期无效', 'Invalid date');
  const a = await body(c, AdjSchema);
  return c.json(await applyAdjustment(c.env, c.get('admin').username, clientIp(c), emp, date, a));
});

// ---------------------------------------------------------------- Breaks
/** The Telegram text that started a break (e.g. "Lunch Break - 60 mins", "WC"); admin-added breaks have none. */
const BREAK_TEXT = `(SELECT m.raw_text FROM attendance_events ev JOIN telegram_messages m ON m.id = ev.message_id
  WHERE ev.employee_id = s.employee_id AND ev.work_date = s.work_date AND ev.event_type = 'BREAK_START' AND ev.is_voided = 0 AND ev.event_ts = b.start_at
  ORDER BY ev.id LIMIT 1)`;
async function withRemarks<T extends { start_text: string | null }>(db: D1Database, rows: T[]): Promise<(Omit<T, 'start_text'> & { remark: string | null })[]> {
  if (!rows.some((r) => r.start_text)) return rows.map(({ start_text: _t, ...r }) => ({ ...r, remark: null }));
  const idx = buildKeywordIndex((await loadSettings(db)).keywords);
  return rows.map(({ start_text, ...r }) => ({ ...r, remark: start_text ? punchRemark(start_text, idx) ?? start_text.split(/\r?\n/)[0].slice(0, 80) : null }));
}

attendanceRoutes.get('/breaks', async (c) => {
  const f = query(c, Filters.pick({ from: true, to: true, cur: true, q: true, page: true, size: true }));
  const w = sessionWhere(f, todayOf(c));
  const db = c.env.DB;
  const cond = `${w.sql} AND (s.break_count + s.open_break_count) > 0`;
  const [cnt, rows] = await db.batch([
    stmt(db, `SELECT COUNT(*) AS n FROM attendance_sessions s JOIN employees e ON e.id = s.employee_id LEFT JOIN shift_instances i ON i.id = s.shift_instance_id WHERE ${cond}`, ...w.params),
    stmt(db, `${ROW_SELECT} WHERE ${cond} ORDER BY s.work_date DESC, e.employee_code ASC LIMIT ? OFFSET ?`, ...w.params, f.size, (f.page - 1) * f.size),
  ]);
  const ids = (rows.results as { session_id: number }[]).map((r) => r.session_id);
  const breaks = ids.length ? await all<{ start_text: string | null }>(db, `SELECT b.session_id, b.seq, b.start_at, b.end_at, b.duration_ms, b.status, ${BREAK_TEXT} AS start_text
    FROM break_sessions b JOIN attendance_sessions s ON s.id = b.session_id WHERE b.session_id IN (${ids.map(() => '?').join(',')}) ORDER BY b.session_id, b.seq`, ...ids) : [];
  return c.json({ total: (cnt.results[0] as { n: number }).n, rows: rows.results, breaks: await withRemarks(c.env.DB, breaks) });
});

// ---------------------------------------------------------------- Reports
attendanceRoutes.get('/reports', async (c) => {
  const f = query(c, Filters);
  const w = sessionWhere(f, todayOf(c));
  const db = c.env.DB;
  const FROM = 'FROM attendance_sessions s JOIN employees e ON e.id = s.employee_id LEFT JOIN shift_instances i ON i.id = s.shift_instance_id';
  if (!f.status) {
    const [cnt, rows] = await db.batch([
      stmt(db, `SELECT COUNT(DISTINCT s.employee_id) AS n ${FROM} WHERE ${w.sql}`, ...w.params),
      stmt(db, `SELECT e.id AS employee_id, e.employee_code, e.name, e.currency_code,
                  COUNT(s.shift_instance_id) AS scheduled, SUM(s.actual_in_at IS NOT NULL) AS present, SUM(s.status = 'ABSENT') AS absent,
                  SUM(s.late_min > 0) AS late_times, SUM(COALESCE(s.late_min, 0)) AS late_min, SUM(s.early_min > 0) AS early_times, SUM(COALESCE(s.early_min, 0)) AS early_min,
                  SUM(s.break_count) AS breaks, SUM(s.total_break_ms) AS break_ms,
                  SUM(CASE WHEN s.net_worked_ms IS NOT NULL THEN s.shift_duration_ms ELSE 0 END) AS shift_ms, SUM(s.exception_count) AS exceptions
                ${FROM} WHERE ${w.sql} GROUP BY e.id ORDER BY e.employee_code LIMIT ? OFFSET ?`, ...w.params, f.size, (f.page - 1) * f.size),
    ]);
    return c.json({ mode: 'summary', total: (cnt.results[0] as { n: number }).n, rows: rows.results });
  }
  const [cnt, rows] = await db.batch([
    stmt(db, `SELECT COUNT(*) AS n ${FROM} WHERE ${w.sql}`, ...w.params),
    stmt(db, `${ROW_SELECT} WHERE ${w.sql} ORDER BY s.work_date DESC, e.employee_code ASC LIMIT ? OFFSET ?`, ...w.params, f.size, (f.page - 1) * f.size),
  ]);
  return c.json({ mode: 'detail', total: (cnt.results[0] as { n: number }).n, rows: rows.results });
});
