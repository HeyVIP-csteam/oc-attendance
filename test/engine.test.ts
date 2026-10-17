// Unit tests for the pure, deterministic parts: time zone handling, keyword parser, state machine and calculations.
import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYWORDS } from '../src/shared/codes';
import { computeSession, type EngineEvent, type EngineInstance, runStateMachine } from '../src/shared/engine';
import { buildKeywordIndex, normText, parseText, validateKeywords } from '../src/shared/parser';
import { TEST_KEYWORDS, TEST_PARSER } from './helpers';
import { addDays, HOUR, localDate, MIN, shiftWindow, zonedToUtc } from '../src/shared/time';

const TZ = 'Asia/Colombo';
const lk = (d: string, t: string, s = 0) => zonedToUtc(d, t, TZ) + s * 1000;
let n = 0;
const ev = (type: EngineEvent['type'], ts: number, extra: Partial<EngineEvent> = {}): EngineEvent =>
  ({ id: ++n, type, ts, tgMessageId: n, receivedAt: ts + 1000, source: 'TELEGRAM', voided: false, ...extra });
const inst = (date: string, start: string, end: string, extra: Partial<EngineInstance> = {}): EngineInstance => {
  const w = shiftWindow(date, start, end, TZ);
  return { id: 1, startAt: w.startAt, endAt: w.endAt, lateGraceMin: 5, earlyGraceMin: 5, breakMinutes: 60, ...extra };
};
const rules = { windowHours: 4, lateAsException: false };

describe('time zones (test 15)', () => {
  it('converts Colombo wall time to UTC without relying on the runtime time zone', () => {
    expect(new Date(lk('2026-10-16', '07:00')).toISOString()).toBe('2026-10-16T01:30:00.000Z');
    expect(new Date(lk('2026-10-16', '23:00')).toISOString()).toBe('2026-10-16T17:30:00.000Z');
  });
  it('23:00 Sri Lanka time belongs to the same business date (16th), 01:30 the next day to the 17th', () => {
    expect(localDate(lk('2026-10-16', '23:00'), TZ)).toBe('2026-10-16');
    expect(localDate(Date.parse('2026-10-16T20:00:00Z'), TZ)).toBe('2026-10-17'); // 01:30 LK
  });
  it('overnight shift window ends on the next calendar day', () => {
    const w = shiftWindow('2026-10-16', '23:00', '07:00', TZ);
    expect(w.overnight).toBe(true);
    expect(w.endAt - w.startAt).toBe(8 * HOUR);
  });
  it('handles DST zones (America/New_York spring-forward day is 23 h long)', () => {
    const a = zonedToUtc('2026-03-08', '00:00', 'America/New_York');
    const b = zonedToUtc('2026-03-09', '00:00', 'America/New_York');
    expect(b - a).toBe(23 * HOUR);
    const w = shiftWindow('2026-03-07', '22:00', '06:00', 'America/New_York');
    expect(w.endAt - w.startAt).toBe(7 * HOUR); // 8 wall-clock hours minus the skipped hour
  });
  it('date arithmetic', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });
});

describe('keyword parser', () => {
  const idx = buildKeywordIndex(TEST_KEYWORDS, TEST_PARSER);
  it.each([
    ['IN', 'CLOCK_IN'], ['in', 'CLOCK_IN'], ['  In. ', 'CLOCK_IN'], ['IN ✅', 'CLOCK_IN'], ['clock-in', 'CLOCK_IN'], ['Clock In!', 'CLOCK_IN'], ['/in@MyBot', 'CLOCK_IN'],
    ['BREAK', 'BREAK_START'], ['break start', 'BREAK_START'], ['RESUME', 'BREAK_END'], ['Break End', 'BREAK_END'], ['OUT 👋', 'CLOCK_OUT'], ['clock out', 'CLOCK_OUT'],
    ['ＩＮ', 'CLOCK_IN'], // full-width letters are NFKC-normalised
  ])('"%s" → %s', (text, type) => {
    expect(parseText(text, idx)).toMatchObject({ kind: 'PUNCH', type });
  });
  it.each([
    ['Clocked in\nAgent: Nisha\nDate: 16/10/2026', 'CLOCK_IN', 'Clocked in'],
    ['Log in for the day.\nAgent : Michael den.', 'CLOCK_IN', 'Log in for the day'],
    ['🟢Start of Shift🟢 Clocked In', 'CLOCK_IN', null],
    ['Dinner Break\nNisha', 'BREAK_START', 'Dinner Break'],
    ['CS Name: probas sharma\nWC', 'BREAK_START', 'WC'],
    ['Name: Paul Parks\nLunch Break - 60 mins', 'BREAK_START', 'Lunch Break - 60 mins'],
    ['Taking Break ( David)', 'BREAK_START', 'Taking Break'],
    ['Taking Break (30minute).', 'BREAK_START', 'Taking Break (30minute)'],
    ['CS Name: Joy Shah\n1st Break ( 60 minit)', 'BREAK_START', null],
    ['back', 'BREAK_END', 'back'], ['back from break', 'BREAK_END', null],
    ['CS Name: TONMOY HOSSAIN\nChecked Out', 'CLOCK_OUT', 'Checked Out'],
    ['Done For the day ( David )', 'CLOCK_OUT', 'Done For the day'],
    ['Clocked out\nAgent: Nisha\nDate: 14/10/2026', 'CLOCK_OUT', 'Clocked out'],
    ['out early', 'CLOCK_OUT', null], ['break 15min', 'BREAK_START', null],
  ])('real-world message %j → %s (labels, names and dates are skipped)', (text, type, remark) => {
    const r = parseText(text, idx);
    expect(r).toMatchObject({ kind: 'PUNCH', type });
    if (remark) expect(r).toMatchObject({ remark });
  });
  it.each([['clok in', 'CLOCK_IN'], ['brek', 'BREAK_START'], ['resme', 'BREAK_END'], ['innnn', 'CLOCK_IN'], ['outtt', 'CLOCK_OUT'], ['chekced out', 'CLOCK_OUT']])('typo %j → %s', (text, type) => {
    expect(parseText(text, idx)).toMatchObject({ kind: 'PUNCH', type });
  });
  it.each([['in 9am', 'TIME'], ['IN 08:30', 'TIME'], ['Clocked in 4.55', 'TIME'], ['in out', 'CONFLICT'], ['break back', 'CONFLICT']])('%j → UNRECOGNIZED (%s): never a punch, typed times are ignored', (text, reason) => {
    expect(parseText(text, idx)).toMatchObject({ kind: 'UNRECOGNIZED', reason });
  });
  it.each(['good morning', 'ok noted', "I'm in the meeting now", 'will be out for lunch later?', '', '👍', 'on', 'it', 'thanks'])('chat "%s" → NONE', (text) => {
    expect(parseText(text, idx).kind).toBe('NONE');
  });
  it('custom aliases including non-Latin keywords', () => {
    const i2 = buildKeywordIndex({ ...TEST_KEYWORDS, CLOCK_IN: ['IN', '上班'] }, TEST_PARSER);
    expect(parseText('上班', i2)).toMatchObject({ kind: 'PUNCH', type: 'CLOCK_IN' });
    expect(parseText('上班了', i2)).toMatchObject({ kind: 'PUNCH', type: 'CLOCK_IN' });
    expect(parseText('今天上班的时候系统一直卡住很久', i2).kind).toBe('NONE');
  });
  it('reading rules come from settings: labels, typo tolerance, brackets, typed times', () => {
    const msg = 'Agent: Out Smith\nClocked in';
    expect(parseText(msg, buildKeywordIndex(TEST_KEYWORDS, TEST_PARSER))).toMatchObject({ kind: 'PUNCH', type: 'CLOCK_IN' });
    expect(parseText(msg, buildKeywordIndex(TEST_KEYWORDS, { ...TEST_PARSER, skipLabels: [] })).kind).toBe('UNRECOGNIZED'); // "Out" in the name now counts
    expect(parseText('brek', buildKeywordIndex(TEST_KEYWORDS, { ...TEST_PARSER, typoTolerance: false })).kind).not.toBe('PUNCH');
    expect(parseText('IN 08:30', buildKeywordIndex(TEST_KEYWORDS, { ...TEST_PARSER, typedTimeReview: false }))).toMatchObject({ kind: 'PUNCH', type: 'CLOCK_IN' });
    expect(parseText('Taking Break (back soon)', buildKeywordIndex(TEST_KEYWORDS, { ...TEST_PARSER, ignoreBrackets: false })).kind).toBe('UNRECOGNIZED');
  });
  it('code fallback is only the four basic keywords', () => {
    expect(DEFAULT_KEYWORDS).toEqual({ CLOCK_IN: ['IN'], BREAK_START: ['BREAK'], BREAK_END: ['RESUME'], CLOCK_OUT: ['OUT'] });
    expect(parseText('WC', buildKeywordIndex(DEFAULT_KEYWORDS)).kind).toBe('NONE'); // WC only works once an admin adds it
  });
  it('rejects ambiguous keyword configurations', () => {
    expect(validateKeywords({ ...DEFAULT_KEYWORDS, CLOCK_OUT: ['OUT', 'in'] })).not.toBeNull();
    expect(validateKeywords({ ...DEFAULT_KEYWORDS, BREAK_END: [] })).not.toBeNull();
    expect(validateKeywords(DEFAULT_KEYWORDS)).toBeNull();
    expect(validateKeywords(TEST_KEYWORDS)).toBeNull();
  });
  it('normalises punctuation and case', () => expect(normText('  Clock_IN!! ')).toBe('clock in'));
});

describe('state machine (test 14: invalid transitions)', () => {
  it('normal flow', () => {
    const sm = runStateMachine([ev('CLOCK_IN', 1), ev('BREAK_START', 2), ev('BREAK_END', 3), ev('CLOCK_OUT', 4)]);
    expect(sm.state).toBe('COMPLETED');
    expect(sm.flags).toHaveLength(0);
  });
  it('flags every invalid transition and never drops events silently', () => {
    const sm = runStateMachine([ev('BREAK_START', 1), ev('BREAK_END', 2), ev('CLOCK_OUT', 3), ev('CLOCK_IN', 4), ev('CLOCK_IN', 5), ev('BREAK_START', 6), ev('BREAK_START', 7), ev('CLOCK_OUT', 8), ev('CLOCK_OUT', 9), ev('BREAK_END', 10)]);
    expect(sm.flags.map((f) => f.code)).toEqual([
      'BREAK_BEFORE_CLOCK_IN', 'RESUME_WITHOUT_BREAK', 'CLOCK_OUT_WITHOUT_CLOCK_IN', 'DUPLICATE_CLOCK_IN', 'DUPLICATE_BREAK_START',
      'CLOCK_OUT_DURING_BREAK', 'DUPLICATE_CLOCK_OUT', 'PUNCH_AFTER_COMPLETED',
    ]);
    expect(sm.results.size).toBe(10);
  });
});

describe('calculations', () => {
  const d = '2026-10-16';
  const A = inst(d, '07:00', '15:00');
  it('test 1: on-time IN / OUT → net = shift − breaks', () => {
    const s = computeSession({ events: [ev('CLOCK_IN', lk(d, '06:55')), ev('CLOCK_OUT', lk(d, '15:02'))], instance: A, now: lk(d, '16:00'), rules, tz: TZ })!;
    expect(s.status).toBe('ON_TIME');
    expect(s.lateMin).toBe(0);
    expect(s.earlyMin).toBe(0);
    expect(s.shiftDurMs).toBe(8 * HOUR + 7 * MIN);
    expect(s.netMs).toBe(8 * HOUR + 7 * MIN);
  });
  it('test 2: multiple breaks are summed once each', () => {
    const s = computeSession({ events: [ev('CLOCK_IN', lk(d, '07:00')), ev('BREAK_START', lk(d, '09:00')), ev('BREAK_END', lk(d, '09:15')),
      ev('BREAK_START', lk(d, '12:00')), ev('BREAK_END', lk(d, '12:30')), ev('BREAK_START', lk(d, '14:00')), ev('BREAK_END', lk(d, '14:10')), ev('CLOCK_OUT', lk(d, '15:00'))],
    instance: A, now: lk(d, '16:00'), rules, tz: TZ })!;
    expect(s.breakCount).toBe(3);
    expect(s.totalBreakMs).toBe(55 * MIN);
    expect(s.netMs).toBe(8 * HOUR - 55 * MIN);
    expect(s.breakExceeded).toBe(false);
  });
  it('test 3: late minutes = max(0, in − start − grace), partial minutes round up', () => {
    const mk = (t: string, sec = 0) => computeSession({ events: [ev('CLOCK_IN', lk(d, t, sec))], instance: A, now: lk(d, '08:00'), rules, tz: TZ })!.lateMin;
    expect(mk('07:05')).toBe(0);       // inside 5-minute grace
    expect(mk('07:05', 1)).toBe(1);    // 1 second past grace → 1 minute
    expect(mk('07:20')).toBe(15);
    expect(mk('06:30')).toBe(0);
  });
  it('test 4: early leave = max(0, end − grace − out)', () => {
    const mk = (t: string) => computeSession({ events: [ev('CLOCK_IN', lk(d, '07:00')), ev('CLOCK_OUT', lk(d, t))], instance: A, now: lk(d, '16:00'), rules, tz: TZ })!;
    expect(mk('14:55').earlyMin).toBe(0);
    expect(mk('14:30').earlyMin).toBe(25);
    expect(mk('14:30').status).toBe('EARLY_LEAVE');
  });
  it('test 6: overnight C shift with breaks across midnight', () => {
    const C = inst(d, '23:00', '07:00');
    const s = computeSession({ events: [ev('CLOCK_IN', lk(d, '22:58')), ev('BREAK_START', lk('2026-10-17', '02:00')), ev('BREAK_END', lk('2026-10-17', '02:30')), ev('CLOCK_OUT', lk('2026-10-17', '07:03'))],
      instance: C, now: lk('2026-10-17', '08:00'), rules, tz: TZ })!;
    expect(s.status).toBe('ON_TIME');
    expect(s.shiftDurMs).toBe(8 * HOUR + 5 * MIN);
    expect(s.netMs).toBe(7 * HOUR + 35 * MIN);
  });
  it('test 8: missing clock-out becomes INCOMPLETE only after end + 4 h, and net is not shown', () => {
    const evs = [ev('CLOCK_IN', lk(d, '07:00'))];
    const working = computeSession({ events: evs, instance: A, now: lk(d, '18:00'), rules, tz: TZ })!;
    expect(working.status).toBe('WORKING');
    expect(working.nextCheckAt).toBe(A.endAt + 4 * HOUR + 1);
    const later = computeSession({ events: evs, instance: A, now: lk(d, '19:01'), rules, tz: TZ })!;
    expect(later.status).toBe('INCOMPLETE');
    expect(later.missing).toBe('MISSING_OUT');
    expect(later.netMs).toBeNull();
    expect(later.flags.map((f) => f.code)).toContain('MISSING_CLOCK_OUT');
  });
  it('test 9: unended break is flagged; clock-out during break keeps the break open and no net hours', () => {
    const s = computeSession({ events: [ev('CLOCK_IN', lk(d, '07:00')), ev('BREAK_START', lk(d, '12:00')), ev('CLOCK_OUT', lk(d, '15:00'))], instance: A, now: lk(d, '16:00'), rules, tz: TZ })!;
    expect(s.status).toBe('INCOMPLETE');
    expect(s.openBreakCount).toBe(1);
    expect(s.netMs).toBeNull();
    expect(s.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['CLOCK_OUT_DURING_BREAK', 'BREAK_NOT_ENDED']));
  });
  it('open break during a shift is only flagged after 120 minutes', () => {
    const evs = [ev('CLOCK_IN', lk(d, '07:00')), ev('BREAK_START', lk(d, '10:00'))];
    expect(computeSession({ events: evs, instance: A, now: lk(d, '11:00'), rules, tz: TZ })!.status).toBe('ON_BREAK');
    expect(computeSession({ events: evs, instance: A, now: lk(d, '12:01'), rules, tz: TZ })!.flags.map((f) => f.code)).toContain('BREAK_NOT_ENDED');
  });
  it('no-show: scheduled → not clocked in → absent', () => {
    expect(computeSession({ events: [], instance: A, now: lk(d, '01:00'), rules, tz: TZ })!.status).toBe('SCHEDULED');
    expect(computeSession({ events: [], instance: A, now: lk(d, '07:30'), rules, tz: TZ })!.status).toBe('NOT_CLOCKED_IN');
    const s = computeSession({ events: [], instance: A, now: lk(d, '09:01'), rules, tz: TZ })!;
    expect(s.status).toBe('ABSENT');
    expect(s.flags[0].code).toBe('NO_SHOW');
  });
  it('break limit (total break per shift)', () => {
    const s = computeSession({ events: [ev('CLOCK_IN', lk(d, '07:00')), ev('BREAK_START', lk(d, '10:00')), ev('BREAK_END', lk(d, '11:10')), ev('CLOCK_OUT', lk(d, '15:00'))], instance: A, now: lk(d, '16:00'), rules, tz: TZ })!;
    expect(s.breakExceeded).toBe(true);
    expect(s.flags.map((f) => f.code)).toContain('BREAK_LIMIT_EXCEEDED');
  });
  it('unscheduled punches compute hours but are flagged', () => {
    const s = computeSession({ events: [ev('CLOCK_IN', lk(d, '10:00')), ev('CLOCK_OUT', lk(d, '14:00'))], instance: null, now: lk(d, '15:00'), rules, tz: TZ })!;
    expect(s.status).toBe('NO_SCHEDULE');
    expect(s.lateMin).toBeNull();
    expect(s.netMs).toBe(4 * HOUR);
    expect(s.flags.map((f) => f.code)).toContain('UNSCHEDULED_PUNCH');
  });
  it('out-of-order and delayed delivery are flagged, results use Telegram time', () => {
    const inEv = ev('CLOCK_IN', lk(d, '07:00'), { receivedAt: lk(d, '07:20') });   // arrives 20 min late
    const brEv = ev('BREAK_START', lk(d, '07:10'), { receivedAt: lk(d, '07:10', 5) });
    const s = computeSession({ events: [brEv, inEv], instance: A, now: lk(d, '07:30'), rules, tz: TZ })!;
    expect(s.inT).toBe(lk(d, '07:00'));
    expect(s.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['OUT_OF_ORDER', 'DELAYED_DELIVERY']));
    expect(s.state).toBe('ON_BREAK');
  });
  it('voided events are excluded; admin events count', () => {
    const wrong = ev('CLOCK_OUT', lk(d, '08:00'), { voided: true });
    const fixed = ev('CLOCK_OUT', lk(d, '15:00'), { source: 'ADMIN', tgMessageId: null });
    const s = computeSession({ events: [ev('CLOCK_IN', lk(d, '07:00')), wrong, fixed], instance: A, now: lk(d, '16:00'), rules, tz: TZ })!;
    expect(s.outT).toBe(lk(d, '15:00'));
    expect(s.status).toBe('ON_TIME');
  });
  it('late / early can also be listed as exceptions', () => {
    const s = computeSession({ events: [ev('CLOCK_IN', lk(d, '07:30')), ev('CLOCK_OUT', lk(d, '14:00'))], instance: A, now: lk(d, '16:00'), rules: { ...rules, lateAsException: true }, tz: TZ })!;
    expect(s.status).toBe('LATE_EARLY');
    expect(s.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['LATE', 'EARLY_LEAVE']));
  });
  it('is deterministic: the same input always produces the same output', () => {
    const evs = [ev('CLOCK_IN', lk(d, '07:03')), ev('BREAK_START', lk(d, '11:00')), ev('BREAK_END', lk(d, '11:40')), ev('CLOCK_OUT', lk(d, '14:50'))];
    const a = computeSession({ events: evs, instance: A, now: lk(d, '20:00'), rules, tz: TZ });
    const b = computeSession({ events: [...evs].reverse(), instance: A, now: lk(d, '20:00'), rules, tz: TZ });
    expect({ ...a, eventResults: null }).toEqual({ ...b, eventResults: null });
  });
});
