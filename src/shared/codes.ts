// Codes and bilingual labels shared by the Worker and the dashboard.

export type Bi = { zh: string; en: string };
export const bi = (zh: string, en: string): Bi => ({ zh, en });

export const EVENT_TYPES = ['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_LABEL: Record<EventType, Bi> = {
  CLOCK_IN: bi('上班 IN', 'Clock In'),
  BREAK_START: bi('开始休息', 'Break Start'),
  BREAK_END: bi('结束休息', 'Break End'),
  CLOCK_OUT: bi('下班 OUT', 'Clock Out'),
};

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';

export const EXCEPTIONS = {
  UNKNOWN_SENDER: { label: bi('未登记发送者', 'Unknown sender'), sev: 'HIGH' },
  INACTIVE_EMPLOYEE: { label: bi('已停用员工打卡', 'Inactive employee'), sev: 'MEDIUM' },
  NO_TOPIC: { label: bi('未在 Topic 内打卡', 'Not in a topic'), sev: 'MEDIUM' },
  WRONG_TOPIC_UNMAPPED: { label: bi('Topic 未映射', 'Unmapped topic'), sev: 'MEDIUM' },
  UNTRUSTED_SOURCE: { label: bi('转发/非本人消息', 'Forwarded / untrusted'), sev: 'HIGH' },
  UNRECOGNIZED: { label: bi('无法识别的打卡', 'Unrecognised punch'), sev: 'LOW' },
  EDITED_MESSAGE: { label: bi('打卡消息被编辑', 'Punch message edited'), sev: 'LOW' },
  DUPLICATE_CLOCK_IN: { label: bi('重复上班打卡', 'Duplicate clock in'), sev: 'LOW' },
  DUPLICATE_BREAK_START: { label: bi('重复开始休息', 'Duplicate break start'), sev: 'LOW' },
  DUPLICATE_CLOCK_OUT: { label: bi('重复下班打卡', 'Duplicate clock out'), sev: 'LOW' },
  BREAK_BEFORE_CLOCK_IN: { label: bi('未上班就休息', 'Break before clock in'), sev: 'MEDIUM' },
  RESUME_WITHOUT_BREAK: { label: bi('未休息就 Resume', 'Resume without break'), sev: 'LOW' },
  CLOCK_OUT_WITHOUT_CLOCK_IN: { label: bi('未上班就下班', 'Clock out without clock in'), sev: 'MEDIUM' },
  CLOCK_OUT_DURING_BREAK: { label: bi('休息中下班', 'Clock out during break'), sev: 'MEDIUM' },
  PUNCH_AFTER_COMPLETED: { label: bi('下班后再打卡', 'Punch after clock out'), sev: 'MEDIUM' },
  MISSING_CLOCK_IN: { label: bi('缺少上班打卡', 'Missing clock in'), sev: 'MEDIUM' },
  NO_SHOW: { label: bi('排班未出勤', 'No show'), sev: 'MEDIUM' },
  MISSING_CLOCK_OUT: { label: bi('缺少下班打卡', 'Missing clock out'), sev: 'MEDIUM' },
  BREAK_NOT_ENDED: { label: bi('休息未结束', 'Break not ended'), sev: 'MEDIUM' },
  UNSCHEDULED_PUNCH: { label: bi('未排班打卡', 'Unscheduled punch'), sev: 'LOW' },
  DELAYED_DELIVERY: { label: bi('消息延迟送达', 'Delayed delivery'), sev: 'LOW' },
  TYPED_TIME: { label: bi('员工自填时间', 'Typed time'), sev: 'LOW' },
  OUT_OF_ORDER: { label: bi('消息乱序到达', 'Out-of-order message'), sev: 'LOW' },
  INVALID_TIME_ORDER: { label: bi('时间顺序无效', 'Invalid time order'), sev: 'MEDIUM' },
  BREAK_LIMIT_EXCEEDED: { label: bi('超过休息规则', 'Break limit exceeded'), sev: 'LOW' },
  LATE: { label: bi('迟到', 'Late'), sev: 'LOW' },
  EARLY_LEAVE: { label: bi('早退', 'Early leave'), sev: 'LOW' },
} as const satisfies Record<string, { label: Bi; sev: Severity }>;

export type ExceptionCode = keyof typeof EXCEPTIONS;
export const exceptionSeverity = (c: string): Severity => (EXCEPTIONS as Record<string, { sev: Severity }>)[c]?.sev ?? 'LOW';

export const STATUSES = {
  ON_TIME: { label: bi('准时', 'On time'), cls: 'ok' },
  LATE: { label: bi('迟到', 'Late'), cls: 'w' },
  EARLY_LEAVE: { label: bi('早退', 'Early leave'), cls: 'w' },
  LATE_EARLY: { label: bi('迟到+早退', 'Late + early'), cls: 'w' },
  WORKING: { label: bi('工作中', 'Working'), cls: 'i' },
  ON_BREAK: { label: bi('休息中', 'On break'), cls: 'v' },
  INCOMPLETE: { label: bi('数据不完整', 'Incomplete'), cls: 'r' },
  ABSENT: { label: bi('缺勤', 'Absent'), cls: 'r' },
  NOT_CLOCKED_IN: { label: bi('未打卡', 'Not clocked in'), cls: 'w' },
  SCHEDULED: { label: bi('未开始', 'Scheduled'), cls: '' },
  NO_SCHEDULE: { label: bi('未排班', 'No schedule'), cls: 'v' },
} as const;
export type SessionStatus = keyof typeof STATUSES;

export type SessionState = 'NOT_STARTED' | 'WORKING' | 'ON_BREAK' | 'COMPLETED';
export type MissingKind = 'NONE' | 'MISSING_IN' | 'MISSING_OUT' | 'BREAK_NOT_ENDED';

export interface KeywordConfig { CLOCK_IN: string[]; BREAK_START: string[]; BREAK_END: string[]; CLOCK_OUT: string[] }

export interface Rules {
  windowHours: number;        // shift matching window (hours before/after the scheduled shift; may be a fraction, e.g. 0.5 = 30 min)
  windowUnit?: 'h' | 'm';     // how the admin entered it (display only)
  lateAsException: boolean;   // also list late / early leave as exceptions
  botReply: boolean;          // bot replies in the topic
  otHours: number;            // on-shift time (clock in → clock out) above this many hours is tagged OT on the roster
}

/** Fixed thresholds (not user-editable; removed from the UI by request). */
export const FIXED = {
  missingInHours: 2,        // no clock-in this long after scheduled start → ABSENT / NO_SHOW
  missingOutHours: 4,       // no clock-out this long after scheduled end → MISSING_CLOCK_OUT
  breakNotEndedMin: 120,    // an open break older than this → BREAK_NOT_ENDED
  delayThresholdMin: 5,     // received_at − telegram time above this → DELAYED_DELIVERY
  unscheduledMaxHours: 16,  // without a shift, an open session is considered missing OUT after this
  openSessionMaxHours: 20,  // a BREAK/RESUME/OUT is attached to an open session started within this many hours
} as const;

/** Fallback only — the real keyword list lives in the database (Settings → Punch keywords, seeded by migrations). */
export const DEFAULT_KEYWORDS: KeywordConfig = {
  CLOCK_IN: ['IN'], BREAK_START: ['BREAK'], BREAK_END: ['RESUME'], CLOCK_OUT: ['OUT'],
};

/** How messages are read. Stored in the database (Settings → Punch keywords → Message reading rules). */
export interface ParserRules {
  /** Lines starting with one of these labels followed by ":" are information, never the action ("Agent: Nisha"). */
  skipLabels: string[];
  /** Accept one wrong / missing / swapped letter ("clok in", "brek") and repeated letters ("innnn"). */
  typoTolerance: boolean;
  /** Ignore text in brackets ("Taking Break ( David)"). */
  ignoreBrackets: boolean;
  /** A message with a typed clock time ("IN 08:30") goes to review instead of punching. The typed time is never used either way. */
  typedTimeReview: boolean;
}
export const DEFAULT_PARSER: ParserRules = { skipLabels: [], typoTolerance: true, ignoreBrackets: true, typedTimeReview: true };
export const DEFAULT_RULES: Rules = { windowHours: 4, windowUnit: 'h', lateAsException: false, botReply: true, otHours: 9 };

export const BIZ_TZ_DEFAULT = 'Asia/Colombo';
