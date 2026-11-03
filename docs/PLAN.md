# ShortStop: Project JEDI build plan (trimmed for the free tier)

## Context
Pronoy's Project JEDI submission needs to be a distinctive full-stack TypeScript app on Cloudflare, running at **$0 on the Workers Free plan**. It must not overlap with the 5 submitted apps or the 6 "Ideas to steal".

**ShortStop** is a drug-shortage allocation desk for a health system's central pharmacy.
- A wholesaler allocation notice comes in.
- AI extracts it, and a deterministic engine proposes a split across 10 hospitals.
- An ops-lead autopilot commits the safe cases.
- Humans handle the rest.
- A Durable Object ledger guarantees a lot can never be over-allocated when two planners collide.

The novelty is human-configured autopilot with hard floors in code, plus a collision over a quantity that must be conserved. That stays intact. The scope was trimmed to fit free-tier limits (10 ms CPU, 10k neurons/day, 1k KV writes/day) and a 2–3 week part-time budget.

The repo `/Users/newpage/TS-Cloudflare` is empty (not yet a git repo).

## What was trimmed, and why
| Cut or changed | Reason |
|---|---|
| Two Workers → **one Worker** | Less wiring and one deploy. The public form is handled with an Access bypass policy on `/request/*` |
| Workflow `waitForEvent` per lot and 7-day escalation → the **Workflow covers ingest only** | Human decisions go straight to `LotDO`, which keeps the Workflow short and well inside 3k steps/day |
| Vectorize substitute matching → a **seeded `substitutes` table in D1** | Deterministic, no index to manage, and the substitute rule is still enforced |
| Generated PDF confirmations → **HTML/CSV confirmation in R2** | PDF rendering risks the 10 ms CPU limit |
| Analytics Engine metrics page → **a simple metrics view from D1** | One less service to justify |
| Rate Limiting binding and AI Gateway | Rate Limiting is unverified on Free; AI Gateway isn't needed |
| Turnstile form → a **stretch goal** | Audit alone covers the "Trust & records" block |

## Core (must ship)
**Users:**
- planner
- pharmacist (approves substitutes)
- ops lead (edits autopilot rules)
- Sign-in: Cloudflare Access with email OTP (card on file, $0). The Worker maps the Access JWT email to a role in D1.

**Seed data:** about 40 drugs that have really been in shortage (cisplatin, carboplatin, amoxicillin suspension, IV fluids, semaglutide…), 3 criticality tiers, and 10 synthetic hospitals with stock and daily demand. Substitutes are seeded in D1.

**Flow:**
1. **Intake:** a planner uploads a PDF or .eml, or pastes text, through a presigned R2 PUT. A row goes into `notices`, and a message goes to the `intake` Queue.
2. **Queue consumer** starts `IngestWorkflow`, using the notice ID as the instance ID so it's idempotent. If retries run out, it writes the notice to `dead_letters` in D1.
3. **`IngestWorkflow`** steps:
   1. Load from R2, converting PDFs with `AI.toMarkdown`.
   2. Extract with an 8B-class model in JSON mode and validate with Zod. If validation fails, mark the notice `needs_triage`. Cache the result in KV by content hash.
   3. Compute the split: pure TypeScript, criticality-weighted days of cover.
   4. Evaluate the policy and the hard floors.
   5. For each lot, either reserve it in `LotDO` as a pending auto-commit or leave it as a proposal.
   6. Notify `BoardDO`.
4. **`LotDO`** (one per lot, SQLite):
   - `commit(allocations, idemKey)` checks the remaining quantity atomically. The loser gets a rebased proposal back.
   - `reserveAuto(...)` sets an alarm for 15 minutes; `cancel` and `takeOver` release the reservation.
   - The alarm finalizes the commit, writes the HTML/CSV confirmation to R2, and writes the audit entry.
5. **`BoardDO`** (one per desk): WebSocket hibernation. It broadcasts `notice.ingested`, `lot.reserved`, `lot.committed`, `lot.rebased` and `lot.cancelled`.
6. **Autopilot policy:**
   - An ordered list of IF→action rules (auto-commit, propose or manual-only), where the first match wins. Only the ops lead edits them.
   - Each save creates an immutable version in D1, and the compiled policy is cached in KV. Each auto-commit records the rule ID and policy version that fired.
7. **Hard floors, in code:** tier-1 (ICU/oncology) allocations and any substitute always need a human, and substitutes need a pharmacist.
8. **Cron**, 1 trigger every 15 minutes: sweeps stuck reservations and notices that never finished. A nightly branch re-scores days of cover and refreshes the KV snapshot.
9. **Audit:** every state change writes to `audit_log` and emits an `[AUDIT] {...}` log line.

**Stack:** a pnpm monorepo, TypeScript strict, Zod at every boundary.
- **`apps/worker`:** Hono API; Vite React SPA served from Static Assets; DOs, Workflow, queue consumer and `scheduled()`.
- **`packages/shared`:** schemas, split engine, policy evaluator, prompts.
- **`packages/db`:** Drizzle schema, migrations, seed.
- **`fixtures/notices/`:** about 5 notices, including a PDF and one that should fail extraction.

## Building blocks
| Block | Use |
|---|---|
| D1 | Main store: drugs, sites, lots, allocations, policies, substitutes, audit_log, dead_letters |
| KV | Compiled policy, days-of-cover snapshot, AI result cache (all rebuildable, low write volume) |
| R2 | Uploaded notices; confirmations and CSV exports |
| Durable Objects | `LotDO` ledger and alarms; `BoardDO` live board |
| Queues | Intake buffer with retries and a D1 dead-letter mirror |
| Workers AI | Notice extraction and the split explanation |
| Cron | Sweep and nightly re-score |
| Audit | `audit_log` on every change |
| Bonus | Workflows, DO WebSockets (outside a game), Access |

## Stretch goals (only if week 3 has room)
- A Turnstile-protected public site urgent-request form at `/request`. Each request feeds the split as a priority signal.
- Vectorize "similar past shortages" next to each notice.

## Milestones
- **Week 1:**
  - A quick spike to confirm Access on workers.dev works with WebSocket upgrades (hostname app) and to check whether a DLQ works on Free.
  - Scaffold the monorepo and deploy a hello-world Worker.
  - Write the Drizzle schema, migrations and seed.
  - Write the split engine and policy evaluator with table tests.
  - Build intake → R2 → Queue → Workflow with stub steps.
- **Week 2:** AI extraction; `LotDO` commit, rebase and auto-reserve with alarms; `BoardDO` board UI; the policy editor; the hard floors; audit and confirmations; Access roles. **This is the demoable cut line.**
- **Week 3:** Cron, metrics view, polish, stretch goals; README with an architecture diagram, services table, cluster mapping and free-tier rationale. Then post in `#project-jedi`.

## Demo (~5 min)
1. Upload a notice. Autopilot reserves the small lots ("pending, 15 min"). A tier-1 cisplatin lot waits for a human.
2. Two planners in two browsers commit to that lot together. One wins, and the other gets a live "only 140 left" rebase.
3. A substitute proposal is blocked until a pharmacist approves it.
4. The audit trail shows the rule and policy version behind each auto-commit. Then open the confirmation stored in R2.

## First steps after approval
1. `git init`. Write `CLAUDE.md` (conventions) and `CONTEXT.md` (glossary: lot, allocation, days of cover, tier, policy version, hard floor, reservation).
2. Scaffold the monorepo and `wrangler.jsonc` with every binding. Run `wrangler types`.

## Verification
- `pnpm test` (Vitest + `@cloudflare/vitest-pool-workers`):
  - split engine and policy table tests
  - a `LotDO` race test: two concurrent commits, the ledger never goes negative, an idempotent replay
  - an alarm finalize or cancel test
  - extraction against the fixtures with mocked AI
  - one end-to-end test from notice to confirmation in R2
- Deploy to workers.dev, run the demo script in two browser sessions, and check the dashboard usage pages to confirm everything stays within the free-tier quotas.

## Open (outside the build)
- Paste the JEDI cluster checklist (A–F) to finish the curriculum mapping.
- Ask for course repo access in `#project-jedi`.
- Confirm the time budget with Ravinder.
