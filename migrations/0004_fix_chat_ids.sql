-- Migration 0004 — topic bindings saved with a group id copied from a t.me/c/<id>/… link (missing the -100 prefix).
-- Supergroup chat ids are always "-100" followed by the id, so a positive chat_id can never match a group message.
UPDATE telegram_topic_mappings
SET chat_id = CAST('-100' || chat_id AS INTEGER), updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE chat_id > 0
  AND NOT EXISTS (SELECT 1 FROM telegram_topic_mappings m2
                  WHERE m2.chat_id = CAST('-100' || telegram_topic_mappings.chat_id AS INTEGER)
                    AND m2.message_thread_id = telegram_topic_mappings.message_thread_id AND m2.is_active = 1);

INSERT INTO audit_logs (created_at, actor, action, entity_type, entity_id, note)
VALUES (CAST(unixepoch('subsec') * 1000 AS INTEGER), 'migration', 'CHAT_IDS_NORMALISED', 'telegram_topic_mapping', '0004',
        'Chat ids saved without the -100 prefix were corrected');
