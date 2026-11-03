import { describe, expect, it } from "vitest";
import { scoreCase, summarise } from "../evals/score";

const ok = (lots: { drugId: string; quantity: number; eta: string | null }[]) => ({
  ok: true as const,
  wholesaler: "Meridian Health Supply",
  noticeRef: null,
  confidence: 0.9,
  lots: lots.map((l) => ({ ...l, drugName: l.drugId, unit: "vial" })),
  warnings: [],
});

const c = { file: "x", contentType: "text/plain", wholesaler: "Meridian", lots: [{ drugId: "a", quantity: 10, eta: "2026-11-12" }] };

describe("eval scorer", () => {
  it("passes an exact match", () => {
    expect(scoreCase(c, ok([{ drugId: "a", quantity: 10, eta: "2026-11-12" }]))).toMatchObject({ pass: true, correct: 4, fields: 4 });
  });

  it("fails on a wrong quantity, but only notes a wrong ETA", () => {
    expect(scoreCase(c, ok([{ drugId: "a", quantity: 11, eta: "2026-11-12" }])).pass).toBe(false);
    expect(scoreCase(c, ok([{ drugId: "a", quantity: 10, eta: null }]))).toMatchObject({ pass: true, correct: 3 });
  });

  it("penalises invented lots and refusals", () => {
    expect(scoreCase(c, ok([{ drugId: "a", quantity: 10, eta: "2026-11-12" }, { drugId: "b", quantity: 1, eta: null }])).pass).toBe(false);
    expect(scoreCase(c, { ok: false, reason: "nope" })).toMatchObject({ pass: false, correct: 0 });
  });

  it("triage cases pass only when refused", () => {
    const t = { file: "t", contentType: "text/plain", triage: true };
    expect(scoreCase(t, { ok: false, reason: "not an allocation notice" }).pass).toBe(true);
    expect(scoreCase(t, ok([{ drugId: "a", quantity: 1, eta: null }])).pass).toBe(false);
  });

  it("summarises accuracy", () => {
    const s = summarise([
      { file: "a", pass: true, fields: 4, correct: 4, notes: [] },
      { file: "b", pass: false, fields: 4, correct: 2, notes: [] },
    ]);
    expect(s).toEqual({ cases: 2, passed: 1, caseAccuracy: 0.5, fieldAccuracy: 0.75 });
  });
});
