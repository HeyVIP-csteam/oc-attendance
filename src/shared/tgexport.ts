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

// words that are never a person's name in a punch message (the punch keywords are added by the caller)
const STOP = new Set(('in out back break breaks short long dinner lunch toilet wc taking take took log login logout logged done for the day eod end start of shift online offline ' +
  'to work team already clocked clock hour hours hr hrs min mins minute minutes sec eat meal prayer pray tea coffee washroom restroom am pm today now and a an my is i im ' +
  'agent name date time assigned again resume resuming started starting finish finished over off on with be will').split(' '));

/** A person's name in a free-text word list, or null ("Joan", "Michael Den" — letters only, at most 3 words, no punch words). */
function cleanName(raw: string, stop: Set<string>): string | null {
  const n = raw.replace(/[[\](){}【】「」"'*~]/g, ' ').replace(/[.,!?:;]+/g, ' ').replace(/\s+/g, ' ').trim();
  const w = n.split(' ').filter(Boolean);
  if (!w.length || w.length > 3 || n.length < 2 || n.length > 40) return null;
  if (w.some((x) => !/^\p{L}+$/u.test(x) || STOP.has(x.toLowerCase()) || stop.has(x.toLowerCase()))) return null;
  return w.map((x) => x[0].toUpperCase() + x.slice(1).toLowerCase()).join(' ');
}

/**
 * The name of the person a punch message is about, written in the message itself:
 * "Agent: Joan" · "Break — Darsh" · "Log in for the day _ Michael den." · "Taking Break ( David )" · a last line with only a name.
 * `stop` = words that are punch keywords (never a name).
 */
export function personName(text: string, stop: Set<string> = new Set()): string | null {
  const t = text.trim();
  const ag = /\bagent(?:\s*name)?\s*[:：\-]\s*([^\n]+)/i.exec(t);
  if (ag) return cleanName(ag[1].split(/\s+(?:date|time|shift|id|psd|day|assigned)\b|[:：|,;/]/i)[0], stop);
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  const br = /[(（]\s*([^()（）]*?)\s*[)）]\s*[.!]*$/.exec(last);
  if (br && cleanName(br[1], stop)) return cleanName(br[1], stop);
  const parts = last.split(/\s*[—–_]+\s*|\s+-+\s*|\s*-+\s+/);
  if (parts.length > 1) { const n = cleanName(parts[parts.length - 1].replace(/\s*[(（][^)）]*[)）]\s*$/, ''), stop); if (n) return n; }
  if (lines.length > 1) return cleanName(last, stop);
  return null;
}
/** @deprecated name kept for older callers */
export const agentName = (text: string): string | null => personName(text);

/** A name as a key for remembering it ("Michael  den." → "michael den"). */
export const nameKey = (n: string) => n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const tokens = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

/** Employees an agent name points to: an exact name or PSD ID first, else every employee whose name contains all its words. */
export function agentCandidates<E extends { employee_code: string; name: string }>(agent: string, emps: E[]): E[] {
  const a = tokens(agent);
  if (!a.length) return [];
  const exact = emps.filter((e) => tokens(e.name).join(' ') === a.join(' ') || e.employee_code.toLowerCase() === agent.trim().toLowerCase());
  if (exact.length) return exact;
  return emps.filter((e) => { const t = tokens(e.name); return a.every((w) => t.includes(w)); });
}
