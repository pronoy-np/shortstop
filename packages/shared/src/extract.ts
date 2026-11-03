import { ExtractedNotice } from "./schemas";

// 8B "fast" model keeps a notice well under the free 10k neurons/day. Verified against Workers AI JSON mode docs.
export const EXTRACTION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const MAX_INPUT_CHARS = 12_000;

export type CatalogDrug = { id: string; name: string };

export type AiRunner = { run(model: string, input: Record<string, unknown>): Promise<unknown> };

export type ExtractedLotResolved = {
  drugId: string;
  drugName: string;
  quantity: number;
  unit: string;
  eta: string | null;
};

export type ExtractionResult =
  | {
      ok: true;
      wholesaler: string;
      noticeRef: string | null;
      confidence: number;
      lots: ExtractedLotResolved[];
      warnings: string[];
    }
  | { ok: false; reason: string };

export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    isAllocationNotice: { type: "boolean" },
    wholesaler: { type: "string" },
    noticeRef: { type: ["string", "null"] },
    lots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          drugName: { type: "string" },
          drugId: { type: ["string", "null"] },
          quantity: { type: "integer" },
          unit: { type: "string" },
          eta: { type: ["string", "null"], description: "YYYY-MM-DD" },
        },
        required: ["drugName", "drugId", "quantity", "unit", "eta"],
      },
    },
    confidence: { type: "number" },
  },
  required: ["isAllocationNotice", "wholesaler", "noticeRef", "lots", "confidence"],
} as const;

export function buildExtractionMessages(text: string, catalog: CatalogDrug[]) {
  const system = [
    "You extract structured data from drug wholesaler allocation notices sent to a hospital network's central pharmacy.",
    "An allocation notice says how many units of a product in shortage the network will receive, and when.",
    "Rules:",
    "- quantity is the number of units ALLOCATED to the customer (not ordered, not backordered). Integer only, no thousands separators. Use 0 for a cancelled line.",
    "- If the text contains a correction or a forwarded thread, use the latest corrected figures only.",
    "- unit is the selling unit (vial, bag, syringe, bottle, pen, ampule, box).",
    "- drugId must be exactly one id from the catalog below that is the same product (same drug, strength and form), or null if none matches.",
    "- eta is the expected ship or delivery date as YYYY-MM-DD, or null if not stated.",
    "- If the text is not an allocation notice (e.g. marketing, an invoice, unrelated email), set isAllocationNotice to false and lots to [].",
    "- confidence is 0 to 1: how sure you are that every extracted field is correct.",
    "Return only JSON.",
    "",
    "Catalog (id: product):",
    ...catalog.map((d) => `${d.id}: ${d.name}`),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: text.slice(0, MAX_INPUT_CHARS) },
  ];
}

// "400mg/5mL susp" -> {400, mg, 5, ml, susp}
const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/(\d)([a-z])/g, "$1 $2")
      .replace(/([a-z])(\d)/g, "$1 $2")
      .split(/[^a-z0-9%]+/)
      .filter(Boolean),
  );

// Exact token, or a shared prefix for words ("susp" ~ "suspension").
const sameToken = (a: string, b: string) =>
  a === b || (a.length >= 4 && b.length >= 4 && /^[a-z]/.test(a) && (a.startsWith(b) || b.startsWith(a)));

/** Best-effort catalog match on drug name tokens; null when ambiguous or weak. */
export function matchDrug(name: string, catalog: CatalogDrug[]): string | null {
  const want = tokens(name);
  const first = name.toLowerCase().split(/[^a-z]+/).find(Boolean);
  let best: { id: string; score: number } | null = null;
  let tie = false;
  for (const d of catalog) {
    if (!first || !d.name.toLowerCase().startsWith(first)) continue;
    const have = tokens(d.name);
    let shared = 0;
    for (const t of want) if ([...have].some((h) => sameToken(t, h))) shared++;
    const score = shared / (want.size + have.size - shared); // Jaccard
    if (!best || score > best.score) {
      best = { id: d.id, score };
      tie = false;
    } else if (score === best.score) tie = true;
  }
  return best && !tie && best.score >= 0.3 ? best.id : null;
}

/** Validates raw model output and resolves catalog ids. Pure: no AI call. */
export function validateExtraction(raw: unknown, catalog: CatalogDrug[]): ExtractionResult {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, reason: "model output is not JSON" };
    }
  }
  const parsed = ExtractedNotice.safeParse(value);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  const n = parsed.data;
  if (!n.isAllocationNotice) return { ok: false, reason: "not an allocation notice" };

  const ids = new Set(catalog.map((d) => d.id));
  const warnings: string[] = [];
  let confidence = n.confidence;
  const lots: ExtractedLotResolved[] = [];
  for (const lot of n.lots) {
    if (lot.quantity === 0) {
      warnings.push(`zero allocation: ${lot.drugName}`);
      continue;
    }
    let drugId = lot.drugId && ids.has(lot.drugId) ? lot.drugId : null;
    if (!drugId) {
      drugId = matchDrug(lot.drugName, catalog);
      if (drugId) confidence = Math.max(0, confidence - 0.1);
    }
    if (!drugId) {
      warnings.push(`unmatched product: ${lot.drugName}`);
      continue;
    }
    lots.push({ drugId, drugName: lot.drugName, quantity: lot.quantity, unit: lot.unit, eta: lot.eta || null });
  }
  if (lots.length === 0) return { ok: false, reason: warnings[0] ?? "no lots in notice" };
  return {
    ok: true,
    wholesaler: n.wholesaler,
    noticeRef: n.noticeRef ?? null,
    confidence: Math.round(confidence * 100) / 100,
    lots,
    warnings,
  };
}

export async function extractNotice(ai: AiRunner, text: string, catalog: CatalogDrug[]): Promise<ExtractionResult> {
  if (text.trim().length < 20) return { ok: false, reason: "notice is empty" };
  const out = (await ai.run(EXTRACTION_MODEL, {
    messages: buildExtractionMessages(text, catalog),
    response_format: { type: "json_schema", json_schema: EXTRACTION_JSON_SCHEMA },
    temperature: 0,
    max_tokens: 1500,
  })) as { response?: unknown };
  return validateExtraction(out?.response, catalog);
}
