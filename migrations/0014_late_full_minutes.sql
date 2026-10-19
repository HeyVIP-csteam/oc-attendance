-- Late / early leave minutes are now the full time from the scheduled start / to the scheduled end (the grace only
-- decides whether it counts). Recalculate every session that has late or early minutes (the cron does 200 per run).
UPDATE attendance_sessions SET next_check_at = 0 WHERE late_min > 0 OR early_min > 0;
