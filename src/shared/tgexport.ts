// Reads a Telegram Desktop chat export (result.json, "Machine-readable JSON") into the compact list the import API takes.

export interface ExportMsg { id: number; ts: number; reply: number | null; text: string; fwd: boolean; from: string; fromId: number | null }
/** topicsSince: when the first topic was created in this export (service message), null if the export shows none. */
export interface ExportInfo { name: string; chatId: number | null; messages: ExportMsg[]; topicsSince: number | null }

type Part = string | { type?: string; text?: string };
const flat = (t: unknown): string => (typeof t === 'string' ? t : Array.isArray(t) ? (t as Part[]).map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('') : '');

export function readTelegramExport(json: unknown): ExportInfo {
  const d = json as { name?: string; type?: string; id?: number; messages?: Record<string, unknown>[]; chats?: unknown };
  if (!d || !Array.isArray(d.messages)) throw new Error('This is not a single-chat Telegram export (result.json with "messages")');
  // supergroups are exported without the -100 prefix every supergroup id has in the Bot API
  const chatId = typeof d.id === 'number' ? Number(`-100${d.id}`) : null;
  const messages: ExportMsg[] = [];
  let topicsSince: number | null = null;
  for (const m of d.messages) {
    if (m.type === 'service' && m.action === 'topic_created') { const t = Number(m.date_unixtime) * 1000; if (t > 0 && (topicsSince == null || t < topicsSince)) topicsSince = t; }
    if (m.type !== 'message') continue;
    const text = flat(m.text).trim();
    const ts = Number(m.date_unixtime) * 1000;
    if (!text || !Number.isFinite(ts) || ts <= 0) continue;
    // the sender's Telegram account ("user123456789"); channels / anonymous admins have no user id
    const fid = typeof m.from_id === 'string' ? /^user(\d{1,15})$/.exec(m.from_id) : null;
    messages.push({ id: Number(m.id), ts, reply: typeof m.reply_to_message_id === 'number' ? m.reply_to_message_id : null, text: text.slice(0, 4000), fwd: !!(m.forwarded_from || m.via_bot || m.saved_from),
      from: typeof m.from === 'string' ? m.from.slice(0, 120) : '', fromId: fid ? Number(fid[1]) : null });
  }
  return { name: d.name ?? '', chatId, messages, topicsSince };
}

/** The name after "Agent :" in a punch message ("Start of Shift Agent :Ali Khan date: 17/10/2026" → "Ali Khan"), or null. */
export function agentName(text: string): string | null {
  const m = /\bagent(?:\s*name)?\s*[:：\-]\s*([^\n:：|,;/]+?)(?=\s+(?:date|time|shift|id|psd|day)\b|\s*[\n:：|,;/]|\s*$)/i.exec(text);
  if (!m) return null;
  const n = m[1].replace(/[^\p{L}\p{N} .'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return n && n.length <= 40 && /\p{L}/u.test(n) ? n : null;
}

const tokens = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

/** Employees an agent name points to: an exact name or PSD ID first, else every employee whose name contains all its words. */
export function agentCandidates<E extends { employee_code: string; name: string }>(agent: string, emps: E[]): E[] {
  const a = tokens(agent);
  if (!a.length) return [];
  const exact = emps.filter((e) => tokens(e.name).join(' ') === a.join(' ') || e.employee_code.toLowerCase() === agent.trim().toLowerCase());
  if (exact.length) return exact;
  return emps.filter((e) => { const t = tokens(e.name); return a.every((w) => t.includes(w)); });
}
