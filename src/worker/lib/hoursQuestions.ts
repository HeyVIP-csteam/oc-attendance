// The bot's "Incomplete working hours" question (Settings → Bot messages), sent with the clock-out confirmation when
// the employee clocks out before completing the shift length (breaks included; a late employee counts from the clock in):
//   [Yes]              the clock out stands; "Incomplete working hours" stays under Exceptions
//   [No]               the clock out is cancelled (voided, audited) — the employee is still working and clocks out again later;
//                      "Clock out cancelled (No)" is listed under Exceptions and is not recalculated away
//   [Forgot clock in]  the clock out stands; "Forgot clock in" is listed under Exceptions for the admin to approve
//                      (approving = correcting the clock in, from the exception or the attendance detail)
// Answers can be changed ("Change answer"); every answer is in the audit log. Nobody answers within the OT-question wait
// → "No answer to the working hours question". Who may press follows Attendance rules → "Who may answer".

import { type BotTexts, EXCEPTIONS, type HoursAnswer } from '../../shared/codes';
import type { Incomplete } from '../../shared/engine';
import { fmtHm, fmtTime, MIN } from '../../shared/time';
import type { Env } from '../env';
import { applyAdjustment } from '../routes/attendance';
import { auditStmt, log } from './audit';
import { redact } from './crypto';
import { first, stmt } from './db';
import { recomputeMany } from './sessions';
import { bizTz, loadSettings, rulesFor } from './settings';
import { type BotRow, botToken, tgCall } from './telegram';
import type { TgCallback } from './otQuestions';

let ready = false;
/** Creates the table on first use, so a deploy does not depend on running migration 0020 first. */
export async function ensureHoursQuestions(db: D1Database): Promise<void> {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS hours_questions (
      id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id), work_date TEXT NOT NULL,
      out_event_id INTEGER NOT NULL UNIQUE, out_at INTEGER NOT NULL, chat_id INTEGER NOT NULL, thread_id INTEGER, bot_id INTEGER,
      tg_message_id INTEGER, owner_tg_id INTEGER, text TEXT NOT NULL, vars TEXT NOT NULL, asked_at INTEGER NOT NULL,
      answer TEXT CHECK (answer IN ('YES','NO','FORGOT_IN')), answered_by TEXT, answered_by_tg INTEGER, answered_at INTEGER)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_hq_session ON hours_questions(employee_id, work_date)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_hq_message ON hours_questions(chat_id, tg_message_id)'),
  ]);
  ready = true;
}
/** Tests only. */
export const resetHoursQuestionsForTests = () => { ready = false; };

/** The fields the texts can use: {name} {shift} {in} {out} {worked} {need} {until} {short}. */
export function hoursVars(inc: Incomplete, c: { name: string; inT: number | null; outT: number; start: number | null; end: number | null; tz: string }): Record<string, string> {
  return {
    name: c.name, shift: c.start != null && c.end != null ? `${fmtTime(c.start, c.tz)}–${fmtTime(c.end, c.tz)}` : '',
    in: fmtTime(c.inT, c.tz), out: fmtTime(c.outT, c.tz), worked: fmtHm(inc.workedMs), need: fmtHm(inc.needMs),
    until: fmtTime(inc.untilAt, c.tz), short: fmtHm(Math.floor(inc.shortMs / MIN) * MIN),
  };
}
export const fillVars = (t: string, v: Record<string, string>) => t.replace(/\{(name|shift|in|out|worked|need|until|short)\}/g, (_, k: string) => v[k] ?? '');

const CODES: Record<string, HoursAnswer> = { y: 'YES', n: 'NO', f: 'FORGOT_IN' };
const keyboard = (t: BotTexts, id: number) => ({ inline_keyboard: [[
  { text: t.incYes, callback_data: `hq:${id}:y` }, { text: t.incNo, callback_data: `hq:${id}:n` }, { text: t.incForgot, callback_data: `hq:${id}:f` }]] });
const label = (t: BotTexts, a: HoursAnswer) => ({ YES: t.incYes, NO: t.incNo, FORGOT_IN: t.incForgot })[a];
const reply = (t: BotTexts, a: HoursAnswer) => ({ YES: t.incRYes, NO: t.incRNo, FORGOT_IN: t.incRForgot })[a];

export interface HoursAsk { employeeId: number; workDate: string; outEventId: number; outAt: number; chatId: number; threadId: number | null; replyTo: number; ownerTgId: number | null; confirm: string; vars: Record<string, string> }

/**
 * Sends the clock-out confirmation together with the question and its buttons (one message, a reply to the OUT).
 * If the question cannot be stored or sent, the plain confirmation is sent instead.
 */
export async function sendHoursQuestion(env: Env, bot: BotRow, token: string, a: HoursAsk): Promise<boolean> {
  const db = env.DB;
  const t = (await loadSettings(db)).botTexts;
  const text = `${a.confirm}\n\n${fillVars(t.incomplete, a.vars)}`;
  const base = { chat_id: a.chatId, ...(a.threadId != null ? { message_thread_id: a.threadId } : {}), reply_parameters: { message_id: a.replyTo, allow_sending_without_reply: true } };
  let id: number | null = null;
  try {
    await ensureHoursQuestions(db);
    const ins = await db.prepare(`INSERT OR IGNORE INTO hours_questions (employee_id, work_date, out_event_id, out_at, chat_id, thread_id, owner_tg_id, text, vars, asked_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(a.employeeId, a.workDate, a.outEventId, a.outAt, a.chatId, a.threadId, a.ownerTgId, text, JSON.stringify(a.vars), Date.now()).run();
    if (!ins.meta.changes) return false; // already asked about this clock out
    id = Number(ins.meta.last_row_id);
    const m = await tgCall<{ message_id: number }>(token, 'sendMessage', { ...base, text, reply_markup: keyboard(t, id) }, 5000);
    await db.batch([
      stmt(db, 'UPDATE hours_questions SET tg_message_id = ?, bot_id = ? WHERE id = ?', m.message_id, bot.id, id),
      // the session learns about the question (an unanswered one becomes an exception later)
      stmt(db, 'UPDATE attendance_sessions SET next_check_at = 0 WHERE employee_id = ? AND work_date = ?', a.employeeId, a.workDate),
    ]);
    return true;
  } catch (e) {
    log('warn', 'hours_question_failed', { employee: a.employeeId, error: redact(String((e as Error).message)) });
    if (id != null) await db.prepare('DELETE FROM hours_questions WHERE id = ?').bind(id).run().catch(() => undefined);
    await tgCall(token, 'sendMessage', { ...base, text: a.confirm, disable_notification: true }, 5000).catch(() => undefined);
    return false;
  }
}

interface QRow { id: number; employee_id: number; work_date: string; out_event_id: number; out_at: number; chat_id: number; tg_message_id: number | null; owner_tg_id: number | null;
  text: string; vars: string; asked_at: number; answer: HoursAnswer | null; employee_code: string; currency_code: string | null; timezone: string }

/** A press on the buttons under a working hours question. Always answers the callback so the button stops spinning. */
export async function handleHoursCallback(env: Env, bot: BotRow, cq: TgCallback): Promise<string> {
  const token = await botToken(env, bot);
  if (!token) return 'NO_TOKEN';
  const answerCb = (text?: string, alert = false) => tgCall(token, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) }, 5000).catch(() => undefined);
  const m = /^hq:(\d{1,12}):([ynfc])$/.exec(cq.data ?? '');
  if (!m || !cq.message || cq.from.is_bot) { await answerCb(); return 'IGNORED'; }
  const db = env.DB;
  await ensureHoursQuestions(db);
  const q = await first<QRow>(db, `SELECT q.*, e.employee_code, e.currency_code, e.timezone FROM hours_questions q JOIN employees e ON e.id = q.employee_id WHERE q.id = ?`, Number(m[1]));
  if (!q || q.chat_id !== cq.message.chat.id || q.tg_message_id !== cq.message.message_id) { await answerCb(); return 'UNKNOWN'; }
  const settings = await loadSettings(db);
  const t = settings.botTexts;
  const rules = rulesFor(settings, q.currency_code);
  if (rules.answerBy === 'own' && q.owner_tg_id != null && cq.from.id !== q.owner_tg_id) { await answerCb(t.notYou, true); return 'NOT_YOU'; }
  const tz = q.timezone || bizTz(env);
  if (m[2] === 'c') {
    // show the buttons again; the current answer stays until a new one is pressed
    await tgCall(token, 'editMessageReplyMarkup', { chat_id: q.chat_id, message_id: q.tg_message_id, reply_markup: keyboard(t, q.id) }, 5000).catch(() => undefined);
    await answerCb();
    return 'CHANGE';
  }
  const a = CODES[m[2]];
  const who = [cq.from.first_name, cq.from.last_name].filter(Boolean).join(' ') || (cq.from.username ? `@${cq.from.username}` : `#${cq.from.id}`);
  const actor = `Telegram · ${who}`.slice(0, 80);
  const now = Date.now();
  const prev = q.answer;
  const vars = (() => { try { return JSON.parse(q.vars) as Record<string, string>; } catch { return {}; } })();
  const activeOut = (exactly: boolean) => first<{ id: number }>(db, `SELECT id FROM attendance_events WHERE employee_id = ? AND work_date = ? AND event_type = 'CLOCK_OUT' AND is_voided = 0
      ${exactly ? 'AND event_ts = ?' : ''} ORDER BY id DESC LIMIT 1`, ...[q.employee_id, q.work_date, ...(exactly ? [q.out_at] : [])]);
  if (prev !== a) {
    // leaving "No": the cancelled clock out comes back — unless the employee has clocked out again since
    if (prev === 'NO') {
      if (await activeOut(false)) { await answerCb(t.incClockedAgain, true); return 'CLOCKED_OUT_AGAIN'; }
      await applyAdjustment(env, actor, 'telegram', q.employee_id, q.work_date, { action: 'ADD_EVENT', eventType: 'CLOCK_OUT', ts: q.out_at, reason: `Working hours answer changed to "${label(t, a)}" (by ${who} in Telegram) — clock out restored` });
    }
    // "No": cancel this clock out — the employee is still working
    if (a === 'NO') {
      const ev = await activeOut(true);
      if (ev) await applyAdjustment(env, actor, 'telegram', q.employee_id, q.work_date, { action: 'VOID_EVENT', targetEventId: ev.id, reason: `Clock out cancelled: ${who} pressed "${label(t, a)}" (still working) in Telegram` });
    }
    if (prev === 'FORGOT_IN') await db.prepare("DELETE FROM attendance_exceptions WHERE dedupe_key = ? AND status = 'OPEN'").bind(`HQ|${q.id}|FORGOT_IN`).run();
    // "No" pressed by mistake and changed: its record goes too (it is kept once an admin has handled it)
    if (prev === 'NO') await db.prepare("DELETE FROM attendance_exceptions WHERE dedupe_key = ? AND status = 'OPEN'").bind(`HQ|${q.id}|NO`).run();
    // "No": a record that the employee tried to clock out early — it stays (not recalculated away)
    if (a === 'NO') {
      const detail = JSON.stringify({
        zh: `${who} 在 Telegram 按了「${label(t, a)}」：${vars.out ?? '—'} 的下班卡已取消（应 ${vars.until ?? '—'} 下班，当时差 ${vars.short ?? '—'}），员工继续上班`,
        en: `${who} pressed "${label(t, a)}" in Telegram: the ${vars.out ?? '—'} clock out was cancelled (due at ${vars.until ?? '—'}, ${vars.short ?? '—'} short at the time); the employee kept working` });
      await db.prepare(`INSERT INTO attendance_exceptions (dedupe_key, source, code, severity, employee_id, work_date, occurred_at, detail, status, created_at, updated_at)
          VALUES (?, 'INGEST', 'CLOCK_OUT_CANCELLED', ?, ?, ?, ?, ?, 'OPEN', ?, ?) ON CONFLICT (dedupe_key) DO UPDATE SET status = 'OPEN', detail = excluded.detail, updated_at = excluded.updated_at`)
        .bind(`HQ|${q.id}|NO`, EXCEPTIONS.CLOCK_OUT_CANCELLED.sev, q.employee_id, q.work_date, q.out_at, detail, now, now).run();
    }
    if (a === 'FORGOT_IN') {
      const detail = JSON.stringify({
        zh: `${who} 在 Telegram 按了「${label(t, a)}」：员工表示忘记上班打卡（记录的上班 ${vars.in ?? '—'}，班次 ${vars.shift ?? '—'}）。批准时请修改上班时间。`,
        en: `${who} pressed "${label(t, a)}" in Telegram: the employee says they forgot to clock in (recorded clock in ${vars.in ?? '—'}, shift ${vars.shift ?? '—'}). To approve, correct the clock-in time.` });
      await db.prepare(`INSERT INTO attendance_exceptions (dedupe_key, source, code, severity, employee_id, work_date, occurred_at, detail, status, created_at, updated_at)
          VALUES (?, 'INGEST', 'FORGOT_CLOCK_IN', ?, ?, ?, ?, ?, 'OPEN', ?, ?) ON CONFLICT (dedupe_key) DO UPDATE SET status = 'OPEN', detail = excluded.detail, updated_at = excluded.updated_at`)
        .bind(`HQ|${q.id}|FORGOT_IN`, EXCEPTIONS.FORGOT_CLOCK_IN.sev, q.employee_id, q.work_date, q.out_at, detail, now, now).run();
    }
    await db.batch([
      stmt(db, 'UPDATE hours_questions SET answer = ?, answered_by = ?, answered_by_tg = ?, answered_at = ? WHERE id = ?', a, who.slice(0, 80), cq.from.id, now, q.id),
      auditStmt(db, { actor, action: 'HOURS_QUESTION_ANSWERED', entityType: 'attendance_session', entityId: `${q.employee_code}@${q.work_date}`,
        before: { question: 'INCOMPLETE_HOURS', answer: prev ?? '' }, after: { question: 'INCOMPLETE_HOURS', answer: a, answered_by: who, telegram_user: cq.from.id }, ip: 'telegram', at: now }),
      stmt(db, "UPDATE system_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ? WHERE key = 'data_version'", now),
    ]);
    await recomputeMany(db, [[q.employee_id, q.work_date]], { now, tz: bizTz(env), rules: settings.rules, byCur: settings.rulesCur });
  }
  // the question shows who answered (with "Change answer"); the bot replies with the configured text
  await tgCall(token, 'editMessageText', {
    chat_id: q.chat_id, message_id: q.tg_message_id, text: `${q.text}\n\n✓ ${label(t, a)} · ${who} · ${fmtTime(now, tz)}`,
    reply_markup: { inline_keyboard: [[{ text: t.change, callback_data: `hq:${q.id}:c` }]] },
  }, 5000).catch(() => undefined);
  if (prev !== a) {
    await tgCall(token, 'sendMessage', { chat_id: q.chat_id, text: fillVars(reply(t, a), vars), reply_parameters: { message_id: q.tg_message_id, allow_sending_without_reply: true } }, 5000)
      .catch((e) => log('warn', 'hours_reply_failed', { error: redact(String((e as Error).message)) }));
  }
  await answerCb('✅');
  return a;
}
