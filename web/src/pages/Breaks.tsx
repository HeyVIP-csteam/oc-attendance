import { Fragment, useState } from 'react';
import { addDays } from '../../../src/shared/time';
import { Cnt, CurrencyOptions, EmpSearch, Empty, ErrBox, Field, Mut, Pager, ShiftName, TblTop } from '../components/ui';
import { qs } from '../lib/api';
import { fmtDur, fmtT, today } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useApi, useData, usePageState } from '../lib/store';
import { ExportHtmlButton } from '../components/ExportHtml';
import { countBreaks, exportBreaks } from '../lib/exports';
import type { AttRow } from './Attendance';

interface BreakRow { session_id: number; seq: number; start_at: number; end_at: number | null; duration_ms: number | null; status: string; remark: string | null }

export function Breaks() {
  const { L, dt } = useI18n();
  const { meta } = useData();
  const t = today();
  const [f, set] = usePageState('br', () => ({ from: addDays(t, -2), to: t, cur: '', q: '', page: 1, size: 10 }));
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const { data, error } = useApi<{ total: number; rows: AttRow[]; breaks: BreakRow[] }>(`/breaks?${qs(f)}`);
  const setF = (p: Partial<typeof f>) => set({ ...p, page: 1 });
  const bySession = new Map<number, BreakRow[]>();
  for (const b of data?.breaks ?? []) bySession.set(b.session_id, [...(bySession.get(b.session_id) ?? []), b]);
  return (
    <>
      <div className="card"><div className="row">
        <Field label={L('开始', 'From')}><input type="date" value={f.from} onChange={(e) => setF({ from: e.target.value || t })} /></Field>
        <Field label={L('结束', 'To')}><input type="date" value={f.to} onChange={(e) => setF({ to: e.target.value || t })} /></Field>
        <Field label={L('货币', 'Currency')}><select value={f.cur} onChange={(e) => setF({ cur: e.target.value })}><CurrencyOptions all={L('全部货币', 'All currencies')} /></select></Field>
        <Field label={L('搜索', 'Search')}><EmpSearch value={f.q} onChange={(q) => setF({ q })} /></Field>
        <div className="rowact"><ExportHtmlButton title={L('导出休息报表', 'Export breaks report')} init={{ from: f.from, to: f.to, cur: f.cur }} count={countBreaks} run={(q) => exportBreaks({ L, dt, meta }, q)} /></div>
      </div></div>
      <ErrBox error={error} />
      {data && (data.rows.length === 0 ? <Empty>{L('没有休息记录', 'No break records')}</Empty> : (
        <>
          <TblTop left={<Cnt n={data.total} />} size={f.size} onSize={(size) => set({ size, page: 1 })} />
          <div className="tw"><table className="brtbl"><thead><tr>
            <th className="pid">{L('PSD ID', 'PSD ID')}</th><th>{L('员工姓名', 'Employee Name')}</th><th>{L('日期', 'Date')}</th><th>{L('班次', 'Shift')}</th><th className="n">{L('休息次数', 'Breaks')}</th>
            <th className="n">{L('当日休息总时长', 'Total Daily Break')}</th><th>{L('状态', 'Status')}</th><th className="c">{L('超出', 'Exceeded')}</th>
          </tr></thead><tbody>
            {data.rows.map((r) => {
              const o = open[r.session_id];
              return (
                <Fragment key={r.session_id}>
                  <tr className={`cl brm ${o ? 'open' : ''}`} onClick={() => setOpen({ ...open, [r.session_id]: !o })}>
                    <td className="nw pid"><span className="arw">▶</span><b>{r.employee_code}</b></td><td>{r.name}</td><td>{r.work_date}</td><td><ShiftName name={r.shift_name} mark={r.mark_code} /></td>
                    <td className="n">{r.break_count}{r.open_break_count > 0 && <> <span className="b r">+{r.open_break_count}</span></>}</td><td className="n">{fmtDur(r.total_break_ms)}</td>
                    <td>{r.open_break_count ? <span className="b w">{L('休息中', 'On break')}</span> : <span className="b ok">{L('全部结束', 'All closed')}</span>}</td>
                    <td className="c">{r.break_exceeded == null ? <Mut /> : r.break_exceeded ? <span className="b w">{L('是', 'Yes')}</span> : <span className="b ok">{L('否', 'No')}</span>}</td>
                  </tr>
                  {o && (bySession.get(r.session_id) ?? []).map((b, j, all) => (
                    <tr key={`${r.session_id}-${b.seq}`} className={`brd ${j === all.length - 1 ? 'last' : ''}`}><td></td><td className="tl mut">Break #{b.seq}</td><td>{b.remark ? <span className="b i" title={L('员工消息', 'Employee message')}>{b.remark}</span> : <span className="mut">—</span>}</td>
                      <td>{fmtT(b.start_at)} → {b.end_at ? fmtT(b.end_at) : <span className="b r">{L('未结束', 'Open')}</span>}</td><td></td><td className="n">{fmtDur(b.duration_ms)}</td><td>{b.status === 'OPEN' ? <span className="b r">{L('未结束', 'Open')}</span> : L('已结束', 'Closed')}</td><td></td></tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody></table></div>
          <Pager total={data.total} page={f.page} size={f.size} onPage={(page) => set({ page })} />
        </>
      ))}
    </>
  );
}
