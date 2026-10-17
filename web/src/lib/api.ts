import type { Bi } from '../../../src/shared/codes';

export class ApiErr extends Error {
  constructor(public status: number, public code: string, public msg: Bi) { super(msg.en); }
}

type Listener = () => void;
const unauthorized = new Set<Listener>();
export const onUnauthorized = (f: Listener) => { unauthorized.add(f); return () => { unauthorized.delete(f); }; };

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method: opts.method ?? 'GET',
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiErr(0, 'NETWORK', { zh: '网络连接失败', en: 'Network error' });
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/auth/login')) unauthorized.forEach((f) => f());
  if (!res.ok) throw new ApiErr(res.status, json?.error ?? 'ERROR', json?.message ?? { zh: `请求失败（${res.status}）`, en: `Request failed (${res.status})` });
  return json as T;
}

export const qs = (o: Record<string, unknown>): string =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)])).toString();
