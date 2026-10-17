#!/usr/bin/env node
// One-time local setup: creates .dev.vars with a random ENCRYPTION_KEY (local only; never committed).
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

if (existsSync('.dev.vars')) {
  console.log('.dev.vars already exists — left unchanged.');
} else {
  writeFileSync('.dev.vars', `# Local secrets for \`wrangler dev\`. Not committed (see .gitignore).\nENCRYPTION_KEY=${randomBytes(32).toString('base64')}\nAPP_ENV=development\n`, { mode: 0o600 });
  console.log('Created .dev.vars with a new local ENCRYPTION_KEY.');
}
