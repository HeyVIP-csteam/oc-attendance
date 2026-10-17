#!/usr/bin/env node
// LOCAL DEVELOPMENT ONLY — prints SQL with demo employees, topic mappings and a rotating A/B/C roster for the current
// month, and marks the LKR/MYR/USD bots as ACTIVE (without tokens) so the local webhook accepts simulated updates.
//
//   npm run db:seed:demo:local        (never run this against --remote)
//
// Attendance events are NOT inserted here; generate them through the real webhook pipeline with:
//   npm run simulate -- --demo

const CHAT = -1002233445566;
const TZ_OFFSET_MIN = 330; // Asia/Colombo is UTC+05:30 all year (no DST)
const pad = (n) => String(n).padStart(2, '0');
const q = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const now = Date.now();
const lkNow = new Date(now + TZ_OFFSET_MIN * 60000);
const today = lkNow.toISOString().slice(0, 10);
const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const lkToUtc = (d, hhmm) => { const [y, m, dd] = d.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); return Date.UTC(y, m - 1, dd, h, mi) - TZ_OFFSET_MIN * 60000; };
const weekday = (d) => new Date(d + 'T00:00:00Z').getUTCDay();
const monthStart = today.slice(0, 8) + '01';
const monthEnd = (() => { const [y, m] = today.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); })();
const from = [addDays(today, -13), monthStart].sort()[0];
const to = [addDays(today, 1), monthEnd].sort().pop();

const NAMES = ['Nimal Perera', 'Kasun Silva', 'Dilani Fernando', 'Chamara Jayasinghe', 'Sanduni Wickramasinghe', 'Ruwan Bandara', 'Ishara Gunawardena', 'Tharindu Rajapaksa', 'Nadeesha Herath', 'Lahiru Dissanayake',
  'Malsha Senanayake', 'Pradeep Kumara', 'Hiruni Abeysekera', 'Supun Wijesinghe', 'Anusha Ratnayake', 'Dinesh Karunaratne', 'Kavindi Liyanage', 'Chathura Weerasinghe', 'Shehani Peiris', 'Asanka Samarasinghe',
  'Gayani Mendis', 'Buddhika Ekanayake', 'Thilini Amarasinghe', 'Janaka Hettiarachchi', 'Madhavi Kularatne', 'Roshan de Silva', 'Piumi Jayawardena', 'Sachith Gamage', 'Nethmi Ranasinghe', 'Harsha Wanigasekara',
  'Yasodha Munasinghe', 'Charith Alwis', 'Sewwandi Rathnayake', 'Mahesh Pathirana', 'Dulani Kodikara', 'Udara Senaratne', 'Rashmi Dias', 'Isuru Udayanga', 'Oshadi Hapuarachchi', 'Vimukthi Nanayakkara'];
const SHIFTS = { A: ['A Shift', '07:00', '15:00'], B: ['B Shift', '15:00', '23:00'], C: ['C Shift', '23:00', '07:00'] };
const CUR = ['LKR', 'MYR', 'USD'];

const out = [];
out.push(`-- demo seed generated ${new Date(now).toISOString()} for ${from} … ${to}`);
out.push(`UPDATE system_settings SET value = '{"windowHours":4,"lateAsException":false,"botReply":true,"allowedChats":[${CHAT}]}' WHERE key = 'rules';`);
for (const c of CUR) {
  out.push(`UPDATE telegram_bots SET status = 'ACTIVE', username = 'demo_${c.toLowerCase()}_bot', bot_user_id = ${700000000 + CUR.indexOf(c)}, webhook_url = 'https://localhost.invalid/api/telegram/webhook/${c.toLowerCase()}', token_last4 = 'DEMO', updated_at = ${now} WHERE currency_code = '${c}' AND status = 'NOT_SET';`);
}
const T0 = now - 90 * 86400000;
for (let i = 1; i <= 40; i++) {
  const code = 'E' + pad(i).padStart(3, '0');
  out.push(`INSERT OR IGNORE INTO employees (employee_code, name, currency_code, employment_status, timezone, created_at, updated_at) VALUES (${q(code)}, ${q(NAMES[i - 1])}, '${CUR[i % 3]}', 'ACTIVE', 'Asia/Colombo', ${T0}, ${T0});`);
  if (i === 40) continue; // E040: new hire without a topic yet
  out.push(`INSERT OR IGNORE INTO telegram_topic_mappings (employee_id, chat_id, message_thread_id, valid_from, valid_until, is_active, created_by, created_at, updated_at)
  SELECT id, ${CHAT}, ${1000 + i}, ${T0}, NULL, 1, 'demo-seed', ${T0}, ${T0} FROM employees WHERE employee_code = ${q(code)} AND NOT EXISTS (SELECT 1 FROM telegram_topic_mappings m WHERE m.employee_id = employees.id);`);
}
// rotating roster: 3 crews rotate weekly A → B → C, two days off per week
const monday = (d) => addDays(d, weekday(d) === 0 ? -6 : 1 - weekday(d));
for (let i = 1; i <= 40; i++) {
  const code = 'E' + pad(i).padStart(3, '0');
  const crew = (i - 1) % 3;
  const off = [i % 7, (i + 1) % 7];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (off.includes(weekday(d))) continue;
    const week = Math.round((Date.parse(monday(d)) - Date.parse(monday(from))) / (7 * 86400000));
    const sc = ['A', 'B', 'C'][(week + crew) % 3];
    const [name, st, en] = SHIFTS[sc];
    const s = lkToUtc(d, st);
    const e = lkToUtc(en <= st ? addDays(d, 1) : d, en);
    out.push(`INSERT OR IGNORE INTO shift_instances (employee_id, shift_date, shift_id, shift_code, shift_name, timezone, scheduled_start_at, scheduled_end_at, late_grace_min, early_grace_min, break_minutes, source, adjustment_status, created_at, updated_at, updated_by)
  SELECT e.id, '${d}', t.id, '${sc}', '${name}', 'Asia/Colombo', ${s}, ${e}, t.late_grace_min, t.early_grace_min, t.break_minutes, 'ROSTER_IMPORT', 'SCHEDULED', ${now}, ${now}, 'demo-seed'
  FROM employees e, shift_templates t WHERE e.employee_code = '${code}' AND t.code = '${sc}';`);
  }
}
out.push(`INSERT INTO audit_logs (created_at, actor, action, entity_type, entity_id, note) VALUES (${now}, 'demo-seed', 'DEMO_DATA_SEEDED', 'database', 'local', 'Local development demo data');`);
process.stdout.write(out.join('\n') + '\n');
