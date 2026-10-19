// Forgot clock-out reminder (Settings → Attendance rules): when an employee has clocked in but not out for the set
// number of hours, the bot posts one reminder in the employee's topic. It is sent only when bot replies are on for the
// employee's currency, once per session, and only close to the due time (older open sessions are never reminded, so a
// deploy or a pause of the cron does not flood the groups).

import { HOUR, MIN, fmtHm, fmtTime } from '../../shared/time';
import type { Env } from '../env';
import { log } from './audit';
import { all, first } from './db';
import { redact } from './crypto';
import type { Settings } from './settings';
import { rulesFor } from './settings';
import { type BotRow, botToken, loadBot, sendTopicMessage } from './telegram';

const LATE_LIMIT = 2 * HOUR; // a reminder that is this late is skipped
const MAX_PER_RUN = 50;

export const reminderText = (inAt: number, tz: string, forgotMs: number) =>
  `⏰ Reminder: you clocked in at ${fmtTime(inAt, tz)} and have not clocked out for over ${fmtHm(forgotMs).replace(/^(\d+)h$/, (_, h) => `${h} hours`)}. Did you forget to clock out? Please tell your team leader your actual clock-out time.`;

interface Due { session_id: number; employee_id: number; actual_in_at: number; currency_code: string | null; timezone: string; chat_id: number | null; thread: number | null }

export async function sendOutReminders(env: Env, settings: Settings, now: number): Promise<number> {
  const db = env.DB;
  const rows = await all<Due>(db, `SELECT s.id AS session_id, s.employee_id, s.actual_in_at, e.currency_code, e.timezone, m.chat_id, m.message_thread_id AS thread
      FROM attendance_sessions s JOIN employees e ON e.id = s.employee_id
      LEFT JOIN telegram_topic_mappings m ON m.employee_id = e.id AND m.is_active = 1
      WHERE s.actual_in_at IS NOT NULL AND s.actual_out_at IS NULL AND s.out_reminder_at IS NULL
        AND s.actual_in_at BETWEEN ? AND ? AND e.employment_status = 'ACTIVE'
      ORDER BY s.actual_in_at LIMIT 500`, now - 22 * HOUR, now - 59 * MIN);
  let sent = 0;
  const bots = new Map<number, { row: BotRow | null; token: string | null }>();
  for (const r of rows) {
    if (sent >= MAX_PER_RUN) break;
    const rules = rulesFor(settings, r.currency_code);
    if (!rules.botReply || r.chat_id == null) continue;
    const forgotMs = Math.round((rules.forgotOutHours ?? 14) * 60) * MIN;
    const due = r.actual_in_at + forgotMs;
    if (now < due || now - due > LATE_LIMIT) continue;
    // claim first (one reminder per session even if two cron runs overlap)
    const claim = await db.prepare('UPDATE attendance_sessions SET out_reminder_at = ? WHERE id = ? AND out_reminder_at IS NULL AND actual_out_at IS NULL').bind(now, r.session_id).run();
    if (!claim.meta.changes) continue;
    try {
      // the bot that is in this group: the one that received its latest message, else the currency's own bot
      const last = await first<{ bot_id: number | null }>(db, 'SELECT bot_id FROM telegram_messages WHERE chat_id = ? AND bot_id IS NOT NULL ORDER BY id DESC LIMIT 1', r.chat_id);
      const key = last?.bot_id ?? -1;
      if (!bots.has(key)) {
        const row = last?.bot_id != null ? await first<BotRow>(db, 'SELECT * FROM telegram_bots WHERE id = ?', last.bot_id) : r.currency_code ? await loadBot(db, r.currency_code) : null;
        bots.set(key, { row, token: row && row.status !== 'DISABLED' ? await botToken(env, row) : null });
      }
      const b = bots.get(key)!;
      if (!b.token) { log('warn', 'out_reminder_no_bot', { employee: r.employee_id }); continue; }
      await sendTopicMessage(b.token, r.chat_id, r.thread, reminderText(r.actual_in_at, r.timezone || 'Asia/Colombo', forgotMs));
      sent++;
    } catch (e) {
      log('warn', 'out_reminder_failed', { employee: r.employee_id, error: redact(String((e as Error).message)) });
    }
  }
  return sent;
}
