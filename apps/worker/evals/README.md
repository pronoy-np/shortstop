# Extraction evals

These evals check the one step where a model does real work: reading a wholesaler allocation notice and turning it into structured lots. They call the **real** Workers AI model (`@cf/meta/llama-3.1-8b-instruct-fast`) through a remote binding.

```bash
pnpm eval          # from the repo root; requires `wrangler login`
```

A run makes 10 model calls, which uses a small fraction of the free 10,000 neurons/day.

## What is tested
Each case is a file in [`fixtures/notices/`](../../../fixtures/notices). Its expected answer is in [`expected.json`](../../../fixtures/notices/expected.json). A case goes through the same path as production: R2 → `loadNoticeText` (PDF via `AI.toMarkdown`, `.eml` via postal-mime) → `extractNotice` → Zod validation → catalog matching.

| Case | What makes it hard |
|---|---|
| 01 multi-lot text | Fixed-width table with *Ordered* and *Allocated* columns; the model must pick the allocated quantity |
| 02 cisplatin `.eml` | Requested vs allocated in prose; the date is written out in words |
| 03 IV fluids | Two near-identical products (saline and lactated Ringer's) |
| 04 amoxicillin | Informal email with abbreviations and a US date format |
| 05 GLP-1 pens | No ship date stated (the ETA must be null, not invented) |
| 06 webinar | Mentions shortage drugs, but it is marketing, not a notice. It **must be refused** |
| 07 bumetanide | A real notice for a product that is not in the catalog. It **must be refused** |
| 08 PDF letter | A real PDF through `toMarkdown` |
| 09 forwarded correction | A thread with a superseded quantity (300 → 220) |
| 10 cancelled line | Thousands separators ("1,200") plus a zero-quantity cancelled line |

## Scoring
[`score.ts`](score.ts) scores each field; it has its own unit test in `test/score.test.ts`.

- **Fields scored:** each expected lot gets a point each for the right drug, the right quantity and the right ETA. The wholesaler is one more point. Invented lots count as wrong fields.
- **When a case passes:** every drug and every quantity must be right. An ETA miss is reported but doesn't fail the case: a planner would spot a wrong date, but a wrong quantity would be silently allocated.
- **Triage cases (06, 07):** these must be refused every time. A single failure fails the run.
- **Bars:** case accuracy must be at least 75% and field accuracy at least 85% (`extraction.eval.ts`).

## Latest result (2026-11-03)
```
PASS  01-meridian-multi-lot.txt      10/10
PASS  02-cisplatin-oncology.eml       4/4
PASS  03-iv-fluids-short.txt          7/7
PASS  04-pediatric-amoxicillin.txt    4/4
PASS  05-glp1-pens.txt                7/7
PASS  06-not-a-notice.txt             1/1   not an allocation notice
PASS  07-unknown-product.txt          1/1   unmatched product: Bumetanide Injection 0.25 mg/mL
PASS  08-epinephrine-letter.pdf       7/7
PASS  09-forwarded-correction.eml     4/4
PASS  10-cancelled-line.txt           4/4
SUMMARY {"cases":10,"passed":10,"caseAccuracy":1,"fieldAccuracy":1}
```

Cases 09 and 10 were added after the first 8 scored 100%, to make the set harder. Case 10 found a real bug: a zero-quantity line made the whole notice fail validation. Now that line is dropped and the notice gets a warning. When you change the prompt, bump `PROMPT_VERSION` in `src/ingest.ts` so cached extractions are not reused.
