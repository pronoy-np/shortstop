import { describe, expect, it } from "vitest";
import { checkPolicy, decide, planReroutes, type LotContext, type RerouteCandidate } from "./policy";
import { PolicyRules, type PolicyRule } from "./schemas";

const ctx = (over: Partial<LotContext> = {}): LotContext => ({
  tier: 2,
  drugClass: "antiemetic",
  lotQty: 200,
  confidence: 0.95,
  needsSubstitute: false,
  ...over,
});

const rules: PolicyRule[] = [
  { id: "antibiotics-propose", when: { drugClass: "antibiotic" }, then: "propose" },
  { id: "small-auto", when: { maxLotQty: 500, minConfidence: 0.85, needsSubstitute: false }, then: "auto_commit" },
  { id: "glp1-manual", when: { drugClass: "glp1" }, then: "manual_only" },
];

describe("decide", () => {
  it("first matching rule wins", () => {
    expect(decide(rules, ctx({ drugClass: "antibiotic" }))).toEqual({
      action: "propose",
      ruleId: "antibiotics-propose",
      hardFloor: null,
    });
    expect(decide(rules, ctx())).toEqual({ action: "auto_commit", ruleId: "small-auto", hardFloor: null });
  });

  it("checks every condition in a rule", () => {
    expect(decide(rules, ctx({ lotQty: 501 })).ruleId).toBeNull();
    expect(decide(rules, ctx({ confidence: 0.5 })).ruleId).toBeNull();
  });

  it("defaults to propose when nothing matches", () => {
    expect(decide([], ctx())).toEqual({ action: "propose", ruleId: null, hardFloor: null });
  });

  it("hard floor: tier-1 never auto-commits, even with an explicit rule", () => {
    const allAuto: PolicyRule[] = [{ id: "everything", when: {}, then: "auto_commit" }];
    expect(decide(allAuto, ctx({ tier: 1 }))).toEqual({ action: "propose", ruleId: "everything", hardFloor: "tier1" });
  });

  it("hard floor: substitutes never auto-commit", () => {
    const allAuto: PolicyRule[] = [{ id: "everything", when: {}, then: "auto_commit" }];
    expect(decide(allAuto, ctx({ needsSubstitute: true })).hardFloor).toBe("substitute");
  });

  it("manual_only passes through untouched", () => {
    expect(decide(rules, ctx({ drugClass: "glp1", lotQty: 9999 })).action).toBe("manual_only");
  });
});

describe("PolicyRules schema", () => {
  it("rejects duplicate ids and unknown conditions", () => {
    expect(PolicyRules.safeParse([rules[0], rules[0]]).success).toBe(false);
    expect(PolicyRules.safeParse([{ id: "x", when: { colour: "red" }, then: "propose" }]).success).toBe(false);
    expect(PolicyRules.safeParse(rules).success).toBe(true);
  });
});

describe("checkPolicy", () => {
  const rule = (id: string, when: PolicyRule["when"], then: PolicyRule["then"]): PolicyRule => ({ id, when, then });

  it("accepts the seed-style policy and an empty one", () => {
    expect(checkPolicy(rules)).toEqual([]);
    expect(checkPolicy([])).toEqual([]);
  });

  it("refuses auto-commit rules that only match hard-floor lots", () => {
    expect(checkPolicy([rule("t1", { tier: 1, needsSubstitute: false }, "auto_commit")])).toMatchObject([{ rule: 0, message: expect.stringContaining("tier-1") }]);
    expect(checkPolicy([rule("sub", { needsSubstitute: true }, "auto_commit")])).toMatchObject([{ rule: 0 }]);
    // Stricter than the floor is fine; tier "any" on an auto-commit rule means tiers 2 and 3.
    expect(checkPolicy([rule("t1", { tier: 1 }, "manual_only"), rule("all", { needsSubstitute: false }, "auto_commit")])).toEqual([]);
  });

  it("makes an auto-commit rule say Needs substitute = no", () => {
    expect(checkPolicy([rule("any-sub", { tier: 2 }, "auto_commit")])).toMatchObject([{ rule: 0, message: expect.stringContaining("Needs substitute") }]);
    expect(checkPolicy([rule("no-sub", { tier: 2, needsSubstitute: false }, "auto_commit")])).toEqual([]);
  });

  it("refuses a later rule an earlier one already catches with another action", () => {
    const issues = checkPolicy([rule("a", { drugClass: "glp1", needsSubstitute: false }, "auto_commit"), rule("b", { drugClass: "glp1", tier: 2, needsSubstitute: false }, "manual_only")]);
    expect(issues).toMatchObject([{ rule: 1, message: expect.stringContaining("contradicts rule 1") }]);
  });

  it("refuses an exact duplicate condition set", () => {
    expect(checkPolicy([rule("a", { tier: 2 }, "propose"), rule("b", { tier: 2 }, "propose")])).toMatchObject([
      { rule: 1, message: expect.stringContaining("never matches") },
    ]);
  });

  it("compares numeric bounds by coverage", () => {
    const small = rule("small", { maxLotQty: 500, needsSubstitute: false }, "auto_commit");
    expect(checkPolicy([small, rule("tiny", { maxLotQty: 100, needsSubstitute: false }, "propose")])).toHaveLength(1);
    expect(checkPolicy([small, rule("big", { maxLotQty: 900 }, "propose")])).toEqual([]);
    const sure = rule("sure", { minConfidence: 0.8, needsSubstitute: false }, "auto_commit");
    expect(checkPolicy([sure, rule("surer", { minConfidence: 0.9, needsSubstitute: false }, "propose")])).toHaveLength(1);
    expect(checkPolicy([sure, rule("less", { minConfidence: 0.5 }, "propose")])).toEqual([]);
  });

  it("allows partial overlaps, where order decides", () => {
    expect(checkPolicy([rule("a", { tier: 2, needsSubstitute: false }, "auto_commit"), rule("b", { drugClass: "glp1" }, "manual_only")])).toEqual([]);
  });
});

describe("planReroutes", () => {
  const auto: PolicyRule = { id: "small-auto", when: { maxLotQty: 100, needsSubstitute: false }, then: "auto_commit" };
  const c = (lotId: string, over: Partial<RerouteCandidate> = {}): RerouteCandidate => ({ ...ctx({ lotQty: 50 }), lotId, status: "open", action: "propose", ...over });

  it("moves open lots the new rules auto-commit, and reserved lots they no longer do", () => {
    const out = planReroutes([auto], [c("a"), c("b", { status: "reserved", action: "auto_commit", lotQty: 500 }), c("c", { lotQty: 500 })]);
    expect(out.map((r) => [r.lotId, r.to])).toEqual([
      ["a", "autopilot"],
      ["b", "planner"],
    ]);
    expect(out[0]!.decision).toEqual({ action: "auto_commit", ruleId: "small-auto", hardFloor: null });
  });

  it("keeps the hard floors, and never overrules a planner who took a lot off autopilot", () => {
    const wide: PolicyRule = { id: "all-auto", when: {}, then: "auto_commit" };
    expect(planReroutes([wide], [c("t1", { tier: 1 }), c("sub", { needsSubstitute: true }), c("off", { action: "auto_commit" })])).toEqual([]);
    expect(planReroutes([wide], [c("r", { status: "reserved", action: "auto_commit", tier: 1 })])).toEqual([
      { lotId: "r", to: "planner", decision: { action: "propose", ruleId: "all-auto", hardFloor: "tier1" } },
    ]);
  });
});
