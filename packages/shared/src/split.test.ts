import { describe, expect, it } from "vitest";
import { computeSplit, explainSplit, type SiteStock } from "./split";

const site = (siteId: string, acuity: 1 | 2 | 3, onHand: number, dailyDemand: number, inbound = 0): SiteStock => ({
  siteId,
  acuity,
  onHand,
  inbound,
  dailyDemand,
});

const total = (r: ReturnType<typeof computeSplit>) => r.allocations.reduce((s, a) => s + a.quantity, 0);

describe("computeSplit", () => {
  it("allocates exactly the lot quantity", () => {
    const sites = [site("a", 1, 10, 5), site("b", 2, 40, 4), site("c", 3, 0, 2)];
    for (const qty of [0, 1, 7, 100, 999]) expect(total(computeSplit(qty, sites))).toBe(qty);
  });

  it("fills the lowest cover first", () => {
    const r = computeSplit(10, [site("a", 3, 100, 1), site("b", 3, 0, 1)]);
    expect(r.allocations).toEqual([{ siteId: "b", quantity: 10 }]);
  });

  it("equalises weighted cover with identical sites", () => {
    const r = computeSplit(90, [site("a", 3, 0, 1), site("b", 3, 0, 1), site("c", 3, 0, 1)]);
    expect(r.allocations.map((a) => a.quantity)).toEqual([30, 30, 30]);
  });

  it("weights higher-acuity sites toward more cover", () => {
    const r = computeSplit(250, [site("icu", 1, 0, 1), site("comm", 3, 0, 1)]);
    const icu = r.allocations.find((a) => a.siteId === "icu")!.quantity;
    expect(icu).toBe(150); // 1.5 : 1.0
  });

  it("counts inbound supply toward cover", () => {
    const r = computeSplit(10, [site("a", 3, 0, 1, 50), site("b", 3, 0, 1)]);
    expect(r.allocations).toEqual([{ siteId: "b", quantity: 10 }]);
  });

  it("ignores sites with no demand", () => {
    const r = computeSplit(20, [site("a", 1, 0, 0), site("b", 3, 0, 2)]);
    expect(r.allocations).toEqual([{ siteId: "b", quantity: 20 }]);
  });

  it("is deterministic regardless of input order", () => {
    const sites = [site("x", 2, 3, 1.3), site("y", 1, 7, 2.1), site("z", 3, 1, 0.7)];
    expect(computeSplit(37, sites)).toEqual(computeSplit(37, [...sites].reverse()));
  });

  it("flags a shortfall below the cover floor", () => {
    expect(computeSplit(5, [site("a", 3, 0, 10)]).shortfall).toBe(true);
    expect(computeSplit(500, [site("a", 3, 0, 10)]).shortfall).toBe(false);
  });

  it("rejects bad quantities", () => {
    expect(() => computeSplit(-1, [])).toThrow();
    expect(() => computeSplit(1.5, [])).toThrow();
  });

  it("explains the split in plain text", () => {
    const sites = [{ ...site("a", 1, 0, 5), siteName: "Alpha" }, site("b", 3, 0, 1)];
    const text = explainSplit(60, "vial", sites, computeSplit(60, sites));
    expect(text).toContain("60 vials");
    expect(text).toContain("Alpha");
  });
});
