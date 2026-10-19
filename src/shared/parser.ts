// Plain-text punch parser. Deterministic: the same text and keyword list always give the same result.
//
// Nothing about wording is hard-coded: the keywords AND the reading rules (labels to skip, typo tolerance, brackets,
// typed times) come from the database — Settings → Punch keywords. The examples below use the seeded defaults.
// Each employee's topic is used only for punching, so the parser reads the way people actually write:
//   "Clocked in\nAgent: Nisha\nDate: 16/10/2026"   → CLOCK_IN   (label lines such as Agent:/Name:/Date: are skipped)
//   "Taking Break ( David)", "Lunch Break - 60 mins" → BREAK_START (text in brackets and durations are ignored)
//   "Done For the day ( David )"                    → CLOCK_OUT
//   "clok in", "brek", "innnn"                      → typo-tolerant (one letter off, repeated letters)
// Messages are UNRECOGNIZED (pending review, never a punch) when they mention two different actions, or contain a
// clock time ("IN 08:30") — an employee-typed time is never trusted; the event time is always Telegram's message.date.

import { DEFAULT_PARSER, type EventType, type KeywordConfig, type ParserRules } from './codes';

export type ParseResult =
  | { kind: 'PUNCH'; type: EventType; norm: string; keyword: string; fuzzy: boolean; remark: string; typedTime?: string }
  | { kind: 'UNRECOGNIZED'; norm: string; reason: 'CONFLICT' | 'TIME' | 'NEAR'; types: EventType[] }
  | { kind: 'NONE'; norm: string };

export function normText(t: string | null | undefined): string {
  return (t || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, ' ')
    .replace(/^\/(\S+?)(@\w+)?(?=\s|$)/, '$1') // "/in@MyBot" → "in"
    .replace(/[_\-–—]/g, ' ')
    .replace(/[.!?,;:。！？，；：~…'"`()[\]（）|/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Little words people add or leave out ("end of shift" = "end shift", "done for the day" = "done for day"). */
const FILLER = new Set(['of', 'the', 'for', 'a', 'an', 'to']);
/** Compares keywords and messages without filler words (a text made only of filler words is kept as is). */
export function canon(n: string): string {
  const w = n.split(' ').filter((x) => !FILLER.has(x));
  return w.length ? w.join(' ') : n;
}

const isLatin = (s: string) => !/[^\x00-\x7f]/.test(s);

function permutations(w: string[]): string[][] {
  if (w.length <= 1) return [w];
  return w.flatMap((x, i) => permutations([...w.slice(0, i), ...w.slice(i + 1)]).map((p) => [x, ...p]));
}

export interface KeywordIndex { map: Map<string, EventType>; sorted: string[]; tokens: Set<string>; rules: ParserRules; label: RegExp | null }

export function buildKeywordIndex(kw: KeywordConfig, parser: Partial<ParserRules> = {}): KeywordIndex {
  const rules: ParserRules = { ...DEFAULT_PARSER, ...parser };
  const map = new Map<string, EventType>();
  for (const [type, list] of Object.entries(kw) as [EventType, string[]][]) {
    for (const k of list) {
      const n = canon(normText(k));
      if (n && !map.has(n)) map.set(n, type);
    }
  }
  // word order does not matter for short phrases: "end break" = "BREAK END", "in clock" = "CLOCK IN".
  // Added after the real keywords, so a keyword the admin typed always wins over a reordered one.
  for (const [k, type] of [...map]) {
    const w = k.split(' ');
    if (w.length < 2 || w.length > 3 || !w.every(isLatin)) continue;
    for (const p of permutations(w)) { const alias = p.join(' '); if (!map.has(alias)) map.set(alias, type); }
  }
  const sorted = [...map.keys()].sort((a, b) => b.length - a.length); // longest phrase first
  const tokens = new Set<string>();
  for (const k of map.keys()) for (const w of k.split(' ')) tokens.add(w);
  const labels = (rules.skipLabels ?? []).map((l) => l.trim()).filter(Boolean).sort((a, b) => b.length - a.length)
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
  const label = labels.length ? new RegExp(`^\\s*(${labels.join('|')})\\s*[:：]`, 'i') : null;
  return { map, sorted, tokens, rules, label };
}

/** A clock time typed by the employee: 08:30, 8.30, 9am, 9 pm. Durations ("60 mins", "30minute") are fine. */
// A date written with the same separators ("09:10:2026", "05.10.2026") is not a time: no digit group may follow or precede.
const TIME_RE = /(?<!\d\s*[:：./]\s*)(?<!\d)\d{1,2}\s*[:：.]\s*\d{2}(?!\d|\s*[:：./]\s*\d)|(^|[^\d])\d{1,2}\s*(am|pm|a\.m|p\.m)\b/i;
const MAX_LINE_WORDS = 12;   // longer lines are prose, not a punch
const SHORT_LINE_WORDS = 4;  // a single-word keyword ("in", "back") only counts on a short line

/** Splits the message into the lines that may carry the action (label lines and bracketed asides removed). */
function actionLines(text: string, idx: KeywordIndex): { raw: string; norm: string }[] {
  return text.split(/\r?\n/)
    .filter((l) => !idx.label?.test(l))
    .map((l) => ({ raw: l.trim(), norm: canon(normText(idx.rules.ignoreBrackets ? l.replace(/[(（][^)）]*[)）]?/g, ' ') : l)) }))
    .filter((l) => l.norm);
}

/** Optimal-string-alignment distance (insert / delete / substitute / swap two neighbours), capped early. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
const squeeze = (s: string) => s.replace(/(.)\1+/g, '$1'); // "innnn" → "in", "outtt" → "out"

interface Hit { type: EventType; keyword: string; raw: string; fuzzy: boolean }

/** Exact phrase matches inside one line, longest keyword first; a matched span is consumed. */
function exactHits(line: { raw: string; norm: string }, idx: KeywordIndex): Hit[] {
  const words = line.norm.split(' ').length;
  if (words > MAX_LINE_WORDS) return [];
  let rest = ` ${line.norm} `;
  const hits: Hit[] = [];
  for (const k of idx.sorted) {
    const single = !k.includes(' ');
    if (isLatin(k)) {
      if (single && words > SHORT_LINE_WORDS) continue;
      const needle = ` ${k} `;
      if (!rest.includes(needle)) continue;
      rest = rest.split(needle).join(' \u0000 ');
    } else {
      // non-Latin keywords (上班, 下班 …) are matched inside the text, on a short line only
      if (!rest.includes(k) || line.norm.replace(/\s/g, '').length > k.length + 4) continue;
      rest = rest.split(k).join(' \u0000 ');
    }
    hits.push({ type: idx.map.get(k)!, keyword: k, raw: line.raw, fuzzy: false });
  }
  return hits;
}

/** One-letter typos and repeated letters, on short lines only ("clok in", "brek", "innnn"). */
function fuzzyHits(line: { raw: string; norm: string }, idx: KeywordIndex): Hit[] {
  const words = line.norm.split(' ');
  if (words.length > SHORT_LINE_WORDS) return [];
  const hits: Hit[] = [];
  for (const k of idx.sorted) {
    if (!isLatin(k)) continue;
    const n = k.split(' ').length;
    for (let i = 0; i + n <= words.length; i++) {
      const cand = words.slice(i, i + n).join(' ');
      const typo = k.length >= 4 && editDistance(cand, k) <= 1;
      const repeated = squeeze(cand) === squeeze(k) && cand !== k && (n > 1 || words.length <= 2);
      if (typo || repeated) { hits.push({ type: idx.map.get(k)!, keyword: k, raw: line.raw, fuzzy: true }); break; }
    }
  }
  return hits;
}

export function parseText(text: string | null | undefined, idx: KeywordIndex): ParseResult {
  const n = normText(text);
  if (!n) return { kind: 'NONE', norm: n };
  const lines = actionLines(text || '', idx);
  let hits = lines.flatMap((l) => exactHits(l, idx));
  if (!hits.length && idx.rules.typoTolerance) hits = lines.flatMap((l) => fuzzyHits(l, idx));
  if (!hits.length) {
    // short message that shares a word with a keyword but is not one ("clock", "shift") → let an admin look at it
    const w = n.split(' ');
    if (w.length <= 2 && w.some((x) => x.length >= 4 && idx.tokens.has(x))) return { kind: 'UNRECOGNIZED', norm: n, reason: 'NEAR', types: [] };
    return { kind: 'NONE', norm: n };
  }
  const types = [...new Set(hits.map((h) => h.type))];
  // three or more different actions in one message is not a punch but an announcement / instruction listing the keywords
  // ("Check-In: CLOCK IN / … Break Start: BREAK / … Check-Out: …"): ordinary chat — no reply, no exception
  if (types.length >= 3) return { kind: 'NONE', norm: n };
  if (types.length > 1) return { kind: 'UNRECOGNIZED', norm: n, reason: 'CONFLICT', types };
  const actionText = lines.map((l) => l.raw).join(' ');
  const tm = actionText.match(TIME_RE);
  if (idx.rules.typedTimeReview && tm) return { kind: 'UNRECOGNIZED', norm: n, reason: 'TIME', types };
  const h = hits[0];
  // bracketed names are dropped ("Taking Break ( David)"), bracketed durations are kept ("Taking Break (30minute)")
  const clean = (r: string) => (idx.rules.ignoreBrackets ? r.replace(/\s*[(（][^)）\d]*[)）]/g, '') : r).replace(/[\s.。]+$/, '').trim();
  const remark = [...new Set(hits.map((x) => clean(x.raw)))].filter(Boolean).join(' · ').slice(0, 80);
  // typed time accepted (rule off): the punch still uses Telegram's time; the typed time is reported for follow-up
  const typedTime = tm ? tm[0].replace(/^[^\d]/, '').trim() : undefined;
  return { kind: 'PUNCH', type: h.type, norm: n, keyword: h.keyword, fuzzy: hits.every((x) => x.fuzzy), remark, ...(typedTime ? { typedTime } : {}) };
}

/** The employee's own words for a punch, e.g. "Lunch Break - 60 mins", "WC" — shown as a remark on breaks. */
export function punchRemark(text: string | null | undefined, idx: KeywordIndex): string | null {
  const p = parseText(text, idx);
  return p.kind === 'PUNCH' ? p.remark : null;
}

/** Validates an admin-submitted keyword configuration. Returns an error message or null. */
export function validateKeywords(kw: KeywordConfig): { zh: string; en: string } | null {
  const seen = new Map<string, string>();
  for (const [type, list] of Object.entries(kw)) {
    if (!Array.isArray(list) || list.length === 0) return { zh: `${type} 至少需要一个关键词`, en: `${type} needs at least one keyword` };
    for (const w of list) {
      const n = normText(w);
      if (!n) return { zh: `「${w}」去掉符号后为空`, en: `"${w}" is empty after removing symbols` };
      if (n.split(' ').length > 6) return { zh: `「${w}」太长（最多 6 个词）`, en: `"${w}" is too long (max 6 words)` };
      const prev = seen.get(canon(n));
      if (prev && prev !== type) return { zh: `「${w}」同时出现在 ${prev} 和 ${type}`, en: `"${w}" appears in both ${prev} and ${type}` };
      seen.set(canon(n), type);
    }
  }
  return null;
}
