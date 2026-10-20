// "Export HTML" dialog: choose the date range, the currency and (optionally) one agent, then the page builds and downloads the report.
import { useState } from 'react';
import { type ApiErr } from '../lib/api';
import { today } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { toast, useData } from '../lib/store';
import { CurrencyOptions, ErrBox, Modal, ModalActions } from './ui';

/** emp: one agent only; none = every agent of the currency. */
export interface ExportRange { from: string; to: string; cur: string; emp?: number }

export function ExportHtmlButton(p: { title: string; init: ExportRange; run: (q: ExportRange) => Promise<number> }) {
  const { L } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>{L('导出 HTML', 'Export HTML')}</button>
      {open && <ExportHtmlDialog {...p} onClose={() => setOpen(false)} />}
    </>
  );
}

function ExportHtmlDialog({ title, init, run, onClose }: { title: string; init: ExportRange; run: (q: ExportRange) => Promise<number>; onClose: () => void }) {
  const { L, dt } = useI18n();
  const { meta } = useData();
  const t = today();
  const [q, setQ] = useState<ExportRange>(init);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  // the agents of the chosen currency (all currencies: everyone this account can see); active first, then by PSD ID
  const agents = meta.employees.filter((e) => !q.cur || e.currency === q.cur)
    .sort((a, b) => Number(a.status !== 'ACTIVE') - Number(b.status !== 'ACTIVE') || a.code.localeCompare(b.code, undefined, { numeric: true }));
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const rows = await run(q.from <= q.to ? q : { ...q, from: q.to, to: q.from });
      toast(L(`已导出 ${rows} 行`, `Exported ${rows} rows`));
      onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <div className="fg xfg">
        <div><label>{L('开始', 'From')}</label><input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value || t })} /></div>
        <div><label>{L('结束', 'To')}</label><input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value || t })} /></div>
        {/* a new currency clears the agent: the list only holds that currency's agents */}
        <div className="full"><label>{L('货币', 'Currency')}</label><select value={q.cur} onChange={(e) => setQ({ ...q, cur: e.target.value, emp: undefined })}><CurrencyOptions all={L('全部货币', 'All currencies')} /></select></div>
        <div className="full"><label>Agent</label>
          <select value={q.emp ?? ''} onChange={(e) => setQ({ ...q, emp: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">{L(`全部 Agent（${agents.length}）`, `All agents (${agents.length})`)}</option>
            {agents.map((e) => <option key={e.id} value={e.id}>{e.code} · {e.name}{q.cur ? '' : ` · ${e.currency ?? '—'}`}{e.status !== 'ACTIVE' ? L('（已停用）', ' (inactive)') : ''}</option>)}
          </select></div>
      </div>
      <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={go} busy={busy} okLabel={L('导出', 'Export')} />
      {busy && <div className="xhint">{dt({ zh: '正在产生报表…', en: 'Building the report…' })}</div>}
    </Modal>
  );
}
