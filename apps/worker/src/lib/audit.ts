export type AuditEntry = {
  id?: string;
  entity: "notice" | "lot" | "policy" | "system";
  entityId: string;
  action: string;
  actor: string;
  payload?: unknown;
  /** Logged on the [AUDIT] line. Defaults to "ok" (the change committed). */
  outcome?: "ok" | "rejected";
  /** Only write the row if this SELECT returns a row, evaluated inside the same transaction. */
  onlyIf?: { sql: string; binds: unknown[] };
};

type Stamped = AuditEntry & { id: string; at: number };

function insert(env: Env, e: Stamped) {
  const values = [e.id, e.entity, e.entityId, e.action, e.actor, JSON.stringify(e.payload ?? {}), e.at];
  const cols = `INSERT OR IGNORE INTO audit_log (id, entity, entity_id, action, actor, payload_json, at)`;
  return e.onlyIf
    ? env.DB.prepare(`${cols} SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${e.onlyIf.sql})`).bind(...values, ...e.onlyIf.binds)
    : env.DB.prepare(`${cols} VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(...values);
}

/**
 * Runs the state-change statements and their audit rows in one D1 batch (one transaction).
 * The [AUDIT] log line is emitted only after the batch commits, and only for rows actually
 * inserted, so failed writes and idempotent replays never produce a log line.
 * Give entries a stable `id` wherever the change can be retried.
 */
export async function batchAudited(env: Env, stmts: D1PreparedStatement[], audits: AuditEntry[]): Promise<D1Result[]> {
  const at = Date.now();
  const stamped: Stamped[] = audits.map((e) => ({ ...e, id: e.id ?? crypto.randomUUID(), at }));
  const results = await env.DB.batch([...stmts, ...stamped.map((e) => insert(env, e))]);
  results.slice(stmts.length).forEach((r, i) => {
    if (r.meta.changes > 0) {
      const { onlyIf: _, outcome, ...e } = stamped[i]!;
      // Structured, grep-able: wrangler tail | grep AUDIT
      console.log(`[AUDIT] ${JSON.stringify({ ts: new Date(e.at).toISOString(), actor: e.actor, action: e.action, target: `${e.entity}:${e.entityId}`, outcome: outcome ?? "ok", id: e.id, payload: e.payload ?? {} })}`);
    }
  });
  return results;
}

export const audit = (env: Env, e: AuditEntry) => batchAudited(env, [], [e]);
