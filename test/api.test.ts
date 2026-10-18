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
    expect(dry.json.plan).toMatchObject({ changeCount: 3, errorCount: 2, unchanged: 1 });
    expect((await h.req('POST', '/api/roster/import', { grid, apply: true, reason: '' })).status).toBe(400);
    const ap = await h.req('POST', '/api/roster/import', { grid, fileName: 'oct.csv', apply: true, reason: 'October roster' });
    expect(ap.json.applied).toMatchObject({ added: 3 });
    const roster = await h.req('GET', '/api/roster?from=2026-10-20&to=2026-10-22');
    expect(roster.json.instances.map((i: any) => `${i.employee_id}:${i.shift_date}:${i.shift_code}`).sort()).toEqual([`${e1}:2026-10-20:A`, `${e1}:2026-10-21:B`, `${e2}:2026-10-20:C`].sort());
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
    await h.cron(lk(D, '19:15'));
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
    await h.cron(lk(D, '19:30'));
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

  it('each currency needs its own bot; deleting a currency in use is refused', async () => {
    const { h } = await fixture();
    const dup = await h.req('PUT', '/api/bots/MYR', { token: `700000001:AAH${'x'.repeat(32)}`, webhookUrl: 'https://att.example.com/api/telegram/webhook/myr' });
    expect(dup.status).toBe(409);
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
    expect(ov.json.trend).toHaveLength(14);
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
