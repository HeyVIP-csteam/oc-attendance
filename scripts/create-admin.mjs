#!/usr/bin/env node
// Creates (or resets the password of) a dashboard administrator.
//
//   npm run admin:create -- --local            # local D1 used by `wrangler dev`
//   npm run admin:create -- --remote           # production D1
//   options: --username owner --role admin|viewer
//
// The password is typed interactively (hidden) or piped on stdin, never passed as an argument, so it does not end up
// in shell history. Only a PBKDF2-SHA256 hash is written to the database; the SQL file is deleted right after use.

import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const target = args.includes('--remote') ? '--remote' : args.includes('--local') ? '--local' : null;
if (!target) { console.error('Specify --local or --remote'); process.exit(1); }
const role = opt('role', 'admin');
if (!['admin', 'viewer'].includes(role)) { console.error('--role must be admin or viewer'); process.exit(1); }

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else rl.output.write('*'); };
    }
    rl.question(question, (a) => { rl.close(); if (hidden && process.stdin.isTTY) process.stdout.write('\n'); resolve(a); });
  });
}

const username = opt('username') ?? (await ask('Username: ')).trim();
if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) { console.error('Username: 3–64 chars of letters, digits, _ . @ -'); process.exit(1); }
const password = await ask('Password (min 12 chars): ', true);
if (password.length < 12) { console.error('Password must be at least 12 characters'); process.exit(1); }
if (process.stdin.isTTY) {
  const again = await ask('Repeat password: ', true);
  if (again !== password) { console.error('Passwords do not match'); process.exit(1); }
}

const iterations = 100000; // must match PBKDF2_ITERATIONS in src/worker/lib/crypto.ts
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const stored = `pbkdf2-sha256$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const now = Date.now();
const sql = `INSERT INTO admin_users (username, password_hash, role, is_active, failed_attempts, created_at, updated_at)
VALUES (${q(username)}, ${q(stored)}, ${q(role)}, 1, 0, ${now}, ${now})
ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role, is_active = 1, failed_attempts = 0, locked_until = NULL, updated_at = excluded.updated_at;
DELETE FROM admin_sessions WHERE admin_id = (SELECT id FROM admin_users WHERE username = ${q(username)});
INSERT INTO audit_logs (created_at, actor, action, entity_type, entity_id, note) VALUES (${now}, 'cli', 'ADMIN_USER_SET', 'admin_user', ${q(username)}, ${q(`role=${role}`)});
`;

const dir = join(process.cwd(), '.wrangler', 'tmp');
mkdirSync(dir, { recursive: true });
const file = join(dir, `admin-${now}.sql`);
writeFileSync(file, sql, { mode: 0o600 });
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', target, '--file', file, '--yes'], { stdio: 'inherit' });
  console.log(`\n✓ Admin "${username}" (${role}) saved to the ${target === '--remote' ? 'production' : 'local'} database.`);
} finally {
  rmSync(file, { force: true });
}
