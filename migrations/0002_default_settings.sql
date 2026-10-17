-- Migration 0002 — default configuration (idempotent; safe on an existing database)
-- No employees, no admin users and no secrets are created here.
--   * admin users:  npm run admin:create
--   * bot tokens:   Settings → Bot Setting in the dashboard (stored encrypted) or `wrangler secret put TELEGRAM_BOT_TOKEN_<CODE>`

INSERT OR IGNORE INTO system_settings (key, value, updated_at, updated_by) VALUES
  ('keywords', '{"CLOCK_IN":["IN","CLOCK IN"],"BREAK_START":["BREAK","BREAK START"],"BREAK_END":["RESUME","BREAK END"],"CLOCK_OUT":["OUT","CLOCK OUT"]}', CAST(unixepoch('subsec') * 1000 AS INTEGER), 'migration'),
  ('rules', '{"windowHours":4,"lateAsException":false,"botReply":true,"allowedChats":[]}', CAST(unixepoch('subsec') * 1000 AS INTEGER), 'migration'),
  ('data_version', '1', CAST(unixepoch('subsec') * 1000 AS INTEGER), 'migration');

INSERT OR IGNORE INTO currencies (code, name, created_at, created_by) VALUES
  ('LKR', 'Sri Lankan Rupee',  CAST(unixepoch('subsec') * 1000 AS INTEGER), 'migration'),
  ('MYR', 'Malaysian Ringgit', CAST(unixepoch('subsec') * 1000 AS INTEGER), 'migration'),
  ('USD', 'US Dollar',         CAST(unixepoch('subsec') * 1000 AS INTEGER), 'migration');

-- Three-shift rotation (Asia/Colombo). Total break allowance 60 minutes per shift.
INSERT OR IGNORE INTO shift_templates (code, name, timezone, start_time, end_time, late_grace_min, early_grace_min, break_minutes, is_active, created_at, updated_at) VALUES
  ('A', 'A Shift', 'Asia/Colombo', '07:00', '15:00', 5, 5, 60, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('B', 'B Shift', 'Asia/Colombo', '15:00', '23:00', 5, 5, 60, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  ('C', 'C Shift', 'Asia/Colombo', '23:00', '07:00', 5, 5, 60, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER));
