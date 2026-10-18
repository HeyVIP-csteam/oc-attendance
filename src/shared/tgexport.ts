// Reads a Telegram Desktop chat export (result.json, "Machine-readable JSON") into the compact list the import API takes.

export interface ExportMsg { id: number; ts: number; reply: number | null; text: string; fwd: boolean }
export interface ExportInfo { name: string; chatId: number | null; messages: ExportMsg[] }

type Part = string | { type?: string; text?: string };
const flat = (t: unknown): string => (typeof t === 'string' ? t : Array.isArray(t) ? (t as Part[]).map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('') : '');

export function readTelegramExport(json: unknown): ExportInfo {
  const d = json as { name?: string; type?: string; id?: number; messages?: Record<string, unknown>[]; chats?: unknown };
  if (!d || !Array.isArray(d.messages)) throw new Error('This is not a single-chat Telegram export (result.json with "messages")');
  // supergroups are exported without the -100 prefix every supergroup id has in the Bot API
  const chatId = typeof d.id === 'number' ? Number(`-100${d.id}`) : null;
  const messages: ExportMsg[] = [];
  for (const m of d.messages) {
    if (m.type !== 'message') continue;
    const text = flat(m.text).trim();
    const ts = Number(m.date_unixtime) * 1000;
    if (!text || !Number.isFinite(ts) || ts <= 0) continue;
    messages.push({ id: Number(m.id), ts, reply: typeof m.reply_to_message_id === 'number' ? m.reply_to_message_id : null, text: text.slice(0, 4000), fwd: !!(m.forwarded_from || m.via_bot || m.saved_from) });
  }
  return { name: d.name ?? '', chatId, messages };
}
