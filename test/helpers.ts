import { vi } from 'vitest';
import { zonedToUtc } from '../src/shared/time';
import { hashPassword, webhookSecret } from '../src/worker/lib/crypto';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/env';
import { D1Shim } from './d1-shim';

export const TZ = 'Asia/Colombo';
export const KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'); // test-only key
export const CHAT = -1002233445566;
export const ORIGIN = 'https://att.example.com';
export const lk = (date: string, hhmm: string, sec = 0) => zonedToUtc(date, hhmm, TZ) + sec * 1000;

export interface TgCall { method: string; body: Record<string, unknown> }

export class Harness {
  db = new D1Shim();
  env: Env;
  cookie = '';
  tg: TgCall[] = [];
  webhooks = new Map<string, string>();
  pending: Promise<unknown>[] = [];
  private seq = 1000;

  constructor() {
    this.env = { DB: this.db as unknown as D1Database, ASSETS: undefined as unknown as Fetcher, ENCRYPTION_KEY: KEY, BIZ_TZ: TZ, APP_ENV: 'test' } as Env;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => this.fakeTelegram(String(url), init));
  }

  now(ms: number) { vi.setSystemTime(ms); }

  private async fakeTelegram(url: string, init?: RequestInit): Promise<Response> {
    const m = url.match(/^https:\/\/api\.telegram\.org\/bot(\d+):[^/]+\/(\w+)$/);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    const [, botId, method] = m;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    this.tg.push({ method, body });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
    switch (method) {
      case 'getMe': return ok({ id: Number(botId), is_bot: true, first_name: 'Attendance', username: `att_${botId}_bot`, can_read_all_group_messages: true });
      case 'setWebhook': this.webhooks.set(botId, body.url); return ok(true);
      case 'getWebhookInfo': return ok({ url: this.webhooks.get(botId) ?? '', pending_update_count: 0 });
      case 'deleteWebhook': this.webhooks.delete(botId); return ok(true);
      case 'sendMessage': return ok({ message_id: 1 });
      default: return new Response(JSON.stringify({ ok: false, description: 'unknown method' }), { status: 404 });
    }
  }

  ctx(): ExecutionContext {
    return { waitUntil: (p: Promise<unknown>) => { this.pending.push(p); }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  }

  async flush() { await Promise.all(this.pending.splice(0)); }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...(this.cookie ? { cookie: this.cookie } : {}), ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), this.env, this.ctx());
    const set = res.headers.get('set-cookie');
    if (set && set.startsWith('att_session=')) this.cookie = set.split(';')[0];
    await this.flush();
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  }

  async createAdmin(username = 'owner', password = 'correct-horse-battery', role: 'admin' | 'viewer' = 'admin') {
    this.db.x('INSERT INTO admin_users (username, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?)', username, await hashPassword(password), role, Date.now(), Date.now());
  }

  async login(username = 'owner', password = 'correct-horse-battery') {
    this.cookie = '';
    const r = await this.req('POST', '/api/auth/login', { username, password });
    if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.json)}`);
    return r;
  }

  async setupBot(code = 'LKR', botId = 700000001) {
    const r = await this.req('PUT', `/api/bots/${code}`, { token: `${botId}:AAH${'x'.repeat(32)}`, webhookUrl: `${ORIGIN}/api/telegram/webhook/${code.toLowerCase()}` });
    if (r.status !== 200) throw new Error(`bot setup failed ${JSON.stringify(r.json)}`);
  }

  async secretFor(code = 'LKR') {
    const b = this.db.get<{ id: number; secret_salt: string }>('SELECT id, secret_salt FROM telegram_bots WHERE currency_code = ?', code)!;
    return webhookSecret(KEY, b.id, b.secret_salt);
  }

  async employee(code: string, name: string, thread: number | null, currency = 'LKR') {
    const r = await this.req('POST', '/api/employees', { code, name, currency, timezone: TZ, chatId: String(CHAT), threadId: thread == null ? '' : String(thread) });
    if (r.status !== 200) throw new Error(`employee failed ${JSON.stringify(r.json)}`);
    return r.json.id as number;
  }

  /** shiftCode A/B/C or OFF */
  async roster(empId: number, date: string, shift: 'A' | 'B' | 'C' | 'OFF', reason = 'roster setup') {
    const id = shift === 'OFF' ? 'OFF' : this.db.get<{ id: number }>('SELECT id FROM shift_templates WHERE code = ?', shift)!.id;
    const r = await this.req('PUT', '/api/roster/cell', { employeeId: empId, date, value: id, reason });
    if (r.status !== 200) throw new Error(`roster failed ${JSON.stringify(r.json)}`);
  }

  /** Sends a Telegram update to the webhook. `ts` = message time; `at` = when the Worker receives it (default ts + 2 s). */
  async send(o: { text: string; ts: number; thread?: number | null; at?: number; code?: string; updateId?: number; messageId?: number; fromId?: number;
    forwarded?: boolean; edited?: { editTs: number }; secret?: string; chat?: number }) {
    const updateId = o.updateId ?? ++this.seq;
    const messageId = o.messageId ?? updateId;
    const msg: Record<string, unknown> = {
      message_id: messageId, date: Math.floor(o.ts / 1000), chat: { id: o.chat ?? CHAT, type: 'supergroup', title: 'Attendance', is_forum: true },
      from: { id: o.fromId ?? 5100000001, is_bot: false, first_name: 'Test' }, text: o.text,
    };
    if (o.thread != null) { msg.message_thread_id = o.thread; msg.is_topic_message = true; }
    if (o.forwarded) msg.forward_origin = { type: 'user', date: Math.floor(o.ts / 1000) - 60 };
    if (o.edited) msg.edit_date = Math.floor(o.edited.editTs / 1000);
    const update = o.edited ? { update_id: updateId, edited_message: msg } : { update_id: updateId, message: msg };
    this.now(o.at ?? o.ts + 2000);
    const code = (o.code ?? 'LKR').toLowerCase();
    const r = await this.req('POST', `/api/telegram/webhook/${code}`, update, { 'x-telegram-bot-api-secret-token': o.secret ?? (await this.secretFor(o.code ?? 'LKR')) });
    return { ...r, updateId, messageId, update };
  }

  async session(empId: number, date: string) {
    return this.db.get<Record<string, any>>('SELECT * FROM attendance_sessions WHERE employee_id = ? AND work_date = ?', empId, date);
  }

  async cron(at: number) {
    this.now(at);
    const { runCron } = await import('../src/worker/cron');
    return runCron(this.env, at);
  }
}

/** Standard fixture: admin logged in, LKR bot active, employees E001 (thread 1001) and E002 (thread 1002). */
export async function fixture(nowMs = lk('2026-10-15', '05:00')) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(nowMs);
  const h = new Harness();
  await h.createAdmin();
  await h.login();
  await h.setupBot('LKR');
  const e1 = await h.employee('E001', 'Nimal Perera', 1001);
  const e2 = await h.employee('E002', 'Kasun Silva', 1002);
  return { h, e1, e2 };
}
