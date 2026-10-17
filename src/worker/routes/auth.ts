import { Hono } from 'hono';
import { z } from 'zod';
import type { AppBindings } from '../env';
import { auditStmt } from '../lib/audit';
import { clearSessionCookie, createSession, LOCK_MS, MAX_FAILED, requireSession } from '../lib/auth';
import { hashPassword, verifyPassword } from '../lib/crypto';
import { first, stmt } from '../lib/db';
import { ApiError, body, clientIp } from '../lib/http';

export const authRoutes = new Hono<AppBindings>();

const LoginSchema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) });

authRoutes.post('/login', async (c) => {
  const { username, password } = await body(c, LoginSchema);
  const db = c.env.DB;
  const now = Date.now();
  const ip = clientIp(c);
  const user = await first<{ id: number; username: string; password_hash: string; role: string; is_active: number; failed_attempts: number; locked_until: number | null }>(
    db, 'SELECT id, username, password_hash, role, is_active, failed_attempts, locked_until FROM admin_users WHERE username = ?', username);
  const fail = () => new ApiError(401, 'BAD_CREDENTIALS', { zh: '账号或密码错误', en: 'Incorrect username or password' });
  if (!user || !user.is_active) {
    await auditStmt(db, { actor: username.slice(0, 64), action: 'ADMIN_LOGIN_FAILED', entityType: 'admin_user', note: 'unknown or inactive user', ip, at: now }).run();
    throw fail();
  }
  if (user.locked_until && user.locked_until > now) {
    throw new ApiError(423, 'LOCKED', { zh: '登录失败次数过多，请 15 分钟后再试', en: 'Too many failed attempts. Try again in 15 minutes.' });
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const attempts = user.failed_attempts + 1;
    await db.batch([
      stmt(db, 'UPDATE admin_users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?', attempts >= MAX_FAILED ? 0 : attempts, attempts >= MAX_FAILED ? now + LOCK_MS : null, now, user.id),
      auditStmt(db, { actor: user.username, action: attempts >= MAX_FAILED ? 'ADMIN_LOCKED' : 'ADMIN_LOGIN_FAILED', entityType: 'admin_user', entityId: user.id, ip, at: now }),
    ]);
    throw fail();
  }
  await db.batch([
    stmt(db, 'UPDATE admin_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?', now, now, user.id),
    await createSession(c, user.id, now),
    auditStmt(db, { actor: user.username, action: 'ADMIN_LOGIN', entityType: 'admin_user', entityId: user.id, ip, at: now }),
    stmt(db, 'DELETE FROM admin_sessions WHERE admin_id = ? AND expires_at < ?', user.id, now),
  ]);
  return c.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

authRoutes.post('/logout', requireSession, async (c) => {
  const a = c.get('admin');
  const now = Date.now();
  await c.env.DB.batch([
    stmt(c.env.DB, 'DELETE FROM admin_sessions WHERE id = ?', a.sessionId),
    auditStmt(c.env.DB, { actor: a.username, action: 'ADMIN_LOGOUT', entityType: 'admin_user', entityId: a.id, ip: clientIp(c), at: now }),
  ]);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', requireSession, (c) => {
  const a = c.get('admin');
  return c.json({ id: a.id, username: a.username, role: a.role });
});

const PwSchema = z.object({ current: z.string().min(1).max(200), next: z.string().min(10).max(200) });

authRoutes.post('/password', requireSession, async (c) => {
  const a = c.get('admin');
  const { current, next } = await body(c, PwSchema);
  const db = c.env.DB;
  const u = await first<{ password_hash: string }>(db, 'SELECT password_hash FROM admin_users WHERE id = ?', a.id);
  if (!u || !(await verifyPassword(current, u.password_hash))) throw new ApiError(400, 'BAD_PASSWORD', { zh: '当前密码不正确', en: 'Current password is incorrect' });
  const now = Date.now();
  await db.batch([
    stmt(db, 'UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(next), now, a.id),
    stmt(db, 'DELETE FROM admin_sessions WHERE admin_id = ? AND id <> ?', a.id, a.sessionId),
    auditStmt(db, { actor: a.username, action: 'ADMIN_PASSWORD_CHANGED', entityType: 'admin_user', entityId: a.id, ip: clientIp(c), at: now }),
  ]);
  return c.json({ ok: true });
});
