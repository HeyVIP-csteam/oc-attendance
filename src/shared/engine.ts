// Attendance state machine and calculations — pure, deterministic functions (no I/O, no clock reads).
// The Worker calls computeSession() whenever a session's inputs change and from the cron job when time passes.
//
//   NOT_STARTED --CLOCK_IN--> WORKING --BREAK_START--> ON_BREAK --BREAK_END--> WORKING --CLOCK_OUT--> COMPLETED
//
// Formulas (all instants in UTC ms, results in whole minutes):
//   Late Minutes        = floor((actualIn − scheduledStart) / 1 min)   when actualIn − scheduledStart > lateGrace, else 0
//   Early Leave Minutes = floor((scheduledEnd − actualOut) / 1 min)    when scheduledEnd − actualOut > earlyGrace, else 0
//   Incomplete Hours    = the shift length (breaks included) not completed; a late employee counts from the clock in
//                         and must stay until clock in + shift length (see incompleteHours)
//   Break Duration      = breakEnd − breakStart   (clipped to [actualIn, actualOut])
//   Total Break         = Σ closed break durations (each break counted once)
//   Total Shift         = actualOut − actualIn
//   Net Worked          = Total Shift − Total Break  (only when the session is complete and no break is open)

import { type Bi, bi, type EventType, type ExceptionCode, exceptionSeverity, FIXED, type MissingKind, type OtAnswer, type SessionState, type SessionStatus } from './codes';
import { fmtDuration, fmtHm, fmtTime, HOUR, MIN } from './time';

export interface EngineEvent {
  id: number;
  type: EventType;
  ts: number;               // Telegram message time (or admin-entered time)
  tgMessageId: number | null;
  receivedAt: number;
  source: 'TELEGRAM' | 'ADMIN';
  voided: boolean;
}

export interface EngineInstance {
  id: number;
  startAt: number;
  endAt: number;
  lateGraceMin: number;
  earlyGraceMin: number;
  breakMinutes: number | null;
}

export interface EngineRules { lateAsException: boolean; breakMinutes?: number | null }
/** A question the bot asked in the topic and its answer (null = not answered yet). */
export interface EngineQuestion { kind: 'EARLY' | 'LATE'; answer: OtAnswer | null; askedAt: number }

export interface Flag { code: ExceptionCode; ts: number; eventId: number | null; detail: Bi | null }

export interface BreakRow { seq: number; start: number; end: number | null; durMs: number | null; status: 'OPEN' | 'CLOSED' }

export interface SessionSummary {
  state: SessionState;
  status: SessionStatus;
  missing: MissingKind;
  inT: number | null;
  outT: number | null;
  schedIn: number | null;
  schedOut: number | null;
  lateMin: number | null;
  earlyMin: number | null;
  breaks: BreakRow[];
  breakCount: number;       // completed breaks
  openBreakCount: number;
  totalBreakMs: number;
  shiftDurMs: number | null;
  netMs: number | null;
  breakExceeded: boolean | null;
  otMs: number;             // OT confirmed through the bot's questions
  /** the shift length (breaks included) was not completed; null = complete, or not applicable */
  incomplete: Incomplete | null;
  flags: Flag[];
  eventResults: Map<number, ExceptionCode | null>;
  eventCount: number;
  nextCheckAt: number | null;
}

/**
 * Working hours check (breaks included). The required time is the scheduled shift length.
 *   not late (within the late grace)  → counted from the shift start (or the clock in, if later); must stay until the shift end
 *   late                              → counted from the actual clock in; must stay until clock in + shift length
 * Shortfalls within the early-leave grace are not flagged.
 */
export interface Incomplete { needMs: number; workedMs: number; untilAt: number; shortMs: number; fromAt: number }

export function incompleteHours(inst: Pick<EngineInstance, 'startAt' | 'endAt' | 'earlyGraceMin'>, inT: number, outT: number, late: boolean): Incomplete | null {
  const needMs = inst.endAt - inst.startAt;
  const fromAt = Math.max(inT, inst.startAt);
  const untilAt = late ? inT + needMs : inst.endAt;
  const shortMs = untilAt - outT;
  if (shortMs <= inst.earlyGraceMin * MIN) return null;
  return { needMs, workedMs: Math.max(0, outT - fromAt), untilAt, shortMs, fromAt };
}

export const sortEvents =(a: EngineEvent, b: EngineEvent): number =>
  a.ts - b.ts || (a.tgMessageId ?? 1e15) - (b.tgMessageId ?? 1e15) || a.id - b.id;

export interface SMResult {
  state: SessionState;
  inT: number | null;
  outT: number | null;
  breaks: { start: number; end: number | null; startEventId: number }[];
  results: Map<number, ExceptionCode | null>;
  flags: Flag[];
}

/** Runs the state machine over events that are already sorted by time. Invalid transitions are flagged, never dropped silently. */
export function runStateMachine(events: EngineEvent[]): SMResult {
  let state: SessionState = 'NOT_STARTED';
  let inT: number | null = null;
  let outT: number | null = null;
  const breaks: SMResult['breaks'] = [];
  const results = new Map<number, ExceptionCode | null>();
  const flags: Flag[] = [];
  for (const e of events) {
    let code: ExceptionCode | null = null;
    switch (e.type) {
      case 'CLOCK_IN':
        if (state === 'NOT_STARTED') { state = 'WORKING'; inT = e.ts; }
        else code = state === 'COMPLETED' ? 'PUNCH_AFTER_COMPLETED' : 'DUPLICATE_CLOCK_IN';
        break;
      case 'BREAK_START':
        if (state === 'WORKING') { state = 'ON_BREAK'; breaks.push({ start: e.ts, end: null, startEventId: e.id }); }
        else code = state === 'NOT_STARTED' ? 'BREAK_BEFORE_CLOCK_IN' : state === 'ON_BREAK' ? 'DUPLICATE_BREAK_START' : 'PUNCH_AFTER_COMPLETED';
        break;
      case 'BREAK_END':
        if (state === 'ON_BREAK') { state = 'WORKING'; breaks[breaks.length - 1].end = e.ts; }
        else code = state === 'COMPLETED' ? 'PUNCH_AFTER_COMPLETED' : 'RESUME_WITHOUT_BREAK';
        break;
      case 'CLOCK_OUT':
        if (state === 'WORKING') { state = 'COMPLETED'; outT = e.ts; }
        else if (state === 'ON_BREAK') { state = 'COMPLETED'; outT = e.ts; code = 'CLOCK_OUT_DURING_BREAK'; }
        else code = state === 'NOT_STARTED' ? 'CLOCK_OUT_WITHOUT_CLOCK_IN' : 'DUPLICATE_CLOCK_OUT';
        break;
    }
    results.set(e.id, code);
    if (code) flags.push({ code, ts: e.ts, eventId: e.id, detail: null });
  }
  return { state, inT, outT, breaks, results, flags };
}

/** True when an event with this code was still applied to the session (only CLOCK_OUT during a break). */
export const resultAccepted = (code: ExceptionCode | null): boolean => code === null || code === 'CLOCK_OUT_DURING_BREAK';

export interface ComputeInput {
  events: EngineEvent[];          // all events of the session, including voided ones (they are ignored for the SM)
  instance: EngineInstance | null;
  now: number;
  rules: EngineRules;
  tz: string;                     // display time zone for detail texts
  otDay?: boolean;                // the roster marks this day OT (overtime on a day off): punches without a shift are expected
  questions?: EngineQuestion[];   // the bot's OT questions for this session
  /** an OT / ST day (or a day marked OT by hand): the employee was not scheduled to work, working hours are not checked */
  skipHours?: boolean;
  /** the bot's "Incomplete working hours" questions for this session (answer null = not answered yet) */
  hoursQuestions?: { answer: string | null; askedAt: number }[];
}

export function computeSession(input: ComputeInput): SessionSummary | null {
  const { instance: inst, now, rules, tz } = input;
  const all = [...input.events].sort(sortEvents);
  const active = all.filter((e) => !e.voided);
  if (!active.length && !inst) return null;

  const sm = runStateMachine(active);
  const flags: Flag[] = [...sm.flags];

  // delivery-quality flags (Telegram-sourced events only, by arrival order)
  let maxTs = -Infinity;
  for (const e of all.filter((x) => x.source === 'TELEGRAM' && !x.voided).sort((a, b) => a.receivedAt - b.receivedAt || a.id - b.id)) {
    if (e.ts < maxTs) flags.push({ code: 'OUT_OF_ORDER', ts: e.ts, eventId: e.id, detail: bi('较晚送达但时间较早，已按 Telegram 时间重算', 'Arrived after a newer message; recalculated by Telegram time') });
    maxTs = Math.max(maxTs, e.ts);
    const lag = e.receivedAt - e.ts;
    if (lag > FIXED.delayThresholdMin * MIN) flags.push({ code: 'DELAYED_DELIVERY', ts: e.ts, eventId: e.id, detail: bi(`Telegram 时间与接收时间相差 ${fmtDuration(lag)}`, `Telegram time vs received time differ by ${fmtDuration(lag)}`) });
    if (lag < -2 * MIN) flags.push({ code: 'INVALID_TIME_ORDER', ts: e.ts, eventId: e.id, detail: bi('Telegram 时间晚于接收时间', 'Telegram time is later than the time it was received') });
  }

  const { inT, outT } = sm;
  const schedIn = inst ? inst.startAt : null;
  const schedOut = inst ? inst.endAt : null;
  // the grace only decides WHETHER it is late / early; the minutes are the full time from the scheduled start / to the
  // scheduled end (whole minutes, seconds dropped): 14:30 shift, clock in 14:38:40 → 8 min late
  const lateMin = inst && inT != null ? (inT - inst.startAt > inst.lateGraceMin * MIN ? Math.floor((inT - inst.startAt) / MIN) : 0) : null;
  const earlyMin = inst && outT != null ? (inst.endAt - outT > inst.earlyGraceMin * MIN ? Math.floor((inst.endAt - outT) / MIN) : 0) : null;

  const breaks: BreakRow[] = sm.breaks.map((b, i) => {
    let durMs: number | null = null;
    if (b.end != null) {
      const s = Math.max(b.start, inT ?? b.start);
      const e = Math.min(b.end, outT ?? b.end);
      durMs = Math.max(0, e - s);
    }
    return { seq: i + 1, start: b.start, end: b.end, durMs, status: b.end != null ? 'CLOSED' : 'OPEN' };
  });
  const closed = breaks.filter((b) => b.status === 'CLOSED');
  const open = breaks.filter((b) => b.status === 'OPEN');
  const totalBreakMs = closed.reduce((s, b) => s + (b.durMs ?? 0), 0);
  const shiftDurMs = inT != null && outT != null ? outT - inT : null;
  const netMs = shiftDurMs != null && open.length === 0 ? shiftDurMs - totalBreakMs : null;

  let breakExceeded: boolean | null = null;
  // the daily break allowance is one setting for every shift (Settings → Attendance rules); older shift-level values are only a fallback
  const quota = rules.breakMinutes !== undefined ? rules.breakMinutes : inst?.breakMinutes ?? null;
  if (inst && quota != null && inT != null) {
    breakExceeded = totalBreakMs > quota * MIN;
    if (breakExceeded) flags.push({ code: 'BREAK_LIMIT_EXCEEDED', ts: inT ?? inst.startAt, eventId: null, detail: bi(`当日合计 ${fmtDuration(totalBreakMs)} > ${quota}m`, `daily total ${fmtDuration(totalBreakMs)} > ${quota}m`) });
  }

  const windowMs = FIXED.shiftWindowHours * HOUR;
  const checks: number[] = [];
  let status: SessionStatus;
  let missing: MissingKind = 'NONE';
  if (inT == null) {
    if (active.length) { missing = 'MISSING_IN'; status = 'INCOMPLETE'; flags.push({ code: 'MISSING_CLOCK_IN', ts: active[0].ts, eventId: null, detail: null }); }
    else if (inst) {
      const absentAt = inst.startAt + FIXED.missingInHours * HOUR;
      if (now > absentAt) { status = 'ABSENT'; flags.push({ code: 'NO_SHOW', ts: inst.startAt, eventId: null, detail: null }); }
      else if (now >= inst.startAt - windowMs) { status = 'NOT_CLOCKED_IN'; checks.push(absentAt + 1); }
      else { status = 'SCHEDULED'; checks.push(inst.startAt - windowMs); }
    } else return null;
  } else if (outT == null) {
    // no clock out this long after clock in (the bot has asked "Are you on OT?" well before that)
    const forgotMs = FIXED.missingOutHours * HOUR;
    const deadline = inT + forgotMs;
    if (now > deadline) {
      missing = 'MISSING_OUT'; status = 'INCOMPLETE';
      flags.push({ code: 'MISSING_CLOCK_OUT', ts: deadline, eventId: null, detail: bi(`上班 ${fmtTime(inT, tz)} 后 ${fmtHm(forgotMs)} 没有下班打卡`, `No clock out ${fmtHm(forgotMs)} after clock in (${fmtTime(inT, tz)})`) });
    }
    else { status = sm.state === 'ON_BREAK' ? 'ON_BREAK' : 'WORKING'; checks.push(deadline + 1); }
  } else if (open.length) status = 'INCOMPLETE';
  else if (!inst) status = 'NO_SCHEDULE';
  else status = lateMin! > 0 && earlyMin! > 0 ? 'LATE_EARLY' : lateMin! > 0 ? 'LATE' : earlyMin! > 0 ? 'EARLY_LEAVE' : 'ON_TIME';

  if (open.length) {
    const ob = open[0];
    const limitAt = ob.start + FIXED.breakNotEndedMin * MIN;
    if (outT != null || missing === 'MISSING_OUT' || now > limitAt) {
      if (missing === 'NONE') missing = 'BREAK_NOT_ENDED';
      flags.push({ code: 'BREAK_NOT_ENDED', ts: ob.start, eventId: null, detail: bi(`第 ${ob.seq} 次休息开始于 ${fmtTime(ob.start, tz)}，没有 RESUME`, `Break #${ob.seq} started ${fmtTime(ob.start, tz)} with no RESUME`) });
    } else checks.push(limitAt + 1);
  }
  if (!inst && !input.otDay && active.length) flags.push({ code: 'UNSCHEDULED_PUNCH', ts: active[0].ts, eventId: null, detail: bi('当天没有该员工的班次', 'No shift scheduled for this employee on this date') });
  const incomplete = inst && inT != null && outT != null && !input.skipHours ? incompleteHours(inst, inT, outT, (lateMin ?? 0) > 0) : null;
  if (incomplete) {
    const sm = Math.floor(incomplete.shortMs / MIN) * MIN;
    flags.push({ code: 'INCOMPLETE_HOURS', ts: outT!, eventId: null, detail: bi(
      `应上满 ${fmtHm(incomplete.needMs)}（含休息）· ${fmtTime(incomplete.fromAt, tz)}–${fmtTime(outT!, tz)} = ${fmtHm(incomplete.workedMs)} · 应 ${fmtTime(incomplete.untilAt, tz)} 下班，差 ${fmtHm(sm)}`,
      `Needs ${fmtHm(incomplete.needMs)} (breaks included) · ${fmtTime(incomplete.fromAt, tz)}–${fmtTime(outT!, tz)} = ${fmtHm(incomplete.workedMs)} · should clock out at ${fmtTime(incomplete.untilAt, tz)}, ${fmtHm(sm)} short`) });
  }
  if (rules.lateAsException) {
    if (lateMin && lateMin > 0) flags.push({ code: 'LATE', ts: inT!, eventId: null, detail: bi(`迟到 ${lateMin} 分钟`, `${lateMin} min late`) });
    if (earlyMin && earlyMin > 0) flags.push({ code: 'EARLY_LEAVE', ts: outT!, eventId: null, detail: bi(`早退 ${earlyMin} 分钟`, `left ${earlyMin} min early`) });
  }

  // OT is counted only when the employee (or a colleague) answered the bot's question with OT:
  // early clock in → from the clock in to the shift start; still working after the set hours → from the shift end to the clock out
  const qs = input.questions ?? [];
  const ans = (k: 'EARLY' | 'LATE') => qs.find((q) => q.kind === k)?.answer ?? null;
  let otMs = 0;
  if (inst && inT != null && ans('EARLY') === 'YES' && inT < inst.startAt) otMs += inst.startAt - inT;
  if (inst && outT != null && ans('LATE') === 'OT' && outT > inst.endAt) otMs += outT - inst.endAt;
  const waiting = qs.filter((q) => q.answer == null);
  const overdue = waiting.filter((q) => now > q.askedAt + FIXED.otAnswerWaitMin * MIN);
  if (overdue.length) {
    const what = overdue.map((q) => (q.kind === 'EARLY' ? (inst ? ['提早上班', 'early clock in'] : ['休假日上班', 'clock in on a day off']) : ['超时未下班', 'no clock out'])) as [string, string][];
    flags.push({ code: 'OT_NO_ANSWER', ts: overdue[0].askedAt, eventId: null, detail: bi(`没有人回答 OT 问题（${what.map((w) => w[0]).join('、')}），不计算 OT`, `Nobody answered the OT question (${what.map((w) => w[1]).join(', ')}) — no OT counted`) });
  }
  for (const q of waiting) if (!overdue.includes(q)) checks.push(q.askedAt + FIXED.otAnswerWaitMin * MIN + 1);

  // the working hours question: unanswered for the same wait as the OT questions (only while the hours are still short)
  if (incomplete) {
    const hw = (input.hoursQuestions ?? []).filter((q) => q.answer == null);
    const late = hw.find((q) => now > q.askedAt + FIXED.otAnswerWaitMin * MIN);
    if (late) flags.push({ code: 'INCOMPLETE_NO_ANSWER', ts: late.askedAt, eventId: null, detail: bi('没有人回答工时不足问题（YES / NO / 忘记上班打卡）', 'Nobody answered the working hours question (Yes / No / Forgot clock in)') });
    else for (const q of hw) checks.push(q.askedAt + FIXED.otAnswerWaitMin * MIN + 1);
  }

  return {
    state: sm.state, status, missing, inT, outT, schedIn, schedOut, lateMin, earlyMin, breaks,
    breakCount: closed.length, openBreakCount: open.length, totalBreakMs, shiftDurMs, netMs, breakExceeded, otMs, incomplete,
    flags, eventResults: sm.results, eventCount: active.length,
    nextCheckAt: checks.length ? Math.min(...checks) : null,
  };
}

/** Exceptions whose severity is MEDIUM or HIGH (the attendance table shows them in red). */
export const hasMajor = (flags: Flag[]): boolean => flags.some((f) => exceptionSeverity(f.code) !== 'LOW');

/** Stable key used to upsert computed exceptions for a session. */
export const flagKey = (employeeId: number, workDate: string, f: Flag): string => `C|${employeeId}|${workDate}|${f.code}|${f.eventId ?? ''}`;
