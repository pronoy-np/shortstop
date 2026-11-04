# Notes to review

What surprised me, what I got wrong, and what I'd do differently.

## What surprised me
- **The free tier shaped the architecture more than any feature did.**
  - The 10 ms CPU limit ruled out Next.js server rendering.
  - Email Routing needs a domain, and sending to arbitrary recipients needs Workers Paid, so intake became upload-based.
  - Both R2 and Zero Trust ask for a card even when they charge $0.
- **The model named in the course brief is gone.** `@cf/meta/llama-3.1-8b-instruct` returns `AiError 5028` (deprecated 2026-05-30). `wrangler tail` showed this immediately, where `curl` only showed `1101`.
- **Vectorize is eventually consistent.** A vector is queryable a few seconds after `upsert`. The first live precedent attempt ran before the earlier lot was visible and correctly returned no note; the fallback did its job.
- **Small models ignore length limits.** The precedent note now gets trimmed to two sentences *before* the grounding check.

## What I got wrong (and how it was found)
- **An auto-commit could get stuck as `reserved`.**
  - *The bug:* the DO deleted the reservation, then mirrored to D1. If the mirror threw, the retry found nothing to finalize.
  - *How it was found:* the two-axis code review.
  - *The fix:* a transactional outbox inside `LotDO`, with versioned D1 writes. A test now injects a D1 failure to cover it.
- **The audit log could lie.**
  - *The bug:* `[AUDIT]` was printed when the statement was built, not after the commit. A refused pharmacist decision still got an audit row.
  - *How it was found:* the same review.
  - *The fix:* `batchAudited()` writes the row in the same transaction, conditionally where needed, and logs only rows that were actually written.
- **A zero-quantity "cancelled" line made a whole notice fail validation.**
  - *How it was found:* an adversarial eval case written *after* the first 8 cases scored 100%.
- **Demo auth could impersonate a real account.**
  - *The bug:* any email in the users table was accepted, including mine.
  - *The fix:* demo mode is now restricted to the `@shortstop.demo` personas.
- **A flaky test.** The real-alarm test exited as soon as the ledger moved, while the projection to D1 was still in flight. The test now waits for both. Running the suite 8 times in a row confirmed the fix.

## What I'd do differently
- **Start from the curriculum checklist.** I built from a plan first, and Vectorize, the RAG Worker, the landing page and the run-twice cron were added later to close gaps.
- **Write the adversarial eval cases first.** Easy cases scored 100% and taught nothing.
- **Model the D1 mirror as an outbox from day one.** "Write, then mirror" looks idempotent until the mirror fails halfway.
- **With a domain and Workers Paid:** use Email Workers for intake and confirmations, and presigned R2 uploads.
