import type { ExtractionResult } from "@shortstop/shared";

export type ExpectedLot = { drugId: string; quantity: number; eta: string | null };
export type EvalCase = { file: string; contentType: string; triage?: boolean; wholesaler?: string; lots?: ExpectedLot[] };

export type CaseScore = {
  file: string;
  pass: boolean;
  fields: number;
  correct: number;
  notes: string[];
};

/**
 * Field-level scoring. Per expected lot: right drug (1), right quantity (1), right ETA (1); plus the wholesaler (1).
 * Extra lots the model invented count as wrong fields. A case passes only when every drug and quantity is right
 * (ETA misses are reported but do not fail the case: a wrong date is caught by the planner, a wrong quantity is not).
 * Triage cases pass only when the pipeline refuses the notice.
 */
export function scoreCase(c: EvalCase, r: ExtractionResult): CaseScore {
  if (c.triage) {
    return { file: c.file, pass: !r.ok, fields: 1, correct: r.ok ? 0 : 1, notes: r.ok ? [`expected triage, got ${r.lots.length} lots`] : [r.reason] };
  }
  const expected = c.lots ?? [];
  if (!r.ok) return { file: c.file, pass: false, fields: expected.length * 3 + 1, correct: 0, notes: [`refused: ${r.reason}`] };

  const notes: string[] = [];
  let correct = 0;
  let fields = 1;
  if (c.wholesaler && r.wholesaler.toLowerCase().includes(c.wholesaler.toLowerCase())) correct++;
  else notes.push(`wholesaler "${r.wholesaler}"`);

  let critical = true;
  for (const e of expected) {
    fields += 3;
    const got = r.lots.find((l) => l.drugId === e.drugId);
    if (!got) {
      critical = false;
      notes.push(`missing ${e.drugId}`);
      continue;
    }
    correct++;
    if (got.quantity === e.quantity) correct++;
    else {
      critical = false;
      notes.push(`${e.drugId} qty ${got.quantity} ≠ ${e.quantity}`);
    }
    if ((got.eta ?? null) === e.eta) correct++;
    else notes.push(`${e.drugId} eta ${got.eta} ≠ ${e.eta}`);
  }
  const extra = r.lots.filter((l) => !expected.some((e) => e.drugId === l.drugId));
  for (const x of extra) {
    fields++;
    critical = false;
    notes.push(`unexpected ${x.drugId}`);
  }
  return { file: c.file, pass: critical, fields, correct, notes };
}

export function summarise(scores: CaseScore[]) {
  const fields = scores.reduce((s, x) => s + x.fields, 0);
  const correct = scores.reduce((s, x) => s + x.correct, 0);
  return {
    cases: scores.length,
    passed: scores.filter((s) => s.pass).length,
    caseAccuracy: scores.filter((s) => s.pass).length / scores.length,
    fieldAccuracy: correct / fields,
  };
}
