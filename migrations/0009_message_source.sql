-- Where a raw Telegram message came from: the bot's webhook, or an admin import of a Telegram Desktop chat export
-- (punches sent before the bot joined the group). Imported rows have no bot and a negative update_id.
ALTER TABLE telegram_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'WEBHOOK';
