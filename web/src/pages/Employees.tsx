import { useRef, useState } from 'react';
import { Cnt, CurB, CurrencyOptions, EmpSearch, ErrBox, Field, jsonOrNull, KvList, Modal, ModalActions, Pager, TblTop } from '../components/ui';
import { api, type ApiErr, qs } from '../lib/api';
import { exportXLSX, readGrid } from '../lib/files';
import { fmtDT } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { toast, useApi, useData, usePageState } from '../lib/store';

interface EmpRow { id: number; employee_code: string; name: string; currency_code: string | null; employment_status: string; default_shift_id: number | null; timezone: string; chat_id: number | null; message_thread_id: number | null; mapping_count: number }

export function Employees() {
  const { L } = useI18n();
  const { readOnly, reloadMeta, refresh, meta } = useData();
  const [f, set] = usePageState('em', () => ({ q: '', cur: '', status: 'ACTIVE', page: 1, size: 10 }));
  const { data, error } = useApi<{ total: number; rows: EmpRow[] }>(`/employees?${qs(f)}`);
  const [edit, setEdit] = useState<number | 'new' | null>(null);
  const [hist, setHist] = useState<number | null>(null);
  const [imp, setImp] = useState<{ grid: (string | number | null)[][]; file: string; plan: EmpPlan } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const doExport = async () => {
    try {
      const r = await api<{ rows: { employee_code: string; name: string; currency_code: string | null; employment_status: string; chat_id: number | null; message_thread_id: number | null }[] }>(`/export/employees?${qs({ q: f.q, cur: f.cur, status: f.status })}`);
      await exportXLSX(`employees${f.cur ? '_' + f.cur : ''}${f.status ? '_' + f.status.toLowerCase() : ''}`, ['PSD ID', 'Employee Name', 'Currency', 'Chat ID', 'Thread ID', 'Status'],
        r.rows.map((e) => [e.employee_code, e.name, e.currency_code ?? '', e.chat_id != null ? String(e.chat_id) : '', e.message_thread_id ?? '', e.employment_status]));
      toast(L(`已导出 ${r.rows.length} 名员工`, `Exported ${r.rows.length} employees`));
    } catch (e) { toast(L('导出失败', 'Export failed') + ': ' + (e as Error).message); }
  };
  // empty file in the import format: fill in new employees (or changes) and import it
  const doTemplate = async () => {
    await exportXLSX('employees_template', ['PSD ID', 'Employee Name', 'Currency', 'Chat ID', 'Thread ID'], [], [
      ['How to use', 'One employee per row, then Employees → Import'],
      ['PSD ID', 'Required. Letters, digits and _ . - (no spaces). An existing PSD ID updates that employee'],
      ['Employee Name', 'Required for a new employee'],
      ['Currency', `Required for a new employee: ${meta.currencies.map((c) => c.code).join(' / ')}`],
      ['Chat ID', 'Group id, e.g. -1003959204082 (or 3959204082 from the topic link)'],
      ['Thread ID', 'Topic number, e.g. 28. Leave Chat ID and Thread ID empty to bind the topic later'],
      ['Empty cell', 'For an existing employee an empty cell keeps the current value'],
    ]);
  };
  const doImport = async (file: File) => {
    try {
      const grid = await readGrid(file);
      const r = await api<{ plan: EmpPlan }>('/employees/import', { method: 'POST', body: { grid, fileName: file.name } });
      setImp({ grid, file: file.name, plan: r.plan });
    } catch (e) { toast(L('无法读取文件', 'Could not read the file') + ': ' + ((e as ApiErr).msg ? L((e as ApiErr).msg.zh, (e as ApiErr).msg.en) : (e as Error).message)); }
  };
  const [del, setDel] = useState<EmpRow | null>(null);
  const deactivate = async (e: EmpRow) => {
    const reason = prompt(L(`停用 ${e.employee_code} ${e.name}？历史考勤会保留。请输入原因：`, `Disable ${e.employee_code} ${e.name}? History is kept. Enter a reason:`));
    if (!reason) return;
    try { await api(`/employees/${e.id}/deactivate`, { method: 'POST', body: { reason } }); toast(L('已停用', 'Disabled')); await reloadMeta(); refresh(); }
    catch (x) { alert(L((x as ApiErr).msg.zh, (x as ApiErr).msg.en)); }
  };
  const activate = async (e: EmpRow) => {
    if (!confirm(L(`重新启用 ${e.employee_code} ${e.name}？`, `Activate ${e.employee_code} ${e.name} again?`))) return;
    try {
      const r = await api<{ topic: number | null; topicTaken: boolean }>(`/employees/${e.id}/activate`, { method: 'POST', body: {} });
      toast(r.topic != null ? L(`已启用，Topic #${r.topic} 已恢复`, `Activated; topic #${r.topic} restored`)
        : r.topicTaken ? L('已启用；原本的 Topic 已被别人使用，请按 Edit 绑定新的 Topic', 'Activated; the old topic is used by someone else — bind a new one with Edit')
        : L('已启用', 'Activated'));
      await reloadMeta(); refresh();
    } catch (x) { alert(L((x as ApiErr).msg.zh, (x as ApiErr).msg.en)); }
  };
  return (
    <>
      <div className="card"><div className="row">
        <Field label={L('货币', 'Currency')}><select value={f.cur} onChange={(e) => set({ cur: e.target.value, page: 1 })}><CurrencyOptions all={L('全部货币', 'All currencies')} /></select></Field>
        <Field label={L('状态', 'Status')}><select value={f.status} onChange={(e) => set({ status: e.target.value, page: 1 })}><option value="">{L('全部', 'All')}</option><option value="ACTIVE">{L('在职', 'Active')}</option><option value="INACTIVE">{L('停用', 'Inactive')}</option></select></Field>
        <Field label={L('搜索', 'Search')}><EmpSearch value={f.q} onChange={(q) => set({ q, page: 1 })} /></Field>
        {!readOnly && <button className="btn p" onClick={() => setEdit('new')}>+ {L('新增员工', 'Add employee')}</button>}
        <div className="rowact">
          {!readOnly && <button className="btn" onClick={() => { if (fileRef.current) { fileRef.current.value = ''; fileRef.current.click(); } }}>{L('导入', 'Import')}</button>}
          <button className="btn" onClick={doExport}>{L('导出', 'Export')}</button>
          <button className="btn" onClick={doTemplate}>{L('导出模板', 'Export template')}</button>
          <input ref={fileRef} type="file" accept=".csv,.xlsx" hidden onChange={(e) => { const x = e.target.files?.[0]; if (x) void doImport(x); }} />
        </div>
      </div></div>
      <ErrBox error={error} />
      {data && (
        <>
          <TblTop left={<Cnt n={data.total} />} size={f.size} onSize={(size) => set({ size, page: 1 })} />
          <div className="tw"><table className="emtbl"><thead><tr>
            <th className="pid">{L('PSD ID', 'PSD ID')}</th><th>{L('员工姓名', 'Employee Name')}</th><th>{L('货币', 'Currency')}</th><th>{L('状态', 'Status')}</th><th>Topic（chat / thread）</th><th>Mapping</th><th className="c">{L('操作', 'Action')}</th>
          </tr></thead><tbody>
            {data.rows.map((e) => (
              <tr key={e.id}>
                <td className="pid"><b>{e.employee_code}</b></td><td>{e.name}</td><td className="c"><CurB c={e.currency_code} /></td>
                <td>{e.employment_status === 'ACTIVE' ? <span className="b ok">ACTIVE</span> : <span className="b">INACTIVE</span>}</td>
                <td>{e.message_thread_id != null ? <><code>{e.chat_id}</code> / <b>#{e.message_thread_id}</b></> : <span className="b w">{L('未绑定 Topic', 'Topic not bound')}</span>}</td>
                <td>{e.message_thread_id != null && <span className="b ok">{L('已验证', 'Verified')}</span>}</td>
                <td><button className="btn sm" onClick={() => setHist(e.id)}>{L('历史', 'History')}</button>{!readOnly && <> <button className="btn sm" onClick={() => setEdit(e.id)}>{L('编辑', 'Edit')}</button> {e.employment_status === 'ACTIVE'
                  ? <button className="btn sm dis" onClick={() => deactivate(e)}>{L('停用', 'Disable')}</button>
                  : <button className="btn sm act" onClick={() => activate(e)}>{L('启用', 'Active')}</button>} <button className="btn sm d" onClick={() => setDel(e)}>{L('删除', 'Delete')}</button></>}</td>
              </tr>
            ))}
          </tbody></table></div>
          <Pager total={data.total} page={f.page} size={f.size} onPage={(page) => set({ page })} />
        </>
      )}
      {edit != null && <EmployeeModal id={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {hist != null && <HistoryModal id={hist} onClose={() => setHist(null)} />}
      {imp && <ImportModal {...imp} onClose={() => setImp(null)} />}
      {del && <DeleteModal emp={del} onClose={() => setDel(null)} />}
    </>
  );
}

function DeleteModal({ emp, onClose }: { emp: EmpRow; onClose: () => void }) {
  const { L } = useI18n();
  const { reloadMeta, refresh } = useData();
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = typed.trim() === emp.employee_code;
  const go = async () => {
    setBusy(true);
    try {
      await api(`/employees/${emp.id}/delete`, { method: 'POST', body: { confirm: typed.trim() } });
      toast(L(`已删除 ${emp.employee_code}`, `${emp.employee_code} deleted`));
      await reloadMeta(); refresh(); onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0, color: 'var(--bad)' }}>{L(`删除 ${emp.employee_code} ${emp.name}？`, `Delete ${emp.employee_code} ${emp.name}?`)}</h3>
      <div className="delwarn">{L('删除后无法恢复。', 'This cannot be undone.')}</div>
      <ul className="dellist">
        <li>{L('员工资料和 Topic 绑定', 'The employee and their topic binding')}</li>
        <li>{L('所有打卡、考勤、休息和异常', 'All punches, attendance, breaks and exceptions')}</li>
        <li>{L('排班，以及他 Topic 里的 Telegram 消息', 'Roster shifts and Telegram messages from their topic')}</li>
      </ul>
      <div className="mut" style={{ fontSize: 12.5, marginBottom: 6 }}>{L('Audit Log 只会留下一行删除纪录（谁、何时、删除哪个 PSD ID）。', 'Only one line stays in the Audit Log (who deleted which PSD ID, and when).')}<br />
        {L('请输入 ', 'Type ')}<b>{emp.employee_code}</b>{L(' 确认删除：', ' to confirm:')}</div>
      <input autoFocus autoComplete="off" style={{ width: '100%' }} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ok && !busy) void go(); }} />
      <ErrBox error={err} />
      <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button className="btn" onClick={onClose}>{L('取消', 'Cancel')}</button>
        <button className="btn danger" disabled={!ok || busy} onClick={go}>{L('永久删除', 'Delete permanently')}</button>
      </div>
    </Modal>
  );
}

interface EmpPlan {
  newCount: number; updateCount: number; unchanged: number; errorCount: number; errors: { where: string; msg: { zh: string; en: string } }[];
  changes: { kind: 'NEW' | 'UPDATE'; code: string; name: string; currency: string | null; topic: number | null; fields: string[]; before: { name: string; currency: string | null; topic: number | null } | null }[];
}

function ImportModal({ grid, file, plan, onClose }: { grid: (string | number | null)[][]; file: string; plan: EmpPlan; onClose: () => void }) {
  const { L, dt } = useI18n();
  const { reloadMeta, refresh } = useData();
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const n = plan.newCount + plan.updateCount;
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<{ applied: { added: number; updated: number } }>('/employees/import', { method: 'POST', body: { grid, fileName: file, apply: true } });
      toast(L(`已导入：新增 ${r.applied.added}，更新 ${r.applied.updated}`, `Imported: ${r.applied.added} added, ${r.applied.updated} updated`));
      await reloadMeta(); refresh(); onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  const diff = (c: EmpPlan['changes'][number], k: 'name' | 'currency' | 'topic', now: string) => {
    if (!c.fields.includes(k)) return <span className="mut">{now || '—'}</span>;
    const was = c.before ? String((k === 'topic' ? (c.before.topic != null ? '#' + c.before.topic : '') : c.before[k]) ?? '') : '';
    return <>{was && <><span className="mut" style={{ textDecoration: 'line-through' }}>{was}</span> → </>}<b>{now || '—'}</b></>;
  };
  return (
    <Modal onClose={onClose} wide>
      <h3 style={{ marginTop: 0 }}>{L('导入员工', 'Import employees')} · {file}</h3>
      <div className="kv">
        <div><span>{L('新增', 'New')}</span><b>{plan.newCount}</b></div>
        <div><span>{L('更新', 'Updated')}</span><b>{plan.updateCount}</b></div>
        <div><span>{L('不变', 'Unchanged')}</span><b>{plan.unchanged}</b></div>
        <div><span>{L('错误（跳过）', 'Errors (skipped)')}</span><b style={{ color: plan.errorCount ? 'var(--bad)' : 'inherit' }}>{plan.errorCount}</b></div>
      </div>
      {plan.changes.length > 0 && (
        <div className="tw" style={{ maxHeight: 300, marginTop: 12 }}><table><thead><tr><th className="pid">PSD ID</th><th></th><th>{L('员工姓名', 'Employee Name')}</th><th>{L('货币', 'Currency')}</th><th>Topic</th></tr></thead><tbody>
          {plan.changes.map((c) => <tr key={c.code}><td className="pid"><b>{c.code}</b></td><td>{c.kind === 'NEW' ? <span className="b ok">{L('新增', 'New')}</span> : <span className="b i">{L('更新', 'Update')}</span>}</td>
            <td>{diff(c, 'name', c.name)}</td><td>{diff(c, 'currency', c.currency ?? '')}</td><td>{diff(c, 'topic', c.topic != null ? '#' + c.topic : '')}</td></tr>)}
        </tbody></table></div>
      )}
      {plan.errors.length > 0 && (
        <div className="tw" style={{ maxHeight: 200, marginTop: 12 }}><table><thead><tr><th>{L('位置', 'Where')}</th><th>{L('原因', 'Reason')}</th></tr></thead><tbody>
          {plan.errors.map((x, i) => <tr key={i}><td>{x.where}</td><td style={{ color: 'var(--bad)' }}>{dt(x.msg)}</td></tr>)}
        </tbody></table></div>
      )}
      <p className="mut" style={{ fontSize: 12 }}>{L('栏位：PSD ID、Employee Name、Currency、Chat ID、Thread ID。已有的员工：留空的栏位保持不变；Status 栏只供参考，不会改变在职/停用。', 'Columns: PSD ID, Employee Name, Currency, Chat ID, Thread ID. For existing employees an empty cell keeps the current value; the Status column is for reference only and does not activate / deactivate anyone.')}</p>
      <ErrBox error={err} />
      <ModalActions onCancel={onClose} onOk={n > 0 || plan.unchanged > 0 ? apply : undefined} busy={busy} okLabel={n > 0 ? L(`确认导入 ${n} 名员工`, `Import ${n} employees`) : L('只更新排列顺序', 'Update the row order only')} />
    </Modal>
  );
}

interface EmpDetail { changes?: { id: number; created_at: number; actor: string; action: string; before_json: string | null; after_json: string | null; note: string | null }[]; employee: { id: number; employee_code: string; name: string; currency_code: string | null; default_shift_id: number | null; timezone: string }; mappings: { id: number; chat_id: number; message_thread_id: number; valid_from: number; valid_until: number | null; is_active: number; created_by: string }[] }

function EmployeeModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { L } = useI18n();
  const { meta, reloadMeta, refresh } = useData();
  const { data } = useApi<EmpDetail>(id ? `/employees/${id}` : null);
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const knownChat = '';
  if (id && !data) return <Modal onClose={onClose}><div className="mut">…</div></Modal>;
  const cur = data?.mappings.find((m) => m.is_active);
  const v = form ?? {
    code: data?.employee.employee_code ?? '', name: data?.employee.name ?? '', currency: data?.employee.currency_code ?? '',
    tz: data?.employee.timezone ?? 'Asia/Colombo',
    chat: String(cur?.chat_id ?? knownChat), thread: cur ? String(cur.message_thread_id) : '',
  };
  const upd = (k: string, val: string) => setForm({ ...v, [k]: val });
  const save = async () => {
    if (!v.code.trim() || !v.name.trim()) return setErr(new Error(L('PSD ID 与员工姓名必填', 'PSD ID and employee name are required')));
    if (!/^[A-Za-z0-9_.-]+$/.test(v.code.trim())) return setErr(new Error(L('PSD ID 只能用英文字母、数字和 _ . -，不能有空格（例如 E001、Test-1）', 'PSD ID may only contain letters, digits and _ . - with no spaces (e.g. E001, Test-1)')));
    if (v.thread && !/^\d+$/.test(v.thread)) return setErr(new Error(L('thread_id 必须为数字', 'thread_id must be numeric')));
    if (/^\d{5,17}$/.test(v.chat.trim())) v.chat = '-100' + v.chat.trim(); // copied from a t.me/c/<id>/… link
    if (v.thread && !/^-100\d{5,17}$/.test(v.chat.trim())) return setErr(new Error(L('Chat ID 格式错误：超级群组的 Chat ID 是 -100 开头（例如 -1003959204082）', 'Invalid Chat ID: supergroup ids start with -100 (e.g. -1003959204082)')));
    setBusy(true);
    try {
      await api(id ? `/employees/${id}` : '/employees', { method: id ? 'PUT' : 'POST', body: { code: v.code.trim(), name: v.name.trim(), currency: v.currency || null, timezone: v.tz, chatId: v.chat.trim(), threadId: v.thread.trim() } });
      toast(L('已保存，并写入 Audit Log', 'Saved and written to the audit log'));
      await reloadMeta();
      refresh();
      onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{id ? L('编辑员工 ', 'Edit employee ') + (data?.employee.employee_code ?? '') : L('新增员工', 'Add employee')}</h3>
      <div className="fg">
        <div><label>PSD ID *</label><input type="text" value={v.code} onChange={(e) => upd('code', e.target.value)} /></div>
        <div><label>{L('姓名', 'Name')} *</label><input type="text" value={v.name} onChange={(e) => upd('name', e.target.value)} /></div>
        <div><label>{L('货币', 'Currency')}</label><select value={v.currency} onChange={(e) => upd('currency', e.target.value)}><CurrencyOptions all={L('（未指定）', '(none)')} /></select></div>
        <div><label>{L('时区', 'Time zone')}</label><select value={v.tz} onChange={(e) => upd('tz', e.target.value)}><option value="Asia/Colombo">{L('斯里兰卡时间（UTC+05:30）', 'Sri Lanka time (UTC+05:30)')}</option></select></div>
      </div>
      <h3>{L('Telegram Topic 绑定', 'Telegram topic binding')}</h3>
      <div className="fg">
        <div><label>Chat ID</label><input type="text" value={v.chat} placeholder="-100..." onChange={(e) => upd('chat', e.target.value)} /></div>
        <div><label>Topic message_thread_id</label><input type="text" value={v.thread} placeholder={L('留空 = 不绑定', 'Empty = not bound')} onChange={(e) => upd('thread', e.target.value)} /></div>
      </div>
      <div style={{ marginTop: 10 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={save} busy={busy} />
    </Modal>
  );
}

const ACTION_LABEL: Record<string, [string, string]> = {
  EMPLOYEE_CREATED: ['新增员工', 'Employee created'], EMPLOYEE_UPDATED: ['修改资料', 'Profile updated'], EMPLOYEE_DEACTIVATED: ['停用', 'Deactivated'],
  TOPIC_MAPPING_CHANGED: ['更换 Topic', 'Topic changed'], TOPIC_MAPPING_REMOVED: ['解除 Topic', 'Topic removed'],
};

function HistoryModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { L } = useI18n();
  const { data, error } = useApi<EmpDetail>(`/employees/${id}`);
  return (
    <Modal onClose={onClose} wide>
      <h3 style={{ marginTop: 0 }}>{L('历史', 'History')} · {data ? `${data.employee.employee_code} ${data.employee.name}` : '…'}</h3>
      <ErrBox error={error} />
      {data && (
        <>
          <h4 className="subh" style={{ marginTop: 6 }}>{L('Topic 绑定历史', 'Topic binding history')}</h4>
          {data.mappings.length ? (
            <div className="tw"><table className="histbl"><thead><tr><th>Topic</th><th>Chat ID</th><th>{L('开始', 'From')}</th><th>{L('结束', 'Until')}</th><th>{L('设置人', 'By')}</th></tr></thead><tbody>
              {data.mappings.map((h) => <tr key={h.id}><td>#{h.message_thread_id}</td><td><code>{h.chat_id}</code></td><td>{fmtDT(h.valid_from)}</td><td>{h.valid_until ? fmtDT(h.valid_until) : <span className="b ok">{L('有效', 'Active')}</span>}</td><td>{h.created_by}</td></tr>)}
            </tbody></table></div>
          ) : <div className="mut">{L('没有绑定记录', 'No bindings yet')}</div>}
          <h4 className="subh">{L('资料修改记录', 'Change log')}</h4>
          {data.changes && data.changes.length ? (
            <div className="tw"><table className="grid histbl"><thead><tr><th>{L('时间', 'Time')}</th><th>{L('动作', 'Action')}</th><th>{L('修改前', 'Before')}</th><th>{L('修改后', 'After')}</th><th>{L('操作人', 'By')}</th></tr></thead><tbody>
              {data.changes.map((c) => {
                const b = jsonOrNull(c.before_json);
                const lbl = ACTION_LABEL[c.action];
                return <tr key={c.id}><td className="nw">{fmtDT(c.created_at)}</td><td><span className="b i">{lbl ? L(lbl[0], lbl[1]) : c.action}</span>{c.note && <div className="mut" style={{ fontSize: 11.5, marginTop: 2, whiteSpace: 'normal' }}>{c.note}</div>}</td><td><KvList obj={b} /></td><td><KvList obj={jsonOrNull(c.after_json)} other={b} /></td><td>{c.actor}</td></tr>;
              })}
            </tbody></table></div>
          ) : <div className="mut">{L('没有修改记录', 'No changes yet')}</div>}
          <ModalActions onCancel={onClose} />
        </>
      )}
    </Modal>
  );
}
