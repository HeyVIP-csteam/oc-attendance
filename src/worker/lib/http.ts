import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import type { AppBindings } from '../env';

/** Error with a bilingual, user-safe message. */
export class ApiError extends HTTPException {
  constructor(status: 400 | 401 | 403 | 404 | 409 | 423 | 429 | 500 | 502 | 503, public code: string, public msg: { zh: string; en: string }, public extra?: Record<string, unknown>) {
    super(status, { message: msg.en });
  }
}

export const bad = (code: string, zh: string, en: string, extra?: Record<string, unknown>) => new ApiError(400, code, { zh, en }, extra);
export const notFound = (what = 'Not found') => new ApiError(404, 'NOT_FOUND', { zh: '找不到资料', en: what });
export const conflict = (code: string, zh: string, en: string) => new ApiError(409, code, { zh, en });

export async function body<T extends z.ZodType>(c: Context<AppBindings>, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw bad('INVALID_JSON', '请求格式错误', 'Request body must be JSON'); }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path?.join('.') || 'body';
    throw bad('VALIDATION', `输入无效：${where}`, `Invalid input: ${where} — ${issue?.message ?? ''}`, { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}

export function query<T extends z.ZodType>(c: Context<AppBindings>, schema: T): z.infer<T> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) {
    const where = r.error.issues[0]?.path?.join('.') || 'query';
    throw bad('VALIDATION', `查询参数无效：${where}`, `Invalid query parameter: ${where}`);
  }
  return r.data;
}

export const intParam = (c: Context<AppBindings>, name: string): number => {
  const v = Number(c.req.param(name));
  if (!Number.isInteger(v) || v <= 0) throw bad('VALIDATION', '参数无效', `Invalid ${name}`);
  return v;
};

export function requireAdminRole(c: Context<AppBindings>): void {
  if (c.get('admin').role !== 'admin') throw new ApiError(403, 'FORBIDDEN', { zh: '只读账号不能修改资料', en: 'Read-only accounts cannot make changes' });
}

export const clientIp = (c: Context<AppBindings>): string => c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
