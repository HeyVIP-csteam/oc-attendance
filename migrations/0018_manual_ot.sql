-- Manual OT (Shifts & Roster → click a day → "OT"): an admin marks a day as OT by hand with its duration. The roster shows
-- the red OT badge; the minutes count as that day's OT in Attendance and Reports (replacing bot-confirmed OT that day).
-- IF NOT EXISTS: the Worker also creates this table by itself on first use (src/worker/lib/otMarks.ts), so the app works
-- even before this migration is applied; applying it afterwards is harmless.
CREATE TABLE IF NOT EXISTS ot_marks (
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  work_date    TEXT NOT NULL,
  note         TEXT,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  minutes      INTEGER,
  PRIMARY KEY (employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_ot_marks_date ON ot_marks(work_date);
