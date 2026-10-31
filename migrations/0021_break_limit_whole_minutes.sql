-- Break limit ("Break limit exceeded") is now compared in whole minutes, as displayed: a daily total shown as 1h 30m
-- against a 90-minute allowance is within the limit; 1h 31m and more is over. Recalculate the days that were flagged
-- (the cron job does 200 per run); an open exception that no longer applies is removed by the recalculation.
UPDATE attendance_sessions SET next_check_at = 0 WHERE break_exceeded = 1;
