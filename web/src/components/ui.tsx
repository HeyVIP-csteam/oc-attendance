import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { EXCEPTIONS, exceptionSeverity, ROSTER_COLORS, STATUSES } from '../../../src/shared/codes';
import type { ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { type MetaEmployee, useData, useToastText } from '../lib/store';

export const PAGE_SIZES = [10, 20, 30];

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className="fl"><label>{label}</label>{children}</div>;
}

/** The shift of a day: the shift name, else the roster code of that day (OFF, VL …), else "No schedule". */
export function ShiftName({ name, mark }: { name: string | null | undefined; mark?: string | null }) {
  const { L } = useI18n();
  const rc = useRosterCode();
  if (name) return <>{name}</>;
  const m = rc(mark);
  if (mark && m) return <span className="b mk" style={m.style} title={m.name}>{mark} · {m.name}</span>;
  return <>{L('未排班', 'No schedule')}</>;
}

export function StatusBadge({ st, mark }: { st: string; mark?: string | null }) {
  const { dt } = useI18n();
  const rc = useRosterCode();
  // a day marked OFF / VL … on the roster is that day off, not "no schedule"
  const m = st === 'NO_SCHEDULE' ? rc(mark) : null;
  if (m) return <span className="b mk" style={m.style}>{m.name}</span>;
  const s = (STATUSES as Record<string, { label: { zh: string; en: string }; cls: string }>)[st];
  return <span className={`b ${s?.cls ?? ''}`}>{s ? dt(s.label) : st}</span>;
}

export const exLabel = (code: string) => (EXCEPTIONS as Record<string, { label: { zh: string; en: string } }>)[code]?.label ?? { zh: code, en: code };

export function ExB({ code }: { code: string }) {
  const { dt } = useI18n();
  const sev = exceptionSeverity(code);
  return <span className={`b ${sev === 'HIGH' ? 'r' : sev === 'MEDIUM' ? 'w' : ''}`}>{dt(exLabel(code))}</span>;
}

export const SevB = ({ sev }: { sev: string }) => <span className={`b ${sev === 'HIGH' ? 'r' : sev === 'MEDIUM' ? 'w' : ''}`}>{sev}</span>;
export const CurB = ({ c }: { c: string | null | undefined }) => (c ? <span className="b i" style={{ fontSize: 11 }}>{c}</span> : <span className="mut">—</span>);
export const Mut = ({ children = '—' }: { children?: ReactNode }) => <span className="mut">{children}</span>;

export function Pager({ total, page, size, onPage }: { total: number; page: number; size: number; onPage: (p: number) => void }) {
  const { L } = useI18n();
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="pgbar">
      <button className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹ {L('上一页', 'Previous')}</button>
      <span className="pgnum">{L(`第 ${page} / ${pages} 页`, `Page ${page} / ${pages}`)}</span>
      <button className="btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>{L('下一页', 'Next')} ›</button>
    </div>
  );
}

export function TblTop({ left, size, onSize }: { left: ReactNode; size: number; onSize: (n: number) => void }) {
  const { L } = useI18n();
  return (
    <div className="tbltop">
      {left}
      <select className="pgsize" aria-label="Rows per page" value={size} onChange={(e) => onSize(Number(e.target.value))}>
        {PAGE_SIZES.map((n) => <option key={n} value={n}>{L(`每页 ${n} 条`, `${n} / page`)}</option>)}
      </select>
    </div>
  );
}
export function Cnt({ n }: { n: number }) {
  const { L } = useI18n();
  return <span className="cnt">{L(`共 ${n} 条`, `${n} rows`)}</span>;
}

export function Modal({ onClose, children, wide }: { onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* the rounded box clips; the inner layer scrolls, so the scrollbar never covers the rounded corners */}
      <div className="mbox" style={wide ? { maxWidth: 760 } : undefined} role="dialog" aria-modal="true"><div className="mscroll">{children}</div></div>
    </div>
  );
}

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  // the page behind the popup does not scroll while it is open
  useEffect(() => { const o = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = o; }; }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="drawer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dbox" role="dialog" aria-modal="true"><div className="dscroll">{children}</div></div>
    </div>
  );
}

export function ModalActions({ onCancel, onOk, okLabel, busy, extra }: { onCancel: () => void; onOk?: () => void; okLabel?: string; busy?: boolean; extra?: ReactNode }) {
  const { L } = useI18n();
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
      <button className="btn" onClick={onCancel}>{L('取消', 'Cancel')}</button>
      {extra}
      {onOk && <button className="btn p" disabled={busy} onClick={onOk}>{okLabel ?? L('保存', 'Save')}</button>}
    </div>
  );
}

export function Toast() {
  const { t, on } = useToastText();
  return <div id="toast" className={on ? 'on' : ''} role="status">{t}</div>;
}

export function ErrBox({ error }: { error: ApiErr | Error | null | undefined }) {
  const { dt } = useI18n();
  if (!error) return null;
  return <div className="errbox">{'msg' in error ? dt((error as ApiErr).msg) : error.message}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card empty">{children}</div>;
}

export function Tabs<T extends string>({ items, value, onChange }: { items: [T, string][]; value: T; onChange: (v: T) => void }) {
  return <div className="tabs">{items.map(([k, l]) => <button key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}</div>;
}

export function KvList({ obj, other }: { obj: unknown; other?: unknown }) {
  if (obj == null) return <span className="kvl"><span className="none">—</span></span>;
  if (typeof obj !== 'object') return <div className="kvl"><div>{String(obj)}</div></div>;
  const o = other && typeof other === 'object' ? (other as Record<string, unknown>) : null;
  return (
    <div className="kvl">
      {Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
        const s = v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        const chg = o !== null && JSON.stringify(o[k]) !== JSON.stringify(v);
        return <div key={k} className={chg ? 'chg' : ''}><b>{k}</b>{s}</div>;
      })}
    </div>
  );
}

export const jsonOrNull = (s: string | null | undefined): unknown => { if (!s) return null; try { return JSON.parse(s); } catch { return s; } };

// ---------------------------------------------------------------- employee search with suggestions (name / ID / topic)
function Hl({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

export function EmpSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { L } = useI18n();
  const { meta } = useData();
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const f = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', f);
    return () => document.removeEventListener('mousedown', f);
  }, []);
  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [] as MetaEmployee[];
    const out: { e: MetaEmployee; s: number }[] = [];
    for (const e of meta.employees) {
      const code = e.code.toLowerCase(), name = e.name.toLowerCase(), topic = String(e.thread ?? '');
      let s = -1;
      if (code === q) s = 100; else if (code.startsWith(q)) s = 90; else if (name.startsWith(q)) s = 80;
      else if (name.split(' ').some((w) => w.startsWith(q))) s = 70; else if (code.includes(q)) s = 60; else if (name.includes(q)) s = 50; else if (topic && topic.includes(q)) s = 40;
      if (s >= 0) out.push({ e, s });
    }
    return out.sort((a, b) => b.s - a.s || a.e.code.localeCompare(b.e.code)).slice(0, 8).map((x) => x.e);
  }, [text, meta.employees]);
  const commit = (v: string) => { clearTimeout(timer.current); setText(v); setOpen(false); onChange(v); };
  return (
    <div className="acw" ref={wrap}>
      <input type="text" value={text} placeholder={L('输入姓名或 PSD ID', 'Type a name or PSD ID')} autoComplete="off" spellCheck={false}
        role="combobox" aria-autocomplete="list" aria-expanded={open}
        onChange={(e) => { const v = e.target.value; setText(v); setOpen(!!v.trim()); setHi(0); clearTimeout(timer.current); timer.current = setTimeout(() => onChange(v), 300); }}
        onFocus={() => { if (text.trim()) setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!open) { setOpen(true); return; } if (!matches.length) return; setHi((i) => (e.key === 'ArrowDown' ? (i + 1) % matches.length : (i - 1 + matches.length) % matches.length)); }
          else if (e.key === 'Enter') { e.preventDefault(); if (open && matches[hi]) commit(matches[hi].code); else { setOpen(false); onChange(text); } }
          else if (e.key === 'Escape') setOpen(false);
        }} />
      {text && <button type="button" className="acx" aria-label="Clear" onClick={() => commit('')}>×</button>}
      {open && (
        <div className="acl" role="listbox">
          {matches.length ? matches.map((e, i) => (
            <div key={e.id} className={`aco ${i === hi ? 'on' : ''}`} role="option" aria-selected={i === hi} onMouseDown={(ev) => { ev.preventDefault(); commit(e.code); }} onMouseEnter={() => setHi(i)}>
              <b><Hl text={e.code} q={text.trim()} /></b><span><Hl text={e.name} q={text.trim()} /></span>
              <span className="meta">{e.currency && <CurB c={e.currency} />}{e.thread != null && <span>#<Hl text={String(e.thread)} q={text.trim()} /></span>}{e.status !== 'ACTIVE' && <span className="b">{L('停用', 'Inactive')}</span>}</span>
            </div>
          )) : <div className="acempty">{L('没有符合的员工', 'No matching employees')}</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- roster codes (OFF, VL …)
/** Inline colors for a roster code; null when the code is unknown. */
export function useRosterCode() {
  const { meta } = useData();
  const list = meta.rosterCodes ?? [];
  return (code: string | null | undefined) => {
    const c = code ? list.find((x) => x.code === code) : undefined;
    if (!c) return null;
    const [bg, fg] = ROSTER_COLORS[c.color] ?? ROSTER_COLORS[0];
    return { name: c.name, style: { background: bg, color: fg } as CSSProperties };
  };
}

// ---------------------------------------------------------------- currency switch (segmented)
export function CurSeg({ value, onChange, all, counts }: { value: string; onChange: (c: string) => void; all?: string; counts?: Record<string, number> }) {
  const { meta } = useData();
  const items: [string, string][] = [...(all != null ? [['', all] as [string, string]] : []), ...meta.currencies.map((c) => [c.code, c.code] as [string, string])];
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="seg" role="tablist">
      {items.map(([code, label]) => (
        <button key={code || 'all'} type="button" role="tab" aria-selected={value === code} className={value === code ? 'on' : ''} onClick={() => onChange(code)}>
          {label}{counts && <span className="dot">{code ? counts[code] ?? 0 : total}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- shared select options
export function CurrencyOptions({ all }: { all?: string }) {
  const { meta } = useData();
  return <>{all != null && <option value="">{all}</option>}{meta.currencies.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}</>;
}
export function ShiftOptions({ withNone }: { withNone?: boolean }) {
  const { meta } = useData();
  const { L } = useI18n();
  return <><option value="">{L('全部班次', 'All shifts')}</option>{meta.shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}{withNone && <option value="none">{L('未排班', 'No schedule')}</option>}</>;
}
export function StatusOptions({ all }: { all: string }) {
  const { dt, L } = useI18n();
  return <><option value="">{all}</option>{Object.entries(STATUSES).map(([k, v]) => <option key={k} value={k}>{dt(v.label)}</option>)}<option value="MISSING">{L('任何缺卡', 'Any missing punch')}</option><option value="ANY_LATE">{L('任何迟到', 'Any late')}</option><option value="ANY_EARLY">{L('任何早退', 'Any early leave')}</option><option value="HAS_SHIFT">{L('有排班', 'With a shift')}</option></>;
}

export function ShiftChip({ code, inline }: { code: string | null | undefined; inline?: boolean }) {
  if (!code) return null;
  return <span className={`chip cell ${code}`} style={inline ? { display: 'inline-block', minWidth: 0, padding: '0 6px' } : undefined}>{code}</span>;
}
