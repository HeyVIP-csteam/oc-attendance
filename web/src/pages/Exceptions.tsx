import { useState } from 'react';
import { EVENT_LABEL, EVENT_TYPES, type EventType } from '../../../src/shared/codes';
import { Cnt, EmpSearch, Empty, ErrBox, ExB, exLabel, Field, KvList, Modal, ModalActions, Pager, SevB, Tabs, TblTop, jsonOrNull } from '../components/ui';
import { api, type ApiErr, qs } from '../lib/api';
import { fmtDT, fromLocalInput, toLocalInput } from '../lib/format';
import { parseBi, useI18n } from '../lib/i18n';
import { toast, useApi, useData, usePageState } from '../lib/store';

interface ExRow { id: number; code: string; severity: string; status: 'OPEN' | 'RESOLVED' | 'DISMISSED'; source: string; occurred_at: number; work_date: string; detail: string | null; note: string | null; handled_by: string | null; handled_at: number | null; employee_id: number | null; employee_code: string | null; name: string | null; raw_text: string | null; message_thread_id: number | null }

export function Exceptions() {
  const { L } = useI18n();
  const [f, set] = usePageState('ex', () => ({ tab: 'ex' as 'ex' | 'au' | 'raw', code: '', sev: '', status: 'OPEN', q: '', page: 1, apage: 1, rpage: 1, size: 10 }));
  return (
    <>
      <Tabs items={[['ex', L('异常', 'Exceptions')], ['au', 'Audit Log'], ['raw', L('原始消息', 'Raw messages')]]} value={f.tab} onChange={(tab) => set({ tab })} />
      {f.tab === 'ex' && <ExList f={f} set={set} />}
      {f.tab === 'au' && <AuditList page={f.apage} size={f.size} onPage={(apage) => set({ apage })} onSize={(size) => set({ size, apage: 1 })} />}
      {f.tab === 'raw' && <RawList page={f.rpage} size={f.size} onPage={(rpage) => set({ rpage })} onSize={(size) => set({ size, rpage: 1 })} />}
    </>
  );
}

const stLabel = (s: string, L: (a: string, b: string) => string) => (s === 'OPEN' ? L('待处理', 'Open') : s === 'RESOLVED' ? L('已处理', 'Resolved') : L('已驳回', 'Dismissed'));

function ExList({ f, set }: { f: { code: string; sev: string; status: string; q: string; page: number; size: number }; set: (p: Partial<{ code: string; sev: string; status: string; q: string; page: number; size: number }>) => void }) {
  const { L, dt } = useI18n();
  const { readOnly } = useData();
  const { data, error } = useApi<{ total: number; rows: ExRow[]; codes: string[] }>(`/exceptions?${qs({ code: f.code, sev: f.sev, status: f.status, q: f.q, page: f.page, size: f.size })}`);
  const [edit, setEdit] = useState<ExRow | null>(null);
  const setF = (p: Partial<typeof f>) => set({ ...p, page: 1 });
  return (
    <>
      <div className="card"><div className="row">
        <Field label={L('类型', 'Type')}><select value={f.code} onChange={(e) => setF({ code: e.target.value })}><option value="">{L('全部类型', 'All types')}</option>{(data?.codes ?? []).map((c) => <option key={c} value={c}>{dt(exLabel(c))}</option>)}</select></Field>
        <Field label={L('严重级', 'Severity')}><select value={f.sev} onChange={(e) => setF({ sev: e.target.value })}><option value="">{L('全部', 'All')}</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option></select></Field>
        <Field label={L('处理状态', 'Status')}><select value={f.status} onChange={(e) => setF({ status: e.target.value })}><option value="">{L('全部', 'All')}</option>{['OPEN', 'RESOLVED', 'DISMISSED'].map((s) => <option key={s} value={s}>{stLabel(s, L)}</option>)}</select></Field>
        <Field label={L('员工', 'Employee')}><EmpSearch value={f.q} onChange={(q) => setF({ q })} /></Field>
      </div></div>
      <ErrBox error={error} />
      {data && (data.rows.length === 0 ? <Empty>{L('没有符合条件的异常 🎉', 'No exceptions match these filters 🎉')}</Empty> : (
        <>
          <TblTop left={<Cnt n={data.total} />} size={f.size} onSize={(size) => set({ size, page: 1 })} />
          <div className="tw"><table className="grid extbl"><thead><tr>
            <th>{L('员工', 'Employee')}</th><th>{L('日期', 'Date')}</th><th>{L('类型', 'Type')}</th><th>{L('严重级', 'Severity')}</th><th>{L('原始消息', 'Raw message')}</th><th>{L('说明', 'Detail')}</th>
            <th>{L('状态', 'Status')}</th><th>{L('编辑人', 'By')}</th><th>{L('更新时间', 'Update Time')}</th><th className="c">{L('操作', 'Action')}</th>
          </tr></thead><tbody>
            {data.rows.map((x) => (
              <tr key={x.id}>
                <td className="nw">{x.employee_code ? <><b>{x.employee_code}</b> {x.name}</> : <span className="b r">{L('未知', 'Unknown')}</span>}</td>
                <td className="nw">{fmtDT(x.occurred_at)}</td><td><ExB code={x.code} /></td><td><SevB sev={x.severity} /></td>
                <td>{x.raw_text != null ? <>「{x.raw_text}」<div className="mut" style={{ fontSize: 11 }}>thread {x.message_thread_id ?? 'General'}</div></> : <span className="mut">—</span>}</td>
                <td>{x.detail ? dt(parseBi(x.detail)) : <span className="mut">—</span>}</td>
                <td><span className={`b ${x.status === 'OPEN' ? 'w' : x.status === 'RESOLVED' ? 'ok' : ''}`} title={x.note ?? undefined}>{stLabel(x.status, L)}</span></td>
                <td className="nw">{x.handled_by ?? <span className="mut">—</span>}</td><td className="nw">{x.handled_at ? fmtDT(x.handled_at) : <span className="mut">—</span>}</td>
                <td className="nw">{!readOnly && <button className="btn sm" onClick={() => setEdit(x)}>{L('编辑', 'Edit')}</button>}</td>
              </tr>
            ))}
          </tbody></table></div>
          <Pager total={data.total} page={f.page} size={f.size} onPage={(page) => set({ page })} />
        </>
      ))}
      {edit && <ExModal x={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

interface Fix { employeeId: number; workDate: string; type: EventType; ts: number; on: boolean; reason: { zh: string; en: string } }

function ExModal({ x, onClose }: { x: ExRow; onClose: () => void }) {
  const { L, dt } = useI18n();
  const { refresh } = useData();
  const fixR = useApi<{ fix: Fix | null }>(`/exceptions/${x.id}/fix`);
  const fx = fixR.data?.fix ?? null;
  const [st, setSt] = useState<string>(x.status === 'OPEN' ? 'RESOLVED' : x.status);
  const [note, setNote] = useState(x.note ?? '');
  const [fixOn, setFixOn] = useState<boolean | null>(null);
  const [type, setType] = useState<EventType | null>(null);
  const [ts, setTs] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const on = fixOn ?? fx?.on ?? false;
  const save = async () => {
    const body: Record<string, unknown> = { status: st, note };
    if (fx && on) {
      const t = fromLocalInput(ts || toLocalInput(fx.ts));
      if (t == null) return setErr(new Error(L('请填写时间', 'Please enter a time')));
      let r = (reason ?? dt(fx.reason)).trim() || L('异常修正', 'Exception fix');
      if (r.length < 4) r += ' · ' + dt(exLabel(x.code));
      body.fix = { employeeId: fx.employeeId, workDate: fx.workDate, eventType: type ?? fx.type, ts: t, reason: r };
    }
    setBusy(true);
    try {
      await api(`/exceptions/${x.id}`, { method: 'PUT', body });
      toast(body.fix ? L('已保存，考勤已修正', 'Saved; attendance fixed') : L('已保存', 'Saved'));
      refresh();
      onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{L('编辑异常', 'Edit exception')}</h3>
      <div className="kv">
        <div><span>{L('类型', 'Type')}</span><ExB code={x.code} /></div>
        <div><span>{L('员工', 'Employee')}</span><b>{x.employee_code ? `${x.employee_code} ${x.name}` : '—'}</b></div>
        <div><span>{L('发生时间', 'Occurred')}</span><b>{fmtDT(x.occurred_at)}</b></div>
        {x.raw_text != null && <div><span>{L('原始消息', 'Raw message')}</span><b>「{x.raw_text}」</b></div>}
      </div>
      <div style={{ marginTop: 14 }}><label className="mut" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{L('状态', 'Status')}</label>
        <div className="stseg">{['OPEN', 'RESOLVED', 'DISMISSED'].map((s) => <label key={s}><input type="radio" name="xSt" checked={st === s} onChange={() => setSt(s)} /><span>{stLabel(s, L)}</span></label>)}</div>
      </div>
      <div style={{ marginTop: 12 }}><label className="mut" style={{ fontSize: 12 }}>{L('备注（可选）', 'Note (optional)')}</label><input type="text" style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      {fx && (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={on} onChange={(e) => setFixOn(e.target.checked)} /> {L('同时修正考勤', 'Also fix attendance')}</label>
          {on && (
            <div className="fixbox"><div className="fg">
              <div><label>{L('补录事件', 'Add event')}</label><select value={type ?? fx.type} onChange={(e) => setType(e.target.value as EventType)}>{EVENT_TYPES.map((k) => <option key={k} value={k}>{dt(EVENT_LABEL[k])}</option>)}</select></div>
              <div><label>{L('时间（LK）', 'Time (LK)')}</label><input type="datetime-local" step={1} value={ts || toLocalInput(fx.ts)} onChange={(e) => setTs(e.target.value)} /></div>
              <div style={{ gridColumn: '1/-1' }}><label>{L('修正原因', 'Reason')}</label><input type="text" value={reason ?? dt(fx.reason)} onChange={(e) => setReason(e.target.value)} /></div>
            </div></div>
          )}
        </>
      )}
      <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={save} busy={busy} />
    </Modal>
  );
}

function AuditList({ page, size, onPage, onSize }: { page: number; size: number; onPage: (p: number) => void; onSize: (n: number) => void }) {
  const { L } = useI18n();
  const { data, error } = useApi<{ total: number; rows: { id: number; created_at: number; actor: string; action: string; entity_type: string; entity_id: string | null; before_json: string | null; after_json: string | null; note: string | null }[] }>(`/audit?${qs({ page, size })}`);
  return (
    <>
      <ErrBox error={error} />
      {data && (
        <>
          <TblTop left={<Cnt n={data.total} />} size={size} onSize={onSize} />
          <div className="tw"><table className="grid autbl"><thead><tr><th>{L('时间', 'Time')}</th><th>Actor</th><th>Action</th><th>Entity</th><th>Before</th><th>After</th><th>Note</th></tr></thead><tbody>
            {data.rows.map((a) => {
              const b = jsonOrNull(a.before_json);
              return <tr key={a.id}><td>{fmtDT(a.created_at)}</td><td>{a.actor}</td><td><span className="b i">{a.action}</span></td><td>{a.entity_type} #{a.entity_id}</td><td><KvList obj={b} /></td><td><KvList obj={jsonOrNull(a.after_json)} other={b} /></td><td style={{ minWidth: 220, maxWidth: 340, overflowWrap: 'anywhere' }}>{a.note}</td></tr>;
            })}
          </tbody></table></div>
          <Pager total={data.total} page={page} size={size} onPage={onPage} />
        </>
      )}
    </>
  );
}

function RawList({ page, size, onPage, onSize }: { page: number; size: number; onPage: (p: number) => void; onSize: (n: number) => void }) {
  const { L } = useI18n();
  const { data, error } = useApi<{ total: number; rows: { id: number; received_at: number; telegram_message_ts: number; message_id: number; message_thread_id: number | null; from_user_id: number | null; raw_text: string | null; parsed_event_type: string | null; processing_status: string; error_code: string | null; is_edit: number }[] }>(`/messages?${qs({ page, size })}`);
  return (
    <>
      <ErrBox error={error} />
      {data && (
        <>
          <TblTop left={<Cnt n={data.total} />} size={size} onSize={onSize} />
          <div className="tw"><table className="grid rwtbl"><thead><tr><th>{L('接收', 'Received')}</th><th>{L('Telegram 时间', 'Telegram Time')}</th><th>msg_id</th><th>thread</th><th>from.id</th><th>{L('内容', 'Text')}</th><th>Parsed</th><th>Status</th><th>Codes</th></tr></thead><tbody>
            {data.rows.map((r) => (
              <tr key={r.id}><td>{fmtDT(r.received_at)}</td><td>{fmtDT(r.telegram_message_ts)}</td><td>{r.message_id}{r.is_edit ? <> <span className="b v">edited</span></> : null}</td><td>{r.message_thread_id ?? '—'}</td>
                <td><code>{r.from_user_id}</code></td><td>{r.raw_text}</td><td>{r.parsed_event_type ?? '—'}</td>
                <td><span className={`b ${r.processing_status === 'PROCESSED' || r.processing_status === 'REPARSED' ? 'ok' : r.processing_status === 'IGNORED' ? '' : 'w'}`}>{r.processing_status}</span></td><td>{r.error_code ?? ''}</td></tr>
            ))}
          </tbody></table></div>
          <Pager total={data.total} page={page} size={size} onPage={onPage} />
        </>
      )}
    </>
  );
}
