// Plain-text punch parser. Deterministic: only an exact keyword match (after normalisation) produces a punch.
// Near misses ("in 9am", "IN 08:30") become UNRECOGNIZED (pending review) and never create a clock event.
// Employee-typed times are never trusted — the event time is always Telegram's message.date.

import type { EventType, KeywordConfig } from './codes';

export type ParseResult =
  | { kind: 'PUNCH'; type: EventType; norm: string }
  | { kind: 'UNRECOGNIZED'; norm: string }
  | { kind: 'NONE'; norm: string };

export function normText(t: string | null | undefined): string {
  return (t || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, ' ')
    .replace(/^\/(\S+?)(@\w+)?(?=\s|$)/, '$1') // "/in@MyBot" → "in"
    .replace(/[_\-]/g, ' ')
    .replace(/[.!?,;:。！？，；：~…'"`()[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface KeywordIndex { map: Map<string, EventType>; tokens: Set<string> }

export function buildKeywordIndex(kw: KeywordConfig): KeywordIndex {
  const map = new Map<string, EventType>();
  for (const [type, list] of Object.entries(kw) as [EventType, string[]][]) {
    for (const k of list) {
      const n = normText(k);
      if (n) map.set(n, type);
    }
  }
  const tokens = new Set<string>();
  for (const k of map.keys()) for (const w of k.split(' ')) tokens.add(w);
  return { map, tokens };
}

export function parseText(text: string | null | undefined, idx: KeywordIndex): ParseResult {
  const n = normText(text);
  if (!n) return { kind: 'NONE', norm: n };
  const hit = idx.map.get(n);
  if (hit) return { kind: 'PUNCH', type: hit, norm: n };
  const words = n.split(' ');
  if (words.length <= 3 && words.some((w) => idx.tokens.has(w))) return { kind: 'UNRECOGNIZED', norm: n };
  for (const k of idx.map.keys()) {
    // non-Latin keywords (e.g. 上班) embedded in a very short message
    if (/[^\x00-\x7f]/.test(k) && n.includes(k) && n.length <= k.length + 4) return { kind: 'UNRECOGNIZED', norm: n };
  }
  return { kind: 'NONE', norm: n };
}

/** Validates an admin-submitted keyword configuration. Returns an error message or null. */
export function validateKeywords(kw: KeywordConfig): { zh: string; en: string } | null {
  const seen = new Map<string, string>();
  for (const [type, list] of Object.entries(kw)) {
    if (!Array.isArray(list) || list.length === 0) return { zh: `${type} 至少需要一个关键词`, en: `${type} needs at least one keyword` };
    for (const w of list) {
      const n = normText(w);
      if (!n) return { zh: `「${w}」去掉符号后为空`, en: `"${w}" is empty after removing symbols` };
      if (n.split(' ').length > 3) return { zh: `「${w}」太长（最多 3 个词）`, en: `"${w}" is too long (max 3 words)` };
      const prev = seen.get(n);
      if (prev && prev !== type) return { zh: `「${w}」同时出现在 ${prev} 和 ${type}`, en: `"${w}" appears in both ${prev} and ${type}` };
      seen.set(n, type);
    }
  }
  return null;
}
