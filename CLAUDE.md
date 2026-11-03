# ShortStop

ShortStop is a drug-shortage allocation desk on Cloudflare, built as a Project JEDI submission. The full plan is in `docs/PLAN.md`, and the domain glossary is in `CONTEXT.md`.

## Hard constraints
- **$0, Workers Free plan.** No paid-only features. Keep CPU per request under 10 ms: no PDF rendering and no heavy SSR in the Worker.
- **Free quotas to respect:**
  - Workers AI: 10k neurons/day. Use small models and cache results in KV.
  - KV: 1k writes/day.
  - Queues: 10k ops/day.
  - Workflows: 3k steps/day.
- **The AI never commits an allocation.** Splits are computed by `packages/shared/src/split.ts` (deterministic). The AI only extracts notices and explains splits.
- **Hard floors live in code**, not in policy: tier-1 allocations and any substitute always need a human, and substitutes need a pharmacist.
- **`LotDO` is the only writer of a lot's remaining quantity.** The ledger must never go negative, and every mutation takes an idempotency key.
- **Audit everything:** every state change writes to `audit_log` and logs `[AUDIT] {json}`.
- **Secrets never go in the repo.** Use `wrangler secret put` (R2 S3 credentials for presigned URLs, Access audience).

## Layout
- `apps/worker`: one Worker. It contains the Hono API (`/api/*`), the Vite React SPA (Static Assets), `LotDO`, `BoardDO`, `IngestWorkflow`, the queue consumers and `scheduled()`.
- `packages/shared`: Zod schemas, event types, the split engine, the policy evaluator and prompts. Keep it pure: no Cloudflare APIs.
- `packages/db`: Drizzle schema, migrations (the source of truth) and the seed.
- `fixtures/notices`: sample allocation notices for tests and the demo.

## Conventions
- pnpm workspaces, TypeScript strict, Zod at every boundary (HTTP, queue messages, AI output, DO RPC).
- Run `pnpm cf-typegen` (`wrangler types`) after changing `wrangler.jsonc`. Never hand-edit `worker-configuration.d.ts`.
- Test with Vitest, using `@cloudflare/vitest-plugin` (formerly `vitest-pool-workers`) for Worker and DO code. Tests mock Workers AI and must never spend neurons.
- D1 is the system of record. KV holds only rebuildable caches.
