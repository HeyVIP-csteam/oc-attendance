// Scheduled job (every 15 minutes, one cron trigger):
//   1. materialise sessions for today's / yesterday's shift instances (so no-shows become visible)
//   2. recompute sessions whose status can change with time (next_check_at), explicit dirty marks, and crash recovery
//   3. once per business day: generate instances from default-shift assignments and purge expired admin sessions
// Each run uses a bounded number of D1 queries (well below the per-invocation limits of the free plan).

import { addDays, localDate } from '../shared/time';
import type { Env } from './env';
import { log } from './lib/audit';
import { first, stmt } from './lib/db';
import { generateFromAssignments } from './lib/roster';
import { dueSessionKeys, recomputeMany } from './lib/sessions';
import { bizTz, loadSettings } from './lib/settings';

export async function runCron(env: Env, now = Date.now()): Promise<{ materialised: number; recomputed: number; generated: number }> {
  const db = env.DB;
  const tz = bizTz(env);
  const today = localDate(now, tz);
  const settings = await loadSettings(db);

  let generated = 0;
  const last = await first<{ value: string }>(db, "SELECT value FROM system_settings WHERE key = 'last_daily_run'");
  if (last?.value !== today) {
    generated = await generateFromAssignments(db, today, addDays(today, 13), now);
    await db.batch([
      stmt(db, 'DELETE FROM admin_sessions WHERE expires_at < ?', now),
      stmt(db, "INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES ('last_daily_run', ?, ?, 'cron') ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", today, now),
    ]);
  }

  const mat = await stmt(db, `INSERT INTO attendance_sessions (employee_id, work_date, shift_instance_id, state, status, computed_at, next_check_at)
      SELECT i.employee_id, i.shift_date, i.id, 'NOT_STARTED', 'SCHEDULED', 0, 0 FROM shift_instances i
      WHERE i.shift_date BETWEEN ? AND ? AND i.adjustment_status <> 'CANCELLED'
        AND NOT EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.employee_id = i.employee_id AND s.work_date = i.shift_date)`, addDays(today, -1), today).run();

  const keys = await dueSessionKeys(db, now, 200);
  if (keys.length) await recomputeMany(db, keys, { now, tz, rules: settings.rules, byCur: settings.rulesCur });

  const res = { materialised: mat.meta.changes ?? 0, recomputed: keys.length, generated };
  log('info', 'cron', res);
  return res;
}
