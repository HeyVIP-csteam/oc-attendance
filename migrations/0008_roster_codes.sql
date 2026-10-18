-- Roster codes: admin-defined codes for days that are not a work shift (OFF, VL, SL …), each with a meaning and a color.
-- The list lives in system_settings (key 'roster_codes'); a day marked with a code is stored in roster_marks.
-- A day has either a shift (shift_instances), a code (roster_marks), or nothing ("not scheduled").

CREATE TABLE IF NOT EXISTS roster_marks (
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  mark_date    TEXT NOT NULL,
  code         TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT,
  PRIMARY KEY (employee_id, mark_date)
);
CREATE INDEX IF NOT EXISTS idx_roster_marks_date ON roster_marks(mark_date);
CREATE INDEX IF NOT EXISTS idx_roster_marks_code ON roster_marks(code);

-- start with one code; it can be edited or deleted like any other
INSERT OR IGNORE INTO system_settings (key, value, updated_at, updated_by)
VALUES ('roster_codes', '[{"code":"OFF","name":"Day off","color":0}]', 0, 'migration');
