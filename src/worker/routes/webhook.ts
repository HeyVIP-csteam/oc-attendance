import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { log } from '../lib/audit';
import { ConfigError, redact, safeEqual, webhookSecret } from '../lib/crypto';
import { ingestUpdate, type TgUpdate } from '../lib/ingest';
import { type BotRow, botToken, loadBot, sendReply } from '../lib/telegram';
import { askOtQuestions, handleOtCallback } from '../lib/otQuestions';
import { handleHoursCallback, sendHoursQuestion } from '../lib/hoursQuestions';

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
  const db = c.env.DB;
  const pathBot = await loadBot(db, code);
  if (!pathBot) return c.json({ ok: false }, 404);
  const got = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  // The update belongs to the bot whose webhook secret it carries. Several currencies may use one bot (they share the
  // secret), so the URL it arrives on does not matter. A NOT_SET row whose secret matches is accepted too: right
  // after "Save", Telegram may deliver queued updates before the ACTIVE status is written.
  let matches: BotRow[] = [];
  try {
    const secretOf = (b: BotRow) => webhookSecret(c.env.ENCRYPTION_KEY, b.secret_ref ?? b.id, b.secret_salt);
    if (safeEqual(got, await secretOf(pathBot))) matches.push(pathBot);
    const others = await db.prepare("SELECT * FROM telegram_bots WHERE id <> ? AND (status <> 'NOT_SET' OR secret_ref = ? OR id = ?)").bind(pathBot.id, pathBot.secret_ref ?? pathBot.id, pathBot.secret_ref ?? -1).all<BotRow>();
    for (const b of others.results ?? []) if (safeEqual(got, await secretOf(b))) matches.push(b);
  } catch (e) {
    log('error', 'webhook_config', { bot: code, error: e instanceof ConfigError ? e.message : 'secret derivation failed' });
    return c.json({ ok: false }, 500);
  }
  if (!matches.length) {
    log('warn', 'webhook_bad_secret', { bot: code });
    return c.json({ ok: false }, 401);
  }
  // prefer a running currency of this bot; only when every currency using it is stopped is the update refused
  const bot = matches.find((b) => b.status === 'ACTIVE') ?? matches.find((b) => b.status === 'NOT_SET' || b.status === 'ERROR');
  if (!bot) return c.json({ ok: false, status: 'BOT_STOPPED' }, 503);

  const len = Number(c.req.header('content-length') ?? '0');
  if (len > MAX_BODY) return c.json({ ok: true, status: 'IGNORED_TOO_LARGE' });
  let upd: TgUpdate;
  try {
    const text = await c.req.text();
    if (text.length > MAX_BODY) return c.json({ ok: true, status: 'IGNORED_TOO_LARGE' });
    upd = JSON.parse(text);
  } catch { return c.json({ ok: true, status: 'IGNORED_MALFORMED' }); }
  if (!upd || typeof upd !== 'object' || !Number.isInteger(upd.update_id)) return c.json({ ok: true, status: 'IGNORED_MALFORMED' });

  // a press on the buttons under an OT question (never stored as a punch)
  if (upd.callback_query) {
    try {
      const cq = upd.callback_query;
      const r = cq.data?.startsWith('hq:') ? await handleHoursCallback(c.env, bot, cq) : await handleOtCallback(c.env, bot, cq);
      log('info', 'webhook_callback', { bot: code, update_id: upd.update_id, result: r, ms: Date.now() - receivedAt });
    } catch (e) { log('error', 'webhook_callback_failed', { bot: code, update_id: upd.update_id, error: redact(String((e as Error).message)) }); }
    return c.json({ ok: true, status: 'CALLBACK' });
  }

  try {
    const r = await ingestUpdate(c.env, bot, upd, receivedAt);
    log('info', 'webhook', { bot: code, update_id: upd.update_id, status: r.status, codes: r.codes, ms: Date.now() - receivedAt });
    if (r.reply) {
      const m = (upd.message ?? upd.edited_message)!;
      const send = (async () => {
        try {
          const token = await botToken(c.env, bot);
          if (!token) return;
          // clocked out short of the shift length: the confirmation comes with the question and its buttons
          if (r.hours) await sendHoursQuestion(c.env, bot, token, r.hours);
          else await sendReply(token, m.chat.id, m.is_topic_message ? m.message_thread_id ?? null : null, m.message_id, r.reply!);
        } catch (e) { log('warn', 'bot_reply_failed', { bot: code, error: redact(String((e as Error).message)) }); }
      })();
      try { c.executionCtx.waitUntil(send); } catch { await send; }
    }
    // clocked in early → the bot asks whether it is OT (right away instead of at the next cron run)
    if (r.event === 'CLOCK_IN' && r.status === 'PROCESSED') {
      const ask = askOtQuestions(c.env, Date.now(), true).catch((e) => log('warn', 'ot_question_failed', { error: redact(String((e as Error).message)) }));
      try { c.executionCtx.waitUntil(ask); } catch { await ask; }
    }
    return c.json({ ok: true, status: r.status, codes: r.codes }, r.http as 200);
  } catch (e) {
    log('error', 'webhook_failed', { bot: code, update_id: upd.update_id, error: redact(String((e as Error).message)) });
    return c.json({ ok: false, status: 'STORAGE_ERROR' }, 500); // Telegram will retry; nothing partial was stored
  }
});
