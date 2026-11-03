# ShortStop

ShortStop is a drug-shortage allocation desk on Cloudflare, built as a Project JEDI submission. User-facing docs are in `README.md`. The design history is in `docs/PLAN.md`, and the domain glossary is in `CONTEXT.md`.

## Hard constraints
- **$0, Workers Free plan.** No paid-only features. Keep CPU per request under 10 ms: no PDF rendering and no SSR in the Worker.
- **Free quotas to respect:**
  - Workers AI: 10k neurons/day. Use the small model and cache results in KV.
  - KV: 1k writes/day.
  - Queues: 10k ops/day.
  - Workflows: 3k steps/day.
- **The AI never decides quantities.** Splits come from `packages/shared/src/split.ts`, which is deterministic. The AI only extracts notices.
- **Hard floors live in code** (`packages/shared/src/policy.ts` `decide()` and the substitute gate in `api.ts`): tier-1 drugs and substitute cases never auto-commit, and substitutes need a pharmacist.
- **`LotDO` is the only writer of a lot's remaining quantity.** Its check and its write must stay synchronous (before the first `await`), and every mutation takes a commit key. D1 is a mirror, so mirror writes must be idempotent.
- **Audit everything:** every state change writes `audit_log` and logs `[AUDIT] {json}` (`src/lib/audit.ts`).
- **No secrets in the repo.** The only optional secret is `ACCESS_AUD` (`wrangler secret put`).

## Layout
- `apps/worker`: one Worker.
  - `src/api.ts`: the Hono API.
  - `src/lot-do.ts` and `src/board-do.ts`: the Durable Objects.
  - `src/ingest.ts` and `src/ingest-workflow.ts`: the pipeline.
  - `src/cron.ts`: scheduled jobs.
  - `web/`: the React SPA.
  - `test/` and `evals/`.
- `packages/shared`: pure TypeScript (schemas, split, policy, extraction prompt and validation). No Cloudflare APIs.
- `packages/db`: Drizzle schema, migrations (the source of truth) and `scripts/seed.ts`, which generates `seed.sql`.
- `fixtures/notices`: sample notices plus `expected.json`. It is also Vite's `publicDir`, so only put things there that are safe to serve publicly.

## Conventions
- pnpm workspaces, TypeScript strict, Zod at every boundary (HTTP, queue messages, AI output).
- After changing `wrangler.jsonc`, run `pnpm cf-typegen`. After changing the schema, run `pnpm db:generate`. After changing the seed, run `pnpm db:seed-sql`.
- `pnpm test` runs fully local in workerd (`@cloudflare/vitest-plugin`, `remoteBindings: false`) and never calls AI. `pnpm eval` calls the real model.
- After changing the extraction prompt, bump `PROMPT_VERSION` in `src/ingest.ts` and re-run `pnpm eval`.
- D1 is the system of record. KV holds only rebuildable caches.
