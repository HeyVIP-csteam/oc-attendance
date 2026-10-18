import { ArcElement, Chart, DoughnutController, Legend, Tooltip } from 'chart.js';
import { type ReactNode, useEffect, useRef } from 'react';
import { CurrencyOptions, ErrBox, Field, ShiftOptions } from '../components/ui';
import { qs } from '../lib/api';
import { fmtMin, today } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useApi, usePageState } from '../lib/store';

Chart.register(Legend, Tooltip, DoughnutController, ArcElement);

interface OverviewData {
  totalEmployees: number; expected: number; started: number; startedPresent: number; working: number; onBreak: number;
  late: number; lateMin: number; early: number; earlyMin: number; clockedIn: number;
}

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function ChartBox({ build, deps }: { build: (el: HTMLCanvasElement) => Chart; deps: unknown[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    Chart.defaults.color = css('--mut');
    Chart.defaults.borderColor = css('--line');
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    const c = build(ref.current);
    return () => c.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return <div className="cw"><canvas ref={ref} /></div>;
}

export function Overview() {
  const { L } = useI18n();
  const [f, set] = usePageState('ov', () => ({ date: today(), cur: '', shift: '' }));
  const { data, error } = useApi<OverviewData>(`/overview?${qs(f)}`);
  const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—');
  const k = (l: string, v: ReactNode, s: string, c = '') => <div className={`kpi ${c}`}><div className="l">{l}</div><div className="v">{v}</div><div className="s">{s || ' '}</div></div>;
  const d = data;
  return (
    <>
      <div className="card"><div className="row">
        <Field label={L('日期（考勤日）', 'Date (work date)')}><input type="date" value={f.date} onChange={(e) => set({ date: e.target.value || today() })} /></Field>
        <Field label={L('货币', 'Currency')}><select value={f.cur} onChange={(e) => set({ cur: e.target.value })}><CurrencyOptions all={L('全部货币', 'All currencies')} /></select></Field>
        <Field label={L('班次', 'Shift')}><select value={f.shift} onChange={(e) => set({ shift: e.target.value })}><ShiftOptions /></select></Field>
      </div></div>
      <ErrBox error={error} />
      {d && (
        <>
          <div className="kpis k4">
            {k(L('员工总数', 'Total Employees'), d.totalEmployees, L('在职员工', 'active'))}
            {k(L('今日应到', 'Expected Today'), d.expected, L('有班次实例', 'with a shift instance'))}
            {k(L('工作中', 'Currently Working'), d.working, L('实时', 'live'))}
            {k(L('休息中', 'Currently On Break'), d.onBreak, L('实时', 'live'))}
            {k(L('迟到人数', 'Late Employees'), d.late, L(`合计 ${fmtMin(d.lateMin)}`, `${fmtMin(d.lateMin)} total`), 'kw')}
            {k(L('早退人数', 'Early Leave'), d.early, L(`合计 ${fmtMin(d.earlyMin)}`, `${fmtMin(d.earlyMin)} total`), 'kw')}
            {k(L('出勤率', 'Attendance Rate'), pct(d.startedPresent, d.started), L(`${d.startedPresent}/${d.started} 已开始班次`, `${d.startedPresent}/${d.started} started shifts`), 'kg')}
            {k(L('迟到率', 'Late Rate'), pct(d.late, d.clockedIn), L('迟到 / 已打卡', 'late / clocked in'))}
          </div>
          <div className="charts">
            <div className="card"><h3>{L('准时 vs 迟到', 'On-Time vs Late')}（{f.date}）</h3>
              <ChartBox deps={[d, L('准时', 'On time')]} build={(el) => new Chart(el, {
                type: 'doughnut',
                data: { labels: [L('准时', 'On time'), L('迟到', 'Late')], datasets: [{ data: [d.clockedIn - d.late, d.late], backgroundColor: ['#22c55e', '#f59e0b'] }] },
                options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
              })} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
