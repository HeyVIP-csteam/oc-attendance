// Minimal Telegram Bot API client. Tokens are only ever placed in the request URL to api.telegram.org and are
// redacted from every error message before it is logged or stored.

import type { Env } from '../env';
import { decryptString, redact } from './crypto';
import { first } from './db';

export const TELEGRAM_API = 'https://api.telegram.org';
export const ALLOWED_UPDATES = ['message', 'edited_message'] as const;

export class TelegramError extends Error {
  constructor(message: string, public errorCode?: number) { super(redact(message)); }
}

export async function tgCall<T>(token: string, method: string, payload: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new TelegramError(`Network error calling Telegram ${method}: ${(e as Error).message}`);
  }
  let data: { ok: boolean; result?: T; description?: string; error_code?: number };
  try { data = await res.json(); } catch { throw new TelegramError(`Telegram ${method}: invalid response (HTTP ${res.status})`, res.status); }
  if (!data.ok) throw new TelegramError(`Telegram ${method}: ${data.description ?? 'error'}`, data.error_code ?? res.status);
  return data.result as T;
}

export interface TgUser { id: number; is_bot: boolean; first_name: string; username?: string; can_read_all_group_messages?: boolean; can_join_groups?: boolean }
export interface TgWebhookInfo { url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string; allowed_updates?: string[] }

export const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;

export interface BotRow {
  id: number; currency_code: string; bot_user_id: number | null; username: string | null; token_ciphertext: string | null; token_last4: string | null;
  secret_salt: string; webhook_url: string | null; status: 'NOT_SET' | 'ACTIVE' | 'DISABLED' | 'ERROR';
  can_read_all_group_messages: number | null; pending_update_count: number | null; last_error: string | null; last_checked_at: number | null;
  updated_at: number; shared_from?: string | null; tg_bot_id: number | null; secret_ref: number | null; tg_url: string | null;
}

/** Bot token: a Cloudflare secret TELEGRAM_BOT_TOKEN_<CODE> takes precedence over the encrypted copy in D1. */
export async function botToken(env: Env, bot: Pick<BotRow, 'currency_code' | 'token_ciphertext'>): Promise<string | null> {
  const fromSecret = env[`TELEGRAM_BOT_TOKEN_${bot.currency_code}`];
  if (fromSecret) return fromSecret.trim();
  if (!bot.token_ciphertext) return null;
  return decryptString(env.ENCRYPTION_KEY, bot.token_ciphertext);
}

export const hasSecretToken = (env: Env, code: string): boolean => !!env[`TELEGRAM_BOT_TOKEN_${code}`];

export async function loadBot(db: D1Database, code: string): Promise<BotRow | null> {
  return first<BotRow>(db, 'SELECT * FROM telegram_bots WHERE currency_code = ?', code.toUpperCase());
}

/** Sends a message (not a reply) into a forum topic. */
export async function sendTopicMessage(token: string, chatId: number, threadId: number | null, text: string): Promise<void> {
  await tgCall(token, 'sendMessage', { chat_id: chatId, ...(threadId != null ? { message_thread_id: threadId } : {}), text }, 5000);
}

/** Sends a reply into the same forum topic. Failures are logged by the caller and never affect attendance data. */
export async function sendReply(token: string, chatId: number, threadId: number | null, replyTo: number, text: string): Promise<void> {
  await tgCall(token, 'sendMessage', {
    chat_id: chatId,
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    text,
    reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
    disable_notification: true,
  }, 5000);
}
