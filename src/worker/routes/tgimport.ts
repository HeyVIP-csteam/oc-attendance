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

export const tgImportRoutes = new Hono<AppBindings>();

const Msg = z.object({
  id: z.number().int().positive(),
  ts: z.number().int().positive(),            // Telegram message time (ms) from date_unixtime
  reply: z.number().int().positive().nullable(), // reply_to_message_id (the topic, or a message inside the topic)
  text: z.string().max(4000),
  fwd: z.boolean().default(false),            // forwarded / sent via a bot → never a punch
});
const ImportSchema = z.object({
  chatId: z.number().int(),                   // -100… supergroup id
  fileName: z.string().max(200).default('result.json'),
  messages: z.array(Msg).max(20000),
  apply: z.boolean().default(false),
  reason: z.string().trim().max(300).optional().default(''),
});

type Result = 'NEW' | 'DUP' | 'UNREC' | 'NOTOPIC' | 'INACTIVE' | 'UNTRUSTED';
interface Row { id: number; ts: number; text: string; thread: number | null; employeeId: number | null; code: string | null; name: string | null; type: string | null; result: Result }

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
  const [maps, have] = await Promise.all([
    all<{ employee_id: number; message_thread_id: number; valid_from: number; valid_until: number | null; employee_code: string; name: string; employment_status: string; deactivated_at: number | null }>(db,
      `SELECT m.employee_id, m.message_thread_id, m.valid_from, m.valid_until, e.employee_code, e.name, e.employment_status, e.deactivated_at
       FROM telegram_topic_mappings m JOIN employees e ON e.id = m.employee_id WHERE m.chat_id = ? ORDER BY m.valid_from`, v.chatId),
    all<{ message_id: number }>(db, 'SELECT message_id FROM telegram_messages WHERE chat_id = ? AND is_edit = 0', v.chatId),
  ]);
  if (!maps.length) throw bad('NO_TOPICS', '这个群组还没有任何员工绑定 Topic，请先在 Employees 绑定', 'No employee topic is bound in this group yet — bind the topics in Employees first');
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

  const rows: Row[] = [];
  let notPunch = 0;
  for (const m of v.messages) {
    const p = parseText(m.text, idx);
    if (p.kind === 'NONE') { notPunch++; continue; }
    const thread = topicOf(m);
    const base = { id: m.id, ts: m.ts, text: m.text.slice(0, 200), thread, employeeId: null, code: null, name: null, type: p.kind === 'PUNCH' ? p.type : null };
    if (thread == null) { rows.push({ ...base, result: 'NOTOPIC' }); continue; }
    const o = ownerAt(thread, m.ts)!;
    const who = { employeeId: o.employee_id, code: o.employee_code, name: o.name };
    if (known.has(m.id)) { rows.push({ ...base, ...who, result: 'DUP' }); continue; }
    if (m.fwd) { rows.push({ ...base, ...who, result: 'UNTRUSTED' }); continue; }
    if (o.employment_status !== 'ACTIVE' && o.deactivated_at != null && o.deactivated_at <= m.ts) { rows.push({ ...base, ...who, result: 'INACTIVE' }); continue; }
    rows.push({ ...base, ...who, result: p.kind === 'PUNCH' ? 'NEW' : 'UNREC' });
  }
  const count = (r: Result) => rows.filter((x) => x.result === r).length;
  const add = rows.filter((x) => x.result === 'NEW');
  const ts = v.messages.map((m) => m.ts);
  const plan = {
    messages: v.messages.length, toAdd: add.length, already: count('DUP'), unclear: count('UNREC') + count('UNTRUSTED'), noTopic: count('NOTOPIC'), inactive: count('INACTIVE'), notPunch,
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
      VALUES (NULL, ?, ?, ?, ?, NULL, ?, ?, 0, 0, ?, ?, ?, ?, 'PROCESSED', ?, ?, 'IMPORT') ON CONFLICT DO NOTHING`,
      -x.id, v.chatId, x.id, x.thread, `import:${v.fileName}`.slice(0, 120), x.text, x.ts, now, now, x.type, x.employeeId, now));
    statements.push(stmt(db, `INSERT INTO attendance_events (message_id, employee_id, work_date, event_type, event_ts, tg_message_id, received_at, source, created_at)
      SELECT id, ?, ?, ?, ?, ?, ?, 'TELEGRAM', ? FROM telegram_messages WHERE chat_id = ? AND message_id = ? AND is_edit = 0 AND source = 'IMPORT'
        AND NOT EXISTS (SELECT 1 FROM attendance_events ev WHERE ev.message_id = telegram_messages.id)`,
      x.employeeId, localDate(x.ts, tz), x.type, x.ts, x.id, now, now, v.chatId, x.id));
  }
  statements.push(auditStmt(db, { actor, action: 'TELEGRAM_HISTORY_IMPORTED', entityType: 'telegram_messages', entityId: v.fileName,
    after: { chat_id: v.chatId, added: add.length, already_recorded: plan.already, unclear: plan.unclear, no_topic: plan.noTopic, from: plan.from, to: plan.to }, note: v.reason, ip: clientIp(c), at: now }));
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
