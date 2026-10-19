import { STATUSES } from '../../../src/shared/codes';
import { CurrencyOptions, EmpSearch, ErrBox, Field, Pager, ShiftOptions, StatusOptions, TblTop } from '../components/ui';
import { qs } from '../lib/api';
import { fmtDur, fmtMin, today } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useApi, useData, usePageState } from '../lib/store';
import { ExportHtmlButton } from '../components/ExportHtml';
import { countReports, exportReports } from '../lib/exports';
import { type AttRow, useDetailExport } from './Attendance';

interface SummaryRow { employee_id: number; employee_code: string; name: string; scheduled: number; present: number; absent: number; late_times: number; late_min: number; early_times: number; early_min: number; breaks: number; break_ms: number; shift_ms: number; exceptions: number }

/** Status = All → employee summary; a specific status → the matching attendance rows. */
export function Reports() {
  const { L, dt } = useI18n();
  const t = today();
  const [f, set] = usePageState('rp', () => ({ from: t, to: t, cur: '', shift: '', status: '', q: '', page: 1, size: 10 }));
  const [from, to] = f.from <= f.to ? [f.from, f.to] : [f.to, f.from];
  const query = { ...f, from, to };
  const { data, error } = useApi<{ mode: 'summary' | 'detail'; total: number; rows: (SummaryRow | AttRow)[] }>(`/reports?${qs(query)}`);
  const ex = useDetailExport();
  const { meta } = useData();
  const setF = (p: Partial<typeof f>) => set({ ...p, page: 1 });
  let cols: string[] = [];
  let rows: (string | number)[][] = [];
  const left: number[] = [0]; // PSD ID
  if (data?.mode === 'summary') {
    cols = L('PSD ID|员工姓名|排班|出勤|缺勤|迟到次数|迟到时长|早退次数|早退时长|休息次数|休息总时长|总工时|异常数', 'PSD ID|Employee Name|Scheduled|Present|Absent|Late (times)|Late (time)|Early (times)|Early (time)|Breaks|Total Break|Total Shift|Exceptions').split('|');
    rows = (data.rows as SummaryRow[]).map((a) => [a.employee_code, a.name, a.scheduled ?? 0, a.present ?? 0, a.absent ?? 0, a.late_times ?? 0, a.late_min ? fmtMin(a.late_min) : 0, a.early_times ?? 0, a.early_min ? fmtMin(a.early_min) : 0, a.breaks ?? 0, fmtDur(a.break_ms), fmtDur(a.shift_ms), a.exceptions]);
  } else if (data?.mode === 'detail') {
    cols = ex.cols();
    rows = (data.rows as AttRow[]).map((r) => { const x = ex.row(r, (s) => dt((STATUSES as any)[s]?.label ?? s)) as (string | number)[]; x[7] = r.late_min ? fmtMin(r.late_min) : x[7]; x[10] = r.early_min ? fmtMin(r.early_min) : x[10]; return x; });
  }
  return (
    <>
      <div className="card"><div className="row">
        <Field label={L('开始', 'From')}><input type="date" value={f.from} onChange={(e) => setF({ from: e.target.value || t })} /></Field>
        <Field label={L('结束', 'To')}><input type="date" value={f.to} onChange={(e) => setF({ to: e.target.value || t })} /></Field>
        <Field label={L('货币', 'Currency')}><select value={f.cur} onChange={(e) => setF({ cur: e.target.value })}><CurrencyOptions all={L('全部货币', 'All currencies')} /></select></Field>
        <Field label={L('班次', 'Shift')}><select value={f.shift} onChange={(e) => setF({ shift: e.target.value })}><ShiftOptions withNone /></select></Field>
        <Field label={L('状态', 'Status')}><select value={f.status} onChange={(e) => setF({ status: e.target.value })}><StatusOptions all={L('全部', 'All')} /></select></Field>
        <Field label={L('搜索', 'Search')}><EmpSearch value={f.q} onChange={(q) => setF({ q })} /></Field>
        <div className="rowact"><ExportHtmlButton title={L('导出考勤汇总报表', 'Export attendance summary')} init={{ from, to, cur: f.cur }} count={countReports} run={(q) => exportReports({ L, dt, meta }, q)} /></div>
      </div></div>
      <ErrBox error={error} />
      {data && (
        <div className="card">
          <TblTop left={<span />} size={f.size} onSize={(size) => set({ size, page: 1 })} />
          {rows.length ? (
            <>
              <div className="tw"><table><thead><tr>{cols.map((c, i) => <th key={i} className={left.includes(i) ? 'pid' : ''}>{c}</th>)}</tr></thead><tbody>
                {rows.map((r, j) => <tr key={j}>{r.map((v, i) => <td key={i} className={left.includes(i) ? 'pid' : ''}>{i === 0 ? <b>{v}</b> : v}</td>)}</tr>)}
              </tbody></table></div>
              <Pager total={data.total} page={f.page} size={f.size} onPage={(page) => set({ page })} />
            </>
          ) : <div className="empty">{L('此条件下没有数据', 'No data for these filters')}</div>}
        </div>
      )}
    </>
  );
}
