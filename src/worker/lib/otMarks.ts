// Manual OT marks: an admin marks a roster day as OT by hand (the red OT badge). Display only.
// The table is created on first use, so a deploy does not depend on running migration 0018 first.

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
      PRIMARY KEY (employee_id, work_date))`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_ot_marks_date ON ot_marks(work_date)'),
  ]);
  ready = true;
}
