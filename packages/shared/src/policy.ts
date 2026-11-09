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

/** A problem with a saved policy. `rule` is the 0-based index of the offending rule. */
export type PolicyIssue = { rule: number; message: string };

/** The hard floors as rules, for display: they cap the outcome after the policy runs (see `decide`). */
export const HARD_FLOORS = [
  { id: "floor-tier1", when: { tier: 1 }, label: "Tier-1 drugs never auto-commit" },
  { id: "floor-substitute", when: { needsSubstitute: true }, label: "Substitute cases wait for a pharmacist" },
] as const;

/** True when every lot `later` matches is also matched by `earlier`, so `later` can never fire. */
function covers(earlier: PolicyRule["when"], later: PolicyRule["when"]): boolean {
  if (earlier.tier !== undefined && earlier.tier !== later.tier) return false;
  if (earlier.drugClass !== undefined && earlier.drugClass !== later.drugClass) return false;
  if (earlier.needsSubstitute !== undefined && earlier.needsSubstitute !== later.needsSubstitute) return false;
  if (earlier.maxLotQty !== undefined && (later.maxLotQty === undefined || later.maxLotQty > earlier.maxLotQty)) return false;
  if (earlier.minConfidence !== undefined && (later.minConfidence === undefined || later.minConfidence < earlier.minConfidence))
    return false;
  return true;
}

const ACTION_WORDS: Record<PolicyAction, string> = { auto_commit: "auto-commit", propose: "propose", manual_only: "manual only" };

/**
 * Rules that can't do what they say: an auto-commit rule aimed at tier 1 or at lots that may need a
 * substitute (it must say "not needed", so the rule never claims more than the floors allow), and a
 * rule that an earlier rule already catches (first match wins, so it never fires). Saving refuses
 * any of these. `PolicyRules` stays shape-only so versions saved before this check still load.
 */
export function checkPolicy(rules: PolicyRule[]): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  rules.forEach((rule, i) => {
    if (rule.then === "auto_commit" && rule.when.tier === 1)
      issues.push({ rule: i, message: "can never auto-commit: tier-1 drugs always need a person (hard floor)" });
    if (rule.then === "auto_commit" && rule.when.needsSubstitute !== false)
      issues.push({
        rule: i,
        message: "auto-commits only lots that need no substitute: set Needs substitute to “no” (substitute cases always wait for a pharmacist)",
      });
    const j = rules.findIndex((earlier, k) => k < i && covers(earlier.when, rule.when));
    if (j === -1) return;
    const earlier = rules[j]!;
    issues.push({
      rule: i,
      message:
        earlier.then === rule.then
          ? `never matches: rule ${j + 1} (${earlier.id}) already catches every lot it would`
          : `contradicts rule ${j + 1} (${earlier.id}): that rule catches the same lots first and says ${ACTION_WORDS[earlier.then]}, so this ${ACTION_WORDS[rule.then]} never applies`,
    });
  });
  return issues;
}
