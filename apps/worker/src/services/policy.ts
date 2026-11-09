import { checkPolicy, PolicyRules, type PolicyRule, type Role } from "@shortstop/shared";
import { z } from "zod";
import type { User } from "../lib/auth";
import { getPolicy, savePolicy, type CurrentPolicy } from "../lib/policy-store";
import { forbidUnless, invalid, invalidField, type Result } from "./result";

export const POLICY_ROLES: readonly Role[] = ["ops_lead"];

const PolicyBody = z.object({ rules: PolicyRules });

export type PolicyVersionView = { version: number; createdBy: string; createdAt: number; rules: PolicyRule[] };
export type PolicyView = { current: CurrentPolicy; versions: PolicyVersionView[] };

/** The current policy (KV-cached) and the last 20 immutable versions. */
export async function loadPolicy(env: Env): Promise<PolicyView> {
  const current = await getPolicy(env);
  const { results: versions } = await env.DB.prepare(
    `SELECT version, created_by AS createdBy, created_at AS createdAt, rules_json AS rulesJson FROM policy_versions ORDER BY version DESC LIMIT 20`,
  ).all<Omit<PolicyVersionView, "rules"> & { rulesJson: string }>();
  return { current, versions: versions.map(({ rulesJson, ...v }) => ({ ...v, rules: JSON.parse(rulesJson) as PolicyRule[] })) };
}

/** Saves a new policy version (ops lead only). Input: `{ rules }`. */
export async function updatePolicy(env: Env, actor: User, input: unknown): Promise<Result<{ policy: CurrentPolicy }>> {
  const denied = forbidUnless(actor, POLICY_ROLES);
  if (denied) return denied;
  const body = PolicyBody.safeParse(input);
  if (!body.success) return invalid(body.error, body.error.issues[0]?.message ?? "invalid rules");
  const issue = checkPolicy(body.data.rules)[0];
  if (issue) return invalidField("rules", `rule ${issue.rule + 1} (${body.data.rules[issue.rule]!.id}) ${issue.message}`);
  return { ok: true, policy: await savePolicy(env, body.data.rules, actor.email) };
}
