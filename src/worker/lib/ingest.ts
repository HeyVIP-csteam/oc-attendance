// Telegram update → raw message → (identity check) → attendance event → session recompute.
//
// Idempotency
//   * UNIQUE(bot_id, update_id)            – Telegram retries of the same update
//   * UNIQUE(chat_id, message_id) original  – the same message delivered to two bots in one group
//   * raw message + event are inserted in ONE atomic batch; if it fails the webhook returns 500 so Telegram retries.
//   * the session recompute that follows is idempotent; if it fails, the cron job heals it (events newer than session).
//
// Trust
//   * Event time = Telegram's message.date. Text such as "IN 08:30" is never parsed as a time (it is UNRECOGNIZED).
//   * Identity = verified (chat_id, message_thread_id) mapping valid at message time. Topic names/usernames are ignored.

import { bi, type Bi, EVENT_LABEL, type EventType, EXCEPTIONS, exceptionSeverity, type ExceptionCode, type KeywordConfig, type Rules } from '../../shared/codes';
import { buildKeywordIndex, parseText } from '../../shared/parser';
import { fmtTime, localDate } from '../../shared/time';
import type { Env } from '../env';
import { log } from './audit';
import { isConstraintError, stmt } from './db';
import { assignmentContext, chooseWorkDate, keyStr, recomputeMany } from './sessions';
import { parseSettings } from './settings';
import { type BotRow } from './telegram';

export interface TgMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: { id: number; type: string; title?: string; is_forum?: boolean };
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: { id: number; is_bot: boolean; first_name?: string; last_name?: string; username?: string };
  sender_chat?: unknown;
  forward_origin?: unknown;
  forward_date?: number;
  via_bot?: unknown;
  text?: string;
  caption?: string;
}
export interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: TgMessage }

export interface IngestResult { http: number; status: string; codes: string[]; event?: EventType; reply?: string | null }

interface MappingRow { employee_id: number; employee_code: string; name: string; currency_code: string | null; employment_status: string; deactivated_at: number | null; emp_bot_id: number | null; emp_bot_status: string | null }

export const IDENTITY_CODES = ['UNTRUSTED_SOURCE', 'NO_TOPIC', 'WRONG_TOPIC_UNMAPPED', 'INACTIVE_EMPLOYEE'] as const;

export function identify(msg: Pick<TgMessage, 'forward_origin' | 'forward_date' | 'sender_chat' | 'via_bot' | 'from'>, threadId: number | null, mapping: MappingRow | null, ts: number):
  { ok: true; employeeId: number } | { ok: false; code: ExceptionCode; employeeId: number | null } {
  if (msg.forward_origin || msg.forward_date || msg.sender_chat || msg.via_bot || msg.from?.is_bot) return { ok: false, code: 'UNTRUSTED_SOURCE', employeeId: mapping?.employee_id ?? null };
  if (threadId == null) return { ok: false, code: 'NO_TOPIC', employeeId: null };
  if (!mapping) return { ok: false, code: 'WRONG_TOPIC_UNMAPPED', employeeId: null };
  if (mapping.employment_status !== 'ACTIVE' && mapping.deactivated_at != null && ts >= mapping.deactivated_at) return { ok: false, code: 'INACTIVE_EMPLOYEE', employeeId: mapping.employee_id };
  return { ok: true, employeeId: mapping.employee_id };
}

export const mappingSql = `SELECT m.employee_id, e.employee_code, e.name, e.currency_code, e.employment_status, e.deactivated_at, b.id AS emp_bot_id, b.status AS emp_bot_status
  FROM telegram_topic_mappings m JOIN employees e ON e.id = m.employee_id LEFT JOIN telegram_bots b ON b.currency_code = e.currency_code
  WHERE m.chat_id = ? AND m.message_thread_id = ? AND m.valid_from <= ? AND (m.valid_until IS NULL OR m.valid_until > ?)
  ORDER BY m.valid_from DESC LIMIT 1`;

const tzLabel = 'Sri Lanka time';

export function replyText(kind: 'ok' | 'sm' | 'unrec' | 'id', data: { type?: EventType; code?: string; ts?: number; tz: string; keywords?: string[] }): string {
  const label = (c?: string) => (c && (EXCEPTIONS as Record<string, { label: Bi }>)[c]?.label.en) || c || '';
  switch (kind) {
    case 'ok': return `✅ ${EVENT_LABEL[data.type!].en} recorded · ${fmtTime(data.ts!, data.tz)} (${tzLabel})`;
    case 'sm': return `⚠️ ${EVENT_LABEL[data.type!].en} not counted: ${label(data.code)}`;
    case 'unrec': return `⚠️ Not recognised. Please send only ${(data.keywords ?? ['IN', 'BREAK', 'RESUME', 'OUT']).join(' / ')}`;
    case 'id': return `⚠️ Not counted: ${label(data.code)}. The admin has been notified.`;
  }
}

const primaryKeywords = (kw: KeywordConfig) => (['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT'] as const).map((k) => kw[k]?.[0]).filter(Boolean) as string[];

export async function ingestUpdate(env: Env, bot: BotRow, upd: TgUpdate, receivedAt: number): Promise<IngestResult> {
  const db = env.DB;
  const tz = env.BIZ_TZ || 'Asia/Colombo';
  const msg = upd.message ?? upd.edited_message;
  const edited = !upd.message && !!upd.edited_message;
  if (!msg) return { http: 200, status: 'IGNORED_UPDATE_TYPE', codes: [] };
  if (!msg.chat || (msg.chat.type !== 'supergroup' && msg.chat.type !== 'group')) return { http: 200, status: 'IGNORED_CHAT_TYPE', codes: [] };
  if (!Number.isInteger(msg.message_id) || !Number.isInteger(msg.date) || !Number.isInteger(msg.chat.id)) return { http: 200, status: 'IGNORED_MALFORMED', codes: [] };

  const chatId = msg.chat.id;
  const threadId = msg.is_topic_message && Number.isInteger(msg.message_thread_id) ? msg.message_thread_id! : null;
  const tgTs = msg.date * 1000;
  const editTs = edited && msg.edit_date ? msg.edit_date * 1000 : null;
  const text = (msg.text ?? msg.caption ?? '').slice(0, 4000);

  // one round trip: duplicates, settings, topic mapping, chat allow-list
  const [dupR, setR, mapR, allowR] = await db.batch([
    edited
      ? stmt(db, 'SELECT id FROM telegram_messages WHERE (bot_id = ? AND update_id = ?) OR (chat_id = ? AND message_id = ? AND is_edit = 1 AND edit_ts IS ?) LIMIT 1', bot.id, upd.update_id, chatId, msg.message_id, editTs)
      : stmt(db, 'SELECT id FROM telegram_messages WHERE (bot_id = ? AND update_id = ?) OR (chat_id = ? AND message_id = ? AND is_edit = 0) LIMIT 1', bot.id, upd.update_id, chatId, msg.message_id),
    stmt(db, "SELECT key, value FROM system_settings WHERE key IN ('keywords','rules')"),
    stmt(db, mappingSql, chatId, threadId ?? -1, tgTs, tgTs),
    stmt(db, 'SELECT 1 AS ok FROM telegram_topic_mappings WHERE chat_id = ? LIMIT 1', chatId),
  ]);
  if (dupR.results.length) return { http: 200, status: 'DUPLICATE', codes: [] };
  const settings = parseSettings(setR.results as { key: string; value: string }[]);
  const rules: Rules = settings.rules;
  const mapping = threadId != null ? ((mapR.results[0] as unknown as MappingRow) ?? null) : null;
  const allowed = rules.allowedChats.includes(chatId) || allowR.results.length > 0;
  if (!allowed) return { http: 200, status: 'IGNORED_CHAT', codes: [] };

  // Several currency bots may sit in one group: the bot of the employee's currency handles that employee's topic.
  if (mapping && mapping.emp_bot_id != null && mapping.emp_bot_id !== bot.id && mapping.emp_bot_status === 'ACTIVE') {
    return { http: 200, status: 'IGNORED_OTHER_BOT', codes: [] };
  }

  const idx = buildKeywordIndex(settings.keywords);
  const parsed = parseText(text, idx);
  const fromName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').slice(0, 200) || null;
  const forwarded = msg.forward_origin || msg.forward_date ? 1 : 0;

  const rawInsert = (status: string, errorCode: string | null, employeeId: number | null, parsedType: string | null) => stmt(db,
    `INSERT INTO telegram_messages (bot_id, update_id, chat_id, message_id, message_thread_id, from_user_id, from_name, from_username, raw_text, is_edit,
       is_forwarded, telegram_message_ts, edit_ts, received_at, processed_at, parsed_event_type, processing_status, error_code, employee_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    bot.id, upd.update_id, chatId, msg.message_id, threadId, msg.from?.id ?? null, fromName, msg.from?.username ?? null, text, edited ? 1 : 0,
    forwarded, tgTs, editTs, receivedAt, Date.now(), parsedType, status, errorCode, employeeId, receivedAt);
  const rawRef = `(SELECT id FROM telegram_messages WHERE bot_id = ${Number(bot.id)} AND update_id = ${Number(upd.update_id)})`;
  const exInsert = (code: ExceptionCode, employeeId: number | null, detail: Bi | null) => stmt(db,
    `INSERT INTO attendance_exceptions (dedupe_key, source, code, severity, employee_id, work_date, occurred_at, message_id, detail, status, created_at, updated_at)
     VALUES (?, 'INGEST', ?, ?, ?, ?, ?, ${rawRef}, ?, 'OPEN', ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
    `I|${code}|${chatId}|${msg.message_id}|${editTs ?? ''}`, code, exceptionSeverity(code), employeeId, localDate(tgTs, tz), tgTs, detail ? JSON.stringify(detail) : null, receivedAt, receivedAt);

  const write = async (statements: D1PreparedStatement[]): Promise<'ok' | 'dup'> => {
    try {
      await db.batch([...statements, stmt(db, "UPDATE system_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ? WHERE key = 'data_version'", receivedAt)]);
      return 'ok';
    } catch (e) {
      if (isConstraintError(e)) return 'dup';
      throw e;
    }
  };

  // ---------------------------------------------------------------- edited messages: never change the original event
  if (edited) {
    const orig = await db.prepare(`SELECT m.id, m.raw_text, (SELECT id FROM attendance_events WHERE message_id = m.id) AS event_id
                                   FROM telegram_messages m WHERE m.chat_id = ? AND m.message_id = ? AND m.is_edit = 0`).bind(chatId, msg.message_id).first<{ id: number; raw_text: string; event_id: number | null }>();
    if (!orig?.event_id && parsed.kind === 'NONE') return { http: 200, status: 'IGNORED', codes: [] };
    const empId = mapping?.employee_id ?? null;
    const r = await write([
      rawInsert('EDITED_REVIEW', 'EDITED_MESSAGE', empId, parsed.kind === 'PUNCH' ? parsed.type : null),
      exInsert('EDITED_MESSAGE', empId, bi(`原文「${orig?.raw_text ?? '?'}」→ 新文「${text}」；原事件不变`, `Original "${orig?.raw_text ?? '?'}" → edited "${text}"; original event kept`)),
    ]);
    return { http: 200, status: r === 'dup' ? 'DUPLICATE' : 'EDITED_REVIEW', codes: ['EDITED_MESSAGE'] };
  }

  // ---------------------------------------------------------------- ordinary chat
  if (parsed.kind === 'NONE') {
    if (!mapping) return { http: 200, status: 'IGNORED', codes: [] }; // general chatter is not stored
    const r = await write([rawInsert('IGNORED', null, mapping.employee_id, null)]);
    return { http: 200, status: r === 'dup' ? 'DUPLICATE' : 'IGNORED', codes: [] };
  }

  // ---------------------------------------------------------------- near-miss: pending review, no event
  if (parsed.kind === 'UNRECOGNIZED') {
    const empId = mapping?.employee_id ?? null;
    const r = await write([
      rawInsert('PENDING_REVIEW', 'UNRECOGNIZED', empId, null),
      exInsert('UNRECOGNIZED', empId, bi(`「${text}」接近打卡关键词但不完全匹配`, `"${text}" looks like a punch but does not match a keyword exactly`)),
    ]);
    if (r === 'dup') return { http: 200, status: 'DUPLICATE', codes: [] };
    return { http: 200, status: 'PENDING_REVIEW', codes: ['UNRECOGNIZED'], reply: rules.botReply ? replyText('unrec', { tz, keywords: primaryKeywords(settings.keywords) }) : null };
  }

  // ---------------------------------------------------------------- punch: identity
  const id = identify(msg, threadId, mapping, tgTs);
  if (!id.ok) {
    const detail = threadId != null ? bi(`Topic #${threadId}`, `Topic #${threadId}`) : bi('General（无 Topic）', 'General (no topic)');
    const r = await write([rawInsert('REJECTED_IDENTITY', id.code, id.employeeId, parsed.type), exInsert(id.code, id.employeeId, detail)]);
    if (r === 'dup') return { http: 200, status: 'DUPLICATE', codes: [] };
    return { http: 200, status: 'REJECTED_IDENTITY', codes: [id.code], reply: rules.botReply ? replyText('id', { code: id.code, tz }) : null };
  }

  // ---------------------------------------------------------------- punch: event
  const empId = id.employeeId;
  const { ctx, instances } = await assignmentContext(db, empId, tgTs);
  const workDate = chooseWorkDate({ type: parsed.type, ts: tgTs }, ctx, instances, rules.windowHours, tz);
  const r = await write([
    rawInsert('PROCESSED', null, empId, parsed.type),
    stmt(db, `INSERT INTO attendance_events (message_id, employee_id, work_date, event_type, event_ts, tg_message_id, received_at, source, created_at)
              VALUES (${rawRef}, ?, ?, ?, ?, ?, ?, 'TELEGRAM', ?)`, empId, workDate, parsed.type, tgTs, msg.message_id, receivedAt, receivedAt),
  ]);
  if (r === 'dup') return { http: 200, status: 'DUPLICATE', codes: [] };

  let code: string | null = null;
  try {
    const rec = await recomputeMany(db, [[empId, workDate]], { now: Date.now(), tz, rules });
    const ev = await db.prepare(`SELECT id FROM attendance_events WHERE message_id = ${rawRef}`).first<{ id: number }>();
    code = (ev && rec.get(keyStr([empId, workDate]))?.summary?.eventResults.get(ev.id)) ?? null;
  } catch (e) {
    // the event is safely stored; the cron job recomputes sessions with events newer than their computation
    log('error', 'recompute_failed', { employeeId: empId, workDate, error: String((e as Error).message) });
  }
  const accepted = code === null || code === 'CLOCK_OUT_DURING_BREAK';
  return {
    http: 200, status: 'PROCESSED', codes: code ? [code] : [], event: parsed.type,
    reply: rules.botReply ? (accepted ? replyText('ok', { type: parsed.type, ts: tgTs, tz }) : replyText('sm', { type: parsed.type, code: code!, tz })) : null,
  };
}

/** Re-parses messages that were pending review after the keyword list changed. */
export async function reparsePending(env: Env, actor: string, now: number): Promise<number> {
  const db = env.DB;
  const tz = env.BIZ_TZ || 'Asia/Colombo';
  const [setR, pendR] = await db.batch([
    stmt(db, "SELECT key, value FROM system_settings WHERE key IN ('keywords','rules')"),
    stmt(db, `SELECT id, chat_id, message_id, message_thread_id, raw_text, is_forwarded, telegram_message_ts, received_at
              FROM telegram_messages WHERE processing_status = 'PENDING_REVIEW' ORDER BY id LIMIT 200`),
  ]);
  const settings = parseSettings(setR.results as { key: string; value: string }[]);
  const idx = buildKeywordIndex(settings.keywords);
  let n = 0;
  const keys: [number, string][] = [];
  for (const m of pendR.results as { id: number; chat_id: number; message_id: number; message_thread_id: number | null; raw_text: string; is_forwarded: number; telegram_message_ts: number; received_at: number }[]) {
    const p = parseText(m.raw_text, idx);
    if (p.kind !== 'PUNCH') continue;
    const mapping = m.message_thread_id != null
      ? await db.prepare(mappingSql).bind(m.chat_id, m.message_thread_id, m.telegram_message_ts, m.telegram_message_ts).first<MappingRow>()
      : null;
    const id = identify({ forward_origin: m.is_forwarded ? {} : undefined }, m.message_thread_id, mapping, m.telegram_message_ts);
    const note = 'Re-parsed after keyword update';
    const resolve = stmt(db, `UPDATE attendance_exceptions SET status = 'RESOLVED', note = ?, handled_by = ?, handled_at = ?, updated_at = ?
                              WHERE message_id = ? AND code = 'UNRECOGNIZED' AND status = 'OPEN'`, note, actor, now, now, m.id);
    if (!id.ok) {
      await db.batch([
        stmt(db, "UPDATE telegram_messages SET processing_status = 'REJECTED_IDENTITY', error_code = ?, parsed_event_type = ?, processed_at = ? WHERE id = ?", id.code, p.type, now, m.id),
        stmt(db, `INSERT INTO attendance_exceptions (dedupe_key, source, code, severity, employee_id, work_date, occurred_at, message_id, status, created_at, updated_at)
                  VALUES (?, 'INGEST', ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
          `I|${id.code}|${m.chat_id}|${m.message_id}|`, id.code, exceptionSeverity(id.code), id.employeeId, localDate(m.telegram_message_ts, tz), m.telegram_message_ts, m.id, now, now),
        resolve,
      ]);
      n++;
      continue;
    }
    const { ctx, instances } = await assignmentContext(db, id.employeeId, m.telegram_message_ts);
    const workDate = chooseWorkDate({ type: p.type, ts: m.telegram_message_ts }, ctx, instances, settings.rules.windowHours, tz);
    await db.batch([
      stmt(db, "UPDATE telegram_messages SET processing_status = 'REPARSED', error_code = NULL, parsed_event_type = ?, employee_id = ?, processed_at = ? WHERE id = ?", p.type, id.employeeId, now, m.id),
      stmt(db, `INSERT INTO attendance_events (message_id, employee_id, work_date, event_type, event_ts, tg_message_id, received_at, source, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'TELEGRAM', ?)`, m.id, id.employeeId, workDate, p.type, m.telegram_message_ts, m.message_id, m.received_at, now),
      resolve,
    ]);
    keys.push([id.employeeId, workDate]);
    n++;
  }
  if (keys.length) await recomputeMany(db, keys, { now, tz, rules: settings.rules });
  return n;
}
