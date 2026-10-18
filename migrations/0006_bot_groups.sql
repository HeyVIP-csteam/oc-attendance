-- Migration 0006 — several currencies can use the same Telegram bot, each stopped / cleaned / switched on its own.
-- Rows using the same bot (tg_bot_id) share one webhook secret (secret_ref + secret_salt), because Telegram allows
-- only one webhook per bot. Incoming updates are matched by that secret, whatever currency URL they arrive on.
ALTER TABLE telegram_bots ADD COLUMN tg_bot_id INTEGER;   -- Telegram bot id (not unique: several currencies may use one bot)
ALTER TABLE telegram_bots ADD COLUMN secret_ref INTEGER;  -- row id the webhook secret is derived from (NULL = own id)
ALTER TABLE telegram_bots ADD COLUMN tg_url TEXT;         -- where the bot's webhook points (shared by the group)

UPDATE telegram_bots SET tg_bot_id = bot_user_id, tg_url = webhook_url WHERE bot_user_id IS NOT NULL;

-- rows saved with the short-lived "shared_from" model (migration 0005) become ordinary group members
UPDATE telegram_bots SET
  tg_bot_id  = (SELECT p.bot_user_id FROM telegram_bots p WHERE p.currency_code = telegram_bots.shared_from),
  secret_ref = (SELECT p.id FROM telegram_bots p WHERE p.currency_code = telegram_bots.shared_from),
  secret_salt = COALESCE((SELECT p.secret_salt FROM telegram_bots p WHERE p.currency_code = telegram_bots.shared_from), secret_salt),
  tg_url     = (SELECT p.webhook_url FROM telegram_bots p WHERE p.currency_code = telegram_bots.shared_from),
  shared_from = NULL
WHERE shared_from IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bots_tg_bot ON telegram_bots(tg_bot_id);
