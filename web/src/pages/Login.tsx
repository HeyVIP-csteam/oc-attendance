import { useState } from 'react';
import { ErrBox } from '../components/ui';
import { api, type ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';

export function Login({ onDone }: { onDone: () => void }) {
  const { L, lang, setLang } = useI18n();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState<ApiErr | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try { await api('/auth/login', { method: 'POST', body: { username: u.trim(), password: p } }); setP(''); onDone(); }
    catch (x) { setErr(x as ApiErr); } finally { setBusy(false); }
  };
  return (
    <div className="loginwrap">
      <form className="loginbox" onSubmit={submit}>
        <div className="brand"><div className="logo">TA</div><div className="bt">TG Attendance<small>{L('管理员登录', 'Administrator sign-in')}</small></div></div>
        <label htmlFor="lu">{L('账号', 'Username')}</label>
        <input id="lu" type="text" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} autoFocus required />
        <label htmlFor="lp">{L('密码', 'Password')}</label>
        <input id="lp" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required />
        <div style={{ marginTop: 12 }}><ErrBox error={err} /></div>
        <button className="btn p" type="submit" disabled={busy}>{busy ? L('登录中…', 'Signing in…') : L('登录', 'Sign in')}</button>
        <div className="loginfoot">
          <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value as 'zh' | 'en')}><option value="en">English</option><option value="zh">中文</option></select>
        </div>
      </form>
    </div>
  );
}
