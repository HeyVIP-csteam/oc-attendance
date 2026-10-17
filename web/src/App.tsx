import { useCallback, useEffect, useRef, useState } from 'react';
import { Layout, type PageKey } from './components/Layout';
import { Toast } from './components/ui';
import { api, onUnauthorized } from './lib/api';
import { initialLang, type Lang, LangCtx, saveLang } from './lib/i18n';
import { DataCtx, type Meta, resetPageStore } from './lib/store';
import { Attendance } from './pages/Attendance';
import { Breaks } from './pages/Breaks';
import { Employees } from './pages/Employees';
import { Exceptions } from './pages/Exceptions';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Reports } from './pages/Reports';
import { SettingsPage } from './pages/Settings';
import { Shifts } from './pages/Shifts';

const PAGES: PageKey[] = ['overview', 'attendance', 'breaks', 'reports', 'employees', 'shifts', 'exceptions', 'settings'];
const pageFromPath = (): PageKey => { const p = location.pathname.replace(/^\/+|\/+$/g, '') as PageKey; return PAGES.includes(p) ? p : 'overview'; };

// Polling: one tiny request (/api/version reads one row) every 60 s, only while the tab is visible and the
// admin has been active in the last 10 minutes. Data is re-fetched only when the version changed.
const POLL_MS = 60_000;
const IDLE_MS = 10 * 60_000;

export function App() {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = (l: Lang) => { setLangState(l); saveLang(l); };
  useEffect(() => { document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'; }, [lang]);

  const [auth, setAuth] = useState<'loading' | 'out' | 'in'>('loading');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [page, setPage] = useState<PageKey>(pageFromPath);
  const [tick, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const version = useRef<number | null>(null);
  const lastActive = useRef(Date.now());

  const reloadMeta = useCallback(async () => {
    const m = await api<Meta>('/meta');
    version.current = m.dataVersion;
    setMeta(m);
  }, []);

  useEffect(() => {
    reloadMeta().then(() => setAuth('in')).catch(() => setAuth('out'));
    return onUnauthorized(() => { setAuth('out'); setMeta(null); });
  }, [reloadMeta]);

  useEffect(() => {
    const f = () => setPage(pageFromPath());
    window.addEventListener('popstate', f);
    return () => window.removeEventListener('popstate', f);
  }, []);
  const nav = (p: PageKey) => { if (p !== page) { history.pushState(null, '', '/' + p); setPage(p); window.scrollTo(0, 0); } };

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const check = useCallback(async () => {
    try {
      const { v } = await api<{ v: number }>('/version');
      if (version.current !== null && v !== version.current) refresh();
      version.current = v;
    } catch { /* offline or signed out: handled elsewhere */ }
  }, [refresh]);

  useEffect(() => {
    if (auth !== 'in') return;
    const activity = () => { lastActive.current = Date.now(); if (paused) { setPaused(false); void check(); } };
    const events = ['mousedown', 'keydown', 'touchstart', 'wheel'];
    events.forEach((e) => window.addEventListener(e, activity, { passive: true }));
    const vis = () => { if (document.visibilityState === 'visible') { lastActive.current = Date.now(); setPaused(false); void check(); } };
    document.addEventListener('visibilitychange', vis);
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastActive.current > IDLE_MS) { setPaused(true); return; }
      void check();
    }, POLL_MS);
    return () => { events.forEach((e) => window.removeEventListener(e, activity)); document.removeEventListener('visibilitychange', vis); clearInterval(t); };
  }, [auth, paused, check]);

  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    resetPageStore();
    setMeta(null);
    setAuth('out');
  };

  const content = () => {
    switch (page) {
      case 'overview': return <Overview />;
      case 'attendance': return <Attendance />;
      case 'breaks': return <Breaks />;
      case 'reports': return <Reports />;
      case 'employees': return <Employees />;
      case 'shifts': return <Shifts />;
      case 'exceptions': return <Exceptions />;
      case 'settings': return <SettingsPage />;
    }
  };

  return (
    <LangCtx.Provider value={{ lang, setLang }}>
      {auth === 'loading' && <div className="loadbar" />}
      {auth === 'out' && <Login onDone={() => reloadMeta().then(() => setAuth('in'))} />}
      {auth === 'in' && meta && (
        <DataCtx.Provider value={{ meta, reloadMeta, tick, refresh, readOnly: meta.user.role !== 'admin' }}>
          <Layout page={page} onNav={nav} paused={paused} onResume={() => { lastActive.current = Date.now(); setPaused(false); refresh(); }} onLogout={logout}>
            {content()}
          </Layout>
        </DataCtx.Provider>
      )}
      <Toast />
    </LangCtx.Provider>
  );
}
