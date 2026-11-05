# ShortStop

ShortStop is a drug-shortage allocation desk on Cloudflare, built as a Project JEDI submission. User-facing docs are in `README.md`. The design history is in `docs/PLAN.md`, and the domain glossary is in `CONTEXT.md`.

## Hard constraints
- **$0, Workers Free plan, never Paid.** No paid-only features, no PDF rendering. Next.js pages run under a soft CPU budget ([ADR 0001](docs/adr/0001-free-plan-with-a-soft-cpu-budget.md)): they may exceed 10 ms, but any `exceededCpu` or 1102 triggers that route's free fallback. Hot paths skip Next in `src/entry.ts` (`/api/*`, the board WebSocket). Re-run `pnpm --filter @shortstop/worker cpu-sample` after any Next or OpenNext upgrade (versions are pinned, [ADR 0002](docs/adr/0002-opennext-over-vinext.md)).
- **Free quotas to respect:**
  - Workers AI: 10k neurons/day. Use the small model and cache results in KV.
  - KV: 1k writes/day.
  - Queues: 10k ops/day.
  - Workflows: 3k steps/day.
- **The AI never decides quantities.** Splits come from `packages/shared/src/split.ts`, which is deterministic. The AI only extracts notices.
- **Hard floors live in code** (`packages/shared/src/policy.ts` `decide()` and the substitute gate in `api.ts`): tier-1 drugs and substitute cases never auto-commit, and substitutes need a pharmacist.
- **`LotDO` is the only writer of a lot's remaining quantity.** Its check, its write and its outbox append must stay in one synchronous block (before the first `await`), and every mutation takes a key (commit key or cancel key). D1 is a projection of the outbox: writes are idempotent and guarded by `lots.state_version`.
- **Audit everything:** write state changes through `batchAudited()` (`src/lib/audit.ts`), so the `audit_log` row is in the same D1 transaction and the `[AUDIT]` line is logged only after commit. Give retryable changes a stable audit `id`.
- **No secrets in the repo.** Secrets: `AI_SHARED_SECRET` (on both Workers), `TURNSTILE_SECRET` (its site key `TURNSTILE_SITEKEY` is a public var) and the optional `ACCESS_AUD`, all set with `wrangler secret put`.
- **Curriculum mapping:** `docs/CLUSTERS.md` maps every Cluster A–F item. Keep it current when a feature changes.

## Layout
- `apps/worker`: one Worker, and the Next.js project root (`next@16.4.5` on `@opennextjs/cloudflare@1.20.16`).
  - `src/entry.ts`: production `main`. Routes `/api/*` (and the WebSocket) to `src/index.ts`, everything else to OpenNext, and re-exports the DOs, Workflow, `queue` and `scheduled`. `src/index.ts` stays Next-free (vitest boots it). Never rename the DO classes or edit `migrations` (`scripts/check-migrations.ts` fails `pnpm typecheck`).
  - `src/api.ts`: the Hono API, thin adapters over `src/services/` (one validated `fn(env, actor, input)` per write, returning a discriminated result; reads too). Put business logic in the services, not the handlers.
  - `src/lot-do.ts` and `src/board-do.ts`: the Durable Objects.
  - `src/ingest.ts` and `src/ingest-workflow.ts`: the pipeline.
  - `src/cron.ts`: scheduled jobs.
  - `src/lib/lots.ts`: every lot-status rule. `src/lib/ai.ts`: the one typed Workers AI adapter (no casts elsewhere).
  - `src/search.ts`: Vectorize indexing, `/api/search`, and precedent calls to the AI Worker (advisory: failures return null and must never block allocation).
  - `app/`: the App Router UI. `(public)`: `/` (prerendered) and `/sign-in`. `(app)`: the gated desk under `/app`. Server pages call `src/services/` directly; client islands only hold UI state. `LiveRefresh` turns board events into `router.refresh()`.
  - `src/actions/forms.ts`: the Server Action cores (transport-free, tested in workerd). `app/_lib/actions.ts` holds the thin `"use server"` wrappers. Client components import `src/actions/state.ts`, never `forms.ts`.
  - `test/` (vitest, workerd), `e2e/` (Playwright) and `evals/`.
- `apps/ai-worker`: the RAG Worker (`workers_dev: false`), reachable only through the `AI_SVC` service binding, with the `AI_SHARED_SECRET` check. It returns `note: null` unless the note cites retrieved records.
- `packages/shared`: pure TypeScript (schemas, split, policy, extraction prompt and validation, and `views.ts`: the board API response types shared by the Worker and the browser). No Cloudflare APIs.
- `packages/db`: Drizzle schema, migrations (the source of truth) and `scripts/seed.ts`, which generates `seed.sql`.
- `fixtures/notices`: sample notices plus `expected.json`. `apps/worker/public` is a symlink to `fixtures/`, so everything there is served publicly: only put things there that are safe to serve.

## Conventions
- pnpm workspaces, TypeScript strict, Zod at every boundary (HTTP bodies, query parameters, form fields, queue messages, AI output).
- After changing `wrangler.jsonc`, run `pnpm cf-typegen`. After changing the schema, run `pnpm db:generate`. After changing the seed, run `pnpm db:seed-sql`.
- `pnpm test` runs fully local in workerd (`@cloudflare/vitest-plugin`, `remoteBindings: false`, `main: ./src/index.ts`), needs no build and never calls AI. `pnpm test:e2e` builds, runs `opennextjs-cloudflare preview --env e2e` (no queue consumers, no AI) on fresh local state and drives it with Playwright. `pnpm eval` calls the real model.
- After changing the extraction prompt, bump `PROMPT_VERSION` in `src/ingest.ts` and re-run `pnpm eval`.
- D1 is the system of record. KV holds only rebuildable caches.
