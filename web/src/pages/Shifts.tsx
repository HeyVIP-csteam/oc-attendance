import { useRef, useState } from 'react';
import { addDays, dayDiff, monthEnd, monthStart, weekday } from '../../../src/shared/time';
import { Cnt, CurrencyOptions, EmpSearch, ErrBox, Field, Modal, ModalActions, Pager, Tabs, TblTop } from '../components/ui';
import { api, type ApiErr, qs } from '../lib/api';
import { exportXLSX, readGrid } from '../lib/files';
import { fmtDT, fmtDur, fmtT, today } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { type MetaShift, rulesOf, toast, useApi, useData, usePageState } from '../lib/store';

interface Inst { employee_id: number; shift_date: string; shift_id: number; shift_code: string; shift_name: string; scheduled_start_at: number; scheduled_end_at: number; adjustment_status: string; source: string }
interface RosterData { counts?: Record<string, number>; ot?: { employee_id: number; work_date: string; actual_in_at: number; actual_out_at: number | null; kind: 'OFF' | 'LONG' }[]; from: string; to: string; total: number; employees: { id: number; employee_code: string; name: string; currency_code: string | null; employment_status: string }[]; instances: Inst[] }

export function Shifts() {
  const { L } = useI18n();
  const t = today();
  const [f, set] = usePageState('sh', () => ({ tab: 'roster' as 'roster' | 'history' | 'tpl', cq: '', cpage: 1, hfrom: t, hto: t, from: monthStart(t), to: monthEnd(t), cur: '', page: 1, size: 10 }));
  return (
    <>
      <Tabs items={[['roster', L('排班表（Shift Instances）', 'Roster (shift instances)')], ['history', L('历史记录', 'History')], ['tpl', L('班次模板', 'Shift templates')]]} value={f.tab} onChange={(tab) => set({ tab })} />
      {f.tab === 'tpl' ? <Templates /> : f.tab === 'history' ? <History q={f.cq} cur={f.cur} from={f.hfrom} to={f.hto} page={f.cpage} size={f.size} set={(p) => set(p)} /> : <Roster f={f} set={set} />}
    </>
  );
}

function Roster({ f, set }: { f: { from: string; to: string; cur: string; page: number; size: number }; set: (p: Partial<{ from: string; to: string; cur: string; page: number; size: number }>) => void }) {
  const { L, lang } = useI18n();
  const { readOnly, meta } = useData();
  const t = today();
  const { data, error } = useApi<RosterData>(`/roster?${qs({ from: f.from, to: f.to, cur: f.cur, page: f.page, size: f.size })}`);
  const [cell, setCell] = useState<{ emp: RosterData['employees'][number]; date: string; inst: Inst | undefined; cancelled: boolean } | null>(null);
  const [plan, setPlan] = useState<{ grid: (string | number | null)[][]; file: string; plan: any; currency: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const days: string[] = [];
  if (data) for (let d = data.from; d <= data.to; d = addDays(d, 1)) days.push(d);
  const [lo, hi] = f.from <= f.to ? [f.from, f.to] : [f.to, f.from];
  const capped = dayDiff(hi, lo) >= 31;
  const compact = days.length > 14;
  const wd = (d: string) => (lang === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['日', '一', '二', '三', '四', '五', '六'])[weekday(d)];
  const byKey = new Map((data?.instances ?? []).map((i) => [`${i.employee_id}|${i.shift_date}`, i]));
  const otKey = new Map((data?.ot ?? []).map((o) => [`${o.employee_id}|${o.work_date}`, o]));
  const doExport = async () => {
    try {
      const r = await api<{ from: string; to: string; employees: { id: number; employee_code: string; name: string; currency_code: string | null }[]; instances: { employee_id: number; shift_date: string; shift_code: string }[] }>(`/roster/export?${qs({ from: f.from, to: f.to, cur: f.cur })}`);
      const ds: string[] = [];
      for (let d = r.from; d <= r.to; d = addDays(d, 1)) ds.push(d);
      const m = new Map(r.instances.map((i) => [`${i.employee_id}|${i.shift_date}`, i.shift_code]));
      await exportXLSX(`roster_${r.from}_${r.to}${f.cur ? '_' + f.cur : ''}`, ['PSD ID', 'Employee Name', 'Currency', ...ds], r.employees.map((e) => [e.employee_code, e.name, e.currency_code ?? '', ...ds.map((d) => m.get(`${e.id}|${d}`) ?? 'OFF')]));
      toast(L(`已导出 ${r.employees.length} 名员工的排班`, `Exported the roster of ${r.employees.length} employees`));
    } catch (e) { toast(L('导出失败', 'Export failed') + ': ' + (e as Error).message); }
  };
  // the import format with the selected dates and the employees of the selected currency, every shift cell empty
  const doTemplate = async () => {
    try {
      const r = await api<{ from: string; to: string; employees: { id: number; employee_code: string; name: string; currency_code: string | null }[] }>(`/roster/export?${qs({ from: f.from, to: f.to, cur: f.cur })}`);
      const ds: string[] = [];
      for (let d = r.from; d <= r.to; d = addDays(d, 1)) ds.push(d);
      await exportXLSX(`roster_template_${r.from}_${r.to}${f.cur ? '_' + f.cur : ''}`, ['PSD ID', 'Employee Name', 'Currency', ...ds],
        r.employees.map((e) => [e.employee_code, e.name, e.currency_code ?? '', ...ds.map(() => '')]), [
          ['How to use', 'Fill in the shift codes, then Shifts & Roster → Import'],
          ['Shift codes', `${meta.shifts.filter((s) => s.is_active).map((s) => s.code).join(' / ')} / OFF`],
          ['Empty cell', 'An empty cell leaves that day unchanged'],
          ['Dates', 'Each column header is a date (YYYY-MM-DD). You can add or remove date columns'],
          ['Employees', 'Rows can be added or removed; only the PSD ID column is used to find the employee'],
        ]);
    } catch (e) { toast(L('导出失败', 'Export failed') + ': ' + (e as Error).message); }
  };
  const doImport = async (file: File) => {
    try {
      const grid = await readGrid(file);
      const r = await api<{ plan: any }>('/roster/import', { method: 'POST', body: { grid, fileName: file.name, currency: f.cur } });
      setPlan({ grid, file: file.name, plan: r.plan, currency: f.cur });
    } catch (e) { toast(L('无法读取文件', 'Could not read the file') + ': ' + ((e as ApiErr).msg ? L((e as ApiErr).msg.zh, (e as ApiErr).msg.en) : (e as Error).message)); }
  };
  return (
    <>
      <div className="card"><div className="row">
        <Field label={L('开始', 'From')}><input type="date" value={f.from} onChange={(e) => set({ from: e.target.value || t, page: 1 })} /></Field>
        <Field label={L('结束', 'To')}><input type="date" value={f.to} onChange={(e) => set({ to: e.target.value || t, page: 1 })} /></Field>
        <Field label={L('货币', 'Currency')}><select value={f.cur} onChange={(e) => set({ cur: e.target.value, page: 1 })}><CurrencyOptions all={L('全部货币', 'All currencies')} /></select></Field>
        <div className="rowact">
          {!readOnly && <button className="btn" onClick={() => { if (fileRef.current) { fileRef.current.value = ''; fileRef.current.click(); } }}>{L('导入', 'Import')}</button>}
          <button className="btn" onClick={doExport}>{L('导出', 'Export')}</button>
          <button className="btn" onClick={doTemplate}>{L('导出模板', 'Export template')}</button>
          <input ref={fileRef} type="file" accept=".csv,.xlsx" hidden onChange={(e) => { const x = e.target.files?.[0]; if (x) void doImport(x); }} />
        </div>
        {capped && <span className="b w">{L('最多显示 31 天', 'Shows at most 31 days')}</span>}
      </div></div>
      <ErrBox error={error} />
      {data && (
        <>
          <TblTop left={<Cnt n={data.total} />} size={f.size} onSize={(size) => set({ size, page: 1 })} />
          <div className={`tw roster ${compact ? 'compact' : ''}`}><table><thead><tr>
            <th className="rid">{L('PSD ID', 'PSD ID')}</th><th className="rname">{L('员工姓名', 'Employee Name')}</th>{!f.cur && <th>{L('货币', 'Currency')}</th>}
            {days.map((d) => <th key={d} className={`${d === t ? 'today' : ''} ${[0, 6].includes(weekday(d)) ? 'wkend' : ''}`}>{compact ? <><span className="dw">{wd(d)}</span>{Number(d.slice(8))}</> : `${wd(d)} ${d.slice(5)}`}</th>)}
          </tr></thead><tbody>
            {data.employees.map((e) => (
              <tr key={e.id}>
                <td className="rid"><b>{e.employee_code}</b></td><td className="rname">{e.name}{e.employment_status !== 'ACTIVE' && <> <span className="b">{L('停用', 'Inactive')}</span></>}</td>{!f.cur && <td><span className="b">{e.currency_code ?? '—'}</span></td>}
                {days.map((d) => {
                  const raw = byKey.get(`${e.id}|${d}`);
                  const i = raw && raw.adjustment_status !== 'CANCELLED' ? raw : undefined;
                  const cancelled = !!raw && raw.adjustment_status === 'CANCELLED';
                  const ot = otKey.get(`${e.id}|${d}`);
                  return (
                    <td key={d}><span className={`cell ${i ? i.shift_code : 'OFF'}`} title={i ? `${i.shift_name} ${fmtT(i.scheduled_start_at)}–${fmtT(i.scheduled_end_at)} (LK)${ot?.kind === 'LONG' && ot.actual_out_at
                        ? L(`\nOT：实际 ${fmtT(ot.actual_in_at)} – ${fmtT(ot.actual_out_at)}，在班 ${fmtDur(ot.actual_out_at - ot.actual_in_at)}（超过 ${rulesOf(meta, e.currency_code).otHours ?? 9} 小时）`, `\nOT: actual ${fmtT(ot.actual_in_at)} – ${fmtT(ot.actual_out_at)}, on shift ${fmtDur(ot.actual_out_at - ot.actual_in_at)} (over ${rulesOf(meta, e.currency_code).otHours ?? 9} h)`) : ''}`
                      : ot ? L(`休息日上班（OT）：${fmtT(ot.actual_in_at)} – ${ot.actual_out_at ? fmtT(ot.actual_out_at) : '未下班'}`, `Worked on a day off (OT): ${fmtT(ot.actual_in_at)} – ${ot.actual_out_at ? fmtT(ot.actual_out_at) : 'not clocked out'}`) : L('休息', 'Off')}
                      onClick={() => !readOnly && setCell({ emp: e, date: d, inst: i, cancelled })} style={readOnly ? { cursor: 'default' } : undefined}>
                      {i ? (compact ? i.shift_code : <>{i.shift_code}<br /><span style={{ fontWeight: 400 }}>{fmtT(i.scheduled_start_at)}</span></>) : (compact ? '–' : 'OFF')}
                      {ot && (!i || ot.kind === 'LONG') && <span className="ot">OT</span>}
                    </span></td>
                  );
                })}
              </tr>
            ))}
          </tbody></table></div>
          <Pager total={data.total} page={f.page} size={f.size} onPage={(page) => set({ page })} />
        </>
      )}
      {cell && <CellModal {...cell} onClose={() => setCell(null)} />}
      {plan && <ImportModal {...plan} onClose={() => setPlan(null)} />}
    </>
  );
}

function CellModal({ emp, date, inst, onClose }: { emp: { id: number; employee_code: string; name: string }; date: string; inst: Inst | undefined; onClose: () => void }) {
  const { L } = useI18n();
  const { meta, refresh } = useData();
  const hist = useApi<{ rows: { created_at: number; actor: string; note: string; before_json: string | null }[] }>(`/roster/history?employeeId=${emp.id}&date=${date}`);
  const [val, setVal] = useState(inst ? String(inst.shift_id) : '');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (reason.trim().length < 4) return setErr(new Error(L('请填写原因（至少 4 个字）', 'Please give a reason (at least 4 characters)')));
    if (!val) return setErr(new Error(L('请选择班次', 'Please choose a shift')));
    setBusy(true);
    try {
      await api('/roster/cell', { method: 'PUT', body: { employeeId: emp.id, date, value: val === 'OFF' ? 'OFF' : Number(val), reason } });
      toast(L('班次已调整，考勤已重算', 'Shift changed; attendance recalculated'));
      refresh();
      onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{L('调整班次', 'Change shift')} · {emp.employee_code} {emp.name} · {date}</h3>
      <p>{L('当前：', 'Current: ')}<b>{inst ? `${inst.shift_name} ${fmtDT(inst.scheduled_start_at)} → ${fmtDT(inst.scheduled_end_at)}` : L('OFF（无班次）', 'OFF (no shift)')}</b></p>
      {hist.data && hist.data.rows.length > 0 && <div className="note">{hist.data.rows.map((h, i) => <div key={i}>{fmtDT(h.created_at)} {h.actor}：{h.note}</div>)}</div>}
      <div className="fg"><div><label>{L('调整为', 'Change to')}</label><select value={val} onChange={(e) => setVal(e.target.value)}>
        {!inst && <option value="">—</option>}
        {meta.shifts.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}<option value="OFF">{L('OFF（取消班次）', 'OFF (cancel shift)')}</option>
      </select></div></div>
      <div style={{ marginTop: 10 }}><label className="mut" style={{ fontSize: 12 }}>{L('原因（必填）', 'Reason (required)')}</label><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={save} busy={busy} />
    </Modal>
  );
}

function ImportModal({ grid, file, plan, currency, onClose }: { grid: (string | number | null)[][]; file: string; plan: any; currency: string; onClose: () => void }) {
  const { L, dt } = useI18n();
  const { refresh } = useData();
  const t = today();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const lbl = (c: string) => <span className={`cell ${c}`} style={{ display: 'inline-block', minWidth: 44, padding: '1px 6px' }}>{c}</span>;
  const apply = async () => {
    if (reason.trim().length < 4) return setErr(new Error(L('请填写原因（至少 4 个字）', 'Please give a reason (at least 4 characters)')));
    setBusy(true);
    try {
      const r = await api<{ applied: { added: number; changed: number; removed: number } }>('/roster/import', { method: 'POST', body: { grid, fileName: file, apply: true, reason, currency } });
      toast(L(`已导入 ${plan.changeCount} 项排班，考勤已重算`, `Imported ${plan.changeCount} roster changes; attendance recalculated`) + ` (+${r.applied.added} / ~${r.applied.changed} / −${r.applied.removed})`);
      refresh();
      onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose} wide>
      <h3 style={{ marginTop: 0 }}>{L('导入排班', 'Import roster')}{currency ? ` · ${currency}` : ''} · {file}</h3>
      <div className="kv">
        <div><span>{L('读取格子', 'Cells read')}</span><b>{plan.cells}</b></div><div><span>{L('将修改', 'Changes')}</span><b>{plan.changeCount}</b></div>
        <div><span>{L('不变', 'Unchanged')}</span><b>{plan.unchanged}</b></div>
        {currency && <div><span>{L(`非 ${currency} 员工（跳过）`, `Not ${currency} (skipped)`)}</span><b style={{ color: plan.skipped ? 'var(--warn)' : 'inherit' }}>{plan.skipped ?? 0}</b></div>}
        <div><span>{L('错误（跳过）', 'Errors (skipped)')}</span><b style={{ color: plan.errorCount - (plan.skipped ?? 0) ? 'var(--bad)' : 'inherit' }}>{plan.errorCount - (plan.skipped ?? 0)}</b></div>
        <div><span>{L('今天及以前', 'Today or earlier')}</span><b style={{ color: plan.pastCount ? 'var(--warn)' : 'inherit' }}>{plan.pastCount}</b></div>
      </div>
      {plan.changes.length > 0 && (
        <div className="tw" style={{ marginTop: 12, maxHeight: 260, overflow: 'auto' }}><table><thead><tr><th className="pid">{L('PSD ID', 'PSD ID')}</th><th>{L('员工姓名', 'Employee Name')}</th><th>{L('日期', 'Date')}</th><th>{L('原本', 'Current')}</th><th>{L('改为', 'New')}</th></tr></thead><tbody>
          {plan.changes.map((c: any, i: number) => <tr key={i}><td className="pid"><b>{c.code}</b></td><td>{c.name}</td><td>{c.date}{c.date <= t && <> <span className="b w">{L('会重算', 'recalc')}</span></>}</td><td>{lbl(c.from)}</td><td>{lbl(c.to)}</td></tr>)}
        </tbody></table></div>
      )}
      {plan.errors.length > 0 && (
        <div className="tw" style={{ marginTop: 12, maxHeight: 160, overflow: 'auto' }}><table><thead><tr><th>{L('位置', 'Where')}</th><th>{L('错误', 'Error')}</th></tr></thead><tbody>
          {plan.errors.map((x: any, i: number) => <tr key={i}><td>{x.where}</td><td style={{ color: 'var(--bad)' }}>{dt(x.msg)}</td></tr>)}
        </tbody></table></div>
      )}
      {plan.changeCount > 0 && <div style={{ marginTop: 12 }}><label className="mut" style={{ fontSize: 12 }}>{L('原因（必填）', 'Reason (required)')}</label><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
      <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={plan.changeCount > 0 ? apply : undefined} busy={busy} okLabel={L(`确认导入 ${plan.changeCount} 项`, `Import ${plan.changeCount} changes`)} />
    </Modal>
  );
}

function Templates() {
  const { L } = useI18n();
  const { meta, readOnly } = useData();
  const [edit, setEdit] = useState<MetaShift | 'new' | null>(null);
  const date = (ms: number) => fmtDT(ms).slice(0, 10);
  return (
    <>
      <div className="tw"><table className="tpltbl"><thead><tr>
        <th>Code</th><th>{L('名称', 'Name')}</th><th>{L('时间', 'Time')}</th><th className="n">{L('迟到宽限', 'Late grace')}</th><th className="n">{L('早退宽限', 'Early grace')}</th>
        <th>{L('创建日期', 'Create Date')}</th><th>{L('启用', 'Active')}</th><th className="c">{L('操作', 'Action')}</th>
      </tr></thead><tbody>
        {meta.shifts.map((s) => (
          <tr key={s.id}>
            <td><span className={`chip cell ${s.code}`}>{s.code}</span></td><td>{s.name}</td><td>{s.start_time}–{s.end_time}</td><td className="n">{s.late_grace_min}m</td><td className="n">{s.early_grace_min}m</td>
            <td>{date(s.created_at)}</td>
            <td>{s.is_active ? <span className="b ok">Active</span> : <span className="b">Off</span>}</td>
            <td>{!readOnly && <button className="btn sm" onClick={() => setEdit(s)}>{L('编辑', 'Edit')}</button>}</td>
          </tr>
        ))}
      </tbody></table></div>
      {edit && <ShiftModal s={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function ShiftModal({ s, onClose }: { s: MetaShift | null; onClose: () => void }) {
  const { L } = useI18n();
  const { reloadMeta, refresh } = useData();
  const [v, setV] = useState({ code: s?.code ?? '', name: s?.name ?? '', start: s?.start_time ?? '09:00', end: s?.end_time ?? '18:00', lg: String(s?.late_grace_min ?? 5), eg: String(s?.early_grace_min ?? 5), br: s?.break_minutes == null ? '' : String(s.break_minutes), active: s ? !!s.is_active : true, apply: true });
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const code = v.code.trim().toUpperCase();
    if (!s && !/^[A-Z]{1,3}$/.test(code)) return setErr(new Error(L('Code 必须是 1–3 个英文字母', 'Code must be 1–3 letters')));
    if (!v.name.trim()) return setErr(new Error(L('名称必填', 'Name is required')));
    if (v.start === v.end) return setErr(new Error(L('开始与结束不能相同', 'Start and end cannot be the same')));
    setBusy(true);
    try {
      const n = (x: string) => Math.max(0, Number(x) || 0);
      const r = await api<{ count: number }>(s ? `/shifts/${s.id}` : '/shifts', { method: s ? 'PUT' : 'POST', body: { ...(s ? {} : { code }), name: v.name.trim(), start: v.start, end: v.end, lateGrace: n(v.lg), earlyGrace: n(v.eg), breakMinutes: v.br === '' ? null : n(v.br), isActive: v.active, applyFuture: v.apply } });
      toast(L(`班次模板已保存${r.count ? `；更新 ${r.count} 个未来班次` : ''}`, `Shift template saved${r.count ? `; ${r.count} future instances updated` : ''}`));
      await reloadMeta();
      refresh();
      onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  const upd = (p: Partial<typeof v>) => setV({ ...v, ...p });
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{s ? L('编辑班次 ', 'Edit shift ') + s.name : L('新增班次', 'Add shift')}</h3>
      <div className="fg">
        <div><label>Code</label><input type="text" maxLength={3} value={v.code} disabled={!!s} onChange={(e) => upd({ code: e.target.value })} /></div>
        <div><label>{L('名称', 'Name')}</label><input type="text" value={v.name} onChange={(e) => upd({ name: e.target.value })} /></div>
        <div><label>{L('开始（Colombo）', 'Start (Colombo)')}</label><input type="time" value={v.start} onChange={(e) => upd({ start: e.target.value })} /></div>
        <div><label>{L('结束（Colombo；≤ 开始 视为跨午夜）', 'End (Colombo; ≤ start = overnight)')}</label><input type="time" value={v.end} onChange={(e) => upd({ end: e.target.value })} /></div>
        <div><label>{L('迟到宽限（分钟）', 'Late grace (min)')}</label><input type="number" min={0} value={v.lg} onChange={(e) => upd({ lg: e.target.value })} /></div>
        <div><label>{L('早退宽限（分钟）', 'Early leave grace (min)')}</label><input type="number" min={0} value={v.eg} onChange={(e) => upd({ eg: e.target.value })} /></div>
        <div><label>{L('启用', 'Active')}</label><select value={v.active ? '1' : '0'} onChange={(e) => upd({ active: e.target.value === '1' })}><option value="1">Active</option><option value="0">Inactive</option></select></div>
      </div>
      {s && <label style={{ display: 'block', marginTop: 10, fontSize: 13 }}><input type="checkbox" checked={v.apply} onChange={(e) => upd({ apply: e.target.checked })} /> {L('同时更新明天及以后的班次实例（今天及以前的考勤不变）', 'Also update shift instances from tomorrow onwards (today and earlier stay unchanged)')}</label>}
      <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={save} busy={busy} />
    </Modal>
  );
}

// ---------------------------------------------------------------- roster history: manual shift changes + roster imports
interface HistRow { id: number; created_at: number; actor: string; action: string; entity_id: string; before_json: string | null; after_json: string | null; note: string | null; employee_code: string | null; name: string | null }

function History({ q, cur, from, to, page, size, set }: { q: string; cur: string; from: string; to: string; page: number; size: number; set: (p: { cur?: string; cq?: string; hfrom?: string; hto?: string; cpage?: number; size?: number }) => void }) {
  const { L } = useI18n();
  const { data, error } = useApi<{ total: number; rows: HistRow[] }>(`/roster/history-log?${qs({ q, cur, from, to, page, size })}`);
  const t = today();
  const parse = (s: string | null) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
  const chip = (c: string | undefined) => <span className={`cell ${c ?? 'OFF'}`} style={{ display: 'inline-block', minWidth: 40, padding: '1px 6px' }}>{c ?? '—'}</span>;
  return (
    <>
      <div className="card"><div className="row">
        <Field label={L('开始', 'From')}><input type="date" value={from} max={t} onChange={(e) => set({ hfrom: e.target.value || t, cpage: 1 })} /></Field>
        <Field label={L('结束', 'To')}><input type="date" value={to} max={t} onChange={(e) => set({ hto: e.target.value || t, cpage: 1 })} /></Field>
        <Field label={L('货币', 'Currency')}><select value={cur} onChange={(e) => set({ cur: e.target.value, cpage: 1 })}><CurrencyOptions all={L('全部货币', 'All currencies')} /></select></Field>
        <Field label={L('员工', 'Employee')}><EmpSearch value={q} onChange={(v) => set({ cq: v, cpage: 1 })} /></Field>
      </div></div>
      <ErrBox error={error} />
      {data && (data.rows.length === 0 ? <div className="card empty">{L('这段期间没有记录', 'No history in this period')}</div> : (
        <>
          <TblTop left={<Cnt n={data.total} />} size={size} onSize={(n) => set({ size: n, cpage: 1 })} />
          <div className="tw"><table className="grid tpltbl"><thead><tr>
            <th className="pid">{L('PSD ID', 'PSD ID')}</th><th>{L('员工姓名 / 文件', 'Employee Name / File')}</th><th>{L('时间', 'Time')}</th><th>{L('动作', 'Action')}</th><th>{L('班次日期', 'Shift date')}</th>
            <th>{L('变更', 'Change')}</th><th>{L('原因', 'Reason')}</th><th>{L('操作人', 'By')}</th>
          </tr></thead><tbody>
            {data.rows.map((r) => {
              const b = parse(r.before_json), a = parse(r.after_json);
              const imp = r.action === 'ROSTER_IMPORTED';
              return (
                <tr key={r.id}>
                  <td className="pid">{imp ? <span className="mut">—</span> : <b>{r.employee_code ?? r.entity_id.split('@')[0]}</b>}</td>
                  <td>{imp ? <>📄 {r.entity_id}</> : r.name ?? <span className="mut">—</span>}</td>
                  <td className="nw">{fmtDT(r.created_at)}</td>
                  <td>{imp ? <span className="b i">{L('导入排班', 'Roster import')}</span> : <span className="b v">{L('换班', 'Shift change')}</span>}</td>
                  <td>{imp ? <span className="mut">—</span> : r.entity_id.split('@')[1] ?? ''}</td>
                  <td className="nw">{imp
                    ? L(`新增 ${a.added ?? 0} · 修改 ${a.changed ?? 0} · 取消 ${a.removed ?? 0}${a.skipped_errors ? ` · 跳过 ${a.skipped_errors}` : ''}`, `+${a.added ?? 0} added · ${a.changed ?? 0} changed · ${a.removed ?? 0} removed${a.skipped_errors ? ` · ${a.skipped_errors} skipped` : ''}`)
                    : <>{chip(b.shift)} → {chip(a.shift)}</>}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 180 }}>{r.note}</td>
                  <td>{r.actor}</td>
                </tr>
              );
            })}
          </tbody></table></div>
          <Pager total={data.total} page={page} size={size} onPage={(p) => set({ cpage: p })} />
        </>
      ))}
    </>
  );
}
