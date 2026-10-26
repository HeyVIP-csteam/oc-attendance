// The three HTML reports (Attendance, Breaks, Reports): fetch the chosen range, shape the rows, download the page.
import { DEFAULT_BOT_TEXTS, EVENT_LABEL, type EventType, exceptionSeverity, STATUSES } from '../../../src/shared/codes';
import { exLabel } from '../components/ui';
import { parseBi } from './i18n';
import { rulesOf } from './store';
import type { ExportRange } from '../components/ExportHtml';
import { api, qs } from './api';
import { fmtDT, fmtDur, fmtMin, fmtT } from './format';
import type { Bi } from '../../../src/shared/codes';
import { downloadHtmlReport, type ReportCfg, type DrawerData, type Seg } from './htmlReport';
import type { Meta } from './store';

type L = (zh: string, en: string) => string;
interface Ctx { L: L; dt: (b: Bi) => string; meta: Meta }


function common(x: Ctx, q: ExportRange, title: string, kind: string): Pick<ReportCfg, 'title' | 'file' | 'brand' | 'brandSub' | 'meta' | 'searchLabel' | 'searchPh' | 't'> {
  const { L } = x;
  const emp = q.emp ? x.meta.employees.find((e) => e.id === q.emp) : undefined;
  return {
    title: emp ? `${title} · ${emp.name} (${emp.code})` : title, brand: 'OC Attendance', brandSub: 'Outsource CS Attendance',
    file: `${kind}_${emp ? emp.code + '_' : q.cur ? q.cur + '_' : ''}${q.from === q.to ? q.from : `${q.from}_${q.to}`}.html`,
    meta: [[L('期间', 'Period'), `${q.from} → ${q.to}`], [L('货币', 'Currency'), (emp ? emp.currency : q.cur) || L('全部货币', 'All currencies')],
      [L('导出', 'Exported'), `${fmtDT(Date.now()).slice(0, 16)} (${L('斯里兰卡时间', 'Sri Lanka time')}) · ${x.meta.user.username}`]],
    searchLabel: L('搜索', 'Search'), searchPh: L('姓名或 PSD ID', 'Name or PSD ID'),
    t: { reset: L('重置', 'Reset'), print: L('打印', 'Print'), of: '/', rows: L('行', 'rows'), none: L('没有记录', 'No records') },
  };
}
const foot = (L: L) => L('时间为斯里兰卡时间 (UTC+05:30) · 迟到 / 早退 = 超过宽限后，从排班时间起算的完整分钟 · 时长以小时和分钟表示',
  'Times are Sri Lanka time (UTC+05:30) · Late / Early = full minutes from the scheduled time once past the grace · Durations in hours and minutes');

interface AttRowX { employee_code: string; name: string; currency_code: string | null; work_date: string; shift_name: string | null; mark_code?: string | null; scheduled_start_at: number | null; actual_in_at: number | null; late_min: number | null;
  scheduled_end_at: number | null; actual_out_at: number | null; early_min: number | null; break_count: number; open_break_count: number; total_break_ms: number; net_worked_ms: number | null; shift_duration_ms?: number | null; status: string; missing: string; exception_count: number;
  session_id: number; break_exceeded: number | null; ot_ms?: number | null; ot_day?: number }

function statusOf(x: Ctx, r: Pick<AttRowX, 'status' | 'mark_code'>): [string, string] {
  if (r.status === 'NO_SCHEDULE' && r.mark_code) {
    const name = (x.meta.rosterCodes ?? []).find((c) => c.code === r.mark_code)?.name;
    return [name ? `${r.mark_code} · ${name}` : r.mark_code, 'v'];
  }
  const s = (STATUSES as Record<string, { label: Bi; cls: string }>)[r.status];
  return [s ? x.dt(s.label) : r.status, s?.cls === 'i' ? 'i' : s?.cls ?? ''];
}
const shiftOf = (x: Ctx, r: Pick<AttRowX, 'shift_name' | 'mark_code'>) => r.shift_name ?? (r.mark_code ? r.mark_code : x.L('未排班', 'No schedule'));

// ---------------------------------------------------------------- the session popup inside the attendance report
interface DEv { session_id: number; id: number; event_type: EventType; event_ts: number; source: string; is_voided: number; sm_result: string | null; raw_text: string | null; raw_source: string | null;
  raw_received_at: number | null; telegram_message_ts: number | null; adj_reason: string | null; adj_target: number | null }
interface Detail {
  events: DEv[]; breaks: (BreakX & { remark: string | null })[]; exceptions: { session_id: number; code: string; detail: string | null; occurred_at: number }[];
  otMarks: { session_id: number; note: string | null; created_by: string; created_at: number }[];
  otQuestions: { session_id: number; kind: string; asked_at: number; answer: string | null; answered_by: string | null; answered_at: number | null }[];
  quotas: { session_id: number; break_minutes: number | null }[];
}
const EV_DOT: Record<EventType, string> = { CLOCK_IN: 'd-in', BREAK_START: 'd-bs', BREAK_END: 'd-be', CLOCK_OUT: 'd-out' };
const WD_ZH = '日一二三四五六', WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function group<T extends { session_id: number }>(list: T[]): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const v of list) { const g = m.get(v.session_id); if (g) g.push(v); else m.set(v.session_id, [v]); }
  return m;
}

function drawerOf(x: Ctx, a: AttRowX, d: Detail, g: { ev: Map<number, DEv[]>; br: Map<number, Detail['breaks']>; ex: Map<number, Detail['exceptions']>;
  om: Map<number, Detail['otMarks']>; oq: Map<number, Detail['otQuestions']>; qu: Map<number, Detail['quotas']> }, st: [string, string]): DrawerData {
  const { L, dt, meta } = x;
  const en = L('zh', 'en') === 'en';
  const id = a.session_id, date = a.work_date;
  const hm = (ms: number | null | undefined) => (ms == null ? null : fmtDT(ms).slice(11, 16));
  const hms = (ms: number) => fmtDT(ms).slice(11, 19);
  const wdN = new Date(`${date}T00:00:00Z`).getUTCDay();
  const wd = en ? WD_EN[wdN] : `（${WD_ZH[wdN]}）`;
  const ev = g.ev.get(id) ?? [], br = g.br.get(id) ?? [], ex = g.ex.get(id) ?? [], om = g.om.get(id)?.[0], oq = g.oq.get(id) ?? [];
  const quota = (() => { const r = rulesOf(meta, a.currency_code); return r.breakMinutes !== undefined ? r.breakMinutes : g.qu.get(id)?.[0]?.break_minutes ?? null; })();
  const edited = new Set(ev.filter((e) => e.adj_target).map((e) => e.adj_target!));
  const live = ev.filter((e) => !e.is_voided).length, gone = ev.length - live;
  const lateS: Seg = a.actual_in_at == null ? ['—', 'b'] : a.late_min ? [fmtMin(a.late_min), 'r'] : [L('准时', 'On time'), 'b'];
  const earlyS: Seg = a.actual_out_at == null ? ['—', 'b'] : a.early_min ? [fmtMin(a.early_min), 'r'] : [L('准时', 'On time'), 'b'];
  const brOk = a.break_exceeded == null ? null : !a.break_exceeded;
  const t = { ...DEFAULT_BOT_TEXTS, ...(meta.botTexts ?? {}) };
  const shift = a.shift_name ? `${a.shift_name} · ${hm(a.scheduled_start_at) ?? '—'} – ${hm(a.scheduled_end_at) ?? '—'}` : shiftOf(x, a);
  const sevC = (c: string) => { const v = exceptionSeverity(c); return v === 'HIGH' ? 'r' : v === 'MEDIUM' ? 'w' : ''; };
  return {
    av: a.name.split(/[\s\-_.]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?',
    nm: a.name, id: a.employee_code,
    meta: [[L('考勤日', 'Work date'), date + wd], ...(a.currency_code ? [[L('货币', 'Currency'), a.currency_code] as [string, string]] : []), [L('班次', 'Shift'), shift], [L('斯里兰卡时间', 'Sri Lanka time'), '']],
    st,
    sum: [
      { l: L('上班', 'Clock in'), v: hm(a.actual_in_at), sub: [[L('排班', 'Scheduled') + ' ', ''], [hm(a.scheduled_start_at) ?? '—', 'b'], [' · ' + L('迟到', 'Late') + ' ', ''], lateS] },
      { l: L('下班', 'Clock out'), v: hm(a.actual_out_at), sub: [[L('排班', 'Scheduled') + ' ', ''], [hm(a.scheduled_end_at) ?? '—', 'b'], [' · ' + L('早退', 'Early') + ' ', ''], earlyS] },
      { l: L('休息', 'Breaks'), tag: brOk == null ? undefined : brOk ? [L('符合规则', 'Within rule'), 'ok'] : [L('超出额度', 'Over limit'), 'w'], v: fmtDur(a.total_break_ms ?? 0),
        sub: [[L('共 ', ''), ''], [String(a.break_count ?? 0), 'b'], [' ' + L('次', 'breaks'), ''], ...(a.open_break_count ? [[' · ', ''], [L(`${a.open_break_count} 次未结束`, `${a.open_break_count} open`), 'r']] as Seg[] : []),
          [' · ' + L('额度', 'Limit') + ' ', ''], [quota != null ? `${quota}m` : L('不限', 'none'), 'b']] },
      { l: L('净工时', 'Net worked'), v: a.net_worked_ms == null ? null : fmtDur(a.net_worked_ms), dash: true,
        sub: a.net_worked_ms == null ? [[L('缺少上班或下班卡', 'Clock in or out missing'), '']]
          : [[L('在班', 'On shift') + ' ', ''], [fmtDur(a.shift_duration_ms ?? 0), 'b'], [' − ' + L('休息', 'breaks') + ' ', ''], [fmtDur(a.total_break_ms), 'b']] },
    ],
    evh: L(`按 Telegram 消息时间排序 · 共 ${live} 笔`, `By Telegram message time · ${live} punches`) + (gone ? L(`（已删除 / 已修改 ${gone}）`, ` (${gone} deleted / edited)`) : ''),
    ev: ev.map((e) => {
      const imported = e.raw_source === 'IMPORT';
      const delay = !imported && e.raw_received_at && e.telegram_message_ts ? e.raw_received_at - e.telegram_message_ts : 0;
      const od = fmtDT(e.event_ts).slice(0, 10);
      const tags: Seg[] = e.is_voided ? [[edited.has(e.id) ? L('已修改', 'Edited') : L('已删除', 'Deleted'), '']]
        : e.sm_result ? [[dt(exLabel(e.sm_result)), sevC(e.sm_result)]] : [[L('已记录', 'Recorded'), 'ok']];
      if (!e.is_voided && delay > 5 * 60000) tags.push([`${L('延迟', 'Delay')} ${fmtDur(delay)}`, 'w']);
      if (imported) tags.push([L('导入', 'Imported'), 'i']);
      return { t: hms(e.event_ts), od: od !== date ? od : null, a: dt(EVENT_LABEL[e.event_type]), dot: EV_DOT[e.event_type], vd: !!e.is_voided,
        msg: e.source === 'TELEGRAM' ? (e.raw_text ?? '—') : null, adm: e.source === 'TELEGRAM' ? null : e.adj_target ? L('管理员修改', 'Edited by admin') : L('管理员补录', 'Added by admin'),
        rs: e.adj_reason, tags };
    }),
    ot: !om && !oq.length ? null : {
      h: om || (a.ot_ms ?? 0) > 0 || a.ot_day ? L('OT · 算 1 次', 'OT · counts as 1') : L('不计 OT', 'No OT'),
      mark: om ? [L(`排班表手动标记 · ${om.created_by}`, `Marked by hand on the roster · ${om.created_by}`) + (om.note ? ` · ${om.note}` : ''), fmtDT(om.created_at).slice(0, 16)] : null,
      q: oq.map((o) => {
        const lab = o.answer ? ({ YES: t.earlyYes, NO: t.earlyNo, STILL: t.lateStill, OT: t.lateOt, FORGOT: t.lateForgot } as Record<string, string>)[o.answer] ?? o.answer : null;
        return [o.kind === 'EARLY' ? (a.scheduled_start_at != null ? L('提早上班', 'Early clock in') : L('休假日上班', 'Day off clock in')) : L('超时未下班', 'No clock out'), fmtT(o.asked_at), lab ?? L('未回答', 'No answer'),
          !lab ? '' : o.answer === 'YES' || o.answer === 'OT' ? 'w' : o.answer === 'FORGOT' ? 'r' : 'ok', o.answered_by ?? '—', o.answered_at ? fmtT(o.answered_at) : '—'];
      }),
    },
    brh: `${L('合计', 'Total')} ${fmtDur(a.total_break_ms ?? 0)}`,
    br: br.map((b) => [String(b.seq), b.remark ?? '—', hm(b.start_at) ?? '—', b.end_at ? hm(b.end_at) : null, b.end_at ? fmtDur(b.duration_ms) : '—']),
    exh: L(`${ex.length} 项`, `${ex.length}`),
    ex: ex.map((v) => { const p = v.detail ? parseBi(v.detail) : null; return [dt(exLabel(v.code)), sevC(v.code), p ? (typeof p === 'string' ? p : dt(p)) : '', hms(v.occurred_at)]; }),
  };
}

export async function exportAttendance(x: Ctx, q: ExportRange): Promise<number> {
  const { L } = x;
  const r = await api<{ rows: AttRowX[]; detail?: Detail }>(`/attendance/export?${qs({ ...q })}`);
  const d = r.detail;
  const g = d && { ev: group(d.events), br: group(d.breaks), ex: group(d.exceptions), om: group(d.otMarks), oq: group(d.otQuestions), qu: group(d.quotas) };
  const rows = r.rows.map((a) => {
    const [st, stc] = statusOf(x, a);
    return { _x: d && g ? drawerOf(x, a, d, g, [st, stc]) : undefined, code: a.employee_code, name: a.name, cur: a.currency_code, d: a.work_date, shift: shiftOf(x, a), si: a.scheduled_start_at ? fmtT(a.scheduled_start_at) : null, ai: a.actual_in_at ? fmtT(a.actual_in_at) : null,
      late: a.late_min, so: a.scheduled_end_at ? fmtT(a.scheduled_end_at) : null, ao: a.actual_out_at ? fmtT(a.actual_out_at) : null, early: a.early_min,
      br: a.break_count + a.open_break_count, bt: a.total_break_ms, net: a.net_worked_ms, ot: a.ot_day ? 'OT' : null, ot_c: 'r', st, st_c: stc, sk: a.status, miss: a.missing, ex: a.exception_count };
  });
  downloadHtmlReport({
    ...common(x, q, L('考勤报表', 'Attendance report'), 'attendance'),
    cols: [{ k: 'code', label: 'PSD ID', t: 'pid' }, { k: 'name', label: L('员工姓名', 'Employee Name') }, { k: 'cur', label: L('货币', 'Currency'), t: 'cur' }, { k: 'd', label: L('日期', 'Date') },
      { k: 'shift', label: L('班次', 'Shift') }, { k: 'si', label: L('排班上班', 'Sched In') }, { k: 'ai', label: L('实际上班', 'Actual In') }, { k: 'late', label: L('迟到', 'Late'), t: 'min' },
      { k: 'so', label: L('排班下班', 'Sched Out') }, { k: 'ao', label: L('实际下班', 'Actual Out') }, { k: 'early', label: L('早退', 'Early'), t: 'min' }, { k: 'br', label: L('休息', 'Breaks'), t: 'num' },
      { k: 'bt', label: L('休息总计', 'Break Total'), t: 'dur' }, { k: 'net', label: L('净工时', 'Net Worked'), t: 'dur' }, { k: 'ot', label: 'OT', t: 'badge' }, { k: 'st', label: L('状态', 'Status'), t: 'badge' }, { k: 'ex', label: L('异常', 'Exceptions'), t: 'num' }],
    rows, search: ['code', 'name'],
    filters: [{ k: 'd', label: L('日期', 'Date'), all: L('全部日期', 'All dates'), desc: true }, { k: 'cur', label: L('货币', 'Currency'), all: L('全部货币', 'All currencies') },
      { k: 'shift', label: L('班次', 'Shift'), all: L('全部班次', 'All shifts') }, { k: 'st', label: L('状态', 'Status'), all: L('全部状态', 'All statuses') }],
    kpis: [
      { label: L('记录', 'Records'), value: { op: 'count' }, sub: { agg: { op: 'distinct', f: 'code' }, tpl: L('{} 位员工', '{} employees') } },
      { label: L('迟到', 'Late'), cls: 'w', value: { op: 'count', where: ['late', '>', 0] }, sub: { agg: { op: 'sum', f: 'late', fmt: 'min' }, tpl: L('合计 {}', '{} total') }, click: ['late', '>', 0] },
      { label: L('早退', 'Early leave'), cls: 'w', value: { op: 'count', where: ['early', '>', 0] }, sub: { agg: { op: 'sum', f: 'early', fmt: 'min' }, tpl: L('合计 {}', '{} total') }, click: ['early', '>', 0] },
      { label: L('缺勤', 'Absent'), cls: 'r', value: { op: 'count', where: ['sk', '=', 'ABSENT'] }, sub: { tpl: L('没有上班打卡', 'no clock in') }, click: ['sk', '=', 'ABSENT'] },
      { label: L('缺卡', 'Missing punch'), cls: 'r', value: { op: 'count', where: ['miss', '!=', 'NONE'] }, sub: { tpl: L('数据不完整', 'incomplete') }, click: ['miss', '!=', 'NONE'] },
      { label: L('净工时', 'Net worked'), cls: 'g', value: { op: 'sum', f: 'net', fmt: 'dur' }, sub: { agg: { op: 'avg', f: 'net', fmt: 'dur' }, tpl: L('平均 {} / 天', 'avg {} / day') } },
      { label: L('OT（次）', 'OT (times)'), cls: 'w', value: { op: 'count', where: ['ot', '=', 'OT'] }, sub: { agg: { op: 'distinct', f: 'code', where: ['ot', '=', 'OT'] }, tpl: L('{} 位员工', '{} employees') }, click: ['ot', '=', 'OT'] },
    ],
    sort: { k: 'd', dir: -1 }, foot: foot(L),
    drawer: d ? { close: L('关闭', 'Close'), punch: L('打卡记录', 'Punch records'), time: L('时间', 'Time'), action: L('动作', 'Action'), msg: L('员工消息', 'Message'), status: L('状态', 'Status'),
      breaks: L('休息明细', 'Breaks'), remark: L('备注', 'Remark'), dur: L('时长', 'Duration'), exc: L('异常', 'Exceptions'), noEx: L('无异常', 'No exceptions'), noPunch: L('没有打卡记录', 'No punches'),
      noBreaks: L('没有休息', 'No breaks'), open: L('未结束', 'Open'), missing: L('未打卡', 'Missing'), q: L('问题', 'Question'), asked: L('发送时间', 'Asked'), ans: L('回答', 'Answer'),
      by: L('回答人', 'Answered by'), at: L('回答时间', 'Answered at'), ro: L('导出时的数据（只读）· 要修改请到后台', 'Data as exported (read only) · make changes in the dashboard'),
      hint: L('点击任一行查看当天明细', 'Click a row to see that day in detail') } : undefined,
  });
  return rows.length;
}

interface BreakX { session_id: number; seq: number; start_at: number; end_at: number | null; duration_ms: number | null; status: string; remark: string | null }

export async function exportBreaks(x: Ctx, q: ExportRange): Promise<number> {
  const { L } = x;
  const r = await api<{ rows: AttRowX[]; breaks: BreakX[] }>(`/breaks/export?${qs({ ...q })}`);
  const bySession = new Map(r.rows.map((a) => [a.session_id, a]));
  const yes = L('是', 'Yes'), no = L('否', 'No');
  const rows = r.breaks.filter((b) => bySession.has(b.session_id)).map((b) => {
    const a = bySession.get(b.session_id)!;
    const open = b.status === 'OPEN';
    return { code: a.employee_code, name: a.name, cur: a.currency_code, d: a.work_date, shift: shiftOf(x, a), sid: a.session_id, no: `#${b.seq}`, rm: b.remark,
      s: fmtT(b.start_at), e: b.end_at ? fmtT(b.end_at) : null, dur: b.duration_ms, bs: open ? L('未结束', 'Open') : L('已结束', 'Closed'), bs_c: open ? 'r' : 'ok', bk: open ? 'OPEN' : 'CLOSED',
      day: a.total_break_ms, ov: a.break_exceeded == null ? null : a.break_exceeded ? yes : no, ov_c: a.break_exceeded ? 'w' : 'ok', ovk: a.break_exceeded ? 1 : 0 };
  });
  downloadHtmlReport({
    ...common(x, q, L('休息报表', 'Breaks report'), 'breaks'),
    cols: [{ k: 'code', label: 'PSD ID', t: 'pid' }, { k: 'name', label: L('员工姓名', 'Employee Name') }, { k: 'cur', label: L('货币', 'Currency'), t: 'cur' }, { k: 'd', label: L('日期', 'Date') },
      { k: 'shift', label: L('班次', 'Shift') }, { k: 'no', label: L('休息', 'Break') }, { k: 'rm', label: L('员工消息', 'Remark'), t: 'text' }, { k: 's', label: L('开始', 'Start') }, { k: 'e', label: L('结束', 'End') },
      { k: 'dur', label: L('时长', 'Duration'), t: 'dur' }, { k: 'bs', label: L('状态', 'Status'), t: 'badge' }, { k: 'day', label: L('当日休息总时长', 'Total Daily Break'), t: 'dur' }, { k: 'ov', label: L('超出', 'Exceeded'), t: 'badge' }],
    rows, search: ['code', 'name'],
    filters: [{ k: 'd', label: L('日期', 'Date'), all: L('全部日期', 'All dates'), desc: true }, { k: 'cur', label: L('货币', 'Currency'), all: L('全部货币', 'All currencies') },
      { k: 'shift', label: L('班次', 'Shift'), all: L('全部班次', 'All shifts') }, { k: 'bs', label: L('状态', 'Status'), all: L('全部状态', 'All statuses') }],
    kpis: [
      { label: L('休息次数', 'Breaks'), value: { op: 'count' }, sub: { agg: { op: 'distinct', f: 'code' }, tpl: L('{} 位员工', '{} employees') } },
      { label: L('休息总时长', 'Total break time'), value: { op: 'sum', f: 'dur', fmt: 'dur' }, sub: { agg: { op: 'avg', f: 'dur', fmt: 'dur' }, tpl: L('平均每次 {}', 'avg {} per break') } },
      { label: L('未结束', 'Open breaks'), cls: 'r', value: { op: 'count', where: ['bk', '=', 'OPEN'] }, sub: { tpl: L('没有 Resume', 'no break end') }, click: ['bk', '=', 'OPEN'] },
      { label: L('超出休息时间', 'Over the limit'), cls: 'w', value: { op: 'distinct', f: 'sid', where: ['ovk', '=', 1] }, sub: { tpl: L('天', 'days') }, click: ['ovk', '=', 1] },
    ],
    sort: { k: 'd', dir: -1 }, foot: foot(L),
  });
  return rows.length;
}

interface SumX { employee_code: string; name: string; currency_code: string | null; scheduled: number; present: number; absent: number; late_times: number; late_min: number; early_times: number; early_min: number; breaks: number; break_ms: number; shift_ms: number; ot_times?: number | null; exceptions: number }

export async function exportReports(x: Ctx, q: ExportRange): Promise<number> {
  const { L } = x;
  const r = await api<{ rows: SumX[] }>(`/reports/export?${qs({ ...q })}`);
  const n = (v: number | null | undefined) => v ?? 0;
  const rows = r.rows.map((a) => ({ code: a.employee_code, name: a.name, cur: a.currency_code, sch: n(a.scheduled), pre: n(a.present), abs: n(a.absent), lt: n(a.late_times), lm: n(a.late_min),
    et: n(a.early_times), em: n(a.early_min), br: n(a.breaks), bm: n(a.break_ms), sm: n(a.shift_ms), ot: n(a.ot_times), ex: n(a.exceptions) }));
  downloadHtmlReport({
    ...common(x, q, L('考勤汇总报表', 'Attendance summary'), 'report'),
    cols: [{ k: 'code', label: 'PSD ID', t: 'pid' }, { k: 'name', label: L('员工姓名', 'Employee Name') }, { k: 'cur', label: L('货币', 'Currency'), t: 'cur' }, { k: 'sch', label: L('排班', 'Scheduled'), t: 'num' },
      { k: 'pre', label: L('出勤', 'Present'), t: 'num' }, { k: 'abs', label: L('缺勤', 'Absent'), t: 'red' }, { k: 'lt', label: L('迟到次数', 'Late (times)'), t: 'red' }, { k: 'lm', label: L('迟到时长', 'Late (time)'), t: 'min' },
      { k: 'et', label: L('早退次数', 'Early (times)'), t: 'red' }, { k: 'em', label: L('早退时长', 'Early (time)'), t: 'min' }, { k: 'br', label: L('休息次数', 'Breaks'), t: 'num' },
      { k: 'bm', label: L('休息总时长', 'Total Break'), t: 'dur' }, { k: 'sm', label: L('总工时', 'Total Shift'), t: 'dur' }, { k: 'ot', label: L('OT（次）', 'OT (times)'), t: 'num' }, { k: 'ex', label: L('异常数', 'Exceptions'), t: 'num' }],
    rows, search: ['code', 'name'],
    filters: [{ k: 'cur', label: L('货币', 'Currency'), all: L('全部货币', 'All currencies') }],
    kpis: [
      { label: L('员工', 'Employees'), value: { op: 'count' }, sub: { agg: { op: 'sum', f: 'sch' }, tpl: L('{} 个排班', '{} scheduled shifts') } },
      { label: L('出勤', 'Present'), cls: 'g', value: { op: 'sum', f: 'pre' }, sub: { tpl: L('天', 'days') } },
      { label: L('缺勤', 'Absent'), cls: 'r', value: { op: 'sum', f: 'abs' }, sub: { tpl: L('天', 'days') }, click: ['abs', '>', 0] },
      { label: L('迟到', 'Late'), cls: 'w', value: { op: 'sum', f: 'lt' }, sub: { agg: { op: 'sum', f: 'lm', fmt: 'min' }, tpl: L('合计 {}', '{} total') }, click: ['lt', '>', 0] },
      { label: L('早退', 'Early leave'), cls: 'w', value: { op: 'sum', f: 'et' }, sub: { agg: { op: 'sum', f: 'em', fmt: 'min' }, tpl: L('合计 {}', '{} total') }, click: ['et', '>', 0] },
      { label: L('总工时', 'Total shift'), value: { op: 'sum', f: 'sm', fmt: 'dur' }, sub: { agg: { op: 'sum', f: 'bm', fmt: 'dur' }, tpl: L('休息 {}', 'breaks {}') } },
      { label: L('OT（次）', 'OT (times)'), cls: 'w', value: { op: 'sum', f: 'ot' }, sub: { agg: { op: 'count', where: ['ot', '>', 0] }, tpl: L('{} 位员工', '{} employees') }, click: ['ot', '>', 0] },
    ],
    sort: { k: 'code', dir: 1 }, foot: foot(L),
  });
  return rows.length;
}
