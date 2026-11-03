import { describe, expect, it } from "vitest";
import { EXTRACTION_MODEL, extractNotice, matchDrug, validateExtraction, type CatalogDrug } from "./extract";

const catalog: CatalogDrug[] = [
  { id: "cisplatin", name: "Cisplatin 1 mg/mL injection 50 mL" },
  { id: "epinephrine-syr", name: "Epinephrine 0.1 mg/mL 10 mL prefilled syringe" },
  { id: "epinephrine-vial", name: "Epinephrine 1 mg/mL 1 mL vial" },
  { id: "amoxicillin-susp", name: "Amoxicillin 400 mg/5 mL oral suspension 100 mL" },
];

const good = {
  isAllocationNotice: true,
  wholesaler: "Meridian Health Supply",
  noticeRef: "ALLOC-123",
  confidence: 0.92,
  lots: [{ drugName: "Cisplatin 50mg/50mL", drugId: "cisplatin", quantity: 120, unit: "vial", eta: "2026-11-10" }],
};

describe("validateExtraction", () => {
  it("accepts a valid object or JSON string", () => {
    for (const raw of [good, JSON.stringify(good)]) {
      const r = validateExtraction(raw, catalog);
      expect(r.ok && r.lots[0]).toEqual({
        drugId: "cisplatin",
        drugName: "Cisplatin 50mg/50mL",
        quantity: 120,
        unit: "vial",
        eta: "2026-11-10",
      });
    }
  });

  it("rejects non-JSON and schema violations", () => {
    expect(validateExtraction("not json", catalog).ok).toBe(false);
    expect(validateExtraction({ ...good, lots: [{ ...good.lots[0], quantity: -4 }] }, catalog).ok).toBe(false);
  });

  it("rejects text that is not an allocation notice", () => {
    expect(validateExtraction({ ...good, isAllocationNotice: false, lots: [] }, catalog)).toEqual({
      ok: false,
      reason: "not an allocation notice",
    });
  });

  it("falls back to fuzzy matching when the model's id is invalid, with lower confidence", () => {
    const r = validateExtraction(
      { ...good, lots: [{ ...good.lots[0], drugId: "made-up", drugName: "Amoxicillin 400mg/5mL susp" }] },
      catalog,
    );
    expect(r.ok && r.lots[0]!.drugId).toBe("amoxicillin-susp");
    expect(r.ok && r.confidence).toBe(0.82);
  });

  it("drops cancelled (zero) lines with a warning instead of failing the notice", () => {
    const r = validateExtraction(
      { ...good, lots: [...good.lots, { drugName: "Propofol", drugId: null, quantity: 0, unit: "vial", eta: null }] },
      catalog,
    );
    expect(r.ok && r.lots).toHaveLength(1);
    expect(r.ok && r.warnings).toEqual(["zero allocation: Propofol"]);
  });

  it("drops unmatched products with a warning, fails if none match", () => {
    const mixed = validateExtraction(
      { ...good, lots: [...good.lots, { drugName: "Unobtainium", drugId: null, quantity: 5, unit: "vial", eta: null }] },
      catalog,
    );
    expect(mixed.ok && mixed.warnings).toEqual(["unmatched product: Unobtainium"]);
    const none = validateExtraction({ ...good, lots: [{ ...good.lots[0], drugId: null, drugName: "Unobtainium" }] }, catalog);
    expect(none.ok).toBe(false);
  });
});

describe("matchDrug", () => {
  it("prefers the closest product and refuses weak matches", () => {
    expect(matchDrug("Epinephrine 1mg/mL vial", catalog)).toBe("epinephrine-vial");
    expect(matchDrug("Epinephrine 0.1 mg/mL syringe", catalog)).toBe("epinephrine-syr");
    expect(matchDrug("Ibuprofen 200 mg", catalog)).toBeNull();
  });
});

describe("extractNotice", () => {
  it("calls the extraction model in JSON mode and validates the result", async () => {
    const calls: unknown[] = [];
    const ai = { run: async (model: string, input: unknown) => (calls.push({ model, input }), { response: good }) };
    const r = await extractNotice(ai, "Allocation notice from Meridian: cisplatin 120 vials", catalog);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { model: string }).model).toBe(EXTRACTION_MODEL);
  });

  it("skips the model for empty text", async () => {
    const ai = { run: async () => { throw new Error("should not be called"); } };
    expect((await extractNotice(ai, "  ", catalog)).ok).toBe(false);
  });
});
