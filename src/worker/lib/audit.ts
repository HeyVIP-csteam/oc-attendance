import { stmt } from './db';

/** Returns an INSERT statement for the append-only audit log (add it to the same batch as the change it records). */
export function auditStmt(
  db: D1Database,
  a: { actor: string; action: string; entityType: string; entityId?: string | number | null; before?: unknown; after?: unknown; note?: string | null; ip?: string | null; at: number },
): D1PreparedStatement {
  const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
  return stmt(
    db,
    'INSERT INTO audit_logs (created_at, actor, action, entity_type, entity_id, before_json, after_json, note, ip) VALUES (?,?,?,?,?,?,?,?,?)',
    a.at, a.actor, a.action, a.entityType, a.entityId == null ? null : String(a.entityId), j(a.before), j(a.after), a.note ?? null, a.ip ?? null,
  );
}

/** Log a structured line without secrets (Workers Logs / `wrangler tail`). */
export function log(level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...data });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
