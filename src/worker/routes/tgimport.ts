// Import of a Telegram Desktop chat export (result.json, "Machine-readable JSON") for punches sent before the bot
// joined the group. The browser reads the file and sends a compact list of messages; this route matches each message to
// the employee bound to its topic, reads it with the punch keywords, and (on apply) stores it exactly like a message the
// bot received: a raw telegram_messages row (source IMPORT) plus an attendance event at Telegram's own message time.

import { Hono } from 'hono';
import { z } from 'zod';
import { buildKeywordIndex, parseText } from '../../shared/parser';
import { addDays, fmtDateTime, localDate } from '../../shared/time';
import type { AppBindings } from '../env';
import { auditStmt } from '../lib/audit';
import { all, chunk, stmt } from '../lib/db';
import { bad, body, clientIp, requireAdminRole } from '../lib/http';
import { type Key, reassignEvents, recomputeOrDefer } from '../lib/sessions';
import { bizTz, loadSettings } from '../lib/settings';
import { inScope, scopeOf } from '../lib/scope';
import { agentCandidates, nameKey, personName } from '../../shared/tgexport';

export const tgImportRoutes = new Hono<AppBindings>();

const Msg = z.object({
  id: z.number().int().positive(),
  ts: z.number().int().positive(),            // Telegram message time (ms) from date_unixtime
  reply: z.number().int().positive().nullable(), // reply_to_message_id (the topic, or a message inside the topic)
  text: z.string().max(4000),
  fwd: z.boolean().default(false),            // forwarded / sent via a bot → never a punch
  from: z.string().max(120).optional().default(''),               // sender's display name in the export
  fromId: z.number().int().positive().nullable().optional().default(null), // sender's Telegram user id
});
const ImportSchema = z.object({
  chatId: z.number().int(),                   // -100… supergroup id
  fileName: z.string().max(200).default('result.json'),
  messages: z.array(Msg).max(20000),
  apply: z.boolean().default(false),
  reason: z.string().trim().max(300).optional().default(''),
  // group without topics: the employee chosen for a Telegram account (user id → employee id; null = undo the choice)
  topicsSince: z.number().int().positive().nullable().optional().default(null), // first topic created (from the export)
  // keys: "u:<telegram user id>" (a personal account), "n:<name>" (a name written in the messages of a shared account),
  //       "m:<message id>" (one message without a name)
  senders: z.record(z.string().max(60).regex(/^(u:\d{1,15}|m:\d{1,12}|n:.{1,50})$/), z.number().int().positive().nullable()).optional().default({}),
});

type Result = 'NEW' | 'DUP' | 'UNREC' | 'NOTOPIC' | 'NEED' | 'INACTIVE' | 'UNTRUSTED';
interface Row { id: number; ts: number; text: string; thread: number | null; employeeId: number | null; code: string | null; name: string | null; type: string | null; result: Result; from: string; fromId: number | null; key: string | null; who: string | null }
interface Emp { id: number; employee_code: string; name: string; currency_code: string | null; employment_status: string; deactivated_at: number | null }
/** How the employee of a Telegram account was found: chosen now, chosen before, seen in the employee's topic, by the Agent name; or not (yet). */
type By = 'MAN' | 'SAVED' | 'KNOWN' | 'NAME' | 'TWO' | 'NONE';

tgImportRoutes.post('/telegram-import', async (c) => {
  requireAdminRole(c);
  const v = await body(c, ImportSchema);
  const db = c.env.DB;
  const tz = bizTz(c.env);
  const now = Date.now();
  if (!/^-100\d{5,17}$/.test(String(v.chatId))) throw bad('VALIDATION', '群组 ID 格式错误', 'Invalid group id');
  if (v.apply && v.reason.length < 4) throw bad('REASON', '请填写原因（至少 4 个字）', 'Please give a reason (at least 4 characters)');

  const settings = await loadSettings(db);
  const idx = buildKeywordIndex(settings.keywords, settings.parser);
  const [maps, have, empAll] = await Promise.all([
    all<{ employee_id: number; message_thread_id: number; valid_from: number; valid_until: number | null; employee_code: string; name: string; employment_status: string; deactivated_at: number | null; currency_code: string | null }>(db,
      `SELECT m.employee_id, m.message_thread_id, m.valid_from, m.valid_until, e.employee_code, e.name, e.employment_status, e.deactivated_at, e.currency_code
       FROM telegram_topic_mappings m JOIN employees e ON e.id = m.employee_id WHERE m.chat_id = ? ORDER BY m.valid_from`, v.chatId),
    all<{ message_id: number }>(db, 'SELECT message_id FROM telegram_messages WHERE chat_id = ? AND is_edit = 0', v.chatId),
    all<Emp>(db, 'SELECT id, employee_code, name, currency_code, employment_status, deactivated_at FROM employees'),
  ]);
  const empById = new Map(empAll.map((e) => [e.id, e]));
  const mine = empAll.filter((e) => inScope(c, e.currency_code));
  const threads = new Set(maps.map((m) => m.message_thread_id));
  const known = new Set(have.map((h) => h.message_id));
  const byId = new Map(v.messages.map((m) => [m.id, m]));

  // the topic of a message: follow its reply chain inside the export until it reaches a bound topic
  const topicOf = (m: z.infer<typeof Msg>): number | null => {
    let r = m.reply;
    for (let i = 0; r != null && i < 100; i++) {
      if (threads.has(r)) return r;
      const p = byId.get(r);
      if (!p) return null;
      r = p.reply;
    }
    return null;
  };
  // the employee of a topic at that time; before the topic was bound (the usual case here) its first owner
  const ownerAt = (thread: number, ts: number) => {
    const list = maps.filter((m) => m.message_thread_id === thread);
    return list.find((m) => m.valid_from <= ts && (m.valid_until == null || m.valid_until > ts)) ?? list.find((m) => m.valid_from > ts) ?? null;
  };

  // a limited account only sees and imports its currencies' employees; other messages are left out
  const limited = scopeOf(c) !== null;
  let hiddenNoTopic = 0;
  let notPunch = 0;
  const parsed = v.messages.map((m) => ({ m, p: parseText(m.text, idx), thread: topicOf(m) }));
  // messages outside a topic are matched by their sender only while the group had no topics: a group with no bound
  // topic, or messages sent before its first topic was created (afterwards a punch outside a topic is not accepted,
  // exactly as when the bot receives it)
  const bySender = (ts: number) => !maps.length || (v.topicsSince != null && ts < v.topicsSince);

  // ---- a group without topics (or messages outside the bound topics): who is each message about?
  //  • a personal Telegram account (one person): all its messages belong to that person (matched once per account)
  //  • a shared account (several names written in its messages, e.g. one "ice_csinr1" used by the whole team):
  //    each message belongs to the name written in it ("Agent: Joan", "Break — Darsh", "( David )" …), or to the
  //    name of the message it replies to; messages without any name are chosen one by one (or skipped)
  type GroupKind = 'ACCOUNT' | 'NAME';
  interface Group { key: string; kind: GroupKind; label: string; account: string; fromId: number; agents: Map<string, number>; n: number; emp: Emp | null; by: By; cands: Emp[] }
  const own = new Map<number, string | null>();
  const nameIn = (m: z.infer<typeof Msg>) => { if (!own.has(m.id)) own.set(m.id, personName(m.text, idx.tokens)); return own.get(m.id)!; };
  const nameOf = (m: z.infer<typeof Msg>): string | null => {
    let cur = m;
    for (let k = 0; k < 20; k++) {
      const n = nameIn(cur);
      if (n) return n;
      const p = cur.reply != null ? byId.get(cur.reply) : undefined;
      if (!p || p.fromId !== m.fromId) return null; // only through the same account's own messages
      cur = p;
    }
    return null;
  };
  const outside = parsed.filter(({ m, thread }) => thread == null && m.fromId != null && bySender(m.ts));
  const namesOfAccount = new Map<number, Set<string>>();
  for (const { m } of outside) { const n = nameIn(m); if (n) namesOfAccount.set(m.fromId!, (namesOfAccount.get(m.fromId!) ?? new Set()).add(nameKey(n))); }
  const shared = (id: number) => (namesOfAccount.get(id)?.size ?? 0) > 1;
  const groups = new Map<string, Group>();
  const keyOfMsg = new Map<number, string>(); // message id → group key, or "m:<id>" for a message without a name on a shared account
  for (const { m, p } of outside) {
    const id = m.fromId!;
    let key: string, kind: GroupKind, label: string;
    if (!shared(id)) { key = `u:${id}`; kind = 'ACCOUNT'; label = m.from; }
    else {
      const n = nameOf(m);
      if (!n) { keyOfMsg.set(m.id, `m:${m.id}`); continue; }
      key = `n:${nameKey(n)}`; kind = 'NAME'; label = n;
    }
    keyOfMsg.set(m.id, key);
    const g = groups.get(key) ?? { key, kind, label, account: m.from, fromId: id, agents: new Map(), n: 0, emp: null, by: 'NONE' as By, cands: [] };
    if (p.kind !== 'NONE') g.n++;
    if (kind === 'ACCOUNT' && m.from) g.label = m.from;
    const a = nameIn(m);
    if (a) g.agents.set(a, (g.agents.get(a) ?? 0) + 1);
    groups.set(key, g);
  }
  const ok = (id: number | undefined | null) => (id != null && empById.has(id) && inScope(c, empById.get(id)!.currency_code) ? empById.get(id)! : null);
  if (groups.size) {
    const ids = [...groups.values()].filter((g) => g.kind === 'ACCOUNT').map((g) => g.fromId);
    const names = [...groups.values()].filter((g) => g.kind === 'NAME').map((g) => g.key.slice(2));
    const saved = new Map<string, number>();
    const seen = new Map<number, number>();
    for (const part of chunk(ids, 90)) {
      const q = part.map(() => '?').join(',');
      for (const r of await all<{ from_user_id: number; employee_id: number }>(db, `SELECT from_user_id, employee_id FROM tg_sender_employees WHERE from_user_id IN (${q})`, ...part)) saved.set(`u:${r.from_user_id}`, r.employee_id);
      // the employee this account already punched for in a bound topic (the bot recorded it)
      for (const r of await all<{ from_user_id: number; employee_id: number }>(db, `SELECT from_user_id, employee_id FROM telegram_messages
          WHERE from_user_id IN (${q}) AND employee_id IS NOT NULL AND source = 'WEBHOOK' GROUP BY from_user_id, employee_id ORDER BY COUNT(*)`, ...part)) seen.set(r.from_user_id, r.employee_id);
    }
    for (const part of chunk(names, 90)) {
      for (const r of await all<{ name_key: string; employee_id: number }>(db, `SELECT name_key, employee_id FROM tg_agent_names WHERE name_key IN (${part.map(() => '?').join(',')})`, ...part)) saved.set(`n:${r.name_key}`, r.employee_id);
    }
    for (const g of groups.values()) {
      const agent = g.kind === 'NAME' ? g.label : [...g.agents.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
      const cands = agent ? agentCandidates(agent, mine) : [];
      const chosen = v.senders[g.key];
      let e: Emp | null;
      if (chosen != null && (e = ok(chosen))) { g.emp = e; g.by = 'MAN'; }
      else if (chosen === undefined && (e = ok(saved.get(g.key)))) { g.emp = e; g.by = 'SAVED'; }
      else if (g.kind === 'ACCOUNT' && (e = ok(seen.get(g.fromId)))) { g.emp = e; g.by = 'KNOWN'; }
      else if (cands.length === 1) { g.emp = cands[0]; g.by = 'NAME'; }
      else { g.by = cands.length > 1 ? 'TWO' : 'NONE'; g.cands = cands; }
    }
  }
  const senders = groups;

  const rows: Row[] = [];
  for (const { m, p, thread } of parsed) {
    if (p.kind === 'NONE') { notPunch++; continue; }
    const base: Row = { id: m.id, ts: m.ts, text: m.text.slice(0, 200), thread, employeeId: null, code: null, name: null, type: p.kind === 'PUNCH' ? p.type : null, from: m.from, fromId: m.fromId, key: null, who: null, result: 'NEW' };
    let o: Pick<Emp, 'id' | 'employee_code' | 'name' | 'currency_code' | 'employment_status' | 'deactivated_at'>;
    if (thread != null) {
      const t = ownerAt(thread, m.ts)!;
      o = { id: t.employee_id, employee_code: t.employee_code, name: t.name, currency_code: t.currency_code, employment_status: t.employment_status, deactivated_at: t.deactivated_at };
    } else {
      const key = keyOfMsg.get(m.id);
      if (!key) { if (limited) hiddenNoTopic++; else rows.push({ ...base, result: 'NOTOPIC' }); continue; }
      base.key = key;
      base.who = m.fromId != null && shared(m.fromId) ? nameOf(m) : null;
      // a message without a name on a shared account: chosen one by one
      if (key.startsWith('m:')) {
        const e = ok(v.senders[key]);
        if (!e) { rows.push({ ...base, result: 'NEED' }); continue; }
        o = e;
      } else {
        const g = groups.get(key)!;
        // a limited account does not see names / accounts that point to no employee of its currencies
        if (!g.emp) { if (limited && !g.cands.length && g.by !== 'NONE') hiddenNoTopic++; else rows.push({ ...base, result: 'NEED' }); continue; }
        o = g.emp;
      }
    }
    if (!inScope(c, o.currency_code)) continue;
    const who = { employeeId: o.id, code: o.employee_code, name: o.name };
    if (known.has(m.id)) { rows.push({ ...base, ...who, result: 'DUP' }); continue; }
    if (m.fwd) { rows.push({ ...base, ...who, result: 'UNTRUSTED' }); continue; }
    if (o.employment_status !== 'ACTIVE' && o.deactivated_at != null && o.deactivated_at <= m.ts) { rows.push({ ...base, ...who, result: 'INACTIVE' }); continue; }
    rows.push({ ...base, ...who, result: p.kind === 'PUNCH' ? 'NEW' : 'UNREC' });
  }
  const count = (r: Result) => rows.filter((x) => x.result === r).length;
  const add = rows.filter((x) => x.result === 'NEW');
  const ts = v.messages.map((m) => m.ts);
  const plan = {
    messages: v.messages.length, toAdd: add.length, already: count('DUP'), unclear: count('UNREC') + count('UNTRUSTED'), noTopic: count('NOTOPIC') + hiddenNoTopic, need: count('NEED'), inactive: count('INACTIVE'), notPunch,
    senders: [...senders.values()].filter((s) => s.n > 0 && (!limited || s.emp || s.cands.length || s.by === 'NONE')).sort((x, y) => Number(!!x.emp) - Number(!!y.emp) || y.n - x.n).map((s) => ({
      key: s.key, kind: s.kind, name: s.kind === 'NAME' ? s.label : s.label || s.account, account: s.account, agent: s.kind === 'NAME' ? null : [...s.agents.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null, n: s.n, by: s.by,
      spellings: s.kind === 'NAME' ? [...s.agents.keys()].filter((x) => x !== s.label).slice(0, 5) : [],
      employeeId: s.emp?.id ?? null, code: s.emp?.employee_code ?? null, empName: s.emp?.name ?? null,
      cands: s.cands.map((e) => ({ id: e.id, code: e.employee_code, name: e.name })),
    })),
    from: ts.length ? localDate(Math.min(...ts), tz) : null, to: ts.length ? localDate(Math.max(...ts), tz) : null,
    rows: rows.slice(0, 3000).map((x) => ({ ...x, time: fmtDateTime(x.ts, tz), workDate: localDate(x.ts, tz) })),
  };
  if (!v.apply) return c.json({ plan });
  if (!add.length) return c.json({ plan, applied: { added: 0 } });

  // write the raw messages + events exactly like the webhook does (work dates are settled right after by reassignEvents)
  const actor = c.get('admin').username;
  const statements: D1PreparedStatement[] = [];
  for (const x of add) {
    statements.push(stmt(db, `INSERT INTO telegram_messages (bot_id, update_id, chat_id, message_id, message_thread_id, from_user_id, from_name, raw_text, is_edit, is_forwarded,
        telegram_message_ts, received_at, processed_at, parsed_event_type, processing_status, employee_id, created_at, source)
      VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'PROCESSED', ?, ?, 'IMPORT') ON CONFLICT DO NOTHING`,
      -x.id, v.chatId, x.id, x.thread, x.fromId, (x.from || `import:${v.fileName}`).slice(0, 120), x.text, x.ts, now, now, x.type, x.employeeId, now));
    statements.push(stmt(db, `INSERT INTO attendance_events (message_id, employee_id, work_date, event_type, event_ts, tg_message_id, received_at, source, created_at)
      SELECT id, ?, ?, ?, ?, ?, ?, 'TELEGRAM', ? FROM telegram_messages WHERE chat_id = ? AND message_id = ? AND is_edit = 0 AND source = 'IMPORT'
        AND NOT EXISTS (SELECT 1 FROM attendance_events ev WHERE ev.message_id = telegram_messages.id)`,
      x.employeeId, localDate(x.ts, tz), x.type, x.ts, x.id, now, now, v.chatId, x.id));
  }
  // remember the employees chosen for Telegram accounts (next import of this group needs no choosing)
  const chosen = [...senders.values()].filter((s) => s.by === 'MAN' && s.emp);
  for (const s of chosen) {
    if (s.kind === 'ACCOUNT') statements.push(stmt(db, `INSERT INTO tg_sender_employees (from_user_id, employee_id, updated_at, updated_by) VALUES (?,?,?,?)
      ON CONFLICT (from_user_id) DO UPDATE SET employee_id = excluded.employee_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, s.fromId, s.emp!.id, now, actor));
    else statements.push(stmt(db, `INSERT INTO tg_agent_names (name_key, employee_id, updated_at, updated_by) VALUES (?,?,?,?)
      ON CONFLICT (name_key) DO UPDATE SET employee_id = excluded.employee_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, s.key.slice(2), s.emp!.id, now, actor));
  }
  statements.push(auditStmt(db, { actor, action: 'TELEGRAM_HISTORY_IMPORTED', entityType: 'telegram_messages', entityId: v.fileName,
    after: { chat_id: v.chatId, added: add.length, already_recorded: plan.already, unclear: plan.unclear, no_topic: plan.noTopic, not_matched: plan.need, accounts_chosen: chosen.map((s) => `${s.label || s.key} → ${s.emp!.employee_code}`), from: plan.from, to: plan.to }, note: v.reason, ip: clientIp(c), at: now }));
  statements.push(stmt(db, "UPDATE system_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ? WHERE key = 'data_version'", now));
  for (const part of chunk(statements, 90)) await db.batch(part);

  // settle work dates (night shifts, breaks across midnight …) and recompute every affected day
  const emps = [...new Set(add.map((x) => x.employeeId!))];
  const dates = add.map((x) => localDate(x.ts, tz)).sort();
  const o = { now, tz, rules: settings.rules, byCur: settings.rulesCur };
  const { updates, keys } = await reassignEvents(db, emps, addDays(dates[0], -1), dates[dates.length - 1], o, tz);
  for (const part of chunk(updates, 90)) await db.batch(part);
  const affected: Key[] = [...keys];
  for (const x of add) for (const d of [addDays(localDate(x.ts, tz), -1), localDate(x.ts, tz)]) affected.push([x.employeeId!, d]);
  const r = await recomputeOrDefer(db, affected, o);
  return c.json({ plan, applied: { added: add.length, recomputed: r.inline, deferred: r.deferred } });
});
