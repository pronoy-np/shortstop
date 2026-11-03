import type { PolicyAction, PolicyRule, Tier } from "./schemas";

export type LotContext = {
  tier: Tier;
  drugClass: string;
  lotQty: number;
  confidence: number;
  needsSubstitute: boolean;
};

export type PolicyDecision = {
  action: PolicyAction;
  ruleId: string | null;
  hardFloor: "tier1" | "substitute" | null;
};

function matches(rule: PolicyRule, ctx: LotContext): boolean {
  const w = rule.when;
  if (w.tier !== undefined && w.tier !== ctx.tier) return false;
  if (w.drugClass !== undefined && w.drugClass !== ctx.drugClass) return false;
  if (w.maxLotQty !== undefined && ctx.lotQty > w.maxLotQty) return false;
  if (w.minConfidence !== undefined && ctx.confidence < w.minConfidence) return false;
  if (w.needsSubstitute !== undefined && w.needsSubstitute !== ctx.needsSubstitute) return false;
  return true;
}

/**
 * First matching rule wins; no match means "propose". Hard floors are applied after the policy
 * and cannot be configured away: tier-1 drugs and substitute cases never auto-commit.
 */
export function decide(rules: PolicyRule[], ctx: LotContext): PolicyDecision {
  const rule = rules.find((r) => matches(r, ctx));
  const action = rule?.then ?? "propose";
  const ruleId = rule?.id ?? null;

  if (action === "auto_commit") {
    if (ctx.tier === 1) return { action: "propose", ruleId, hardFloor: "tier1" };
    if (ctx.needsSubstitute) return { action: "propose", ruleId, hardFloor: "substitute" };
  }
  return { action, ruleId, hardFloor: null };
}
