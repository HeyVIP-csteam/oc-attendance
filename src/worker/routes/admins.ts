// Administrator accounts (stored in D1 table admin_users), managed from Settings → Admin accounts.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../env';
import { auditStmt } from '../lib/audit';
import { hashPassword } from '../lib/crypto';
import { all, first, stmt } from '../lib/db';
import { ApiError, bad, body, clientIp, conflict, intParam, notFound, requireAdminRole } from '../lib/http';
import { PasswordSchema, UsernameSchema } from './auth';

export const adminRoutes = new Hono<AppBindings>();

adminRoutes.get('/admins', async (c) => {
  const rows = await all(c.env.DB, `SELECT id, username, role, is_active, last_login_at, locked_until, created_at FROM admin_users ORDER BY username`);
  return c.json({ rows, me: c.get('admin').id });
});

adminRoutes.post('/admins', async (c) => {
  requireAdminRole(c);
  const v = await body(c, z.object({ username: UsernameSchema, password: PasswordSchema, role: z.enum(['admin', 'viewer']) }));
  const db = c.env.DB;
  const now = Date.now();
  if (await first(db, 'SELECT id FROM admin_users WHERE username = ?', v.username)) throw conflict('EXISTS', '账号已存在', 'This username already exists');
  await db.batch([
    stmt(db, 'INSERT INTO admin_users (username, password_hash, role, is_active, created_at, updated_at) VALUES (?,?,?,1,?,?)', v.username, await hashPassword(v.password), v.role, now, now),
    auditStmt(db, { actor: c.get('admin').username, action: 'ADMIN_USER_CREATED', entityType: 'admin_user', entityId: v.username, after: { role: v.role }, ip: clientIp(c), at: now }),
  ]);
  return c.json({ ok: true });
});

adminRoutes.put('/admins/:id', async (c) => {
  requireAdminRole(c);
  const id = intParam(c, 'id');
  const v = await body(c, z.object({ role: z.enum(['admin', 'viewer']), isActive: z.boolean(), password: z.union([PasswordSchema, z.literal('')]).optional().default('') }));
  const db = c.env.DB;
  const now = Date.now();
  const me = c.get('admin');
  const u = await first<{ id: number; username: string; role: string; is_active: number }>(db, 'SELECT id, username, role, is_active FROM admin_users WHERE id = ?', id);
  if (!u) throw notFound();
  if (id === me.id && (v.role !== 'admin' || !v.isActive)) throw bad('SELF', '不能停用自己或把自己改为只读', 'You cannot deactivate yourself or make yourself read-only');
  if (u.role === 'admin' && u.is_active && (v.role !== 'admin' || !v.isActive)) {
    const others = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM admin_users WHERE role = 'admin' AND is_active = 1 AND id <> ?", id);
    if (!others?.n) throw new ApiError(409, 'LAST_ADMIN', { zh: '至少要保留一个启用中的管理员', en: 'At least one active admin must remain' });
  }
  const statements: D1PreparedStatement[] = [
    stmt(db, 'UPDATE admin_users SET role = ?, is_active = ?, updated_at = ? WHERE id = ?', v.role, v.isActive ? 1 : 0, now, id),
  ];
  if (v.password) statements.push(stmt(db, 'UPDATE admin_users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?', await hashPassword(v.password), id));
  // a password reset, role change or deactivation signs the account out everywhere (except your own current session)
  if (v.password || v.role !== u.role || !v.isActive) statements.push(stmt(db, 'DELETE FROM admin_sessions WHERE admin_id = ? AND id <> ?', id, me.sessionId));
  statements.push(auditStmt(db, { actor: me.username, action: 'ADMIN_USER_UPDATED', entityType: 'admin_user', entityId: u.username,
    before: { role: u.role, active: !!u.is_active }, after: { role: v.role, active: v.isActive, password_reset: !!v.password }, ip: clientIp(c), at: now }));
  await db.batch(statements);
  return c.json({ ok: true });
});
