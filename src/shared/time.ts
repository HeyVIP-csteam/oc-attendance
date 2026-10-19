// Time utilities shared by the Worker and the dashboard.
// Instants are UTC epoch milliseconds. Conversions to wall-clock time always go through Intl with an explicit
// IANA time zone, so results never depend on the runtime's default time zone (Workers run in UTC).

export const SEC = 1000;
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const pad = (n: number): string => String(n).padStart(2, '0');

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export interface WallParts { y: number; m: number; d: number; h: number; mi: number; s: number }

export function wallParts(ms: number, tz: string): WallParts {
  const o: Record<string, string> = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}

/** Offset (ms) of `tz` from UTC at instant `ms`. */
export function tzOffset(ms: number, tz: string): number {
  const p = wallParts(ms, tz);
  const base = Math.floor(ms / 1000) * 1000;
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - base;
}

/** Wall-clock date + time in `tz` → UTC instant. Handles DST transitions by re-checking the offset. */
export function zonedToUtc(date: string, hhmm: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffset(guess, tz);
  const o2 = tzOffset(t, tz);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

/** Business date (YYYY-MM-DD) of an instant in `tz`. */
export function localDate(ms: number, tz: string): string {
  const p = wallParts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / DAY);
}

export function weekday(date: string): number {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

export const monthStart = (date: string): string => date.slice(0, 8) + '01';
export function monthEnd(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
export const isHHMM = (s: unknown): s is string => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Scheduled start/end instants for a shift template on a business date (end ≤ start ⇒ overnight). */
export function shiftWindow(date: string, start: string, end: string, tz: string): { startAt: number; endAt: number; overnight: boolean } {
  const overnight = toMin(end) <= toMin(start);
  return {
    startAt: zonedToUtc(date, start, tz),
    endAt: zonedToUtc(overnight ? addDays(date, 1) : date, end, tz),
    overnight,
  };
}

export function fmtTime(ms: number | null | undefined, tz: string): string {
  if (ms == null) return '—';
  const p = wallParts(ms, tz);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

export function fmtDateTime(ms: number | null | undefined, tz: string): string {
  if (ms == null) return '—';
  const p = wallParts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/** A setting-style duration: 14h, 13h 30m, 45m. */
export function fmtHm(ms: number): string {
  const m = Math.round(ms / MIN);
  const h = Math.floor(m / 60);
  return h && m % 60 ? `${h}h ${m % 60}m` : h ? `${h}h` : `${m}m`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const m = Math.round(ms / MIN);
  return m >= 60 ? `${Math.floor(m / 60)}h ${pad(m % 60)}m` : `${m}m`;
}
