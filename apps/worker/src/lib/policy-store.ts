import { PolicyRules, type PolicyRule } from "@shortstop/shared";
import { batchAudited } from "./audit";
import { broadcast } from "./board";

export type CurrentPolicy = { version: number; rules: PolicyRule[] };

const KV_KEY = "policy:current";

async function latestFromD1(env: Env): Promise<CurrentPolicy> {
  const row = await env.DB.prepare(`SELECT version, rules_json FROM policy_versions ORDER BY version DESC LIMIT 1`).first<{
    version: number;
    rules_json: string;
  }>();
  return row ? { version: row.version, rules: PolicyRules.parse(JSON.parse(row.rules_json)) } : { version: 0, rules: [] };
}

/**
 * D1 policy_versions is the source of truth. KV holds the compiled current policy for reads.
 * `fresh` reads D1 directly: the pipeline uses it so a lot is never routed by a policy that KV
 * (eventually consistent, up to ~60 s across locations) hasn't caught up with yet.
 */
export async function getPolicy(env: Env, opts: { fresh?: boolean } = {}): Promise<CurrentPolicy> {
  if (!opts.fresh) {
    const cached = await env.CACHE.get<CurrentPolicy>(KV_KEY, "json");
    if (cached) return cached;
  }
  const policy = await latestFromD1(env);
  if (!opts.fresh) await env.CACHE.put(KV_KEY, JSON.stringify(policy));
  return policy;
}

export async function savePolicy(env: Env, rules: PolicyRule[], actor: string): Promise<CurrentPolicy> {
  // Versions are MAX+1. Two simultaneous saves can pick the same number; the loser re-reads and takes the next one.
  for (let attempt = 0; ; attempt++) {
    const prev = await env.DB.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM policy_versions`).first<{ v: number }>();
    const version = (prev?.v ?? 0) + 1;
    try {
      await batchAudited(
        env,
        [
          env.DB.prepare(`INSERT INTO policy_versions (version, rules_json, created_by, created_at) VALUES (?, ?, ?, ?)`).bind(
            version,
            JSON.stringify(rules),
            actor,
            Date.now(),
          ),
        ],
        [{ id: `policy:${version}`, entity: "policy", entityId: String(version), action: "policy.saved", actor, payload: { rules } }],
      );
    } catch (err) {
      const taken = await env.DB.prepare(`SELECT 1 FROM policy_versions WHERE version = ?`).bind(version).first();
      if (taken && attempt < 4) continue;
      throw err;
    }
    const policy = { version, rules };
    await env.CACHE.put(KV_KEY, JSON.stringify(policy));
    await broadcast(env, { type: "policy.saved", version });
    return policy;
  }
}
