import { describe, expect, it } from "vitest";
import { buildPrecedentMessages, firstSentences, groundedSources, lotSummary } from "./precedent";

const past = [
  { lotId: "n_a-1", summary: "Cisplatin 1 mg/mL: 120 vials allocated by Northstar." },
  { lotId: "n_b-2", summary: "Carboplatin 10 mg/mL: 80 vials allocated by Meridian." },
];

describe("precedent grounding", () => {
  it("accepts a note that cites only provided records", () => {
    expect(groundedSources("Last cycle Northstar sent only 120 vials [1].", past)).toEqual(["n_a-1"]);
    expect(groundedSources("Both platinum lots ran short [1][2] [1].", past)).toEqual(["n_a-1", "n_b-2"]);
  });

  it("discards uncited, out-of-range or NONE answers", () => {
    expect(groundedSources("Supply has been tight.", past)).toBeNull();
    expect(groundedSources("See record [3].", past)).toBeNull();
    expect(groundedSources("NONE", past)).toBeNull();
    expect(groundedSources("  ", past)).toBeNull();
  });

  it("trims long answers to two sentences, keeping trailing citations", () => {
    expect(firstSentences("One [1]. Two. Three [2].")).toBe("One [1]. Two.");
    expect(firstSentences("Short note [1].")).toBe("Short note [1].");
    expect(firstSentences("Cut off mid sentence [1]. Second part")).toBe("Cut off mid sentence [1].");
  });

  it("numbers past records in the prompt and forbids invention", () => {
    const [system, user] = buildPrecedentMessages("Cisplatin 150 vials", past);
    expect(system!.content).toContain("ONLY");
    expect(user!.content).toContain("[2] Carboplatin");
  });

  it("builds one stable summary per lot", () => {
    const s = lotSummary({
      lotId: "x", noticeId: "n", drugId: "cisplatin", drugName: "Cisplatin", drugClass: "oncology",
      wholesaler: "Northstar", quantity: 150, unit: "vial", eta: null, explanation: "Split across 6 sites.",
    });
    expect(s).toBe("Cisplatin (oncology): 150 vials allocated by Northstar, ETA not stated. Split across 6 sites.");
  });
});
