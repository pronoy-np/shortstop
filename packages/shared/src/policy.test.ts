import { describe, expect, it } from "vitest";
import { decide, type LotContext } from "./policy";
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
  { id: "small-auto", when: { maxLotQty: 500, minConfidence: 0.85 }, then: "auto_commit" },
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
