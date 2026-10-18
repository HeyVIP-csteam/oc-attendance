import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { addDays, localDate } from '../../shared/time';
import type { AppBindings } from '../env';
import { auditStmt } from '../lib/audit';
import { all, chunk, first, stmt } from '../lib/db';
import { ApiError, bad, body, clientIp, conflict, intParam, notFound, query, requireAdminRole } from '../lib/http';
import { afterInstancesChanged, generateFromAssignments } from '../lib/roster';
import type { Key } from '../lib/sessions';
import { bizTz, loadSettings } from '../lib/settings';

export const employeeRoutes = new Hono<AppBindings>();

const validTz = (tz: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const likeEsc = (q: string) => `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;

employeeRoutes.get('/employees', async (c) => {
  const f = query(c, z.object({
    q: z.string().max(80).optional().default(''), cur: z.string().trim().toUpperCase().max(10).optional().default(''), status: z.enum(['', 'ACTIVE', 'INACTIVE']).optional().default(''),
    page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().refine((n) => [10, 20, 30, 50, 100].includes(n)).default(10),
  }));
  const cond: string[] = ['1 = 1'];
  const p: unknown[] = [];
  if (f.status) { cond.push('e.employment_status = ?'); p.push(f.status); }
  if (f.cur) { cond.push('e.currency_code = ?'); p.push(f.cur); }
  if (f.q) { cond.push("(e.employee_code LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\' OR CAST(m.message_thread_id AS TEXT) LIKE ? ESCAPE '\\')"); p.push(likeEsc(f.q), likeEsc(f.q), likeEsc(f.q)); }
  const FROM = 'FROM employees e LEFT JOIN telegram_topic_mappings m ON m.employee_id = e.id AND m.is_active = 1';
  const db = c.env.DB;
  const [cnt, rows] = await db.batch([
    stmt(db, `SELECT COUNT(*) AS n ${FROM} WHERE ${cond.join(' AND ')}`, ...p),
    stmt(db, `SELECT e.id, e.employee_code, e.name, e.currency_code, e.employment_status, e.default_shift_id, e.timezone, e.deactivated_at,
                m.chat_id, m.message_thread_id, (SELECT COUNT(*) FROM telegram_topic_mappings h WHERE h.employee_id = e.id) AS mapping_count
              ${FROM} WHERE ${cond.join(' AND ')} ORDER BY e.employee_code LIMIT ? OFFSET ?`, ...p, f.size, (f.page - 1) * f.size),
  ]);
  return c.json({ total: (cnt.results[0] as { n: number }).n, rows: rows.results });
});

employeeRoutes.get('/employees/:id', async (c) => {
  const id = intParam(c, 'id');
  const db = c.env.DB;
  const [e, maps] = await db.batch([
    stmt(db, 'SELECT * FROM employees WHERE id = ?', id),
    stmt(db, 'SELECT id, chat_id, message_thread_id, valid_from, valid_until, is_active, created_by FROM telegram_topic_mappings WHERE employee_id = ? ORDER BY valid_from DESC', id),
  ]);
  const emp = e.results[0] as { employee_code: string } | undefined;
  if (!emp) throw notFound('Employee not found');
  // change log of this employee's profile and topic binding (append-only audit log)
  const changes = await all(db, `SELECT id, created_at, actor, action, before_json, after_json, note FROM audit_logs
    WHERE entity_type IN ('employee', 'telegram_topic_mapping') AND entity_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`, emp.employee_code);
  return c.json({ employee: emp, mappings: maps.results, changes });
});

const EmpSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(100),
  currency: z.string().trim().max(10).nullable().optional(),
  defaultShiftId: z.number().int().positive().nullable().optional(),
  timezone: z.string().trim().max(64).default('Asia/Colombo'),
  chatId: z.string().trim().max(20).optional().default(''),
  threadId: z.string().trim().max(12).optional().default(''),
});

async function saveEmployee(c: Context<AppBindings>, id: number | null) {
  requireAdminRole(c);
  const v = await body(c, EmpSchema);
  const db = c.env.DB;
  const actor = c.get('admin').username;
  const ip = clientIp(c);
  const now = Date.now();
  const tz = bizTz(c.env);
  if (!/^[A-Za-z0-9_.-]+$/.test(v.code)) throw bad('VALIDATION', 'PSD ID 只能用英文字母、数字和 _ . -，不能有空格', 'PSD ID may only contain letters, digits and _ . - (no spaces)');
  if (!validTz(v.timezone)) throw bad('VALIDATION', '时区无效', 'Invalid time zone');
  if (v.threadId && !/^\d+$/.test(v.threadId)) throw bad('VALIDATION', 'thread_id 必须为数字', 'thread_id must be numeric');
  // a link like t.me/c/3959204082/28/… shows the group id without the -100 prefix every supergroup id has
  if (/^\d{5,17}$/.test(v.chatId)) v.chatId = '-100' + v.chatId;
  if (v.threadId && !/^-100\d{5,17}$/.test(v.chatId)) throw bad('VALIDATION', 'Chat ID 格式错误：超级群组的 Chat ID 是 -100 开头', 'Invalid Chat ID: supergroup ids start with -100');
  const chatId = v.threadId ? Number(v.chatId) : null;
  const threadId = v.threadId ? Number(v.threadId) : null;

  const [curR, dupR, shR, oldR, mapR, topicR] = await db.batch([
    stmt(db, 'SELECT code FROM currencies WHERE code = ?', v.currency ?? ''),
    stmt(db, 'SELECT id FROM employees WHERE employee_code = ? AND id IS NOT ?', v.code, id),
    stmt(db, 'SELECT id, is_active FROM shift_templates WHERE id = ?', v.defaultShiftId ?? 0),
    stmt(db, 'SELECT * FROM employees WHERE id = ?', id ?? 0),
    stmt(db, 'SELECT * FROM telegram_topic_mappings WHERE employee_id = ? AND is_active = 1', id ?? 0),
    stmt(db, `SELECT m.employee_id, e.employee_code FROM telegram_topic_mappings m JOIN employees e ON e.id = m.employee_id
              WHERE m.chat_id = ? AND m.message_thread_id = ? AND m.is_active = 1`, chatId ?? 0, threadId ?? 0),
  ]);
  if (v.currency && !curR.results[0]) throw bad('VALIDATION', '货币不存在', 'Unknown currency');
  if (dupR.results[0]) throw conflict('DUPLICATE_CODE', 'PSD ID 已存在', 'PSD ID already exists');
  if (v.defaultShiftId && !shR.results[0]) throw bad('VALIDATION', '班次不存在', 'Unknown shift');
  const old = (oldR.results[0] as Record<string, unknown> | undefined) ?? null;
  if (id && !old) throw notFound('Employee not found');
  // shifts are planned in the roster; the dashboard no longer sends a default shift, so keep whatever is stored
  if (v.defaultShiftId === undefined) v.defaultShiftId = (old?.default_shift_id as number | null | undefined) ?? null;
  const owner = topicR.results[0] as { employee_id: number; employee_code: string } | undefined;
  if (owner && owner.employee_id !== id) throw conflict('TOPIC_TAKEN', `Topic #${threadId} 当前已映射给 ${owner.employee_code}，请先解除`, `Topic #${threadId} is mapped to ${owner.employee_code}; unbind it first`);
  const curMap = (mapR.results[0] as { id: number; chat_id: number; message_thread_id: number } | undefined) ?? null;

  const statements: D1PreparedStatement[] = [];
  const after = { code: v.code, name: v.name, currency: v.currency || null, default_shift_id: v.defaultShiftId ?? null, timezone: v.timezone, topic: threadId };
  if (!id) {
    statements.push(stmt(db, `INSERT INTO employees (employee_code, name, currency_code, employment_status, default_shift_id, timezone, created_at, updated_at)
                              VALUES (?,?,?,?,?,?,?,?)`, v.code, v.name, v.currency || null, 'ACTIVE', v.defaultShiftId ?? null, v.timezone, now, now));
  } else {
    statements.push(stmt(db, 'UPDATE employees SET employee_code = ?, name = ?, currency_code = ?, default_shift_id = ?, timezone = ?, updated_at = ? WHERE id = ?',
      v.code, v.name, v.currency || null, v.defaultShiftId ?? null, v.timezone, now, id));
  }
  const empRef = id ? String(id) : '(SELECT id FROM employees WHERE employee_code = ?)';
  const empRefP = id ? [] : [v.code];
  const mappingChanged = threadId != null && (!curMap || curMap.message_thread_id !== threadId || curMap.chat_id !== chatId);
  if (curMap && (mappingChanged || threadId == null)) {
    statements.push(stmt(db, 'UPDATE telegram_topic_mappings SET valid_until = ?, is_active = 0, updated_at = ? WHERE id = ?', now, now, curMap.id));
  }
  if (mappingChanged) {
    statements.push(stmt(db, `INSERT INTO telegram_topic_mappings (employee_id, chat_id, message_thread_id, valid_from, valid_until, is_active, created_by, created_at, updated_at)
                              VALUES (${empRef}, ?, ?, ?, NULL, 1, ?, ?, ?)`, ...empRefP, chatId, threadId, now, actor, now, now));
    statements.push(auditStmt(db, { actor, action: 'TOPIC_MAPPING_CHANGED', entityType: 'telegram_topic_mapping', entityId: v.code,
      before: curMap ? { chat_id: curMap.chat_id, thread_id: curMap.message_thread_id } : null, after: { chat_id: chatId, thread_id: threadId }, ip, at: now }));
  } else if (curMap && threadId == null) {
    statements.push(auditStmt(db, { actor, action: 'TOPIC_MAPPING_REMOVED', entityType: 'telegram_topic_mapping', entityId: v.code, before: { chat_id: curMap.chat_id, thread_id: curMap.message_thread_id }, ip, at: now }));
  }

  // default shift → assignment effective from tomorrow (history of the previous assignment is kept)
  const today = localDate(now, tz);
  const tomorrow = addDays(today, 1);
  const shiftChanged = (old?.default_shift_id ?? null) !== (v.defaultShiftId ?? null);
  if (shiftChanged) {
    statements.push(stmt(db, `UPDATE employee_shift_assignments SET effective_until = ? WHERE employee_id = ${empRef} AND (effective_until IS NULL OR effective_until >= ?) AND effective_from <= ?`,
      today, ...empRefP, tomorrow, today));
    statements.push(stmt(db, `DELETE FROM employee_shift_assignments WHERE employee_id = ${empRef} AND effective_from >= ?`, ...empRefP, tomorrow));
    statements.push(stmt(db, `DELETE FROM shift_instances WHERE employee_id = ${empRef} AND shift_date >= ? AND source = 'ASSIGNMENT' AND adjustment_status = 'SCHEDULED'
                              AND NOT EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.shift_instance_id = shift_instances.id)`, ...empRefP, tomorrow));
    if (v.defaultShiftId) {
      statements.push(stmt(db, `INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from, effective_until, work_days, assigned_by, created_at)
                                VALUES (${empRef}, ?, ?, NULL, '0123456', ?, ?)`, ...empRefP, v.defaultShiftId, tomorrow, actor, now));
    }
    statements.push(auditStmt(db, { actor, action: 'SHIFT_ASSIGNED', entityType: 'employee_shift_assignment', entityId: v.code, before: { shift_id: old?.default_shift_id ?? null }, after: { shift_id: v.defaultShiftId ?? null, effective_from: tomorrow }, ip, at: now }));
  }
  const before = old ? { code: old.employee_code, name: old.name, currency: old.currency_code, default_shift_id: old.default_shift_id, timezone: old.timezone, topic: curMap?.message_thread_id ?? null } : null;
  statements.push(auditStmt(db, { actor, action: id ? 'EMPLOYEE_UPDATED' : 'EMPLOYEE_CREATED', entityType: 'employee', entityId: v.code, before, after, ip, at: now }));
  statements.push(stmt(db, "UPDATE system_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ? WHERE key = 'data_version'", now));
  try { await db.batch(statements); }
  catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) throw conflict('CONFLICT', '资料冲突（PSD ID 或 Topic 已被使用）', 'Conflict: PSD ID or topic already in use');
    throw e;
  }
  if (shiftChanged && v.defaultShiftId) await generateFromAssignments(db, tomorrow, addDays(tomorrow, 13), now);
  const saved = await first<{ id: number }>(db, 'SELECT id FROM employees WHERE employee_code = ?', v.code);
  return c.json({ ok: true, id: saved?.id });
}

employeeRoutes.post('/employees', (c) => saveEmployee(c, null));
employeeRoutes.put('/employees/:id', (c) => saveEmployee(c, intParam(c, 'id')));

employeeRoutes.post('/employees/:id/deactivate', async (c) => {
  requireAdminRole(c);
  const id = intParam(c, 'id');
  const { reason } = await body(c, z.object({ reason: z.string().trim().min(2).max(300) }));
  const db = c.env.DB;
  const now = Date.now();
  const tz = bizTz(c.env);
  const e = await first<{ employee_code: string; employment_status: string }>(db, 'SELECT employee_code, employment_status FROM employees WHERE id = ?', id);
  if (!e) throw notFound('Employee not found');
  if (e.employment_status !== 'ACTIVE') throw new ApiError(409, 'ALREADY_INACTIVE', { zh: '员工已停用', en: 'Employee is already inactive' });
  const future = await all<{ shift_date: string }>(db, "SELECT shift_date FROM shift_instances WHERE employee_id = ? AND scheduled_start_at > ? AND adjustment_status <> 'CANCELLED'", id, now);
  const actor = c.get('admin').username;
  await db.batch([
    stmt(db, "UPDATE employees SET employment_status = 'INACTIVE', deactivated_at = ?, updated_at = ? WHERE id = ?", now, now, id),
    stmt(db, 'UPDATE telegram_topic_mappings SET valid_until = ?, is_active = 0, updated_at = ? WHERE employee_id = ? AND is_active = 1', now, now, id),
    stmt(db, 'UPDATE employee_shift_assignments SET effective_until = ? WHERE employee_id = ? AND (effective_until IS NULL OR effective_until > ?)', localDate(now, tz), id, localDate(now, tz)),
    stmt(db, "UPDATE shift_instances SET adjustment_status = 'CANCELLED', updated_at = ?, updated_by = ? WHERE employee_id = ? AND scheduled_start_at > ? AND adjustment_status <> 'CANCELLED'", now, actor, id, now),
    auditStmt(db, { actor, action: 'EMPLOYEE_DEACTIVATED', entityType: 'employee', entityId: e.employee_code, before: { status: 'ACTIVE' }, after: { status: 'INACTIVE', cancelled_future_shifts: future.length }, note: reason, ip: clientIp(c), at: now }),
    stmt(db, "UPDATE system_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ? WHERE key = 'data_version'", now),
  ]);
  const settings = await loadSettings(db);
  await afterInstancesChanged(db, future.map((f) => [id, f.shift_date] as Key), { now, tz, rules: settings.rules, byCur: settings.rulesCur });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- export / import (PSD ID, Employee Name, Currency, Chat ID, Thread ID)
employeeRoutes.get('/export/employees', async (c) => {
  const f = query(c, z.object({ q: z.string().max(80).optional().default(''), cur: z.string().trim().toUpperCase().max(10).optional().default(''), status: z.enum(['', 'ACTIVE', 'INACTIVE']).optional().default('') }));
  const cond: string[] = ['1 = 1'];
  const p: unknown[] = [];
  if (f.status) { cond.push('e.employment_status = ?'); p.push(f.status); }
  if (f.cur) { cond.push('e.currency_code = ?'); p.push(f.cur); }
  if (f.q) { cond.push("(e.employee_code LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\')"); p.push(likeEsc(f.q), likeEsc(f.q)); }
  const rows = await all(c.env.DB, `SELECT e.employee_code, e.name, e.currency_code, e.employment_status, m.chat_id, m.message_thread_id
    FROM employees e LEFT JOIN telegram_topic_mappings m ON m.employee_id = e.id AND m.is_active = 1
    WHERE ${cond.join(' AND ')} ORDER BY e.employee_code`, ...p);
  return c.json({ rows });
});

const EmpImportSchema = z.object({
  grid: z.array(z.array(z.union([z.string().max(100), z.number(), z.null()])).max(20)).min(1).max(2000),
  fileName: z.string().max(200).default('employees'),
  apply: z.boolean().default(false),
});

interface ImpRow { row: number; code: string; name: string; currency: string | null; chatId: number | null; threadId: number | null; topicGiven: boolean }

employeeRoutes.post('/employees/import', async (c) => {
  requireAdminRole(c);
  const v = await body(c, EmpImportSchema);
  const db = c.env.DB;
  const actor = c.get('admin').username;
  const ip = clientIp(c);
  const now = Date.now();
  const cell = (r: (string | number | null)[], i: number) => (i < 0 ? '' : String(r[i] ?? '').trim());
  const head = v.grid[0].map((x) => String(x ?? '').trim().toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const ci = { code: col(/^(psd\s*id|employee\s*id|员工编号|id)$/), name: col(/^(employee\s*name|name|员工姓名|姓名)$/), cur: col(/^(currency|货币)$/), chat: col(/^(chat\s*id|chat)$/), thread: col(/^(thread\s*id|thread|topic)$/) };
  if (ci.code < 0 || ci.name < 0) throw bad('HEADER', '第一行需要有「PSD ID」和「Employee Name」栏位', 'The first row needs "PSD ID" and "Employee Name" columns');

  const [empR, curR, mapR] = await db.batch([
    stmt(db, 'SELECT id, employee_code, name, currency_code, employment_status FROM employees'),
    stmt(db, 'SELECT code FROM currencies'),
    stmt(db, 'SELECT m.id, m.employee_id, m.chat_id, m.message_thread_id FROM telegram_topic_mappings m WHERE m.is_active = 1'),
  ]);
  type Emp = { id: number; employee_code: string; name: string; currency_code: string | null; employment_status: string };
  const emps = new Map((empR.results as Emp[]).map((e) => [e.employee_code.toLowerCase(), e]));
  const empById = new Map((empR.results as Emp[]).map((e) => [e.id, e]));
  const curs = new Set((curR.results as { code: string }[]).map((x) => x.code));
  type Map1 = { id: number; employee_id: number; chat_id: number; message_thread_id: number };
  const mapByEmp = new Map((mapR.results as Map1[]).map((m) => [m.employee_id, m]));
  const topicOwner = new Map((mapR.results as Map1[]).map((m) => [`${m.chat_id}|${m.message_thread_id}`, m.employee_id]));

  const errs: { where: string; msg: { zh: string; en: string } }[] = [];
  const rows: ImpRow[] = [];
  const seen = new Set<string>();
  for (let r = 1; r < v.grid.length; r++) {
    const g = v.grid[r];
    const code = cell(g, ci.code);
    if (!code) continue;
    const where = `Row ${r + 1} · ${code}`;
    const e = (zh: string, en: string) => errs.push({ where, msg: { zh, en } });
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(code)) { e('PSD ID 只能用英文字母、数字和 _ . -', 'PSD ID may only contain letters, digits and _ . -'); continue; }
    if (seen.has(code.toLowerCase())) { e('文件里重复出现', 'Appears more than once in the file'); continue; }
    seen.add(code.toLowerCase());
    const old = emps.get(code.toLowerCase());
    const name = cell(g, ci.name) || old?.name || '';
    if (!name || name.length > 100) { e('缺少员工姓名', 'Employee name is missing'); continue; }
    const curRaw = cell(g, ci.cur).toUpperCase();
    const currency = curRaw || old?.currency_code || null;
    if (curRaw && !curs.has(curRaw)) { e(`货币 ${curRaw} 不存在`, `Unknown currency ${curRaw}`); continue; }
    if (!old && !currency) { e('新员工需要填写货币', 'A new employee needs a currency'); continue; }
    let chatRaw = cell(g, ci.chat).replace(/\.0+$/, '');
    const threadRaw = cell(g, ci.thread).replace(/^#/, '').replace(/\.0+$/, '');
    let chatId: number | null = null, threadId: number | null = null;
    const topicGiven = !!threadRaw;
    if (topicGiven) {
      if (/^\d{5,17}$/.test(chatRaw)) chatRaw = '-100' + chatRaw; // t.me/c/<id>/<thread> link form
      if (!/^\d+$/.test(threadRaw)) { e('Thread ID 必须是数字', 'Thread ID must be a number'); continue; }
      if (!/^-100\d{5,17}$/.test(chatRaw)) { e('Chat ID 格式错误（超级群组是 -100 开头）', 'Invalid Chat ID (supergroup ids start with -100)'); continue; }
      chatId = Number(chatRaw); threadId = Number(threadRaw);
    }
    if (old && old.employment_status !== 'ACTIVE') { e('员工已停用，请先在页面上重新启用', 'Employee is deactivated; reactivate them first'); continue; }
    rows.push({ row: r + 1, code: old?.employee_code ?? code, name, currency, chatId, threadId, topicGiven });
  }

  // topic ownership after the import: a topic may belong to one employee only
  const finalTopic = new Map<string, string>(); // topic → code
  for (const [k, empId] of topicOwner) { const e = empById.get(empId); if (e) finalTopic.set(k, e.employee_code); }
  for (const x of rows) { const e = emps.get(x.code.toLowerCase()); if (x.topicGiven && e) { const m = mapByEmp.get(e.id); if (m) finalTopic.delete(`${m.chat_id}|${m.message_thread_id}`); } }
  const ok: ImpRow[] = [];
  for (const x of rows) {
    if (x.topicGiven) {
      const k = `${x.chatId}|${x.threadId}`;
      const holder = finalTopic.get(k);
      if (holder && holder.toLowerCase() !== x.code.toLowerCase()) {
        errs.push({ where: `Row ${x.row} · ${x.code}`, msg: { zh: `Topic #${x.threadId} 已属于 ${holder}`, en: `Topic #${x.threadId} already belongs to ${holder}` } });
        continue;
      }
      finalTopic.set(k, x.code);
    }
    ok.push(x);
  }

  type Ch = ImpRow & { kind: 'NEW' | 'UPDATE'; id: number | null; fields: string[]; oldMap: Map1 | null };
  const changes: Ch[] = [];
  let unchanged = 0;
  for (const x of ok) {
    const old = emps.get(x.code.toLowerCase());
    if (!old) { changes.push({ ...x, kind: 'NEW', id: null, fields: ['name', 'currency', ...(x.topicGiven ? ['topic'] : [])], oldMap: null }); continue; }
    const m = mapByEmp.get(old.id) ?? null;
    const fields: string[] = [];
    if (old.name !== x.name) fields.push('name');
    if ((old.currency_code ?? null) !== x.currency) fields.push('currency');
    if (x.topicGiven && (!m || m.chat_id !== x.chatId || m.message_thread_id !== x.threadId)) fields.push('topic');
    if (!fields.length) { unchanged++; continue; }
    changes.push({ ...x, kind: 'UPDATE', id: old.id, fields, oldMap: m });
  }
  const plan = {
    newCount: changes.filter((x) => x.kind === 'NEW').length, updateCount: changes.filter((x) => x.kind === 'UPDATE').length, unchanged,
    errorCount: errs.length, errors: errs.slice(0, 200),
    changes: changes.slice(0, 300).map((x) => {
      const old = emps.get(x.code.toLowerCase());
      return { kind: x.kind, code: x.code, name: x.name, currency: x.currency, topic: x.topicGiven ? x.threadId : x.oldMap?.message_thread_id ?? null, fields: x.fields,
        before: old ? { name: old.name, currency: old.currency_code, topic: x.oldMap?.message_thread_id ?? null } : null };
    }),
  };
  if (!v.apply) return c.json({ plan });

  // 1) close the topic bindings that move, 2) write employees + new bindings (so a topic can pass from one employee to another)
  const closes: D1PreparedStatement[] = [];
  const writes: D1PreparedStatement[] = [];
  for (const x of changes) {
    const ref = x.id ? String(x.id) : '(SELECT id FROM employees WHERE employee_code = ?)';
    const refP = x.id ? [] : [x.code];
    if (x.kind === 'NEW') {
      writes.push(stmt(db, `INSERT INTO employees (employee_code, name, currency_code, employment_status, default_shift_id, timezone, created_at, updated_at)
                            VALUES (?,?,?,'ACTIVE',NULL,?,?,?)`, x.code, x.name, x.currency, bizTz(c.env), now, now));
    } else if (x.fields.includes('name') || x.fields.includes('currency')) {
      writes.push(stmt(db, 'UPDATE employees SET name = ?, currency_code = ?, updated_at = ? WHERE id = ?', x.name, x.currency, now, x.id));
    }
    if (x.fields.includes('topic') && x.topicGiven) {
      if (x.oldMap) closes.push(stmt(db, 'UPDATE telegram_topic_mappings SET valid_until = ?, is_active = 0, updated_at = ? WHERE id = ?', now, now, x.oldMap.id));
      writes.push(stmt(db, `INSERT INTO telegram_topic_mappings (employee_id, chat_id, message_thread_id, valid_from, valid_until, is_active, created_by, created_at, updated_at)
                            VALUES (${ref}, ?, ?, ?, NULL, 1, ?, ?, ?)`, ...refP, x.chatId, x.threadId, now, actor, now, now));
      writes.push(auditStmt(db, { actor, action: 'TOPIC_MAPPING_CHANGED', entityType: 'telegram_topic_mapping', entityId: x.code,
        before: x.oldMap ? { chat_id: x.oldMap.chat_id, thread_id: x.oldMap.message_thread_id } : null, after: { chat_id: x.chatId, thread_id: x.threadId }, note: `Import ${v.fileName}`, ip, at: now }));
    }
    const old = emps.get(x.code.toLowerCase());
    writes.push(auditStmt(db, { actor, action: x.kind === 'NEW' ? 'EMPLOYEE_CREATED' : 'EMPLOYEE_UPDATED', entityType: 'employee', entityId: x.code,
      before: old ? { name: old.name, currency: old.currency_code, topic: x.oldMap?.message_thread_id ?? null } : null,
      after: { name: x.name, currency: x.currency, topic: x.topicGiven ? x.threadId : x.oldMap?.message_thread_id ?? null }, note: `Import ${v.fileName}`, ip, at: now }));
  }
  writes.push(auditStmt(db, { actor, action: 'EMPLOYEES_IMPORTED', entityType: 'employee', entityId: v.fileName, after: { added: plan.newCount, updated: plan.updateCount, skipped_errors: errs.length }, ip, at: now }));
  writes.push(stmt(db, "UPDATE system_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ? WHERE key = 'data_version'", now));
  try {
    for (const part of chunk([...closes, ...writes], 90)) await db.batch(part);
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) throw conflict('CONFLICT', '资料冲突（PSD ID 或 Topic 已被使用）', 'Conflict: PSD ID or topic already in use');
    throw e;
  }
  return c.json({ plan, applied: { added: plan.newCount, updated: plan.updateCount } });
});
