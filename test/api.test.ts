// Integration tests: the real Worker (Hono app, webhook, recompute, cron) against the real migrations in SQLite.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOUR, MIN } from '../src/shared/time';
import { CHAT, fixture, Harness, lk, TEST_KEYWORDS, TEST_PARSER } from './helpers';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const D = '2026-10-15';
const D2 = '2026-10-16';

describe('end-to-end acceptance flow', () => {
  it('IN → BREAK → RESUME → OUT reaches Dashboard, Attendance and Reports with correct totals', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    let r = await h.send({ text: 'IN', ts: lk(D, '06:58'), thread: 1001 });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('PROCESSED');
    expect(h.tg.filter((c) => c.method === 'sendMessage').at(-1)?.body.text).toMatch(/Clock In recorded · 06:58/);

    const ov1 = await h.req('GET', `/api/overview?date=${D}`);
    expect(ov1.json).toMatchObject({ expected: 1, working: 1, clockedIn: 1 });

    await h.send({ text: 'BREAK', ts: lk(D, '10:00'), thread: 1001 });
    expect((await h.req('GET', `/api/overview?date=${D}`)).json.onBreak).toBe(1);
    await h.send({ text: 'resume', ts: lk(D, '10:25'), thread: 1001 });
    await h.send({ text: 'Out', ts: lk(D, '15:04'), thread: 1001 });

    const att = await h.req('GET', `/api/attendance?from=${D}&to=${D}`);
    expect(att.json.total).toBe(1);
    expect(att.json.rows[0]).toMatchObject({ employee_code: 'E001', status: 'ON_TIME', late_min: 0, early_min: 0, break_count: 1, total_break_ms: 25 * MIN,
      shift_duration_ms: 8 * HOUR + 6 * MIN, net_worked_ms: 8 * HOUR + 6 * MIN - 25 * MIN });

    const rep = await h.req('GET', `/api/reports?from=${D}&to=${D}`);
    expect(rep.json.mode).toBe('summary');
    expect(rep.json.rows[0]).toMatchObject({ employee_code: 'E001', scheduled: 1, present: 1, absent: 0, breaks: 1, break_ms: 25 * MIN, shift_ms: 8 * HOUR + 6 * MIN });

    const detail = await h.req('GET', `/api/sessions/${e1}/${D}`);
    expect(detail.json.events.map((e: any) => e.event_type)).toEqual(['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT']);
    expect(detail.json.events[0]).toMatchObject({ raw_text: 'IN', telegram_message_ts: lk(D, '06:58'), raw_received_at: lk(D, '06:58') + 2000 });
  });
});

describe('Telegram webhook', () => {
  it('test 13: wrong secret → 401 and nothing stored', async () => {
    const { h } = await fixture();
    const r = await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001, secret: 'wrong' });
    expect(r.status).toBe(401);
    expect(h.db.get('SELECT COUNT(*) AS n FROM telegram_messages')).toEqual({ n: 0 });
  });

  it('clean: wipes the bot (token, account, webhook, secret) but keeps attendance; a new bot can be set up', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    expect((await h.send({ text: 'IN', ts: lk(D, '06:58'), thread: 1001 })).json.status).toBe('PROCESSED');
    const oldSecret = await h.secretFor('LKR');
    const r = await h.req('POST', '/api/bots/LKR/clean');
    expect(r.status).toBe(200);
    expect(r.json.webhookRemoved).toBe(true);
    const b = h.db.get<Record<string, unknown>>("SELECT * FROM telegram_bots WHERE currency_code = 'LKR'")!;
    expect([b.status, b.token_ciphertext, b.username, b.webhook_url, b.bot_user_id]).toEqual(['NOT_SET', null, null, null, null]);
    expect((await h.session(e1, D))!.actual_in_at).toBe(lk(D, '06:58')); // attendance kept
    expect((await h.send({ text: 'OUT', ts: lk(D, '15:00'), thread: 1001, secret: oldSecret })).status).toBe(401); // old secret is dead
    expect(h.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'BOT_CLEARED'")).toEqual({ n: 1 });
    await h.setupBot('LKR', 700000009);
    expect((await h.send({ text: 'OUT', ts: lk(D, '15:01'), thread: 1001 })).json.status).toBe('PROCESSED');
  });

  it('unknown currency path → 404; bot mid-setup (NOT_SET) with a valid secret is accepted; stopped bot → 503', async () => {
    const { h } = await fixture();
    expect((await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001, code: 'XYZ', secret: 'x' })).status).toBe(404);
    expect((await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001, code: 'USD' })).status).toBe(200);
    await h.req('POST', '/api/bots/LKR/stop');
    expect((await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 })).status).toBe(503);
  });

  it('test 10: duplicate update (Telegram retry) and the same message via a second bot create one event', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    const first = await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001, updateId: 5001 });
    const retry = await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001, updateId: 5001, at: lk(D, '07:01') });
    expect(first.json.status).toBe('PROCESSED');
    expect(retry.json.status).toBe('DUPLICATE');
    await h.setupBot('MYR', 700000002);
    const other = await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001, code: 'MYR', updateId: 9001, messageId: 5001 });
    expect(other.json.status).toMatch(/IGNORED_OTHER_BOT|DUPLICATE/);
    expect(h.db.get('SELECT COUNT(*) AS n FROM attendance_events')).toEqual({ n: 1 });
  });

  it('test 18: database write failure → 500, nothing partial; Telegram retry succeeds once', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    h.db.failNextBatch = /INSERT INTO attendance_events/;
    const r = await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001, updateId: 6001 });
    expect(r.status).toBe(500);
    expect(h.db.get('SELECT COUNT(*) AS n FROM telegram_messages')).toEqual({ n: 0 });
    const again = await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001, updateId: 6001, at: lk(D, '07:02') });
    expect(again.status).toBe(200);
    expect(again.json.status).toBe('PROCESSED');
    expect(h.db.get('SELECT COUNT(*) AS n FROM attendance_events')).toEqual({ n: 1 });
    expect((await h.session(e1, D))!.actual_in_at).toBe(lk(D, '07:00'));
  });

  it('recompute failure after the event is stored is healed by the cron job', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    h.db.failNextBatch = /INSERT INTO attendance_sessions/;
    const r = await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    expect(r.json.status).toBe('PROCESSED');
    expect((await h.session(e1, D))?.actual_in_at ?? null).toBeNull();
    await h.cron(lk(D, '07:10'));
    expect((await h.session(e1, D))!.actual_in_at).toBe(lk(D, '07:00'));
  });

  it('test 11 / 12: wrong topic, no topic, unregistered topic and forwarded messages never create attendance', async () => {
    const { h } = await fixture();
    const general = await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: null });
    const unmapped = await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 4040 });
    const fwd = await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001, forwarded: true });
    expect([general.json.status, unmapped.json.status, fwd.json.status]).toEqual(['REJECTED_IDENTITY', 'REJECTED_IDENTITY', 'REJECTED_IDENTITY']);
    expect(h.db.get('SELECT COUNT(*) AS n FROM attendance_events')).toEqual({ n: 0 });
    expect(h.db.rows('SELECT code FROM attendance_exceptions ORDER BY id').map((x: any) => x.code)).toEqual(['NO_TOPIC', 'WRONG_TOPIC_UNMAPPED', 'UNTRUSTED_SOURCE']);
  });

  it('messages from chats that are not allowed are ignored and not stored', async () => {
    const { h } = await fixture();
    const r = await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001, chat: -1009999999999 });
    expect(r.json.status).toBe('IGNORED_CHAT');
    expect(h.db.get('SELECT COUNT(*) AS n FROM telegram_messages')).toEqual({ n: 0 });
  });

  it('ordinary chat in General is not stored; near-miss punches become pending review', async () => {
    const { h } = await fixture();
    expect((await h.send({ text: 'good morning', ts: lk(D, '07:00'), thread: null })).json.status).toBe('IGNORED');
    const nm = await h.send({ text: 'IN 08:30', ts: lk(D, '08:31'), thread: 1001 });
    expect(nm.json.status).toBe('PENDING_REVIEW');
    expect(h.db.get('SELECT COUNT(*) AS n FROM telegram_messages')).toEqual({ n: 1 });
    expect(h.db.get('SELECT COUNT(*) AS n FROM attendance_events')).toEqual({ n: 0 });
  });

  it('edited punch messages are recorded for review and never change the original event', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    const orig = await h.send({ text: 'IN', ts: lk(D, '07:20'), thread: 1001 });
    await h.send({ text: 'IN 07:00', ts: lk(D, '07:20'), thread: 1001, messageId: orig.messageId, edited: { editTs: lk(D, '07:45') } });
    expect((await h.session(e1, D))!.actual_in_at).toBe(lk(D, '07:20'));
    expect(h.db.get("SELECT code FROM attendance_exceptions WHERE code = 'EDITED_MESSAGE'")).toBeTruthy();
  });

  it('inactive employees and migrated topics', async () => {
    const { h, e1 } = await fixture();
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    // migrate E001 to a new topic, the old one becomes unmapped
    h.now(lk(D, '12:00'));
    await h.req('PUT', `/api/employees/${e1}`, { code: 'E001', name: 'Nimal Perera', currency: 'LKR', timezone: 'Asia/Colombo', chatId: String(CHAT), threadId: '2001' });
    expect((await h.send({ text: 'OUT', ts: lk(D, '15:00'), thread: 2001 })).json.status).toBe('PROCESSED');
    expect((await h.send({ text: 'IN', ts: lk(D2, '07:00'), thread: 1001 })).json.codes).toEqual(['WRONG_TOPIC_UNMAPPED']);
    const hist = await h.req('GET', `/api/employees/${e1}`);
    expect(hist.json.mappings).toHaveLength(2);
    h.now(lk(D2, '09:00'));
    await h.req('POST', `/api/employees/${e1}/deactivate`, { reason: 'Resigned' });
    expect((await h.send({ text: 'IN', ts: lk(D2, '10:00'), thread: 2001 })).json.codes).toEqual(['WRONG_TOPIC_UNMAPPED']);
    expect(h.db.get('SELECT COUNT(*) AS n FROM attendance_events WHERE employee_id = ?', e1)).toEqual({ n: 2 }); // history kept
  });
});

describe('shifts, roster and rotation', () => {
  it('test 5: rotating shifts — each punch attaches to the instance in force', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    await h.roster(e1, D2, 'B');
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    await h.send({ text: 'OUT', ts: lk(D, '15:00'), thread: 1001 });
    await h.send({ text: 'IN', ts: lk(D2, '15:12'), thread: 1001 });
    await h.send({ text: 'OUT', ts: lk(D2, '23:00'), thread: 1001 });
    expect((await h.session(e1, D))!.status).toBe('ON_TIME');
    const s2 = (await h.session(e1, D2))!;
    expect(s2.status).toBe('LATE');
    expect(s2.late_min).toBe(7);
  });

  it('test 6: overnight C shift — OUT after midnight belongs to the night that started on the 15th', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'C');
    await h.send({ text: 'IN', ts: lk(D, '22:57'), thread: 1001 });
    await h.send({ text: 'BREAK', ts: lk(D2, '02:00'), thread: 1001 });
    await h.send({ text: 'RESUME', ts: lk(D2, '02:40'), thread: 1001 });
    await h.send({ text: 'OUT', ts: lk(D2, '07:01'), thread: 1001 });
    const s = (await h.session(e1, D))!;
    expect(s).toMatchObject({ status: 'ON_TIME', total_break_ms: 40 * MIN, net_worked_ms: 8 * HOUR + 4 * MIN - 40 * MIN });
    expect(await h.session(e1, D2)).toBeUndefined();
  });

  it('test 7: a temporary roster change recomputes the past session and is audited', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    await h.send({ text: 'IN', ts: lk(D, '09:00'), thread: 1001 });
    await h.send({ text: 'OUT', ts: lk(D, '17:00'), thread: 1001 });
    expect((await h.session(e1, D))!.status).toBe('LATE'); // the A shift is wrong for this day
    h.now(lk(D2, '09:00'));
    await h.req('POST', '/api/shifts', { code: 'D', name: 'Day Shift', start: '09:00', end: '17:00', breakMinutes: 60 });
    const dShift = h.db.get<{ id: number }>("SELECT id FROM shift_templates WHERE code = 'D'")!.id;
    const r = await h.req('PUT', '/api/roster/cell', { employeeId: e1, date: D, value: dShift, reason: 'Moved to day shift for training' });
    expect(r.status).toBe(200);
    const s = (await h.session(e1, D))!;
    expect(s.status).toBe('ON_TIME');
    expect(h.db.get("SELECT adjustment_status FROM shift_instances WHERE employee_id = ? AND shift_date = ?", e1, D)).toEqual({ adjustment_status: 'ADJUSTED' });
    expect(h.db.get("SELECT note FROM audit_logs WHERE action = 'SHIFT_INSTANCE_ADJUSTED' ORDER BY id DESC")).toEqual({ note: 'Moved to day shift for training' });
  });

  it('template edits apply to future instances only; past results keep their snapshot', async () => {
    const { h, e1 } = await fixture(lk(D, '05:00'));
    await h.roster(e1, D, 'A');
    await h.roster(e1, '2026-10-20', 'A');
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    const A = h.db.get<{ id: number }>("SELECT id FROM shift_templates WHERE code = 'A'")!.id;
    await h.req('PUT', `/api/shifts/${A}`, { name: 'A Shift', start: '08:00', end: '16:00', lateGrace: 5, earlyGrace: 5, breakMinutes: 60, isActive: true, applyFuture: true });
    const past = h.db.get<any>('SELECT scheduled_start_at FROM shift_instances WHERE employee_id = ? AND shift_date = ?', e1, D);
    const fut = h.db.get<any>("SELECT scheduled_start_at FROM shift_instances WHERE employee_id = ? AND shift_date = '2026-10-20'", e1);
    expect(past.scheduled_start_at).toBe(lk(D, '07:00'));
    expect(fut.scheduled_start_at).toBe(lk('2026-10-20', '08:00'));
  });

  it('roster import: dry-run plan, then apply with a reason', async () => {
    const { h, e1, e2 } = await fixture();
    const grid = [['Employee ID', 'Name', '2026-10-20', '2026-10-21', '2026-10-22'], ['E001', 'Nimal', 'A', 'B', 'OFF'], ['E002', 'Kasun', 'C', 'X', ''], ['E999', '?', 'A', '', '']];
    const dry = await h.req('POST', '/api/roster/import', { grid, fileName: 'oct.csv' });
    expect(dry.json.plan).toMatchObject({ changeCount: 4, errorCount: 2, unchanged: 0 }); // OFF is a roster code: the day gets marked OFF
    expect((await h.req('POST', '/api/roster/import', { grid, apply: true, reason: '' })).status).toBe(400);
    const ap = await h.req('POST', '/api/roster/import', { grid, fileName: 'oct.csv', apply: true, reason: 'October roster' });
    expect(ap.json.applied).toMatchObject({ added: 3 });
    const roster = await h.req('GET', '/api/roster?from=2026-10-20&to=2026-10-22');
    expect(roster.json.instances.map((i: any) => `${i.employee_id}:${i.shift_date}:${i.shift_code}`).sort()).toEqual([`${e1}:2026-10-20:A`, `${e1}:2026-10-21:B`, `${e2}:2026-10-20:C`].sort());
    expect(roster.json.marks).toEqual([{ employee_id: e1, mark_date: '2026-10-22', code: 'OFF' }]);
  });

  it('default shift assignment generates future instances', async () => {
    const { h, e1 } = await fixture();
    const B = h.db.get<{ id: number }>("SELECT id FROM shift_templates WHERE code = 'B'")!.id;
    await h.req('PUT', `/api/employees/${e1}`, { code: 'E001', name: 'Nimal Perera', currency: 'LKR', defaultShiftId: B, timezone: 'Asia/Colombo', chatId: String(CHAT), threadId: '1001' });
    expect(h.db.get('SELECT COUNT(*) AS n FROM shift_instances WHERE employee_id = ? AND shift_code = ?', e1, 'B')).toEqual({ n: 14 });
    expect(h.db.get('SELECT MIN(shift_date) AS d FROM shift_instances WHERE employee_id = ?', e1)).toEqual({ d: D2 });
  });
});

describe('missing punches and the cron job', () => {
  it('test 8: missing clock-out and no-shows are detected as time passes', async () => {
    const { h, e1, e2 } = await fixture();
    await h.roster(e1, D, 'A');
    await h.roster(e2, D, 'A');
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    await h.cron(lk(D, '08:00'));
    expect((await h.session(e2, D))!.status).toBe('NOT_CLOCKED_IN');
    await h.cron(lk(D, '09:15'));
    expect((await h.session(e2, D))!.status).toBe('ABSENT');
    expect((await h.session(e1, D))!.status).toBe('WORKING');
    await h.cron(lk(D, '20:45'));
    expect((await h.session(e1, D))!.status).toBe('WORKING'); // 14 h after clock in (default) is 21:00
    await h.cron(lk(D, '21:15'));
    expect((await h.session(e1, D))).toMatchObject({ status: 'INCOMPLETE', missing: 'MISSING_OUT' });
    const ex = await h.req('GET', '/api/exceptions?status=OPEN');
    expect(ex.json.rows.map((x: any) => x.code).sort()).toEqual(['MISSING_CLOCK_OUT', 'NO_SHOW']);
  });

  it('test 9: unended break', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    await h.send({ text: 'BREAK', ts: lk(D, '11:00'), thread: 1001 });
    await h.cron(lk(D, '13:05'));
    expect((await h.session(e1, D))).toMatchObject({ status: 'ON_BREAK', missing: 'BREAK_NOT_ENDED' });
    const out = await h.send({ text: 'OUT', ts: lk(D, '15:00'), thread: 1001 });
    expect(out.json.codes).toEqual(['CLOCK_OUT_DURING_BREAK']);
    expect((await h.session(e1, D))).toMatchObject({ status: 'INCOMPLETE', net_worked_ms: null, open_break_count: 1 });
  });

  it('test 14: invalid transitions are stored, flagged and answered by the bot', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    const b = await h.send({ text: 'BREAK', ts: lk(D, '06:50'), thread: 1001 });
    expect(b.json.codes).toEqual(['BREAK_BEFORE_CLOCK_IN']);
    expect(h.tg.filter((c) => c.method === 'sendMessage').at(-1)?.body.text).toMatch(/not counted/);
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    await h.send({ text: 'OUT', ts: lk(D, '15:00'), thread: 1001 });
    const late = await h.send({ text: 'IN', ts: lk(D, '15:10'), thread: 1001 });
    expect(late.json.codes).toEqual(['PUNCH_AFTER_COMPLETED']);
    const ev = h.db.rows<any>('SELECT event_type, sm_result FROM attendance_events WHERE employee_id = ? ORDER BY event_ts', e1);
    expect(ev.map((e) => e.sm_result)).toEqual(['BREAK_BEFORE_CLOCK_IN', null, null, 'PUNCH_AFTER_COMPLETED']);
  });
});

describe('admin corrections and audit (test 16)', () => {
  it('adds a missing OUT and voids a wrong event; raw data stays untouched', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    const wrong = await h.send({ text: 'OUT', ts: lk(D, '08:00'), thread: 1001 });
    h.now(lk(D2, '09:00'));
    const evId = h.db.get<{ id: number }>("SELECT id FROM attendance_events WHERE event_type = 'CLOCK_OUT'")!.id;
    expect((await h.req('POST', `/api/sessions/${e1}/${D}/adjustments`, { action: 'VOID_EVENT', targetEventId: evId, reason: 'x' })).status).toBe(400); // reason too short
    expect((await h.req('POST', `/api/sessions/${e1}/${D}/adjustments`, { action: 'VOID_EVENT', targetEventId: evId, reason: 'Sent OUT by mistake' })).status).toBe(200);
    const add = await h.req('POST', `/api/sessions/${e1}/${D}/adjustments`, { action: 'ADD_EVENT', eventType: 'CLOCK_OUT', ts: lk(D, '15:02'), reason: 'Supervisor confirmed 15:02' });
    expect(add.status).toBe(200);
    expect(add.json.after).toMatchObject({ status: 'ON_TIME', actual_out: '2026-10-15 15:02:00' });
    expect((await h.session(e1, D))!.adjusted).toBe(1);
    expect(h.db.get('SELECT raw_text FROM telegram_messages WHERE update_id = ?', wrong.updateId)).toEqual({ raw_text: 'OUT' });
    expect(h.db.rows("SELECT action FROM audit_logs WHERE action = 'ATTENDANCE_ADJUSTED'")).toHaveLength(2);
    // raw data and audit log cannot be rewritten even with direct SQL
    expect(() => h.db.x("UPDATE telegram_messages SET raw_text = 'IN'")).toThrow(/immutable/);
    expect(() => h.db.x('DELETE FROM audit_logs')).toThrow(/append-only/);
    expect(() => h.db.x('UPDATE attendance_events SET event_ts = 0')).toThrow(/immutable/);
  });

  it('edit = delete the old punch + add the corrected one in one step; both are traceable', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    await h.send({ text: 'OUT', ts: lk(D, '13:00'), thread: 1001 });
    h.now(lk(D2, '09:00'));
    const evId = h.db.get<{ id: number }>("SELECT id FROM attendance_events WHERE event_type = 'CLOCK_OUT'")!.id;
    expect((await h.req('POST', `/api/sessions/${e1}/${D}/adjustments`, { action: 'EDIT_EVENT', targetEventId: evId, eventType: 'CLOCK_OUT', ts: lk(D, '13:00'), reason: 'No real change here' })).status).toBe(400);
    const r = await h.req('POST', `/api/sessions/${e1}/${D}/adjustments`, { action: 'EDIT_EVENT', targetEventId: evId, eventType: 'CLOCK_OUT', ts: lk(D, '15:05'), reason: 'Supervisor confirmed 15:05' });
    expect(r.status).toBe(200);
    expect(r.json.after).toMatchObject({ status: 'ON_TIME', actual_out: '2026-10-15 15:05:00' });
    const adj = h.db.rows<any>('SELECT action, target_event_id, after_json IS NOT NULL AS done FROM attendance_adjustments ORDER BY id');
    expect(adj).toEqual([{ action: 'VOID_EVENT', target_event_id: evId, done: 1 }, { action: 'ADD_EVENT', target_event_id: evId, done: 1 }]);
    expect((await h.req('POST', `/api/sessions/${e1}/${D}/adjustments`, { action: 'EDIT_EVENT', targetEventId: evId, eventType: 'CLOCK_OUT', ts: lk(D, '15:06'), reason: 'Second edit of old one' })).status).toBe(400);
  });

  it('editing an exception can fix attendance in one step', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    await h.cron(lk(D, '21:30'));
    const ex = (await h.req('GET', '/api/exceptions?code=MISSING_CLOCK_OUT')).json.rows[0];
    const fix = (await h.req('GET', `/api/exceptions/${ex.id}/fix`)).json.fix;
    expect(fix).toMatchObject({ employeeId: e1, workDate: D, type: 'CLOCK_OUT', ts: lk(D, '15:00'), on: true });
    const r = await h.req('PUT', `/api/exceptions/${ex.id}`, { status: 'RESOLVED', note: 'confirmed', fix: { employeeId: e1, workDate: D, eventType: 'CLOCK_OUT', ts: fix.ts, reason: fix.reason.en } });
    expect(r.status).toBe(200);
    expect((await h.session(e1, D))!.status).toBe('ON_TIME');
    expect(h.db.get('SELECT status, handled_by FROM attendance_exceptions WHERE id = ?', ex.id)).toEqual({ status: 'RESOLVED', handled_by: 'owner' });
  });

  it('real-world messages with admin-entered keywords and reading rules: label lines skipped, break remark shown', async () => {
    const { h, e1 } = await fixture();
    expect((await h.req('PUT', '/api/settings/keywords', { keywords: TEST_KEYWORDS })).status).toBe(200);
    expect((await h.req('PUT', '/api/settings/parser', TEST_PARSER)).status).toBe(200);
    await h.roster(e1, D, 'A');
    const a = await h.send({ text: 'Clocked in\nAgent: Nimal\nDate: 15/10/2026', ts: lk(D, '06:58'), thread: 1001 });
    expect(a.json.status).toBe('PROCESSED');
    const b = await h.send({ text: 'Name: Nimal\nLunch Break - 60 mins', ts: lk(D, '11:00'), thread: 1001 });
    expect(b.json.status).toBe('PROCESSED');
    await h.send({ text: 'back', ts: lk(D, '11:40'), thread: 1001 });
    await h.send({ text: 'CS Name: Nimal\nWC', ts: lk(D, '13:00'), thread: 1001 });
    await h.send({ text: 'Back', ts: lk(D, '13:07'), thread: 1001 });
    await h.send({ text: 'Done for the day - Nimal', ts: lk(D, '15:01'), thread: 1001 });
    const s = (await h.session(e1, D))!;
    expect([s.actual_in_at, s.actual_out_at, s.break_count]).toEqual([lk(D, '06:58'), lk(D, '15:01'), 2]);
    const br = await h.req('GET', `/api/breaks?from=${D}&to=${D}`);
    expect(br.json.breaks.map((x: { remark: string }) => x.remark)).toEqual(['Lunch Break - 60 mins', 'WC']);
    const t = await h.send({ text: 'IN 08:30', ts: lk(D, '15:05'), thread: 1001 });
    expect(t.json.status).toBe('PENDING_REVIEW');
  });

  it('typed time accepted when the review rule is off: Telegram time is recorded, the typed time is listed for follow-up', async () => {
    const { h, e1 } = await fixture();
    expect((await h.req('PUT', '/api/settings/keywords', { keywords: TEST_KEYWORDS })).status).toBe(200);
    const pr = await h.req('PUT', '/api/settings/parser', { ...TEST_PARSER, typedTimeReview: false });
    expect(pr.json).toEqual({ ok: true });
    await h.roster(e1, D, 'A');
    const r = await h.send({ text: 'clock in\nAgent: Test-02\nTime:12.15', ts: lk(D, '07:03'), thread: 1001 });
    expect(r.json.status).toBe('PROCESSED');
    await h.flush();
    expect((await h.session(e1, D))!.actual_in_at).toBe(lk(D, '07:03'));
    const ex = h.db.get<{ code: string; detail: string }>("SELECT code, detail FROM attendance_exceptions WHERE code = 'TYPED_TIME'")!;
    expect(JSON.parse(ex.detail).zh).toContain('12.15');
    const reply = h.tg.filter((t) => t.method === 'sendMessage').pop()!.body as { text: string };
    expect(reply.text).toContain('07:03');
    expect(reply.text).toContain('12.15');
  });

  it('re-parses pending messages after the keyword list changes', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    expect((await h.send({ text: 'hello', ts: lk(D, '07:00'), thread: 1001 })).json.status).toBe('IGNORED');
    expect((await h.send({ text: 'clock', ts: lk(D, '07:01'), thread: 1001 })).json.status).toBe('PENDING_REVIEW');
    await h.req('PUT', '/api/settings/keywords', { keywords: { CLOCK_IN: ['IN', 'CLOCK IN', 'clock'], BREAK_START: ['BREAK'], BREAK_END: ['RESUME'], CLOCK_OUT: ['OUT'] } });
    const r = await h.req('POST', '/api/messages/reparse');
    expect(r.json.count).toBe(1);
    expect((await h.session(e1, D))!.actual_in_at).toBe(lk(D, '07:01'));
  });
});

describe('security (test 17)', () => {
  it('API requires a session', async () => {
    const h = new Harness();
    for (const p of ['/api/meta', '/api/attendance?from=2026-10-01&to=2026-10-02', '/api/employees', '/api/bots', '/api/audit']) {
      expect((await h.req('GET', p)).status).toBe(401);
    }
    expect((await h.req('POST', '/api/employees', { code: 'X', name: 'X' })).status).toBe(401);
  });

  it('wrong password is rejected and 5 failures lock the account', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(lk(D, '05:00'));
    const h = new Harness();
    await h.createAdmin();
    for (let i = 0; i < 5; i++) expect((await h.req('POST', '/api/auth/login', { username: 'owner', password: 'nope' })).status).toBe(401);
    expect((await h.req('POST', '/api/auth/login', { username: 'owner', password: 'correct-horse-battery' })).status).toBe(423);
    h.now(lk(D, '05:16'));
    expect((await h.req('POST', '/api/auth/login', { username: 'owner', password: 'correct-horse-battery' })).status).toBe(200);
    expect(h.db.rows("SELECT action FROM audit_logs WHERE action LIKE 'ADMIN_%'").map((r: any) => r.action)).toContain('ADMIN_LOCKED');
  });

  it('viewer accounts are read-only; cross-origin writes are rejected; logout ends the session', async () => {
    const { h } = await fixture();
    await h.createAdmin('auditor', 'viewer-password-123', 'viewer');
    await h.login('auditor', 'viewer-password-123');
    expect((await h.req('GET', '/api/employees')).status).toBe(200);
    expect((await h.req('POST', '/api/employees', { code: 'E9', name: 'X' })).status).toBe(403);
    await h.login();
    expect((await h.req('POST', '/api/currencies', { code: 'SGD' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await h.req('POST', '/api/currencies', { code: 'SGD' }, { origin: 'https://att.example.com' })).status).toBe(200);
    await h.req('POST', '/api/auth/logout');
    h.cookie = h.cookie || 'att_session=stale';
    expect((await h.req('GET', '/api/meta')).status).toBe(401);
  });

  it('bot tokens are encrypted at rest, never returned, and masked in the audit log', async () => {
    const { h } = await fixture();
    const row = h.db.get<any>("SELECT token_ciphertext FROM telegram_bots WHERE currency_code = 'LKR'");
    expect(row.token_ciphertext).toMatch(/^v1:/);
    expect(row.token_ciphertext).not.toContain('AAH');
    const bots = await h.req('GET', '/api/bots');
    expect(JSON.stringify(bots.json)).not.toContain('AAHxxx');
    expect(bots.json.rows.find((b: any) => b.currency === 'LKR')).toMatchObject({ status: 'ACTIVE', tokenSource: 'stored', tokenLast4: 'xxxx' });
    const audit = h.db.rows<any>("SELECT after_json FROM audit_logs WHERE action = 'BOT_WEBHOOK_SET'");
    expect(audit[0].after_json).toContain('••••');
    expect(audit[0].after_json).not.toContain('AAH');
    const setWebhook = h.tg.find((c) => c.method === 'setWebhook')!;
    expect(setWebhook.body.allowed_updates).toEqual(['message', 'edited_message']);
    expect(String(setWebhook.body.secret_token)).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it('deleting a currency in use is refused', async () => {
    const { h } = await fixture();
    expect((await h.req('DELETE', '/api/currencies/LKR')).status).toBe(409);
    expect((await h.req('DELETE', '/api/currencies/USD')).status).toBe(200);
  });
});

describe('dashboard queries', () => {
  it('filters, paging, exports and the polling version', async () => {
    const { h, e1, e2 } = await fixture();
    for (const e of [e1, e2]) await h.roster(e, D, 'A');
    await h.send({ text: 'IN', ts: lk(D, '07:30'), thread: 1001 });
    await h.send({ text: 'IN', ts: lk(D, '06:59'), thread: 1002 });
    const v1 = (await h.req('GET', '/api/version')).json.v;
    await h.send({ text: 'OUT', ts: lk(D, '15:00'), thread: 1002 });
    expect((await h.req('GET', '/api/version')).json.v).toBeGreaterThan(v1);
    const late = await h.req('GET', `/api/reports?from=${D}&to=${D}&status=WORKING`);
    expect(late.json).toMatchObject({ mode: 'detail', total: 1 });
    const q = await h.req('GET', `/api/attendance?from=${D}&to=${D}&q=kasun`);
    expect(q.json.rows.map((r: any) => r.employee_code)).toEqual(['E002']);
    const p2 = await h.req('GET', `/api/attendance?from=${D}&to=${D}&size=10&page=1&sort=lateMin&dir=-1`);
    expect(p2.json.rows[0].employee_code).toBe('E001');
    const exp = await h.req('GET', `/api/attendance/export?from=${D}&to=${D}`);
    expect(exp.json.rows).toHaveLength(2);
    const ov = await h.req('GET', `/api/overview?date=${D}`);
    expect(ov.json).toMatchObject({ totalEmployees: 2, expected: 2, late: 1, lateMin: 25, startedPresent: 2, started: 2 });
    const meta = await h.req('GET', '/api/meta');
    expect(meta.json.employees.map((e: any) => e.thread)).toEqual([1001, 1002]);
  });
});

describe('admin accounts', () => {
  it('first admin from the setup page: needs SETUP_CODE, works once, then closes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(lk(D, '05:00'));
    const h = new Harness();
    expect((await h.req('GET', '/api/auth/setup-status')).json).toEqual({ needsSetup: true, setupEnabled: false });
    expect((await h.req('POST', '/api/auth/setup', { code: 'x', username: 'owner', password: 'long-enough-pw' })).status).toBe(403);
    h.env.SETUP_CODE = 'my-setup-code';
    expect((await h.req('POST', '/api/auth/setup', { code: 'wrong', username: 'owner', password: 'long-enough-pw' })).status).toBe(401);
    const ok = await h.req('POST', '/api/auth/setup', { code: 'my-setup-code', username: 'owner', password: 'long-enough-pw' });
    expect(ok.status).toBe(200);
    expect((await h.req('GET', '/api/auth/me')).json).toMatchObject({ username: 'owner', role: 'admin' }); // signed in
    expect((await h.req('GET', '/api/auth/setup-status')).json.needsSetup).toBe(false);
    expect((await h.req('POST', '/api/auth/setup', { code: 'my-setup-code', username: 'intruder', password: 'long-enough-pw' })).status).toBe(409);
    expect(h.db.get('SELECT COUNT(*) AS n FROM admin_users')).toEqual({ n: 1 });
  });

  it('admins add, reset and disable accounts; the last admin and yourself are protected', async () => {
    const { h } = await fixture();
    expect((await h.req('POST', '/api/admins', { username: 'alice', password: 'alice-password-1', role: 'viewer' })).status).toBe(200);
    expect((await h.req('POST', '/api/admins', { username: 'alice', password: 'alice-password-1', role: 'viewer' })).status).toBe(409);
    const list = (await h.req('GET', '/api/admins')).json;
    const me = list.rows.find((r: any) => r.username === 'owner');
    const alice = list.rows.find((r: any) => r.username === 'alice');
    expect(JSON.stringify(list)).not.toContain('pbkdf2'); // hashes are never returned
    expect((await h.req('PUT', `/api/admins/${me.id}`, { role: 'viewer', isActive: true })).status).toBe(400);
    expect((await h.req('PUT', `/api/admins/${alice.id}`, { role: 'viewer', isActive: true, password: 'new-alice-pass-2' })).status).toBe(200);
    await h.login('alice', 'new-alice-pass-2');
    expect((await h.req('POST', '/api/admins', { username: 'bob', password: 'bob-password-12', role: 'admin' })).status).toBe(403);
    await h.login();
    expect((await h.req('PUT', `/api/admins/${alice.id}`, { role: 'viewer', isActive: false })).status).toBe(200);
    expect((await h.req('POST', '/api/auth/login', { username: 'alice', password: 'new-alice-pass-2' })).status).toBe(401);
    expect(h.db.rows("SELECT action FROM audit_logs WHERE action LIKE 'ADMIN_USER_%'").length).toBe(3);
  });
});

describe('migration 0003 (roster-only shifts)', () => {
  it('removes future auto-generated shifts and keeps roster shifts; editing an employee keeps shifts untouched', async () => {
    const { h, e1, e2 } = await fixture(Date.now()); // migration uses the real "today"
    const B = h.db.get<{ id: number }>("SELECT id FROM shift_templates WHERE code = 'B'")!.id;
    await h.req('PUT', `/api/employees/${e1}`, { code: 'E001', name: 'Nimal Perera', currency: 'LKR', defaultShiftId: B, timezone: 'Asia/Colombo', chatId: String(CHAT), threadId: '1001' });
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM shift_instances WHERE source = 'ASSIGNMENT'")!.n).toBe(14);
    const future = h.db.get<{ d: string }>("SELECT MAX(shift_date) AS d FROM shift_instances")!.d;
    await h.roster(e2, future, 'C');
    const { readFileSync } = await import('node:fs');
    h.db.sqlite.exec(readFileSync('migrations/0003_roster_only_shifts.sql', 'utf8'));
    expect(h.db.get('SELECT COUNT(*) AS n FROM shift_instances WHERE source = ?', 'ASSIGNMENT')).toEqual({ n: 0 });
    expect(h.db.get('SELECT shift_code FROM shift_instances WHERE employee_id = ?', e2)).toEqual({ shift_code: 'C' });
    expect(h.db.get('SELECT default_shift_id FROM employees WHERE id = ?', e1)).toEqual({ default_shift_id: null });
    // the dashboard no longer sends defaultShiftId: saving must not create assignments
    await h.req('PUT', `/api/employees/${e2}`, { code: 'E002', name: 'Kasun S', currency: 'LKR', timezone: 'Asia/Colombo', chatId: String(CHAT), threadId: '1002' });
    expect(h.db.get('SELECT COUNT(*) AS n FROM employee_shift_assignments WHERE employee_id = ?', e2)).toEqual({ n: 0 });
    expect((await h.req('POST', '/api/employees', { code: 'Test 1', name: 'x', timezone: 'Asia/Colombo' })).json.message.zh).toMatch(/不能有空格/);
  });
});

describe('chat id input', () => {
  it('a group id copied from a message link (without -100) is normalised', async () => {
    const { h } = await fixture();
    const r = await h.req('POST', '/api/employees', { code: 'T3', name: 'Test 3', currency: 'LKR', timezone: 'Asia/Colombo', chatId: '2233445566', threadId: '28' });
    expect(r.status).toBe(200);
    expect(h.db.get('SELECT chat_id FROM telegram_topic_mappings WHERE message_thread_id = 28')).toEqual({ chat_id: CHAT });
    expect((await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 28 })).json.status).toBe('PROCESSED');
  });
});

describe('bot shared with another system (one webhook per bot at Telegram)', () => {
  const TBC = 'https://tbc-csteam.pages.dev/api/telegram-webhook/lkr';
  const BOT = '700000001'; // LKR bot of the fixture
  const tbcTakesBot = (h: Harness) => h.webhooks.set(BOT, TBC);
  const deletes = (h: Harness) => h.tg.filter((t) => t.method === 'deleteWebhook').length;

  it('clean leaves another system\'s webhook untouched', async () => {
    const { h } = await fixture();
    tbcTakesBot(h);
    const r = await h.req('POST', '/api/bots/LKR/clean');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ webhook: 'other', url: TBC, webhookRemoved: false });
    expect(h.webhooks.get(BOT)).toBe(TBC);
    expect(deletes(h)).toBe(0);
    expect(h.db.get("SELECT status FROM telegram_bots WHERE currency_code = 'LKR'")).toEqual({ status: 'NOT_SET' });
  });

  it('clean removes the webhook when it points at oc-attendance', async () => {
    const { h } = await fixture();
    const r = await h.req('POST', '/api/bots/LKR/clean');
    expect(r.json).toMatchObject({ webhook: 'removed', webhookRemoved: true });
    expect(h.webhooks.has(BOT)).toBe(false);
  });

  it('clean stops (keeps the token) when Telegram cannot be reached, unless forced', async () => {
    const { h } = await fixture();
    h.failing.add('getWebhookInfo');
    const r = await h.req('POST', '/api/bots/LKR/clean', {});
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('TELEGRAM_UNREACHABLE');
    expect(h.db.get("SELECT status FROM telegram_bots WHERE currency_code = 'LKR'")).toEqual({ status: 'ACTIVE' });
    const f = await h.req('POST', '/api/bots/LKR/clean', { force: true });
    expect(f.status).toBe(200);
    expect(f.json.webhook).toBe('unreachable');
  });

  it('stop leaves another system\'s webhook untouched', async () => {
    const { h } = await fixture();
    tbcTakesBot(h);
    const r = await h.req('POST', '/api/bots/LKR/stop');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ webhook: 'other', url: TBC });
    expect(h.webhooks.get(BOT)).toBe(TBC);
    expect(h.db.get("SELECT status FROM telegram_bots WHERE currency_code = 'LKR'")).toEqual({ status: 'DISABLED' });
  });

  it('start and rotate refuse to take the bot back from another system', async () => {
    const { h } = await fixture();
    await h.req('POST', '/api/bots/LKR/stop');
    tbcTakesBot(h);
    const s = await h.req('POST', '/api/bots/LKR/start');
    expect(s.status).toBe(409);
    expect(s.json.error).toBe('BOT_IN_USE');
    expect((await h.req('POST', '/api/bots/LKR/rotate')).status).toBe(409);
    expect(h.webhooks.get(BOT)).toBe(TBC);
  });

  it('saving a bot that belongs to another system needs explicit confirmation', async () => {
    const { h } = await fixture();
    h.webhooks.set('700000005', TBC);
    const body = { token: `700000005:AAH${'y'.repeat(32)}`, webhookUrl: 'https://att.example.com/api/telegram/webhook/usd' };
    const r = await h.req('PUT', '/api/bots/USD', body);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: 'BOT_IN_USE', url: TBC });
    expect(h.webhooks.get('700000005')).toBe(TBC);
    expect(h.db.get("SELECT status FROM telegram_bots WHERE currency_code = 'USD'")).toEqual({ status: 'NOT_SET' });
    const f = await h.req('PUT', '/api/bots/USD', { ...body, force: true });
    expect(f.status).toBe(200);
    expect(h.webhooks.get('700000005')).toBe(body.webhookUrl);
  });

  it('deleting a currency never removes another system\'s webhook', async () => {
    const { h } = await fixture();
    await h.setupBot('USD', 700000006);
    h.webhooks.set('700000006', TBC);
    expect((await h.req('DELETE', '/api/currencies/USD')).status).toBe(200);
    expect(h.webhooks.get('700000006')).toBe(TBC);
  });
});

describe('one bot for several currencies', () => {
  const TOK = `700000001:AAH${'x'.repeat(32)}`; // the fixture's LKR bot
  const save = (h: Harness, code: string, tok = TOK) => h.req('PUT', `/api/bots/${code}`, { token: tok, webhookUrl: `https://att.example.com/api/telegram/webhook/${code.toLowerCase()}` });
  const row = (h: Harness, code: string) => h.db.get<Record<string, any>>('SELECT status, tg_bot_id, webhook_url, tg_url FROM telegram_bots WHERE currency_code = ?', code)!;
  const sets = (h: Harness) => h.tg.filter((t) => t.method === 'setWebhook').length;

  it('a bot set up under one currency also records employees of currencies that have no bot of their own', async () => {
    const { h } = await fixture(); // only the LKR bot is set up
    const m = await h.employee('M001', 'Myr Person', 1101, 'MYR');
    await h.roster(m, D, 'A');
    expect((await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1101, code: 'LKR' })).json.status).toBe('PROCESSED');
  });

  it('every currency can save the same bot; nothing is reconnected at Telegram', async () => {
    const { h } = await fixture();
    const before = sets(h);
    expect((await save(h, 'MYR')).status).toBe(200);
    expect((await save(h, 'USD')).status).toBe(200);
    expect(sets(h)).toBe(before); // already connected to oc-attendance: no setWebhook
    expect(row(h, 'MYR')).toMatchObject({ status: 'ACTIVE', tg_bot_id: 700000001 });
    expect(h.webhooks.get('700000001')).toContain('/webhook/lkr');
    const list = (await h.req('GET', '/api/bots')).json.rows;
    expect(new Set(list.map((x: any) => x.username))).toEqual(new Set(['att_700000001_bot']));
    expect(new Set(list.map((x: any) => x.webhookUrl)).size).toBe(1);
    const m = await h.employee('M002', 'Myr Two', 1102, 'MYR');
    await h.roster(m, D, 'A');
    expect((await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1102 })).json.status).toBe('PROCESSED');
    expect((await h.req('POST', '/api/bots/MYR/check')).json.lastError).toBeNull();
  });

  it('each currency is stopped and started on its own', async () => {
    const { h, e1 } = await fixture();
    await save(h, 'MYR');
    const m = await h.employee('M003', 'Myr Three', 1104, 'MYR');
    for (const e of [e1, m]) await h.roster(e, D, 'A');
    expect((await h.req('POST', '/api/bots/MYR/stop')).json.webhook).toBe('kept');
    expect((await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1104 })).json.status).toBe('IGNORED_CURRENCY_STOPPED');
    expect((await h.send({ text: 'IN', ts: lk(D, '07:01'), thread: 1001 })).json.status).toBe('PROCESSED'); // LKR unaffected
    expect((await h.req('POST', '/api/bots/MYR/start')).status).toBe(200);
    expect((await h.req('POST', '/api/bots/LKR/stop')).json.webhook).toBe('kept'); // MYR still runs on it
    expect((await h.send({ text: 'IN', ts: lk(D, '07:02'), thread: 1104 })).json.status).toBe('PROCESSED');
    expect((await h.send({ text: 'OUT', ts: lk(D, '15:00'), thread: 1001 })).json.status).toBe('IGNORED_CURRENCY_STOPPED');
    expect((await h.req('POST', '/api/bots/MYR/stop')).json.webhook).toBe('removed'); // nobody runs on it any more
    expect(h.webhooks.has('700000001')).toBe(false);
    expect((await h.req('POST', '/api/bots/MYR/start')).status).toBe(200); // explicit admin action reconnects
    expect((await h.send({ text: 'OUT', ts: lk(D, '15:01'), thread: 1104, code: 'MYR' })).json.status).toBe('PROCESSED');
  });

  it('switching or cleaning one currency never touches the others and never reconnects the old bot', async () => {
    const { h } = await fixture();
    await save(h, 'MYR');
    await save(h, 'USD');
    const m = await h.employee('M004', 'Myr Four', 1105, 'MYR');
    const u = await h.employee('U004', 'Usd Four', 1106, 'USD');
    for (const e of [m, u]) await h.roster(e, D, 'A');
    // LKR moves to a new bot: the old bot stays as it is (still used by MYR and USD), nothing re-registered for it
    const before = sets(h);
    expect((await save(h, 'LKR', `700000008:AAH${'q'.repeat(32)}`)).json.oldBot).toBe('kept');
    expect(sets(h)).toBe(before + 1); // only the NEW bot was connected
    expect(h.webhooks.get('700000001')).toContain('/webhook/lkr'); // old bot untouched
    expect((await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1105, secret: await h.secretFor('MYR') })).json.status).toBe('PROCESSED');
    // MYR is cleaned: USD keeps working, Telegram not touched
    expect((await h.req('POST', '/api/bots/MYR/clean')).json.webhook).toBe('kept');
    expect(h.webhooks.get('700000001')).toContain('/webhook/lkr');
    expect((await h.send({ text: 'IN', ts: lk(D, '07:01'), thread: 1106, secret: await h.secretFor('USD') })).json.status).toBe('PROCESSED');
    // the last currency using the old bot is cleaned: only now it is disconnected (it pointed at oc-attendance)
    expect((await h.req('POST', '/api/bots/USD/clean')).json.webhook).toBe('removed');
    expect(h.webhooks.has('700000001')).toBe(false);
    expect(h.webhooks.get('700000008')).toContain('/webhook/lkr'); // LKR's new bot unaffected
  });
});

describe('roster hides deactivated employees', () => {
  it('a deactivated employee disappears from the roster and its export, but keeps attendance history', async () => {
    const { h, e1, e2 } = await fixture();
    await h.roster(e1, D, 'A');
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    const before = await h.req('GET', `/api/roster?from=${D}&to=${D}`);
    expect(before.json.employees.map((e: any) => e.employee_code)).toEqual(['E001', 'E002']);
    expect((await h.req('POST', `/api/employees/${e1}/deactivate`, { reason: 'Resigned' })).status).toBe(200);
    const after = await h.req('GET', `/api/roster?from=${D}&to=${D}`);
    expect(after.json.total).toBe(1);
    expect(after.json.employees.map((e: any) => e.id)).toEqual([e2]);
    expect((await h.req('GET', `/api/roster/export?from=${D}&to=${D}`)).json.employees.map((e: any) => e.id)).toEqual([e2]);
    expect((await h.session(e1, D))!.actual_in_at).toBe(lk(D, '07:00'));
  });
});

describe('roster OT tag', () => {
  it('worked on a day off, or on shift longer than the OT threshold → listed as OT', async () => {
    const { h, e1, e2 } = await fixture();
    await h.roster(e1, D, 'A'); // A = 07:00–15:00
    await h.send({ text: 'IN', ts: lk(D, '05:00'), thread: 1001 });
    await h.send({ text: 'OUT', ts: lk(D, '15:30'), thread: 1001 }); // 10h30m on shift
    await h.send({ text: 'IN', ts: lk(D, '09:00'), thread: 1002 }); // E002 has no shift: day off
    // no clock out yet (or forgot to clock out) → not OT
    expect((await h.req('GET', `/api/roster?from=${D}&to=${D}`)).json.ot.map((o: any) => [o.employee_id, o.kind])).toEqual([[e1, 'LONG']]);
    await h.send({ text: 'OUT', ts: lk(D, '13:00'), thread: 1002 });
    const r = await h.req('GET', `/api/roster?from=${D}&to=${D}`);
    const ot = r.json.ot.map((o: any) => [o.employee_id, o.kind]).sort();
    expect(ot).toEqual([[e1, 'LONG'], [e2, 'OFF']].sort());
    await h.req('PUT', '/api/settings/rules', { windowHours: 4, lateAsException: false, botReply: true, otHours: 11 });
    expect((await h.req('GET', `/api/roster?from=${D}&to=${D}`)).json.ot.map((o: any) => o.employee_id)).toEqual([e2]);
  });
});

describe('shift matching window in minutes', () => {
  it('accepts a 30-minute window and keeps the chosen unit', async () => {
    const { h } = await fixture();
    expect((await h.req('PUT', '/api/settings/rules', { windowHours: 0.5, windowUnit: 'm', lateAsException: false, botReply: true })).status).toBe(200);
    const m = await h.req('GET', '/api/meta');
    expect(m.json.rules).toMatchObject({ windowHours: 0.5, windowUnit: 'm' });
    expect((await h.req('PUT', '/api/settings/rules', { windowHours: 0.51, lateAsException: false, botReply: true })).status).toBe(400);
    expect((await h.req('PUT', '/api/settings/rules', { windowHours: 9, lateAsException: false, botReply: true })).status).toBe(400);
  });
});

describe('daily break allowance (Attendance rules)', () => {
  it('one setting for every shift; empty = no limit', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    await h.send({ text: 'BREAK', ts: lk(D, '10:00'), thread: 1001 });
    await h.send({ text: 'RESUME', ts: lk(D, '11:00'), thread: 1001 }); // 60 min
    const ex = async () => (await h.session(e1, D))!.break_exceeded;
    expect(await ex()).toBe(0); // default 90 min
    await h.req('PUT', '/api/settings/rules', { windowHours: 4, lateAsException: false, botReply: true, breakMinutes: 30 });
    await h.cron(lk(D, '12:00'));
    expect(await ex()).toBe(1);
    await h.req('PUT', '/api/settings/rules', { windowHours: 4, lateAsException: false, botReply: true, breakMinutes: null });
    await h.cron(lk(D, '12:00'));
    expect(await ex()).toBeNull();
  });
});

describe('rules and roster per currency', () => {
  it('each currency has its own rules; saving one currency does not touch another', async () => {
    const { h, e1 } = await fixture();
    await h.req('POST', '/api/currencies', { code: 'PHP' });
    await h.roster(e1, D, 'A');
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    await h.send({ text: 'BREAK', ts: lk(D, '10:00'), thread: 1001 });
    await h.send({ text: 'RESUME', ts: lk(D, '11:00'), thread: 1001 }); // 60 min
    const ex = async () => (await h.session(e1, D))!.break_exceeded;
    const base = { windowHours: 4, lateAsException: false, botReply: true };
    expect((await h.req('PUT', '/api/settings/rules', { ...base, currency: 'PHP', breakMinutes: 30 })).status).toBe(200);
    await h.cron(lk(D, '12:00'));
    expect(await ex()).toBe(0); // LKR still 90 min
    await h.req('PUT', '/api/settings/rules', { ...base, currency: 'LKR', breakMinutes: 45, otHours: 10 });
    await h.cron(lk(D, '12:01'));
    expect(await ex()).toBe(1);
    const m = (await h.req('GET', '/api/meta')).json;
    expect(m.rulesCur.PHP).toMatchObject({ breakMinutes: 30 });
    expect(m.rulesCur.LKR).toMatchObject({ breakMinutes: 45, otHours: 10 });
    expect((await h.req('PUT', '/api/settings/rules', { ...base, currency: 'XXX' })).status).toBe(404);
  });

  it('roster counts, import into one currency skips other currencies, history follows the currency', async () => {
    const { h, e1 } = await fixture();
    await h.req('POST', '/api/currencies', { code: 'PHP' });
    await h.employee('P001', 'Maria', null, 'PHP');
    const r = await h.req('GET', `/api/roster?from=${D}&to=${D}&cur=PHP`);
    expect(r.json.counts).toMatchObject({ LKR: 2, PHP: 1 });
    expect(r.json.employees.map((e: any) => e.employee_code)).toEqual(['P001']);
    const grid = [['PSD ID', '2026-10-21'], ['E001', 'A'], ['P001', 'B']];
    const plan = (await h.req('POST', '/api/roster/import', { grid, fileName: 'lkr.csv', currency: 'LKR' })).json.plan;
    expect(plan).toMatchObject({ changeCount: 1, skipped: 1 });
    await h.req('POST', '/api/roster/import', { grid, fileName: 'lkr.csv', currency: 'LKR', apply: true, reason: 'LKR week' });
    expect(h.db.get<any>("SELECT COUNT(*) AS n FROM shift_instances WHERE shift_date = '2026-10-21'").n).toBe(1);
    await h.roster(e1, '2026-10-22', 'A');
    const lkr = (await h.req('GET', '/api/roster/history-log?cur=LKR')).json;
    const php = (await h.req('GET', '/api/roster/history-log?cur=PHP')).json;
    expect(lkr.total).toBe(2); // the LKR import + E001's change
    expect(php.total).toBe(0);
  });
});

describe('employee import / export', () => {
  it('exports, then imports new employees, updates and topic moves; bad rows are skipped', async () => {
    const { h } = await fixture();
    await h.req('POST', '/api/currencies', { code: 'PHP' });
    const ex = (await h.req('GET', '/api/export/employees?status=ACTIVE')).json.rows;
    expect(ex.map((r: any) => [r.employee_code, r.message_thread_id])).toEqual([['E001', 1001], ['E002', 1002]]);
    const grid = [
      ['PSD ID', 'Employee Name', 'Currency', 'Chat ID', 'Thread ID', 'Status'],
      ['E001', 'Nimal P.', '', '', '', 'ACTIVE'],                 // rename only; topic kept
      ['E002', 'Kasun Silva', 'PHP', String(CHAT), '1001', ''],   // takes E001's topic → E001 still holds it → error
      ['N100', 'New Person', 'PHP', String(CHAT).replace('-100', ''), '#2001', ''], // link form chat id
      ['N101', 'No Currency', '', '', '', ''],
      ['bad id', 'X', 'PHP', '', '', ''],
    ];
    const plan = (await h.req('POST', '/api/employees/import', { grid, fileName: 'emp.xlsx' })).json.plan;
    expect(plan).toMatchObject({ newCount: 1, updateCount: 1, unchanged: 0, errorCount: 3 });
    const r = await h.req('POST', '/api/employees/import', { grid, fileName: 'emp.xlsx', apply: true });
    expect(r.json.applied).toEqual({ added: 1, updated: 1 });
    const e1 = h.db.get<any>("SELECT e.name, m.message_thread_id AS t FROM employees e JOIN telegram_topic_mappings m ON m.employee_id = e.id AND m.is_active = 1 WHERE e.employee_code = 'E001'");
    expect(e1).toMatchObject({ name: 'Nimal P.', t: 1001 });
    const n = h.db.get<any>("SELECT e.currency_code, m.chat_id, m.message_thread_id AS t FROM employees e JOIN telegram_topic_mappings m ON m.employee_id = e.id AND m.is_active = 1 WHERE e.employee_code = 'N100'");
    expect(n).toMatchObject({ currency_code: 'PHP', chat_id: CHAT, t: 2001 });
    // swap topics inside one file
    const swap = [['PSD ID', 'Employee Name', 'Chat ID', 'Thread ID'], ['E001', 'Nimal P.', String(CHAT), '1002'], ['E002', 'Kasun Silva', String(CHAT), '1001']];
    expect((await h.req('POST', '/api/employees/import', { grid: swap, apply: true })).json.applied).toEqual({ added: 0, updated: 2 });
    const t = (c: string) => h.db.get<any>(`SELECT m.message_thread_id AS t FROM employees e JOIN telegram_topic_mappings m ON m.employee_id = e.id AND m.is_active = 1 WHERE e.employee_code = '${c}'`).t;
    expect([t('E001'), t('E002')]).toEqual([1002, 1001]);
  });
});

describe('disable / active / delete employee', () => {
  it('active brings the employee and their old topic back', async () => {
    const { h, e1 } = await fixture();
    await h.req('POST', `/api/employees/${e1}/deactivate`, { reason: 'Leave' });
    const r = await h.req('POST', `/api/employees/${e1}/activate`, {});
    expect(r.json).toMatchObject({ ok: true, topic: 1001 });
    expect(h.db.get<any>('SELECT employment_status FROM employees WHERE id = ?', e1).employment_status).toBe('ACTIVE');
    expect((await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 })).status).toBe(200);
    expect(h.db.get<any>('SELECT COUNT(*) AS n FROM attendance_events WHERE employee_id = ?', e1).n).toBe(1);
    expect((await h.req('POST', `/api/employees/${e1}/activate`, {})).status).toBe(409);
  });

  it('delete removes the employee and all their data, keeps only the audit log; other employees untouched', async () => {
    const { h, e1, e2 } = await fixture();
    await h.roster(e1, D, 'A');
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    await h.send({ text: 'OUT', ts: lk(D, '15:00'), thread: 1001 });
    await h.send({ text: 'hello clock', ts: lk(D, '15:01'), thread: 1001 });
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1002 });
    const evId = h.db.get<any>("SELECT id FROM attendance_events WHERE employee_id = ? AND event_type = 'CLOCK_OUT'", e1).id;
    await h.req('POST', `/api/sessions/${e1}/${D}/adjustments`, { action: 'VOID_EVENT', targetEventId: evId, reason: 'Sent OUT by mistake' });
    expect((await h.req('POST', `/api/employees/${e1}/delete`, { confirm: 'E002' })).status).toBe(400);
    expect((await h.req('POST', `/api/employees/${e1}/delete`, { confirm: 'E001' })).status).toBe(200);
    const cnt = (sql: string, ...p: unknown[]) => h.db.get<any>(sql, ...p).n;
    for (const tbl of ['attendance_events', 'attendance_adjustments', 'attendance_sessions', 'shift_instances', 'telegram_topic_mappings', 'attendance_exceptions', 'telegram_messages'])
      expect(cnt(`SELECT COUNT(*) AS n FROM ${tbl} WHERE employee_id = ?`, e1)).toBe(0);
    expect(cnt('SELECT COUNT(*) AS n FROM telegram_messages WHERE message_thread_id = 1001')).toBe(0);
    expect(cnt('SELECT COUNT(*) AS n FROM employees WHERE id = ?', e1)).toBe(0);
    expect(cnt('SELECT COUNT(*) AS n FROM attendance_events WHERE employee_id = ?', e2)).toBe(1);
    expect(cnt("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EMPLOYEE_DELETED' AND entity_id = 'E001'")).toBe(1);
    expect(cnt("SELECT COUNT(*) AS n FROM system_settings WHERE key = 'purge_employee'")).toBe(0);
    // raw data of other employees is still append-only
    expect(() => h.db.x('DELETE FROM attendance_events WHERE employee_id = ?', e2)).toThrow();
  });
});

describe('roster codes', () => {
  it('admin-defined codes: add, use on the roster and in imports, rename, delete only when unused', async () => {
    const { h, e1 } = await fixture();
    expect((await h.req('GET', '/api/meta')).json.rosterCodes).toEqual([{ code: 'OFF', name: 'Day off', color: 0 }]);
    expect((await h.req('POST', '/api/roster-codes', { code: 'vl', name: 'Vacation Leave', color: 6 })).status).toBe(200);
    expect((await h.req('POST', '/api/roster-codes', { code: 'VL', name: 'Dup', color: 1 })).status).toBe(409);
    expect((await h.req('POST', '/api/roster-codes', { code: 'A', name: 'Clash with shift A', color: 1 })).status).toBe(400);
    // a shift day becomes a leave day: the shift is cancelled and the code is stored
    await h.roster(e1, D2, 'A');
    expect((await h.req('PUT', '/api/roster/cell', { employeeId: e1, date: D2, value: 'VL', reason: 'Annual leave' })).status).toBe(200);
    expect(h.db.get<any>("SELECT adjustment_status FROM shift_instances WHERE employee_id = ? AND shift_date = ?", e1, D2).adjustment_status).toBe('CANCELLED');
    expect(h.db.get<any>('SELECT code FROM roster_marks WHERE employee_id = ? AND mark_date = ?', e1, D2).code).toBe('VL');
    expect((await h.req('PUT', '/api/roster/cell', { employeeId: e1, date: D2, value: 'XX', reason: 'Unknown code' })).status).toBe(400);
    // import: codes, "-" clears, unknown code is an error
    const grid = [['PSD ID', '2026-10-25', '2026-10-26', D2], ['E001', 'VL', 'ZZ', '-']];
    const plan = (await h.req('POST', '/api/roster/import', { grid, fileName: 'r.csv' })).json.plan;
    expect(plan).toMatchObject({ changeCount: 2, errorCount: 1 });
    await h.req('POST', '/api/roster/import', { grid, fileName: 'r.csv', apply: true, reason: 'Leave plan' });
    expect(h.db.rows<any>('SELECT mark_date, code FROM roster_marks WHERE employee_id = ? ORDER BY mark_date', e1)).toEqual([{ mark_date: '2026-10-25', code: 'VL' }]);
    // rename follows onto the roster; delete is refused while used
    expect((await h.req('PUT', '/api/roster-codes/VL', { code: 'AL', name: 'Annual Leave', color: 6 })).status).toBe(200);
    expect(h.db.get<any>('SELECT code FROM roster_marks WHERE employee_id = ?', e1).code).toBe('AL');
    expect((await h.req('DELETE', '/api/roster-codes/AL')).status).toBe(409);
    await h.req('PUT', '/api/roster/cell', { employeeId: e1, date: '2026-10-25', value: '', reason: 'Leave cancelled' });
    expect((await h.req('DELETE', '/api/roster-codes/AL')).status).toBe(200);
    expect((await h.req('DELETE', '/api/roster-codes/OFF')).status).toBe(200); // OFF is not fixed
    expect((await h.req('GET', '/api/meta')).json.rosterCodes).toEqual([]);
  });
});

describe('telegram history import', () => {
  it('reads a Telegram Desktop export: topics via reply chains, punches at Telegram time, skips what the bot already has', async () => {
    const { h, e1, e2 } = await fixture();
    await h.roster(e1, D, 'A'); // 07:00–15:00
    // the bot already received one message (id 9005)
    await h.send({ text: 'OUT', ts: lk(D, '15:02'), thread: 1001, messageId: 9005 });
    const t = (hhmm: string) => String(lk(D, hhmm) / 1000);
    const exp = { name: 'Team', type: 'private_supergroup', id: Number(String(CHAT).replace('-100', '')), messages: [
      { id: 9001, type: 'message', date_unixtime: t('06:58'), reply_to_message_id: 1001, text: [{ type: 'bold', text: 'Clocked In !' }, '\n', { type: 'bold', text: 'Agent: Nimal' }] },
      { id: 9002, type: 'message', date_unixtime: t('10:00'), reply_to_message_id: 1001, text: 'short break' },
      { id: 9003, type: 'message', date_unixtime: t('10:15'), reply_to_message_id: 9002, text: 'RESUME' }, // reply inside the topic
      { id: 9004, type: 'message', date_unixtime: t('11:00'), reply_to_message_id: 1002, text: 'RESUME 10:25' }, // typed time → unclear
      { id: 9005, type: 'message', date_unixtime: t('15:02'), reply_to_message_id: 1001, text: 'OUT' },
      { id: 9006, type: 'message', date_unixtime: t('12:00'), reply_to_message_id: 5555, text: 'IN' }, // topic nobody is bound to
      { id: 9007, type: 'message', date_unixtime: t('12:01'), reply_to_message_id: 1002, text: 'good morning team' },
      { id: 9008, type: 'service', date_unixtime: t('12:02'), action: 'pin_message' },
    ] };
    const { readTelegramExport } = await import('../src/shared/tgexport');
    const x = readTelegramExport(exp);
    expect(x.chatId).toBe(CHAT);
    const body = { chatId: x.chatId, fileName: 'result.json', messages: x.messages };
    const plan = (await h.req('POST', '/api/telegram-import', body)).json.plan;
    expect(plan).toMatchObject({ toAdd: 3, already: 1, unclear: 1, noTopic: 1, notPunch: 1 });
    expect((await h.req('POST', '/api/telegram-import', { ...body, apply: true, reason: '' })).status).toBe(400);
    const r = await h.req('POST', '/api/telegram-import', { ...body, apply: true, reason: 'Before the bot joined' });
    expect(r.json.applied.added).toBe(3);
    const s = (await h.session(e1, D))!;
    expect(s.actual_in_at).toBe(lk(D, '06:58'));
    expect(s.actual_out_at).toBe(lk(D, '15:02'));
    expect(s.break_count).toBe(1);
    expect(h.db.get<any>("SELECT COUNT(*) AS n FROM telegram_messages WHERE source = 'IMPORT'").n).toBe(3);
    expect(h.db.get<any>("SELECT COUNT(*) AS n FROM attendance_exceptions WHERE code = 'DELAYED_DELIVERY'").n).toBe(0); // imported ≠ delivered late
    // importing the same file again adds nothing
    expect((await h.req('POST', '/api/telegram-import', body)).json.plan).toMatchObject({ toAdd: 0, already: 4 });
    expect(h.db.get<any>('SELECT COUNT(*) AS n FROM attendance_events WHERE employee_id = ?', e2).n).toBe(0);
  });
});

describe('employee order follows the uploaded file', () => {
  it('roster and employee imports keep the file row order; new employees go last', async () => {
    const { h } = await fixture();
    await h.employee('E003', 'Aaron', 1003);
    const order = async () => (await h.req('GET', `/api/roster?from=${D}&to=${D}`)).json.employees.map((e: any) => e.employee_code);
    await h.req('POST', '/api/roster/import', { grid: [['PSD ID', D], ['E003', 'A'], ['E001', 'B'], ['E002', 'C']], fileName: 'r.xlsx', apply: true, reason: 'October roster' });
    expect(await order()).toEqual(['E003', 'E001', 'E002']);
    await h.req('POST', '/api/employees/import', { grid: [['PSD ID', 'Employee Name'], ['E002', 'Kasun Silva'], ['E003', 'Aaron'], ['E001', 'Nimal Perera']], apply: true });
    expect((await h.req('GET', '/api/employees?status=ACTIVE')).json.rows.map((e: any) => e.employee_code)).toEqual(['E002', 'E003', 'E001']);
    await h.employee('A000', 'Zed', 1004);
    expect(await order()).toEqual(['E002', 'E003', 'E001', 'A000']);
  });
});

describe('roster history', () => {
  it('lists manual shift changes and one row per roster import, with who, when and why', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, '2026-10-20', 'A', 'Cover for sick colleague');
    await h.req('POST', '/api/roster/import', { grid: [['PSD ID', '2026-10-21'], ['E002', 'C']], fileName: 'r.csv', apply: true, reason: 'Weekly roster' });
    const r = await h.req('GET', '/api/roster/history-log');
    expect(r.json.total).toBe(2); // the import's per-cell entry is not listed separately
    const [imp, man] = r.json.rows;
    expect(imp).toMatchObject({ action: 'ROSTER_IMPORTED', entity_id: 'r.csv', actor: 'owner', note: 'Weekly roster' });
    expect(JSON.parse(imp.after_json)).toMatchObject({ added: 1 });
    expect(man).toMatchObject({ action: 'SHIFT_INSTANCE_ADJUSTED', employee_code: 'E001', note: 'Cover for sick colleague', entity_id: 'E001@2026-10-20' });
    expect((await h.req('GET', '/api/roster/history-log?q=nimal')).json.total).toBe(1);
    // custom date range = the day the change was made (Sri Lanka time); a reversed range is accepted
    expect((await h.req('GET', '/api/roster/history-log?from=2026-10-15&to=2026-10-15')).json.total).toBe(2);
    expect((await h.req('GET', '/api/roster/history-log?from=2026-10-16&to=2026-10-31')).json.total).toBe(0);
    expect((await h.req('GET', '/api/roster/history-log?from=2026-10-15&to=2026-10-01')).json.total).toBe(2);
  });
});

describe('currency access (owner / limited admin)', () => {
  async function scoped() {
    const { h, e1, e2 } = await fixture();
    await h.req('POST', '/api/currencies', { code: 'PKR' });
    const p1 = await h.employee('P001', 'Ahad Ali', 2001, 'PKR');
    await h.roster(p1, '2026-10-15', 'B');
    await h.roster(e1, '2026-10-15', 'B');
    expect((await h.req('POST', '/api/admins', { username: 'pkr', password: 'pkr-password-12', role: 'admin', currencies: ['PKR'] })).status).toBe(200);
    await h.login('pkr', 'pkr-password-12');
    return { h, e1, e2, p1 };
  }

  it('a PKR-only account sees and changes only PKR data on every page', async () => {
    const { h, e1, p1 } = await scoped();
    const me = (await h.req('GET', '/api/auth/me')).json;
    expect(me).toMatchObject({ currencies: ['PKR'], owner: false });
    const meta = (await h.req('GET', '/api/meta')).json;
    expect(meta.currencies.map((c: any) => c.code)).toEqual(['PKR']);
    expect(meta.employees.map((e: any) => e.code)).toEqual(['P001']);
    expect(Object.keys(meta.rulesCur)).toEqual(['PKR']);
    const R = 'from=2026-10-01&to=2026-10-31';
    expect((await h.req('GET', `/api/employees`)).json.rows.map((r: any) => r.employee_code)).toEqual(['P001']);
    expect((await h.req('GET', `/api/roster?${R}`)).json.employees.map((r: any) => r.employee_code)).toEqual(['P001']);
    expect((await h.req('GET', `/api/roster?${R}`)).json.counts).toEqual({ PKR: 1 });
    expect((await h.req('GET', `/api/roster/export?${R}`)).json.employees.length).toBe(1);
    for (const path of ['/api/attendance', '/api/reports', '/api/breaks', '/api/attendance/export']) {
      const r = await h.req('GET', `${path}?${R}`);
      expect(r.status, path).toBe(200);
      expect(JSON.stringify(r.json), path).not.toContain('E001');
    }
    // asking for another currency, or another currency's employee, is refused
    expect((await h.req('GET', `/api/attendance?${R}&cur=LKR`)).status).toBe(403);
    expect((await h.req('GET', `/api/roster?${R}&cur=LKR`)).status).toBe(403);
    expect((await h.req('GET', `/api/employees/${e1}`)).status).toBe(403);
    expect((await h.req('GET', `/api/sessions/${e1}/2026-10-15`)).status).toBe(403);
    expect((await h.req('PUT', '/api/roster/cell', { employeeId: e1, date: '2026-10-16', value: 'OFF', reason: 'not mine' })).status).toBe(403);
    expect((await h.req('POST', `/api/employees/${e1}/deactivate`, { reason: 'not mine at all' })).status).toBe(403);
    expect((await h.req('POST', '/api/employees', { code: 'L009', name: 'X', currency: 'LKR', timezone: 'Asia/Colombo', chatId: String(CHAT), threadId: '' })).status).toBe(403);
    // own currency works
    expect((await h.req('PUT', '/api/roster/cell', { employeeId: p1, date: '2026-10-16', value: 'OFF', reason: 'day off' })).status).toBe(200);
    expect((await h.req('GET', `/api/sessions/${p1}/2026-10-15`)).status).toBe(200);
    // settings: only its own currency's attendance rules
    expect((await h.req('PUT', '/api/settings/rules', { lateAsException: true, botReply: false, windowHours: 6, currency: 'PKR' })).status).toBe(200);
    expect((await h.req('PUT', '/api/settings/rules', { lateAsException: true, botReply: false, windowHours: 6, currency: 'LKR' })).status).toBe(403);
    expect((await h.req('PUT', '/api/settings/rules', { lateAsException: true, botReply: false, windowHours: 6 })).status).toBe(403);
    expect((await h.req('PUT', '/api/settings/keywords', TEST_KEYWORDS)).status).toBe(403);
    expect((await h.req('GET', '/api/bots')).status).toBe(403);
    expect((await h.req('GET', '/api/admins')).status).toBe(403);
    expect((await h.req('POST', '/api/currencies', { code: 'INR' })).status).toBe(403);
    // roster import: rows of other currencies are skipped
    const imp = (await h.req('POST', '/api/roster/import', { grid: [['PSD ID', '2026-10-20'], ['E001', 'B'], ['P001', 'B']] })).json.plan;
    expect(imp.changeCount).toBe(1);
    expect(imp.changes[0].code).toBe('P001');
  });

  it('a limited account sees only the audit lines and messages of its currency', async () => {
    const { h, e1 } = await scoped();
    await h.send({ text: 'IN', ts: lk('2026-10-15', '09:00'), thread: 1001 });
    await h.send({ text: 'IN', ts: lk('2026-10-15', '09:01'), thread: 2001 });
    const audit = (await h.req('GET', '/api/audit?size=100')).json;
    const ids = audit.rows.map((r: any) => String(r.entity_id));
    expect(ids).toContain('P001@2026-10-15');
    expect(ids).toContain('P001');
    expect(ids.some((x: string) => x.startsWith('E00'))).toBe(false);
    expect(ids).not.toContain('LKR');
    expect(audit.total).toBe(audit.rows.length);
    const msgs = (await h.req('GET', '/api/messages')).json;
    expect(msgs.rows.map((m: any) => m.message_thread_id)).toEqual([2001]);
    expect(JSON.stringify((await h.req('GET', '/api/exceptions?size=100')).json)).not.toContain('E001');
    await h.login();
    expect((await h.req('GET', '/api/audit?size=100')).json.rows.some((r: any) => String(r.entity_id).startsWith('E001'))).toBe(true);
    expect((await h.req('GET', `/api/employees/${e1}`)).status).toBe(200);
  });

  it('the owner cannot be limited or disabled; only the owner manages accounts', async () => {
    const { h } = await scoped();
    await h.login();
    const list = (await h.req('GET', '/api/admins')).json.rows;
    const owner = list.find((r: any) => r.username === 'owner');
    expect(owner.is_owner).toBe(1);
    expect(list.find((r: any) => r.username === 'pkr').currencies).toEqual(['PKR']);
    expect((await h.req('PUT', `/api/admins/${owner.id}`, { role: 'admin', isActive: true, currencies: ['PKR'] })).status).toBe(400);
    const pkr = list.find((r: any) => r.username === 'pkr');
    // widening access signs the account out so the new access applies at once
    expect((await h.req('PUT', `/api/admins/${pkr.id}`, { role: 'admin', isActive: true, currencies: null })).status).toBe(200);
    await h.login('pkr', 'pkr-password-12');
    expect((await h.req('GET', '/api/meta')).json.currencies.length).toBeGreaterThan(1);
    expect((await h.req('GET', '/api/bots')).status).toBe(403); // all currencies, but still not the owner
  });
});

describe('forgot clock-out reminder', () => {
  const reminders = (h: Harness) => h.tg.filter((x) => x.method === 'sendMessage' && String(x.body.text).startsWith('⏰'));

  it('reminds once in the topic after the set hours; the exception appears at the same time', async () => {
    const { h, e1 } = await fixture();
    await h.roster(e1, D, 'A');
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    await h.req('PUT', '/api/settings/rules', { currency: 'LKR', windowHours: 4, lateAsException: false, botReply: true, forgotOutHours: 12 });
    await h.cron(lk(D, '18:50'));
    expect(reminders(h)).toHaveLength(0);
    await h.cron(lk(D, '19:05'));
    const r = reminders(h);
    expect(r).toHaveLength(1);
    expect(r[0].body).toMatchObject({ chat_id: CHAT, message_thread_id: 1001 });
    expect(r[0].body.text).toBe('⏰ Reminder: you clocked in at 07:00 and have not clocked out for over 12 hours. Did you forget to clock out? Please tell your team leader your actual clock-out time.');
    expect((await h.session(e1, D))).toMatchObject({ missing: 'MISSING_OUT' });
    await h.cron(lk(D, '19:20'));
    await h.cron(lk(D, '19:35'));
    expect(reminders(h)).toHaveLength(1); // only once
  });

  it('no reminder when bot replies are off, or when the employee clocked out', async () => {
    const { h, e1, e2 } = await fixture();
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1002 });
    await h.send({ text: 'OUT', ts: lk(D, '15:00'), thread: 1002 });
    await h.req('PUT', '/api/settings/rules', { currency: 'LKR', windowHours: 4, lateAsException: false, botReply: false, forgotOutHours: 14 });
    await h.cron(lk(D, '21:05'));
    expect(reminders(h)).toHaveLength(0);
    expect((await h.session(e1, D))!.missing).toBe('MISSING_OUT'); // the exception still appears
    expect((await h.session(e2, D))!.missing).toBe('NONE');
  });

  it('old open sessions are never reminded (e.g. right after a deploy)', async () => {
    const { h } = await fixture();
    await h.send({ text: 'IN', ts: lk(D, '07:00'), thread: 1001 });
    await h.cron(lk(D, '23:30')); // due 21:00, more than 2 h ago
    expect(reminders(h)).toHaveLength(0);
  });

  it('the setting is limited to 1–20 hours', async () => {
    const { h } = await fixture();
    expect((await h.req('PUT', '/api/settings/rules', { currency: 'LKR', windowHours: 4, lateAsException: false, botReply: true, forgotOutHours: 21 })).status).toBe(400);
    expect((await h.req('PUT', '/api/settings/rules', { currency: 'LKR', windowHours: 4, lateAsException: false, botReply: true, forgotOutHours: 13.5, forgotOutUnit: 'm' })).status).toBe(200);
    expect((await h.req('GET', '/api/meta')).json.rulesCur.LKR).toMatchObject({ forgotOutHours: 13.5, forgotOutUnit: 'm' });
  });
});

describe('roster code OT (overtime on a day off)', () => {
  it('punches on an OT day are not an unscheduled punch, and the roster shows OT once clocked out', async () => {
    const { h, e1, e2 } = await fixture();
    await h.req('POST', '/api/roster-codes', { code: 'OT', name: 'Overtime', color: 3 });
    await h.req('PUT', '/api/roster/cell', { employeeId: e1, date: D, value: 'OT', reason: 'overtime day' });
    await h.send({ text: 'IN', ts: lk(D, '09:00'), thread: 1001 });
    await h.send({ text: 'OUT', ts: lk(D, '17:00'), thread: 1001 });
    await h.send({ text: 'IN', ts: lk(D, '09:00'), thread: 1002 }); // E002: nothing on the roster
    await h.send({ text: 'OUT', ts: lk(D, '17:00'), thread: 1002 });
    const codes = (id: number) => h.db.rows<{ code: string }>("SELECT code FROM attendance_exceptions WHERE employee_id = ? AND status = 'OPEN'", id).map((x) => x.code);
    expect(codes(e1)).not.toContain('UNSCHEDULED_PUNCH');
    expect(codes(e2)).toContain('UNSCHEDULED_PUNCH');
    const ot = (await h.req('GET', `/api/roster?from=${D}&to=${D}`)).json.ot.map((o: any) => o.employee_id).sort();
    expect(ot).toEqual([e1, e2].sort());
  });
});

describe('overview card filters', () => {
  it('ANY_LATE / ANY_EARLY / HAS_SHIFT list the people behind the overview numbers', async () => {
    const { h, e1, e2 } = await fixture();
    await h.roster(e1, D, 'A'); // 07:00–15:00
    await h.send({ text: 'IN', ts: lk(D, '07:20'), thread: 1001 }); // late, still working
    await h.send({ text: 'IN', ts: lk(D, '09:00'), thread: 1002 }); // no shift
    h.now(lk(D, '10:00'));
    const ids = async (st: string) => (await h.req('GET', `/api/attendance?from=${D}&to=${D}&status=${st}`)).json.rows.map((r: any) => r.employee_id);
    expect((await h.req('GET', `/api/overview?date=${D}`)).json.late).toBe(1);
    expect(await ids('ANY_LATE')).toEqual([e1]);
    expect(await ids('LATE')).toEqual([]); // status is WORKING while still on shift
    expect(await ids('HAS_SHIFT')).toEqual([e1]);
    expect(await ids('ANY_EARLY')).toEqual([]);
    expect((await ids('')).sort()).toEqual([e1, e2].sort());
  });
});
