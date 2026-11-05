import { z } from "zod";
import { invalid, type Result } from "./result";

const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), entityId: z.string().max(100).optional() });

export type AuditEntryView = { id: string; entity: string; entity_id: string; action: string; actor: string; at: number; payload: unknown };

/** Newest audit entries, optionally for one entity. Input: `{ limit?, entityId? }` (strings are coerced, as from a query). */
export async function loadAudit(env: Env, input: unknown): Promise<Result<{ entries: AuditEntryView[] }>> {
  const q = AuditQuery.safeParse(input ?? {});
  if (!q.success) return invalid(q.error, "limit must be 1-500");
  const { limit, entityId } = q.data;
  const stmt = entityId
    ? env.DB.prepare(`SELECT * FROM audit_log WHERE entity_id = ? ORDER BY at DESC LIMIT ?`).bind(entityId, limit)
    : env.DB.prepare(`SELECT * FROM audit_log ORDER BY at DESC LIMIT ?`).bind(limit);
  const { results } = await stmt.all<Omit<AuditEntryView, "payload"> & { payload_json: string }>();
  return { ok: true, entries: results.map(({ payload_json, ...r }) => ({ ...r, payload: JSON.parse(payload_json) as unknown })) };
}
