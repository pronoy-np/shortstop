import { PolicyRules, type PolicyRule } from "@shortstop/shared";
import { auditStmt } from "./audit";
import { broadcast } from "./board";

export type CurrentPolicy = { version: number; rules: PolicyRule[] };

const KV_KEY = "policy:current";

/** KV holds the compiled current policy; D1 policy_versions is the source of truth. */
export async function getPolicy(env: Env): Promise<CurrentPolicy> {
  const cached = await env.CACHE.get<CurrentPolicy>(KV_KEY, "json");
  if (cached) return cached;
  const row = await env.DB.prepare(`SELECT version, rules_json FROM policy_versions ORDER BY version DESC LIMIT 1`).first<{
    version: number;
    rules_json: string;
  }>();
  const policy: CurrentPolicy = row
    ? { version: row.version, rules: PolicyRules.parse(JSON.parse(row.rules_json)) }
    : { version: 0, rules: [] };
  await env.CACHE.put(KV_KEY, JSON.stringify(policy));
  return policy;
}

export async function savePolicy(env: Env, rules: PolicyRule[], actor: string): Promise<CurrentPolicy> {
  const prev = await env.DB.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM policy_versions`).first<{ v: number }>();
  const version = (prev?.v ?? 0) + 1;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO policy_versions (version, rules_json, created_by, created_at) VALUES (?, ?, ?, ?)`).bind(
      version,
      JSON.stringify(rules),
      actor,
      Date.now(),
    ),
    auditStmt(env, { entity: "policy", entityId: String(version), action: "policy.saved", actor, payload: { rules } }),
  ]);
  const policy = { version, rules };
  await env.CACHE.put(KV_KEY, JSON.stringify(policy));
  await broadcast(env, { type: "policy.saved", version });
  return policy;
}
