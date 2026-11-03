import { EXTRACTION_MODEL, extractNotice, type AiRunner, type ExtractionResult } from "@shortstop/shared";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import expected from "../../../fixtures/notices/expected.json";
import { loadCatalog, loadNoticeText } from "../src/ingest";
import { scoreCase, summarise, type CaseScore, type EvalCase } from "./score";

// Pass bars. Quantities drive real allocations, so the case bar is high; the triage cases must always be refused.
const MIN_CASE_ACCURACY = 0.75;
const MIN_FIELD_ACCURACY = 0.85;

const text = import.meta.glob<string>("../../../fixtures/notices/*.{txt,eml}", { query: "?raw", import: "default", eager: true });
const binary = import.meta.glob<string>("../../../fixtures/notices/*.pdf", { query: "?inline", import: "default", eager: true });

function bytesFor(file: string): ArrayBuffer | string {
  const key = `../../../fixtures/notices/${file}`;
  if (key in text) return text[key]!;
  const dataUrl = binary[key];
  if (!dataUrl) throw new Error(`fixture not found: ${file}`);
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)).buffer;
}

const cases = (expected as { cases: EvalCase[] }).cases;
const scores: CaseScore[] = [];

describe(`extraction evals · ${EXTRACTION_MODEL}`, () => {
  for (const c of cases) {
    it(c.file, async () => {
      const key = `notices/eval/${c.file}`;
      await env.FILES.put(key, bytesFor(c.file), { httpMetadata: { contentType: c.contentType } });
      const noticeText = await loadNoticeText(env, key, c.contentType);
      const result: ExtractionResult = await extractNotice(env.AI as unknown as AiRunner, noticeText, await loadCatalog(env));
      const s = scoreCase(c, result);
      scores.push(s);
      console.log(`${s.pass ? "PASS" : "FAIL"}  ${c.file}  ${s.correct}/${s.fields}  ${s.notes.join("; ")}`);
      if (c.triage) expect(s.pass, `${c.file} must be refused`).toBe(true);
    });
  }

  it("meets the accuracy bar", () => {
    const sum = summarise(scores);
    console.log(`\nSUMMARY ${JSON.stringify(sum)}`);
    expect(sum.caseAccuracy).toBeGreaterThanOrEqual(MIN_CASE_ACCURACY);
    expect(sum.fieldAccuracy).toBeGreaterThanOrEqual(MIN_FIELD_ACCURACY);
  });
});
