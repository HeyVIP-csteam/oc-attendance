// Reports → click an employee: that employee over the period queried on the Reports page. Totals as in the summary row,
// then every day of the period in order (a day without a shift is "Day off"; worked on a day off = that day's OT), and
// each worked day opens the same day popup as Attendance.
import { useState } from 'react';
import { addDays } from '../../../src/shared/time';
import { qs } from '../lib/api';
import { fmtDur, fmtMin, fmtT, LATE_RED, today } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useApi } from '../lib/store';
import { type AttRow, SessionDrawer } from '../pages/Attendance';
import { CurB, Drawer, ErrBox, Mut, ShiftName, StatusBadge } from './ui';

interface Summary { scheduled: number; present: number; absent: number; late_times: number; late_min: number; early_times: number; early_min: number; breaks: number; break_ms: number; net_ms: number; shift_ms: number; missing: number; ot_times: number; exceptions: number }
interface Resp {
  employee: { id: number; employee_code: string; name: string; currency_code: string | null; employment_status: string };
  summary: Partial<Summary>; rows: AttRow[];
  marks: { date: string; code: string }[]; otMarks: { date: string; note: string | null }[];
}

const WD_ZH = '日一二三四五六';
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

export function EmployeeReport({ emp, from, to, shift, onClose }: { emp: number; from: string; to: string; shift?: string; onClose: () => void }) {
  const { L, lang } = useI18n();
  const [day, setDay] = useState<string | null>(null);
  const [rf, rt] = from <= to ? [from, to] : [to, from];
  const { data, error } = useApi<Resp>(`/reports/employee/${emp}?${qs({ from: rf, to: rt, shift: shift ?? '' })}`);

  const s = data?.summary ?? {};
  const n = (k: keyof Summary) => Number(s[k] ?? 0);
  const byDate = new Map((data?.rows ?? []).map((r) => [r.work_date, r]));
  const markOf = new Map((data?.marks ?? []).map((m) => [m.date, m.code]));
  const otMarked = new Set((data?.otMarks ?? []).map((m) => m.date));
  const span = days(rf, rt);
  // days after today have nothing yet: the list stops at today
  const last = rt < today() ? rt : today();
  const dates = Array.from({ length: Math.max(0, Math.min(days(rf, last), 400)) }, (_, i) => addDays(rf, i));
  const wd = (d: string) => { const x = new Date(`${d}T00:00:00Z`).getUTCDay(); return lang === 'en' ? WD_EN[x] : `周${WD_ZH[x]}`; };
  const rate = n('scheduled') ? Math.round((n('present') / n('scheduled')) * 100) : null;
  const initials = (nm: string) => nm.split(/[\s\-_.]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const otBadge = <span className="b r">{L('当日 OT', 'OT day')}</span>;
  /** No shift that day: the roster code (OFF, VL …) or simply "Day off". */
  const dayOff = (d: string) => (markOf.get(d) ? <ShiftName name={null} mark={markOf.get(d)} /> : <b className="rp-off">Day off</b>);

  const card = (label: string, value: React.ReactNode, sub: React.ReactNode, tone = '') => (
    <div className={`rp-sc ${tone}`}><div className="l">{label}</div><div className="v">{value}</div><div className="s">{sub}</div></div>
  );

  return (
    <Drawer onClose={onClose}>
      <div className="sd">
        <div className="sd-hd">
          <div className="sd-av">{data ? initials(data.employee.name) : '…'}</div>
          <div style={{ minWidth: 0 }}>
            <h2>{data?.employee.name ?? '…'} {data && <span className="sd-id">PSD ID {data.employee.employee_code}</span>}</h2>
            <div className="sd-meta">
              <span>{L('期间', 'Period')} <b>{rf} → {rt}</b> · {L(`${span} 天`, `${span} days`)}</span>
              {data?.employee.currency_code && <span>{L('货币', 'Currency')} <CurB c={data.employee.currency_code} /></span>}
              <span>{L('斯里兰卡时间', 'Sri Lanka time')}</span>
            </div>
          </div>
          <div className="sd-r"><button className="btn" onClick={onClose}>{L('关闭', 'Close')}</button></div>
        </div>

        <div className="sd-body">
          <ErrBox error={error} />
          {!data && !error && <div className="mut" style={{ padding: 24 }}>…</div>}

          {data && (
            <>
              <div className="rp-sum">
                {card(L('出勤（排班日）', 'Present (shift days)'), <>{n('present')}<small> / {n('scheduled')}</small></>, rate == null ? L('没有排班', 'No shifts') : <>{L('出勤率', 'Attendance')} <b>{rate}%</b></>)}
                {card(L('缺勤', 'Absent'), n('absent'), L('排班未出勤', 'Scheduled, no show'), n('absent') ? 'bad' : '')}
                {card(L('迟到', 'Late'), <>{n('late_times')}<small> {L('次', 'times')}</small></>, <>{L('合计', 'Total')} <b>{n('late_min') ? fmtMin(n('late_min')) : '0'}</b></>, n('late_times') ? 'warn' : '')}
                {card(L('早退', 'Early leave'), <>{n('early_times')}<small> {L('次', 'times')}</small></>, <>{L('合计', 'Total')} <b>{n('early_min') ? fmtMin(n('early_min')) : '0'}</b></>, n('early_times') ? 'warn' : '')}
                {card(L('缺卡', 'Missing punch'), <>{n('missing')}<small> {L('天', 'days')}</small></>, L('缺上班 / 下班 / 休息未结束', 'In / out / break not ended'), n('missing') ? 'bad' : '')}
                {card(L('休息', 'Breaks'), fmtDur(n('break_ms')), <>{L('共', '')} <b>{n('breaks')}</b> {L('次', 'breaks')}</>)}
                {card(L('净工时', 'Net worked'), fmtDur(n('net_ms')), <>{L('在班', 'On shift')} <b>{fmtDur(n('shift_ms'))}</b></>)}
                {card('OT', <>{n('ot_times')}<small> {L('次', 'times')}</small></>, <>{L('异常', 'Exceptions')} <b>{n('exceptions')}</b></>)}
              </div>

              <div className="sd-card">
                <div className="sd-ch"><h3>{L('每日明细', 'Day by day')}</h3><span className="c">{L('点击某天查看当日打卡', 'Click a day for its punches')}</span></div>
                <div className="tw"><table className="sd-t rp-t"><thead><tr>
                  <th>{L('日期', 'Date')}</th><th>{L('班次', 'Shift')}</th><th>{L('上班', 'Clock in')}</th><th>{L('迟到', 'Late')}</th><th>{L('下班', 'Clock out')}</th><th>{L('早退', 'Early')}</th>
                  <th>{L('休息', 'Breaks')}</th><th>{L('净工时', 'Net')}</th><th>OT</th><th>{L('状态', 'Status')}</th><th>{L('异常', 'Exc.')}</th>
                </tr></thead><tbody>
                  {dates.map((d) => {
                    const r = byDate.get(d);
                    const date = <td><b>{d.slice(5)}</b> <span className="mut">{wd(d)}</span></td>;
                    if (!r) return (
                      <tr key={d} className="rp-none">
                        {date}<td>{dayOff(d)}</td>
                        <td colSpan={9}>{otMarked.has(d) ? <>{otBadge} <span className="mut">{L('排班表手动标记 OT', 'OT marked on the roster')}</span></> : <span className="mut">{L('休息日', 'Rest day')}</span>}</td>
                      </tr>
                    );
                    const off = !r.shift_name; // worked without a shift that day
                    return (
                      <tr key={d} className="cl" onClick={() => setDay(d)}>
                        {date}
                        <td>{off ? dayOff(d) : <ShiftName name={r.shift_name} mark={r.mark_code} />}</td>
                        <td>{r.actual_in_at ? fmtT(r.actual_in_at) : <Mut />}{r.scheduled_start_at ? <div className="sd-sub">{L('排', 'sch')} {fmtT(r.scheduled_start_at)}</div> : null}</td>
                        <td>{r.late_min ? <b style={{ color: LATE_RED }}>{fmtMin(r.late_min)}</b> : <Mut />}</td>
                        <td>{r.actual_out_at ? fmtT(r.actual_out_at) : <Mut />}{r.scheduled_end_at ? <div className="sd-sub">{L('排', 'sch')} {fmtT(r.scheduled_end_at)}</div> : null}</td>
                        <td>{r.early_min ? <b style={{ color: LATE_RED }}>{fmtMin(r.early_min)}</b> : <Mut />}</td>
                        <td>{r.break_count ? <>{r.break_count} · {fmtDur(r.total_break_ms)}</> : <Mut />}{r.open_break_count > 0 && <> <span className="b r">+{r.open_break_count}</span></>}</td>
                        <td>{r.net_worked_ms == null ? <Mut /> : fmtDur(r.net_worked_ms)}</td>
                        <td>{r.ot_day ? <b style={{ color: LATE_RED }}>OT</b> : <Mut />}</td>
                        <td>{off && r.ot_day ? otBadge : <StatusBadge st={r.status} mark={r.mark_code} />}</td>
                        <td>{r.exception_count ? <span className={`b ${r.has_major_exception ? 'r' : ''}`}>{r.exception_count}</span> : <span className="mut">0</span>}</td>
                      </tr>
                    );
                  })}
                </tbody></table></div>
              </div>

            </>
          )}
        </div>
      </div>
      {day && <SessionDrawer emp={emp} date={day} onClose={() => setDay(null)} />}
    </Drawer>
  );
}
