// A D1Database-compatible adapter over Node's built-in SQLite (node:sqlite), used only by the tests.
// It applies the real migrations from ./migrations, enforces foreign keys like D1, runs batch() atomically like D1,
// and can inject a failure into the next batch to test "database write failed" handling.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Param = string | number | bigint | null | Uint8Array;
const norm = (v: unknown): Param => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Param));
const returnsRows = (sql: string) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

class ShimStatement {
  constructor(private shim: D1Shim, readonly sql: string, readonly params: Param[] = []) {}
  bind(...params: unknown[]): ShimStatement { return new ShimStatement(this.shim, this.sql, params.map(norm)); }
  exec(): { results: Record<string, unknown>[]; changes: number; lastRowId: number } {
    this.shim.queries++;
    const st = this.shim.sqlite.prepare(this.sql);
    if (returnsRows(this.sql)) {
      const rows = st.all(...this.params) as Record<string, unknown>[];
      return { results: rows.map((r) => ({ ...r })), changes: 0, lastRowId: 0 };
    }
    const r = st.run(...this.params);
    return { results: [], changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
  }
  async first<T>(col?: string): Promise<T | null> {
    const r = this.exec().results[0];
    if (!r) return null;
    return (col ? r[col] : r) as T;
  }
  async all<T>() { const r = this.exec(); return { results: r.results as T[], success: true, meta: { changes: r.changes, last_row_id: r.lastRowId } }; }
  async run() { const r = this.exec(); return { results: r.results, success: true, meta: { changes: r.changes, last_row_id: r.lastRowId } }; }
  async raw() { return this.exec().results.map((r) => Object.values(r)); }
}

export class D1Shim {
  sqlite: DatabaseSync;
  queries = 0;
  batches = 0;
  /** When set, the next batch whose SQL matches throws (simulating a D1 write failure) and the flag resets. */
  failNextBatch: RegExp | null = null;

  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    const dir = join(import.meta.dirname, '..', 'migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) this.sqlite.exec(readFileSync(join(dir, f), 'utf8'));
  }
  prepare(sql: string) { return new ShimStatement(this, sql); }
  async batch(statements: ShimStatement[]) {
    this.batches++;
    if (this.failNextBatch && statements.some((s) => this.failNextBatch!.test(s.sql))) {
      this.failNextBatch = null;
      throw new Error('D1_ERROR: simulated storage failure');
    }
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => { const r = s.exec(); return { results: r.results, success: true, meta: { changes: r.changes, last_row_id: r.lastRowId } }; });
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql: string) { this.sqlite.exec(sql); return { count: 1, duration: 0 }; }
  /** synchronous helpers for assertions */
  get<T = Record<string, unknown>>(sql: string, ...p: unknown[]): T | undefined { const r = this.sqlite.prepare(sql).get(...p.map(norm)); return r ? ({ ...r } as T) : undefined; }
  rows<T = Record<string, unknown>>(sql: string, ...p: unknown[]): T[] { return (this.sqlite.prepare(sql).all(...p.map(norm)) as Record<string, unknown>[]).map((r) => ({ ...r }) as T); }
  x(sql: string, ...p: unknown[]) { return this.sqlite.prepare(sql).run(...p.map(norm)); }
}
