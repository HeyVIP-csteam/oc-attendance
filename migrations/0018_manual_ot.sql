-- Manual OT marks (Shifts & Roster → click a day → "OT mark"): an admin marks a day as OT by hand and the roster shows
-- the red OT badge on that day. Display only — attendance figures are not changed.
-- IF NOT EXISTS: the Worker also creates this table by itself on first use (src/worker/lib/otMarks.ts), so the app works
-- even before this migration is applied; applying it afterwards is harmless.
CREATE TABLE IF NOT EXISTS ot_marks (
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  work_date    TEXT NOT NULL,
  note         TEXT,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_ot_marks_date ON ot_marks(work_date);
