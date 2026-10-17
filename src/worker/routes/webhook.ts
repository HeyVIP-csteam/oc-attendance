import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { log } from '../lib/audit';
import { ConfigError, redact, safeEqual, webhookSecret } from '../lib/crypto';
import { ingestUpdate, type TgUpdate } from '../lib/ingest';
import { botToken, loadBot, sendReply } from '../lib/telegram';

export const webhookRoutes = new Hono<AppBindings>();

const MAX_BODY = 64 * 1024;

/**
 * POST /api/telegram/webhook/:code   (one URL per currency bot)
 * Responses: 200 = handled (including ignored/duplicate) · 401 = wrong secret · 404 = unknown currency ·
 *            503 = bot stopped · 500 = storage failure (Telegram retries the update later).
 */
webhookRoutes.post('/webhook/:code', async (c) => {
  const receivedAt = Date.now();
  const code = c.req.param('code').toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(code)) return c.json({ ok: false }, 404);
  const bot = await loadBot(c.env.DB, code);
  // A NOT_SET bot is accepted when the secret matches: right after "Save", Telegram may deliver queued
  // updates before the ACTIVE status is written, and a 404 there would show up as a webhook error.
  if (!bot) return c.json({ ok: false }, 404);

  let expected: string;
  try { expected = await webhookSecret(c.env.ENCRYPTION_KEY, bot.id, bot.secret_salt); }
  catch (e) {
    log('error', 'webhook_config', { bot: code, error: e instanceof ConfigError ? e.message : 'secret derivation failed' });
    return c.json({ ok: false }, 500);
  }
  const got = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!safeEqual(got, expected)) {
    log('warn', 'webhook_bad_secret', { bot: code });
    return c.json({ ok: false }, 401);
  }
  if (bot.status === 'DISABLED') return c.json({ ok: false, status: 'BOT_STOPPED' }, 503);

  const len = Number(c.req.header('content-length') ?? '0');
  if (len > MAX_BODY) return c.json({ ok: true, status: 'IGNORED_TOO_LARGE' });
  let upd: TgUpdate;
  try {
    const text = await c.req.text();
    if (text.length > MAX_BODY) return c.json({ ok: true, status: 'IGNORED_TOO_LARGE' });
    upd = JSON.parse(text);
  } catch { return c.json({ ok: true, status: 'IGNORED_MALFORMED' }); }
  if (!upd || typeof upd !== 'object' || !Number.isInteger(upd.update_id)) return c.json({ ok: true, status: 'IGNORED_MALFORMED' });

  try {
    const r = await ingestUpdate(c.env, bot, upd, receivedAt);
    log('info', 'webhook', { bot: code, update_id: upd.update_id, status: r.status, codes: r.codes, ms: Date.now() - receivedAt });
    if (r.reply) {
      const m = (upd.message ?? upd.edited_message)!;
      const send = (async () => {
        try {
          const token = await botToken(c.env, bot);
          if (token) await sendReply(token, m.chat.id, m.is_topic_message ? m.message_thread_id ?? null : null, m.message_id, r.reply!);
        } catch (e) { log('warn', 'bot_reply_failed', { bot: code, error: redact(String((e as Error).message)) }); }
      })();
      try { c.executionCtx.waitUntil(send); } catch { await send; }
    }
    return c.json({ ok: true, status: r.status, codes: r.codes }, r.http as 200);
  } catch (e) {
    log('error', 'webhook_failed', { bot: code, update_id: upd.update_id, error: redact(String((e as Error).message)) });
    return c.json({ ok: false, status: 'STORAGE_ERROR' }, 500); // Telegram will retry; nothing partial was stored
  }
});
