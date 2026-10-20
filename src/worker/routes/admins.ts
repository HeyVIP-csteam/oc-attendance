// Administrator accounts (stored in D1 table admin_users), managed from Settings → Admin accounts.
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../env';
import { auditStmt } from '../lib/audit';
import { hashPassword } from '../lib/crypto';
import { all, first, stmt } from '../lib/db';
import { ApiError, bad, body, clientIp, conflict, intParam, notFound } from '../lib/http';
import { parseCurrencies } from '../lib/auth';
import { ensurePermsColumn, requireSetting } from '../lib/perms';
import { cleanPerms, parsePerms, permsText } from '../../shared/perms';
import { PasswordSchema, UsernameSchema } from './auth';

// null = all currencies; a list = only those
const CurList = z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/)).min(1).max(50).nullable().optional().default(null);
// Settings access: { tab: 'v' | 'e' } (missing = off); capped by role when saved
const PermsSchema = z.record(z.string().max(20), z.enum(['v', 'e'])).optional(); // unknown tabs are dropped by cleanPerms
const curJson = (v: string[] | null) => (v === null ? null : JSON.stringify([...new Set(v)].sort()));
async function checkCurrencies(db: D1Database, v: string[] | null) {
  if (v === null) return;
  const known = new Set((await all<{ code: string }>(db, 'SELECT code FROM currencies')).map((x) => x.code));
  for (const x of v) if (!known.has(x)) throw bad('VALIDATION', `货币 ${x} 不存在`, `Unknown currency ${x}`);
}

export const adminRoutes = new Hono<AppBindings>();

/**
 * "Admin accounts" opened to an account by the owner (Can edit): it may add accounts and change role, status, password and
 * currencies — but never Settings access (only the owner grants permissions), never the owner, never itself, and only
 * within its own currencies, so nobody can give themselves or others more than the owner allowed.
 */
function guardCurrencies(c: Context<AppBindings>, next: string[] | null, current?: string[] | null) {
  const mine = c.get('admin').currencies;
  if (c.get('admin').owner || mine === null) return;
  const inside = (list: string[] | null | undefined) => list != null && list.every((x) => mine.includes(x));
  if (!inside(next) || (current !== undefined && !inside(current))) throw new ApiError(403, 'OUT_OF_SCOPE', { zh: '只能设定你负责的货币', en: 'You can only give currencies you have access to' });
}

adminRoutes.get('/admins', async (c) => {
  requireSetting(c, 'admins', 'v');
  await ensurePermsColumn(c.env.DB);
  const rows = await all<{ currencies: string | null; role: 'admin' | 'viewer'; is_owner: number; settings_perms: string | null }>(c.env.DB, `SELECT id, username, role, is_active, last_login_at, locked_until, created_at, currencies, is_owner, settings_perms FROM admin_users ORDER BY is_owner DESC, username`);
  return c.json({ rows: rows.map(({ settings_perms, ...r }) => ({ ...r, currencies: parseCurrencies(r.currencies), perms: r.is_owner ? null : parsePerms(settings_perms, r.role) })), me: c.get('admin').id });
});

adminRoutes.post('/admins', async (c) => {
  requireSetting(c, 'admins', 'e');
  const v = await body(c, z.object({ username: UsernameSchema, password: PasswordSchema, role: z.enum(['admin', 'viewer']), currencies: CurList, settingsPerms: PermsSchema }));
  const db = c.env.DB;
  const now = Date.now();
  await ensurePermsColumn(db);
  const owner = c.get('admin').owner;
  guardCurrencies(c, v.currencies);
  // not sent (older clients / scripts) = the default: Attendance rules of its own currencies.
  // Only the owner grants Settings access: an account added by anyone else starts with every tab off.
  const perms = !owner ? {} : v.settingsPerms ? cleanPerms(v.settingsPerms, v.role) : null;
  await checkCurrencies(db, v.currencies);
  if (await first(db, 'SELECT id FROM admin_users WHERE username = ?', v.username)) throw conflict('EXISTS', '账号已存在', 'This username already exists');
  await db.batch([
    stmt(db, 'INSERT INTO admin_users (username, password_hash, role, is_active, created_at, updated_at, currencies, settings_perms) VALUES (?,?,?,1,?,?,?,?)', v.username, await hashPassword(v.password), v.role, now, now, curJson(v.currencies), perms && JSON.stringify(perms)),
    auditStmt(db, { actor: c.get('admin').username, action: 'ADMIN_USER_CREATED', entityType: 'admin_user', entityId: v.username, after: { role: v.role, currencies: v.currencies ?? 'ALL', settings: permsText(perms ?? parsePerms(null, v.role)) }, ip: clientIp(c), at: now }),
  ]);
  return c.json({ ok: true });
});

adminRoutes.put('/admins/:id', async (c) => {
  requireSetting(c, 'admins', 'e');
  const id = intParam(c, 'id');
  const v = await body(c, z.object({ role: z.enum(['admin', 'viewer']), isActive: z.boolean(), password: z.union([PasswordSchema, z.literal('')]).optional().default(''), currencies: CurList, settingsPerms: PermsSchema }));
  const db = c.env.DB;
  const now = Date.now();
  const me = c.get('admin');
  await ensurePermsColumn(db);
  const u = await first<{ id: number; username: string; role: 'admin' | 'viewer'; is_active: number; currencies: string | null; is_owner: number; settings_perms: string | null }>(db, 'SELECT id, username, role, is_active, currencies, is_owner, settings_perms FROM admin_users WHERE id = ?', id);
  if (!u) throw notFound();
  if (!me.owner) {
    if (u.is_owner) throw new ApiError(403, 'OWNER_ONLY', { zh: '只有 Owner 可以修改 Owner 账号', en: 'Only the owner can change the owner account' });
    if (u.id === me.id) throw new ApiError(403, 'SELF', { zh: '不能修改自己的账号（密码请在右上角修改）', en: 'You cannot change your own account here (change your password from the top-right menu)' });
    guardCurrencies(c, v.currencies, parseCurrencies(u.currencies));
  }
  await checkCurrencies(db, v.currencies);
  // the owner always keeps full access: only the password can change
  if (u.is_owner && (v.role !== 'admin' || !v.isActive || v.currencies !== null)) throw bad('OWNER', 'Owner 账号始终拥有全部权限，只能修改密码', 'The owner always has full access — only the password can be changed');
  const curChanged = curJson(v.currencies) !== (u.currencies ?? null);
  if (id === me.id && (v.role !== 'admin' || !v.isActive)) throw bad('SELF', '不能停用自己或把自己改为只读', 'You cannot deactivate yourself or make yourself read-only');
  if (u.role === 'admin' && u.is_active && (v.role !== 'admin' || !v.isActive)) {
    const others = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM admin_users WHERE role = 'admin' AND is_active = 1 AND id <> ?", id);
    if (!others?.n) throw new ApiError(409, 'LAST_ADMIN', { zh: '至少要保留一个启用中的管理员', en: 'At least one active admin must remain' });
  }
  // Settings access: not sent = unchanged (re-capped if the role changed); only the owner can change it
  const permsBefore = parsePerms(u.settings_perms, u.role);
  const permsAfter = u.is_owner ? {} : cleanPerms((me.owner ? v.settingsPerms : undefined) ?? permsBefore, v.role);
  const statements: D1PreparedStatement[] = [
    stmt(db, 'UPDATE admin_users SET role = ?, is_active = ?, currencies = ?, settings_perms = ?, updated_at = ? WHERE id = ?', v.role, v.isActive ? 1 : 0, curJson(v.currencies), u.is_owner ? null : JSON.stringify(permsAfter), now, id),
  ];
  if (v.password) statements.push(stmt(db, 'UPDATE admin_users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?', await hashPassword(v.password), id));
  // a password reset, role change or deactivation signs the account out everywhere (except your own current session)
  if (v.password || v.role !== u.role || !v.isActive || curChanged) statements.push(stmt(db, 'DELETE FROM admin_sessions WHERE admin_id = ? AND id <> ?', id, me.sessionId));
  statements.push(auditStmt(db, { actor: me.username, action: 'ADMIN_USER_UPDATED', entityType: 'admin_user', entityId: u.username,
    before: { role: u.role, active: !!u.is_active, currencies: parseCurrencies(u.currencies) ?? 'ALL', ...(u.is_owner ? {} : { settings: permsText(permsBefore) }) },
    after: { role: v.role, active: v.isActive, currencies: v.currencies ?? 'ALL', password_reset: !!v.password, ...(u.is_owner ? {} : { settings: permsText(permsAfter) }) }, ip: clientIp(c), at: now }));
  await db.batch(statements);
  return c.json({ ok: true });
});
