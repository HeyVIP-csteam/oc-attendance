// Administrator accounts (stored in D1 table admin_users), managed from Settings → Admin accounts.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../env';
import { auditStmt } from '../lib/audit';
import { hashPassword } from '../lib/crypto';
import { all, first, stmt } from '../lib/db';
import { ApiError, bad, body, clientIp, conflict, intParam, notFound, requireAdminRole } from '../lib/http';
import { parseCurrencies } from '../lib/auth';
import { requireOwner } from '../lib/scope';
import { PasswordSchema, UsernameSchema } from './auth';

// null = all currencies; a list = only those
const CurList = z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/)).min(1).max(50).nullable().optional().default(null);
const curJson = (v: string[] | null) => (v === null ? null : JSON.stringify([...new Set(v)].sort()));
async function checkCurrencies(db: D1Database, v: string[] | null) {
  if (v === null) return;
  const known = new Set((await all<{ code: string }>(db, 'SELECT code FROM currencies')).map((x) => x.code));
  for (const x of v) if (!known.has(x)) throw bad('VALIDATION', `货币 ${x} 不存在`, `Unknown currency ${x}`);
}

export const adminRoutes = new Hono<AppBindings>();

adminRoutes.get('/admins', async (c) => {
  requireOwner(c);
  const rows = await all<{ currencies: string | null }>(c.env.DB, `SELECT id, username, role, is_active, last_login_at, locked_until, created_at, currencies, is_owner FROM admin_users ORDER BY is_owner DESC, username`);
  return c.json({ rows: rows.map((r) => ({ ...r, currencies: parseCurrencies(r.currencies) })), me: c.get('admin').id });
});

adminRoutes.post('/admins', async (c) => {
  requireAdminRole(c);
  requireOwner(c);
  const v = await body(c, z.object({ username: UsernameSchema, password: PasswordSchema, role: z.enum(['admin', 'viewer']), currencies: CurList }));
  const db = c.env.DB;
  const now = Date.now();
  await checkCurrencies(db, v.currencies);
  if (await first(db, 'SELECT id FROM admin_users WHERE username = ?', v.username)) throw conflict('EXISTS', '账号已存在', 'This username already exists');
  await db.batch([
    stmt(db, 'INSERT INTO admin_users (username, password_hash, role, is_active, created_at, updated_at, currencies) VALUES (?,?,?,1,?,?,?)', v.username, await hashPassword(v.password), v.role, now, now, curJson(v.currencies)),
    auditStmt(db, { actor: c.get('admin').username, action: 'ADMIN_USER_CREATED', entityType: 'admin_user', entityId: v.username, after: { role: v.role, currencies: v.currencies ?? 'ALL' }, ip: clientIp(c), at: now }),
  ]);
  return c.json({ ok: true });
});

adminRoutes.put('/admins/:id', async (c) => {
  requireAdminRole(c);
  requireOwner(c);
  const id = intParam(c, 'id');
  const v = await body(c, z.object({ role: z.enum(['admin', 'viewer']), isActive: z.boolean(), password: z.union([PasswordSchema, z.literal('')]).optional().default(''), currencies: CurList }));
  const db = c.env.DB;
  const now = Date.now();
  const me = c.get('admin');
  const u = await first<{ id: number; username: string; role: string; is_active: number; currencies: string | null; is_owner: number }>(db, 'SELECT id, username, role, is_active, currencies, is_owner FROM admin_users WHERE id = ?', id);
  if (!u) throw notFound();
  await checkCurrencies(db, v.currencies);
  // the owner always keeps full access: only the password can change
  if (u.is_owner && (v.role !== 'admin' || !v.isActive || v.currencies !== null)) throw bad('OWNER', 'Owner 账号始终拥有全部权限，只能修改密码', 'The owner always has full access — only the password can be changed');
  const curChanged = curJson(v.currencies) !== (u.currencies ?? null);
  if (id === me.id && (v.role !== 'admin' || !v.isActive)) throw bad('SELF', '不能停用自己或把自己改为只读', 'You cannot deactivate yourself or make yourself read-only');
  if (u.role === 'admin' && u.is_active && (v.role !== 'admin' || !v.isActive)) {
    const others = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM admin_users WHERE role = 'admin' AND is_active = 1 AND id <> ?", id);
    if (!others?.n) throw new ApiError(409, 'LAST_ADMIN', { zh: '至少要保留一个启用中的管理员', en: 'At least one active admin must remain' });
  }
  const statements: D1PreparedStatement[] = [
    stmt(db, 'UPDATE admin_users SET role = ?, is_active = ?, currencies = ?, updated_at = ? WHERE id = ?', v.role, v.isActive ? 1 : 0, curJson(v.currencies), now, id),
  ];
  if (v.password) statements.push(stmt(db, 'UPDATE admin_users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?', await hashPassword(v.password), id));
  // a password reset, role change or deactivation signs the account out everywhere (except your own current session)
  if (v.password || v.role !== u.role || !v.isActive || curChanged) statements.push(stmt(db, 'DELETE FROM admin_sessions WHERE admin_id = ? AND id <> ?', id, me.sessionId));
  statements.push(auditStmt(db, { actor: me.username, action: 'ADMIN_USER_UPDATED', entityType: 'admin_user', entityId: u.username,
    before: { role: u.role, active: !!u.is_active, currencies: parseCurrencies(u.currencies) ?? 'ALL' }, after: { role: v.role, active: v.isActive, currencies: v.currencies ?? 'ALL', password_reset: !!v.password }, ip: clientIp(c), at: now }));
  await db.batch(statements);
  return c.json({ ok: true });
});
