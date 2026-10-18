import { useState } from 'react';
import { EVENT_LABEL, EVENT_TYPES, type EventType, STATUSES } from '../../../src/shared/codes';
import { addDays } from '../../../src/shared/time';
import { Cnt, CurB, CurrencyOptions, Drawer, EmpSearch, Empty, ErrBox, ExB, Field, Modal, Mut, Pager, ShiftOptions, StatusBadge, StatusOptions, TblTop } from '../components/ui';
import { api, type ApiErr, qs } from '../lib/api';
import { exportCSV, exportXLSX } from '../lib/files';
import { fmtDT, fmtDur, fmtMin, fmtT, fromLocalInput, hrs, LATE_RED, toLocalInput, today, TZ } from '../lib/format';
import { parseBi, useI18n } from '../lib/i18n';
import { toast, useApi, useData, usePageState } from '../lib/store';

export interface AttRow {
  employee_id: number; work_date: string; employee_code: string; name: string; currency_code: string | null; shift_id: number | null; shift_code: string | null; shift_name: string | null;
  adjustment_status: string | null; scheduled_start_at: number | null; actual_in_at: number | null; late_min: number | null; scheduled_end_at: number | null; actual_out_at: number | null;
  early_min: number | null; break_count: number; open_break_count: number; total_break_ms: number; shift_duration_ms: number | null; net_worked_ms: number | null; status: string; state: string;
  missing: string; exception_count: number; has_major_exception: number; adjusted: number; break_exceeded: number | null; session_id: number;
}

export function useDetailExport() {
  const { L, dt } = useI18n();
  const cols = () => L('PSD ID|员工姓名|货币|考勤日期|班次|排班上班 (LK)|实际上班 (LK)|迟到(分)|排班下班 (LK)|实际下班 (LK)|早退(分)|休息次数|休息总时长|净工时(h)|状态|缺卡',
    'PSD ID|Employee Name|Currency|Date|Shift|Scheduled In (LK)|Actual In (LK)|Late Min|Scheduled Out (LK)|Actual Out (LK)|Early Min|Breaks|Total Break|Net Hours|Status|Missing Punch').split('|');
  const row = (r: AttRow, statusLabel: (s: string) => string) => [r.employee_code, r.name, r.currency_code ?? '', r.work_date, r.shift_name ?? L('未排班', 'No schedule'), fmtDT(r.scheduled_start_at), fmtDT(r.actual_in_at), r.late_min ?? '',
    fmtDT(r.scheduled_end_at), fmtDT(r.actual_out_at), r.early_min ?? '', `${r.break_count}${r.open_break_count ? ` (+${r.open_break_count} open)` : ''}`, Math.round(r.total_break_ms / 60000) + 'm', r.net_worked_ms == null ? '' : hrs(r.net_worked_ms), statusLabel(r.status), r.missing];
  return { cols, row, dt };
}

const COLS: [string, string, string][] = [
  ['emp', 'PSD ID', 'PSD ID'], ['name', '员工姓名', 'Employee Name'], ['cur', '货币', 'Currency'], ['workDate', '日期', 'Date'], ['shiftName', '班次', 'Shift'], ['schedIn', '排班上班', 'Sched In'], ['inT', '实际上班', 'Actual In'],
  ['lateMin', '迟到', 'Late'], ['schedOut', '排班下班', 'Sched Out'], ['outT', '实际下班', 'Actual Out'], ['earlyMin', '早退', 'Early'], ['completedBreaks', '休息', 'Breaks'],
  ['totalBreak', '休息总计', 'Break Total'], ['net', '净工时', 'Net Hrs'], ['status', '状态', 'Status'], ['flags', '异常', 'Exceptions'],
];

export function Attendance() {
  const { L, dt } = useI18n();
  const t = today();
  const [f, set] = usePageState('at', () => ({ from: addDays(t, -6), to: t, cur: '', shift: '', status: '', q: '', sort: 'workDate', dir: -1, page: 1, size: 10 }));
  const { data, error } = useApi<{ total: number; rows: AttRow[] }>(`/attendance?${qs(f)}`);
  const [open, setOpen] = useState<{ emp: number; date: string } | null>(null);
  const ex = useDetailExport();
  const setF = (p: Partial<typeof f>) => set({ ...p, page: 1 });
  const doExport = async (fmt: 'csv' | 'xlsx') => {
    try {
      const { page: _p, size: _s, ...rest } = f;
      const r = await api<{ rows: AttRow[] }>(`/attendance/export?${qs(rest)}`);
      const sl = (s: string) => dt((STATUSES as any)[s]?.label ?? s);
      const name = `attendance_${f.from}_${f.to}`;
      const rows = r.rows.map((x) => ex.row(x, sl));
      if (fmt === 'csv') exportCSV(name, ex.cols(), rows);
      else await exportXLSX(name, ex.cols(), rows, [['Generated', fmtDT(Date.now())], ['Time zone', TZ], ['Rows', String(rows.length)]]);
      toast(L(`已导出 ${rows.length} 行`, `Exported ${rows.length} rows`));
    } catch (e) { toast(dt((e as ApiErr).msg ?? { zh: '导出失败', en: 'Export failed' })); }
  };
  const sortBy = (k: string) => set({ sort: k, dir: f.sort === k ? -f.dir : 1, page: 1 });
  const num = (v: number | null) => (v ? <b style={{ color: LATE_RED }}>{fmtMin(v)}</b> : v === 0 ? '0' : '—');
  return (
    <>
      <div className="card"><div className="row">
        <Field label={L('开始', 'From')}><input type="date" value={f.from} onChange={(e) => setF({ from: e.target.value || t })} /></Field>
        <Field label={L('结束', 'To')}><input type="date" value={f.to} onChange={(e) => setF({ to: e.target.value || t })} /></Field>
        <Field label={L('货币', 'Currency')}><select value={f.cur} onChange={(e) => setF({ cur: e.target.value })}><CurrencyOptions all={L('全部货币', 'All currencies')} /></select></Field>
        <Field label={L('班次', 'Shift')}><select value={f.shift} onChange={(e) => setF({ shift: e.target.value })}><ShiftOptions withNone /></select></Field>
        <Field label={L('状态', 'Status')}><select value={f.status} onChange={(e) => setF({ status: e.target.value })}><StatusOptions all={L('全部状态', 'All statuses')} /></select></Field>
        <Field label={L('搜索', 'Search')}><EmpSearch value={f.q} onChange={(q) => setF({ q })} /></Field>
        <div className="rowact"><button className="btn" onClick={() => doExport('csv')}>{L('导出 CSV', 'Export CSV')}</button><button className="btn" onClick={() => doExport('xlsx')}>{L('导出 XLSX', 'Export XLSX')}</button></div>
      </div></div>
      <ErrBox error={error} />
      {data && (data.rows.length === 0 ? <Empty>{L('没有符合条件的考勤记录', 'No attendance records match these filters')}</Empty> : (
        <>
          <TblTop left={<Cnt n={data.total} />} size={f.size} onSize={(size) => set({ size, page: 1 })} />
          <div className="tw"><table className="attbl"><thead><tr>
            {COLS.map(([k, zh, en]) => <th key={k} className={`s ${k === 'emp' ? 'pid' : ['lateMin', 'earlyMin', 'completedBreaks', 'totalBreak', 'net'].includes(k) ? 'n' : ''}`} onClick={() => sortBy(k)}>{L(zh, en)}{f.sort === k ? (f.dir > 0 ? ' ▲' : ' ▼') : ''}</th>)}
          </tr></thead><tbody>
            {data.rows.map((r) => (
              <tr key={`${r.employee_id}|${r.work_date}`} className="cl" onClick={() => setOpen({ emp: r.employee_id, date: r.work_date })}>
                <td className="pid"><b>{r.employee_code}</b></td><td>{r.name}</td><td className="c"><CurB c={r.currency_code} /></td><td>{r.work_date}</td>
                <td>{r.shift_name ?? L('未排班', 'No schedule')}</td>
                <td>{r.scheduled_start_at ? fmtT(r.scheduled_start_at) : <Mut />}</td><td>{r.actual_in_at ? fmtT(r.actual_in_at) : <Mut />}</td><td className="n">{num(r.late_min)}</td>
                <td>{r.scheduled_end_at ? fmtT(r.scheduled_end_at) : <Mut />}</td><td>{r.actual_out_at ? fmtT(r.actual_out_at) : <Mut />}</td><td className="n">{num(r.early_min)}</td>
                <td className="n">{r.break_count}{r.open_break_count > 0 && <> <span className="b r">+{r.open_break_count} {L('未结束', 'open')}</span></>}</td>
                <td className="n">{fmtDur(r.total_break_ms)}</td><td className="n">{r.net_worked_ms == null ? <Mut /> : hrs(r.net_worked_ms)}</td>
                <td><StatusBadge st={r.status} />{r.adjusted ? <> <span className="b v">{L('已修正', 'Adjusted')}</span></> : null}</td>
                <td className="c">{r.exception_count ? <span className={`b ${r.has_major_exception ? 'r' : ''}`}>{r.exception_count}</span> : <span className="mut">0</span>}</td>
              </tr>
            ))}
          </tbody></table></div>
          <Pager total={data.total} page={f.page} size={f.size} onPage={(page) => set({ page })} />
        </>
      ))}
      {open && <SessionDrawer emp={open.emp} date={open.date} onClose={() => setOpen(null)} />}
    </>
  );
}

interface Detail {
  employee: { id: number; employee_code: string; name: string; currency_code: string | null };
  workDate: string;
  instance: { id: number; shift_name: string; adjustment_status: string; source: string; late_grace_min: number; early_grace_min: number; break_minutes: number | null; scheduled_start_at: number; scheduled_end_at: number } | null;
  session: AttRow & { scheduled_start_at: number | null; shift_duration_ms: number | null } | null;
  events: { id: number; event_type: EventType; event_ts: number; source: string; is_voided: number; sm_result: string | null; adjustment_id: number | null; voided_by_adjustment_id: number | null; raw_text: string | null; tg_message_id: number | null; message_thread_id: number | null; from_user_id: number | null; telegram_message_ts: number | null; raw_received_at: number | null; processed_at: number | null }[];
  breaks: { seq: number; start_at: number; end_at: number | null; duration_ms: number | null; status: string; remark: string | null }[];
  exceptions: { id: number; code: string; occurred_at: number; detail: string | null; status: string }[];
  adjustments: { id: number; action: string; event_type: EventType | null; event_ts: number | null; target_event_id: number | null; reason: string; before_json: string | null; after_json: string | null; created_by: string; created_at: number }[];
}

type Ev = Detail['events'][number];
const EV_DOT: Record<EventType, string> = { CLOCK_IN: 'd-in', BREAK_START: 'd-bs', BREAK_END: 'd-be', CLOCK_OUT: 'd-out' };
const WD_ZH = '日一二三四五六';
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function SessionDrawer({ emp, date, onClose }: { emp: number; date: string; onClose: () => void }) {
  const { L, dt, lang } = useI18n();
  const { refresh, readOnly, meta } = useData();
  const { data, error, reload } = useApi<Detail>(`/sessions/${emp}/${date}`);
  const [type, setType] = useState<EventType>('CLOCK_OUT');
  const [ts, setTs] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState<{ kind: 'edit' | 'del'; ev: Ev } | null>(null);
  const s = data?.session;
  const inst = data?.instance;
  const defaultTs = s?.actual_out_at ?? s?.scheduled_end_at ?? s?.actual_in_at ?? Date.now();
  const post = async (body: Record<string, unknown>, msg: string) => {
    setBusy(true);
    try {
      await api(`/sessions/${emp}/${date}/adjustments`, { method: 'POST', body });
      toast(msg);
      await reload();
      refresh();
      return null;
    } catch (e) { return e as ApiErr; } finally { setBusy(false); }
  };
  const save = async () => {
    setErr(null);
    const t = fromLocalInput(ts || toLocalInput(defaultTs));
    if (t == null) return setErr(new Error(L('请填写时间', 'Please enter a time')));
    if (reason.trim().length < 4) return setErr(new Error(L('必须填写修正原因（至少 4 个字）', 'A reason is required (at least 4 characters)')));
    const e = await post({ action: 'ADD_EVENT', eventType: type, ts: t, reason }, L('已补录，数字已重新计算', 'Punch added; figures recalculated'));
    if (e) setErr(e); else setReason('');
  };

  const hm = (ms: number | null | undefined) => (ms == null ? null : fmtDT(ms).slice(11, 16));
  const hms = (ms: number) => fmtDT(ms).slice(11, 19);
  const otherDay = (ms: number) => { const d = fmtDT(ms).slice(0, 10); return d !== date ? d : null; };
  const wd = (() => { const d = new Date(`${date}T00:00:00Z`).getUTCDay(); return lang === 'en' ? WD_EN[d] : L(`（${WD_ZH[d]}）`, `(${WD_EN[d]})`); })();
  const initials = (n: string) => n.split(/[\s\-_.]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const adjById = new Map((data?.adjustments ?? []).map((a) => [a.id, a]));
  // an ADD adjustment that points at an older punch is the second half of an "edit"
  const editedIds = new Set((data?.adjustments ?? []).filter((a) => a.action === 'ADD_EVENT' && a.target_event_id).map((a) => a.target_event_id!));
  const breakQuota = meta.rules.breakMinutes !== undefined ? meta.rules.breakMinutes : inst?.break_minutes ?? null;
  const live = (data?.events ?? []).filter((e) => !e.is_voided).length;
  const gone = (data?.events ?? []).filter((e) => e.is_voided).length;

  const late = s?.late_min ?? null, early = s?.early_min ?? null;
  const lateTxt = s?.actual_in_at == null ? <b>—</b> : late ? <b className="red">{fmtMin(late)}</b> : <b>{L('准时', 'On time')}</b>;
  const earlyTxt = s?.actual_out_at == null ? <b>—</b> : early ? <b className="red">{fmtMin(early)}</b> : <b>{L('准时', 'On time')}</b>;
  const brOk = s?.break_exceeded == null ? null : !s.break_exceeded;

  return (
    <Drawer onClose={onClose}>
      <div className="sd">
      <ErrBox error={error} />
      {!data && !error && <div className="mut" style={{ padding: 24 }}>…</div>}
      {data && (
        <>
          <div className="sd-hd">
            <div className="sd-av">{initials(data.employee.name)}</div>
            <div style={{ minWidth: 0 }}>
              <h2>{data.employee.name} <span className="sd-id">PSD ID {data.employee.employee_code}</span></h2>
              <div className="sd-meta">
                <span>{L('考勤日', 'Work date')} <b>{date}{wd}</b></span>
                {data.employee.currency_code && <span>{L('货币', 'Currency')} <b>{data.employee.currency_code}</b></span>}
                <span>{L('班次', 'Shift')} <b>{inst ? `${inst.shift_name} · ${hm(inst.scheduled_start_at)} – ${hm(inst.scheduled_end_at)}` : L('未排班', 'No schedule')}</b></span>
                <span>{L('斯里兰卡时间', 'Sri Lanka time')}</span>
              </div>
            </div>
            <div className="sd-r">{s && <StatusBadge st={s.status} />}<button className="btn" onClick={onClose}>{L('关闭', 'Close')}</button></div>
          </div>

          <div className="sd-body">
            <div className="sd-sum">
              <div className="sd-sc"><div className="l">{L('上班', 'Clock in')}</div>
                <div className="v">{hm(s?.actual_in_at) ?? <span className="mis">{L('未打卡', 'Missing')}</span>}</div>
                <div className="s">{L('排班', 'Scheduled')} <b>{hm(inst?.scheduled_start_at) ?? '—'}</b> · {L('迟到', 'Late')} {lateTxt}</div></div>
              <div className="sd-sc"><div className="l">{L('下班', 'Clock out')}</div>
                <div className="v">{hm(s?.actual_out_at) ?? <span className="mis">{L('未打卡', 'Missing')}</span>}</div>
                <div className="s">{L('排班', 'Scheduled')} <b>{hm(inst?.scheduled_end_at) ?? '—'}</b> · {L('早退', 'Early')} {earlyTxt}</div></div>
              <div className="sd-sc"><div className="l">{L('休息', 'Breaks')} {brOk != null && <span className={`b ${brOk ? 'ok' : 'w'}`}>{brOk ? L('符合规则', 'Within rule') : L('超出额度', 'Over limit')}</span>}</div>
                <div className="v">{fmtDur(s?.total_break_ms ?? 0)}</div>
                <div className="s">{L('共', '')} <b>{s?.break_count ?? 0}</b> {L('次', 'breaks')}{s?.open_break_count ? <> · <b className="red">{L(`${s.open_break_count} 次未结束`, `${s.open_break_count} open`)}</b></> : null} · {L('额度', 'Limit')} <b>{breakQuota != null ? `${breakQuota}m` : L('不限', 'none')}</b></div></div>
              <div className="sd-sc"><div className="l">{L('净工时', 'Net worked')}</div>
                <div className="v">{s?.net_worked_ms == null ? <span className="mis">—</span> : `${hrs(s.net_worked_ms)} h`}</div>
                <div className="s">{s?.net_worked_ms == null ? L('缺少上班或下班卡', 'Clock in or out missing') : <>{L('在班', 'On shift')} <b>{fmtDur(s.shift_duration_ms)}</b> − {L('休息', 'breaks')} <b>{fmtDur(s.total_break_ms)}</b></>}</div></div>
            </div>

            <div className="sd-card">
              <div className="sd-ch"><h3>{L('打卡记录', 'Punch records')}</h3><span className="c">{L(`按 Telegram 消息时间排序 · 共 ${live} 笔`, `By Telegram message time · ${live} punches`)}{gone ? L(`（已删除 / 已修改 ${gone}）`, ` (${gone} deleted / edited)`) : ''}</span></div>
              {data.events.length === 0 ? <div className="mut sd-empty">{L('没有打卡记录', 'No punches')}</div> : (
                <table className="sd-t"><thead><tr><th>{L('时间', 'Time')}</th><th>{L('动作', 'Action')}</th><th>{L('员工消息', 'Message')}</th><th>{L('状态', 'Status')}</th>{!readOnly && <th>{L('操作', 'Action')}</th>}</tr></thead><tbody>
                  {data.events.map((e) => {
                    const adj = e.adjustment_id ? adjById.get(e.adjustment_id) : undefined;
                    const isEdit = !!adj?.target_event_id;
                    const delay = e.raw_received_at && e.telegram_message_ts ? e.raw_received_at - e.telegram_message_ts : 0;
                    const od = otherDay(e.event_ts);
                    return (
                      <tr key={e.id} className={e.is_voided ? 'vd' : ''}>
                        <td>{hms(e.event_ts)}{od && <div className="sd-sub">{od}</div>}</td>
                        <td><span className="ev"><i className={`dot ${EV_DOT[e.event_type]}`} />{dt(EVENT_LABEL[e.event_type])}</span></td>
                        <td className="msg">{e.source === 'TELEGRAM' ? (e.raw_text ?? '—')
                          : <><span className="b v">{isEdit ? L('管理员修改', 'Edited by admin') : L('管理员补录', 'Added by admin')}</span>{adj?.reason && <span className="rs"> {adj.reason}</span>}</>}</td>
                        <td>{e.is_voided ? <span className="b">{editedIds.has(e.id) ? L('已修改', 'Edited') : L('已删除', 'Deleted')}</span>
                          : e.sm_result ? <ExB code={e.sm_result} /> : <span className="b ok">{L('已记录', 'Recorded')}</span>}
                          {!e.is_voided && delay > 5 * 60000 && <> <span className="b w">{L('延迟', 'Delay')} {fmtDur(delay)}</span></>}</td>
                        {!readOnly && <td>{e.is_voided ? <span className="mut">—</span> : <><button className="btn sm" disabled={busy} onClick={() => setDlg({ kind: 'edit', ev: e })}>{L('编辑', 'Edit')}</button> <button className="btn sm d" disabled={busy} onClick={() => setDlg({ kind: 'del', ev: e })}>{L('删除', 'Delete')}</button></>}</td>}
                      </tr>
                    );
                  })}
                </tbody></table>
              )}
            </div>

            <div className="sd-two">
              <div className="sd-card">
                <div className="sd-ch"><h3>{L('休息明细', 'Breaks')}</h3><span className="c">{L('合计', 'Total')} {fmtDur(s?.total_break_ms ?? 0)}</span></div>
                {data.breaks.length ? (
                  <table className="sd-t"><thead><tr><th>#</th><th>{L('备注', 'Remark')}</th><th>{L('时间', 'Time')}</th><th>{L('时长', 'Duration')}</th></tr></thead><tbody>
                    {data.breaks.map((b) => <tr key={b.seq}><td>{b.seq}</td><td>{b.remark ?? <span className="mut">—</span>}</td><td>{hm(b.start_at)} – {b.end_at ? hm(b.end_at) : <span className="b r">{L('未结束', 'Open')}</span>}</td><td>{b.end_at ? fmtDur(b.duration_ms) : '—'}</td></tr>)}
                  </tbody></table>
                ) : <div className="mut sd-empty">{L('没有休息', 'No breaks')}</div>}
              </div>
              <div className="sd-card">
                <div className="sd-ch"><h3>{L('异常', 'Exceptions')}</h3><span className="c">{L(`${data.exceptions.length} 项`, `${data.exceptions.length}`)}</span></div>
                <div className="sd-exl">
                  {data.exceptions.length ? data.exceptions.map((x) => (
                    <div key={x.id} className="sd-exi"><ExB code={x.code} /><span className="x">{x.detail ? dt(parseBi(x.detail)) : ''}</span><span className="t">{hms(x.occurred_at)}</span></div>
                  )) : <div className="sd-exi"><span className="b ok">{L('无异常', 'No exceptions')}</span></div>}
                </div>
              </div>
            </div>

            {!readOnly && (
              <div className="sd-card">
                <div className="sd-ch"><h3>{L('管理员修正', 'Admin correction')}</h3><span className="c">{L('每次修正都会写入 Audit Log', 'Every correction is written to the audit log')}</span></div>
                <div className="sd-form">
                  <div><label>{L('补录动作', 'Add punch')}</label><select value={type} onChange={(e) => setType(e.target.value as EventType)}>{EVENT_TYPES.map((k) => <option key={k} value={k}>{dt(EVENT_LABEL[k])}</option>)}</select></div>
                  <div><label>{L('时间（斯里兰卡）', 'Time (Sri Lanka)')}</label><input type="datetime-local" step={1} value={ts || toLocalInput(defaultTs)} onChange={(e) => setTs(e.target.value)} /></div>
                  <div><label>{L('修正原因（必填）', 'Reason (required)')}</label><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={L('例如：员工忘记打 OUT，主管确认 16:30 离开', 'e.g. Forgot OUT; supervisor confirms left at 16:30')} /></div>
                </div>
                <div className="sd-ft"><div style={{ flex: 1 }}><ErrBox error={err} /></div><button className="btn p" disabled={busy} onClick={save}>{L('保存修正', 'Save correction')}</button></div>
                {data.adjustments.length > 0 && (
                  <>
                    <div className="sd-hh">{L('修正历史', 'Correction history')}</div>
                    <table className="sd-t"><thead><tr><th>{L('时间', 'Time')}</th><th>{L('管理员', 'Admin')}</th><th>{L('动作', 'Action')}</th><th>{L('原因', 'Reason')}</th></tr></thead><tbody>
                      {adjHistory(data, dt, L, hms).map((h) => <tr key={h.key}><td>{fmtDT(h.at)}</td><td>{h.by}</td><td>{h.what}</td><td className="msg" style={{ whiteSpace: 'normal' }}>{h.reason}</td></tr>)}
                    </tbody></table>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
      </div>
      {dlg && data && <PunchDialog kind={dlg.kind} ev={dlg.ev} date={date} busy={busy} onClose={() => setDlg(null)} onSubmit={async (body, msg) => { const e = await post(body, msg); if (!e) setDlg(null); return e; }} />}
    </Drawer>
  );
}

/** Correction history: an edit (VOID + ADD saved together) is shown as one line. */
function adjHistory(data: Detail, dt: (b: { zh: string; en: string }) => string, L: (zh: string, en: string) => string, hms: (ms: number) => string) {
  const evById = new Map(data.events.map((e) => [e.id, e]));
  const list = [...data.adjustments].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  const out: { key: number; at: number; by: string; what: string; reason: string }[] = [];
  const pairedVoid = new Set(list.filter((a) => a.action === 'ADD_EVENT' && a.target_event_id).map((a) => `${a.created_at}|${a.target_event_id}`));
  for (const a of list) {
    const old = a.target_event_id ? evById.get(a.target_event_id) : undefined;
    const oldTxt = old ? `${dt(EVENT_LABEL[old.event_type])} ${hms(old.event_ts)}` : `#${a.target_event_id}`;
    if (a.action === 'VOID_EVENT' && pairedVoid.has(`${a.created_at}|${a.target_event_id}`)) continue;
    const what = a.action === 'ADD_EVENT'
      ? a.target_event_id ? `${L('修改', 'Edit')} ${oldTxt} → ${dt(EVENT_LABEL[a.event_type!])} ${hms(a.event_ts!)}` : `${L('补录', 'Add')} ${dt(EVENT_LABEL[a.event_type!])} ${hms(a.event_ts!)}`
      : `${L('删除', 'Delete')} ${oldTxt}`;
    out.push({ key: a.id, at: a.created_at, by: a.created_by, what, reason: a.reason });
  }
  return out;
}

function PunchDialog({ kind, ev, date, busy, onClose, onSubmit }: { kind: 'edit' | 'del'; ev: Ev; date: string; busy: boolean; onClose: () => void; onSubmit: (body: Record<string, unknown>, msg: string) => Promise<ApiErr | null> }) {
  const { L, dt } = useI18n();
  const [type, setType] = useState<EventType>(ev.event_type);
  const [ts, setTs] = useState(toLocalInput(ev.event_ts));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const orig = `${dt(EVENT_LABEL[ev.event_type])} · ${fmtDT(ev.event_ts).slice(fmtDT(ev.event_ts).slice(0, 10) === date ? 11 : 0)}${ev.raw_text ? ` · 「${ev.raw_text}」` : ''}`;
  const ok = async () => {
    setErr(null);
    if (reason.trim().length < 4) return setErr(new Error(kind === 'edit' ? L('请填写修改原因（至少 4 个字）', 'Please give a reason (at least 4 characters)') : L('请填写删除原因（至少 4 个字）', 'Please give a reason (at least 4 characters)')));
    if (kind === 'del') { const e = await onSubmit({ action: 'VOID_EVENT', targetEventId: ev.id, reason }, L('已删除，数字已重新计算', 'Deleted; figures recalculated')); if (e) setErr(e); return; }
    const t = fromLocalInput(ts);
    if (t == null) return setErr(new Error(L('请填写时间', 'Please enter a time')));
    if (t === ev.event_ts && type === ev.event_type) return setErr(new Error(L('没有任何修改', 'Nothing changed')));
    const e = await onSubmit({ action: 'EDIT_EVENT', targetEventId: ev.id, eventType: type, ts: t, reason }, L('已修改，数字已重新计算', 'Edited; figures recalculated'));
    if (e) setErr(e);
  };
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{kind === 'edit' ? L('编辑这笔打卡', 'Edit this punch') : L('删除这笔打卡', 'Delete this punch')}</h3>
      <div className="sd-orig">{kind === 'edit' ? L('原本：', 'Original: ') : ''}{orig}</div>
      {kind === 'del' && <p className="mut" style={{ fontSize: 12.5, margin: '0 0 12px' }}>{L('删除后这笔不计入考勤，系统会重新计算。原始 Telegram 消息仍保留，可在 Audit Log 查到。', 'The punch stops counting and figures are recalculated. The original Telegram message is kept and the change is in the audit log.')}</p>}
      <div className="fg">
        {kind === 'edit' && <>
          <div><label>{L('动作', 'Action')}</label><select value={type} onChange={(e) => setType(e.target.value as EventType)}>{EVENT_TYPES.map((k) => <option key={k} value={k}>{dt(EVENT_LABEL[k])}</option>)}</select></div>
          <div><label>{L('时间（斯里兰卡）', 'Time (Sri Lanka)')}</label><input type="datetime-local" step={1} value={ts} onChange={(e) => setTs(e.target.value)} /></div>
        </>}
      </div>
      <div style={{ marginTop: 10 }}><label className="mut" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{kind === 'edit' ? L('修改原因（必填）', 'Reason (required)') : L('删除原因（必填）', 'Reason (required)')}</label>
        <input type="text" style={{ width: '100%' }} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === 'edit' ? L('例如：员工打错，主管确认实际 16:30 下班', 'e.g. Wrong punch; supervisor confirms 16:30') : L('例如：员工误打，实际没有休息', 'e.g. Sent by mistake; no actual break')} /></div>
      <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        <button className="btn" onClick={onClose}>{L('取消', 'Cancel')}</button>
        <button className={`btn ${kind === 'del' ? 'dd' : 'p'}`} disabled={busy} onClick={ok}>{kind === 'edit' ? L('保存修改', 'Save') : L('删除', 'Delete')}</button>
      </div>
    </Modal>
  );
}
