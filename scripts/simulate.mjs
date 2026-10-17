#!/usr/bin/env node
// LOCAL DEVELOPMENT ONLY — sends Telegram-shaped updates to the local webhook (wrangler dev on :8787), exactly like
// Telegram would, including the X-Telegram-Bot-Api-Secret-Token header. Useful for end-to-end checks without a real bot.
//
//   npm run simulate -- --thread 1001 --text IN                 # one message now
//   npm run simulate -- --thread 1001 --text OUT --at "2026-10-16 15:02"   (Sri Lanka time)
//   npm run simulate -- --demo                                  # realistic punches for the seeded roster (last 7 days)
//   options: --bot LKR  --url http://127.0.0.1:8787  --chat -1002233445566
//
// Requires ENCRYPTION_KEY in .dev.vars (run `npm run setup:local` once).

import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('url', 'http://127.0.0.1:8787');
const CHAT = Number(opt('chat', '-1002233445566'));
const vars = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
if (!vars.ENCRYPTION_KEY) { console.error('ENCRYPTION_KEY missing in .dev.vars — run `npm run setup:local`'); process.exit(1); }

const d1 = (sql) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--json', '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0].results;
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const master = Buffer.from(vars.ENCRYPTION_KEY, 'base64');
const sub = createHmac('sha256', master).update('tg-attendance:webhook').digest();
const bots = Object.fromEntries(d1("SELECT id, currency_code, secret_salt FROM telegram_bots WHERE status = 'ACTIVE'").map((b) => [b.currency_code, b]));
const secretFor = (code) => { const b = bots[code]; if (!b) throw new Error(`Bot ${code} is not ACTIVE in the local DB`); return b64url(createHmac('sha256', sub).update(`wh:${b.id}:${b.secret_salt}`).digest()); };

let seq = Number(opt('start-id', String(Math.floor(Date.now() / 1000) % 1e9)));
async function send({ code, thread, text, ts, delayMs = 1500 }) {
  const id = ++seq;
  const message = { message_id: id, date: Math.floor(ts / 1000), chat: { id: CHAT, type: 'supergroup', title: 'Attendance', is_forum: true }, from: { id: 5100000000 + (thread ?? 0), is_bot: false, first_name: 'Demo' }, text };
  if (thread != null) { message.message_thread_id = thread; message.is_topic_message = true; }
  const res = await fetch(`${BASE}/api/telegram/webhook/${code.toLowerCase()}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secretFor(code) }, body: JSON.stringify({ update_id: id, message }) });
  const j = await res.json().catch(() => ({}));
  return { http: res.status, ...j };
}
const lk = (s) => { const [d, t] = s.split(' '); const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return Date.UTC(y, m - 1, dd, h, mi) - 330 * 60000; };

if (args.includes('--demo')) {
  const rows = d1(`SELECT i.shift_date, i.scheduled_start_at s, i.scheduled_end_at e, i.shift_code, m.message_thread_id t, e.currency_code c, e.employee_code code
    FROM shift_instances i JOIN employees e ON e.id = i.employee_id JOIN telegram_topic_mappings m ON m.employee_id = e.id AND m.is_active = 1
    WHERE i.adjustment_status <> 'CANCELLED' AND i.scheduled_start_at BETWEEN ${Date.now() - 7 * 86400000} AND ${Date.now()} ORDER BY i.scheduled_start_at`);
  let r = 20261016;
  const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
  const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const msgs = [];
  const now = Date.now();
  for (const x of rows) {
    if (rnd() < 0.04) continue; // no-show
    const inT = x.s + (rnd() < 0.13 ? rint(6, 45) : rint(-14, 3)) * 60000 + rint(0, 59) * 1000;
    const outT = (rnd() < 0.07 ? x.e - rint(10, 75) * 60000 : x.e + rint(0, 20) * 60000) + rint(0, 59) * 1000;
    msgs.push({ code: x.c, thread: x.t, text: 'IN', ts: inT });
    const nb = rint(1, 2);
    for (let k = 0; k < nb; k++) {
      const c = inT + ((k + 1) * (outT - inT)) / (nb + 1);
      msgs.push({ code: x.c, thread: x.t, text: 'BREAK', ts: c });
      if (rnd() > 0.03) msgs.push({ code: x.c, thread: x.t, text: 'RESUME', ts: c + rint(8, 35) * 60000 });
    }
    if (rnd() > 0.04) msgs.push({ code: x.c, thread: x.t, text: 'OUT', ts: outT });
  }
  msgs.push({ code: 'LKR', thread: null, text: 'OUT', ts: now - 3600000 }, { code: 'LKR', thread: 4040, text: 'IN', ts: now - 7200000 }, { code: 'LKR', thread: 1001, text: 'IN 08:30', ts: now - 5400000 });
  const due = msgs.filter((m) => m.ts <= now).sort((a, b) => a.ts - b.ts);
  const stats = {};
  for (const m of due) { const res = await send(m); const k = `HTTP ${res.http} ${res.status ?? ''}${res.codes?.length ? ' ' + res.codes.join(',') : ''}`; stats[k] = (stats[k] ?? 0) + 1; }
  console.log(`Sent ${due.length} updates`, stats);
} else {
  const text = opt('text', 'IN');
  const thread = opt('thread') == null ? null : Number(opt('thread'));
  const at = opt('at');
  const r = await send({ code: opt('bot', 'LKR'), thread, text, ts: at ? lk(at) : Date.now() });
  console.log(r);
}
