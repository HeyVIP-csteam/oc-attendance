// Attendance state machine and calculations — pure, deterministic functions (no I/O, no clock reads).
// The Worker calls computeSession() whenever a session's inputs change and from the cron job when time passes.
//
//   NOT_STARTED --CLOCK_IN--> WORKING --BREAK_START--> ON_BREAK --BREAK_END--> WORKING --CLOCK_OUT--> COMPLETED
//
// Formulas (all instants in UTC ms, results in whole minutes):
//   Late Minutes        = max(0, ceil((actualIn  − scheduledStart − lateGrace)  / 1 min))
//   Early Leave Minutes = max(0, floor((scheduledEnd − earlyGrace − actualOut) / 1 min))
//   Break Duration      = breakEnd − breakStart   (clipped to [actualIn, actualOut])
//   Total Break         = Σ closed break durations (each break counted once)
//   Total Shift         = actualOut − actualIn
//   Net Worked          = Total Shift − Total Break  (only when the session is complete and no break is open)

import { type Bi, bi, type EventType, type ExceptionCode, exceptionSeverity, FIXED, type MissingKind, type SessionState, type SessionStatus } from './codes';
import { fmtDuration, fmtTime, HOUR, MIN } from './time';

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

export interface EngineRules { windowHours: number; lateAsException: boolean; breakMinutes?: number | null }

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
  flags: Flag[];
  eventResults: Map<number, ExceptionCode | null>;
  eventCount: number;
  nextCheckAt: number | null;
}

export const sortEvents = (a: EngineEvent, b: EngineEvent): number =>
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
  const lateMin = inst && inT != null ? Math.max(0, Math.ceil((inT - inst.startAt - inst.lateGraceMin * MIN) / MIN)) : null;
  const earlyMin = inst && outT != null ? Math.max(0, Math.floor((inst.endAt - inst.earlyGraceMin * MIN - outT) / MIN)) : null;

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

  const windowMs = rules.windowHours * HOUR;
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
    const deadline = inst ? inst.endAt + FIXED.missingOutHours * HOUR : inT + FIXED.unscheduledMaxHours * HOUR;
    if (now > deadline) { missing = 'MISSING_OUT'; status = 'INCOMPLETE'; flags.push({ code: 'MISSING_CLOCK_OUT', ts: deadline, eventId: null, detail: null }); }
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
  if (!inst && active.length) flags.push({ code: 'UNSCHEDULED_PUNCH', ts: active[0].ts, eventId: null, detail: bi('当天没有该员工的班次', 'No shift scheduled for this employee on this date') });
  if (rules.lateAsException) {
    if (lateMin && lateMin > 0) flags.push({ code: 'LATE', ts: inT!, eventId: null, detail: bi(`迟到 ${lateMin} 分钟`, `${lateMin} min late`) });
    if (earlyMin && earlyMin > 0) flags.push({ code: 'EARLY_LEAVE', ts: outT!, eventId: null, detail: bi(`早退 ${earlyMin} 分钟`, `left ${earlyMin} min early`) });
  }

  return {
    state: sm.state, status, missing, inT, outT, schedIn, schedOut, lateMin, earlyMin, breaks,
    breakCount: closed.length, openBreakCount: open.length, totalBreakMs, shiftDurMs, netMs, breakExceeded,
    flags, eventResults: sm.results, eventCount: active.length,
    nextCheckAt: checks.length ? Math.min(...checks) : null,
  };
}

/** Exceptions whose severity is MEDIUM or HIGH (the attendance table shows them in red). */
export const hasMajor = (flags: Flag[]): boolean => flags.some((f) => exceptionSeverity(f.code) !== 'LOW');

/** Stable key used to upsert computed exceptions for a session. */
export const flagKey = (employeeId: number, workDate: string, f: Flag): string => `C|${employeeId}|${workDate}|${f.code}|${f.eventId ?? ''}`;
