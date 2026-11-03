export type AuditEntry = {
  id?: string;
  entity: "notice" | "lot" | "policy" | "system";
  entityId: string;
  action: string;
  actor: string;
  payload?: unknown;
};

/** Statement for a durable audit row (idempotent when `id` is stable), plus the [AUDIT] log line. */
export function auditStmt(env: Env, e: AuditEntry): D1PreparedStatement {
  const at = Date.now();
  const id = e.id ?? crypto.randomUUID();
  console.log(`[AUDIT] ${JSON.stringify({ ...e, id, at })}`);
  return env.DB.prepare(
    `INSERT OR IGNORE INTO audit_log (id, entity, entity_id, action, actor, payload_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, e.entity, e.entityId, e.action, e.actor, JSON.stringify(e.payload ?? {}), at);
}

export const audit = (env: Env, e: AuditEntry) => auditStmt(env, e).run();
