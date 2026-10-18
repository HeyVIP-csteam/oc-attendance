import { Hono } from 'hono';
import { z } from 'zod';
import { EVENT_LABEL, EVENT_TYPES, type EventType, EXCEPTIONS } from '../../shared/codes';
import { buildKeywordIndex, normText, parseText } from '../../shared/parser';
import { isDate, MIN } from '../../shared/time';
import type { AppBindings } from '../env';
import { auditStmt } from '../lib/audit';
import { first, stmt } from '../lib/db';
import { bad, body, clientIp, intParam, notFound, query, requireAdminRole } from '../lib/http';
import { assignmentContext, chooseWorkDate } from '../lib/sessions';
import { bizTz, loadSettings, rulesFor } from '../lib/settings';
import { applyAdjustment } from './attendance';

export const exceptionRoutes = new Hono<AppBindings>();

const likeEsc = (q: string) => `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
const Page = { page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().refine((n) => [10, 20, 30, 50, 100].includes(n)).default(10) };

exceptionRoutes.get('/exceptions', async (c) => {
  const f = query(c, z.object({
    code: z.string().max(40).optional().default(''), sev: z.enum(['', 'HIGH', 'MEDIUM', 'LOW']).optional().default(''),
    status: z.enum(['', 'OPEN', 'RESOLVED', 'DISMISSED']).optional().default(''), q: z.string().max(80).optional().default(''), ...Page,
  }));
  const cond: string[] = ['1 = 1'];
  const p: unknown[] = [];
  if (f.code) { cond.push('x.code = ?'); p.push(f.code); }
  if (f.sev) { cond.push('x.severity = ?'); p.push(f.sev); }
  if (f.status) { cond.push('x.status = ?'); p.push(f.status); }
  if (f.q) { cond.push("(e.employee_code LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\')"); p.push(likeEsc(f.q), likeEsc(f.q)); }
  const FROM = 'FROM attendance_exceptions x LEFT JOIN employees e ON e.id = x.employee_id LEFT JOIN telegram_messages m ON m.id = x.message_id';
  const db = c.env.DB;
  const [cnt, rows] = await db.batch([
    stmt(db, `SELECT COUNT(*) AS n ${FROM} WHERE ${cond.join(' AND ')}`, ...p),
    stmt(db, `SELECT x.id, x.code, x.severity, x.status, x.source, x.occurred_at, x.work_date, x.detail, x.note, x.handled_by, x.handled_at, x.employee_id,
                e.employee_code, e.name, m.raw_text, m.message_thread_id, m.id AS raw_id
              ${FROM} WHERE ${cond.join(' AND ')} ORDER BY x.occurred_at DESC, x.id DESC LIMIT ? OFFSET ?`, ...p, f.size, (f.page - 1) * f.size),
  ]);
  return c.json({ total: (cnt.results[0] as { n: number }).n, rows: rows.results, codes: Object.keys(EXCEPTIONS) });
});

/** Which event fixes which exception (null = guess from the raw message text). */
const EX_FIX: Record<string, EventType | null> = {
  MISSING_CLOCK_OUT: 'CLOCK_OUT', MISSING_CLOCK_IN: 'CLOCK_IN', NO_SHOW: 'CLOCK_IN', BREAK_NOT_ENDED: 'BREAK_END', CLOCK_OUT_DURING_BREAK: 'BREAK_END',
  NO_TOPIC: null, WRONG_TOPIC_UNMAPPED: null, UNTRUSTED_SOURCE: null, UNRECOGNIZED: null, EDITED_MESSAGE: null,
};

interface ExRow { id: number; code: string; status: string; employee_id: number | null; work_date: string; occurred_at: number; message_id: number | null; raw_text: string | null; telegram_message_ts: number | null; source: string; note: string | null }

exceptionRoutes.get('/exceptions/:id/fix', async (c) => {
  const id = intParam(c, 'id');
  const db = c.env.DB;
  const tz = bizTz(c.env);
  const x = await first<ExRow>(db, `SELECT x.*, m.raw_text, m.telegram_message_ts FROM attendance_exceptions x LEFT JOIN telegram_messages m ON m.id = x.message_id WHERE x.id = ?`, id);
  if (!x) throw notFound();
  if (!x.employee_id) return c.json({ fix: null });
  const settings = await loadSettings(db);
  let workDate = x.work_date;
  if (x.source === 'INGEST') {
    const { ctx, instances } = await assignmentContext(db, x.employee_id, x.telegram_message_ts ?? x.occurred_at);
    const emp = await first<{ currency_code: string | null }>(db, 'SELECT currency_code FROM employees WHERE id = ?', x.employee_id);
    workDate = chooseWorkDate({ type: 'CLOCK_OUT', ts: x.telegram_message_ts ?? x.occurred_at }, ctx, instances, rulesFor(settings, emp?.currency_code).windowHours, tz);
  }
  const s = await first<{ scheduled_start_at: number | null; scheduled_end_at: number | null; actual_out_at: number | null; id: number }>(db,
    'SELECT id, scheduled_start_at, scheduled_end_at, actual_out_at FROM attendance_sessions WHERE employee_id = ? AND work_date = ?', x.employee_id, workDate);
  let type: EventType = EX_FIX[x.code] ?? 'CLOCK_IN';
  let ts = x.telegram_message_ts ?? x.occurred_at;
  if (x.code in EX_FIX && EX_FIX[x.code] == null) {
    const idx = buildKeywordIndex(settings.keywords, settings.parser);
    const p = parseText(x.raw_text ?? '', idx);
    if (p.kind === 'PUNCH') type = p.type;
    else if (p.kind === 'UNRECOGNIZED' && p.types.length) type = p.types[0];
    else {
      const n = normText(x.raw_text ?? '');
      for (const [k, t] of idx.map) if (n.split(' ').includes(k.split(' ')[0])) { type = t; break; }
    }
  }
  if (x.code === 'MISSING_CLOCK_OUT' && s?.scheduled_end_at) ts = s.scheduled_end_at;
  if ((x.code === 'MISSING_CLOCK_IN' || x.code === 'NO_SHOW') && s?.scheduled_start_at) ts = s.scheduled_start_at;
  if ((x.code === 'BREAK_NOT_ENDED' || x.code === 'CLOCK_OUT_DURING_BREAK') && s) {
    const ob = await first<{ start_at: number }>(db, "SELECT start_at FROM break_sessions WHERE session_id = ? AND status = 'OPEN' ORDER BY seq LIMIT 1", s.id);
    ts = s.actual_out_at ?? (ob ? ob.start_at + 30 * MIN : ts);
  }
  const label = (EXCEPTIONS as Record<string, { label: { zh: string; en: string } }>)[x.code]?.label ?? { zh: x.code, en: x.code };
  return c.json({ fix: {
    employeeId: x.employee_id, workDate, type, ts, on: x.code in EX_FIX,
    reason: { zh: `补录${EVENT_LABEL[type].zh}（${label.zh}）`, en: `Added ${EVENT_LABEL[type].en} (${label.en})` },
  } });
});

const EditSchema = z.object({
  status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']),
  note: z.string().trim().max(500).optional().default(''),
  fix: z.object({ employeeId: z.number().int(), workDate: z.string().refine(isDate), eventType: z.enum(EVENT_TYPES), ts: z.number().int(), reason: z.string().trim().min(4).max(500) }).optional(),
});

exceptionRoutes.put('/exceptions/:id', async (c) => {
  requireAdminRole(c);
  const id = intParam(c, 'id');
  const v = await body(c, EditSchema);
  const db = c.env.DB;
  const actor = c.get('admin').username;
  const ip = clientIp(c);
  const x = await first<ExRow>(db, 'SELECT * FROM attendance_exceptions WHERE id = ?', id);
  if (!x) throw notFound();
  if (v.fix && x.employee_id && x.employee_id !== v.fix.employeeId) throw bad('VALIDATION', '员工不一致', 'Employee mismatch');
  const now = Date.now();
  const setStatus = (status: string, note: string | null, by: string | null, at: number | null) => status === 'OPEN'
    ? stmt(db, "UPDATE attendance_exceptions SET status = 'OPEN', note = NULL, handled_by = NULL, handled_at = NULL, updated_at = ? WHERE id = ?", now, id)
    : stmt(db, 'UPDATE attendance_exceptions SET status = ?, note = ?, handled_by = ?, handled_at = ?, updated_at = ? WHERE id = ?', status, note, by, at, now, id);
  // review status first: a fix may make a computed exception disappear, and a reviewed exception is kept as history
  await db.batch([
    setStatus(v.status, v.note || null, actor, now),
    stmt(db, "UPDATE system_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ? WHERE key = 'data_version'", now),
  ]);
  if (v.fix) {
    try {
      await applyAdjustment(c.env, actor, ip, v.fix.employeeId, v.fix.workDate, { action: 'ADD_EVENT', eventType: v.fix.eventType, ts: v.fix.ts, reason: v.fix.reason });
    } catch (e) {
      const prev = x as ExRow & { handled_by: string | null; handled_at: number | null };
      await setStatus(x.status, x.note, prev.handled_by, prev.handled_at).run();
      throw e;
    }
  }
  await auditStmt(db, { actor, action: 'EXCEPTION_EDITED', entityType: 'attendance_exception', entityId: id, before: { status: x.status, note: x.note ?? '' }, after: { status: v.status, note: v.note, attendance_fixed: !!v.fix }, ip, at: now }).run();
  return c.json({ ok: true });
});

exceptionRoutes.get('/audit', async (c) => {
  const f = query(c, z.object(Page));
  const db = c.env.DB;
  const [cnt, rows] = await db.batch([
    // append-only table: MAX(id) equals the row count and reads one row instead of scanning the table
    stmt(db, 'SELECT COALESCE(MAX(id), 0) AS n FROM audit_logs'),
    stmt(db, 'SELECT id, created_at, actor, action, entity_type, entity_id, before_json, after_json, note FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', f.size, (f.page - 1) * f.size),
  ]);
  return c.json({ total: (cnt.results[0] as { n: number }).n, rows: rows.results });
});

exceptionRoutes.get('/messages', async (c) => {
  const f = query(c, z.object(Page));
  const db = c.env.DB;
  const [cnt, rows] = await db.batch([
    stmt(db, 'SELECT COALESCE(MAX(id), 0) AS n FROM telegram_messages'), // append-only
    stmt(db, `SELECT id, received_at, telegram_message_ts, message_id, message_thread_id, from_user_id, raw_text, parsed_event_type, processing_status, error_code, is_edit
              FROM telegram_messages ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`, f.size, (f.page - 1) * f.size),
  ]);
  return c.json({ total: (cnt.results[0] as { n: number }).n, rows: rows.results });
});
