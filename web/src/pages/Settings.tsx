import { type ReactNode, useMemo, useState } from 'react';
import { type BotSwitches, type BotTexts, DEFAULT_BOT_SWITCHES, DEFAULT_BOT_TEXTS, DEFAULT_PARSER, EVENT_LABEL, EVENT_TYPES, type KeywordConfig, type ParserRules, ROSTER_COLORS } from '../../../src/shared/codes';
import { toMin } from '../../../src/shared/time';
import { capOf, cleanPerms, type SettingLevel, type SettingPerms, type SettingTab } from '../../../src/shared/perms';
import { BotDemo, type DemoKey } from '../components/BotDemo';
import { CurSeg, Empty, ErrBox, Field, Modal, ModalActions, Mut, Tabs } from '../components/ui';
import { api, ApiErr } from '../lib/api';
import { fmtDT } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { DataCtx, type MetaRules, rulesOf, settingAccess, toast, useApi, useData, usePageState } from '../lib/store';

type Tab = 'shift3' | 'cur' | 'kw' | 'rules' | 'msgs' | 'codes' | 'bot' | 'admins';

export function SettingsPage() {
  const { L } = useI18n();
  const data = useData();
  const { owner, meta } = data;
  const [s, set] = usePageState('st', () => ({ tab: 'shift3' as Tab }));
  const all: [Tab, string][] = [['shift3', L('班次设置', 'Shift Setting')], ['cur', L('货币', 'Currency')], ['kw', L('打卡关键词', 'Punch keywords')], ['rules', L('考勤与异常规则', 'Attendance rules')], ['msgs', L('Bot 消息', 'Bot messages')], ['codes', L('排班代号', 'Roster codes')], ['bot', L('Bot 设置', 'Bot Setting')], ['admins', L('管理员账号', 'Admin accounts')]];
  // the owner sees every tab; other accounts see the tabs the owner turned on (Admin accounts -> Edit); Admin accounts is the owner's
  const access = (k: Tab) => settingAccess(meta, k);
  const tabs = all.filter(([k]) => access(k));
  if (!tabs.length) return <Empty>{L('你没有任何设置页的权限，请联系 Owner', 'You have no access to Settings. Ask the owner.')}</Empty>;
  const tab: Tab = tabs.some(([k]) => k === s.tab) ? s.tab : tabs[0][0];
  const viewOnly = access(tab) === 'v';
  return (
    // view only: the tab is shown with every field and button disabled (Preview still plays)
    <DataCtx.Provider value={viewOnly ? { ...data, readOnly: true } : data}>
      <Tabs items={tabs.map(([k, l]) => [k, access(k) === 'v' ? `${l} 👁` : l] as [Tab, string])} value={tab} onChange={(t) => set({ tab: t })} />
      {viewOnly && <div className="viewonly">👁 {L('你只能查看这一页：可以看设定（Bot 消息可以按「▶ 预览」），但不能修改或保存。要修改请联系 Owner。', 'View only: you can see this page (and play ▶ Preview on Bot messages) but cannot change or save anything. Ask the owner to change it.')}</div>}
      {tab === 'shift3' && <Shift3 />}
      {tab === 'cur' && <Currencies />}
      {tab === 'kw' && <Keywords />}
      {tab === 'rules' && <Rules />}
      {tab === 'msgs' && <BotMessages />}
      {tab === 'codes' && <RosterCodes />}
      {tab === 'bot' && <Bots />}
      {tab === 'admins' && <Admins />}
    </DataCtx.Provider>
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
            <td className="mut">{len(s.code)}</td>
          </tr>
        ))}
      </tbody></table></div>
      <label style={{ display: 'block', margin: '12px 0 8px', fontSize: 13 }}><input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} /> {L('同时更新明天及以后的班次实例（今天及以前的考勤不变）', 'Also update shift instances from tomorrow onwards (today and earlier stay unchanged)')}</label>
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
          {sw('typedTimeReview', '有自己写的时间 → 待检查', 'Typed time → review', L('开启：例如 IN 08:30 不打卡，交给管理员确认。关闭：照样打卡，时间用 Telegram 消息时间，员工写的时间列在「异常 → 员工自填时间」供你跟进。', 'On: e.g. "IN 08:30" is not counted and goes to review. Off: it is counted at the Telegram message time and the typed time is listed under Exceptions → Typed time for follow-up.'))}
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
  const { meta } = useData();
  const [st, setSt] = usePageState('st-rules', () => ({ cur: meta.currencies[0]?.code ?? '' }));
  const cur = meta.currencies.some((c) => c.code === st.cur) ? st.cur : meta.currencies[0]?.code ?? '';
  const hm = (m: number) => (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);
  const fmtMin = (m: number | null | undefined, u?: 'h' | 'm') => (m == null ? L('不限', 'No limit') : u === 'h' ? hm(m) : `${m} min`);
  const rows: [string, (r: MetaRules) => string][] = [
    [L('每日休息时间', 'Break time per day'), (r) => fmtMin(r.breakMinutes === undefined ? 90 : r.breakMinutes, r.breakUnit)],
    [L('迟到/早退列为异常', 'Late / early leave as exceptions'), (r) => (r.lateAsException ? L('是', 'Yes') : L('否', 'No'))],
    [L('Bot 回复', 'Bot replies'), (r) => (r.botReply ? L('开启', 'On') : L('关闭', 'Off'))],
    [L('提早上班问 OT', 'Ask OT on early clock in'), (r) => ((r.earlyAskMin ?? 30) > 0 ? `${r.earlyAskMin ?? 30} min` : L('关闭', 'Off'))],
    [L('超时未下班问 OT', 'Ask OT with no clock out'), (r) => { const m = r.outAskMin ?? 45; const t = r.outAskUnit === 'h' ? hm(m) : `${m} min`; return L(`下班后 ${t}`, `${t} after shift end`); }],
    [L('不检查工时的代号', 'Codes not checked for hours'), (r) => (r.noHoursCodes ?? ['OT', 'ST']).join(', ') || '—'],
    [L('谁可以按按钮', 'Who may answer'), (r) => (r.answerBy === 'own' ? L('只有员工本人', 'Only the employee') : L('群里任何人', 'Anyone in the group'))],
  ];
  if (!cur) return <div className="card empty">{L('请先在「货币」新增货币', 'Add a currency first (Currency tab)')}</div>;
  return (
    <>
      <div className="card"><h3>{L('考勤与异常规则', 'Attendance & exception rules')}</h3>
        <div style={{ marginBottom: 12 }}><CurSeg value={cur} onChange={(c) => setSt({ cur: c })} /></div>
        <div className="rnote">{L(`只套用在 ${cur} 员工；每个货币各自设定。`, `Rules for ${cur} employees only. Each currency is set on its own.`)}</div>
        <RulesForm key={cur + JSON.stringify(rulesOf(meta, cur))} cur={cur} />
      </div>
      {meta.currencies.length > 1 && (
        <div className="cmp tw"><table><thead><tr><th>{L('规则', 'Rule')}</th>{meta.currencies.map((c) => <th key={c.code}>{c.code}</th>)}</tr></thead><tbody>
          {rows.map(([label, f]) => {
            const vals = meta.currencies.map((c) => f(rulesOf(meta, c.code)));
            const diff = new Set(vals).size > 1;
            return <tr key={label}><td>{label}</td>{vals.map((x, i) => <td key={i} className={diff ? 'cx' : ''}>{x}</td>)}</tr>;
          })}
        </tbody></table></div>
      )}
    </>
  );
}

function RulesForm({ cur }: { cur: string }) {
  const { L } = useI18n();
  const { meta, reloadMeta, readOnly } = useData();
  const r0 = rulesOf(meta, cur);
  const brMin0 = r0.breakMinutes === undefined ? 90 : r0.breakMinutes;
  const brUnit0: 'h' | 'm' = r0.breakUnit ?? 'm';
  const oaUnit0: 'h' | 'm' = r0.outAskUnit ?? 'm';
  const [v, setV] = useState({ bunit: brUnit0, br: brMin0 == null ? '' : String(brUnit0 === 'h' ? Math.round((brMin0 / 60) * 100) / 100 : brMin0), lx: r0.lateAsException ? '1' : '0', bot: r0.botReply ? '1' : '0', ea: String(r0.earlyAskMin ?? 30), ab: r0.answerBy ?? 'any', nh: (r0.noHoursCodes ?? ['OT', 'ST']).join(', '), ounit: oaUnit0, oa: String(oaUnit0 === 'h' ? Math.round(((r0.outAskMin ?? 45) / 60) * 100) / 100 : r0.outAskMin ?? 45) });
  const [err, setErr] = useState('');
  const onErr = useErr();
  const brMin = () => (v.br.trim() === '' ? null : Math.min(1440, Math.max(0, Math.round((Number(v.br) || 0) * (v.bunit === 'h' ? 60 : 1)))));
  const conv = (val: string, u: 'h' | 'm') => { if (val.trim() === '') return ''; const n = Number(val) || 0; return String(u === 'm' ? Math.round(n * 60) : Math.round((n / 60) * 100) / 100); };
  const save = async () => {
    // hours or minutes; stored as whole minutes 0–480 (8 h). Never changed silently: a bad value is refused.
    const n = Number(v.oa);
    const oaRaw = v.ounit === 'h' ? n * 60 : n;
    const oa = Math.round(oaRaw);
    if (v.oa.trim() === '' || !Number.isFinite(n) || Math.abs(oaRaw - oa) > 1e-6 || oa < 0 || oa > 480)
      return setErr(v.ounit === 'h'
        ? L('「超时未下班问 OT」请填 0–8 小时（可用小数，例如 0.75 = 45 分钟）', '"Ask OT with no clock out": 0–8 hours (decimals allowed, e.g. 0.75 = 45 min)')
        : L('「超时未下班问 OT」请填 0–480 的整数分钟', '"Ask OT with no clock out": a whole number of minutes from 0 to 480'));
    const nhList = [...new Set(v.nh.split(/[\s,，、]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
    if (nhList.some((x) => !/^[A-Z0-9]{1,6}$/.test(x))) return setErr(L('「不检查工时的代号」只能填 1–6 个英文字母或数字，用逗号分开', '"Codes not checked": 1–6 letters or digits each, separated by commas'));
    setErr('');
    try {
      await api('/settings/rules', { method: 'PUT', body: { currency: cur, breakMinutes: brMin(), breakUnit: v.bunit, lateAsException: v.lx === '1', botReply: v.bot === '1', outAskMin: oa, outAskUnit: v.ounit, earlyAskMin: Math.min(240, Math.max(0, Math.round(Number(v.ea) || 0))), answerBy: v.ab, noHoursCodes: nhList } });
      toast(L(`${cur} 规则已保存，${cur} 员工的考勤会重新计算`, `${cur} rules saved; ${cur} attendance is being recalculated`));
      await reloadMeta();
    } catch (e) { onErr(e); }
  };
  return (
    <>
      <div className="setlist">
        <div className="setrow"><label htmlFor="stBr">{L('每日休息时间（总计；留空 = 不限）', 'Break time per day (total; empty = no limit)')}</label><div className="setctl unitctl"><input id="stBr" type="number" min={0} step={v.bunit === 'm' ? 5 : 0.25} placeholder={L('不限', 'No limit')} value={v.br} disabled={readOnly} onChange={(e) => setV({ ...v, br: e.target.value })} /><select aria-label={L('单位', 'Unit')} value={v.bunit} disabled={readOnly} onChange={(e) => { const u = e.target.value as 'h' | 'm'; setV({ ...v, bunit: u, br: conv(v.br, u) }); }}><option value="h">{L('小时', 'Hours')}</option><option value="m">{L('分钟', 'Minutes')}</option></select></div></div>
        <div className="setrow"><label htmlFor="stLx">{L('迟到/早退是否也列为异常', 'Also list late / early leave as exceptions')}</label><div className="setctl"><select id="stLx" value={v.lx} disabled={readOnly} onChange={(e) => setV({ ...v, lx: e.target.value })}><option value="0">{L('否，只显示状态', 'No, status only')}</option><option value="1">{L('是', 'Yes')}</option></select></div></div>
        <div className="setrow"><label htmlFor="stBot">{L('Bot 在 Topic 回复确认', 'Bot replies in the topic')}</label><div className="setctl"><select id="stBot" value={v.bot} disabled={readOnly} onChange={(e) => setV({ ...v, bot: e.target.value })}><option value="1">{L('开启', 'On')}</option><option value="0">{L('关闭', 'Off')}</option></select></div></div>
        <div className="setrow"><label htmlFor="stOa">{L('超时未下班问 OT：排班下班后超过多久还没打下班卡，bot 问是不是 OT（例：16:30 下班 + 45 分钟 → 17:15 问）', 'Ask OT with no clock out: time after the scheduled shift end (e.g. ends 16:30 + 45 min → asked at 17:15)')}</label><div className="setctl unitctl"><input id="stOa" type="number" min={0} max={v.ounit === 'm' ? 480 : 8} step={v.ounit === 'm' ? 5 : 0.25} value={v.oa} disabled={readOnly} onChange={(e) => setV({ ...v, oa: e.target.value })} /><select aria-label={L('单位', 'Unit')} value={v.ounit} disabled={readOnly} onChange={(e) => { const u = e.target.value as 'h' | 'm'; setV({ ...v, ounit: u, oa: conv(v.oa, u) || v.oa }); }}><option value="h">{L('小时', 'Hours')}</option><option value="m">{L('分钟', 'Minutes')}</option></select></div></div>
        <div className="setrow"><label htmlFor="stEa">{L('提早上班问 OT：比排班早多少分钟以上打卡，bot 问是不是 OT（0 = 不问）', 'Ask OT on early clock in: minutes before the shift (0 = do not ask)')}</label><div className="setctl"><input id="stEa" type="number" min={0} max={240} step={5} value={v.ea} disabled={readOnly} onChange={(e) => setV({ ...v, ea: e.target.value })} /></div></div>
        <div className="setrow"><label htmlFor="stNh">{L('不检查工时的代号（排班代号或班次代号，逗号分开）：这些日子不提醒工时不足（例 OT, ST）；手动标 OT 的日子也不检查', 'Codes not checked for working hours (roster or shift codes, comma separated): no incomplete-hours check on these days (e.g. OT, ST); days marked OT by hand are not checked either')}</label><div className="setctl"><input id="stNh" type="text" value={v.nh} placeholder="OT, ST" disabled={readOnly} onChange={(e) => setV({ ...v, nh: e.target.value })} /></div></div>
        <div className="setrow"><label htmlFor="stAb">{L('谁可以按 bot 的按钮', 'Who may answer the bot buttons')}</label><div className="setctl"><select id="stAb" value={v.ab} disabled={readOnly} onChange={(e) => setV({ ...v, ab: e.target.value as 'any' | 'own' })}><option value="any">{L('群里任何人', 'Anyone in the group')}</option><option value="own">{L('只有员工本人', 'Only the employee')}</option></select></div></div>
      </div>
      {err && <div className="err">{err}</div>}
      {!readOnly && <div className="setfoot"><button className="btn p" onClick={save}>{L(`保存 ${cur} 规则`, `Save ${cur} rules`)}</button></div>}
    </>
  );
}

// ---------------------------------------------------------------- Bot messages (the OT questions and their buttons)
type MsgKey = 'early' | 'late' | 'incomplete' | 'scheduled' | 'common';
type L2 = (zh: string, en: string) => string;
/** One chat line of the live preview. */
interface PvLine { who: 'me' | 'bot' | 'gap' | 'off' | 'pop'; text: string; tm?: string; kb?: string[]; answered?: string; quote?: boolean; scheduled?: boolean }
interface MsgDef {
  key: MsgKey; title: (L: L2) => string; sw?: keyof BotSwitches; demo?: DemoKey;
  when: (L: L2) => string; fieldsHelp: string;
  q?: keyof BotTexts; qLabel?: (L: L2) => string;
  buttons: { b: keyof BotTexts; r: keyof BotTexts; does: (L: L2) => string }[];
  extra?: { k: keyof BotTexts; label: (L: L2, t: BotTexts) => string; short?: boolean }[];
  /** sample values filled into the texts (never a real employee) */
  sample: Record<string, string>;
  preview: (t: BotTexts, path: number, on: boolean, L: L2, fill: (s: string) => string) => PvLine[];
}

const CS = 'CS - 1';
const okLine = (what: string, tm: string): PvLine => ({ who: 'bot', text: `✅ ${what} recorded · ${tm} (Sri Lanka time)`, tm });
/** question + its buttons; path 0 = not answered yet, n = button n pressed */
function asked(q: string, labels: string[], replies: string[], path: number, tm: string, tm2: string, change: string): PvLine[] {
  if (!path) return [{ who: 'bot', text: q, tm, kb: labels }];
  return [{ who: 'bot', text: q, tm, answered: `✓ ${labels[path - 1]} · ${CS} · ${tm2}`, kb: [change] }, { who: 'bot', text: replies[path - 1], tm: tm2, quote: true }];
}
const offLine = (L: L2): PvLine => ({ who: 'off', text: L('已关闭 — Bot 不发送这条消息（检测和异常照常）', 'Off — the bot does not send this message (detection and exceptions still work)') });

const MSGS: MsgDef[] = [
  { key: 'early', title: (L) => L('提早上班', 'Early clock in'), sw: 'early', demo: 'early',
    when: (L) => L('员工比排班早打上班卡（达到考勤规则的分钟数）时，马上发出。Yes = 从上班到排班开始算 OT。', 'Sent right after a clock in that is early enough (Attendance rules). Yes = OT from the clock in to the shift start.'),
    fieldsHelp: '{name} {shift} {in}', q: 'earlyQ',
    buttons: [{ b: 'earlyYes', r: 'earlyRYes', does: (L) => L('计 OT', 'OT counted') }, { b: 'earlyNo', r: 'earlyRNo', does: (L) => L('不计 OT', 'No OT') }],
    sample: { name: CS, shift: '14:30–23:30', in: '13:52' },
    preview: (t, p, on, L, f) => [{ who: 'me', text: 'IN', tm: '13:52' }, okLine('Clock In', '13:52'),
      ...(on ? asked(f(t.earlyQ), [t.earlyYes, t.earlyNo], [f(t.earlyRYes), f(t.earlyRNo)], p, '13:53', '13:54', t.change) : [offLine(L)])] },
  { key: 'late', title: (L) => L('超时未下班', 'No clock out'), sw: 'late', demo: 'late',
    when: (L) => L('排班下班后超过设定时间（考勤规则）还没打下班卡时发出。', 'Sent the set time after the shift end (Attendance rules) when there is no clock out yet.'),
    fieldsHelp: '{name} {shift} {in} {hours} {out}', q: 'lateQ',
    buttons: [{ b: 'lateStill', r: 'lateRStill', does: (L) => L('不计 OT', 'No OT') }, { b: 'lateOt', r: 'lateROt', does: (L) => L('计 OT 到下班', 'OT until clock out') },
      { b: 'lateForgot', r: 'lateRForgot', does: (L) => L('下班 = 排班下班，记异常', 'Clock out = shift end, exception') }],
    sample: { name: CS, shift: '14:30–23:30', in: '14:28', hours: '9h 45m', out: '23:30' },
    preview: (t, p, on, L, f) => [{ who: 'me', text: 'IN', tm: '14:28' }, okLine('Clock In', '14:28'), { who: 'gap', text: '00:13' },
      ...(on ? asked(f(t.lateQ), [t.lateStill, t.lateOt, t.lateForgot], [f(t.lateRStill), f(t.lateROt), f(t.lateRForgot)], p, '00:13', '00:16', t.change) : [offLine(L)])] },
  { key: 'incomplete', title: (L) => L('工时不足', 'Incomplete working hours'), sw: 'incomplete', demo: 'incomplete',
    when: (L) => L('打 OUT 时没上满排班时长（含休息；迟到从上班起算），和下班确认一起发出，并记「工时不足」。OT / ST 等「不检查工时的代号」的日子不发。',
      'Sent with the clock-out confirmation when the shift length (breaks included; late → from the clock in) was not completed, and "Incomplete working hours" is listed. Not on days with a code not checked (OT, ST …).'),
    fieldsHelp: '{name} {shift} {in} {out} {worked} {need} {until} {short}', q: 'incomplete', qLabel: (L) => L('问题（跟在下班确认后面）', 'Question (after the clock-out confirmation)'),
    buttons: [{ b: 'incYes', r: 'incRYes', does: (L) => L('下班卡保留', 'Clock out stands') }, { b: 'incNo', r: 'incRNo', does: (L) => L('取消下班，继续上班', 'Clock out cancelled, still working') },
      { b: 'incForgot', r: 'incRForgot', does: (L) => L('记「忘记上班打卡」待审批', '"Forgot clock in" for approval') }],
    extra: [{ k: 'incClockedAgain', label: (L, t) => L(`已再次打 OUT 后想改掉「${t.incNo}」时的提示`, `Pop-up when "${t.incNo}" is changed after clocking out again`) }],
    sample: { name: CS, shift: '14:30–23:30', in: '14:50', out: '23:30', worked: '8h 40m', need: '9h', until: '23:50', short: '20m' },
    preview: (t, p, on, L, f) => {
      const ok = '✅ Clock Out recorded · 23:30 (Sri Lanka time)';
      const head: PvLine[] = [{ who: 'me', text: 'IN', tm: '14:50' }, okLine('Clock In', '14:50'), { who: 'gap', text: '23:30' }, { who: 'me', text: 'OUT', tm: '23:30' }];
      if (!on) return [...head, { who: 'bot', text: ok, tm: '23:30' }, offLine(L)];
      return [...head, ...asked(`${ok}\n\n${f(t.incomplete)}`, [t.incYes, t.incNo, t.incForgot], [f(t.incRYes), f(t.incRNo), f(t.incRForgot)], p, '23:30', '23:31', t.change)];
    } },
  { key: 'scheduled', title: (L) => L('定时发送的打卡', 'Scheduled punch'), sw: 'scheduled', demo: 'scheduled',
    when: (L) => L('员工用 Telegram「定时发送」打卡时回复。这笔打卡不计入，并记「定时发送的打卡」；关闭只是不回复。', 'Reply to a punch sent with Telegram\'s "Schedule message". The punch is not counted and "Scheduled message" is listed; off only stops the reply.'),
    fieldsHelp: '', buttons: [], extra: [{ k: 'scheduled', label: (L) => L('Bot 回复', 'Bot reply') }],
    sample: {},
    preview: (t, _p, on, L) => [{ who: 'me', text: 'IN', tm: '14:30', scheduled: true }, on ? { who: 'bot', text: t.scheduled, tm: '14:30' } : offLine(L)] },
  { key: 'common', title: (L) => L('共用文字', 'Common texts'),
    when: (L) => L('所有带按钮的问题都会用到。', 'Used under every question with buttons.'),
    fieldsHelp: '', buttons: [],
    extra: [{ k: 'change', label: (L) => L('「更改答案」按钮', '"Change answer" button'), short: true }, { k: 'notYou', label: (L) => L('别人按时跳出的提示（只有员工本人可以回答时）', 'Pop-up when someone else presses (only the employee may answer)') }],
    sample: { name: CS, shift: '14:30–23:30', in: '13:52' },
    preview: (t, _p, _on, L, f) => [{ who: 'bot', text: f(t.earlyQ), tm: '13:53', answered: `✓ ${t.earlyYes} · ${CS} · 13:54`, kb: [t.change] },
      { who: 'pop', text: t.notYou }, { who: 'off', text: L('↑ 只有员工本人可以回答时，别人按下按钮会看到这个提示', '↑ shown to someone else who presses, when only the employee may answer') }] },
];

/** The live preview: the chat as the employee would see it, with the texts as they are in the form now. */
function LivePreview({ def, t, on, path, setPath, L }: { def: MsgDef; t: BotTexts; on: boolean; path: number; setPath: (n: number) => void; L: L2 }) {
  const fill = (s: string) => s.replace(/\{(name|shift|in|hours|out|worked|need|until|short)\}/g, (m, k: string) => def.sample[k] ?? m);
  const lines = def.preview(t, path, on, L, fill);
  const labels = def.buttons.map((x) => t[x.b]);
  return (
    <aside className="bm2-pv" aria-label={L('实时预览', 'Live preview')}>
      <div className="bm2-pvh"><b>{L('实时预览', 'Live preview')}</b><span>{L('随输入更新 · 不会发送', 'updates as you type · nothing is sent')}</span></div>
      {labels.length > 0 && on && (
        <div className="bm2-paths" role="group" aria-label={L('演示哪一种', 'Show')}>
          <button type="button" className={path === 0 ? 'on' : ''} aria-pressed={path === 0} onClick={() => setPath(0)}>{L('未回答', 'Not answered')}</button>
          {labels.map((b, i) => <button key={i} type="button" className={path === i + 1 ? 'on' : ''} aria-pressed={path === i + 1} onClick={() => setPath(i + 1)}>{b || '—'}</button>)}
        </div>
      )}
      <div className="bm2-chat">
        <div className="bm2-top">{CS} <span>Topic{def.sample.shift ? ` · ${L('班次', 'Shift')} ${def.sample.shift}` : ''}</span></div>
        {lines.map((x, i) => x.who === 'gap' ? <div key={i} className="bm2-gap"><span>· · · {x.text}</span></div>
          : x.who === 'off' ? <div key={i} className="bm2-off">{x.text}</div>
          : x.who === 'pop' ? <div key={i} className="bm2-pop">{x.text}</div>
          : (
            <div key={i} className={`bm2-grp ${x.who}`}>
              <div className={`bm2-b ${x.who}`}>
                <div className="n">{x.who === 'me' ? CS : 'Attendance Bot'}</div>
                {x.quote && <div className="q">{(lines.find((y) => y.kb)?.text ?? '').split('\n')[0]}</div>}
                <div className="tx">{x.text}{x.answered ? `\n\n${x.answered}` : ''}</div>
                <div className="tm">{x.scheduled ? `🕓 ${L('定时发送', 'scheduled')} · ` : ''}{x.tm}{x.who === 'me' ? ' ✓✓' : ''}</div>
              </div>
              {x.kb && <div className="bm2-kb" style={{ gridTemplateColumns: `repeat(${x.kb.length}, minmax(0, 1fr))` }}>{x.kb.map((k, j) => <span key={j}>{k || '—'}</span>)}</div>}
            </div>
          ))}
      </div>
    </aside>
  );
}

function BotMessages() {
  const { L } = useI18n();
  const { meta, readOnly, reloadMeta } = useData();
  const [v, setV] = useState<BotTexts>({ ...DEFAULT_BOT_TEXTS, ...(meta.botTexts ?? {}) });
  const [sw, setSw] = useState<BotSwitches>({ ...DEFAULT_BOT_SWITCHES, ...(meta.botSwitches ?? {}) });
  const [st, setSt] = usePageState('st-msgs', () => ({ key: 'early' as MsgKey }));
  const [paths, setPaths] = useState<Partial<Record<MsgKey, number>>>({});
  // ▶ the animated demo (step by step) is still there, next to the live preview
  const [demo, setDemo] = useState<DemoKey | null>(null);
  const onErr = useErr();
  const def = MSGS.find((m) => m.key === st.key) ?? MSGS[0];
  const saved = { ...DEFAULT_BOT_TEXTS, ...(meta.botTexts ?? {}) };
  const savedSw = { ...DEFAULT_BOT_SWITCHES, ...(meta.botSwitches ?? {}) };
  const dirty = (Object.keys(v) as (keyof BotTexts)[]).some((k) => v[k] !== saved[k]) || (Object.keys(sw) as (keyof BotSwitches)[]).some((k) => sw[k] !== savedSw[k]);
  const changedIn = (m: MsgDef) => [m.q, ...m.buttons.flatMap((b) => [b.b, b.r]), ...(m.extra ?? []).map((e) => e.k)].some((k) => k && v[k] !== saved[k]) || (!!m.sw && sw[m.sw] !== savedSw[m.sw]);
  const save = async () => {
    try {
      await api('/settings/bot-texts', { method: 'PUT', body: v });
      await api('/settings/bot-switches', { method: 'PUT', body: sw });
      toast(L('Bot 消息已保存', 'Bot messages saved')); await reloadMeta();
    } catch (e) { onErr(e); }
  };
  const set = (k: keyof BotTexts, x: string) => setV({ ...v, [k]: x });
  const on = def.sw ? sw[def.sw] : true;
  const id = (k: string) => `bm2-${k}`;
  return (
    <div className="bm2">
      <div className="bm2-tabs" role="tablist" aria-label={L('Bot 消息', 'Bot messages')}>
        {MSGS.map((m) => (
          <button key={m.key} type="button" role="tab" aria-selected={m.key === def.key} className={m.key === def.key ? 'on' : ''} onClick={() => setSt({ key: m.key })}>
            {m.sw && <i className={`bm2-dot ${sw[m.sw] ? '' : 'off'}`} aria-hidden="true" />}{m.title(L)}{changedIn(m) && <b className="bm2-chg" title={L('有未保存的修改', 'Unsaved changes')}>•</b>}
          </button>
        ))}
      </div>
      <div className="bm2-body">
        <section className="card bm2-form" role="tabpanel">
          <div className="bm2-h">
            <h3>{def.title(L)}</h3>
            {def.sw && (
              <label className={`bmsw ${sw[def.sw] ? 'on' : ''}`} title={L('关闭后 Bot 不会发送这一种消息', 'When off, the bot does not send this message')}>
                <input type="checkbox" checked={sw[def.sw]} disabled={readOnly} onChange={(e) => setSw({ ...sw, [def.sw!]: e.target.checked })} />
                <span className="bmsw-t" />{sw[def.sw] ? L('开启', 'On') : L('关闭', 'Off')}
              </label>
            )}
            {def.demo && <button type="button" className="bd-play" onClick={() => setDemo(def.demo!)}>▶ {L('动画演示', 'Animated demo')}</button>}
          </div>
          <p className="bm2-when">{def.when(L)}</p>
          {def.q && (
            <div className="bm2-f">
              <label htmlFor={id(def.q)}>{def.qLabel?.(L) ?? L('问题', 'Question')}</label>
              <textarea id={id(def.q)} rows={3} maxLength={400} value={v[def.q]} disabled={readOnly} onChange={(e) => set(def.q!, e.target.value)} />
              {def.fieldsHelp && <div className="bm2-help">{L('可用：', 'Fields: ')}{def.fieldsHelp.split(' ').map((x) => <code key={x}>{x}</code>)}</div>}
            </div>
          )}
          {def.buttons.length > 0 && (
            <div className="bm2-btns" style={{ gridTemplateColumns: `repeat(${def.buttons.length}, minmax(0, 1fr))` }}>
              {def.buttons.map((b, i) => (
                <div key={b.b} className="bm2-f">
                  <label htmlFor={id(b.b)}>{L(`按钮 ${i + 1}`, `Button ${i + 1}`)}</label>
                  <input id={id(b.b)} type="text" maxLength={40} value={v[b.b]} disabled={readOnly} onChange={(e) => set(b.b, e.target.value)} />
                  <div className="bm2-help">{b.does(L)}</div>
                </div>
              ))}
            </div>
          )}
          {def.buttons.map((b) => (
            <div key={b.r} className="bm2-f">
              <label htmlFor={id(b.r)}>{L(`按「${v[b.b]}」后的回复`, `Reply to "${v[b.b]}"`)}</label>
              <input id={id(b.r)} type="text" maxLength={400} value={v[b.r]} disabled={readOnly} onChange={(e) => set(b.r, e.target.value)} onFocus={() => setPaths({ ...paths, [def.key]: def.buttons.indexOf(b) + 1 })} />
            </div>
          ))}
          {(def.extra ?? []).map((x) => (
            <div key={x.k} className="bm2-f">
              <label htmlFor={id(x.k)}>{x.label(L, v)}</label>
              {x.short ? <input id={id(x.k)} type="text" maxLength={40} value={v[x.k]} disabled={readOnly} onChange={(e) => set(x.k, e.target.value)} />
                : <textarea id={id(x.k)} rows={2} maxLength={400} value={v[x.k]} disabled={readOnly} onChange={(e) => set(x.k, e.target.value)} />}
            </div>
          ))}
          {!readOnly && (
            <div className="bm2-foot">
              {dirty && <span className="bm2-unsaved">{L('有未保存的修改（所有分页一起保存）', 'Unsaved changes (all tabs are saved together)')}</span>}
              <button className="btn" onClick={() => setV({ ...DEFAULT_BOT_TEXTS })}>{L('恢复预设文字', 'Reset to default')}</button>
              <button className="btn p" onClick={save}>{L('保存', 'Save')}</button>
            </div>
          )}
        </section>
        <LivePreview def={def} t={v} on={on} path={paths[def.key] ?? 0} setPath={(n) => setPaths({ ...paths, [def.key]: n })} L={L} />
      </div>
      {demo && <BotDemo demo={demo} texts={v} switches={sw} punchReplies={rulesOf(meta, null).botReply} onClose={() => setDemo(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- Roster codes (OFF, VL, SL …)
type RCode = { code: string; name: string; color: number };
function RosterCodes() {
  const { L } = useI18n();
  const { meta, readOnly, reloadMeta } = useData();
  const [edit, setEdit] = useState<RCode | 'new' | null>(null);
  const onErr = useErr();
  const list = meta.rosterCodes ?? [];
  const chip = (c: RCode) => { const [bg, fg] = ROSTER_COLORS[c.color] ?? ROSTER_COLORS[0]; return <span className="rcchip" style={{ background: bg, color: fg }}>{c.code}</span>; };
  const del = async (c: RCode) => {
    if (!confirm(L(`删除代号 ${c.code}（${c.name}）？`, `Delete code ${c.code} (${c.name})?`))) return;
    try { await api(`/roster-codes/${encodeURIComponent(c.code)}`, { method: 'DELETE' }); toast(L('已删除', 'Deleted')); await reloadMeta(); } catch (e) { onErr(e); }
  };
  return (
    <div className="card"><h3>{L('排班代号', 'Roster codes')}</h3>
      <p className="mut" style={{ fontSize: 12.5, margin: '0 0 12px' }}>{L('不用上班的日子（休息、请假、假期……）用的代号，可以在 Roster 和排班导入里使用，和班次 A / B / C 并列。', 'Codes for days that are not a work shift (day off, leave, holiday…). They can be used on the roster and in roster imports, next to the shift codes A / B / C.')}</p>
      {list.length === 0 ? <div className="empty">{L('还没有代号，请新增', 'No codes yet — add your own')}</div> : (
        <div className="tw"><table><thead><tr><th>{L('代号', 'Code')}</th><th>{L('含义', 'Meaning')}</th>{!readOnly && <th>{L('操作', 'Action')}</th>}</tr></thead><tbody>
          {list.map((c) => <tr key={c.code}><td>{chip(c)}</td><td>{c.name}</td>{!readOnly && <td><button className="btn sm" onClick={() => setEdit(c)}>{L('编辑', 'Edit')}</button> <button className="btn sm d" onClick={() => del(c)}>{L('删除', 'Delete')}</button></td>}</tr>)}
        </tbody></table></div>
      )}
      {!readOnly && <div className="setfoot"><button className="btn p" onClick={() => setEdit('new')}>+ {L('新增代号', 'Add code')}</button></div>}
      {edit && <RosterCodeModal code={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function RosterCodeModal({ code, onClose }: { code: RCode | null; onClose: () => void }) {
  const { L } = useI18n();
  const { reloadMeta } = useData();
  const [v, setV] = useState<RCode>(code ?? { code: '', name: '', color: 3 });
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [bg, fg] = ROSTER_COLORS[v.color] ?? ROSTER_COLORS[0];
  const save = async () => {
    if (!v.code || !v.name.trim()) return setErr(new Error(L('请填写代号和含义', 'Code and meaning are required')));
    setBusy(true);
    try {
      await api(code ? `/roster-codes/${encodeURIComponent(code.code)}` : '/roster-codes', { method: code ? 'PUT' : 'POST', body: { code: v.code, name: v.name.trim(), color: v.color } });
      toast(L('已保存', 'Saved'));
      await reloadMeta();
      onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{code ? L('编辑代号', 'Edit code') : L('新增代号', 'Add code')}</h3>
      <div className="fg">
        <div><label>{L('代号（1–6 个字母或数字）', 'Code (1–6 letters or digits)')}</label><input value={v.code} maxLength={6} placeholder="e.g. EL" onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} /></div>
        <div><label>{L('含义', 'Meaning')}</label><input value={v.name} maxLength={40} placeholder="e.g. Emergency Leave" onChange={(e) => setV({ ...v, name: e.target.value })} /></div>
      </div>
      <div style={{ marginTop: 12 }}><label className="mut" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>{L('颜色', 'Color')}</label>
        <div className="rcsw">{ROSTER_COLORS.map(([b, f], k) => <button type="button" key={k} className={k === v.color ? 'on' : ''} style={{ background: b, color: f }} onClick={() => setV({ ...v, color: k })}>Aa</button>)}</div>
      </div>
      <div className="mut" style={{ fontSize: 12.5, marginTop: 12 }}>{L('Roster 上的样子：', 'Preview on the roster: ')}<span className="rcchip" style={{ background: bg, color: fg }}>{v.code || '—'}</span> {v.name}</div>
      {code && v.code !== code.code && <div className="mut" style={{ fontSize: 12, marginTop: 6 }}>{L(`Roster 上所有 ${code.code} 都会改成 ${v.code || '—'}。`, `Every ${code.code} on the roster becomes ${v.code || '—'}.`)}</div>}
      <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={save} busy={busy} />
    </Modal>
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
                <td>{configured ? <><b>@{b.username}</b><div className="mut" style={{ fontSize: 11.5 }}>Token {b.tokenLast4 ? `••••${b.tokenLast4}` : L('•••• 已隐藏', '•••• hidden')}{b.tokenSource === 'secret' ? ' · Cloudflare secret' : ''}</div></> : <Mut />}</td>
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
interface AdminRow { id: number; username: string; role: 'admin' | 'viewer'; is_active: number; is_owner: number; currencies: string[] | null; perms: SettingPerms | null; last_login_at: number | null; locked_until: number | null; created_at: number }

/** The Settings tabs as listed on the Settings page. */
const PERM_TABS = (L: (zh: string, en: string) => string): [SettingTab, string, string][] => [
  ['shift3', L('班次设置', 'Shift Setting'), L('班次时间、宽限 · 全系统', 'Shift times and grace · all currencies')],
  ['cur', L('货币', 'Currency'), L('货币与团队 · 全系统', 'Currencies and teams · all currencies')],
  ['kw', L('打卡关键词', 'Punch keywords'), L('IN / BREAK / RESUME / OUT 的写法 · 全系统', 'How IN / BREAK / RESUME / OUT are written · all currencies')],
  ['rules', L('考勤与异常规则', 'Attendance rules'), L('只能改他负责的货币', 'Only their own currencies')],
  ['msgs', L('Bot 消息', 'Bot messages'), L('Bot 文字、开关、▶ 预览 · 全系统', 'Bot texts, switches, ▶ Preview · all currencies')],
  ['codes', L('排班代号', 'Roster codes'), L('OFF、VL 等代号 · 全系统', 'OFF, VL and other codes · all currencies')],
  ['bot', L('Bot 设置', 'Bot Setting'), L('Bot 连线（Token 永远隐藏）', 'Bot connection (tokens always hidden)')],
  ['admins', L('管理员账号', 'Admin accounts'), L('新增账号、密码、货币（设置权限永远只有 Owner 能改）', 'Add accounts, passwords, currencies (Settings access stays with the owner)')],
];

/** Edit account → Settings access: per tab On / Off, and when on View only / Can edit. */
function PermsEditor({ perms, role, onChange, locked }: { perms: SettingPerms; role: 'admin' | 'viewer'; onChange: (p: SettingPerms) => void; locked?: boolean }) {
  const { L } = useI18n();
  const set = (t: SettingTab, v: SettingLevel | null) => { const n = { ...perms }; if (v) n[t] = v; else delete n[t]; onChange(n); };
  return (
    <div className="pmx">
      <div className="pmx-h"><b>{L('设置权限', 'Settings access')}</b><span>· {L('开启 = 这个页签会出现在他的「设置」里', 'On = the tab shows in their Settings')}{role === 'viewer' ? L(' · 只读账号最多「只能看」', ' · read-only accounts: View only') : ''}</span>{locked && <span className="pmx-lock" style={{ marginLeft: 'auto' }}>🔒 {L('只有 Owner 可以修改', 'Only the owner can change this')}</span>}</div>
      {PERM_TABS(L).map(([t, name, sub]) => {
        const v = perms[t];
        const eff = v && capOf(role, t) === 'v' ? 'v' : v;
        const canEdit = capOf(role, t) === 'e';
        return (
          <div className="pmx-r" key={t}>
            <div className="pmx-m"><b>{name}</b><small>{sub}</small></div>
            <div className="pmx-c">
              <div className={`pmx-seg ${v ? '' : 'off'}`} aria-hidden={!v}>
                <button type="button" className={eff === 'v' ? 'on v' : ''} disabled={!v || locked} onClick={() => set(t, 'v')}>{L('只能看', 'View only')}</button>
                <button type="button" className={eff === 'e' ? 'on e' : ''} disabled={!v || !canEdit || locked} title={canEdit ? undefined : t === 'bot' ? L('Bot 设置最多只能看', 'Bot Setting is view only') : L('只读账号不能修改', 'Read-only accounts cannot edit')} onClick={() => set(t, 'e')}>{L('可以修改', 'Can edit')}</button>
              </div>
              <label className={`bmsw ${v ? 'on' : ''}`}>
                <input type="checkbox" checked={!!v} disabled={locked} onChange={(e) => set(t, e.target.checked ? 'v' : null)} />
                <span className="bmsw-t" />{v ? L('开启', 'On') : L('关闭', 'Off')}
              </label>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Access({ a }: { a: AdminRow }) {
  const { L } = useI18n();
  if (a.is_owner || a.currencies === null) return <span className="b ok">{L('全部货币', 'All currencies')}</span>;
  if (!a.currencies.length) return <Mut />;
  return <>{a.currencies.map((c) => <span key={c} className="b cur" style={{ margin: '0 2px' }}>{c}</span>)}</>;
}

function Admins() {
  const { L } = useI18n();
  const { readOnly, owner } = useData();
  const { data, error, reload } = useApi<{ rows: AdminRow[]; me: number }>('/admins');
  // an account the owner gave "Admin accounts" can edit others, but not the owner and not itself
  const canEditRow = (a: AdminRow) => !readOnly && (owner || (!a.is_owner && a.id !== data?.me));
  const [edit, setEdit] = useState<AdminRow | 'new' | null>(null);
  return (
    <div className="card"><h3>{L('管理员账号', 'Admin accounts')}</h3>
      <ErrBox error={error} />
      {data && (
        <div className="tw"><table className="tpltbl"><thead><tr>
          <th>{L('账号', 'Username')}</th><th>{L('权限', 'Role')}</th><th>{L('可查看货币', 'Access')}</th><th>{L('状态', 'Status')}</th><th>{L('最后登录', 'Last sign-in')}</th><th>{L('建立日期', 'Created')}</th><th className="c">{L('操作', 'Action')}</th>
        </tr></thead><tbody>
          {data.rows.map((a) => (
            <tr key={a.id}>
              <td><b>{a.username}</b>{a.id === data.me && <> <span className="b i">{L('你', 'you')}</span></>}</td>
              <td>{a.is_owner ? <span className="b own">Owner</span> : a.role === 'admin' ? <span className="b v">{L('管理员', 'Admin')}</span> : <span className="b">{L('只读', 'Read-only')}</span>}</td>
              <td><Access a={a} /></td>
              <td>{!a.is_active ? <span className="b">{L('已停用', 'Disabled')}</span> : a.locked_until && a.locked_until > Date.now() ? <span className="b r">{L('暂时锁定', 'Locked')}</span> : <span className="b ok">{L('启用', 'Active')}</span>}</td>
              <td>{a.last_login_at ? fmtDT(a.last_login_at) : <Mut />}</td><td>{fmtDT(a.created_at).slice(0, 10)}</td>
              <td>{canEditRow(a) && <button className="btn sm" onClick={() => setEdit(a)}>{L('编辑', 'Edit')}</button>}</td>
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
  const { meta } = useData();
  const isOwner = !!a?.is_owner;
  const [username, setUsername] = useState(a?.username ?? '');
  const [role, setRole] = useState<'admin' | 'viewer'>(a?.role ?? 'admin');
  const [active, setActive] = useState(a ? !!a.is_active : true);
  // a new account starts limited: the owner ticks the currencies it may see, or opens access to all currencies
  const [allCur, setAllCur] = useState(a ? a.currencies === null : false);
  const [curs, setCurs] = useState<string[]>(a?.currencies ?? []);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  // Settings access: a new account starts with every tab off
  const [perms, setPerms] = useState<SettingPerms>(a?.perms ?? {});
  const [err, setErr] = useState<ApiErr | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (c: string) => setCurs((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]));
  const save = async () => {
    if (!a && !/^[A-Za-z0-9_.@-]{3,64}$/.test(username.trim())) return setErr(new Error(L('账号需为 3–64 个英文字母、数字或 _ . @ -', 'Username: 3–64 letters, digits or _ . @ -')));
    if ((!a || pw) && pw.length < 10) return setErr(new Error(L('密码至少 10 个字符', 'Password needs at least 10 characters')));
    if (pw !== pw2) return setErr(new Error(L('两次输入的密码不同', 'The passwords do not match')));
    if (!isOwner && !allCur && !curs.length) return setErr(new Error(L('请至少勾选一个货币', 'Tick at least one currency')));
    const currencies = isOwner || allCur ? null : curs;
    setBusy(true);
    try {
      const settingsPerms = isOwner ? undefined : cleanPerms(perms, role);
      if (a) await api(`/admins/${a.id}`, { method: 'PUT', body: { role: isOwner ? 'admin' : role, isActive: isOwner ? true : active, password: pw, currencies, settingsPerms } });
      else await api('/admins', { method: 'POST', body: { username: username.trim(), password: pw, role, currencies, settingsPerms } });
      toast(L('账号已保存，并写入 Audit Log', 'Account saved and written to the audit log'));
      onClose();
    } catch (e) { setErr(e as ApiErr); } finally { setBusy(false); }
  };
  return (
    <Modal onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>{a ? L('编辑账号 ', 'Edit account ') + a.username : L('新增账号', 'Add account')}</h3>
      <div className="fg">
        <div><label>{L('账号', 'Username')}</label><input type="text" value={username} disabled={!!a} autoComplete="off" onChange={(e) => setUsername(e.target.value)} /></div>
        <div><label>{L('权限', 'Role')}</label>{isOwner
          ? <select disabled value="owner"><option value="owner">Owner</option></select>
          : <select value={role} disabled={isMe} onChange={(e) => setRole(e.target.value as 'admin' | 'viewer')}><option value="admin">{L('管理员（可修改）', 'Admin (can edit)')}</option><option value="viewer">{L('只读（只能查看）', 'Read-only (view only)')}</option></select>}</div>
        {a && <div><label>{L('状态', 'Status')}</label><select value={active ? '1' : '0'} disabled={isMe || isOwner} onChange={(e) => setActive(e.target.value === '1')}><option value="1">{L('启用', 'Active')}</option><option value="0">{L('停用', 'Disabled')}</option></select></div>}
        <div className="full"><label>{L('可查看货币', 'Access')}</label>
          {isOwner ? <div className="accbox"><span className="b ok">{L('全部货币', 'All currencies')}</span> <span className="mut" style={{ fontSize: 12 }}>{L('Owner 固定看得到全部资料', 'The owner always sees everything')}</span></div> : (
            <div className="accbox">
              {/* "all currencies" only for someone who has all currencies; the list holds only the editor's own currencies */}
              {meta.user.currencies === null && <><label className="ck"><input type="checkbox" checked={allCur} onChange={(e) => setAllCur(e.target.checked)} /> {L('全部货币', 'All currencies')}</label>
              <span className="accsep" /></>}
              {meta.currencies.map((c) => (
                <label key={c.code} className={`ck ${allCur ? 'dis' : ''}`}><input type="checkbox" disabled={allCur} checked={allCur || curs.includes(c.code)} onChange={() => toggle(c.code)} /> {c.code}</label>
              ))}
            </div>
          )}
        </div>
        {!isOwner && <div className="full"><PermsEditor perms={perms} role={role} onChange={setPerms} locked={!meta.user.owner} /></div>}
        <div><label>{a ? L('新密码（留空 = 不更改）', 'New password (empty = unchanged)') : L('密码（至少 10 个字符）', 'Password (min. 10 characters)')}</label><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        <div><label>{L('再次输入密码', 'Repeat password')}</label><input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
      </div>
      <div style={{ marginTop: 8 }}><ErrBox error={err} /></div>
      <ModalActions onCancel={onClose} onOk={save} busy={busy} />
    </Modal>
  );
}
