// Small helpers around the D1 binding.
// D1 has no interactive transactions: every multi-statement write goes through db.batch(), which runs the
// statements sequentially inside one implicit transaction (all succeed or all roll back).

export type Row = Record<string, unknown>;

export async function first<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first<T>()) ?? null;
}

export async function all<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...params).all<T>();
  return r.results ?? [];
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

export const stmt = (db: D1Database, sql: string, ...params: unknown[]): D1PreparedStatement => db.prepare(sql).bind(...params);

/** Runs statements in batches of `size` (each batch is atomic on its own). */
export async function batchChunked(db: D1Database, statements: D1PreparedStatement[], size = 80): Promise<void> {
  for (let i = 0; i < statements.length; i += size) await db.batch(statements.slice(i, i + size));
}

/** Statement that bumps the data version the dashboard polls (1 row write). */
export const bumpVersion = (db: D1Database, now: number): D1PreparedStatement =>
  stmt(db, "UPDATE system_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ? WHERE key = 'data_version'", now);

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** (employee_id, work_date) IN (VALUES (?,?),…) helper — D1 allows at most 100 bound parameters per statement. */
export function pairsIn(column: string, pairs: [number, string][]): { sql: string; params: unknown[] } {
  return {
    sql: `${column} IN (VALUES ${pairs.map(() => '(?,?)').join(',')})`,
    params: pairs.flatMap(([a, b]) => [a, b]),
  };
}

export const isConstraintError = (e: unknown): boolean => /UNIQUE constraint|constraint failed|SQLITE_CONSTRAINT/i.test(String((e as Error)?.message ?? e));
