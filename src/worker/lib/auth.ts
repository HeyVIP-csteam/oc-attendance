import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppBindings } from '../env';
import { randomToken, sha256Hex } from './crypto';
import { first, stmt } from './db';
import { ensurePermsColumn } from './perms';
import { parsePerms } from '../../shared/perms';
import { ApiError, clientIp } from './http';

export const COOKIE = 'att_session';
export const SESSION_TTL_MS = 7 * 86_400_000;      // sliding
export const SESSION_MAX_MS = 30 * 86_400_000;     // absolute
const TOUCH_EVERY_MS = 10 * 60_000;                // write last_seen at most every 10 minutes (saves D1 writes)
export const MAX_FAILED = 5;
export const LOCK_MS = 15 * 60_000;

export async function createSession(c: Context<AppBindings>, adminId: number, now: number): Promise<D1PreparedStatement> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  setCookie(c, COOKIE, token, {
    httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Strict', path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return stmt(c.env.DB, 'INSERT INTO admin_sessions (id, admin_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)',
    id, adminId, now, now + SESSION_TTL_MS, now, clientIp(c), (c.req.header('user-agent') ?? '').slice(0, 200));
}

export function clearSessionCookie(c: Context<AppBindings>): void {
  deleteCookie(c, COOKIE, { path: '/' });
}

/** Requires a valid admin session; rejects cross-origin state-changing requests. */
export const requireSession: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = getCookie(c, COOKIE);
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', { zh: '请先登录', en: 'Please sign in' });
  const id = await sha256Hex(token);
  const now = Date.now();
  await ensurePermsColumn(c.env.DB);
  const row = await first<{ id: string; admin_id: number; created_at: number; expires_at: number; last_seen_at: number; username: string; role: 'admin' | 'viewer'; is_active: number; currencies: string | null; is_owner: number; settings_perms: string | null }>(
    c.env.DB,
    `SELECT s.id, s.admin_id, s.created_at, s.expires_at, s.last_seen_at, u.username, u.role, u.is_active, u.currencies, u.is_owner, u.settings_perms
     FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_id WHERE s.id = ?`, id);
  if (!row || row.expires_at < now || row.created_at + SESSION_MAX_MS < now || !row.is_active) {
    clearSessionCookie(c);
    throw new ApiError(401, 'UNAUTHENTICATED', { zh: '登录已过期，请重新登录', en: 'Your session has expired. Please sign in again.' });
  }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    const allowed = new Set([new URL(c.req.url).origin, ...(c.env.PUBLIC_ORIGIN ? [c.env.PUBLIC_ORIGIN.replace(/\/$/, '')] : [])]);
    if (origin && !allowed.has(origin)) throw new ApiError(403, 'BAD_ORIGIN', { zh: '来源不被允许', en: 'Cross-origin request rejected' });
  }
  if (now - row.last_seen_at > TOUCH_EVERY_MS) {
    const touch = stmt(c.env.DB, 'UPDATE admin_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', now, Math.min(now + SESSION_TTL_MS, row.created_at + SESSION_MAX_MS), id).run();
    try { c.executionCtx.waitUntil(touch); } catch { await touch; }
  }
  c.set('admin', { id: row.admin_id, username: row.username, role: row.role, currencies: row.is_owner ? null : parseCurrencies(row.currencies), owner: !!row.is_owner, perms: row.is_owner ? {} : parsePerms(row.settings_perms, row.role), sessionId: id });
  await next();
};

/** admin_users.currencies → null (all) or a non-empty list. A broken value fails closed (no currency). */
export function parseCurrencies(v: string | null | undefined): string[] | null {
  if (v == null || v === '') return null;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
