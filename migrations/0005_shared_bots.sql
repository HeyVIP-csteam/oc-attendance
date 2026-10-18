-- Migration 0005 — one Telegram bot may serve several currencies.
-- Telegram allows ONE webhook per bot, so the first currency that uses a bot owns its webhook ("primary") and the
-- other currencies point at it with shared_from = <primary currency code>. Employees are still identified by topic.
ALTER TABLE telegram_bots ADD COLUMN shared_from TEXT;
