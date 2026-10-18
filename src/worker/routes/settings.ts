import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { EVENT_TYPES, FIXED, type KeywordConfig, type Rules } from '../../shared/codes';
import { validateKeywords } from '../../shared/parser';
import { addDays, localDate } from '../../shared/time';
import type { AppBindings, Env } from '../env';
import { auditStmt } from '../lib/audit';
import { encryptString, randomBytes, webhookSecret } from '../lib/crypto';
import { all, first, stmt } from '../lib/db';
import { ApiError, bad, body, clientIp, conflict, notFound, requireAdminRole } from '../lib/http';
import { reparsePending } from '../lib/ingest';
import { bizTz, loadSettings, rulesFor } from '../lib/settings';
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
    keywords: settings.keywords, rules: settings.rules, parser: settings.parser,
    rulesCur: Object.fromEntries((cur.results as { code: string }[]).map((x) => [x.code, rulesFor(settings, x.code)])), fixed: FIXED, dataVersion: settings.dataVersion,
  });
});

settingsRoutes.get('/version', async (c) => {
  const r = await first<{ value: string }>(c.env.DB, "SELECT value FROM system_settings WHERE key = 'data_version'");
  return c.json({ v: Number(r?.value ?? 0) });
});

// ---------------------------------------------------------------- keywords & rules
const KwSchema = z.object(Object.fromEntries(EVENT_TYPES.map((k) => [k, z.array(z.string().trim().min(1).max(40)).min(1).max(60)])) as Record<(typeof EVENT_TYPES)[number], z.ZodArray<z.ZodString>>);

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

const ParserSchema = z.object({
  skipLabels: z.array(z.string().trim().min(1).max(30)).max(50),
  typoTolerance: z.boolean(),
  ignoreBrackets: z.boolean(),
  typedTimeReview: z.boolean(),
});

settingsRoutes.put('/settings/parser', async (c) => {
  requireAdminRole(c);
  const v = await body(c, ParserSchema);
  const parser = { ...v, skipLabels: [...new Set(v.skipLabels.map((l) => l.replace(/[:：]\s*$/, '').trim()).filter(Boolean))] };
  const db = c.env.DB;
  const now = Date.now();
  const before = await loadSettings(db);
  const actor = c.get('admin').username;
  await db.batch([
    stmt(db, `INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES ('parser', ?, ?, ?)
              ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, JSON.stringify(parser), now, actor),
    auditStmt(db, { actor, action: 'SETTINGS_UPDATED', entityType: 'system_settings', entityId: 'parser', before: before.parser, after: parser, ip: clientIp(c), at: now }),
    bump(db, now),
  ]);
  return c.json({ ok: true });
});

const RulesSchema = z.object({
  windowHours: z.number().min(5 / 60).max(8).refine((h) => Math.abs(h * 60 - Math.round(h * 60)) < 1e-6, 'whole minutes only'),
  windowUnit: z.enum(['h', 'm']).optional().default('h'),
  lateAsException: z.boolean(),
  botReply: z.boolean(),
  otHours: z.number().min(1).max(24).optional().default(9),
  breakMinutes: z.number().int().min(0).max(1440).nullable().optional().default(90),
  breakUnit: z.enum(['h', 'm']).optional().default('m'),
  currency: z.string().trim().toUpperCase().max(10).optional(), // set → these are that currency's own rules
});

settingsRoutes.put('/settings/rules', async (c) => {
  requireAdminRole(c);
  const { currency, ...rules } = await body(c, RulesSchema);
  const db = c.env.DB;
  const now = Date.now();
  const actor = c.get('admin').username;
  const before = await loadSettings(db);
  const since = addDays(localDate(now, bizTz(c.env)), -31);
  const changed = (a: Pick<Rules, 'lateAsException' | 'windowHours' | 'breakMinutes'>, b: typeof a) => a.lateAsException !== b.lateAsException || a.windowHours !== b.windowHours || a.breakMinutes !== b.breakMinutes;
  const statements: D1PreparedStatement[] = [];
  if (currency) {
    // one currency's own rules (each currency is set on its own)
    if (!(await first(db, 'SELECT code FROM currencies WHERE code = ?', currency))) throw notFound();
    const prev = rulesFor(before, currency);
    const all = { ...before.rulesCur, [currency]: rules };
    statements.push(
      stmt(db, `INSERT INTO system_settings (key, value, updated_at, updated_by) VALUES ('rules_cur', ?, ?, ?)
                ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, JSON.stringify(all), now, actor),
      auditStmt(db, { actor, action: 'SETTINGS_UPDATED', entityType: 'system_settings', entityId: `rules:${currency}`, before: prev, after: rules, ip: clientIp(c), at: now }),
      bump(db, now),
    );
    // only this currency's employees are re-evaluated (last 31 days, in the background: cron, 200 sessions per run)
    if (changed(prev, rules)) statements.push(stmt(db, 'UPDATE attendance_sessions SET next_check_at = 0 WHERE work_date >= ? AND employee_id IN (SELECT id FROM employees WHERE currency_code = ?)', since, currency));
  } else {
    statements.push(
      stmt(db, "UPDATE system_settings SET value = ?, updated_at = ?, updated_by = ? WHERE key = 'rules'", JSON.stringify(rules), now, actor),
      auditStmt(db, { actor, action: 'SETTINGS_UPDATED', entityType: 'system_settings', entityId: 'rules', before: before.rules, after: rules, ip: clientIp(c), at: now }),
      bump(db, now),
    );
    if (changed(before.rules, rules)) statements.push(stmt(db, 'UPDATE attendance_sessions SET next_check_at = 0 WHERE work_date >= ?', since));
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
  if (bot && bot.status !== 'NOT_SET') {
    // other currencies using the same bot keep it; otherwise disconnect only our own webhook
    try { await releaseIfUnused(c, await botToken(c.env, bot), bot.tg_bot_id, bot.id, false); } catch { /* best effort */ }
  }
  await db.batch([
    stmt(db, 'DELETE FROM currencies WHERE code = ?', code), // bot row is removed by ON DELETE CASCADE
    auditStmt(db, { actor: c.get('admin').username, action: 'CURRENCY_REMOVED', entityType: 'currency', entityId: code, before: { ...cur, bot: bot?.username ?? null }, ip: clientIp(c), at: now }),
    bump(db, now),
  ]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- bots (per currency; several currencies may use the same bot)
//
// Model: every currency row holds its own copy of the bot token. Rows that use the same Telegram bot (same tg_bot_id)
// form a group and share ONE webhook secret (secret_ref + secret_salt), because Telegram allows only one webhook per bot.
// Messages are matched to the group by that secret, whatever URL they arrive on, so each currency can be stopped,
// cleaned or switched to another bot on its own. oc-attendance never reconnects a bot by itself: Telegram is only told
// to register a webhook when an admin saves, starts or rotates; it is disconnected only when no currency uses the bot
// any more — and only if the webhook points at oc-attendance (never another system's).
const defaultUrl = (c: { req: { url: string } }, code: string) => `${new URL(c.req.url).origin}/api/telegram/webhook/${code.toLowerCase()}`;
const newSalt = () => [...randomBytes(16)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Does this webhook URL point at oc-attendance (any currency)? */
function isOurWebhook(c: Context<AppBindings>, url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const hosts = new Set([new URL(c.req.url).host]);
    if (c.env.PUBLIC_ORIGIN) { try { hosts.add(new URL(c.env.PUBLIC_ORIGIN).host); } catch { /* ignore */ } }
    return hosts.has(u.host) && u.pathname.startsWith('/api/telegram/webhook/');
  } catch { return false; }
}

type WebhookRelease = 'removed' | 'none' | 'other' | 'kept';
/** Removes the webhook only if it points at oc-attendance. Throws TelegramError if Telegram cannot be reached. */
async function releaseWebhook(c: Context<AppBindings>, token: string): Promise<{ result: WebhookRelease; url: string }> {
  const info = await tgCall<TgWebhookInfo>(token, 'getWebhookInfo');
  const url = info.url ?? '';
  if (!url) return { result: 'none', url };
  if (!isOurWebhook(c, url)) return { result: 'other', url };
  await tgCall(token, 'deleteWebhook', { drop_pending_updates: false });
  return { result: 'removed', url };
}
const inUse = (url: string) => new ApiError(409, 'BOT_IN_USE', { zh: `这个 Bot 目前连接在其他系统：${url}。继续会让那个系统收不到消息。`, en: `This bot is connected to another system: ${url}. Continuing would stop that system receiving messages.` }, { url });

/** Other configured currencies using the same Telegram bot. */
const groupOf = (db: D1Database, tgBotId: number | null, exceptId: number, onlyActive = false) => tgBotId == null ? Promise.resolve([] as BotRow[])
  : all<BotRow>(db, `SELECT * FROM telegram_bots WHERE tg_bot_id = ? AND id <> ? AND status <> 'NOT_SET'${onlyActive ? " AND status = 'ACTIVE'" : ''} ORDER BY id`, tgBotId, exceptId);

function botView(env: Env, b: BotRow & { employees?: number }, url: string) {
  return {
    currency: b.currency_code, botUserId: b.tg_bot_id ?? b.bot_user_id, username: b.username, tokenLast4: b.token_last4,
    tokenSource: hasSecretToken(env, b.currency_code) ? 'secret' : b.token_ciphertext ? 'stored' : null,
    webhookUrl: b.tg_url ?? b.webhook_url, defaultUrl: url, status: b.status, canReadAllGroupMessages: b.can_read_all_group_messages == null ? null : !!b.can_read_all_group_messages,
    pendingUpdateCount: b.pending_update_count, lastError: b.last_error, lastCheckedAt: b.last_checked_at, employees: b.employees ?? 0,
  };
}

settingsRoutes.get('/bots', async (c) => {
  const rows = await all<BotRow & { employees: number }>(c.env.DB, `SELECT b.*, (SELECT COUNT(*) FROM employees e WHERE e.currency_code = b.currency_code AND e.employment_status = 'ACTIVE') AS employees
    FROM telegram_bots b ORDER BY b.currency_code`);
  return c.json({ rows: rows.map((b) => botView(c.env, b, defaultUrl(c, b.currency_code))) });
});

/** Registers the webhook for a row with the row's (group's) secret. */
async function registerWebhook(env: Env, bot: Pick<BotRow, 'id' | 'secret_ref' | 'secret_salt'>, token: string, url: string): Promise<TgWebhookInfo> {
  const secret = await webhookSecret(env.ENCRYPTION_KEY, bot.secret_ref ?? bot.id, bot.secret_salt);
  await tgCall(token, 'setWebhook', { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES, max_connections: 10, drop_pending_updates: false });
  return tgCall<TgWebhookInfo>(token, 'getWebhookInfo');
}

/**
 * Telegram's getWebhookInfo keeps returning its *last* delivery error long after the problem is gone
 * (even across setWebhook). Errors older than `since` belong to an earlier configuration and are not shown.
 */
function webhookError(info: TgWebhookInfo, since: number | null): string | null {
  if (!info.last_error_message) return null;
  const errAt = info.last_error_date ? info.last_error_date * 1000 : null;
  if (since != null && errAt != null && errAt < since) return null;
  return `${info.last_error_message}${errAt ? ` @ ${new Date(errAt).toISOString()}` : ''}`;
}

const tgFail = (e: unknown) => new ApiError(502, 'TELEGRAM_ERROR', { zh: `Telegram 返回错误：${(e as Error).message}`, en: (e as Error).message });

/** After a currency stopped using a bot: disconnect it only if no other currency uses it and it points at us. */
async function releaseIfUnused(c: Context<AppBindings>, token: string | null, tgBotId: number | null, exceptId: number, activeOnly: boolean): Promise<WebhookRelease> {
  if (!token || tgBotId == null) return 'none';
  if ((await groupOf(c.env.DB, tgBotId, exceptId, activeOnly)).length) return 'kept';
  return (await releaseWebhook(c, token)).result;
}

settingsRoutes.put('/bots/:code', async (c) => {
  requireAdminRole(c);
  const code = c.req.param('code').toUpperCase();
  const v = await body(c, z.object({ token: z.string().trim().max(200).optional().default(''), webhookUrl: z.string().trim().max(300), force: z.boolean().optional().default(false) }));
  const db = c.env.DB;
  const now = Date.now();
  const bot = await loadBot(db, code);
  if (!bot) throw notFound('Currency not found');
  if (v.token && !TOKEN_RE.test(v.token)) throw bad('TOKEN_FORMAT', 'Token 格式不正确（应为 123456789:AA... ）', 'Invalid token format (expected 123456789:AA...)');
  if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(v.webhookUrl)) throw bad('URL', 'Webhook URL 必须是 https:// 开头的网址', 'Webhook URL must start with https://');
  if (await first(db, 'SELECT id FROM telegram_bots WHERE webhook_url = ? AND id <> ?', v.webhookUrl, bot.id)) throw conflict('URL_TAKEN', '这个 Webhook URL 已被其他货币使用', 'This webhook URL is already used by another currency');
  const oldToken = bot.status !== 'NOT_SET' ? await botToken(c.env, bot) : null;
  const token = v.token || oldToken;
  if (!token) throw bad('TOKEN_REQUIRED', '请输入 Bot Token', 'Please enter the bot token');
  let me: TgUser;
  let current: TgWebhookInfo;
  try { me = await tgCall<TgUser>(token, 'getMe'); current = await tgCall<TgWebhookInfo>(token, 'getWebhookInfo'); } catch (e) { throw tgFail(e); }
  const actor = c.get('admin').username;
  const group = await groupOf(db, me.id, bot.id);
  const g = group[0];
  // the row's secret: the group's if the bot is already used by another currency, otherwise its own
  const secretRef = g ? g.secret_ref ?? g.id : bot.tg_bot_id === me.id ? bot.secret_ref : null;
  const salt = g ? g.secret_salt : bot.tg_bot_id === me.id ? bot.secret_salt : newSalt();
  const row = { id: bot.id, secret_ref: secretRef, secret_salt: salt };
  // never silently take a bot over from another system
  if (current.url && !isOurWebhook(c, current.url) && !v.force) throw inUse(current.url);
  // the bot is already connected to oc-attendance for another currency: nothing to tell Telegram
  const connected = !!g && !!current.url && isOurWebhook(c, current.url);
  let info: TgWebhookInfo = current;
  if (!connected) {
    try { info = await registerWebhook(c.env, row, token, v.webhookUrl); }
    catch (e) {
      await stmt(db, 'UPDATE telegram_bots SET last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?', (e as Error).message.slice(0, 300), now, now, bot.id).run();
      throw tgFail(e);
    }
  }
  const tgUrl = connected ? current.url : v.webhookUrl;
  const cipher = v.token ? await encryptString(c.env.ENCRYPTION_KEY, v.token) : bot.token_ciphertext;
  const switched = bot.status !== 'NOT_SET' && bot.tg_bot_id != null && bot.tg_bot_id !== me.id;
  const ownsUserId = !(await first(db, 'SELECT id FROM telegram_bots WHERE bot_user_id = ? AND id <> ?', me.id, bot.id));
  await db.batch([
    stmt(db, `UPDATE telegram_bots SET tg_bot_id = ?, bot_user_id = ?, username = ?, token_ciphertext = ?, token_last4 = ?, webhook_url = ?, tg_url = ?, secret_ref = ?, secret_salt = ?,
              shared_from = NULL, status = 'ACTIVE', can_read_all_group_messages = ?, pending_update_count = ?, last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`,
      me.id, ownsUserId ? me.id : null, me.username ?? null, cipher, token.slice(-4), connected ? null : v.webhookUrl, tgUrl, secretRef, salt,
      me.can_read_all_group_messages ? 1 : 0, info.pending_update_count ?? 0, webhookError(info, Math.floor(now / 1000) * 1000), now, now, bot.id),
    ...(connected ? [] : [stmt(db, 'UPDATE telegram_bots SET tg_url = ?, updated_at = ? WHERE tg_bot_id = ? AND id <> ?', tgUrl, now, me.id, bot.id)]),
    auditStmt(db, { actor, action: 'BOT_WEBHOOK_SET', entityType: 'telegram_bot', entityId: code,
      before: { bot: bot.username, status: bot.status, url: bot.tg_url ?? bot.webhook_url },
      after: { bot: me.username, status: 'ACTIVE', url: tgUrl, token: `••••${token.slice(-4)}`, also_used_by: group.map((x) => x.currency_code),
        ...(current.url && !isOurWebhook(c, current.url) ? { taken_over_from: current.url } : {}) }, ip: clientIp(c), at: now }),
    bump(db, now),
  ]);
  // the bot this currency used before: disconnect only if no other currency still uses it (never reconnect it)
  let oldBot: WebhookRelease = 'none';
  if (switched) { try { oldBot = await releaseIfUnused(c, oldToken, bot.tg_bot_id, bot.id, false); } catch { /* best effort */ } }
  return c.json({ ok: true, canReadAllGroupMessages: !!me.can_read_all_group_messages, oldBot });
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
      const urlOk = bot.status !== 'ACTIVE' || isOurWebhook(c, info.url);
      // Telegram keeps reporting its last delivery error for a long time; once nothing is queued and the error is old
      // or a message has arrived since, it is history and no longer shown.
      const errAt = info.last_error_date ? info.last_error_date * 1000 : null;
      const recovered = !!info.last_error_message && errAt != null && !info.pending_update_count && (errAt < now - 10 * 60_000 ||
        !!(await first(db, 'SELECT id FROM telegram_messages WHERE bot_id = ? AND received_at > ? LIMIT 1', bot.id, errAt)));
      const lastErr = !urlOk ? (info.url ? `Webhook is connected to another system: "${info.url}"` : 'Webhook is not connected') : recovered ? null : webhookError(info, null);
      await db.batch([
        stmt(db, `UPDATE telegram_bots SET can_read_all_group_messages = ?, pending_update_count = ?, last_error = ?, last_checked_at = ?, status = ?, updated_at = ? WHERE id = ?`,
          me.can_read_all_group_messages ? 1 : 0, info.pending_update_count, lastErr, now, bot.status === 'ACTIVE' && !urlOk ? 'ERROR' : bot.status, now, bot.id),
        ...(info.url && isOurWebhook(c, info.url) ? [stmt(db, 'UPDATE telegram_bots SET tg_url = ? WHERE tg_bot_id = ?', info.url, bot.tg_bot_id)] : []),
        bump(db, now),
      ]);
      return c.json({ ok: true, pending: info.pending_update_count, url: info.url, canReadAllGroupMessages: !!me.can_read_all_group_messages, lastError: lastErr });
    }
    requireAdminRole(c);
    if (action === 'stop') {
      // only this currency stops; the bot stays connected while another currency still runs on it
      await stmt(db, "UPDATE telegram_bots SET status = 'DISABLED', last_error = NULL, last_checked_at = ?, updated_at = ? WHERE id = ?", now, now, bot.id).run();
      const rel = (await groupOf(db, bot.tg_bot_id, bot.id, true)).length ? { result: 'kept' as WebhookRelease, url: '' } : await releaseWebhook(c, token);
      await db.batch([
        auditStmt(db, { actor, action: 'BOT_STOPPED', entityType: 'telegram_bot', entityId: code, before: { status: bot.status }, after: { status: 'DISABLED', webhook: rel.result }, ip: clientIp(c), at: now }),
        bump(db, now),
      ]);
      return c.json({ ok: true, webhook: rel.result, url: rel.result === 'other' ? rel.url : undefined });
    }
    const cur = await tgCall<TgWebhookInfo>(token, 'getWebhookInfo');
    if (cur.url && !isOurWebhook(c, cur.url)) throw inUse(cur.url);
    const url = bot.webhook_url ?? defaultUrl(c, code);
    if (action === 'start') {
      // connect only if the bot is not connected to oc-attendance already (admin action — never automatic)
      let info = cur;
      if (!cur.url) info = await registerWebhook(c.env, bot, token, url);
      await db.batch([
        stmt(db, "UPDATE telegram_bots SET status = 'ACTIVE', webhook_url = COALESCE(webhook_url, CASE WHEN ? THEN ? END), last_error = NULL, last_checked_at = ?, updated_at = ? WHERE id = ?", cur.url ? 0 : 1, url, now, now, bot.id),
        ...(!cur.url ? [stmt(db, 'UPDATE telegram_bots SET tg_url = ? WHERE tg_bot_id = ?', url, bot.tg_bot_id)] : []),
        auditStmt(db, { actor, action: 'BOT_STARTED', entityType: 'telegram_bot', entityId: code, before: { status: bot.status }, after: { status: 'ACTIVE', connected: !cur.url, url: info.url }, ip: clientIp(c), at: now }),
        bump(db, now),
      ]);
      return c.json({ ok: true });
    }
    // rotate: new secret for every currency using this bot, webhook re-registered on this currency's URL
    const salt = newSalt();
    const row = { id: bot.id, secret_ref: null, secret_salt: salt };
    const info = await registerWebhook(c.env, row, token, url);
    await db.batch([
      stmt(db, 'UPDATE telegram_bots SET secret_ref = ?, secret_salt = ?, tg_url = ?, updated_at = ? WHERE tg_bot_id = ? AND id <> ?', bot.id, salt, url, now, bot.tg_bot_id, bot.id),
      stmt(db, "UPDATE telegram_bots SET secret_ref = NULL, secret_salt = ?, webhook_url = COALESCE(webhook_url, ?), tg_url = ?, pending_update_count = ?, last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?",
        salt, url, url, info.pending_update_count ?? 0, webhookError(info, Math.floor(now / 1000) * 1000), now, now, bot.id),
      auditStmt(db, { actor, action: 'BOT_SECRET_ROTATED', entityType: 'telegram_bot', entityId: code, before: { status: bot.status }, after: { url }, ip: clientIp(c), at: now }),
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

/** Wipes a currency's bot row (status back to "Not set", new secret). */
const wipeStmt = (db: D1Database, id: number, now: number) => stmt(db, `UPDATE telegram_bots SET shared_from = NULL, tg_bot_id = NULL, bot_user_id = NULL, username = NULL, token_ciphertext = NULL,
  token_last4 = NULL, webhook_url = NULL, tg_url = NULL, secret_ref = NULL, status = 'NOT_SET', secret_salt = ?, can_read_all_group_messages = NULL, pending_update_count = NULL,
  last_error = NULL, last_checked_at = NULL, updated_at = ? WHERE id = ?`, newSalt(), now, id);

/**
 * Clean: forget this currency's bot. Other currencies using the same bot keep working; the bot is disconnected from
 * Telegram only when no currency uses it any more, and only if it points at oc-attendance. Never reconnects anything.
 * Attendance records, raw messages and employees are NOT touched.
 */
settingsRoutes.post('/bots/:code/clean', async (c) => {
  requireAdminRole(c);
  const code = c.req.param('code').toUpperCase();
  const db = c.env.DB;
  const now = Date.now();
  const bot = await loadBot(db, code);
  if (!bot) throw notFound('Currency not found');
  const { force } = await body(c, z.object({ force: z.boolean().optional().default(false) })).catch(() => ({ force: false }));
  const token = bot.status !== 'NOT_SET' ? await botToken(c.env, bot) : null;
  let webhook: WebhookRelease | 'unreachable' = 'none';
  let otherUrl: string | undefined;
  if ((await groupOf(db, bot.tg_bot_id, bot.id)).length) webhook = 'kept';
  else if (token) {
    try { const r = await releaseWebhook(c, token); webhook = r.result; if (r.result === 'other') otherUrl = r.url; }
    catch (e) {
      // Telegram could not be asked: keep the token so the admin can retry, unless they insist (e.g. the token was revoked)
      if (!force) throw new ApiError(502, 'TELEGRAM_UNREACHABLE', { zh: `无法连接 Telegram 确认 Webhook（${(e as Error).message}），资料没有清除，请稍后再试。`, en: `Could not reach Telegram to check the webhook (${(e as Error).message}); nothing was cleaned, please retry.` });
      webhook = 'unreachable';
    }
  }
  await db.batch([
    wipeStmt(db, bot.id, now),
    auditStmt(db, { actor: c.get('admin').username, action: 'BOT_CLEARED', entityType: 'telegram_bot', entityId: code,
      before: { bot: bot.username, status: bot.status, url: bot.tg_url ?? bot.webhook_url, token: bot.token_last4 ? `••••${bot.token_last4}` : null },
      after: { status: 'NOT_SET', webhook, ...(otherUrl ? { left_connected_to: otherUrl } : {}) }, ip: clientIp(c), at: now }),
    bump(db, now),
  ]);
  return c.json({ ok: true, webhookRemoved: webhook === 'removed', webhook, url: otherUrl, secretTokenRemains: hasSecretToken(c.env, code) });
});
