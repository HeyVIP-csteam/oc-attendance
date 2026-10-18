import { fmtDateTime, fmtDuration, fmtTime, HOUR, localDate, pad, wallParts, zonedToUtc } from '../../../src/shared/time';

/** All times are displayed in Sri Lanka time (the business time zone). */
export const TZ = 'Asia/Colombo';

export const fmtT = (ms: number | null | undefined) => fmtTime(ms, TZ);
export const fmtDT = (ms: number | null | undefined) => fmtDateTime(ms, TZ);
export const fmtDur = (ms: number | null | undefined) => fmtDuration(ms);
export const hrs = (ms: number | null | undefined) => (ms == null ? '—' : (ms / HOUR).toFixed(2));
export const today = () => localDate(Date.now(), TZ);
/** Whole minutes → "45m" / "7h 19m" (late and early leave are stored in minutes). */
export const fmtMin = (m: number | null | undefined): string => {
  if (m == null) return '—';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
export const LATE_RED = '#e60012';

export function toLocalInput(ms: number): string {
  const p = wallParts(ms, TZ);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}
export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const [d, t] = v.split('T');
  const [h, m, s] = (t || '00:00').split(':');
  return zonedToUtc(d, `${h}:${m}`, TZ) + Number(s || 0) * 1000;
}

/** "10-04 22:59" in Sri Lanka time. */
export const fmtMDT = (ms: number) => fmtDateTime(ms, TZ).slice(5, 16);
const VIEWER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return TZ; } })();
/** The same moment in the viewer's own time zone ("10-05 01:29"), or null when it reads the same as Sri Lanka time. */
export function fmtMine(ms: number): string | null {
  const mine = fmtDateTime(ms, VIEWER_TZ).slice(5, 16);
  return mine === fmtMDT(ms) ? null : mine;
}
/** "GMT+8" style label of the viewer's time zone. */
export const mineLabel = (ms: number) => { try { return new Intl.DateTimeFormat('en-US', { timeZoneName: 'shortOffset', timeZone: VIEWER_TZ }).formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value ?? VIEWER_TZ; } catch { return VIEWER_TZ; } };
