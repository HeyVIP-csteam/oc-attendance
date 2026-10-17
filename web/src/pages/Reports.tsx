import { STATUSES } from '../../../src/shared/codes';
import { addDays } from '../../../src/shared/time';
import { CurrencyOptions, EmpSearch, ErrBox, Field, Pager, ShiftOptions, StatusOptions, TblTop } from '../components/ui';
import { qs } from '../lib/api';
import { fmtMin, hrs, today } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useApi, usePageState } from '../lib/store';
import { type AttRow, useDetailExport } from './Attendance';

interface SummaryRow { employee_id: number; employee_code: string; name: string; scheduled: number; present: number; absent: number; late_times: number; late_min: number; early_times: number; early_min: number; breaks: number; break_ms: number; shift_ms: number; exceptions: number }

/** Status = All → employee summary; a specific status → the matching attendance rows. */
export function Reports() {
  const { L, dt } = useI18n();
  const t = today();
  const [f, set] = usePageState('rp', () => ({ period: 'today', from: t, to: t, cur: '', shift: '', status: '', q: '', page: 1, size: 10 }));
  const [from, to] = f.from <= f.to ? [f.from, f.to] : [f.to, f.from];
  const { period: _p, ...query } = { ...f, from, to };
  const { data, error } = useApi<{ mode: 'summary' | 'detail'; total: number; rows: (SummaryRow | AttRow)[] }>(`/reports?${qs(query)}`);
  const ex = useDetailExport();
  const setF = (p: Partial<typeof f>) => set({ ...p, page: 1 });
  const applyPeriod = (period: string) => {
    if (period === 'today') setF({ period, from: t, to: t });
    else if (period === 'weekly') setF({ period, from: addDays(t, -6), to: t });
    else if (period === 'monthly') setF({ period, from: t.slice(0, 8) + '01', to: t });
  };
  const title = !f.status ? L('员工出勤', 'Employee Attendance') : f.status === 'MISSING' ? L('任何缺卡', 'Any missing punch') : dt((STATUSES as any)[f.status]?.label ?? f.status);
  let cols: string[] = [];
  let rows: (string | number)[][] = [];
  let left: number[] = [0];
  if (data?.mode === 'summary') {
    cols = L('名称|排班|出勤|缺勤|迟到次数|迟到时长|早退次数|早退时长|休息次数|休息总时长(h)|总工时(h)|异常数', 'Name|Scheduled|Present|Absent|Late (times)|Late (time)|Early (times)|Early (time)|Breaks|Total Break (h)|Total Shift (h)|Exceptions').split('|');
    rows = (data.rows as SummaryRow[]).map((a) => [`${a.employee_code} ${a.name}`, a.scheduled, a.present, a.absent, a.late_times, a.late_min ? fmtMin(a.late_min) : 0, a.early_times, a.early_min ? fmtMin(a.early_min) : 0, a.breaks, hrs(a.break_ms), hrs(a.shift_ms), a.exceptions]);
  } else if (data?.mode === 'detail') {
    cols = ex.cols();
    rows = (data.rows as AttRow[]).map((r) => { const x = ex.row(r, (s) => dt((STATUSES as any)[s]?.label ?? s)) as (string | number)[]; x[7] = r.late_min ? fmtMin(r.late_min) : x[7]; x[10] = r.early_min ? fmtMin(r.early_min) : x[10]; return x; });
    left = [0, 1];
  }
  return (
    <>
      <div className="card"><div className="row">
        <Field label={L('期间', 'Period')}><select value={f.period} onChange={(e) => applyPeriod(e.target.value)}>
          {!f.period && <option value="">—</option>}
          <option value="today">{L('今天', 'Today')}</option><option value="weekly">{L('每周（7 天）', 'Weekly (7 days)')}</option><option value="monthly">{L('每月（月初至今）', 'Monthly (month to date)')}</option>
        </select></Field>
        <Field label={L('开始', 'From')}><input type="date" value={f.from} onChange={(e) => setF({ from: e.target.value || t, period: '' })} /></Field>
        <Field label={L('结束', 'To')}><input type="date" value={f.to} onChange={(e) => setF({ to: e.target.value || t, period: '' })} /></Field>
        <Field label={L('货币', 'Currency')}><select value={f.cur} onChange={(e) => setF({ cur: e.target.value })}><CurrencyOptions all={L('全部货币', 'All currencies')} /></select></Field>
        <Field label={L('班次', 'Shift')}><select value={f.shift} onChange={(e) => setF({ shift: e.target.value })}><ShiftOptions withNone /></select></Field>
        <Field label={L('状态', 'Status')}><select value={f.status} onChange={(e) => setF({ status: e.target.value })}><StatusOptions all={L('全部', 'All')} /></select></Field>
        <Field label={L('搜索', 'Search')}><EmpSearch value={f.q} onChange={(q) => setF({ q })} /></Field>
      </div></div>
      <ErrBox error={error} />
      {data && (
        <div className="card">
          <TblTop left={<h3 style={{ margin: 0 }}>{title} · {from} → {to} · {L(`${data.total} 行`, `${data.total} rows`)} · {L('斯里兰卡时间', 'Sri Lanka time')}</h3>} size={f.size} onSize={(size) => set({ size, page: 1 })} />
          {rows.length ? (
            <>
              <div className="tw"><table><thead><tr>{cols.map((c, i) => <th key={i} className={left.includes(i) ? '' : 'c'}>{c}</th>)}</tr></thead><tbody>
                {rows.map((r, j) => <tr key={j}>{r.map((v, i) => <td key={i} className={left.includes(i) ? '' : 'c'}>{v}</td>)}</tr>)}
              </tbody></table></div>
              <Pager total={data.total} page={f.page} size={f.size} onPage={(page) => set({ page })} />
            </>
          ) : <div className="empty">{L('此条件下没有数据', 'No data for these filters')}</div>}
        </div>
      )}
    </>
  );
}
