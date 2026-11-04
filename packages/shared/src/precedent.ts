import { z } from "zod";

// 768-dim embeddings; matches the shortstop-lots Vectorize index.
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const PRECEDENT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

/** Below this cosine similarity a past lot is not considered a precedent. */
export const MIN_PRECEDENT_SCORE = 0.6;

export type LotDoc = {
  lotId: string;
  noticeId: string;
  drugId: string;
  drugName: string;
  drugClass: string;
  wholesaler: string;
  quantity: number;
  unit: string;
  eta: string | null;
  explanation: string;
};

/** The one text we embed per lot. Also stored as Vectorize metadata so RAG can quote it back. */
export function lotSummary(d: LotDoc): string {
  return [
    `${d.drugName} (${d.drugClass.replace("_", " ")}): ${d.quantity} ${d.unit}s allocated by ${d.wholesaler}, ETA ${d.eta ?? "not stated"}.`,
    d.explanation,
  ].join(" ");
}

export const PrecedentRequest = z.object({
  lotId: z.string().min(1),
  noticeId: z.string().min(1),
  text: z.string().min(1).max(4000),
});
export type PrecedentRequest = z.infer<typeof PrecedentRequest>;

export const PrecedentResponse = z.object({
  note: z.string().nullable(),
  sources: z.array(z.string()),
});
export type PrecedentResponse = z.infer<typeof PrecedentResponse>;

export type PastRecord = { lotId: string; summary: string };

export function buildPrecedentMessages(newLot: string, past: PastRecord[]) {
  return [
    {
      role: "system",
      content: [
        "You write a precedent note for a hospital central-pharmacy planner who is about to allocate a scarce drug lot.",
        "Use ONLY the numbered past allocation records provided. Never invent quantities, sites or dates.",
        "Write at most two sentences, and cite every record you rely on as [n].",
        "If none of the records is relevant to the new lot, reply with exactly: NONE",
      ].join("\n"),
    },
    {
      role: "user",
      content: `New lot:\n${newLot}\n\nPast records:\n${past.map((p, i) => `[${i + 1}] ${p.summary}`).join("\n")}`,
    },
  ];
}

/** Small models ignore length limits: keep at most `n` sentences, then run the grounding check on what's left. */
export function firstSentences(text: string, n = 2): string {
  const parts = text.trim().match(/[^.!?]+[.!?]+(?:\s*\[\d+\])*/g);
  return parts ? parts.slice(0, n).join("").trim() : text.trim();
}

/**
 * Grounding check on the model's answer: it must cite at least one provided record and only provided records.
 * Returns the cited lot ids, or null when the note must be discarded.
 */
export function groundedSources(note: string, past: PastRecord[]): string[] | null {
  if (!note.trim() || /^NONE\b/i.test(note.trim())) return null;
  const cited = [...note.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  if (cited.length === 0 || cited.some((n) => n < 1 || n > past.length)) return null;
  return [...new Set(cited)].map((n) => past[n - 1]!.lotId);
}
