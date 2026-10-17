import { useEffect, useState } from 'react';
import { ErrBox } from '../components/ui';
import { api, type ApiErr } from '../lib/api';
import { useI18n } from '../lib/i18n';

/** Sign-in page. While no administrator exists yet it becomes the one-time "create the first admin" page. */
export function Login({ onDone }: { onDone: () => void }) {
  const { L, lang, setLang } = useI18n();
  const [mode, setMode] = useState<'login' | 'setup' | 'setup-off'>('login');
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [p2, setP2] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ needsSetup: boolean; setupEnabled: boolean }>('/auth/setup-status')
      .then((s) => { if (s.needsSetup) setMode(s.setupEnabled ? 'setup' : 'setup-off'); })
      .catch(() => {});
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (mode === 'setup') {
      if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(u.trim())) return setErr(new Error(L('账号需为 3–64 个英文字母、数字或 _ . @ -', 'Username: 3–64 letters, digits or _ . @ -')));
      if (p.length < 10) return setErr(new Error(L('密码至少 10 个字符', 'Password needs at least 10 characters')));
      if (p !== p2) return setErr(new Error(L('两次输入的密码不同', 'The passwords do not match')));
    }
    setBusy(true);
    try {
      if (mode === 'setup') await api('/auth/setup', { method: 'POST', body: { code, username: u.trim(), password: p } });
      else await api('/auth/login', { method: 'POST', body: { username: u.trim(), password: p } });
      setP(''); setP2('');
      onDone();
    } catch (x) { setErr(x as ApiErr); } finally { setBusy(false); }
  };
  const setup = mode === 'setup';
  return (
    <div className="loginwrap">
      <form className="loginbox" onSubmit={submit}>
        <div className="brand"><div className="logo">TA</div><div className="bt">TG Attendance<small>{setup ? L('建立第一个管理员', 'Create the first administrator') : L('管理员登录', 'Administrator sign-in')}</small></div></div>
        {mode === 'setup-off' && <div className="note w">{L('系统还没有管理员。请先在 Cloudflare 设定 SETUP_CODE（见部署说明），重新整理此页即可建立第一个管理员。', 'No administrator exists yet. Set the SETUP_CODE secret in Cloudflare (see the deployment guide), then reload this page to create the first administrator.')}</div>}
        {setup && (
          <>
            <div className="note">{L('只在第一次使用时出现。建立后此页面会自动关闭，之后的账号请在「设置 → 管理员账号」新增。', 'Shown only on first use. It closes once the first admin exists; add more accounts in Settings → Admin accounts.')}</div>
            <label htmlFor="lc">{L('设置码（Cloudflare 中的 SETUP_CODE）', 'Setup code (SETUP_CODE in Cloudflare)')}</label>
            <input id="lc" type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} required />
          </>
        )}
        <label htmlFor="lu">{L('账号', 'Username')}</label>
        <input id="lu" type="text" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} autoFocus required />
        <label htmlFor="lp">{setup ? L('密码（至少 10 个字符）', 'Password (min. 10 characters)') : L('密码', 'Password')}</label>
        <input id="lp" type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={p} onChange={(e) => setP(e.target.value)} required />
        {setup && <><label htmlFor="lp2">{L('再次输入密码', 'Repeat password')}</label><input id="lp2" type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} required /></>}
        <div style={{ marginTop: 12 }}><ErrBox error={err} /></div>
        <button className="btn p" type="submit" disabled={busy || mode === 'setup-off'}>{busy ? L('处理中…', 'Working…') : setup ? L('建立管理员并登录', 'Create admin and sign in') : L('登录', 'Sign in')}</button>
        <div className="loginfoot">
          <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value as 'zh' | 'en')}><option value="en">English</option><option value="zh">中文</option></select>
        </div>
      </form>
    </div>
  );
}
