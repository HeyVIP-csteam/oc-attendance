// Manual OT: an admin marks a roster day as OT by hand (the red OT badge). OT is counted in times: every day the roster
// shows the badge counts once in Attendance and Reports (a manual mark and a bot-confirmed OT on the same day = 1).
// The table is created / upgraded on first use, so a deploy does not depend on running migrations first.

let ready = false;

export async function ensureOtMarks(db: D1Database): Promise<void> {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS ot_marks (
      employee_id  INTEGER NOT NULL REFERENCES employees(id),
      work_date    TEXT NOT NULL,
      note         TEXT,
      created_by   TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      minutes      INTEGER,
      PRIMARY KEY (employee_id, work_date))`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ot_marks_date ON ot_marks(work_date)'),
  ]);
  // tables created by the first version (display-only marks) have no duration column yet
  try { await db.prepare('SELECT minutes FROM ot_marks LIMIT 0').all(); }
  catch { await db.prepare('ALTER TABLE ot_marks ADD COLUMN minutes INTEGER').run(); }
  ready = true;
}

/** Tests only: forget that the table was checked in this isolate. */
export const resetOtMarksForTests = () => { ready = false; };

/**
 * SQL: 1 when the session row `s` (with its shift instance `i`) counts as one OT, i.e. the roster shows the red OT badge:
 * marked by hand, worked on a day off (clock in + out, no active shift; not when the day-off question was answered No),
 * or OT confirmed through the bot. Else 0.
 */
export const OT_DAY_SQL = `(CASE WHEN EXISTS (SELECT 1 FROM ot_marks om WHERE om.employee_id = s.employee_id AND om.work_date = s.work_date)
  OR COALESCE(s.ot_ms, 0) > 0
  OR (s.actual_in_at IS NOT NULL AND s.actual_out_at IS NOT NULL AND (s.shift_instance_id IS NULL OR i.adjustment_status = 'CANCELLED')
      AND NOT EXISTS (SELECT 1 FROM ot_questions oq WHERE oq.employee_id = s.employee_id AND oq.work_date = s.work_date AND oq.kind = 'EARLY' AND oq.answer = 'NO'))
  THEN 1 ELSE 0 END)`;

/** SQL: manual OT marks of employee `e` on days without a session (they count too), for `BETWEEN ? AND ? AND <= ?`. */
export const OT_MARKS_WITHOUT_SESSION_SQL = `(SELECT COUNT(*) FROM ot_marks m WHERE m.employee_id = e.id AND m.work_date BETWEEN ? AND ? AND m.work_date <= ?
  AND NOT EXISTS (SELECT 1 FROM attendance_sessions s2 WHERE s2.employee_id = m.employee_id AND s2.work_date = m.work_date))`;
