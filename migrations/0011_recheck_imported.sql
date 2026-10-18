-- Messages imported from a Telegram export were flagged "delayed delivery" (import time vs Telegram time).
-- The engine now treats them as on time; mark the affected days for recalculation (the cron job picks them up).
UPDATE attendance_sessions SET next_check_at = 0
WHERE EXISTS (SELECT 1 FROM attendance_events ev JOIN telegram_messages t ON t.id = ev.message_id
              WHERE t.source = 'IMPORT' AND ev.employee_id = attendance_sessions.employee_id AND ev.work_date = attendance_sessions.work_date);
