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
  SCHEDULED_MESSAGE: { label: bi('定时发送的打卡', 'Scheduled message'), sev: 'HIGH' },
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
  OT_NO_ANSWER: { label: bi('未回答 OT 问题', 'No answer to the OT question'), sev: 'LOW' },
  FORGOT_CLOCK_OUT: { label: bi('忘记下班打卡（按钮）', 'Forgot clock out (button)'), sev: 'MEDIUM' },
  INCOMPLETE_HOURS: { label: bi('工时不足', 'Incomplete working hours'), sev: 'MEDIUM' },
  FORGOT_CLOCK_IN: { label: bi('忘记上班打卡（按钮）', 'Forgot clock in (button)'), sev: 'MEDIUM' },
  CLOCK_OUT_CANCELLED: { label: bi('取消下班（按了 No）', 'Clock out cancelled (No)'), sev: 'LOW' },
  INCOMPLETE_NO_ANSWER: { label: bi('未回答工时不足问题', 'No answer to the working hours question'), sev: 'LOW' },
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
  /** @deprecated the shift matching window is fixed (FIXED.shiftWindowHours); kept only so old saved settings still parse */
  windowHours?: number;
  windowUnit?: 'h' | 'm';
  lateAsException: boolean;   // also list late / early leave as exceptions
  botReply: boolean;          // bot replies in the topic
  breakMinutes: number | null; // total break allowed per day, in minutes (null = no limit); applies to every shift
  breakUnit?: 'h' | 'm';      // how the admin entered it (display only)
  otHours: number;            // on-shift time (clock in → clock out) above this many hours is tagged OT on the roster
  /** no clock out this many minutes after the SCHEDULED shift end → the bot asks "Are you on OT?" (if bot replies are on).
   *  Shift 07:30–16:30 + 45 → asked at 17:15, however early or late the employee clocked in. */
  outAskMin: number;
  outAskUnit?: 'h' | 'm';     // how the admin entered it (display only; the value is always minutes)
  /** @deprecated replaced by outAskMin (was: hours after the clock in); kept only so old saved settings still parse */
  forgotOutHours?: number;
  forgotOutUnit?: 'h' | 'm';
  earlyAskMin: number;        // clock in at least this many minutes before the shift → the bot asks "Is this OT?" (0 = off)
  answerBy: 'any' | 'own';    // who may press the bot's buttons: anyone in the group, or only the employee
  /** roster codes / shift codes of days whose working hours are not checked (OT, ST …): the employee was not scheduled to work */
  noHoursCodes: string[];
}

/** Fixed thresholds (not user-editable; removed from the UI by request). */
export const FIXED = {
  missingInHours: 2,        // no clock-in this long after scheduled start → ABSENT / NO_SHOW
  breakNotEndedMin: 120,    // an open break older than this → BREAK_NOT_ENDED
  missingOutHours: 16,      // no clock out this long after clock in → MISSING_CLOCK_OUT
  otAnswerWaitMin: 120,     // an OT question still unanswered after this → OT_NO_ANSWER
  delayThresholdMin: 5,     // received_at − telegram time above this → DELAYED_DELIVERY
  openSessionMaxHours: 20,  // a BREAK/RESUME/OUT is attached to an open session started within this many hours
  shiftWindowHours: 4,      // a punch belongs to a shift from this long before its start to this long after its end;
                            // from this long before the start a missing clock in shows as NOT_CLOCKED_IN
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
export const DEFAULT_RULES: Rules = { lateAsException: false, botReply: true, otHours: 9, breakMinutes: 90, breakUnit: 'm', outAskMin: 45, earlyAskMin: 30, answerBy: 'any', noHoursCodes: ['OT', 'ST'] };

export const BIZ_TZ_DEFAULT = 'Asia/Colombo';

/** Roster code colors: [background, text]. 16 soft + 16 strong. A roster code stores the index. */
export const ROSTER_COLORS: [string, string][] = [
  ['#eef1f5', '#475569'], ['#fee2e2', '#b91c1c'], ['#ffedd5', '#c2410c'], ['#fef3c7', '#92400e'], ['#fef9c3', '#854d0e'], ['#ecfccb', '#4d7c0f'], ['#dcfce7', '#15803d'], ['#ccfbf1', '#0f766e'],
  ['#cffafe', '#0e7490'], ['#e0f2fe', '#0369a1'], ['#dbeafe', '#1d4ed8'], ['#e0e7ff', '#4338ca'], ['#ede9fe', '#6d28d9'], ['#f3e8ff', '#7e22ce'], ['#fce7f3', '#be185d'], ['#ffe4e6', '#be123c'],
  ['#475569', '#ffffff'], ['#dc2626', '#ffffff'], ['#ea580c', '#ffffff'], ['#d97706', '#ffffff'], ['#ca8a04', '#ffffff'], ['#65a30d', '#ffffff'], ['#16a34a', '#ffffff'], ['#0d9488', '#ffffff'],
  ['#0891b2', '#ffffff'], ['#0284c7', '#ffffff'], ['#2563eb', '#ffffff'], ['#4f46e5', '#ffffff'], ['#7c3aed', '#ffffff'], ['#9333ea', '#ffffff'], ['#db2777', '#ffffff'], ['#e11d48', '#ffffff'],
];
export interface RosterCode { code: string; name: string; color: number }

/** Answers to the bot's OT questions. EARLY: clocked in early (YES = OT / NO); LATE: no clock out after the set hours. */
export type OtAnswer = 'YES' | 'NO' | 'STILL' | 'OT' | 'FORGOT';
/** Answers to the "Incomplete working hours" question: YES = clock out confirmed, NO = clock out cancelled (still working),
 *  FORGOT_IN = the employee forgot to clock in (an exception for the admin to approve). */
export type HoursAnswer = 'YES' | 'NO' | 'FORGOT_IN';

/** Texts of the bot's OT questions (Settings → Bot messages). {name} {shift} {in} {hours} {out} are filled in. */
export interface BotTexts {
  earlyQ: string; earlyYes: string; earlyNo: string; earlyRYes: string; earlyRNo: string;
  lateQ: string; lateStill: string; lateOt: string; lateForgot: string; lateRStill: string; lateROt: string; lateRForgot: string;
  change: string; notYou: string;
  /** reply to a punch sent with Telegram's "Schedule message" (it is not counted) */
  scheduled: string;
  /** the question sent with the clock-out confirmation when the shift length was not completed (breaks included;
   *  late → counted from the clock in). {worked} counted time · {need} shift length · {until} required clock out · {short} missing time */
  incomplete: string; incYes: string; incNo: string; incForgot: string; incRYes: string; incRNo: string; incRForgot: string;
  /** pop-up when "No" is changed after the employee has already clocked out again */
  incClockedAgain: string;
}

/** Which automatic bot messages are sent (Settings → Bot messages). Detection and exceptions do not depend on these. */
export interface BotSwitches { early: boolean; late: boolean; scheduled: boolean; incomplete: boolean }
export const DEFAULT_BOT_SWITCHES: BotSwitches = { early: true, late: true, scheduled: true, incomplete: true };
export const DEFAULT_BOT_TEXTS: BotTexts = {
  earlyQ: '⏰ Your shift is {shift}, but you clocked in early at {in}. Is this OT?',
  earlyYes: 'Yes', earlyNo: 'No',
  earlyRYes: '✅ Recorded as OT from {in}. Have a good shift!',
  earlyRNo: '✅ Recorded. Your clock in is {in}. Have a good shift!',
  lateQ: '⏰ Your shift is {shift}. You clocked in at {in} and have not clocked out for {hours}. Are you on OT?',
  lateStill: 'Still on working', lateOt: 'Yes, OT', lateForgot: 'Forgot clock out',
  lateRStill: 'OK, thank you for your response. Have a nice evening!',
  lateROt: 'OK, please clock out again when your OT ends. Good luck with your work!',
  lateRForgot: '✅ Recorded: CS forgot clock out — time {out}.',
  change: 'Change answer', notYou: 'This button is not for you',
  scheduled: '⚠️ 定时发送的消息不计入打卡，请本人即时打卡。谢谢',
  incomplete: '⚠️ Incomplete working hours: your shift today is {shift} — {need} including breaks. You worked {worked}. You should clock out at {until} — {short} short.\nDo you want to clock out now?',
  incYes: 'Yes', incNo: 'No', incForgot: 'Forgot clock in',
  incRYes: '✅ Clock out confirmed at {out}. Incomplete working hours recorded.',
  incRNo: '↩️ Clock out at {out} cancelled. Please continue working and clock out again at {until}.',
  incRForgot: '📝 Noted: forgot clock in. An admin will check and correct your clock-in time.',
  incClockedAgain: 'You have clocked out again since then — this answer can no longer be changed.',
};
