// The three HTML reports (Attendance, Breaks, Reports): fetch the chosen range, shape the rows, download the page.
import { STATUSES } from '../../../src/shared/codes';
import type { ExportRange } from '../components/ExportHtml';
import { api, qs } from './api';
import { fmtDT, fmtT } from './format';
import type { Bi } from '../../../src/shared/codes';
import { downloadHtmlReport, type ReportCfg } from './htmlReport';
import type { Meta } from './store';

type L = (zh: string, en: string) => string;
interface Ctx { L: L; dt: (b: Bi) => string; meta: Meta }

const count = async (path: string, q: ExportRange) => (await api<{ total: number }>(`${path}?${qs({ ...q, page: 1, size: 10 })}`)).total;
export const countAttendance = (q: ExportRange) => count('/attendance', q);
export const countBreaks = (q: ExportRange) => count('/breaks', q);
export const countReports = (q: ExportRange) => count('/reports', q);

function common(x: Ctx, q: ExportRange, title: string, kind: string): Pick<ReportCfg, 'title' | 'file' | 'brand' | 'brandSub' | 'meta' | 'searchLabel' | 'searchPh' | 't'> {
  const { L } = x;
  return {
    title, brand: 'OC Attendance', brandSub: 'Outsource CS Attendance',
    file: `${kind}_${q.cur ? q.cur + '_' : ''}${q.from}_${q.to}.html`,
    meta: [[L('期间', 'Period'), `${q.from} → ${q.to}`], [L('货币', 'Currency'), q.cur || L('全部货币', 'All currencies')],
      [L('导出', 'Exported'), `${fmtDT(Date.now()).slice(0, 16)} (${L('斯里兰卡时间', 'Sri Lanka time')}) · ${x.meta.user.username}`]],
    searchLabel: L('搜索', 'Search'), searchPh: L('姓名或 PSD ID', 'Name or PSD ID'),
    t: { reset: L('重置', 'Reset'), print: L('打印', 'Print'), of: '/', rows: L('行', 'rows'), none: L('没有记录', 'No records') },
  };
}
const foot = (L: L) => L('时间为斯里兰卡时间 (UTC+05:30) · 迟到 / 早退 = 超过宽限后，从排班时间起算的完整分钟 · 时长以小时和分钟表示',
  'Times are Sri Lanka time (UTC+05:30) · Late / Early = full minutes from the scheduled time once past the grace · Durations in hours and minutes');

interface AttRowX { employee_code: string; name: string; currency_code: string | null; work_date: string; shift_name: string | null; mark_code?: string | null; scheduled_start_at: number | null; actual_in_at: number | null; late_min: number | null;
  scheduled_end_at: number | null; actual_out_at: number | null; early_min: number | null; break_count: number; open_break_count: number; total_break_ms: number; net_worked_ms: number | null; status: string; missing: string; exception_count: number;
  session_id: number; break_exceeded: number | null; ot_ms?: number | null }

function statusOf(x: Ctx, r: Pick<AttRowX, 'status' | 'mark_code'>): [string, string] {
  if (r.status === 'NO_SCHEDULE' && r.mark_code) {
    const name = (x.meta.rosterCodes ?? []).find((c) => c.code === r.mark_code)?.name;
    return [name ? `${r.mark_code} · ${name}` : r.mark_code, 'v'];
  }
  const s = (STATUSES as Record<string, { label: Bi; cls: string }>)[r.status];
  return [s ? x.dt(s.label) : r.status, s?.cls === 'i' ? 'i' : s?.cls ?? ''];
}
const shiftOf = (x: Ctx, r: Pick<AttRowX, 'shift_name' | 'mark_code'>) => r.shift_name ?? (r.mark_code ? r.mark_code : x.L('未排班', 'No schedule'));

export async function exportAttendance(x: Ctx, q: ExportRange): Promise<number> {
  const { L } = x;
  const r = await api<{ rows: AttRowX[] }>(`/attendance/export?${qs({ ...q })}`);
  const rows = r.rows.map((a) => {
    const [st, stc] = statusOf(x, a);
    return { code: a.employee_code, name: a.name, cur: a.currency_code, d: a.work_date, shift: shiftOf(x, a), si: a.scheduled_start_at ? fmtT(a.scheduled_start_at) : null, ai: a.actual_in_at ? fmtT(a.actual_in_at) : null,
      late: a.late_min, so: a.scheduled_end_at ? fmtT(a.scheduled_end_at) : null, ao: a.actual_out_at ? fmtT(a.actual_out_at) : null, early: a.early_min,
      br: a.break_count + a.open_break_count, bt: a.total_break_ms, net: a.net_worked_ms, ot: a.ot_ms || null, st, st_c: stc, sk: a.status, miss: a.missing, ex: a.exception_count };
  });
  downloadHtmlReport({
    ...common(x, q, L('考勤报表', 'Attendance report'), 'attendance'),
    cols: [{ k: 'code', label: 'PSD ID', t: 'pid' }, { k: 'name', label: L('员工姓名', 'Employee Name') }, { k: 'cur', label: L('货币', 'Currency'), t: 'cur' }, { k: 'd', label: L('日期', 'Date') },
      { k: 'shift', label: L('班次', 'Shift') }, { k: 'si', label: L('排班上班', 'Sched In') }, { k: 'ai', label: L('实际上班', 'Actual In') }, { k: 'late', label: L('迟到', 'Late'), t: 'min' },
      { k: 'so', label: L('排班下班', 'Sched Out') }, { k: 'ao', label: L('实际下班', 'Actual Out') }, { k: 'early', label: L('早退', 'Early'), t: 'min' }, { k: 'br', label: L('休息', 'Breaks'), t: 'num' },
      { k: 'bt', label: L('休息总计', 'Break Total'), t: 'dur' }, { k: 'net', label: L('净工时', 'Net Worked'), t: 'dur' }, { k: 'ot', label: 'OT', t: 'dur' }, { k: 'st', label: L('状态', 'Status'), t: 'badge' }, { k: 'ex', label: L('异常', 'Exceptions'), t: 'num' }],
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
      { label: 'OT', cls: 'w', value: { op: 'sum', f: 'ot', fmt: 'dur' }, sub: { agg: { op: 'count', where: ['ot', '>', 0] }, tpl: L('{} 天', '{} days') }, click: ['ot', '>', 0] },
    ],
    sort: { k: 'd', dir: -1 }, foot: foot(L),
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

interface SumX { employee_code: string; name: string; currency_code: string | null; scheduled: number; present: number; absent: number; late_times: number; late_min: number; early_times: number; early_min: number; breaks: number; break_ms: number; shift_ms: number; ot_ms?: number | null; exceptions: number }

export async function exportReports(x: Ctx, q: ExportRange): Promise<number> {
  const { L } = x;
  const r = await api<{ rows: SumX[] }>(`/reports/export?${qs({ ...q })}`);
  const n = (v: number | null | undefined) => v ?? 0;
  const rows = r.rows.map((a) => ({ code: a.employee_code, name: a.name, cur: a.currency_code, sch: n(a.scheduled), pre: n(a.present), abs: n(a.absent), lt: n(a.late_times), lm: n(a.late_min),
    et: n(a.early_times), em: n(a.early_min), br: n(a.breaks), bm: n(a.break_ms), sm: n(a.shift_ms), ot: n(a.ot_ms), ex: n(a.exceptions) }));
  downloadHtmlReport({
    ...common(x, q, L('考勤汇总报表', 'Attendance summary'), 'report'),
    cols: [{ k: 'code', label: 'PSD ID', t: 'pid' }, { k: 'name', label: L('员工姓名', 'Employee Name') }, { k: 'cur', label: L('货币', 'Currency'), t: 'cur' }, { k: 'sch', label: L('排班', 'Scheduled'), t: 'num' },
      { k: 'pre', label: L('出勤', 'Present'), t: 'num' }, { k: 'abs', label: L('缺勤', 'Absent'), t: 'red' }, { k: 'lt', label: L('迟到次数', 'Late (times)'), t: 'red' }, { k: 'lm', label: L('迟到时长', 'Late (time)'), t: 'min' },
      { k: 'et', label: L('早退次数', 'Early (times)'), t: 'red' }, { k: 'em', label: L('早退时长', 'Early (time)'), t: 'min' }, { k: 'br', label: L('休息次数', 'Breaks'), t: 'num' },
      { k: 'bm', label: L('休息总时长', 'Total Break'), t: 'dur' }, { k: 'sm', label: L('总工时', 'Total Shift'), t: 'dur' }, { k: 'ot', label: 'OT', t: 'dur' }, { k: 'ex', label: L('异常数', 'Exceptions'), t: 'num' }],
    rows, search: ['code', 'name'],
    filters: [{ k: 'cur', label: L('货币', 'Currency'), all: L('全部货币', 'All currencies') }],
    kpis: [
      { label: L('员工', 'Employees'), value: { op: 'count' }, sub: { agg: { op: 'sum', f: 'sch' }, tpl: L('{} 个排班', '{} scheduled shifts') } },
      { label: L('出勤', 'Present'), cls: 'g', value: { op: 'sum', f: 'pre' }, sub: { tpl: L('天', 'days') } },
      { label: L('缺勤', 'Absent'), cls: 'r', value: { op: 'sum', f: 'abs' }, sub: { tpl: L('天', 'days') }, click: ['abs', '>', 0] },
      { label: L('迟到', 'Late'), cls: 'w', value: { op: 'sum', f: 'lt' }, sub: { agg: { op: 'sum', f: 'lm', fmt: 'min' }, tpl: L('合计 {}', '{} total') }, click: ['lt', '>', 0] },
      { label: L('早退', 'Early leave'), cls: 'w', value: { op: 'sum', f: 'et' }, sub: { agg: { op: 'sum', f: 'em', fmt: 'min' }, tpl: L('合计 {}', '{} total') }, click: ['et', '>', 0] },
      { label: L('总工时', 'Total shift'), value: { op: 'sum', f: 'sm', fmt: 'dur' }, sub: { agg: { op: 'sum', f: 'bm', fmt: 'dur' }, tpl: L('休息 {}', 'breaks {}') } },
      { label: 'OT', cls: 'w', value: { op: 'sum', f: 'ot', fmt: 'dur' }, sub: { agg: { op: 'count', where: ['ot', '>', 0] }, tpl: L('{} 位员工', '{} employees') }, click: ['ot', '>', 0] },
    ],
    sort: { k: 'code', dir: 1 }, foot: foot(L),
  });
  return rows.length;
}
