// Shift instances: the per-day roster. Shift parameters are snapshotted into each instance so that later template
// edits never silently change past attendance results.

import type { Rules } from '../../shared/codes';
import { addDays, localDate, shiftWindow, weekday } from '../../shared/time';
import { all, chunk, stmt } from './db';
import { type Key, reassignEvents, recomputeOrDefer } from './sessions';

export interface ShiftTemplate {
  id: number; code: string; name: string; timezone: string; start_time: string; end_time: string;
  late_grace_min: number; early_grace_min: number; break_minutes: number | null; is_active: number; created_at: number; updated_at: number;
}

export type InstanceSource = 'ASSIGNMENT' | 'ROSTER_IMPORT' | 'MANUAL';
export type InstanceStatus = 'SCHEDULED' | 'ADJUSTED' | 'MANUAL';

export function upsertInstanceStmt(db: D1Database, employeeId: number, date: string, t: ShiftTemplate, source: InstanceSource, status: InstanceStatus,
  assignmentId: number | null, by: string, now: number): D1PreparedStatement {
  const w = shiftWindow(date, t.start_time, t.end_time, t.timezone);
  return stmt(db, `INSERT INTO shift_instances (employee_id, shift_date, shift_id, shift_code, shift_name, timezone, scheduled_start_at, scheduled_end_at,
      late_grace_min, early_grace_min, break_minutes, source, source_assignment_id, adjustment_status, created_at, updated_at, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (employee_id, shift_date) DO UPDATE SET shift_id = excluded.shift_id, shift_code = excluded.shift_code, shift_name = excluded.shift_name,
      timezone = excluded.timezone, scheduled_start_at = excluded.scheduled_start_at, scheduled_end_at = excluded.scheduled_end_at,
      late_grace_min = excluded.late_grace_min, early_grace_min = excluded.early_grace_min, break_minutes = excluded.break_minutes,
      source = excluded.source, source_assignment_id = COALESCE(excluded.source_assignment_id, shift_instances.source_assignment_id),
      adjustment_status = excluded.adjustment_status, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    employeeId, date, t.id, t.code, t.name, t.timezone, w.startAt, w.endAt, t.late_grace_min, t.early_grace_min, t.break_minutes,
    source, assignmentId, status, now, now, by);
}

export const cancelInstanceStmt = (db: D1Database, employeeId: number, date: string, by: string, now: number) =>
  stmt(db, "UPDATE shift_instances SET adjustment_status = 'CANCELLED', updated_at = ?, updated_by = ? WHERE employee_id = ? AND shift_date = ?", now, by, employeeId, date);

/**
 * Generates instances from default-shift assignments for [fromDate, toDate]. Existing instances (including cancelled
 * ones, which record an explicit OFF) are never overwritten.
 */
export async function generateFromAssignments(db: D1Database, fromDate: string, toDate: string, now: number): Promise<number> {
  const [asgR, instR, tplR] = await db.batch([
    stmt(db, `SELECT a.id, a.employee_id, a.shift_id, a.effective_from, a.effective_until, a.work_days, e.deactivated_at
              FROM employee_shift_assignments a JOIN employees e ON e.id = a.employee_id
              WHERE e.employment_status = 'ACTIVE' AND a.effective_from <= ? AND (a.effective_until IS NULL OR a.effective_until >= ?)`, toDate, fromDate),
    stmt(db, 'SELECT employee_id, shift_date FROM shift_instances WHERE shift_date BETWEEN ? AND ?', fromDate, toDate),
    stmt(db, 'SELECT * FROM shift_templates'),
  ]);
  const have = new Set((instR.results as { employee_id: number; shift_date: string }[]).map((r) => `${r.employee_id}|${r.shift_date}`));
  const tpl = new Map((tplR.results as unknown as ShiftTemplate[]).map((t) => [t.id, t]));
  const inserts: D1PreparedStatement[] = [];
  for (const a of asgR.results as { id: number; employee_id: number; shift_id: number; effective_from: string; effective_until: string | null; work_days: string }[]) {
    const t = tpl.get(a.shift_id);
    if (!t || !t.is_active) continue;
    for (let d = fromDate > a.effective_from ? fromDate : a.effective_from; d <= toDate && (!a.effective_until || d <= a.effective_until); d = addDays(d, 1)) {
      if (!a.work_days.includes(String(weekday(d)))) continue;
      const k = `${a.employee_id}|${d}`;
      if (have.has(k)) continue;
      have.add(k);
      const w = shiftWindow(d, t.start_time, t.end_time, t.timezone);
      inserts.push(stmt(db, `INSERT INTO shift_instances (employee_id, shift_date, shift_id, shift_code, shift_name, timezone, scheduled_start_at, scheduled_end_at,
          late_grace_min, early_grace_min, break_minutes, source, source_assignment_id, adjustment_status, created_at, updated_at, updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'ASSIGNMENT',?,'SCHEDULED',?,?, 'system') ON CONFLICT (employee_id, shift_date) DO NOTHING`,
        a.employee_id, d, t.id, t.code, t.name, t.timezone, w.startAt, w.endAt,
        t.late_grace_min, t.early_grace_min, t.break_minutes, a.id, now, now));
    }
  }
  for (const c of chunk(inserts, 90)) await db.batch(c);
  return inserts.length;
}

/**
 * After roster changes: re-assign events around the changed dates and recompute every affected session that is not in
 * the future (future dates have no events; their sessions are materialised by the cron job when they start).
 */
export async function afterInstancesChanged(db: D1Database, pairs: Key[], o: { now: number; tz: string; rules: Rules; byCur?: Record<string, Rules> }): Promise<{ inline: number; deferred: number }> {
  const today = localDate(o.now, o.tz);
  const relevant = pairs.filter(([, d]) => d <= addDays(today, 1));
  if (!relevant.length) return { inline: 0, deferred: 0 };
  const dates = relevant.map(([, d]) => d).sort();
  const { updates, keys } = await reassignEvents(db, relevant.map(([e]) => e), dates[0], dates[dates.length - 1], o, o.tz);
  for (const c of chunk(updates, 90)) await db.batch(c);
  return recomputeOrDefer(db, [...relevant, ...keys], o);
}

export async function loadTemplates(db: D1Database): Promise<ShiftTemplate[]> {
  return all<ShiftTemplate>(db, 'SELECT * FROM shift_templates ORDER BY code');
}
