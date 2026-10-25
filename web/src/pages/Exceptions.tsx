import { useState } from 'react';
import { EVENT_LABEL, EVENT_TYPES, type EventType } from '../../../src/shared/codes';
import { Cnt, EmpSearch, Empty, ErrBox, ExB, exLabel, Field, KvList, Modal, ModalActions, Pager, SevB, Tabs, TblTop, jsonOrNull } from '../components/ui';
import { api, type ApiErr, qs } from '../lib/api';
import { readTelegramExport, type ExportMsg } from '../../../src/shared/tgexport';
import { fmtDT, fromLocalInput, toLocalInput } from '../lib/format';
import { parseBi, useI18n } from '../lib/i18n';
import { toast, useApi, useData, usePageState } from '../lib/store';

interface ExRow { id: number; code: string; severity: string; status: 'OPEN' | 'RESOLVED' | 'DISMISSED'; source: string; occurred_at: number; work_date: string; detail: string | null; note: string | null; handled_by: string | null; handled_at: number | null; employee_id: number | null; employee_code: string | null; name: string | null; raw_text: string | null; message_thread_id: number | null }

export function Exceptions() {
  const { L } = useI18n();
  const [f, set] = usePageState('ex', () => ({ tab: 'ex' as 'ex' | 'au' | 'raw' | 'imp', code: '', sev: '', status: 'OPEN', q: '', page: 1, apage: 1, rpage: 1, size: 10 }));
  return (
    <>
      <Tabs items={[['ex', L('异常', 'Exceptions')], ['au', 'Audit Log'], ['raw', L('原始消息', 'Raw messages')], ...(useData().readOnly ? [] : [['imp', L('导入 Telegram 记录', 'Import Telegram history')] as ['imp', string]])]} value={f.tab} onChange={(tab) => set({ tab })} />
      {f.tab === 'ex' && <ExList f={f} set={set} />}
      {f.tab === 'au' && <AuditList page={f.apage} size={f.size} onPage={(apage) => set({ apage })} onSize={(size) => set({ size, apage: 1 })} />}
      {f.tab === 'imp' && <TgImport />}
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
            <th className="pid">{L('PSD ID', 'PSD ID')}</th><th>{L('员工姓名', 'Employee Name')}</th><th>{L('日期', 'Date')}</th><th>{L('类型', 'Type')}</th><th>{L('严重级', 'Severity')}</th><th>{L('原始消息', 'Raw message')}</th><th>{L('说明', 'Detail')}</th>
            <th>{L('状态', 'Status')}</th><th>{L('编辑人', 'By')}</th><th>{L('更新时间', 'Update Time')}</th><th className="c">{L('操作', 'Action')}</th>
          </tr></thead><tbody>
            {data.rows.map((x) => (
              <tr key={x.id}>
                <td className="nw pid">{x.employee_code ? <b>{x.employee_code}</b> : <span className="b r">{L('未知', 'Unknown')}</span>}</td><td className="nw">{x.name ?? <span className="mut">—</span>}</td>
                <td className="nw">{fmtDT(x.occurred_at)}</td><td><ExB code={x.code} /></td><td><SevB sev={x.severity} /></td>
                <td>{x.raw_text != null ? <>「{x.raw_text}」</> : <span className="mut">—</span>}</td>
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

interface Fix { employeeId: number; workDate: string; type: EventType; ts: number; on: boolean; reason: { zh: string; en: string }; targetEventId?: number | null }

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
      body.fix = { employeeId: fx.employeeId, workDate: fx.workDate, eventType: type ?? fx.type, ts: t, reason: r, targetEventId: fx.targetEventId ?? null };
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
        <div><span>PSD ID</span><b>{x.employee_code ?? '—'}</b></div><div><span>{L('员工姓名', 'Employee Name')}</span><b>{x.name ?? '—'}</b></div>
        <div><span>{L('发生时间', 'Occurred')}</span><b>{fmtDT(x.occurred_at)}</b></div>
        {x.raw_text != null && <div><span>{L('原始消息', 'Raw message')}</span><b>「{x.raw_text}」</b></div>}
      </div>
      <div style={{ marginTop: 14 }}><label className="mut" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{L('状态', 'Status')}</label>
        <div className="stseg">{['OPEN', 'RESOLVED', 'DISMISSED'].map((s) => <label key={s}><input type="radio" name="xSt" checked={st === s} onChange={() => setSt(s)} /><span>{stLabel(s, L)}</span></label>)}</div>
      </div>
      <div style={{ marginTop: 12 }}><label className="mut" style={{ fontSize: 12 }}>{L('备注（可选）', 'Note (optional)')}</label><input type="text" style={{ width: '100%' }} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      {fx && (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, fontSize: 13, cursor: 'pointer' }}><input type="checkbox" checked={on} onChange={(e) => setFixOn(e.target.checked)} /> {fx.targetEventId ? L('同时修改上班时间（批准）', 'Also correct the clock-in time (approve)') : L('同时修正考勤', 'Also fix attendance')}</label>
          {on && (
            <div className="fixbox"><div className="fg">
              <div><label>{fx.targetEventId ? L('修改为', 'Change to') : L('补录事件', 'Add event')}</label><select value={type ?? fx.type} onChange={(e) => setType(e.target.value as EventType)}>{EVENT_TYPES.map((k) => <option key={k} value={k}>{dt(EVENT_LABEL[k])}</option>)}</select></div>
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
              return <tr key={a.id}><td className="nw">{fmtDT(a.created_at)}</td><td className="nw">{a.actor}</td><td><span className="b i">{a.action}</span></td><td>{a.entity_type} #{a.entity_id}</td><td><KvList obj={b} /></td><td><KvList obj={jsonOrNull(a.after_json)} other={b} /></td><td style={{ minWidth: 220, maxWidth: 340, overflowWrap: 'anywhere' }}>{a.note}</td></tr>;
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

// ---------------------------------------------------------------- import a Telegram Desktop chat export (punches sent before the bot joined)
interface ImpRow { id: number; time: string; workDate: string; text: string; code: string | null; name: string | null; type: EventType | null; thread: number | null; from: string; fromId: number | null; key: string | null; who: string | null; result: 'NEW' | 'DUP' | 'UNREC' | 'NOTOPIC' | 'NEED' | 'INACTIVE' | 'UNTRUSTED' }
/** A Telegram account in a group without topics and the employee it belongs to. */
interface ImpSender { key: string; kind: 'ACCOUNT' | 'NAME'; name: string; account: string; spellings: string[]; agent: string | null; n: number; by: 'MAN' | 'SAVED' | 'KNOWN' | 'NAME' | 'TWO' | 'NONE'; employeeId: number | null; code: string | null; empName: string | null; cands: { id: number; code: string; name: string }[] }
interface ImpPlan { messages: number; toAdd: number; already: number; unclear: number; noTopic: number; need: number; inactive: number; notPunch: number; from: string | null; to: string | null; rows: ImpRow[]; senders: ImpSender[] }

function TgImport() {
  const { L, dt } = useI18n();
  const { refresh, meta } = useData();
  const [src, setSrc] = useState<{ file: string; name: string; chatId: number; messages: ExportMsg[]; topicsSince: number | null } | null>(null);
  const [choice, setChoice] = useState<Record<string, number | null>>({});
  const [prog, setProg] = useState('');
  const [plan, setPlan] = useState<ImpPlan | null>(null);
  const [show, setShow] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const read = async (file: File) => {
    setErr(null); setPlan(null);
    try {
      const x = readTelegramExport(JSON.parse(await file.text()));
      if (x.chatId == null) throw new Error(L('导出档里没有群组 ID', 'The export has no group id'));
      setBusy(true);
      const r = await api<{ plan: ImpPlan }>('/telegram-import', { method: 'POST', body: { chatId: x.chatId, fileName: file.name, messages: x.messages, topicsSince: x.topicsSince } });
      setSrc({ file: file.name, name: x.name, chatId: x.chatId, messages: x.messages, topicsSince: x.topicsSince });
      setChoice({});
      setPlan(r.plan);
    } catch (e) { setErr(e instanceof SyntaxError ? new Error(L('不是 JSON 档案，请在导出时选择 Machine-readable JSON', 'Not a JSON file — choose "Machine-readable JSON" when exporting')) : (e as Error)); }
    finally { setBusy(false); }
  };
  // attendance days still waiting to be recalculated (after a big import) — can be done right away
  const pend = useApi<{ remaining: number }>('/recompute-pending');
  const recalc = async () => {
    setBusy(true);
    try {
      for (let i = 0; i < 200; i++) {
        const x = await api<{ done: number; remaining: number }>('/recompute-pending', { method: 'POST', body: {} });
        setProg(L(`正在重新计算考勤… 还剩 ${x.remaining} 天`, `Recalculating attendance… ${x.remaining} days left`));
        if (!x.remaining || !x.done) break;
      }
      toast(L('考勤已重新计算', 'Attendance recalculated'));
      refresh(); void pend.reload();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); setProg(''); }
  };
  // choosing the employee of a Telegram account re-reads the file with that choice
  const choose = async (key: string, id: number | null) => {
    if (!src) return;
    const next = { ...choice, [key]: id };
    setChoice(next); setBusy(true); setErr(null);
    try {
      const r = await api<{ plan: ImpPlan }>('/telegram-import', { method: 'POST', body: { chatId: src.chatId, fileName: src.file, messages: src.messages, topicsSince: src.topicsSince, senders: next } });
      setPlan(r.plan);
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!src || !plan) return;
    if (reason.trim().length < 4) return setErr(new Error(L('请填写原因（至少 4 个字）', 'Please give a reason (at least 4 characters)')));
    setBusy(true);
    try {
      const r = await api<{ applied: { added: number; deferred?: number } }>('/telegram-import', { method: 'POST', body: { chatId: src.chatId, fileName: src.file, messages: src.messages, topicsSince: src.topicsSince, senders: choice, apply: true, reason } });
      // many days imported: recalculate the rest right away (a slice per request) instead of waiting for the cron
      if (r.applied.deferred) {
        for (let i = 0; i < 100; i++) {
          const x = await api<{ done: number; remaining: number }>('/recompute-pending', { method: 'POST', body: {} });
          setProg(L(`正在重新计算考勤… 还剩 ${x.remaining} 天`, `Recalculating attendance… ${x.remaining} days left`));
          if (!x.remaining || !x.done) break;
        }
        setProg('');
      }
      toast(L(`已补入 ${r.applied.added} 笔打卡，考勤已重算`, `${r.applied.added} punches added; attendance recalculated`));
      refresh(); setSrc(null); setPlan(null); setReason('');
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  const RES: Record<ImpRow['result'], [string, string]> = {
    NEW: ['ok', L('会补入', 'Will be added')], DUP: ['', L('已有记录', 'Already recorded')], UNREC: ['w', L('看不懂，跳过', 'Unclear — skipped')],
    NOTOPIC: ['r', L('Topic 未绑定，跳过', 'Topic not bound — skipped')], NEED: ['w', L('选择员工后才会补入', 'Skipped until chosen')], INACTIVE: ['', L('员工已停用，跳过', 'Employee inactive — skipped')], UNTRUSTED: ['w', L('转发的消息，跳过', 'Forwarded — skipped')],
  };
  const BY: Record<ImpSender['by'], [string, string]> = {
    MAN: ['ok', L('你选的', 'Chosen by you')], SAVED: ['ok', L('之前选过', 'Chosen before')], KNOWN: ['i', L('已认识', 'Already known')],
    NAME: ['v', L('按名字', 'By name')], TWO: ['w', L('多位员工符合', 'Several employees match')], NONE: ['r', L('没有 Agent name', 'No agent name')],
  };
  const unmatched = (plan?.senders ?? []).filter((x) => !x.employeeId);
  const rows = (plan?.rows ?? []).filter((r) => !show || r.result === show || (show === 'UNREC' && r.result === 'UNTRUSTED'));
  return (
    <div className="card">
      <h3>{L('导入 Telegram 记录', 'Import Telegram history')}</h3>
      <p className="mut" style={{ fontSize: 12.5, margin: '0 0 12px', lineHeight: 1.6 }}>{L('用来补 bot 加入群组之前的打卡。时间采用导出档里 Telegram 记录的发送时间，不使用员工自己写的时间。', 'For punches sent before the bot joined the group. The time used is the Telegram message time stored in the export — never a time typed in the message.')}</p>
      {!plan && (pend.data?.remaining ?? 0) > 0 && (
        <div className="imppend"><span>{prog || L(`有 ${pend.data!.remaining} 天的考勤还在等待重新计算（系统每 15 分钟处理一批）。`, `${pend.data!.remaining} attendance days are waiting to be recalculated (the system does a batch every 15 minutes).`)}</span>
          <button className="btn sm" disabled={busy} onClick={recalc}>{L('立即重新计算', 'Recalculate now')}</button></div>
      )}
      {!plan && (
        <>
          <div className="impsteps">
            <div><b>1 · {L('导出', 'Export')}</b><span>{L('Telegram 电脑版 → 打开群组 → ⋮ → Export chat history → 取消 Photos → Format 选 Machine-readable JSON → 选日期', 'Telegram Desktop → open the group → ⋮ → Export chat history → untick Photos → Format: Machine-readable JSON → choose the dates')}</span></div>
            <div><b>2 · {L('上传', 'Upload')}</b><span>{L('上传 result.json。每个 Topic 对应已绑定的员工；没有 Topic 的群组按发送者和消息里的 Agent name 对应员工。', 'Upload result.json. Each topic is matched to the employee bound to it; in a group without topics, by the sender and the Agent name in the message.')}</span></div>
            <div><b>3 · {L('检查后确认', 'Check & confirm')}</b><span>{L('确认要补的打卡，填写原因后写入。bot 已收到的消息会自动跳过。', 'Review the punches, give a reason and confirm. Messages the bot already received are skipped.')}</span></div>
          </div>
          <label className={`impdrop ${drag ? 'on' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) void read(f); }}>
            <input type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f); }} />
            {busy ? L('读取中…', 'Reading…') : <>{L('把 ', 'Drop ')}<b>result.json</b>{L(' 拖到这里，或点击选择档案', ' here or click to choose the file')}</>}
          </label>
        </>
      )}
      {plan && src && (
        <>
          <div className="impkv">
            <div><span>{L('读取消息', 'Messages read')}</span><b>{plan.messages}</b></div>
            <div><span>{L('会补入', 'Punches to add')}</span><b style={{ color: 'var(--ok)' }}>{plan.toAdd}</b></div>
            <div><span>{L('已有记录', 'Already recorded')}</span><b>{plan.already}</b></div>
            <div><span>{L('看不懂', 'Unclear')}</span><b style={{ color: plan.unclear ? 'var(--warn)' : undefined }}>{plan.unclear}</b></div>
            {plan.senders.length
              ? <div><span>{L('需要选择员工', 'Choose employee')}</span><b style={{ color: plan.need ? 'var(--bad)' : undefined }}>{plan.need}</b></div>
              : <div><span>{L('Topic 未绑定', 'Topic not bound')}</span><b style={{ color: plan.noTopic ? 'var(--bad)' : undefined }}>{plan.noTopic}</b></div>}
          </div>
          {plan.senders.length > 0 && (
            <>
              <div className="impsec">1 · {L('消息是谁的', 'Who the messages are about')} <span>{L('个人账号按账号对应；多人共用的账号按消息里写的名字对应（或它回复的那条消息）。每个选一次，系统会记住。', 'A personal account is matched by the account; a shared account by the name written in each message (or the message it replies to). Each is chosen once and remembered.')}</span></div>
              <div className="tw impsnd" style={{ marginBottom: 6 }}><table><thead><tr>
                <th>{L('名字 / Telegram 账号', 'Name / Telegram account')}</th><th>{L('消息里的名字', 'Name in messages')}</th><th>{L('打卡消息', 'Messages')}</th><th>{L('员工', 'Employee')}</th><th>{L('对应方式', 'Matched by')}</th>
              </tr></thead><tbody>
                {plan.senders.map((x) => {
                  const pref = new Set(x.cands.map((c) => c.id));
                  const opts = (list: typeof meta.employees) => list.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>);
                  return (
                    <tr key={x.key}>
                      <td>{x.kind === 'NAME'
                        ? <><b className="impagent">{x.name}</b> <span className="mut" style={{ fontSize: 12 }}>{L('共用账号', 'shared account')} {x.account}</span></>
                        : <><b>{x.name || '—'}</b> <span className="mut" style={{ fontSize: 12 }}>#{x.key.slice(2)}</span></>}</td>
                      <td>{x.kind === 'NAME' ? (x.spellings.length ? <span className="mut" style={{ fontSize: 12 }}>{L('也写成', 'also')} {x.spellings.join(', ')}</span> : <span className="mut">—</span>)
                        : x.agent ? <span className="impagent">{x.agent}</span> : <span className="mut">—</span>}</td>
                      <td>{x.n}</td>
                      <td><select className={x.employeeId ? '' : 'need'} value={x.employeeId ?? ''} disabled={busy} onChange={(e) => void choose(x.key, e.target.value ? Number(e.target.value) : null)} style={{ minWidth: 220, width: 'auto' }}>
                        <option value="">{L('— 选择员工 —', '— Choose employee —')}</option>
                        {pref.size > 0 && opts(meta.employees.filter((e) => pref.has(e.id)))}
                        {pref.size > 0 && <option disabled>──────────</option>}
                        {opts(meta.employees.filter((e) => !pref.has(e.id)))}
                      </select></td>
                      <td><span className={`b ${BY[x.by][0]}`}>{x.kind === 'NAME' && x.by === 'NONE' ? L('对不上员工', 'No matching employee') : BY[x.by][1]}</span></td>
                    </tr>
                  );
                })}
              </tbody></table></div>
              {plan.need > 0 && <div className="impwarn">{L(`还有 ${plan.need} 笔打卡没有对应员工${unmatched.length ? `（${unmatched.length} 个名字 / 账号未选）` : ''}，会先跳过；没有名字的消息可以在下面明细逐笔选择。`, `${plan.need} punches have no employee yet${unmatched.length ? ` (${unmatched.length} names / accounts not chosen)` : ''} — they are skipped; messages without a name can be chosen one by one below.`)}</div>}
              <div className="impsec">2 · {L('打卡明细', 'Punches')} <span>{L('时间采用 Telegram 消息时间（消息里写的日期不会使用）。', 'Time = Telegram message time (the date typed in the message is not used).')}</span></div>
            </>
          )}
          <div className="row" style={{ marginBottom: 10, alignItems: 'center' }}>
            <select value={show} onChange={(e) => setShow(e.target.value)} style={{ width: 'auto' }}>
              <option value="">{L('全部结果', 'All results')}</option><option value="NEW">{RES.NEW[1]}</option><option value="DUP">{RES.DUP[1]}</option>
              <option value="UNREC">{L('看不懂', 'Unclear')}</option>{plan.need > 0 && <option value="NEED">{RES.NEED[1]}</option>}{plan.noTopic > 0 && <option value="NOTOPIC">{RES.NOTOPIC[1]}</option>}
            </select>
            <span className="mut" style={{ fontSize: 12.5 }}>{src.name} · {src.chatId} · {plan.from} → {plan.to} · {L(`另有 ${plan.notPunch} 则一般聊天未列出`, `${plan.notPunch} ordinary chat messages not listed`)}</span>
          </div>
          {rows.length === 0 ? <div className="empty">{L('没有符合的消息', 'Nothing here')}</div> : (
            <div className="tw" style={{ maxHeight: 460 }}><table><thead><tr>
              <th className="pid">PSD ID</th><th>{L('员工姓名', 'Employee Name')}</th><th>{L('Telegram 时间', 'Telegram time')}</th>{plan.senders.length > 0 && <th>{L('Telegram 账号', 'Telegram account')}</th>}<th>{L('动作', 'Action')}</th><th>{L('消息', 'Message')}</th><th>{L('结果', 'Result')}</th>
            </tr></thead><tbody>
              {rows.map((r) => <tr key={r.id}>
                <td className="pid">{r.code ? <b>{r.code}</b> : <span className="mut">—</span>}</td>
                <td>{r.result === 'NEED' && r.key?.startsWith('m:')
                  ? <select className="need" value={choice[r.key] ?? ''} disabled={busy} onChange={(e) => void choose(r.key!, e.target.value ? Number(e.target.value) : null)} style={{ minWidth: 200, width: 'auto' }}>
                      <option value="">{L('— 选择员工 —', '— Choose employee —')}</option>
                      {meta.employees.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}</option>)}
                    </select>
                  : r.name ?? <span className="mut">{r.thread ? `Topic #${r.thread}` : '—'}</span>}</td>
                <td className="nw">{r.time}</td>{plan.senders.length > 0 && <td>{r.from || <span className="mut">—</span>}{r.who && <> · <span className="impagent">{r.who}</span></>}</td>}
                <td>{r.type ? dt(EVENT_LABEL[r.type]) : <span className="mut">—</span>}</td>
                <td className="impmsg" title={r.text}>{r.text.replace(/\s*\n\s*/g, ' · ')}</td>
                <td><span className={`b ${RES[r.result][0]}`}>{RES[r.result][1]}</span></td>
              </tr>)}
            </tbody></table></div>
          )}
          {plan.toAdd > 0 && <div style={{ marginTop: 12 }}><label className="mut" style={{ fontSize: 12 }}>{L('原因（必填）', 'Reason (required)')}</label><textarea rows={2} value={reason} placeholder={L('例如：bot 加入群组前的打卡', 'e.g. Punches sent before the bot joined the group')} onChange={(e) => setReason(e.target.value)} /></div>}
          <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
          <div className="setfoot" style={{ gap: 8, display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => { setPlan(null); setSrc(null); setErr(null); setChoice({}); }}>{L('取消', 'Cancel')}</button>
            {prog && <span className="mut" style={{ fontSize: 12.5, alignSelf: 'center' }}>{prog}</span>}
            {plan.toAdd > 0 && <button className="btn p" disabled={busy} onClick={apply}>{L(`补入 ${plan.toAdd} 笔打卡`, `Add ${plan.toAdd} punches`)}</button>}
          </div>
        </>
      )}
      {!plan && <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>}
    </div>
  );
}
