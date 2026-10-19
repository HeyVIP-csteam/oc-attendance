import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { toast, useData } from '../lib/store';
import { ErrBox, Modal, ModalActions } from './ui';

export type PageKey = 'overview' | 'attendance' | 'breaks' | 'reports' | 'employees' | 'shifts' | 'exceptions' | 'settings';

const NAV_ICON: Record<PageKey, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  attendance: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18M9 15.5l2 2 4-4" /></>,
  breaks: <><path d="M17 8h1a4 4 0 0 1 0 8h-1" /><path d="M3 8h14v8a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z" /><path d="M7 2v2M11 2v2M15 2v2" /></>,
  reports: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 18v-3M12 18v-6M16 18v-2" /></>,
  employees: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
  shifts: <><path d="M17 2l4 4-4 4" /><path d="M3 11V9a3 3 0 0 1 3-3h15" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a3 3 0 0 1-3 3H3" /></>,
  exceptions: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  settings: <><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></>,
};
const Icon = ({ children }: { children: ReactNode }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;

export function useNav() {
  const { L } = useI18n();
  return [
    ['grp', L('考勤', 'Attendance')], ['overview', L('总览', 'Overview')], ['attendance', L('考勤明细', 'Attendance')], ['breaks', L('休息管理', 'Breaks')], ['reports', L('报表', 'Reports')],
    ['grp', L('管理', 'Manage')], ['employees', L('员工', 'Employees')], ['shifts', L('班次与排班', 'Shifts & Roster')], ['exceptions', L('异常与审计', 'Exceptions & Audit')], ['settings', L('设置', 'Settings')],
  ] as [PageKey | 'grp', string][];
}

/** Header clock: the device's own time, updated every second in the browser (no server requests). */
function Clock() {
  const { lang, L } = useI18n();
  const [d, setD] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setD(new Date()), 1000); return () => clearInterval(t); }, []);
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const gmt = `GMT${off >= 0 ? '+' : '-'}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? ':' + p(Math.abs(off) % 60) : ''}`;
  const wd = lang === 'en' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] : '星期' + '日一二三四五六'[d.getDay()];
  return (
    <span className="clockpill" role="timer" aria-live="off" title={L(`设备时间（${gmt}）`, `Device time (${gmt})`)}>
      <span className="ck-day">{wd}</span><span className="ck-sep" />
      <span className="ck-date">{p(d.getMonth() + 1)}/{p(d.getDate())}/{d.getFullYear()}</span><span className="ck-sep" />
      <span className="ck-time">{p(d.getHours())}:{p(d.getMinutes())}:{p(d.getSeconds())}</span>
    </span>
  );
}

function PasswordModal({ onClose }: { onClose: () => void }) {
  const { L } = useI18n();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (next.length < 10) return setErr(new Error(L('新密码至少 10 个字符', 'The new password needs at least 10 characters')));
    if (next !== again) return setErr(new Error(L('两次输入的新密码不同', 'The new passwords do not match')));
    setBusy(true);
    try { await api('/auth/password', { method: 'POST', body: { current: cur, next } }); toast(L('密码已更改', 'Password changed')); onClose(); }
    catch (e) { setErr(e as Error); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{L('更改密码', 'Change password')}</h3>
      <div className="fg">
        <div style={{ gridColumn: '1/-1' }}><label>{L('当前密码', 'Current password')}</label><input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
        <div><label>{L('新密码（至少 10 个字符）', 'New password (min. 10 characters)')}</label><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></div>
        <div><label>{L('再次输入新密码', 'Repeat new password')}</label><input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></div>
      </div>
      <div style={{ marginTop: 10 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={save} busy={busy} />
    </Modal>
  );
}

export function Layout({ page, onNav, paused, onResume, onLogout, children }: { page: PageKey; onNav: (p: PageKey) => void; paused: boolean; onResume: () => void; onLogout: () => void; children: ReactNode }) {
  const { L, lang, setLang } = useI18n();
  const { meta } = useData();
  const nav = useNav();
  const [navOpen, setNavOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [pw, setPw] = useState(false);
  useEffect(() => { document.body.classList.toggle('navopen', navOpen); }, [navOpen]);
  useEffect(() => {
    if (!menu) return;
    const f = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.menuwrap')) setMenu(false); };
    document.addEventListener('mousedown', f);
    return () => document.removeEventListener('mousedown', f);
  }, [menu]);
  const title = nav.find(([k]) => k === page)?.[1] ?? '';
  return (
    <div id="app">
      <aside id="side">
        <div className="brand"><div className="logo">OC</div><div className="bt">OC Attendance<small>Outsource CS Attendance</small></div></div>
        {nav.map(([k, l], i) => k === 'grp'
          ? <div key={'g' + i} className="grp"><span className="lbl">{l}</span></div>
          : <a key={k} className={page === k ? 'on' : ''} title={l} href={'/' + k} onClick={(e) => { e.preventDefault(); setNavOpen(false); onNav(k); }}><Icon>{NAV_ICON[k]}</Icon><span className="lbl">{l}</span></a>)}
      </aside>
      <div id="scrim" onClick={() => setNavOpen(false)} />
      <div id="wrap">
        <header id="top">
          <button className="iconbtn" id="navbtn" aria-label="Menu" onClick={() => setNavOpen((v) => !v)}><Icon><path d="M4 6h16M4 12h16M4 18h16" /></Icon></button>
          <h1>{title}</h1>
          <div className="topctl">
            {paused && <button className="pollpill" onClick={onResume} title={L('自动刷新已暂停，点击刷新', 'Auto-refresh paused; click to refresh')}>⏸<span className="lbl"> {L('已暂停 · 点击刷新', 'Paused · click to refresh')}</span></button>}
            <Clock />
            <label className="sel">
              <Icon><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Icon>
              <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value as 'zh' | 'en')}><option value="en">English</option><option value="zh">中文</option></select>
            </label>
            <div className="menuwrap">
              <button className="iconbtn" id="resetbtn" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu}>
                <Icon><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></Icon><span className="lbl">{meta.user.username}</span>
              </button>
              {menu && (
                <div className="menu" role="menu">
                  <div className="who">{meta.user.username} · {meta.user.owner ? 'Owner' : meta.user.role === 'admin' ? L('管理员', 'Admin') : L('只读', 'Read-only')}{meta.user.currencies && <> · {meta.user.currencies.join(', ') || L('无货币', 'no currency')}</>}</div>
                  <button role="menuitem" onClick={() => { setMenu(false); setPw(true); }}>{L('更改密码', 'Change password')}</button>
                  <button role="menuitem" onClick={() => { setMenu(false); onLogout(); }}>{L('登出', 'Sign out')}</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main id="main">{children}</main>
      </div>
      {pw && <PasswordModal onClose={() => setPw(false)} />}
    </div>
  );
}
