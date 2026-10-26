// Settings → Bot messages → "▶ Preview": a short animated Telegram conversation that plays the bot message with the
// texts currently in the form (saved or not). Nothing is sent and nothing is stored: it only runs in this browser.
//
// Every automatic bot message has one entry in DEMOS below (its title, the answers it can show and its steps).
// A new bot message gets its preview by adding an entry here next to its fields on the Bot messages page.
import { useEffect, useRef, useState } from 'react';
import type { BotSwitches, BotTexts } from '../../../src/shared/codes';
import { useI18n } from '../lib/i18n';
import { Modal } from './ui';

export type DemoKey = 'early' | 'dayoff' | 'late' | 'scheduled' | 'incomplete';
type L = (zh: string, en: string) => string;

// sample data only — never a real employee
const CS1 = 'CS - 1', CS2 = 'CS - 2';
const SAMPLE: Record<DemoKey, Record<string, string>> = {
  early: { name: CS1, shift: '14:30–23:30', in: '13:52', hours: '', out: '' },
  late: { name: CS1, shift: '14:30–23:30', in: '14:28', hours: '9h 45m', out: '23:30' },
  scheduled: { name: CS1, shift: '14:30–23:30', in: '14:30', hours: '', out: '' },
  dayoff: { name: CS1, shift: '', in: '11:09', hours: '', out: '', code: 'OFF' },
  incomplete: { name: CS1, shift: '14:30–23:30', in: '14:50', hours: '', out: '23:30', worked: '8h 40m', need: '9h', until: '23:50', short: '20m' },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** One step of a demo: the caption shown under the chat, what happens, and how long to wait after it. */
interface Step { c: string; d: number; f: (p: Player) => Promise<void> }

/** The chat being animated (plain DOM: the steps add, edit and tap messages like Telegram does). */
class Player {
  q: HTMLElement | null = null;   // the bot question (its buttons sit right under it)
  kb: HTMLElement | null = null;  // the buttons currently shown
  constructor(public chat: HTMLElement, public stage: HTMLElement, public sleep: (ms: number) => Promise<void>) {}
  add(html: string) { this.chat.insertAdjacentHTML('beforeend', html); this.chat.scrollTop = this.chat.scrollHeight; return this.chat.lastElementChild as HTMLElement; }
  async typing(mine: boolean, ms: number) { const t = this.add(`<div class="bd-typing${mine ? ' me' : ''}"><i></i><i></i><i></i></div>`); await this.sleep(ms); t.remove(); }
  underQ(html: string) {
    this.kb?.remove();
    if (!this.q) { this.kb = this.add(html); return; }
    this.q.insertAdjacentHTML('afterend', html);
    this.kb = this.q.nextElementSibling as HTMLElement;
    this.chat.scrollTop = this.chat.scrollHeight;
  }
  async point(el: Element | undefined, hand = '👆') {
    if (!el) return;
    const f = this.stage.querySelector('.bd-finger') as HTMLElement, st = this.stage.getBoundingClientRect(), r = el.getBoundingClientRect();
    f.textContent = hand; f.style.opacity = '1';
    f.style.left = `${r.left - st.left + r.width / 2 - 8}px`; f.style.top = `${r.top - st.top + r.height / 2 - 4}px`;
    await this.sleep(650);
    el.classList.add('tap'); await this.sleep(250); el.classList.remove('tap'); f.style.opacity = '0';
  }
}

// ---------------------------------------------------------------- step builders
function builders(L: L, t: BotTexts, v: Record<string, string>) {
  const fill = (s: string) => esc(s).replace(/\{(name|shift|in|hours|out|worked|need|until|short|code)\}/g, (_, k: string) => v[k] ?? '');
  const bubble = (who: 'me' | 'bot', body: string, tm: string, extra = '') =>
    who === 'me' ? `<div class="bd-msg me"><div class="n">${CS1}</div>${body}<div class="tm">${extra}${tm} ✓✓</div></div>`
      : `<div class="bd-msg bot"><div class="n">Attendance Bot</div>${extra}<span class="body">${body}</span><div class="tm">${tm}</div></div>`;
  const me = (c: string, txt: string, tm: string, scheduled = false): Step => ({ c, d: 900, f: async (p) => {
    if (!scheduled) await p.typing(true, 600);
    p.add(bubble('me', esc(txt), tm, scheduled ? `<span class="sch">🕓 ${L('定时发送', 'scheduled')} · </span>` : ''));
  } });
  const bot = (c: string, html: string, tm: string, isQuestion = false): Step => ({ c, d: 1600, f: async (p) => {
    await p.typing(false, 700);
    const el = p.add(bubble('bot', html, tm));
    if (isQuestion) p.q = el;
  } });
  const punch = (c: string, what: string, tm: string) => bot(c, esc(`✅ ${what} recorded · ${tm} (Sri Lanka time)`), tm);
  const reply = (c: string, html: string, tm: string): Step => ({ c, d: 1800, f: async (p) => {
    await p.typing(false, 700);
    const quote = p.q ? (p.q.querySelector('.body')?.textContent ?? '').split('\n\n✓')[0] : '';
    p.add(bubble('bot', html, tm, `<div class="q">${esc(quote)}</div>`));
  } });
  const buttons = (c: string, labels: string[]): Step => ({ c, d: 900, f: async (p) => {
    p.underQ(`<div class="bd-kb c${labels.length}">${labels.map((l) => `<span>${esc(l)}</span>`).join('')}</div>`);
  } });
  const tap = (c: string, i: number, hand?: string): Step => ({ c, d: 700, f: async (p) => { await p.point(p.kb?.children[i], hand); } });
  const answered = (c: string, label: string, tm: string): Step => ({ c, d: 1500, f: async (p) => {
    const b = p.q?.querySelector('.body');
    if (!p.q || !b) return;
    b.innerHTML = b.innerHTML.replace(/\n\n✓[\s\S]*$/, '') + `\n\n✓ ${esc(label)} · ${CS1} · ${tm}`;
    const q = p.q; q.classList.add('flash'); setTimeout(() => q.classList.remove('flash'), 900);
    p.underQ(`<div class="bd-kb c1"><span>${esc(t.change)}</span></div>`);
  } });
  const popup = (c: string, txt: string): Step => ({ c, d: 2200, f: async (p) => {
    const el = p.stage.querySelector('.bd-toast') as HTMLElement;
    el.textContent = txt; el.classList.add('on'); await p.sleep(1800); el.classList.remove('on');
  } });
  const off = (c: string, txt: string): Step => ({ c, d: 1800, f: async (p) => { p.add(`<div class="bd-silent"><span>🔕 ${esc(txt)}</span></div>`); } });
  const gap = (c: string, tm: string): Step => ({ c, d: 1500, f: async (p) => { p.add(`<div class="bd-day"><span>· · ·  ${tm}</span></div>`); } });
  const say = (c: string): Step => ({ c, d: 1800, f: async () => undefined });
  return { fill, me, bot, punch, reply, buttons, tap, answered, popup, off, gap, say };
}

interface Demo {
  title: (L: L) => string;
  /** the answers the demo can show: [key, label] */
  paths: (L: L, t: BotTexts) => [string, string][];
  steps: (L: L, t: BotTexts, on: BotSwitches, punchReplies: boolean, path: string) => Step[];
}

const DEMOS: Record<DemoKey, Demo> = {
  early: {
    title: (L) => L('提早上班', 'Early clock in'),
    paths: (L, t) => [['yes', L(`按「${t.earlyYes}」`, `Press "${t.earlyYes}"`)], ['no', L(`按「${t.earlyNo}」`, `Press "${t.earlyNo}"`)],
      ['change', L(`更改答案`, 'Change answer')], ['notyou', L('别人去按', 'Someone else presses')]],
    steps(L, t, on, pr, path) {
      const b = builders(L, t, SAMPLE.early);
      const s: Step[] = [b.me(L(`${CS1} 比班次早 38 分钟到，打卡上班。`, `${CS1} arrives 38 minutes before the shift and clocks in.`), 'IN', '13:52')];
      if (pr) s.push(b.punch(L('Bot 确认这笔打卡（考勤规则 → Bot 回复）。', 'The bot confirms the punch (Attendance rules → Bot replies).'), 'Clock In', '13:52'));
      if (!on.early) return [...s, b.off(L('「提早上班」已关闭，Bot 不会问；打卡照常记录。', '"Early clock in" is off, so the bot does not ask. The punch is still recorded.'), L('「提早上班」已关闭 — 不发问题', 'Early clock in is off — no question'))];
      const labels = [t.earlyYes, t.earlyNo];
      s.push(b.bot(L('一分钟后，Bot 问这是不是 OT。', 'A minute later the bot asks whether this is OT.'), b.fill(t.earlyQ), '13:53', true),
        b.buttons(L('员工看到两个按钮。', 'The employee sees the buttons.'), labels));
      if (path === 'notyou') return [...s, b.tap(L(`${CS2}（另一位客服）想替他回答……`, `${CS2} (another CS) tries to answer for him…`), 0, '👉'),
        b.popup(L('……设定为「只有员工本人可以回答」时，Telegram 跳出这个提示，什么都不记录。', '…when only the employee may answer, Telegram shows this pop-up and nothing is recorded.'), t.notYou)];
      const i = path === 'no' ? 1 : 0;
      s.push(b.tap(L(`${CS1} 按「${labels[i]}」。`, `${CS1} presses "${labels[i]}".`), i),
        b.answered(L(`问题更新：显示答案、谁按的、几点按的；按钮变成「${t.change}」。`, `The question updates with the answer, who pressed it and when; the buttons become "${t.change}".`), labels[i], '13:54'),
        b.reply(L('Bot 回复这个问题。', 'The bot replies to the question.'), b.fill(i ? t.earlyRNo : t.earlyRYes), '13:54'));
      if (path === 'change') s.push(b.tap(L(`按错了，他按「${t.change}」。`, `He pressed the wrong one and presses "${t.change}".`), 0),
        b.buttons(L('按钮又出现了。', 'The buttons come back.'), labels),
        b.tap(L(`改按「${t.earlyNo}」。`, `He presses "${t.earlyNo}" instead.`), 1),
        b.answered(L('问题显示新的答案；之前的答案留在 Audit Log。', 'The question shows the new answer. The earlier answer stays in the Audit Log.'), t.earlyNo, '13:55'),
        b.reply(L('Bot 按新的答案再回复一次。', 'The bot replies again for the new answer.'), b.fill(t.earlyRNo), '13:55'));
      return s;
    },
  },
  dayoff: {
    title: (L) => L('休假日上班', 'Off day clock in'),
    paths: (L, t) => [['yes', L(`按「${t.offYes}」`, `Press "${t.offYes}"`)], ['no', L(`按「${t.offNo}」`, `Press "${t.offNo}"`)]],
    steps(L, t, on, pr, path) {
      const d = builders(L, t, SAMPLE.dayoff);
      const s: Step[] = [d.me(L(`今天是 ${CS1} 的休假日（排班表 OFF），他 11:09 打卡上班。`, `Today is ${CS1}'s day off (OFF on the roster). He clocks in at 11:09.`), 'IN', '11:09')];
      if (pr) s.push(d.punch(L('Bot 确认这笔打卡。', 'The bot confirms the punch.'), 'Clock In', '11:09'));
      if (!on.dayoff) return [...s, d.off(L('「休假日上班」已关闭，Bot 不会问；他打卡下班后这天照样算 OT。', '"Off day clock in" is off, so the bot does not ask. Once he clocks out the day still counts as OT.'), L('「休假日上班」已关闭 — 不发问题', 'Off day clock in is off — no question'))];
      const i = path === 'no' ? 1 : 0;
      const labels = [t.offYes, t.offNo], replies = [t.offRYes, t.offRNo];
      return [...s, d.bot(L('Bot 马上问这是不是 OT。', 'The bot asks right away whether this is OT.'), d.fill(t.offQ), '11:09', true),
        d.buttons(L('两个按钮。', 'Two buttons.'), labels),
        d.tap(L(`${CS1} 按「${labels[i]}」。`, `${CS1} presses "${labels[i]}".`), i),
        d.answered(L('问题显示答案和谁按的。', 'The question shows the answer and who pressed it.'), labels[i], '11:10'),
        d.reply(L(i ? 'Bot 回复。这天不算 OT。' : 'Bot 回复。这天算 1 次 OT。', i ? 'The bot replies. The day is not OT.' : 'The bot replies. The day counts as 1 OT.'), d.fill(replies[i]), '11:10')];
    },
  },
  late: {
    title: (L) => L('超时未下班', 'No clock out'),
    paths: (L, t) => [['still', L(`按「${t.lateStill}」`, `Press "${t.lateStill}"`)], ['ot', L(`按「${t.lateOt}」`, `Press "${t.lateOt}"`)], ['forgot', L(`按「${t.lateForgot}」`, `Press "${t.lateForgot}"`)]],
    steps(L, t, on, pr, path) {
      const b = builders(L, t, SAMPLE.late);
      const s: Step[] = [b.me(L(`${CS1} 上 14:30 的班，打卡上班。`, `${CS1} clocks in for the 14:30 shift.`), 'IN', '14:28')];
      if (pr) s.push(b.punch(L('Bot 确认。', 'The bot confirms it.'), 'Clock In', '14:28'));
      s.push(b.gap(L('……班次 23:30 结束，现在 00:13，他还没打卡下班。', '… the shift ends at 23:30. It is now 00:13 and he has not clocked out.'), '00:13'));
      if (!on.late) return [...s, b.off(L('「超时未下班」已关闭，Bot 不会问。', '"No clock out" is off, so the bot does not ask.'), L('「超时未下班」已关闭 — 不发问题', 'No clock out is off — no question'))];
      const i = path === 'ot' ? 1 : path === 'forgot' ? 2 : 0;
      const labels = [t.lateStill, t.lateOt, t.lateForgot], replies = [t.lateRStill, t.lateROt, t.lateRForgot];
      const what = [L('不计算 OT。', 'No OT is counted.'), L('OT 一直算到他打卡下班。', 'OT is counted until he clocks out.'),
        L('下班时间设为排班下班（23:30），并记一条异常。', 'His clock out is set to the shift end (23:30) and listed under Exceptions.')][i];
      return [...s, b.bot(L('下班时间过了一段时间，Bot 发问。', 'Some time after the shift end the bot asks.'), b.fill(t.lateQ), '00:13', true),
        b.buttons(L('三个按钮。', 'Three buttons.'), labels),
        b.tap(L(`${CS1} 按「${labels[i]}」。`, `${CS1} presses "${labels[i]}".`), i),
        b.answered(L('问题显示答案和谁按的。', 'The question shows the answer and who pressed it.'), labels[i], '00:16'),
        b.reply(L(`Bot 回复。${what}`, `The bot replies. ${what}`), b.fill(replies[i]), '00:16')];
    },
  },
  scheduled: {
    title: (L) => L('定时发送的打卡', 'Scheduled punch'),
    paths: () => [],
    steps(L, t, on) {
      const b = builders(L, t, SAMPLE.scheduled);
      return [b.say(L(`07:00，${CS1} 用「定时发送」把「IN」设在 14:30 发出——但他人不在。`, `At 07:00 ${CS1} schedules "IN" to be sent at 14:30 — but he is not at work.`)),
        b.me(L('14:30，Telegram 自动送出这条定时消息。', '14:30: Telegram sends the scheduled message by itself.'), 'IN', '14:30', true),
        on.scheduled
          ? b.bot(L('Bot 认出这是定时发送：这笔打卡不计入，并在异常记一条「定时发送的打卡」。', 'The bot sees it was scheduled: the punch is not counted and "Scheduled message" is listed under Exceptions.'), b.fill(t.scheduled), '14:30')
          : b.off(L('回复已关闭：Bot 不发消息，但打卡仍然不计入，异常仍然记录。', 'The reply is off: no message, but the punch is still not counted and still listed under Exceptions.'), L('「定时发送的打卡」回复已关闭 — 不发消息', 'Scheduled punch reply is off — no message'))];
    },
  },
  incomplete: {
    title: (L) => L('工时不足', 'Incomplete working hours'),
    paths: (L, t) => [['yes', L(`按「${t.incYes}」`, `Press "${t.incYes}"`)], ['no', L(`按「${t.incNo}」`, `Press "${t.incNo}"`)], ['forgot', L(`按「${t.incForgot}」`, `Press "${t.incForgot}"`)]],
    steps(L, t, on, pr, path) {
      const b = builders(L, t, SAMPLE.incomplete);
      const s: Step[] = [b.me(L(`${CS1} 的班是 14:30–23:30（9 小时，含休息），他 14:50 才上班——迟到 20 分钟。`, `${CS1}'s shift is 14:30–23:30 (9 hours, breaks included). He clocks in at 14:50 — 20 minutes late.`), 'IN', '14:50')];
      if (pr) s.push(b.punch(L('Bot 确认。', 'The bot confirms it.'), 'Clock In', '14:50'));
      s.push(b.gap(L('……迟到的人要从上班时间起算满 9 小时，也就是 23:50。', '… a late employee must complete 9 hours from the clock in, i.e. until 23:50.'), '23:30'),
        b.me(L('23:30 他就打卡下班了。', 'He clocks out at 23:30.'), 'OUT', '23:30'));
      if (!pr) return [...s, b.off(L('这个货币的 Bot 回复已关闭（考勤规则）：不发消息，异常仍然记录。', 'Bot replies are off for this currency (Attendance rules): no message, the exception is still listed.'), L('Bot 回复已关闭 — 不发消息', 'Bot replies are off — no message'))];
      const ok = esc('✅ Clock Out recorded · 23:30 (Sri Lanka time)');
      if (!on.incomplete) return [...s, b.bot(L('问题已关闭：只确认下班，但「工时不足」仍然记在异常。', 'The question is off: only the clock out is confirmed, but "Incomplete working hours" is still listed under Exceptions.'), ok, '23:30')];
      const labels = [t.incYes, t.incNo, t.incForgot], replies = [t.incRYes, t.incRNo, t.incRForgot];
      const i = path === 'no' ? 1 : path === 'forgot' ? 2 : 0;
      const what = [L('下班卡保留，异常记「工时不足」。', 'The clock out stands; "Incomplete working hours" is listed under Exceptions.'),
        L('这笔下班卡作废，异常记「取消下班（按了 No）」，他继续上班，之后要再打一次 OUT。', 'This clock out is cancelled and "Clock out cancelled (No)" is listed under Exceptions. He keeps working and clocks out again later.'),
        L('下班卡保留，异常记「忘记上班打卡」，等管理员批准并修改上班时间。', 'The clock out stands; "Forgot clock in" is listed for the admin to approve and correct the clock-in time.')][i];
      return [...s, b.bot(L('Bot 确认下班，并在同一条消息里问他。', 'The bot confirms the clock out and asks in the same message.'), `${ok}\n\n${b.fill(t.incomplete)}`, '23:30', true),
        b.buttons(L('三个按钮。', 'Three buttons.'), labels),
        b.tap(L(`${CS1} 按「${labels[i]}」。`, `${CS1} presses "${labels[i]}".`), i),
        b.answered(L('问题显示答案和谁按的。', 'The question shows the answer and who pressed it.'), labels[i], '23:31'),
        b.reply(L(`Bot 回复。${what}`, `The bot replies. ${what}`), b.fill(replies[i]), '23:31')];
    },
  },
};

const SPEEDS = [1, 1.6, 2.5];

export function BotDemo({ demo, path: path0, texts, switches, punchReplies, onClose }:
  { demo: DemoKey; path?: string; texts: BotTexts; switches: BotSwitches; punchReplies: boolean; onClose: () => void }) {
  const { L } = useI18n();
  const D = DEMOS[demo];
  const paths = D.paths(L, texts);
  const [path, setPath] = useState(path0 ?? paths[0]?.[0] ?? '');
  const [run, setRun] = useState(0);
  const [cap, setCap] = useState<[number, string]>([0, '']);
  const [prog, setProg] = useState(0);
  const [state, setState] = useState<'play' | 'pause' | 'done'>('play');
  const [speed, setSpeed] = useState(1.6);
  const chat = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null);
  const ctl = useRef({ paused: false, speed: 1.6 });
  ctl.current.speed = speed;

  useEffect(() => {
    let alive = true;
    ctl.current.paused = false;
    setState('play');
    const sleep = (ms: number) => new Promise<void>((res) => {
      let left = ms / ctl.current.speed;
      const tick = () => { if (!alive) return res(); if (ctl.current.paused) return void setTimeout(tick, 100); left -= 50; if (left <= 0) res(); else setTimeout(tick, 50); };
      tick();
    });
    const c = chat.current!, st = stage.current!;
    c.innerHTML = `<div class="bd-day"><span>${esc(L('今天', 'Today'))}</span></div>`;
    const p = new Player(c, st, sleep);
    const steps = D.steps(L, texts, switches, punchReplies, path);
    (async () => {
      for (let i = 0; i < steps.length && alive; i++) {
        setCap([i + 1, steps[i].c]); setProg((i + 1) / steps.length);
        await steps[i].f(p); await sleep(steps[i].d);
      }
      if (alive) setState('done');
    })();
    return () => { alive = false; };
    // texts / switches are read when a run starts (Replay picks up new ones)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, path, run]);

  const toggle = () => {
    if (state === 'done') return setRun((r) => r + 1);
    ctl.current.paused = state === 'play';
    setState(state === 'play' ? 'pause' : 'play');
  };
  return (
    <Modal onClose={onClose}>
      <div className="bd">
        <div className="bd-hd"><h3>▶ {D.title(L)}</h3><span className="bd-tag">{L('示范 · 不会发送任何消息', 'Demo · nothing is sent')}</span><button className="btn" onClick={onClose}>{L('关闭', 'Close')}</button></div>
        {paths.length > 0 && <div className="bd-paths"><span>{L('演示', 'Show')}</span>
          {paths.map(([k, l]) => <button key={k} className={k === path ? 'on' : ''} onClick={() => { setPath(k); setRun((r) => r + 1); }}>{l}</button>)}</div>}
        <div className="bd-stage" ref={stage}>
          <div className="bd-top">{CS1} <span>Topic · {demo === 'dayoff' ? L('今天 OFF', 'Today OFF') : `${L('班次', 'Shift')} 14:30–23:30`}</span></div>
          <div className="bd-chat" ref={chat} />
          <div className="bd-finger">👆</div>
          <div className="bd-toast" />
        </div>
        <div className="bd-cap"><b>{cap[0]}</b><span>{cap[1]}</span></div>
        <div className="bd-ctl">
          <button className="btn" onClick={toggle}>{state === 'play' ? L('❚❚ 暂停', '❚❚ Pause') : state === 'pause' ? L('▶ 继续', '▶ Play') : L('✓ 完成', '✓ Done')}</button>
          <button className="btn" onClick={() => setRun((r) => r + 1)}>{L('↺ 重播', '↺ Replay')}</button>
          <div className="bd-bar"><i style={{ width: `${prog * 100}%` }} /></div>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label={L('速度', 'Speed')}>
            {SPEEDS.map((s, i) => <option key={s} value={s}>{['1×', '1.5×', '2×'][i]}</option>)}
          </select>
        </div>
      </div>
    </Modal>
  );
}
