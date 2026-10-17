import { useState } from 'react';
import { EVENT_LABEL, EVENT_TYPES, type EventType, STATUSES } from '../../../src/shared/codes';
import { addDays } from '../../../src/shared/time';
import { Cnt, CurB, CurrencyOptions, Drawer, EmpSearch, Empty, ErrBox, ExB, Field, KvList, Mut, Pager, ShiftOptions, StatusBadge, StatusOptions, TblTop, jsonOrNull } from '../components/ui';
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
  instance: { id: number; shift_name: string; adjustment_status: string; source: string; late_grace_min: number; early_grace_min: number; scheduled_start_at: number; scheduled_end_at: number } | null;
  session: AttRow & { scheduled_start_at: number | null } | null;
  events: { id: number; event_type: EventType; event_ts: number; source: string; is_voided: number; sm_result: string | null; adjustment_id: number | null; raw_text: string | null; tg_message_id: number | null; message_thread_id: number | null; from_user_id: number | null; telegram_message_ts: number | null; raw_received_at: number | null; processed_at: number | null }[];
  breaks: { seq: number; start_at: number; end_at: number | null; duration_ms: number | null; status: string; remark: string | null }[];
  exceptions: { id: number; code: string; occurred_at: number; detail: string | null; status: string }[];
  adjustments: { id: number; action: string; event_type: EventType | null; event_ts: number | null; target_event_id: number | null; reason: string; before_json: string | null; after_json: string | null; created_by: string; created_at: number }[];
}

export function SessionDrawer({ emp, date, onClose }: { emp: number; date: string; onClose: () => void }) {
  const { L, dt } = useI18n();
  const { refresh, readOnly } = useData();
  const { data, error, reload } = useApi<Detail>(`/sessions/${emp}/${date}`);
  const [type, setType] = useState<EventType>('CLOCK_OUT');
  const [ts, setTs] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const s = data?.session;
  const inst = data?.instance;
  const defaultTs = s?.actual_out_at ?? s?.scheduled_end_at ?? s?.actual_in_at ?? Date.now();
  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/sessions/${emp}/${date}/adjustments`, { method: 'POST', body });
      toast(L('修正已保存，并写入 Audit Log', 'Adjustment saved and written to the audit log'));
      setReason('');
      await reload();
      refresh();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  const save = () => {
    const t = fromLocalInput(ts || toLocalInput(defaultTs));
    if (t == null) return setErr(new Error(L('请填写时间', 'Please enter a time')));
    if (reason.trim().length < 4) return setErr(new Error(L('必须填写修正原因（至少 4 个字）', 'A reason is required (at least 4 characters)')));
    void post({ action: 'ADD_EVENT', eventType: type, ts: t, reason });
  };
  const voidEv = (id: number) => {
    const r = prompt(L('作废此事件的原因（必填，至少 4 个字）：', 'Reason for voiding this event (required, at least 4 characters):'));
    if (r == null) return;
    if (r.trim().length < 4) { alert(L('原因至少 4 个字', 'The reason needs at least 4 characters')); return; }
    void post({ action: 'VOID_EVENT', targetEventId: id, reason: r });
  };
  const adjMap = new Map((data?.adjustments ?? []).map((a) => [a.id, a]));
  return (
    <Drawer onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{data ? `${data.employee.employee_code} ${data.employee.name}` : '…'} · {date}</h2>
        <button className="btn" onClick={onClose}>{L('关闭', 'Close')}</button>
      </div>
      <ErrBox error={error} />
      {data && (
        <>
          <p className="mut">{data.employee.currency_code ? data.employee.currency_code + ' · ' : ''}{inst ? inst.shift_name : L('未排班', 'No schedule')}{inst ? `（${L('实例', 'instance')} #${inst.id}, ${inst.adjustment_status}, ${inst.source}）` : ''} · {L('斯里兰卡时间', 'Sri Lanka time')}</p>
          <div className="kv">
            <div><span>{L('状态', 'Status')}</span>{s ? <StatusBadge st={s.status} /> : '—'}</div><div><span>{L('缺卡', 'Missing Punch')}</span><b>{s?.missing ?? '—'}</b></div>
            <div><span>{L('排班上班', 'Scheduled In')}</span><b>{fmtDT(s?.scheduled_start_at)}</b></div><div><span>{L('实际上班', 'Actual In')}</span><b>{fmtDT(s?.actual_in_at)}</b></div>
            <div><span>{L('迟到', 'Late')}</span><b style={s?.late_min ? { color: LATE_RED } : undefined}>{s?.late_min ? fmtMin(s.late_min) : s?.late_min ?? '—'}</b> <span className="mut">{L('宽限', 'grace')} {inst ? inst.late_grace_min : '—'}m</span></div>
            <div><span>{L('排班下班', 'Scheduled Out')}</span><b>{fmtDT(s?.scheduled_end_at)}</b></div><div><span>{L('实际下班', 'Actual Out')}</span><b>{fmtDT(s?.actual_out_at)}</b></div>
            <div><span>{L('早退', 'Early Leave')}</span><b style={s?.early_min ? { color: LATE_RED } : undefined}>{s?.early_min ? fmtMin(s.early_min) : s?.early_min ?? '—'}</b> <span className="mut">{L('宽限', 'grace')} {inst ? inst.early_grace_min : '—'}m</span></div>
            <div><span>{L('班次总时长', 'Total Shift')}</span><b>{fmtDur(s?.shift_duration_ms)}</b></div><div><span>{L('休息（完成 / 未结束）', 'Breaks (done / open)')}</span><b>{s ? `${s.break_count} / ${s.open_break_count}` : '—'}</b></div>
            <div><span>{L('休息总时长', 'Total Break')}</span><b>{fmtDur(s?.total_break_ms ?? 0)}</b></div>
            <div><span>{L('净工时', 'Net Worked')}</span><b>{s?.net_worked_ms == null ? L('—（不完整）', '— (incomplete)') : `${fmtDur(s.net_worked_ms)} · ${hrs(s.net_worked_ms)}h`}</b></div>
            <div><span>{L('休息规则', 'Break Rule')}</span><b>{s?.break_exceeded == null ? L('未配置（不判定）', 'Not set (not judged)') : s.break_exceeded ? L('超出', 'Exceeded') : L('符合', 'Within rule')}</b></div>
          </div>
          <div className="split" style={{ marginTop: 14 }}>
            <div className="card"><h3>{L('事件时间线（按 Telegram 时间排序）', 'Event timeline (by Telegram time)')}</h3><div className="tl">
              {data.events.length === 0 && <div className="mut">{L('没有事件', 'No events')}</div>}
              {data.events.map((e) => {
                const bad = !!e.sm_result && e.sm_result !== 'CLOCK_OUT_DURING_BREAK';
                if (e.is_voided) return <div key={e.id} className="it bad"><s>{dt(EVENT_LABEL[e.event_type])} · {fmtDT(e.event_ts)}</s> <span className="b">{L('已作废', 'Voided')}</span></div>;
                const delay = e.raw_received_at && e.telegram_message_ts ? e.raw_received_at - e.telegram_message_ts : 0;
                return (
                  <div key={e.id} className={`it ${bad ? 'bad' : ''} ${e.source === 'ADMIN' ? 'adm' : ''}`}>
                    <b>{dt(EVENT_LABEL[e.event_type])}</b> · {fmtDT(e.event_ts)} {e.source === 'ADMIN' && <span className="b v">{L('管理员补录', 'Added by admin')}</span>} {e.sm_result && <ExB code={e.sm_result} />}
                    <div className="mut" style={{ fontSize: 12 }}>
                      {e.source === 'TELEGRAM'
                        ? <>{L('原始消息', 'Raw message')}「{e.raw_text}」· message_id {e.tg_message_id} · thread {e.message_thread_id ?? '—'} · from {e.from_user_id}<br />
                          {L('Telegram 时间', 'Telegram time')} {fmtDT(e.telegram_message_ts)} · {L('接收', 'received')} {fmtDT(e.raw_received_at)} · {L('处理', 'processed')} {fmtDT(e.processed_at)} {delay > 5 * 60000 && <span className="b w">{L('延迟', 'delay')} {fmtDur(delay)}</span>}</>
                        : <>{L('来源：管理员修正 #', 'Source: admin adjustment #')}{e.adjustment_id} · {adjMap.get(e.adjustment_id!)?.reason}</>}
                    </div>
                    {!readOnly && <button className="btn sm d" style={{ marginTop: 4 }} disabled={busy} onClick={() => voidEv(e.id)}>{L('作废此事件', 'Void this event')}</button>}
                  </div>
                );
              })}
            </div></div>
            <div>
              <div className="card"><h3>{L('休息明细', 'Breaks')}</h3>{data.breaks.length ? (
                <div className="tw"><table><thead><tr><th>#</th><th>{L('备注', 'Remark')}</th><th>{L('开始', 'Start')}</th><th>{L('结束', 'End')}</th><th className="n">{L('时长', 'Duration')}</th><th>{L('状态', 'Status')}</th></tr></thead><tbody>
                  {data.breaks.map((b) => <tr key={b.seq}><td>#{b.seq}</td><td>{b.remark ?? <span className="mut">—</span>}</td><td>{fmtT(b.start_at)}</td><td>{b.end_at ? fmtT(b.end_at) : <span className="b r">{L('未结束', 'Open')}</span>}</td><td className="n">{fmtDur(b.duration_ms)}</td><td>{b.status === 'OPEN' ? <span className="b r">OPEN</span> : <span className="b ok">CLOSED</span>}</td></tr>)}
                </tbody></table></div>) : <div className="mut">{L('无休息记录', 'No breaks')}</div>}
              </div>
              <div className="card"><h3>{L('异常', 'Exceptions')}（{data.exceptions.length}）</h3>
                {data.exceptions.length ? data.exceptions.map((x) => <div key={x.id} style={{ margin: '4px 0' }}><ExB code={x.code} /> <span className="mut" style={{ fontSize: 12 }}>{dt(parseBi(x.detail))} {fmtDT(x.occurred_at)}</span></div>) : <div className="mut">{L('无', 'None')}</div>}
              </div>
            </div>
          </div>
          {!readOnly && (
            <div className="card"><h3>{L('管理员修正', 'Admin adjustment')}</h3>
              <div className="fg">
                <div><label>{L('动作', 'Action')}</label><select><option>{L('补录事件', 'Add event')}</option></select></div>
                <div><label>{L('事件类型', 'Event type')}</label><select value={type} onChange={(e) => setType(e.target.value as EventType)}>{EVENT_TYPES.map((k) => <option key={k} value={k}>{dt(EVENT_LABEL[k])}</option>)}</select></div>
                <div><label>{L('时间（斯里兰卡）', 'Time (Sri Lanka)')}</label><input type="datetime-local" step={1} value={ts || toLocalInput(defaultTs)} onChange={(e) => setTs(e.target.value)} /></div>
              </div>
              <div style={{ marginTop: 10 }}><label className="mut" style={{ fontSize: 12 }}>{L('修正原因（必填）', 'Reason (required)')}</label><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={L('例如：员工忘记打 OUT，主管确认 18:05 离开', 'e.g. Employee forgot OUT; supervisor confirms left at 18:05')} /></div>
              <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
              <button className="btn p" style={{ marginTop: 8 }} disabled={busy} onClick={save}>{L('保存修正', 'Save adjustment')}</button>
              {data.adjustments.length > 0 && (
                <>
                  <h3 style={{ marginTop: 16 }}>{L('修正历史', 'Adjustment history')}</h3>
                  <div className="tw"><table className="grid"><thead><tr><th>{L('时间', 'Time')}</th><th>{L('管理员', 'Admin')}</th><th>{L('动作', 'Action')}</th><th>{L('原因', 'Reason')}</th><th>{L('修改前', 'Before')}</th><th>{L('修改后', 'After')}</th></tr></thead><tbody>
                    {data.adjustments.map((a) => <tr key={a.id}><td>{fmtDT(a.created_at)}</td><td>{a.created_by}</td><td>{a.action === 'ADD_EVENT' ? `${L('补录 ', 'Add ')}${dt(EVENT_LABEL[a.event_type!])} ${fmtDT(a.event_ts)}` : `${L('作废 #', 'Void #')}${a.target_event_id}`}</td><td style={{ whiteSpace: 'normal' }}>{a.reason}</td><td><KvList obj={jsonOrNull(a.before_json)} /></td><td><KvList obj={jsonOrNull(a.after_json)} other={jsonOrNull(a.before_json)} /></td></tr>)}
                  </tbody></table></div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
