import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { addDays, dayDiff, fmtDateTime, isDate, isHHMM, localDate, shiftWindow, zonedToUtc } from '../../shared/time';
import type { AppBindings } from '../env';
import { auditStmt } from '../lib/audit';
import { all, chunk, first, stmt } from '../lib/db';
import { bad, body, clientIp, conflict, intParam, notFound, query, requireAdminRole } from '../lib/http';
import { assertEmployee, checkCur, inScope, requireOwner, scopeOf, scopeSql } from '../lib/scope';
import { afterInstancesChanged, cancelInstanceStmt, loadTemplates, type ShiftTemplate, upsertInstanceStmt } from '../lib/roster';
import { ensureOtMarks } from '../lib/otMarks';
import type { Key } from '../lib/sessions';
import { bizTz, loadSettings, rulesFor } from '../lib/settings';

export const shiftRoutes = new Hono<AppBindings>();

const bump = (db: D1Database, now: number) => stmt(db, "UPDATE system_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ? WHERE key = 'data_version'", now);

shiftRoutes.get('/shifts', async (c) => c.json({ rows: await loadTemplates(c.env.DB) }));

const ShiftSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z]{1,3}$/).optional(),
  name: z.string().trim().min(1).max(40),
  start: z.string().refine(isHHMM, 'HH:MM'),
  end: z.string().refine(isHHMM, 'HH:MM'),
  lateGrace: z.number().int().min(0).max(240).default(5),
  earlyGrace: z.number().int().min(0).max(240).default(5),
  breakMinutes: z.number().int().min(0).max(600).nullable().default(null),
  isActive: z.boolean().default(true),
  applyFuture: z.boolean().default(true),
});

/** Re-snapshots the template into its instances from tomorrow on. Past and today's instances keep their snapshot. */
async function applyTemplateToFuture(db: D1Database, t: ShiftTemplate, now: number, tz: string, by: string): Promise<{ count: number; pairs: Key[] }> {
  const tomorrow = addDays(localDate(now, tz), 1);
  const rows = await all<{ employee_id: number; shift_date: string }>(db, "SELECT employee_id, shift_date FROM shift_instances WHERE shift_id = ? AND shift_date >= ? AND adjustment_status <> 'CANCELLED'", t.id, tomorrow);
  const dates = [...new Set(rows.map((r) => r.shift_date))];
  const statements = dates.map((d) => {
    const w = shiftWindow(d, t.start_time, t.end_time, t.timezone);
    return stmt(db, `UPDATE shift_instances SET shift_name = ?, scheduled_start_at = ?, scheduled_end_at = ?, late_grace_min = ?, early_grace_min = ?, break_minutes = ?, updated_at = ?, updated_by = ?
                     WHERE shift_id = ? AND shift_date = ? AND adjustment_status <> 'CANCELLED'`, t.name, w.startAt, w.endAt, t.late_grace_min, t.early_grace_min, t.break_minutes, now, by, t.id, d);
  });
  for (const ch of chunk(statements, 90)) await db.batch(ch);
  return { count: rows.length, pairs: rows.filter((r) => r.shift_date === tomorrow).map((r) => [r.employee_id, r.shift_date] as Key) };
}

async function saveTemplate(c: Context<AppBindings>, id: number | null, v: z.infer<typeof ShiftSchema>) {
  const db = c.env.DB;
  const now = Date.now();
  const tz = bizTz(c.env);
  const actor = c.get('admin').username;
  if (v.start === v.end) throw bad('VALIDATION', '开始与结束不能相同', 'Start and end cannot be the same');
  const before = id ? await first<ShiftTemplate>(db, 'SELECT * FROM shift_templates WHERE id = ?', id) : null;
  if (id && !before) throw notFound('Shift not found');
  const after = { name: v.name, start: v.start, end: v.end, late_grace: v.lateGrace, early_grace: v.earlyGrace, break_minutes: v.breakMinutes, active: v.isActive };
  if (!id) {
    if (!v.code) throw bad('VALIDATION', 'Code 必须是 1–3 个英文字母', 'Code must be 1–3 letters');
    const dup = await first(db, 'SELECT id FROM shift_templates WHERE code = ?', v.code);
    if (dup) throw conflict('DUPLICATE_CODE', 'Code 已存在', 'Code already exists');
    await db.batch([
      stmt(db, `INSERT INTO shift_templates (code, name, timezone, start_time, end_time, late_grace_min, early_grace_min, break_minutes, is_active, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`, v.code, v.name, tz, v.start, v.end, v.lateGrace, v.earlyGrace, v.breakMinutes, v.isActive ? 1 : 0, now, now),
      auditStmt(db, { actor, action: 'SHIFT_TEMPLATE_CREATED', entityType: 'shift_template', entityId: v.code, after: { code: v.code, ...after }, ip: clientIp(c), at: now }),
      bump(db, now),
    ]);
    return { count: 0 };
  }
  await db.batch([
    stmt(db, 'UPDATE shift_templates SET name = ?, start_time = ?, end_time = ?, late_grace_min = ?, early_grace_min = ?, break_minutes = ?, is_active = ?, updated_at = ? WHERE id = ?',
      v.name, v.start, v.end, v.lateGrace, v.earlyGrace, v.breakMinutes, v.isActive ? 1 : 0, now, id),
    auditStmt(db, { actor, action: 'SHIFT_TEMPLATE_UPDATED', entityType: 'shift_template', entityId: before!.code,
      before: { name: before!.name, start: before!.start_time, end: before!.end_time, late_grace: before!.late_grace_min, early_grace: before!.early_grace_min, break_minutes: before!.break_minutes, active: !!before!.is_active },
      after, note: v.applyFuture ? 'future unadjusted instances updated' : 'existing instances unchanged', ip: clientIp(c), at: now }),
    bump(db, now),
  ]);
  if (!v.applyFuture) return { count: 0 };
  const t = (await first<ShiftTemplate>(db, 'SELECT * FROM shift_templates WHERE id = ?', id))!;
  const r = await applyTemplateToFuture(db, t, now, tz, actor);
  const settings = await loadSettings(db);
  await afterInstancesChanged(db, r.pairs, { now, tz, rules: settings.rules, byCur: settings.rulesCur });
  return { count: r.count };
}

shiftRoutes.post('/shifts', async (c) => { requireAdminRole(c); requireOwner(c); return c.json(await saveTemplate(c, null, await body(c, ShiftSchema))); });
shiftRoutes.put('/shifts/:id', async (c) => { requireAdminRole(c); requireOwner(c); return c.json(await saveTemplate(c, intParam(c, 'id'), await body(c, ShiftSchema))); });

const BulkSchema = z.object({
  items: z.array(z.object({ id: z.number().int(), name: z.string().trim().min(1).max(40), start: z.string().refine(isHHMM), end: z.string().refine(isHHMM) })).min(1).max(10),
  applyFuture: z.boolean().default(true),
});
shiftRoutes.put('/shifts-bulk', async (c) => {
  requireAdminRole(c);
  requireOwner(c);
  const v = await body(c, BulkSchema);
  const tpls = new Map((await loadTemplates(c.env.DB)).map((t) => [t.id, t]));
  let count = 0;
  const changed: string[] = [];
  for (const it of v.items) {
    const t = tpls.get(it.id);
    if (!t) throw notFound('Shift not found');
    if (t.name === it.name && t.start_time === it.start && t.end_time === it.end) continue;
    const r = await saveTemplate(c, it.id, { name: it.name, start: it.start, end: it.end, lateGrace: t.late_grace_min, earlyGrace: t.early_grace_min, breakMinutes: t.break_minutes, isActive: !!t.is_active, applyFuture: v.applyFuture });
    count += r.count;
    changed.push(t.code);
  }
  return c.json({ changed, count });
});

// ---------------------------------------------------------------- Roster
const RosterQ = z.object({
  from: z.string().refine(isDate), to: z.string().refine(isDate), cur: z.string().max(10).optional().default(''),
  page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().refine((n) => [10, 20, 30, 50, 100].includes(n)).default(10),
});
function rosterRange(from: string, to: string) {
  let [a, b] = from <= to ? [from, to] : [to, from];
  if (dayDiff(b, a) >= 31) b = addDays(a, 30);
  return [a, b];
}

shiftRoutes.get('/roster', async (c) => {
  const f = query(c, RosterQ);
  const [from, to] = rosterRange(f.from, f.to);
  const db = c.env.DB;
  checkCur(c, f.cur);
  const sc = scopeSql(c, 'currency_code');
  // deactivated employees are not shown in the roster (their attendance history stays in Attendance / Reports)
  const cond = `WHERE employment_status = 'ACTIVE'${f.cur ? ' AND currency_code = ?' : ''}${sc.sql}`;
  const p = [...(f.cur ? [f.cur] : []), ...sc.params];
  const [cnt, emps, per] = await db.batch([
    stmt(db, `SELECT COUNT(*) AS n FROM employees ${cond}`, ...p),
    stmt(db, `SELECT id, employee_code, name, currency_code, employment_status FROM employees ${cond} ORDER BY COALESCE(sort_order, 1000000000), employee_code LIMIT ? OFFSET ?`, ...p, f.size, (f.page - 1) * f.size),
    stmt(db, `SELECT currency_code AS code, COUNT(*) AS n FROM employees WHERE employment_status = 'ACTIVE'${sc.sql} GROUP BY currency_code`, ...sc.params),
  ]);
  const counts = Object.fromEntries((per.results as { code: string | null; n: number }[]).map((r) => [r.code ?? '', r.n]));
  const ids = (emps.results as { id: number }[]).map((e) => e.id);
  const inList = ids.map(() => '?').join(',');
  if (ids.length) await ensureOtMarks(db);
  const [instances, ot, marks, otManual] = ids.length ? await Promise.all([
    all(db, `SELECT employee_id, shift_date, shift_id, shift_code, shift_name, scheduled_start_at, scheduled_end_at, adjustment_status, source
      FROM shift_instances WHERE employee_id IN (${inList}) AND shift_date BETWEEN ? AND ?`, ...ids, from, to),
    // OT on the roster: worked on a day off (no active shift), or OT confirmed through the bot's question (ot_ms);
    // a day without a clock out (forgot to clock out) is never OT
    all(db, `SELECT s.employee_id, s.work_date, s.actual_in_at, s.actual_out_at, s.shift_duration_ms, s.ot_ms,
        CASE WHEN s.shift_instance_id IS NULL OR i.adjustment_status = 'CANCELLED' THEN 'OFF' ELSE 'LONG' END AS kind
      FROM attendance_sessions s LEFT JOIN shift_instances i ON i.id = s.shift_instance_id
      WHERE s.employee_id IN (${inList}) AND s.work_date BETWEEN ? AND ? AND s.actual_in_at IS NOT NULL AND s.actual_out_at IS NOT NULL
        AND (s.shift_instance_id IS NULL OR i.adjustment_status = 'CANCELLED' OR s.ot_ms > 0)`,
      ...ids, from, to),
    all(db, `SELECT employee_id, mark_date, code FROM roster_marks WHERE employee_id IN (${inList}) AND mark_date BETWEEN ? AND ?`, ...ids, from, to),
    // OT marked by hand on the roster (display only)
    all(db, `SELECT employee_id, work_date, minutes, note, created_by, created_at FROM ot_marks WHERE employee_id IN (${inList}) AND work_date BETWEEN ? AND ?`, ...ids, from, to),
  ]) : [[], [], [], []];
  return c.json({ from, to, total: (cnt.results[0] as { n: number }).n, counts, employees: emps.results, instances, ot, marks, otManual });
});

/** Manual OT on a roster day: on = OT (red badge; counts once in Attendance and Reports), off = remove. Audited. */
shiftRoutes.put('/roster/ot', async (c) => {
  requireAdminRole(c);
  const v = await body(c, z.object({ employeeId: z.number().int(), date: z.string().refine(isDate), on: z.boolean(), minutes: z.number().int().min(1).max(1440).optional(), note: z.string().trim().max(200).optional().default('') }));
  await assertEmployee(c, v.employeeId);
  const db = c.env.DB;
  const e = await first<{ employee_code: string }>(db, 'SELECT employee_code FROM employees WHERE id = ?', v.employeeId);
  if (!e) throw notFound('Employee not found');
  await ensureOtMarks(db);
  const cur = await first<{ note: string | null; created_by: string; minutes: number | null }>(db, 'SELECT note, created_by, minutes FROM ot_marks WHERE employee_id = ? AND work_date = ?', v.employeeId, v.date);
  if (v.on === !!cur && (!v.on || (cur?.note ?? '') === v.note)) return c.json({ ok: true, unchanged: true });
  const now = Date.now();
  const actor = c.get('admin').username;
  await db.batch([
    v.on
      ? stmt(db, `INSERT INTO ot_marks (employee_id, work_date, minutes, note, created_by, created_at) VALUES (?,?,?,?,?,?)
                  ON CONFLICT (employee_id, work_date) DO UPDATE SET minutes = excluded.minutes, note = excluded.note, created_by = excluded.created_by, created_at = excluded.created_at`,
          v.employeeId, v.date, v.minutes ?? null, v.note || null, actor, now)
      : stmt(db, 'DELETE FROM ot_marks WHERE employee_id = ? AND work_date = ?', v.employeeId, v.date),
    auditStmt(db, { actor, action: v.on ? 'OT_MARK_ADDED' : 'OT_MARK_REMOVED', entityType: 'shift_instance', entityId: `${e.employee_code}@${v.date}`,
      before: cur ? { ot: true, note: cur.note ?? '' } : { ot: false }, after: v.on ? { ot: true, note: v.note } : { ot: false },
      note: v.on ? `OT marked${v.note ? ` — ${v.note}` : ''}` : 'OT removed', ip: clientIp(c), at: now }),
    bump(db, now),
  ]);
  return c.json({ ok: true });
});

shiftRoutes.get('/roster/export', async (c) => {
  const f = query(c, RosterQ.omit({ page: true, size: true }));
  const [from, to] = rosterRange(f.from, f.to);
  const db = c.env.DB;
  checkCur(c, f.cur);
  const sc = scopeSql(c);
  const cond = (f.cur ? 'AND e.currency_code = ?' : '') + sc.sql;
  const p = [...(f.cur ? [f.cur] : []), ...sc.params];
  const [emps, inst, marks] = await db.batch([
    stmt(db, `SELECT id, employee_code, name, currency_code FROM employees e WHERE e.employment_status = 'ACTIVE' ${cond} ORDER BY COALESCE(e.sort_order, 1000000000), e.employee_code`, ...p),
    stmt(db, `SELECT i.employee_id, i.shift_date, i.shift_code FROM shift_instances i JOIN employees e ON e.id = i.employee_id
              WHERE i.shift_date BETWEEN ? AND ? AND i.adjustment_status <> 'CANCELLED' AND e.employment_status = 'ACTIVE' ${cond}`, from, to, ...p),
    stmt(db, `SELECT r.employee_id, r.mark_date, r.code FROM roster_marks r JOIN employees e ON e.id = r.employee_id
              WHERE r.mark_date BETWEEN ? AND ? AND e.employment_status = 'ACTIVE' ${cond}`, from, to, ...p),
  ]);
  return c.json({ from, to, employees: emps.results, instances: inst.results, marks: marks.results });
});

shiftRoutes.get('/roster/history', async (c) => {
  const f = query(c, z.object({ employeeId: z.coerce.number().int(), date: z.string().refine(isDate) }));
  await assertEmployee(c, f.employeeId);
  const e = await first<{ employee_code: string }>(c.env.DB, 'SELECT employee_code FROM employees WHERE id = ?', f.employeeId);
  if (!e) throw notFound();
  const rows = await all(c.env.DB, "SELECT created_at, actor, note, before_json, after_json FROM audit_logs WHERE entity_type = 'shift_instance' AND entity_id = ? ORDER BY id DESC LIMIT 20", `${e.employee_code}@${f.date}`);
  return c.json({ rows });
});

/** A roster day holds a shift (template), a roster code (mark: OFF, VL …) or nothing ('' = not scheduled). */
interface Change { employeeId: number; code: string; date: string; from: string; to: string; template: ShiftTemplate | null; mark?: string | null }

function instanceChangeStmts(db: D1Database, ch: Change, cur: { adjustment_status: string } | null, source: 'MANUAL' | 'ROSTER_IMPORT', actor: string, reason: string, ip: string, now: number, tz: string): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  if (!ch.template) out.push(cancelInstanceStmt(db, ch.employeeId, ch.date, actor, now));
  else out.push(upsertInstanceStmt(db, ch.employeeId, ch.date, ch.template, source, cur && cur.adjustment_status !== 'CANCELLED' ? 'ADJUSTED' : 'MANUAL', null, actor, now));
  if (ch.mark) out.push(stmt(db, `INSERT INTO roster_marks (employee_id, mark_date, code, updated_at, updated_by) VALUES (?,?,?,?,?)
                                  ON CONFLICT (employee_id, mark_date) DO UPDATE SET code = excluded.code, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ch.employeeId, ch.date, ch.mark, now, actor));
  else out.push(stmt(db, 'DELETE FROM roster_marks WHERE employee_id = ? AND mark_date = ?', ch.employeeId, ch.date));
  const w = ch.template ? shiftWindow(ch.date, ch.template.start_time, ch.template.end_time, ch.template.timezone) : null;
  out.push(auditStmt(db, { actor, action: 'SHIFT_INSTANCE_ADJUSTED', entityType: 'shift_instance', entityId: `${ch.code}@${ch.date}`,
    before: { shift: ch.from }, after: { shift: ch.to, source, ...(w ? { start: fmtDateTime(w.startAt, tz), end: fmtDateTime(w.endAt, tz) } : {}) }, note: reason, ip, at: now }));
  return out;
}

shiftRoutes.put('/roster/cell', async (c) => {
  requireAdminRole(c);
  // value: a shift template id, a roster code ('OFF', 'VL' …) or '' (not scheduled)
  const v = await body(c, z.object({ employeeId: z.number().int(), date: z.string().refine(isDate), value: z.union([z.string().trim().toUpperCase().max(6), z.number().int()]), reason: z.string().trim().min(4).max(300) }));
  await assertEmployee(c, v.employeeId);
  const db = c.env.DB;
  const now = Date.now();
  const tz = bizTz(c.env);
  const actor = c.get('admin').username;
  const isShift = typeof v.value === 'number';
  const [eR, iR, tR, mR] = await db.batch([
    stmt(db, 'SELECT id, employee_code, employment_status, deactivated_at FROM employees WHERE id = ?', v.employeeId),
    stmt(db, 'SELECT shift_code, adjustment_status FROM shift_instances WHERE employee_id = ? AND shift_date = ?', v.employeeId, v.date),
    stmt(db, 'SELECT * FROM shift_templates WHERE id = ?', isShift ? v.value : 0),
    stmt(db, 'SELECT code FROM roster_marks WHERE employee_id = ? AND mark_date = ?', v.employeeId, v.date),
  ]);
  const codes = (await loadSettings(db)).rosterCodes.map((x) => x.code);
  const markTo = !isShift && v.value !== '' ? String(v.value) : null;
  if (markTo && !codes.includes(markTo)) throw bad('VALIDATION', `代号 ${markTo} 不存在`, `Unknown roster code ${markTo}`);
  const e = eR.results[0] as { employee_code: string; employment_status: string } | undefined;
  if (!e) throw notFound('Employee not found');
  const cur = (iR.results[0] as { shift_code: string; adjustment_status: string } | undefined) ?? null;
  const t = (tR.results[0] as unknown as ShiftTemplate | undefined) ?? null;
  if (isShift && (!t || !t.is_active)) throw bad('VALIDATION', '班次不存在或未启用', 'Shift not found or inactive');
  if (isShift && e.employment_status !== 'ACTIVE') throw bad('INACTIVE', '员工已停用', 'Employee is inactive');
  const curMark = (mR.results[0] as { code: string } | undefined)?.code ?? null;
  const fromCode = cur && cur.adjustment_status !== 'CANCELLED' ? cur.shift_code : curMark ?? '';
  const toCode = isShift ? t!.code : markTo ?? '';
  if (fromCode === toCode) return c.json({ ok: true, unchanged: true });
  await db.batch([...instanceChangeStmts(db, { employeeId: v.employeeId, code: e.employee_code, date: v.date, from: fromCode, to: toCode, template: isShift ? t : null, mark: markTo }, cur, 'MANUAL', actor, v.reason, clientIp(c), now, tz), bump(db, now)]);
  const settings = await loadSettings(db);
  await afterInstancesChanged(db, [[v.employeeId, v.date]], { now, tz, rules: settings.rules, byCur: settings.rulesCur });
  return c.json({ ok: true });
});

function normDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return isDate(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`) ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) { const d = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; return isDate(d) ? d : null; }
  return null;
}

const ImportSchema = z.object({
  grid: z.array(z.array(z.union([z.string().max(64), z.number(), z.null()])).max(60)).min(1).max(2000),
  fileName: z.string().max(200).default('roster'),
  apply: z.boolean().default(false),
  reason: z.string().trim().max(300).optional().default(''),
  currency: z.string().trim().toUpperCase().max(10).optional().default(''), // set → only that currency's employees are updated
});

shiftRoutes.post('/roster/import', async (c) => {
  requireAdminRole(c);
  const v = await body(c, ImportSchema);
  checkCur(c, v.currency);
  // an account limited to one currency always imports into that currency
  const scope = scopeOf(c);
  if (!v.currency && scope?.length === 1) v.currency = scope[0];
  const db = c.env.DB;
  const now = Date.now();
  const tz = bizTz(c.env);
  const today = localDate(now, tz);
  const errs: { where: string; msg: { zh: string; en: string } }[] = [];
  const changes: Change[] = [];
  let unchanged = 0;
  let cells = 0;
  let skipped = 0; // rows of another currency (import into one currency)
  const fileOrder: number[] = []; // employees in the file's row order → their display order
  const head = v.grid[0].map((x) => String(x ?? '').trim());
  let idCol = head.findIndex((x) => /^(psd\s*id|employee\s*id|员工编号|id)$/i.test(x));
  if (idCol < 0) idCol = 0;
  const dateCols = head.map((x, i) => ({ i, d: normDate(x) })).filter((x): x is { i: number; d: string } => !!x.d);
  if (!dateCols.length) errs.push({ where: 'Header', msg: { zh: '找不到日期栏位（格式 YYYY-MM-DD）', en: 'No date columns found (use YYYY-MM-DD)' } });
  const dates = dateCols.map((x) => x.d).sort();
  if (dates.length && dayDiff(dates[dates.length - 1], dates[0]) > 62) throw bad('RANGE', '一次最多导入 62 天', 'At most 62 days per import');
  const [empR, tplR, instR, markR] = await db.batch([
    stmt(db, 'SELECT id, employee_code, name, employment_status, deactivated_at, currency_code FROM employees'),
    stmt(db, 'SELECT * FROM shift_templates WHERE is_active = 1'),
    stmt(db, 'SELECT employee_id, shift_date, shift_code, adjustment_status FROM shift_instances WHERE shift_date BETWEEN ? AND ?', dates[0] ?? today, dates[dates.length - 1] ?? today),
    stmt(db, 'SELECT employee_id, mark_date, code FROM roster_marks WHERE mark_date BETWEEN ? AND ?', dates[0] ?? today, dates[dates.length - 1] ?? today),
  ]);
  const marks = new Map((markR.results as { employee_id: number; mark_date: string; code: string }[]).map((m) => [`${m.employee_id}|${m.mark_date}`, m.code]));
  const rosterCodes = new Set((await loadSettings(db)).rosterCodes.map((x) => x.code));
  const emps = new Map((empR.results as { id: number; employee_code: string; name: string; employment_status: string; deactivated_at: number | null; currency_code: string | null }[]).map((e) => [e.employee_code.toLowerCase(), e]));
  const tpls = new Map((tplR.results as unknown as ShiftTemplate[]).map((t) => [t.code.toUpperCase(), t]));
  const inst = new Map((instR.results as { employee_id: number; shift_date: string; shift_code: string; adjustment_status: string }[]).map((i) => [`${i.employee_id}|${i.shift_date}`, i]));
  for (let r = 1; r < v.grid.length; r++) {
    const raw = String(v.grid[r][idCol] ?? '').trim();
    if (!raw) continue;
    const e = emps.get(raw.toLowerCase());
    if (!e) { errs.push({ where: `Row ${r + 1}`, msg: { zh: `找不到员工 ${raw}`, en: `Unknown employee ${raw}` } }); continue; }
    if (v.currency && e.currency_code !== v.currency) {
      skipped++;
      errs.push({ where: `Row ${r + 1} · ${e.employee_code}`, msg: { zh: `属于 ${e.currency_code ?? '—'}，不是 ${v.currency}，已跳过`, en: `belongs to ${e.currency_code ?? '—'}, not ${v.currency} — skipped` } });
      continue;
    }
    if (!inScope(c, e.currency_code)) {
      skipped++;
      errs.push({ where: `Row ${r + 1} · ${e.employee_code}`, msg: { zh: '你的账号没有权限修改这个员工，已跳过', en: 'Your account has no access to this employee — skipped' } });
      continue;
    }
    if (!fileOrder.includes(e.id)) fileOrder.push(e.id);
    for (const { i, d } of dateCols) {
      const val = String(v.grid[r][i] ?? '').trim().toUpperCase();
      if (!val) continue;
      cells++;
      const where = `${e.employee_code} · ${d}`;
      const cur = inst.get(`${e.id}|${d}`) ?? null;
      const curCode = cur && cur.adjustment_status !== 'CANCELLED' ? cur.shift_code : marks.get(`${e.id}|${d}`) ?? '';
      // a shift code, a roster code (OFF, VL …) or "-" (not scheduled); an empty cell leaves the day unchanged
      let next: string;
      if (val === '-' || val === '–') next = '';
      else if (tpls.has(val) || rosterCodes.has(val)) next = val;
      else { errs.push({ where, msg: { zh: `未知代号「${val}」`, en: `Unknown code "${val}"` } }); continue; }
      if (tpls.has(next) && e.employment_status !== 'ACTIVE') { errs.push({ where, msg: { zh: '员工已停用', en: 'Employee is inactive' } }); continue; }
      if (next === curCode) { unchanged++; continue; }
      changes.push({ employeeId: e.id, code: e.employee_code, date: d, from: curCode, to: next, template: tpls.get(next) ?? null, mark: !tpls.has(next) && next ? next : null });
    }
  }
  const plan = {
    cells, unchanged, skipped, currency: v.currency || null, errors: errs.slice(0, 200), errorCount: errs.length, pastCount: changes.filter((x) => x.date <= today).length,
    changes: changes.slice(0, 300).map((x) => ({ employeeId: x.employeeId, code: x.code, name: (emps.get(x.code.toLowerCase())?.name) ?? '', date: x.date, from: x.from, to: x.to })),
    changeCount: changes.length,
  };
  if (!v.apply) return c.json({ plan });
  if (v.reason.length < 4) throw bad('REASON', '请填写原因（至少 4 个字）', 'Please give a reason (at least 4 characters)');
  const actor = c.get('admin').username;
  const ip = clientIp(c);
  const statements: D1PreparedStatement[] = [];
  let added = 0, changed = 0, removed = 0;
  for (const ch of changes) {
    statements.push(...instanceChangeStmts(db, ch, inst.get(`${ch.employeeId}|${ch.date}`) ?? null, 'ROSTER_IMPORT', actor, v.reason, ip, now, tz));
    if (!ch.template) removed++; else if (!tpls.has(ch.from)) added++; else changed++;
  }
  statements.push(auditStmt(db, { actor, action: 'ROSTER_IMPORTED', entityType: 'shift_instance', entityId: v.fileName, after: { changes: changes.length, added, changed, removed, skipped_errors: errs.length, ...(v.currency ? { currency: v.currency } : {}) }, note: v.reason, ip, at: now }));
  // rows are shown in the same order as in the file
  fileOrder.forEach((id, k) => statements.push(stmt(db, 'UPDATE employees SET sort_order = ? WHERE id = ?', k + 1, id)));
  statements.push(bump(db, now));
  for (const ch of chunk(statements, 90)) await db.batch(ch);
  const settings = await loadSettings(db);
  const r = await afterInstancesChanged(db, changes.map((x) => [x.employeeId, x.date] as Key), { now, tz, rules: settings.rules, byCur: settings.rulesCur });
  return c.json({ plan, applied: { added, changed, removed, recomputed: r.inline, deferred: r.deferred } });
});

// ---------------------------------------------------------------- roster history (from the append-only audit log)
shiftRoutes.get('/roster/history-log', async (c) => {
  const f = query(c, z.object({
    q: z.string().max(80).optional().default(''),
    cur: z.string().trim().toUpperCase().max(10).optional().default(''),
    from: z.string().refine(isDate).optional(), to: z.string().refine(isDate).optional(), // custom date range (Sri Lanka dates of the change)
    page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().refine((n) => [10, 20, 30, 50, 100].includes(n)).default(10),
  }));
  const db = c.env.DB;
  const tz = bizTz(c.env);
  // manual shift changes one by one, plus ONE row per roster import (its per-cell entries are not listed)
  const cond = ["a.entity_type = 'shift_instance'",
    `((a.action = 'SHIFT_INSTANCE_ADJUSTED' AND COALESCE(a.after_json, '') NOT LIKE '%"source":"ROSTER_IMPORT"%') OR a.action = 'ROSTER_IMPORTED')`];
  const p: unknown[] = [];
  const [d1, d2] = f.from && f.to && f.from > f.to ? [f.to, f.from] : [f.from, f.to];
  if (d1) { cond.push('a.created_at >= ?'); p.push(zonedToUtc(d1, '00:00', tz)); }
  if (d2) { cond.push('a.created_at < ?'); p.push(zonedToUtc(addDays(d2, 1), '00:00', tz)); }
  checkCur(c, f.cur);
  const scope = scopeOf(c);
  if (scope !== null) {
    // a limited account: changes of its currencies' employees, imports made for its currencies, and its own imports
    const q = scope.map(() => '?').join(',') || 'NULL';
    cond.push(`((a.action = 'ROSTER_IMPORTED' AND (a.actor = ? OR (json_valid(a.after_json) AND json_extract(a.after_json, '$.currency') IN (${q})))) OR (a.action <> 'ROSTER_IMPORTED' AND e.currency_code IN (${q})))`);
    p.push(c.get('admin').username, ...scope, ...scope);
  }
  if (f.cur) {
    // a shift change of that currency's employee, or an import made for that currency (or for all currencies)
    cond.push(`((a.action = 'ROSTER_IMPORTED' AND (COALESCE(a.after_json, '') LIKE ? OR COALESCE(a.after_json, '') NOT LIKE '%"currency":%')) OR (a.action <> 'ROSTER_IMPORTED' AND e.currency_code = ?))`);
    p.push(`%"currency":"${f.cur.replace(/[^A-Z0-9]/g, '')}"%`, f.cur);
  }
  if (f.q) { cond.push("(e.employee_code LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\')"); const like = `%${f.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`; p.push(like, like); }
  const FROM = `FROM audit_logs a LEFT JOIN employees e ON e.employee_code = substr(a.entity_id, 1, instr(a.entity_id, '@') - 1)`;
  const [cnt, rows] = await db.batch([
    stmt(db, `SELECT COUNT(*) AS n ${FROM} WHERE ${cond.join(' AND ')}`, ...p),
    stmt(db, `SELECT a.id, a.created_at, a.actor, a.action, a.entity_id, a.before_json, a.after_json, a.note, e.employee_code, e.name
              ${FROM} WHERE ${cond.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`, ...p, f.size, (f.page - 1) * f.size),
  ]);
  return c.json({ total: (cnt.results[0] as { n: number }).n, rows: rows.results });
});
