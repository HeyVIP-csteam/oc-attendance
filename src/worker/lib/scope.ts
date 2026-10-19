// Currency access of the signed-in admin. An account limited to some currencies only ever sees the employees of those
// currencies — every data query adds the filter here, so changing a URL or an API parameter cannot widen it.
import type { Context } from 'hono';
import type { AppBindings } from '../env';
import { first } from './db';
import { ApiError } from './http';

export type Ctx = Context<AppBindings>;

/** null = all currencies. */
export const scopeOf = (c: Ctx): string[] | null => c.get('admin').currencies;

const forbidden = () => new ApiError(403, 'FORBIDDEN_CURRENCY', { zh: '你的账号没有权限查看这个货币', en: 'Your account has no access to this currency' });

/** Settings (other than a currency's attendance rules), admin accounts and the bots are for the owner. */
export function requireOwner(c: Ctx): void {
  if (!c.get('admin').owner) throw new ApiError(403, 'OWNER_ONLY', { zh: '只有 Owner 可以使用这个功能', en: 'Only the owner can use this' });
}

/** SQL condition (with a leading " AND ") limiting `col` (an employee currency column) to the account's currencies. */
export function scopeSql(c: Ctx, col = 'e.currency_code'): { sql: string; params: string[] } {
  const s = scopeOf(c);
  if (s === null) return { sql: '', params: [] };
  if (!s.length) return { sql: ' AND 0', params: [] };
  return { sql: ` AND ${col} IN (${s.map(() => '?').join(',')})`, params: s };
}

/** A requested currency filter must be one the account may see ('' = all of its currencies). */
export function checkCur(c: Ctx, cur: string | null | undefined): void {
  const s = scopeOf(c);
  if (cur && s !== null && !s.includes(cur)) throw forbidden();
}

export const inScope = (c: Ctx, cur: string | null | undefined): boolean => { const s = scopeOf(c); return s === null || (!!cur && s.includes(cur)); };

/** The employee must belong to one of the account's currencies (an unknown employee is reported as not found by the route). */
export async function assertEmployee(c: Ctx, employeeId: number | null | undefined): Promise<void> {
  if (scopeOf(c) === null || employeeId == null) { if (scopeOf(c) !== null && employeeId == null) throw forbidden(); return; }
  const e = await first<{ currency_code: string | null }>(c.env.DB, 'SELECT currency_code FROM employees WHERE id = ?', employeeId);
  if (!e || !inScope(c, e.currency_code)) throw forbidden();
}
