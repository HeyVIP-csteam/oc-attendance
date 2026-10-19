-- Forgot clock-out reminder (Settings → Attendance rules → "Forgot clock-out reminder").
-- When the bot has sent the reminder for this session (NULL = not sent). One reminder per session.
ALTER TABLE attendance_sessions ADD COLUMN out_reminder_at INTEGER;
-- Missing clock out is now counted from the clock in (default 14 hours), not from the shift end: re-evaluate
-- open sessions of the last 3 days so their status and exceptions follow the new rule.
UPDATE attendance_sessions SET next_check_at = 0
WHERE actual_in_at IS NOT NULL AND actual_out_at IS NULL AND work_date >= date('now', '-3 days');
