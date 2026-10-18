import { useMemo, useState } from 'react';
import { DEFAULT_PARSER, EVENT_LABEL, EVENT_TYPES, type KeywordConfig, type ParserRules } from '../../../src/shared/codes';
import { toMin } from '../../../src/shared/time';
import { Empty, ErrBox, Field, Modal, ModalActions, Mut, Tabs } from '../components/ui';
import { api, ApiErr } from '../lib/api';
import { fmtDT } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { toast, useApi, useData, usePageState } from '../lib/store';

type Tab = 'shift3' | 'cur' | 'kw' | 'rules' | 'bot' | 'admins';

export function SettingsPage() {
  const { L } = useI18n();
  const [s, set] = usePageState('st', () => ({ tab: 'shift3' as Tab }));
  return (
    <>
      <Tabs items={[['shift3', L('班次设置', 'Shift Setting')], ['cur', L('货币', 'Currency')], ['kw', L('打卡关键词', 'Punch keywords')], ['rules', L('考勤与异常规则', 'Attendance rules')], ['bot', L('Bot 设置', 'Bot Setting')], ['admins', L('管理员账号', 'Admin accounts')]]} value={s.tab} onChange={(tab) => set({ tab })} />
      {s.tab === 'shift3' && <Shift3 />}
      {s.tab === 'cur' && <Currencies />}
      {s.tab === 'kw' && <Keywords />}
      {s.tab === 'rules' && <Rules />}
      {s.tab === 'bot' && <Bots />}
      {s.tab === 'admins' && <Admins />}
    </>
  );
}

const useErr = () => {
  const { dt } = useI18n();
  return (e: unknown) => toast((e as ApiErr).msg ? dt((e as ApiErr).msg) : String((e as Error).message));
};

// ---------------------------------------------------------------- Shift Setting (A / B / C)
function Shift3() {
  const { L } = useI18n();
  const { meta, reloadMeta, refresh, readOnly } = useData();
  const abc = ['A', 'B', 'C'].map((c) => meta.shifts.find((s) => s.code === c)).filter(Boolean) as typeof meta.shifts;
  const [v, setV] = useState(() => Object.fromEntries(abc.map((s) => [s.code, { name: s.name, start: s.start_time, end: s.end_time }])) as Record<string, { name: string; start: string; end: string }>);
  const [apply, setApply] = useState(true);
  const [busy, setBusy] = useState(false);
  const onErr = useErr();
  if (abc.length < 3) return <Empty>{L('找不到 A / B / C 班次模板', 'Shift templates A / B / C not found')}</Empty>;
  const g = (c: string) => ({ s: toMin(v[c].start), e: toMin(v[c].end) });
  const chain = g('A').e === g('B').s && g('B').e === g('C').s && g('C').e === g('A').s;
  const total = ['A', 'B', 'C'].reduce((t, c) => { const x = g(c); return t + ((x.e - x.s + 1440) % 1440 || 1440); }, 0);
  const ok = chain && total === 1440;
  const len = (c: string) => { const x = g(c); let d = x.e - x.s; if (d <= 0) d += 1440; return `${Math.floor(d / 60)}h${d % 60 ? ' ' + String(d % 60).padStart(2, '0') + 'm' : ''}`; };
  const save = async () => {
    for (const c of ['A', 'B', 'C']) if (!v[c].start || !v[c].end || v[c].start === v[c].end) { toast(L(`${c} 班时间无效`, `Invalid time for shift ${c}`)); return; }
    setBusy(true);
    try {
      const r = await api<{ changed: string[]; count: number }>('/shifts-bulk', { method: 'PUT', body: { applyFuture: apply, items: abc.map((s) => ({ id: s.id, name: v[s.code].name.trim() || s.name, start: v[s.code].start, end: v[s.code].end })) } });
      toast(r.changed.length ? L(`已保存 ${r.changed.join('/')} 班；更新 ${r.count} 个未来班次实例`, `Saved shift ${r.changed.join('/')}; ${r.count} future instances updated`) : L('没有修改', 'No changes'));
      await reloadMeta();
      refresh();
    } catch (e) { onErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="card"><h3>{L('班次设置（A / B / C）', 'Shift Setting (A / B / C)')}</h3>
      <div className="tw"><table className="shift3"><thead><tr><th>{L('班', 'Shift')}</th><th>{L('名称', 'Name')}</th><th>{L('斯里兰卡时间（UTC+05:30）', 'Sri Lanka time (UTC+05:30)')}</th><th>{L('时长', 'Length')}</th></tr></thead><tbody>
        {abc.map((s) => (
          <tr key={s.code}>
            <td><span className={`chip cell ${s.code}`}>{s.code}</span></td>
            <td><input type="text" style={{ width: 110 }} value={v[s.code].name} disabled={readOnly} onChange={(e) => setV({ ...v, [s.code]: { ...v[s.code], name: e.target.value } })} /></td>
            <td><div className="tz">COLOMBO · LK</div><input type="time" value={v[s.code].start} disabled={readOnly} onChange={(e) => setV({ ...v, [s.code]: { ...v[s.code], start: e.target.value } })} /> – <input type="time" value={v[s.code].end} disabled={readOnly} onChange={(e) => setV({ ...v, [s.code]: { ...v[s.code], end: e.target.value } })} /></td>
            <td className="mut">{len(s.code)}{g(s.code).e <= g(s.code).s && <> <span className="b v">{L('跨午夜', 'Overnight')}</span></>}</td>
          </tr>
        ))}
      </tbody></table></div>
      <div className={`note ${ok ? 'ok' : 'w'}`}>{ok
        ? L('✅ A / B / C 班首尾相接，覆盖 24 小时，没有空档或重叠。', '✅ The three shifts join end-to-start and cover 24 hours with no gap or overlap.')
        : L(`⚠️ A / B / C 班没有完整首尾相接（合计 ${Math.floor(total / 60)}h${total % 60 ? ' ' + (total % 60) + 'm' : ''}）。可以保存，但请确认空档或重叠是有意的。`, `⚠️ The shifts do not join end-to-start (total ${Math.floor(total / 60)}h${total % 60 ? ' ' + (total % 60) + 'm' : ''}). You can still save, but check the gap or overlap is intended.`)}</div>
      <label style={{ display: 'block', margin: '8px 0', fontSize: 13 }}><input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} /> {L('同时更新明天及以后的班次实例（今天及以前的考勤不变）', 'Also update shift instances from tomorrow onwards (today and earlier stay unchanged)')}</label>
      {!readOnly && <button className="btn p" disabled={busy} onClick={save}>{L('保存班次时间', 'Save shift times')}</button>}
    </div>
  );
}

// ---------------------------------------------------------------- Currencies
function Currencies() {
  const { L } = useI18n();
  const { meta, reloadMeta, readOnly } = useData();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const onErr = useErr();
  const add = async () => {
    const c = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(c)) return setErr(L('代码需为 2–10 个英文字母或数字', 'Code must be 2–10 letters or digits'));
    if (meta.currencies.some((x) => x.code === c)) return setErr(L(`${c} 已存在`, `${c} already exists`));
    try { await api('/currencies', { method: 'POST', body: { code: c, name: name.trim() } }); setCode(''); setName(''); setErr(''); toast(L(`已新增 ${c}`, `Added ${c}`)); await reloadMeta(); }
    catch (e) { onErr(e); }
  };
  const del = async (c: string) => {
    if (!confirm(L(`删除货币 ${c}？它的 Bot 也会一起移除，Webhook 会停用。`, `Delete currency ${c}? Its bot will also be removed and its webhook stopped.`))) return;
    try { await api(`/currencies/${c}`, { method: 'DELETE' }); toast(L(`已删除 ${c}`, `Deleted ${c}`)); await reloadMeta(); }
    catch (e) { onErr(e); }
  };
  return (
    <div className="card"><h3>{L('货币列表', 'Currencies')}</h3>
      <div className="tw"><table><thead><tr><th>{L('代码', 'Code')}</th><th>{L('名称', 'Name')}</th><th className="n">{L('使用中的员工', 'Employees using it')}</th><th className="c">{L('操作', 'Action')}</th></tr></thead><tbody>
        {meta.currencies.length ? meta.currencies.map((c) => <tr key={c.code}><td><span className="b i">{c.code}</span></td><td>{c.name}</td><td className="n">{c.employees}</td><td className="c">{!readOnly && <button className="btn sm d" onClick={() => del(c.code)}>{L('删除', 'Delete')}</button>}</td></tr>)
          : <tr><td colSpan={4} className="mut">{L('还没有货币', 'No currencies yet')}</td></tr>}
      </tbody></table></div>
      {!readOnly && <div className="row" style={{ marginTop: 12 }}>
        <Field label={L('代码（如 SGD）', 'Code (e.g. SGD)')}><input type="text" maxLength={10} style={{ width: 140, textTransform: 'uppercase' }} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <Field label={L('名称（如 Singapore Dollar）', 'Name (e.g. Singapore Dollar)')}><input type="text" maxLength={60} style={{ minWidth: 240 }} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <button className="btn p" onClick={add}>+ {L('新增货币', 'Add currency')}</button>
      </div>}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Keywords
function Keywords() {
  const { L, dt } = useI18n();
  const { meta, reloadMeta, readOnly } = useData();
  const [kw, setKw] = useState(() => Object.fromEntries(EVENT_TYPES.map((k) => [k, meta.keywords[k].join('\n')])) as Record<string, string>);
  const [err, setErr] = useState('');
  const parsed = useMemo(() => Object.fromEntries(EVENT_TYPES.map((k) => [k, [...new Set(kw[k].split('\n').map((s) => s.trim()).filter(Boolean))]])) as unknown as KeywordConfig, [kw]);
  const [pr, setPr] = useState<ParserRules>(() => ({ ...DEFAULT_PARSER, ...meta.parser }));
  const [labels, setLabels] = useState(() => (meta.parser?.skipLabels ?? []).join('\n'));
  const rulesNow: ParserRules = useMemo(() => ({ ...pr, skipLabels: labels.split('\n').map((s) => s.trim()).filter(Boolean) }), [pr, labels]);
  const saveRules = async () => {
    try { await api('/settings/parser', { method: 'PUT', body: rulesNow }); setErr(''); toast(L('读取规则已保存', 'Reading rules saved')); await reloadMeta(); }
    catch (e) { setErr(dt((e as ApiErr).msg)); }
  };
  const sw = (k: 'typoTolerance' | 'ignoreBrackets' | 'typedTimeReview', zh: string, en: string, hint: string) => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 12, textAlign: 'left' }}>
      <input id={`pr-${k}`} type="checkbox" checked={pr[k]} disabled={readOnly} onChange={(e) => setPr({ ...pr, [k]: e.target.checked })} style={{ width: 16, height: 16, minWidth: 16, flex: 'none', marginTop: 2 }} />
      <div style={{ cursor: 'pointer' }} onClick={() => !readOnly && setPr({ ...pr, [k]: !pr[k] })}><b style={{ fontSize: 13.5 }}>{L(zh, en)}</b><div className="mut" style={{ fontSize: 12, marginTop: 2 }}>{hint}</div></div>
    </div>
  );
  const save = async () => {
    for (const k of EVENT_TYPES) if (!parsed[k].length) return setErr(L(`${k} 至少需要一个关键词`, `${k} needs at least one keyword`));
    try { await api('/settings/keywords', { method: 'PUT', body: { keywords: parsed } }); setErr(''); toast(L('关键词已保存', 'Keywords saved')); await reloadMeta(); }
    catch (e) { setErr(dt((e as ApiErr).msg)); }
  };
  return (
    <>
    <div className="card"><h3>{L('打卡关键词（每行一个，不区分大小写）', 'Punch keywords (one per line, case-insensitive)')}</h3>
      <div className="fg">{EVENT_TYPES.map((k) => <div key={k}><label>{k} · {dt(EVENT_LABEL[k])}</label><textarea rows={9} value={kw[k]} disabled={readOnly} onChange={(e) => setKw({ ...kw, [k]: e.target.value })} /></div>)}</div>
      {err && <div className="err">{err}</div>}
      {!readOnly && <div className="row" style={{ marginTop: 12 }}><button className="btn p" onClick={save}>{L('保存关键词', 'Save keywords')}</button></div>}
    </div>
    <div className="card"><h3>{L('消息读取规则', 'Message reading rules')}</h3>
      <div className="fg">
        <div><label>{L('跳过的资料行（每行一个标签）', 'Lines to skip (one label per line)')}</label>
          <textarea rows={8} value={labels} disabled={readOnly} placeholder={L('例如：\nAgent\nName\nCS Name\nDate', 'e.g.\nAgent\nName\nCS Name\nDate')} onChange={(e) => setLabels(e.target.value)} />
          <div className="mut" style={{ fontSize: 12, marginTop: 4 }}>{L('以这些字开头、后面接「:」的整行会被忽略，例如 Agent: Nisha、Date: 16/10/2026。', 'A whole line starting with one of these followed by ":" is ignored, e.g. "Agent: Nisha", "Date: 16/10/2026".')}</div>
        </div>
        <div>
          {sw('typoTolerance', '容许拼错', 'Typo tolerance', L('差一个字母或重复字母也算，例如 clok in、brek、innnn', 'One letter off or repeated letters count, e.g. clok in, brek, innnn'))}
          {sw('ignoreBrackets', '忽略括号内容', 'Ignore brackets', L('例如 Taking Break ( David) 只读 Taking Break', 'e.g. "Taking Break ( David)" is read as "Taking Break"'))}
          {sw('typedTimeReview', '有自己写的时间 → 待检查', 'Typed time → review', L('例如 IN 08:30 不直接打卡，交给管理员确认；关闭则照样打卡。打卡时间一律用 Telegram 消息时间', 'e.g. "IN 08:30" goes to review; when off it punches. The Telegram message time is always used'))}
        </div>
      </div>
      {!readOnly && <div className="row" style={{ marginTop: 12 }}><button className="btn p" onClick={saveRules}>{L('保存读取规则', 'Save reading rules')}</button></div>}
    </div>
    </>
  );
}

// ---------------------------------------------------------------- Rules
function Rules() {
  const { L } = useI18n();
  const { meta, reloadMeta, readOnly } = useData();
  const [v, setV] = useState({ win: String(meta.rules.windowHours), lx: meta.rules.lateAsException ? '1' : '0', bot: meta.rules.botReply ? '1' : '0' });
  const onErr = useErr();
  const save = async () => {
    try {
      await api('/settings/rules', { method: 'PUT', body: { windowHours: Math.min(8, Math.max(1, Number(v.win) || 1)), lateAsException: v.lx === '1', botReply: v.bot === '1' } });
      toast(L('设置已保存，计算已更新', 'Settings saved; results updated'));
      await reloadMeta();
    } catch (e) { onErr(e); }
  };
  return (
    <div className="card"><h3>{L('考勤与异常规则', 'Attendance & exception rules')}</h3>
      <div className="setlist">
        <div className="setrow"><label htmlFor="stWin">{L('班次匹配窗口（排班前后小时）', 'Shift matching window (hours before/after)')}</label><div className="setctl"><input id="stWin" type="number" min={1} max={8} value={v.win} disabled={readOnly} onChange={(e) => setV({ ...v, win: e.target.value })} /></div></div>
        <div className="setrow"><label htmlFor="stLx">{L('迟到/早退是否也列为异常', 'Also list late / early leave as exceptions')}</label><div className="setctl"><select id="stLx" value={v.lx} disabled={readOnly} onChange={(e) => setV({ ...v, lx: e.target.value })}><option value="0">{L('否，只显示状态', 'No, status only')}</option><option value="1">{L('是', 'Yes')}</option></select></div></div>
        <div className="setrow"><label htmlFor="stBot">{L('Bot 在 Topic 回复确认', 'Bot replies in the topic')}</label><div className="setctl"><select id="stBot" value={v.bot} disabled={readOnly} onChange={(e) => setV({ ...v, bot: e.target.value })}><option value="1">{L('开启', 'On')}</option><option value="0">{L('关闭', 'Off')}</option></select></div></div>
      </div>
      {!readOnly && <div className="setfoot"><button className="btn p" onClick={save}>{L('保存规则', 'Save rules')}</button></div>}
    </div>
  );
}

// ---------------------------------------------------------------- Bots (one per currency)
interface BotView { currency: string; botUserId: number | null; username: string | null; tokenLast4: string | null; tokenSource: 'secret' | 'stored' | null; webhookUrl: string | null; defaultUrl: string; status: 'NOT_SET' | 'ACTIVE' | 'DISABLED' | 'ERROR'; canReadAllGroupMessages: boolean | null; pendingUpdateCount: number | null; lastError: string | null; lastCheckedAt: number | null; employees: number }

function Bots() {
  const { L } = useI18n();
  const { readOnly } = useData();
  const { data, error, reload } = useApi<{ rows: BotView[] }>('/bots');
  const [edit, setEdit] = useState<BotView | null>(null);
  const onErr = useErr();
  const st = (s: string) => ({ NOT_SET: [L('未设置', 'Not set'), ''], ACTIVE: [L('运行中', 'Active'), 'ok'], ERROR: [L('错误', 'Error'), 'r'], DISABLED: [L('已停用', 'Stopped'), 'w'] } as Record<string, string[]>)[s] ?? ['—', ''];
  const act = async (b: BotView, a: 'check' | 'stop' | 'start') => {
    if (a === 'stop' && !confirm(L(`停用 ${b.currency}？${b.currency} 员工的打卡将不再被记录，其他货币不受影响。`, `Stop ${b.currency}? Punches of ${b.currency} employees will no longer be recorded; other currencies are not affected.`))) return;
    try {
      const r = await api<{ webhook?: string; url?: string }>(`/bots/${b.currency}/${a}`, { method: 'POST' });
      toast(a === 'check' ? L(`${b.currency} 状态已更新`, `${b.currency} status updated`) : a === 'stop' ? L(`${b.currency} 已停用`, `${b.currency} stopped`) : L(`${b.currency} 的 Webhook 已启动`, `Webhook started for ${b.currency}`));
      if (a === 'stop' && r.webhook === 'other') alert(L(`${b.currency} 已在 oc-attendance 停用。\n\n这个 Bot 目前连接在其他系统（${r.url}），所以没有删除它的 Webhook，那个系统不受影响。`, `${b.currency} is stopped in oc-attendance.\n\nThis bot is connected to another system (${r.url}), so its webhook was left untouched.`));
    } catch (e) { onErr(e); }
    await reload();
  };
  const clean = async (b: BotView) => {
    if (!confirm(L(`清除 ${b.currency} 的 Bot 资料？\n\n会删除：Bot Token、Bot 账号、Webhook，状态回到「未设置」。\n不会删除：员工、考勤记录、消息记录。\n\n之后可以按「设置」重新绑定新的 Bot。`,
      `Clean the ${b.currency} bot?\n\nRemoves: bot token, bot account and webhook; status returns to "Not set".\nKeeps: employees, attendance and messages.\n\nYou can set up a new bot afterwards.`))) return;
    try {
      type CleanRes = { secretTokenRemains: boolean; webhook: string; url?: string };
      let r: CleanRes;
      try { r = await api<CleanRes>(`/bots/${b.currency}/clean`, { method: 'POST', body: {} }); }
      catch (e) {
        if (!(e instanceof ApiErr) || e.code !== 'TELEGRAM_UNREACHABLE') throw e;
        if (!confirm(L(`${e.msg.zh}\n\n如果这个 Bot 的 Token 已经失效（例如已在 BotFather 更换），可以仍然清除。要仍然清除吗？`, `${e.msg.en}\n\nIf the token is no longer valid (e.g. revoked in BotFather) you can clean anyway. Clean anyway?`))) { await reload(); return; }
        r = await api<CleanRes>(`/bots/${b.currency}/clean`, { method: 'POST', body: { force: true } });
      }
      toast(L(`${b.currency} 的 Bot 资料已清除`, `${b.currency} bot cleaned`));
      if (r.webhook === 'other') alert(L(`${b.currency} 已在 oc-attendance 清除。\n\n这个 Bot 目前连接在其他系统（${r.url}），所以没有删除它的 Webhook，那个系统不受影响。`, `${b.currency} is cleaned in oc-attendance.\n\nThis bot is connected to another system (${r.url}), so its webhook was left untouched.`));
      if (r.secretTokenRemains) alert(L(`注意：Cloudflare 里还有 TELEGRAM_BOT_TOKEN_${b.currency} 这个 Secret，需要到 Cloudflare 删除。`, `Note: the Cloudflare secret TELEGRAM_BOT_TOKEN_${b.currency} still exists; delete it in Cloudflare.`));
    } catch (e) { onErr(e); }
    await reload();
  };
  return (
    <div className="card"><h3>{L('Bot 设置', 'Bot Setting')}</h3>
      <ErrBox error={error} />
      {data && (data.rows.length ? (
        <div className="tw"><table><thead><tr><th className="c">{L('货币', 'Currency')}</th><th>Bot</th><th>Webhook URL</th><th className="c">{L('状态', 'Status')}</th><th className="c">{L('员工数', 'Employees')}</th><th>{L('最后检查', 'Last checked')}</th><th className="c">{L('操作', 'Action')}</th></tr></thead><tbody>
          {data.rows.map((b) => {
            const [sl, sc] = st(b.status);
            const configured = b.status !== 'NOT_SET';
            return (
              <tr key={b.currency}>
                <td className="c"><span className="b i">{b.currency}</span></td>
                <td>{configured ? <><b>@{b.username}</b><div className="mut" style={{ fontSize: 11.5 }}>Token ••••{b.tokenLast4}{b.tokenSource === 'secret' ? ' · Cloudflare secret' : ''}</div></> : <Mut />}</td>
                <td style={{ fontSize: 12, maxWidth: 300, overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{configured ? b.webhookUrl : <span className="mut">{b.defaultUrl}</span>}{b.lastError && <div style={{ color: 'var(--bad)', fontSize: 11.5 }}>{b.lastError}</div>}</td>
                <td className="c"><span className={`b ${sc}`}>{sl}</span></td>
                <td className="c">{b.employees}</td>
                <td className="nw">{b.lastCheckedAt ? fmtDT(b.lastCheckedAt) : <Mut />}</td>
                <td className="nw">{!readOnly && <>
                  <button className={`btn sm ${configured ? '' : 'p'}`} onClick={() => setEdit(b)}>{configured ? L('编辑', 'Edit') : L('设置', 'Set up')}</button>{' '}
                  {configured && <button className="btn sm" onClick={() => act(b, 'check')}>{L('检查', 'Check')}</button>}{' '}
                  {b.status === 'ACTIVE' || b.status === 'ERROR' ? <button className="btn sm d" onClick={() => act(b, 'stop')}>{L('停用', 'Stop')}</button> : b.status === 'DISABLED' ? <button className="btn sm" onClick={() => act(b, 'start')}>{L('启用', 'Start')}</button> : null}{' '}
                  {configured && <button className="btn sm d" onClick={() => clean(b)}>{L('清除', 'Clean')}</button>}
                </>}</td>
              </tr>
            );
          })}
        </tbody></table></div>
      ) : <div className="empty">{L('请先在「货币」新增货币', 'Add a currency first')}</div>)}
      {edit && <BotModal b={edit} onClose={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function BotModal({ b, onClose }: { b: BotView; onClose: () => void }) {
  const { L } = useI18n();
  const [token, setToken] = useState('');
  const [show, setShow] = useState(false);
  const [url, setUrl] = useState(b.webhookUrl || b.defaultUrl);
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const configured = b.status !== 'NOT_SET';
  const yesno = (v: boolean | null) => (v == null ? '—' : v ? <span className="b ok">{L('是', 'Yes')}</span> : <span className="b r">{L('否', 'No')}</span>);
  const save = async () => {
    if (!token && !configured && b.tokenSource !== 'secret') return setErr(new Error(L('请输入 Bot Token', 'Please enter the bot token')));
    if (token && !/^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(token.trim())) return setErr(new Error(L('Token 格式不正确（应为 123456789:AA... ）', 'Invalid token format (expected 123456789:AA...)')));
    if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(url.trim())) return setErr(new Error(L('Webhook URL 必须是 https:// 开头的网址', 'Webhook URL must start with https://')));
    setBusy(true);
    try {
      const put = (force: boolean) => api<{ canReadAllGroupMessages: boolean }>(`/bots/${b.currency}`, { method: 'PUT', body: { token: token.trim(), webhookUrl: url.trim(), force } });
      let r: { canReadAllGroupMessages: boolean };
      try { r = await put(false); }
      catch (e) {
        if (!(e instanceof ApiErr) || e.code !== 'BOT_IN_USE') throw e;
        // the bot already belongs to another system (e.g. the CS reply tool): only continue on explicit confirmation
        if (!confirm(L(`⚠️ ${e.msg.zh}\n\n通常这表示填错了 Token：考勤系统应使用自己专用的 Bot。\n\n确定要把这个 Bot 改连到 oc-attendance 吗？`, `⚠️ ${e.msg.en}\n\nThis usually means the wrong token: the attendance system should use its own bot.\n\nMove this bot to oc-attendance anyway?`))) { setBusy(false); return; }
        r = await put(true);
      }
      setToken('');
      toast(L(`${b.currency} 的 Bot 已设置`, `${b.currency} bot is set up`));
      if (!r.canReadAllGroupMessages) alert(L('提醒：这个 Bot 的 Privacy Mode 仍是开启状态，读不到群组里的普通文字。请到 @BotFather → /setprivacy → Disable，然后把 Bot 移出群组再重新加入。', 'Note: this bot still has Privacy Mode on and cannot read plain group messages. In @BotFather run /setprivacy → Disable, then remove the bot from the group and add it again.'));
      onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  const rotate = async () => {
    if (!confirm(L(`重新生成 ${b.currency} 的 Secret Token 并重新设置 Webhook？`, `Regenerate the ${b.currency} secret token and re-register its webhook?`))) return;
    try { await api(`/bots/${b.currency}/rotate`, { method: 'POST' }); toast(L('Secret Token 已更换', 'Secret token rotated')); }
    catch (e) { setErr(e as ApiErr); }
  };
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{L('Bot 设置', 'Bot Setting')} · <span className="b i">{b.currency}</span></h3>
      <div className="fg">
        <div style={{ gridColumn: '1/-1' }}><label>Bot Token</label><div style={{ display: 'flex', gap: 6 }}>
          <input type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} style={{ flex: 1, minWidth: 0, fontFamily: 'ui-monospace,Menlo,Consolas,monospace' }} value={token} onChange={(e) => setToken(e.target.value)}
            placeholder={b.tokenSource === 'secret' ? L('使用 Cloudflare Secret 中的 Token', 'Using the token from a Cloudflare secret') : configured ? L(`已保存 ••••${b.tokenLast4}（输入新 Token 以更换）`, `Saved ••••${b.tokenLast4} (enter a new token to replace)`) : '123456789:AA...'} />
          <button className="btn" type="button" onClick={() => setShow(!show)}>{show ? L('隐藏', 'Hide') : L('显示', 'Show')}</button>
        </div></div>
        <div style={{ gridColumn: '1/-1' }}><label>Webhook URL</label><input type="text" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
      </div>
      {configured && (
        <div className="kv" style={{ marginTop: 12 }}>
          <div><span>Bot</span><b>@{b.username}</b><br /><small className="mut">ID {b.botUserId}</small></div>
          <div><span>{L('可读取群消息', 'Can read group messages')}</span>{yesno(b.canReadAllGroupMessages)}</div>
          <div><span>Secret Token</span><b>••••</b> <button className="btn sm" onClick={rotate}>{L('重新生成', 'Regenerate')}</button></div>
          <div><span>{L('待处理更新', 'Pending updates')}</span><b>{b.pendingUpdateCount ?? '—'}</b></div>
          <div><span>{L('最后错误', 'Last error')}</span><b style={{ fontSize: 12 }}>{b.lastError || '—'}</b></div>
        </div>
      )}
      <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={save} busy={busy} okLabel={L('保存并启动 Webhook', 'Save & start webhook')} />
    </Modal>
  );
}

// ---------------------------------------------------------------- Admin accounts (D1 table admin_users)
interface AdminRow { id: number; username: string; role: 'admin' | 'viewer'; is_active: number; last_login_at: number | null; locked_until: number | null; created_at: number }

function Admins() {
  const { L } = useI18n();
  const { readOnly } = useData();
  const { data, error, reload } = useApi<{ rows: AdminRow[]; me: number }>('/admins');
  const [edit, setEdit] = useState<AdminRow | 'new' | null>(null);
  return (
    <div className="card"><h3>{L('管理员账号', 'Admin accounts')}</h3>
      <ErrBox error={error} />
      {data && (
        <div className="tw"><table className="tpltbl"><thead><tr>
          <th>{L('账号', 'Username')}</th><th>{L('权限', 'Role')}</th><th>{L('状态', 'Status')}</th><th>{L('最后登录', 'Last sign-in')}</th><th>{L('建立日期', 'Created')}</th><th className="c">{L('操作', 'Action')}</th>
        </tr></thead><tbody>
          {data.rows.map((a) => (
            <tr key={a.id}>
              <td><b>{a.username}</b>{a.id === data.me && <> <span className="b i">{L('你', 'you')}</span></>}</td>
              <td>{a.role === 'admin' ? <span className="b v">{L('管理员', 'Admin')}</span> : <span className="b">{L('只读', 'Read-only')}</span>}</td>
              <td>{!a.is_active ? <span className="b">{L('已停用', 'Disabled')}</span> : a.locked_until && a.locked_until > Date.now() ? <span className="b r">{L('暂时锁定', 'Locked')}</span> : <span className="b ok">{L('启用', 'Active')}</span>}</td>
              <td>{a.last_login_at ? fmtDT(a.last_login_at) : <Mut />}</td><td>{fmtDT(a.created_at).slice(0, 10)}</td>
              <td>{!readOnly && <button className="btn sm" onClick={() => setEdit(a)}>{L('编辑', 'Edit')}</button>}</td>
            </tr>
          ))}
        </tbody></table></div>
      )}
      {!readOnly && <button className="btn p" style={{ marginTop: 10 }} onClick={() => setEdit('new')}>+ {L('新增账号', 'Add account')}</button>}
      {edit && <AdminModal a={edit === 'new' ? null : edit} isMe={edit !== 'new' && edit.id === data?.me} onClose={() => { setEdit(null); void reload(); }} />}
    </div>
  );
}

function AdminModal({ a, isMe, onClose }: { a: AdminRow | null; isMe: boolean; onClose: () => void }) {
  const { L } = useI18n();
  const [username, setUsername] = useState(a?.username ?? '');
  const [role, setRole] = useState<'admin' | 'viewer'>(a?.role ?? 'admin');
  const [active, setActive] = useState(a ? !!a.is_active : true);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!a && !/^[A-Za-z0-9_.@-]{3,64}$/.test(username.trim())) return setErr(new Error(L('账号需为 3–64 个英文字母、数字或 _ . @ -', 'Username: 3–64 letters, digits or _ . @ -')));
    if ((!a || pw) && pw.length < 10) return setErr(new Error(L('密码至少 10 个字符', 'Password needs at least 10 characters')));
    if (pw !== pw2) return setErr(new Error(L('两次输入的密码不同', 'The passwords do not match')));
    setBusy(true);
    try {
      if (a) await api(`/admins/${a.id}`, { method: 'PUT', body: { role, isActive: active, password: pw } });
      else await api('/admins', { method: 'POST', body: { username: username.trim(), password: pw, role } });
      toast(L('账号已保存，并写入 Audit Log', 'Account saved and written to the audit log'));
      onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{a ? L('编辑账号 ', 'Edit account ') + a.username : L('新增账号', 'Add account')}</h3>
      <div className="fg">
        <div><label>{L('账号', 'Username')}</label><input type="text" value={username} disabled={!!a} autoComplete="off" onChange={(e) => setUsername(e.target.value)} /></div>
        <div><label>{L('权限', 'Role')}</label><select value={role} disabled={isMe} onChange={(e) => setRole(e.target.value as 'admin' | 'viewer')}><option value="admin">{L('管理员（可修改）', 'Admin (can edit)')}</option><option value="viewer">{L('只读（只能查看）', 'Read-only (view only)')}</option></select></div>
        {a && <div><label>{L('状态', 'Status')}</label><select value={active ? '1' : '0'} disabled={isMe} onChange={(e) => setActive(e.target.value === '1')}><option value="1">{L('启用', 'Active')}</option><option value="0">{L('停用', 'Disabled')}</option></select></div>}
        <div><label>{a ? L('新密码（留空 = 不更改）', 'New password (empty = unchanged)') : L('密码（至少 10 个字符）', 'Password (min. 10 characters)')}</label><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        <div><label>{L('再次输入密码', 'Repeat password')}</label><input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
      </div>
      <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={save} busy={busy} />
    </Modal>
  );
}
