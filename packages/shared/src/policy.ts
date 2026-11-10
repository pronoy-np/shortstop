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

/**
 * A lot a policy save may move: nothing committed yet, and either open (with planners) or holding an autopilot
 * reservation. `action` is what the lot was routed with last. The service picks these from D1; lots waiting on a
 * pharmacist, committed or partly committed lots are never candidates.
 */
export type RerouteCandidate = LotContext & { lotId: string; status: "open" | "reserved"; action: PolicyAction };

export type Reroute = { lotId: string; to: "autopilot" | "planner"; decision: PolicyDecision };

/**
 * What a newly saved policy changes for lots already on the desk. One pure function, so the preview and the save can
 * never disagree. An open lot moves to autopilot only when the new policy auto-commits it (after the hard floors) and it
 * was not routed to auto-commit before: an open lot whose action is already auto_commit is one a planner took off
 * autopilot, and a re-save must not overrule that person. A reserved lot moves back to planners as soon as the new
 * policy no longer auto-commits it. Everything else stays where it is.
 */
export function planReroutes(rules: PolicyRule[], candidates: readonly RerouteCandidate[]): Reroute[] {
  const out: Reroute[] = [];
  for (const c of candidates) {
    const decision = decide(rules, c);
    if (c.status === "open" && decision.action === "auto_commit" && c.action !== "auto_commit") out.push({ lotId: c.lotId, to: "autopilot", decision });
    else if (c.status === "reserved" && decision.action !== "auto_commit") out.push({ lotId: c.lotId, to: "planner", decision });
  }
  return out;
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
