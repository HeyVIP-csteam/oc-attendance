// The bot's OT questions in the employee's topic (Settings → Attendance rules / Bot messages):
//  • EARLY — the employee clocked in at least N minutes before the shift: "Is this OT?"  [Yes] [No]
//  • LATE  — no clock out the set hours after the clock in: "Are you on OT?"  [Still on working] [Yes, OT] [Forgot clock out]
// The answer (inline button) decides whether OT is counted; "Forgot clock out" sets the clock out to the shift end and
// lists an exception. Answers can be changed ("Change answer"); every answer is in the audit log. Questions are only
// sent while bot replies are on for the employee's currency, and only close to the moment (never for old history).

import { type BotTexts, EXCEPTIONS, type OtAnswer, type Rules } from '../../shared/codes';
import { fmtHm, fmtTime, HOUR, MIN } from '../../shared/time';
import type { Env } from '../env';
import { applyAdjustment } from '../routes/attendance';
import { auditStmt, log } from './audit';
import { all, first, stmt } from './db';
import { redact } from './crypto';
import { recomputeMany } from './sessions';
import { bizTz, loadSettings, rulesFor, type Settings } from './settings';
import { type BotRow, botToken, tgCall } from './telegram';

const LATE_LIMIT = 2 * HOUR; // a question this late (cron paused, deploy) is not sent

type Kind = 'EARLY' | 'LATE';
const CODES: Record<string, OtAnswer> = { y: 'YES', n: 'NO', s: 'STILL', o: 'OT', f: 'FORGOT' };
const KIND_OF: Record<OtAnswer, Kind> = { YES: 'EARLY', NO: 'EARLY', STILL: 'LATE', OT: 'LATE', FORGOT: 'LATE' };

export interface TgCallback { id: string; from: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }; message?: { message_id: number; chat: { id: number } }; data?: string }

interface Ctx { inAt: number; start: number; end: number; tz: string; name: string; hours: number }
const fill = (t: string, c: Ctx) => t
  .replace(/\{name\}/g, c.name).replace(/\{in\}/g, fmtTime(c.inAt, c.tz)).replace(/\{out\}/g, fmtTime(Math.min(c.end, Date.now()), c.tz))
  .replace(/\{shift\}/g, `${fmtTime(c.start, c.tz)}–${fmtTime(c.end, c.tz)}`).replace(/\{hours\}/g, fmtHm(Math.round(c.hours * 60) * MIN));

const keyboard = (t: BotTexts, kind: Kind, id: number) => ({
  inline_keyboard: kind === 'EARLY'
    ? [[{ text: t.earlyYes, callback_data: `ot:${id}:y` }, { text: t.earlyNo, callback_data: `ot:${id}:n` }]]
    : [[{ text: t.lateStill, callback_data: `ot:${id}:s` }, { text: t.lateOt, callback_data: `ot:${id}:o` }, { text: t.lateForgot, callback_data: `ot:${id}:f` }]],
});
const label = (t: BotTexts, a: OtAnswer) => ({ YES: t.earlyYes, NO: t.earlyNo, STILL: t.lateStill, OT: t.lateOt, FORGOT: t.lateForgot })[a];
const reply = (t: BotTexts, a: OtAnswer) => ({ YES: t.earlyRYes, NO: t.earlyRNo, STILL: t.lateRStill, OT: t.lateROt, FORGOT: t.lateRForgot })[a];

/** The bot in this group: the one that received its latest message (several currencies may share a bot). */
async function botOfChat(env: Env, chatId: number, cur: string | null): Promise<{ row: BotRow; token: string } | null> {
  const last = await first<{ bot_id: number | null }>(env.DB, 'SELECT bot_id FROM telegram_messages WHERE chat_id = ? AND bot_id IS NOT NULL ORDER BY id DESC LIMIT 1', chatId);
  const row = last?.bot_id != null ? await first<BotRow>(env.DB, 'SELECT * FROM telegram_bots WHERE id = ?', last.bot_id)
    : cur ? await first<BotRow>(env.DB, 'SELECT * FROM telegram_bots WHERE currency_code = ?', cur) : null;
  if (!row || row.status === 'DISABLED') return null;
  const token = await botToken(env, row);
  return token ? { row, token } : null;
}

interface Cand { employee_id: number; work_date: string; actual_in_at: number; scheduled_start_at: number; scheduled_end_at: number; currency_code: string | null; timezone: string; name: string; chat_id: number; thread: number | null }
const CAND = `SELECT s.employee_id, s.work_date, s.actual_in_at, s.scheduled_start_at, s.scheduled_end_at, e.currency_code, e.timezone, e.name, m.chat_id, m.message_thread_id AS thread
  FROM attendance_sessions s JOIN employees e ON e.id = s.employee_id JOIN telegram_topic_mappings m ON m.employee_id = e.id AND m.is_active = 1
  WHERE s.actual_in_at IS NOT NULL AND s.scheduled_start_at IS NOT NULL AND s.scheduled_end_at IS NOT NULL AND e.employment_status = 'ACTIVE'`;

/** Sends the questions that are due now. `earlyOnly` right after a clock in (the webhook), everything from the cron. */
export async function askOtQuestions(env: Env, now: number, earlyOnly = false, settings?: Settings): Promise<number> {
  const db = env.DB;
  const st = settings ?? (await loadSettings(db));
  const due: { c: Cand; kind: Kind; rules: Rules }[] = [];
  for (const c of await all<Cand>(db, `${CAND} AND s.actual_in_at >= ? AND s.actual_in_at < s.scheduled_start_at
      AND NOT EXISTS (SELECT 1 FROM ot_questions q WHERE q.employee_id = s.employee_id AND q.work_date = s.work_date AND q.kind = 'EARLY') LIMIT 100`, now - LATE_LIMIT)) {
    const rules = rulesFor(st, c.currency_code);
    if (rules.botReply && rules.earlyAskMin > 0 && c.actual_in_at <= c.scheduled_start_at - rules.earlyAskMin * MIN) due.push({ c, kind: 'EARLY', rules });
  }
  if (!earlyOnly) {
    for (const c of await all<Cand>(db, `${CAND} AND s.actual_out_at IS NULL AND s.actual_in_at BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM ot_questions q WHERE q.employee_id = s.employee_id AND q.work_date = s.work_date AND q.kind = 'LATE') LIMIT 200`, now - 17 * HOUR, now - 59 * MIN)) {
      const rules = rulesFor(st, c.currency_code);
      const at = c.actual_in_at + Math.round(rules.forgotOutHours * 60) * MIN;
      if (rules.botReply && now >= at && now - at <= LATE_LIMIT) due.push({ c, kind: 'LATE', rules });
    }
  }
  let sent = 0;
  for (const { c, kind, rules } of due.slice(0, 50)) {
    // claim first (UNIQUE per session and kind), with the employee's own Telegram account (from the clock-in message)
    const ins = await db.prepare(`INSERT OR IGNORE INTO ot_questions (employee_id, work_date, kind, chat_id, thread_id, owner_tg_id, in_at, asked_at)
        VALUES (?, ?, ?, ?, ?, (SELECT m.from_user_id FROM attendance_events ev JOIN telegram_messages m ON m.id = ev.message_id
          WHERE ev.employee_id = ? AND ev.work_date = ? AND ev.event_type = 'CLOCK_IN' AND ev.is_voided = 0 ORDER BY ev.event_ts LIMIT 1), ?, ?)`)
      .bind(c.employee_id, c.work_date, kind, c.chat_id, c.thread, c.employee_id, c.work_date, c.actual_in_at, now).run();
    if (!ins.meta.changes) continue;
    const id = Number(ins.meta.last_row_id);
    try {
      const bot = await botOfChat(env, c.chat_id, c.currency_code);
      if (!bot) throw new Error('no bot for this group');
      const ctx: Ctx = { inAt: c.actual_in_at, start: c.scheduled_start_at, end: c.scheduled_end_at, tz: c.timezone || bizTz(env), name: c.name, hours: rules.forgotOutHours };
      const m = await tgCall<{ message_id: number }>(bot.token, 'sendMessage', {
        chat_id: c.chat_id, ...(c.thread != null ? { message_thread_id: c.thread } : {}),
        text: fill(kind === 'EARLY' ? st.botTexts.earlyQ : st.botTexts.lateQ, ctx), reply_markup: keyboard(st.botTexts, kind, id),
      }, 5000);
      await db.batch([
        stmt(db, 'UPDATE ot_questions SET tg_message_id = ?, bot_id = ? WHERE id = ?', m.message_id, bot.row.id, id),
        // the session learns about the question (an unanswered one becomes an exception later)
        stmt(db, 'UPDATE attendance_sessions SET next_check_at = 0 WHERE employee_id = ? AND work_date = ?', c.employee_id, c.work_date),
      ]);
      sent++;
    } catch (e) {
      await db.prepare('DELETE FROM ot_questions WHERE id = ?').bind(id).run(); // not asked → may be tried again by the next run
      log('warn', 'ot_question_failed', { employee: c.employee_id, kind, error: redact(String((e as Error).message)) });
    }
  }
  return sent;
}

interface QRow { id: number; employee_id: number; work_date: string; kind: Kind; chat_id: number; tg_message_id: number | null; owner_tg_id: number | null; in_at: number; answer: OtAnswer | null; forgot_event_id: number | null;
  employee_code: string; name: string; currency_code: string | null; timezone: string; scheduled_start_at: number | null; scheduled_end_at: number | null; actual_out_at: number | null }

/** A button press under a question. Always answers the callback so the button stops spinning. */
export async function handleOtCallback(env: Env, bot: BotRow, cq: TgCallback): Promise<string> {
  const token = await botToken(env, bot);
  if (!token) return 'NO_TOKEN';
  const answerCb = (text?: string, alert = false) => tgCall(token, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) }, 5000).catch(() => undefined);
  const m = /^ot:(\d{1,12}):([ynsofc])$/.exec(cq.data ?? '');
  if (!m || !cq.message || cq.from.is_bot) { await answerCb(); return 'IGNORED'; }
  const db = env.DB;
  const q = await first<QRow>(db, `SELECT q.*, e.employee_code, e.name, e.currency_code, e.timezone, s.scheduled_start_at, s.scheduled_end_at, s.actual_out_at
      FROM ot_questions q JOIN employees e ON e.id = q.employee_id LEFT JOIN attendance_sessions s ON s.employee_id = q.employee_id AND s.work_date = q.work_date WHERE q.id = ?`, Number(m[1]));
  if (!q || q.chat_id !== cq.message.chat.id || q.tg_message_id !== cq.message.message_id) { await answerCb(); return 'UNKNOWN'; }
  const settings = await loadSettings(db);
  const t = settings.botTexts;
  const rules = rulesFor(settings, q.currency_code);
  if (rules.answerBy === 'own' && q.owner_tg_id != null && cq.from.id !== q.owner_tg_id) { await answerCb(t.notYou, true); return 'NOT_YOU'; }
  const tz = q.timezone || bizTz(env);
  const ctx: Ctx = { inAt: q.in_at, start: q.scheduled_start_at ?? q.in_at, end: q.scheduled_end_at ?? q.in_at, tz, name: q.name, hours: rules.forgotOutHours };
  const question = fill(q.kind === 'EARLY' ? t.earlyQ : t.lateQ, ctx);
  if (m[2] === 'c') {
    // show the buttons again; the current answer stays until a new one is pressed
    await tgCall(token, 'editMessageReplyMarkup', { chat_id: q.chat_id, message_id: q.tg_message_id, reply_markup: keyboard(t, q.kind, q.id) }, 5000).catch(() => undefined);
    await answerCb();
    return 'CHANGE';
  }
  const a = CODES[m[2]];
  if (KIND_OF[a] !== q.kind) { await answerCb(); return 'IGNORED'; }
  const who = [cq.from.first_name, cq.from.last_name].filter(Boolean).join(' ') || (cq.from.username ? `@${cq.from.username}` : `#${cq.from.id}`);
  const now = Date.now();
  const actor = `Telegram · ${who}`.slice(0, 80);
  const prev = q.answer;
  let forgotEvent = q.forgot_event_id;
  if (prev !== a) {
    // leaving "Forgot clock out": take back the clock out it added
    if (prev === 'FORGOT' && forgotEvent) {
      const ev = await first<{ is_voided: number }>(db, 'SELECT is_voided FROM attendance_events WHERE id = ?', forgotEvent);
      if (ev && !ev.is_voided) await applyAdjustment(env, actor, 'telegram', q.employee_id, q.work_date, { action: 'VOID_EVENT', targetEventId: forgotEvent, reason: `OT answer changed to "${label(t, a)}"` }).catch(() => undefined);
      await db.prepare("DELETE FROM attendance_exceptions WHERE dedupe_key = ? AND status = 'OPEN'").bind(`OTQ|${q.id}|FORGOT`).run();
      forgotEvent = null;
    }
    // "Forgot clock out": the clock out is the shift end (never a time typed by the employee)
    if (a === 'FORGOT' && q.actual_out_at == null && q.scheduled_end_at != null) {
      const ts = Math.min(q.scheduled_end_at, now);
      await applyAdjustment(env, actor, 'telegram', q.employee_id, q.work_date, { action: 'ADD_EVENT', eventType: 'CLOCK_OUT', ts, reason: `CS forgot clock out (answered by ${who} in Telegram) — clock out set to the shift end` });
      forgotEvent = (await first<{ id: number }>(db, "SELECT id FROM attendance_events WHERE employee_id = ? AND work_date = ? AND event_type = 'CLOCK_OUT' AND source = 'ADMIN' AND is_voided = 0 ORDER BY id DESC LIMIT 1", q.employee_id, q.work_date))?.id ?? null;
      const detail = JSON.stringify({ zh: `${who} 在 Telegram 按了「${label(t, a)}」，下班时间设为排班下班 ${fmtTime(ts, bizTz(env))}，可以在考勤明细修改`, en: `${who} pressed "${label(t, a)}" in Telegram; clock out set to the shift end ${fmtTime(ts, bizTz(env))} — you can change it in the attendance detail` });
      await db.prepare(`INSERT INTO attendance_exceptions (dedupe_key, source, code, severity, employee_id, work_date, occurred_at, detail, status, created_at, updated_at)
          VALUES (?, 'INGEST', 'FORGOT_CLOCK_OUT', ?, ?, ?, ?, ?, 'OPEN', ?, ?) ON CONFLICT (dedupe_key) DO UPDATE SET status = 'OPEN', detail = excluded.detail, occurred_at = excluded.occurred_at, updated_at = excluded.updated_at`)
        .bind(`OTQ|${q.id}|FORGOT`, EXCEPTIONS.FORGOT_CLOCK_OUT.sev, q.employee_id, q.work_date, ts, detail, now, now).run();
    }
    await db.batch([
      stmt(db, 'UPDATE ot_questions SET answer = ?, answered_by = ?, answered_by_tg = ?, answered_at = ?, forgot_event_id = ? WHERE id = ?', a, who.slice(0, 80), cq.from.id, now, forgotEvent, q.id),
      auditStmt(db, { actor, action: 'OT_QUESTION_ANSWERED', entityType: 'attendance_session', entityId: `${q.employee_code}@${q.work_date}`,
        before: { question: q.kind, answer: prev ?? '' }, after: { question: q.kind, answer: a, answered_by: who, telegram_user: cq.from.id }, ip: 'telegram', at: now }),
      stmt(db, "UPDATE system_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ? WHERE key = 'data_version'", now),
    ]);
    await recomputeMany(db, [[q.employee_id, q.work_date]], { now, tz: bizTz(env), rules: settings.rules, byCur: settings.rulesCur });
  }
  // the question shows who answered (with "Change answer"); the bot replies with the configured text
  await tgCall(token, 'editMessageText', {
    chat_id: q.chat_id, message_id: q.tg_message_id, text: `${question}\n\n✓ ${label(t, a)} · ${who} · ${fmtTime(now, tz)}`,
    reply_markup: { inline_keyboard: [[{ text: t.change, callback_data: `ot:${q.id}:c` }]] },
  }, 5000).catch(() => undefined);
  if (prev !== a) {
    await tgCall(token, 'sendMessage', { chat_id: q.chat_id, text: fill(reply(t, a), { ...ctx, end: q.scheduled_end_at ?? now }), reply_parameters: { message_id: q.tg_message_id, allow_sending_without_reply: true } }, 5000)
      .catch((e) => log('warn', 'ot_reply_failed', { error: redact(String((e as Error).message)) }));
  }
  await answerCb('✅');
  return a;
}
