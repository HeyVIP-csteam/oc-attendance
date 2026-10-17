import { useState } from 'react';
import { Cnt, CurB, CurrencyOptions, EmpSearch, ErrBox, Field, Modal, ModalActions, Pager, TblTop } from '../components/ui';
import { api, type ApiErr, qs } from '../lib/api';
import { fmtDT } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { toast, useApi, useData, usePageState } from '../lib/store';

interface EmpRow { id: number; employee_code: string; name: string; currency_code: string | null; employment_status: string; default_shift_id: number | null; timezone: string; chat_id: number | null; message_thread_id: number | null; mapping_count: number }

export function Employees() {
  const { L } = useI18n();
  const { readOnly, reloadMeta, refresh } = useData();
  const [f, set] = usePageState('em', () => ({ q: '', status: 'ACTIVE', page: 1, size: 10 }));
  const { data, error } = useApi<{ total: number; rows: EmpRow[] }>(`/employees?${qs(f)}`);
  const [edit, setEdit] = useState<number | 'new' | null>(null);
  const deactivate = async (e: EmpRow) => {
    const reason = prompt(L(`停用 ${e.employee_code} ${e.name}？历史考勤会保留。请输入原因：`, `Deactivate ${e.employee_code} ${e.name}? History is kept. Enter a reason:`));
    if (!reason) return;
    try { await api(`/employees/${e.id}/deactivate`, { method: 'POST', body: { reason } }); toast(L('已停用', 'Deactivated')); await reloadMeta(); refresh(); }
    catch (x) { alert(L((x as ApiErr).msg.zh, (x as ApiErr).msg.en)); }
  };
  return (
    <>
      <div className="card"><div className="row">
        <Field label={L('搜索', 'Search')}><EmpSearch value={f.q} onChange={(q) => set({ q, page: 1 })} /></Field>
        <Field label={L('状态', 'Status')}><select value={f.status} onChange={(e) => set({ status: e.target.value, page: 1 })}><option value="">{L('全部', 'All')}</option><option value="ACTIVE">{L('在职', 'Active')}</option><option value="INACTIVE">{L('停用', 'Inactive')}</option></select></Field>
        {!readOnly && <button className="btn p" onClick={() => setEdit('new')}>+ {L('新增员工', 'Add employee')}</button>}
      </div></div>
      <ErrBox error={error} />
      {data && (
        <>
          <TblTop left={<Cnt n={data.total} />} size={f.size} onSize={(size) => set({ size, page: 1 })} />
          <div className="tw"><table className="emtbl"><thead><tr>
            <th>ID</th><th>{L('姓名', 'Name')}</th><th className="c">{L('货币', 'Currency')}</th><th>{L('状态', 'Status')}</th><th>Topic（chat / thread）</th><th>Mapping</th><th className="c">{L('操作', 'Action')}</th>
          </tr></thead><tbody>
            {data.rows.map((e) => (
              <tr key={e.id}>
                <td><b>{e.employee_code}</b></td><td>{e.name}</td><td className="c"><CurB c={e.currency_code} /></td>
                <td>{e.employment_status === 'ACTIVE' ? <span className="b ok">ACTIVE</span> : <span className="b">INACTIVE</span>}</td>
                <td>{e.message_thread_id != null ? <><code>{e.chat_id}</code> / <b>#{e.message_thread_id}</b></> : <span className="b w">{L('未绑定 Topic', 'Topic not bound')}</span>}</td>
                <td>{e.message_thread_id != null && <span className="b ok">{L('已验证', 'Verified')}</span>}{e.mapping_count > 1 && <> <span className="b v">{L(`${e.mapping_count} 条历史`, `${e.mapping_count} history`)}</span></>}</td>
                <td>{!readOnly && <><button className="btn sm" onClick={() => setEdit(e.id)}>{L('编辑', 'Edit')}</button> {e.employment_status === 'ACTIVE' && <button className="btn sm d" onClick={() => deactivate(e)}>{L('停用', 'Deactivate')}</button>}</>}</td>
              </tr>
            ))}
          </tbody></table></div>
          <Pager total={data.total} page={f.page} size={f.size} onPage={(page) => set({ page })} />
        </>
      )}
      {edit != null && <EmployeeModal id={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

interface EmpDetail { employee: { id: number; employee_code: string; name: string; currency_code: string | null; default_shift_id: number | null; timezone: string }; mappings: { id: number; chat_id: number; message_thread_id: number; valid_from: number; valid_until: number | null; is_active: number; created_by: string }[] }

function EmployeeModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { L } = useI18n();
  const { meta, reloadMeta, refresh } = useData();
  const { data } = useApi<EmpDetail>(id ? `/employees/${id}` : null);
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const knownChat = meta.rules.allowedChats[0] ?? '';
  if (id && !data) return <Modal onClose={onClose}><div className="mut">…</div></Modal>;
  const cur = data?.mappings.find((m) => m.is_active);
  const v = form ?? {
    code: data?.employee.employee_code ?? '', name: data?.employee.name ?? '', currency: data?.employee.currency_code ?? '',
    shift: String(data?.employee.default_shift_id ?? ''), tz: data?.employee.timezone ?? 'Asia/Colombo',
    chat: String(cur?.chat_id ?? knownChat), thread: cur ? String(cur.message_thread_id) : '',
  };
  const upd = (k: string, val: string) => setForm({ ...v, [k]: val });
  const save = async () => {
    if (!v.code.trim() || !v.name.trim()) return setErr(new Error(L('Employee ID 与姓名必填', 'Employee ID and name are required')));
    if (v.thread && !/^\d+$/.test(v.thread)) return setErr(new Error(L('thread_id 必须为数字', 'thread_id must be numeric')));
    if (v.thread && !/^-?\d{5,20}$/.test(v.chat)) return setErr(new Error(L('Chat ID 格式错误', 'Invalid Chat ID')));
    setBusy(true);
    try {
      await api(id ? `/employees/${id}` : '/employees', { method: id ? 'PUT' : 'POST', body: { code: v.code.trim(), name: v.name.trim(), currency: v.currency || null, defaultShiftId: v.shift ? Number(v.shift) : null, timezone: v.tz, chatId: v.chat.trim(), threadId: v.thread.trim() } });
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
        <div><label>Employee ID *</label><input type="text" value={v.code} onChange={(e) => upd('code', e.target.value)} /></div>
        <div><label>{L('姓名', 'Name')} *</label><input type="text" value={v.name} onChange={(e) => upd('name', e.target.value)} /></div>
        <div><label>{L('货币', 'Currency')}</label><select value={v.currency} onChange={(e) => upd('currency', e.target.value)}><CurrencyOptions all={L('（未指定）', '(none)')} /></select></div>
        <div><label>{L('默认班次（从明天生效）', 'Default shift (from tomorrow)')}</label><select value={v.shift} onChange={(e) => upd('shift', e.target.value)}>
          <option value="">{L('无（只用排班表）', 'None (roster only)')}</option>{meta.shifts.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select></div>
        <div><label>{L('时区', 'Time zone')}</label><select value={v.tz} onChange={(e) => upd('tz', e.target.value)}><option value="Asia/Colombo">{L('斯里兰卡时间（UTC+05:30）', 'Sri Lanka time (UTC+05:30)')}</option></select></div>
      </div>
      <h3>{L('Telegram Topic 绑定', 'Telegram topic binding')}</h3>
      <div className="fg">
        <div><label>Chat ID</label><input type="text" value={v.chat} placeholder="-100..." onChange={(e) => upd('chat', e.target.value)} /></div>
        <div><label>Topic message_thread_id</label><input type="text" value={v.thread} placeholder={L('留空 = 不绑定', 'Empty = not bound')} onChange={(e) => upd('thread', e.target.value)} /></div>
      </div>
      {data && data.mappings.length > 0 && (
        <>
          <h4 className="subh">{L('绑定历史', 'Binding history')}</h4>
          <div className="tw"><table className="histbl"><thead><tr><th>Topic</th><th>{L('开始', 'From')}</th><th>{L('结束', 'Until')}</th><th>{L('设置人', 'By')}</th></tr></thead><tbody>
            {data.mappings.map((h) => <tr key={h.id}><td>#{h.message_thread_id}</td><td>{fmtDT(h.valid_from)}</td><td>{h.valid_until ? fmtDT(h.valid_until) : <span className="b ok">{L('有效', 'Active')}</span>}</td><td>{h.created_by}</td></tr>)}
          </tbody></table></div>
        </>
      )}
      <div style={{ marginTop: 10 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={save} busy={busy} />
    </Modal>
  );
}
