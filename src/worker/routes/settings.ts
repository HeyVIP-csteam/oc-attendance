import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { EVENT_TYPES, FIXED, type KeywordConfig } from '../../shared/codes';
import { validateKeywords } from '../../shared/parser';
import { addDays, localDate } from '../../shared/time';
import type { AppBindings, Env } from '../env';
import { auditStmt } from '../lib/audit';
import { encryptString, randomBytes, webhookSecret } from '../lib/crypto';
import { all, first, stmt } from '../lib/db';
import { ApiError, bad, body, clientIp, conflict, notFound, requireAdminRole } from '../lib/http';
import { reparsePending } from '../lib/ingest';
import { bizTz, loadSettings } from '../lib/settings';
import { ALLOWED_UPDATES, type BotRow, botToken, hasSecretToken, loadBot, TelegramError, tgCall, type TgUser, type TgWebhookInfo, TOKEN_RE } from '../lib/telegram';

export const settingsRoutes = new Hono<AppBindings>();

const bump = (db: D1Database, now: number) => stmt(db, "UPDATE system_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ? WHERE key = 'data_version'", now);

// ---------------------------------------------------------------- meta (one call per page load) and polling version
settingsRoutes.get('/meta', async (c) => {
  const db = c.env.DB;
  const tz = bizTz(c.env);
  const [cur, sh, emps] = await db.batch([
    stmt(db, `SELECT c.code, c.name, (SELECT COUNT(*) FROM employees e WHERE e.currency_code = c.code) AS employees,
                (SELECT COUNT(*) FROM employees e WHERE e.currency_code = c.code AND e.employment_status = 'ACTIVE') AS active_employees
              FROM currencies c ORDER BY c.code`),
    stmt(db, 'SELECT * FROM shift_templates ORDER BY code'),
    stmt(db, `SELECT e.id, e.employee_code AS code, e.name, e.currency_code AS currency, e.employment_status AS status, m.message_thread_id AS thread
              FROM employees e LEFT JOIN telegram_topic_mappings m ON m.employee_id = e.id AND m.is_active = 1 ORDER BY e.employee_code`),
  ]);
  const settings = await loadSettings(db);
  return c.json({
    user: c.get('admin'), tz, today: localDate(Date.now(), tz), now: Date.now(),
    currencies: cur.results, shifts: sh.results, employees: emps.results,
    keywords: settings.keywords, rules: settings.rules, fixed: FIXED, dataVersion: settings.dataVersion,
  });
});

settingsRoutes.get('/version', async (c) => {
  const r = await first<{ value: string }>(c.env.DB, "SELECT value FROM system_settings WHERE key = 'data_version'");
  return c.json({ v: Number(r?.value ?? 0) });
});

// ---------------------------------------------------------------- keywords & rules
const KwSchema = z.object(Object.fromEntries(EVENT_TYPES.map((k) => [k, z.array(z.string().trim().min(1).max(40)).min(1).max(20)])) as Record<(typeof EVENT_TYPES)[number], z.ZodArray<z.ZodString>>);

settingsRoutes.put('/settings/keywords', async (c) => {
  requireAdminRole(c);
  const { keywords } = await body(c, z.object({ keywords: KwSchema }));
  const kw = Object.fromEntries(Object.entries(keywords).map(([k, v]) => [k, [...new Set(v)]])) as unknown as KeywordConfig;
  const err = validateKeywords(kw);
  if (err) throw bad('KEYWORDS', err.zh, err.en);
  const db = c.env.DB;
  const now = Date.now();
  const before = await loadSettings(db);
  await db.batch([
    stmt(db, "UPDATE system_settings SET value = ?, updated_at = ?, updated_by = ? WHERE key = 'keywords'", JSON.stringify(kw), now, c.get('admin').username),
    auditStmt(db, { actor: c.get('admin').username, action: 'SETTINGS_UPDATED', entityType: 'system_settings', entityId: 'keywords', before: before.keywords, after: kw, ip: clientIp(c), at: now }),
    bump(db, now),
  ]);
  return c.json({ ok: true });
});

const RulesSchema = z.object({
  windowHours: z.number().int().min(1).max(8),
  lateAsException: z.boolean(),
  botReply: z.boolean(),
  allowedChats: z.array(z.union([z.number().int(), z.string().regex(/^-?\d{5,20}$/)])).max(50),
});

settingsRoutes.put('/settings/rules', async (c) => {
  requireAdminRole(c);
  const v = await body(c, RulesSchema);
  const rules = { ...v, allowedChats: [...new Set(v.allowedChats.map((c) => (/^\d{5,17}$/.test(String(c)) ? Number('-100' + c) : Number(c))))] };
  const db = c.env.DB;
  const now = Date.now();
  const before = await loadSettings(db);
  const statements = [
    stmt(db, "UPDATE system_settings SET value = ?, updated_at = ?, updated_by = ? WHERE key = 'rules'", JSON.stringify(rules), now, c.get('admin').username),
    auditStmt(db, { actor: c.get('admin').username, action: 'SETTINGS_UPDATED', entityType: 'system_settings', entityId: 'rules', before: before.rules, after: rules, ip: clientIp(c), at: now }),
    bump(db, now),
  ];
  // rules that change computed results → re-evaluate the last 31 days in the background (cron, 200 sessions per run)
  if (before.rules.lateAsException !== rules.lateAsException || before.rules.windowHours !== rules.windowHours) {
    statements.push(stmt(db, 'UPDATE attendance_sessions SET next_check_at = 0 WHERE work_date >= ?', addDays(localDate(now, bizTz(c.env)), -31)));
  }
  await db.batch(statements);
  return c.json({ ok: true });
});

settingsRoutes.post('/messages/reparse', async (c) => {
  requireAdminRole(c);
  const now = Date.now();
  const n = await reparsePending(c.env, c.get('admin').username, now);
  if (n) await auditStmt(c.env.DB, { actor: c.get('admin').username, action: 'MESSAGES_REPARSED', entityType: 'telegram_messages', entityId: 'pending', after: { count: n }, ip: clientIp(c), at: now }).run();
  return c.json({ count: n });
});

// ---------------------------------------------------------------- currencies
settingsRoutes.post('/currencies', async (c) => {
  requireAdminRole(c);
  const v = await body(c, z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/), name: z.string().trim().max(60).optional().default('') }));
  const db = c.env.DB;
  const now = Date.now();
  if (await first(db, 'SELECT code FROM currencies WHERE code = ?', v.code)) throw conflict('EXISTS', `${v.code} 已存在`, `${v.code} already exists`);
  await db.batch([
    stmt(db, 'INSERT INTO currencies (code, name, created_at, created_by) VALUES (?,?,?,?)', v.code, v.name || v.code, now, c.get('admin').username),
    auditStmt(db, { actor: c.get('admin').username, action: 'CURRENCY_ADDED', entityType: 'currency', entityId: v.code, after: { code: v.code, name: v.name || v.code }, ip: clientIp(c), at: now }),
    bump(db, now),
  ]);
  return c.json({ ok: true });
});

settingsRoutes.delete('/currencies/:code', async (c) => {
  requireAdminRole(c);
  const code = c.req.param('code').toUpperCase();
  const db = c.env.DB;
  const now = Date.now();
  const cur = await first<{ code: string; name: string }>(db, 'SELECT code, name FROM currencies WHERE code = ?', code);
  if (!cur) throw notFound();
  const used = await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM employees WHERE currency_code = ?', code);
  if (used && used.n > 0) throw conflict('IN_USE', `${code} 仍有 ${used.n} 名员工使用，请先在员工资料中更换`, `${code} is used by ${used.n} employees; reassign them first`);
  const bot = await loadBot(db, code);
  if (bot && bot.status === 'ACTIVE') {
    try { const t = await botToken(c.env, bot); if (t) await tgCall(t, 'deleteWebhook', { drop_pending_updates: false }); } catch { /* best effort */ }
  }
  await db.batch([
    stmt(db, 'DELETE FROM currencies WHERE code = ?', code), // bot row is removed by ON DELETE CASCADE
    auditStmt(db, { actor: c.get('admin').username, action: 'CURRENCY_REMOVED', entityType: 'currency', entityId: code, before: { ...cur, bot: bot?.username ?? null }, ip: clientIp(c), at: now }),
    bump(db, now),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- bots (one per currency)
const defaultUrl = (c: { req: { url: string } }, code: string) => `${new URL(c.req.url).origin}/api/telegram/webhook/${code.toLowerCase()}`;

function botView(env: Env, b: BotRow & { employees?: number }, url: string) {
  return {
    currency: b.currency_code, botUserId: b.bot_user_id, username: b.username, tokenLast4: b.token_last4,
    tokenSource: hasSecretToken(env, b.currency_code) ? 'secret' : b.token_ciphertext ? 'stored' : null,
    webhookUrl: b.webhook_url, defaultUrl: url, status: b.status, canReadAllGroupMessages: b.can_read_all_group_messages == null ? null : !!b.can_read_all_group_messages,
    pendingUpdateCount: b.pending_update_count, lastError: b.last_error, lastCheckedAt: b.last_checked_at, employees: b.employees ?? 0,
  };
}

settingsRoutes.get('/bots', async (c) => {
  const rows = await all<BotRow & { employees: number }>(c.env.DB, `SELECT b.*, (SELECT COUNT(*) FROM employees e WHERE e.currency_code = b.currency_code AND e.employment_status = 'ACTIVE') AS employees
    FROM telegram_bots b ORDER BY b.currency_code`);
  return c.json({ rows: rows.map((b) => botView(c.env, b, defaultUrl(c, b.currency_code))) });
});

async function registerWebhook(env: Env, bot: BotRow, token: string, url: string): Promise<TgWebhookInfo> {
  const secret = await webhookSecret(env.ENCRYPTION_KEY, bot.id, bot.secret_salt);
  await tgCall(token, 'setWebhook', { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES, max_connections: 10, drop_pending_updates: false });
  return tgCall<TgWebhookInfo>(token, 'getWebhookInfo');
}

const tgFail = (e: unknown) => new ApiError(502, 'TELEGRAM_ERROR', { zh: `Telegram 返回错误：${(e as Error).message}`, en: (e as Error).message });

settingsRoutes.put('/bots/:code', async (c) => {
  requireAdminRole(c);
  const code = c.req.param('code').toUpperCase();
  const v = await body(c, z.object({ token: z.string().trim().max(200).optional().default(''), webhookUrl: z.string().trim().max(300) }));
  const db = c.env.DB;
  const now = Date.now();
  const bot = await loadBot(db, code);
  if (!bot) throw notFound('Currency not found');
  if (v.token && !TOKEN_RE.test(v.token)) throw bad('TOKEN_FORMAT', 'Token 格式不正确（应为 123456789:AA... ）', 'Invalid token format (expected 123456789:AA...)');
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(v.webhookUrl)) throw bad('URL', 'Webhook URL 必须是 https:// 开头的网址', 'Webhook URL must start with https://');
  if (await first(db, 'SELECT id FROM telegram_bots WHERE webhook_url = ? AND id <> ?', v.webhookUrl, bot.id)) throw conflict('URL_TAKEN', '这个 Webhook URL 已被其他货币的 Bot 使用', 'This webhook URL is already used by another currency');
  const token = v.token || (await botToken(c.env, bot));
  if (!token) throw bad('TOKEN_REQUIRED', '请输入 Bot Token', 'Please enter the bot token');
  let me: TgUser;
  try { me = await tgCall<TgUser>(token, 'getMe'); } catch (e) { throw tgFail(e); }
  const dup = await first<{ currency_code: string }>(db, 'SELECT currency_code FROM telegram_bots WHERE bot_user_id = ? AND id <> ?', me.id, bot.id);
  if (dup) throw conflict('BOT_TAKEN', `这个 Bot 已用于 ${dup.currency_code}，每个货币要用不同的 Bot`, `This bot is already used for ${dup.currency_code}; each currency needs its own bot`);
  const cipher = v.token ? await encryptString(c.env.ENCRYPTION_KEY, v.token) : bot.token_ciphertext;
  let info: TgWebhookInfo;
  try { info = await registerWebhook(c.env, bot, token, v.webhookUrl); }
  catch (e) {
    await stmt(db, "UPDATE telegram_bots SET status = 'ERROR', last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?", (e as Error).message.slice(0, 300), now, now, bot.id).run();
    throw tgFail(e);
  }
  await db.batch([
    stmt(db, `UPDATE telegram_bots SET bot_user_id = ?, username = ?, token_ciphertext = ?, token_last4 = ?, webhook_url = ?, status = 'ACTIVE', can_read_all_group_messages = ?,
              pending_update_count = ?, last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`,
      me.id, me.username ?? null, cipher, token.slice(-4), v.webhookUrl, me.can_read_all_group_messages ? 1 : 0, info.pending_update_count ?? 0, info.last_error_message ?? null, now, now, bot.id),
    auditStmt(db, { actor: c.get('admin').username, action: 'BOT_WEBHOOK_SET', entityType: 'telegram_bot', entityId: code,
      before: { bot: bot.username, status: bot.status, url: bot.webhook_url },
      after: { bot: me.username, status: 'ACTIVE', url: v.webhookUrl, token: `••••${token.slice(-4)}`, allowed_updates: ALLOWED_UPDATES }, ip: clientIp(c), at: now }),
    bump(db, now),
  ]);
  return c.json({ ok: true, canReadAllGroupMessages: !!me.can_read_all_group_messages });
});

async function botAction(c: Context<AppBindings>, action: 'check' | 'stop' | 'start' | 'rotate') {
  const code = c.req.param('code')!.toUpperCase();
  const db = c.env.DB;
  const now = Date.now();
  const bot = await loadBot(db, code);
  if (!bot || bot.status === 'NOT_SET') throw notFound('Bot not configured');
  const token = await botToken(c.env, bot);
  if (!token) throw bad('TOKEN_REQUIRED', '找不到 Bot Token', 'Bot token not available');
  const actor = c.get('admin').username;
  try {
    if (action === 'check') {
      const me = await tgCall<TgUser>(token, 'getMe');
      const info = await tgCall<TgWebhookInfo>(token, 'getWebhookInfo');
      const urlOk = bot.status !== 'ACTIVE' || info.url === bot.webhook_url;
      // Telegram keeps reporting its last delivery error for a long time; once a later update has been
      // received and nothing is queued, the error is history and is no longer shown.
      const errAt = info.last_error_date ? info.last_error_date * 1000 : null;
      const recovered = !!info.last_error_message && errAt != null && !info.pending_update_count &&
        !!(await first(db, 'SELECT id FROM telegram_messages WHERE bot_id = ? AND received_at > ? LIMIT 1', bot.id, errAt));
      const lastErr = !urlOk ? `Webhook URL mismatch: Telegram has "${info.url || '(none)'}"`
        : info.last_error_message && !recovered ? `${info.last_error_message}${errAt ? ` @ ${new Date(errAt).toISOString()}` : ''}` : null;
      await db.batch([stmt(db, `UPDATE telegram_bots SET can_read_all_group_messages = ?, pending_update_count = ?, last_error = ?, last_checked_at = ?, status = ?, updated_at = ? WHERE id = ?`,
        me.can_read_all_group_messages ? 1 : 0, info.pending_update_count, lastErr, now, bot.status === 'ACTIVE' && !urlOk ? 'ERROR' : bot.status, now, bot.id), bump(db, now)]);
      return c.json({ ok: true, pending: info.pending_update_count, url: info.url, canReadAllGroupMessages: !!me.can_read_all_group_messages, lastError: lastErr });
    }
    if (action === 'stop') {
      requireAdminRole(c);
      await tgCall(token, 'deleteWebhook', { drop_pending_updates: false });
      await db.batch([
        stmt(db, "UPDATE telegram_bots SET status = 'DISABLED', last_checked_at = ?, updated_at = ? WHERE id = ?", now, now, bot.id),
        auditStmt(db, { actor, action: 'BOT_WEBHOOK_DELETED', entityType: 'telegram_bot', entityId: code, before: { status: bot.status }, after: { status: 'DISABLED' }, ip: clientIp(c), at: now }),
        bump(db, now),
      ]);
      return c.json({ ok: true });
    }
    requireAdminRole(c);
    let b = bot;
    if (action === 'rotate') {
      const salt = [...randomBytes(16)].map((x) => x.toString(16).padStart(2, '0')).join('');
      b = { ...bot, secret_salt: salt };
    }
    const info = await registerWebhook(c.env, b, token, bot.webhook_url!);
    await db.batch([
      stmt(db, "UPDATE telegram_bots SET status = 'ACTIVE', secret_salt = ?, pending_update_count = ?, last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?", b.secret_salt, info.pending_update_count ?? 0, info.last_error_message ?? null, now, now, bot.id),
      auditStmt(db, { actor, action: action === 'rotate' ? 'BOT_SECRET_ROTATED' : 'BOT_WEBHOOK_SET', entityType: 'telegram_bot', entityId: code, before: { status: bot.status }, after: { status: 'ACTIVE' }, ip: clientIp(c), at: now }),
      bump(db, now),
    ]);
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof TelegramError) {
      await stmt(db, 'UPDATE telegram_bots SET last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?', e.message.slice(0, 300), now, now, bot.id).run();
      throw tgFail(e);
    }
    throw e;
  }
}

settingsRoutes.post('/bots/:code/check', (c) => botAction(c, 'check'));
settingsRoutes.post('/bots/:code/stop', (c) => botAction(c, 'stop'));
settingsRoutes.post('/bots/:code/start', (c) => botAction(c, 'start'));
settingsRoutes.post('/bots/:code/rotate', (c) => botAction(c, 'rotate'));
