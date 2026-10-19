// "Export HTML" dialog: choose the date range and the currency, then the page builds and downloads the report.
import { useEffect, useState } from 'react';
import { addDays } from '../../../src/shared/time';
import { type ApiErr } from '../lib/api';
import { today } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { toast } from '../lib/store';
import { CurrencyOptions, ErrBox, Modal, ModalActions } from './ui';

export interface ExportRange { from: string; to: string; cur: string }

export function ExportHtmlButton(p: { title: string; init: ExportRange; count?: (q: ExportRange) => Promise<number>; run: (q: ExportRange) => Promise<number> }) {
  const { L } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>{L('导出 HTML', 'Export HTML')}</button>
      {open && <ExportHtmlDialog {...p} onClose={() => setOpen(false)} />}
    </>
  );
}

function ExportHtmlDialog({ title, init, count, run, onClose }: { title: string; init: ExportRange; count?: (q: ExportRange) => Promise<number>; run: (q: ExportRange) => Promise<number>; onClose: () => void }) {
  const { L, dt } = useI18n();
  const t = today();
  const [q, setQ] = useState<ExportRange>(init);
  const [n, setN] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const range = (): ExportRange => (q.from <= q.to ? q : { ...q, from: q.to, to: q.from });
  useEffect(() => {
    if (!count) return;
    let live = true;
    setN(null);
    const h = setTimeout(() => { count(range()).then((x) => live && setN(x)).catch(() => live && setN(null)); }, 250);
    return () => { live = false; clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.from, q.to, q.cur]);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const rows = await run(range());
      toast(L(`已导出 ${rows} 行`, `Exported ${rows} rows`));
      onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  const month = t.slice(0, 8) + '01';
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <div className="fg xfg">
        <div><label>{L('开始', 'From')}</label><input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value || t })} /></div>
        <div><label>{L('结束', 'To')}</label><input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value || t })} /></div>
        <div className="full"><label>{L('货币', 'Currency')}</label><select value={q.cur} onChange={(e) => setQ({ ...q, cur: e.target.value })}><CurrencyOptions all={L('全部货币', 'All currencies')} /></select></div>
      </div>
      <div className="xquick">
        <button className="btn sm" onClick={() => setQ({ ...q, from: t, to: t })}>{L('今天', 'Today')}</button>
        <button className="btn sm" onClick={() => setQ({ ...q, from: addDays(t, -6), to: t })}>{L('最近 7 天', 'Last 7 days')}</button>
        <button className="btn sm" onClick={() => setQ({ ...q, from: month, to: t })}>{L('本月', 'This month')}</button>
      </div>
      {count && <div className="xhint">{n == null ? '…' : `${n} ${L('笔记录', 'records')} · ${q.cur || L('全部货币', 'all currencies')}`}</div>}
      <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={go} busy={busy} okLabel={L('导出', 'Export')} />
      {busy && <div className="xhint">{dt({ zh: '正在产生报表…', en: 'Building the report…' })}</div>}
    </Modal>
  );
}
