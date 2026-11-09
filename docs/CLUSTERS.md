# ShortStop against the TypeScript + Cloudflare curriculum (Clusters A–F)

Each "What to build" item from the JEDI course is listed with where it lives in ShortStop and the test or live check that proves it. A–E are required; F is optional.

**Status:**
- ✅ done
- ↔ done in a different way, with the reason given
- ➖ optional and not done

**Deliberate deviations:**
1. **Next.js on the Workers Free plan with a soft CPU budget** ([ADR 0001](adr/0001-free-plan-with-a-soft-cpu-budget.md), [ADR 0002](adr/0002-opennext-over-vinext.md)). The UI is Next.js 16 on OpenNext in the same Worker. Next pages may go over the 10 ms CPU limit; that cost is measured with `scripts/cpu-sample.ts`, not forbidden. Hot paths skip Next in `src/entry.ts`: `/api/*` and the board WebSocket go straight to Hono and `BoardDO`, and the prerendered landing page is read from the static-assets cache. Live since 2026-11-05 (version `e40686b6`), after a gated cutover: a preview on the live Durable Objects, a rehearsed `wrangler rollback` to the SPA build, and five gates (tests, startup, cache HIT, CPU sample, functional checks).

**Measured CPU per request on Workers Free** (`scripts/cpu-sample.ts`, `cpuTime` from `wrangler tail`, 2026-11-05; zero `exceededCpu` in both runs):

| Route | Preview (143 sampled): median / p90 / max ms | Live after cutover (41 sampled): median / p90 / max ms |
|---|---|---|
| `GET /` (static-assets cache HIT) | 2 / 14 / 14 | 2 / 13 / 13 |
| `GET /app` (board, Server Component) | 23 / 240 / 439 | 41 / 379 / 379 |
| `GET /app/audit`, `/app/metrics`, `/app/policy`, `/app/intake` | 16–41 / up to 286 | 22–58 / up to 233 |
| `GET /sign-in` | 18 / 168 / 168 | 28 / 164 / 164 |
| Server Actions (`ACTION /app`, `/app/intake`, `/sign-in`) | 10–21 / up to 23 | (not sampled) |
| `/api/*` via Hono, before Next | 1–8 / up to 23 | 2–7 / up to 12 |
| `WS /api/board/ws` | 1 / 1 / 1 | (not sampled) |

Pages that go through Next cost about 15–60 ms warm and 150–440 ms on a cold isolate, which is over the 10 ms Free limit but has not produced a single `exceededCpu` or 1102. ADR 0001's free per-route fallback applies if one ever appears.
2. **Uploads go through the Worker** (5 MB cap) instead of presigned R2 URLs. Presigning needs R2 S3 API credentials, and the files here are small. See D3.

## Contested write
The allocation of one scarce drug **lot** across 10 hospitals. When two planners commit the same lot at the same moment, `LotDO` lets exactly one win. The other gets a `409` with a fresh split of whatever is left.

---

## Cluster A: the language and the runtime

| # | Item | Status | Where | Proof |
|---|---|---|---|---|
| A1 | Scaffold a fresh app | ✅ | pnpm monorepo. `apps/worker` is a Next.js 16 App Router project (`next build`, wrapped by `opennextjs-cloudflare build`); `src/entry.ts` is the Worker entry. Live (deviation 1) | `pnpm --filter @shortstop/worker preview` |
| A2 | Typed `fetchJson<T>` helper | ↔ | Since the Next.js move the browser makes no JSON calls: Server Components call the services directly, and every write is a Server Action. The typed boundary is the services' discriminated `Result` (`src/services/result.ts`) and the shared response types (`packages/shared/src/views.ts`), checked by the compiler on both sides. The JSON API stays for `curl` and the tests | `pnpm typecheck` |
| A3 | Marketing landing page | ✅ | `apps/worker/app/(public)/page.tsx` at `/`, prerendered (`force-static`) and served from OpenNext's static-assets cache. The desk is at `/app` | `e2e/desk.spec.ts` "landing page … static-assets cache" (`x-opennext-cache: HIT`) |
| A4 | No `any` | ✅ | TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. Zero explicit `any` in `src/`, `app/`, `test/`, `e2e/` | `pnpm typecheck`, `grep` |

## Cluster B: routing and forms

| # | Item | Status | Where | Proof |
|---|---|---|---|---|
| B1 | Route tree: public routes + the app group | ✅ | `app/(public)`: `/` and `/sign-in`. `app/(app)`: a layout that calls `resolveUser` (redirect to `/sign-in` when signed out, 403 message for unknown identities) over `/app`, `/app/intake`, `/app/policy`, `/app/audit`, `/app/metrics`. `/api/*` stays Hono, routed before Next in `src/entry.ts`. | `e2e/desk.spec.ts` "signing in", `api.test.ts` "auth" |
| B2 | One form on a shared Zod schema, rejected on the server via `curl` | ✅ | `PolicyRules` and `NoticeText` (`packages/shared/src/schemas.ts`) are checked in the browser (`app/(app)/app/policy/rules-editor.tsx`, `intake/intake-form.tsx`) **and** on the server, inside the `apps/worker/src/services/*` functions that both the Server Actions (`src/actions/forms.ts`) and `api.ts` call | `api.test.ts` sends an invalid policy straight to the API, skipping the client → 400; `forms.test.ts` posts invalid form data to the Server Action cores → `invalid` with field errors |
| B3 | Main page as a Server Component | ✅ | `app/(app)/app/page.tsx` calls `loadBoard(env, { freshSplits: true })` and `?q=` search on the server; the board island makes no data calls. `LiveRefresh` (in the `(app)` layout) turns `BoardDO` WebSocket events into a debounced `router.refresh()`. Live, with CPU numbers in deviation 1 | `e2e/desk.spec.ts` "reaches the other tab over the WebSocket" |
| B4 | Loading state + error boundary | ✅ | `app/(app)/loading.tsx`, `app/(app)/error.tsx`, `app/global-error.tsx` and `app/not-found.tsx`; empty states stay inside each page | — |
| B5 | Auth | ✅ | Cloudflare Access JWT verification (`lib/auth.ts` `verifyAccessJwt`, `jose`: signature, issuer, audience, expiry), or demo personas restricted to `@shortstop.demo`. Access is code-complete but not switched on for the demo: it needs the `ACCESS_AUD` secret and a real `ACCESS_TEAM_DOMAIN` | `access.test.ts` (valid token, wrong audience/issuer, expired, forged key, no email); `api.test.ts`: real accounts get 403 in demo mode |

## Cluster C: Cloudflare Workers

| # | Item | Status | Where | Proof |
|---|---|---|---|---|
| C1 | Deploy the app to Cloudflare | ✅ | https://shortstop.shortstop-worker.workers.dev | live |
| C2 | Hello-world Worker: `wrangler.jsonc`, `secret put`, `curl`, `tail`, teardown | ✅ | [cluster-c-drill.md](cluster-c-drill.md) | log in the doc; URL returns 404 after the delete |
| C3 | An `ai` binding answering with Llama 3.1 8B | ✅ | The drill, plus the app's extraction (`@cf/meta/llama-3.1-8b-instruct-fast`). The non-fast model named in the brief was deprecated on 2026-05-30 (found in the drill) | `pnpm eval` 10/10 |
| C4 | Three modules that won't run on Workers, with replacements | ✅ | README, "Three modules that won't run on Workers" (`pdf-parse` / `fs`, `better-sqlite3` / native, `nodemailer` / TCP). `bcrypt` is answered below | — |

## Cluster D: storing data

| # | Item | Status | Where | Proof |
|---|---|---|---|---|
| D1 | D1 + Drizzle schema, `drizzle-kit generate`, applied | ✅ | `packages/db/src/schema.ts`, `packages/db/migrations/0000_init.sql`, applied local + remote | every Worker test runs on the migrated schema |
| D2 | Hot, short-lived state in KV | ✅ | `policy:current` (the compiled policy), `extract:*` (the AI result cache, 30-day TTL), `cover:snapshot` (nightly). All rebuildable from D1 | `pipeline.test.ts` cache test (1 AI call for 2 extractions) |
| D3 | R2 uploads through presigned URLs | ↔ | Uploads stream through the Worker into R2 (`POST /api/notices`, 5 MB cap). Only the object key is stored in D1. Confirmations (HTML + CSV) are written to R2 by `LotDO` | e2e test reads the R2 confirmation back |
| D4 | Workers AI embeddings into Vectorize, plus a `/search` route | ✅ | `src/search.ts`: `@cf/baai/bge-base-en-v1.5`, the 768-dim `shortstop-lots` index, upserted by the `index-lots` Workflow step. `GET /api/search?q=` and the search box on the board | `search.test.ts`; live: "platinum chemotherapy shortage" → the cisplatin lot at 0.725 |
| D5 | A schema change you didn't anticipate | ✅ | `0001_lot_state_version.sql` (added after the code review found D1 could go stale) and `0002_precedent_and_cover_history.sql` | `lot-do.test.ts` "D1 matches the ledger" |

## Cluster E: shared state and background work

| # | Item | Status | Where | Proof |
|---|---|---|---|---|
| E1 | Contested-write DO, one per entity via `idFromName`; validates preconditions and writes to D1 | ✅ | `LotDO` (`src/lot-do.ts`), `lotStub()` = `idFromName(lotId)`. Availability is checked synchronously, then D1 is written through a versioned outbox | `lot-do.test.ts`: 2-way and 12-way races, never negative |
| E2 | `idempotencyKey`, where a replay returns the cached result; `[AUDIT]` on every mutation | ✅ | `Idempotency-Key` header (or a body `commitKey`) on commits; keys in the `auto:` namespace are refused. Cancel/take-over keys are derived per reservation by `LotDO` when the client sends none, so a retried click is a replay. The DO ledger keeps every key for the life of the lot, which is stricter than 24 h. A commit replay (same key, same person, same allocations) never writes again and answers `ok, replay: true` with the lot's *current* availability; the same key reused for a different commit is refused with 422. Cancel replays return the stored original result. `batchAudited()` writes the audit row in the same transaction and logs `[AUDIT]` after commit | `search.test.ts` "Idempotency-Key header" (proves current availability after an interleaved commit) and "same key reused … refused"; `api.test.ts` take-over retry with no client key; `lot-do.test.ts` replays |
| E3 | Call the DO through a binding, not over HTTP | ✅ | The API calls `LotDO` through its Durable Object binding (RPC stub), and calls the AI Worker through the `AI_SVC` service binding. Neither goes over public HTTP | — |
| E4 | AI Worker doing RAG: no public URL, shared-secret check, fallback | ✅ | `apps/ai-worker`:<br>• `workers_dev: false`, `preview_urls: false`<br>• `x-shortstop-secret` checked in constant time<br>• embeds the lot, retrieves similar past lots from Vectorize (≥ 0.6, other notices only) and asks Llama for a note citing them<br>• uncited or invented citations are discarded<br>The main Worker calls it from the `precedents` Workflow step with an 8 s timeout. Any failure returns `null` and never blocks allocation | `apps/ai-worker/test` (6); `search.test.ts` fallback tests; live: grounded note on the board, public URL → 404 |
| E5 | Optional queue + consumer: retries, DLQ, discriminated-union events | ✅ | `shortstop-intake` queue with `max_retries: 3`, plus a DLQ mirrored to D1 and audited. Redeliveries are recognised by checking whether the Workflow instance exists. Live-board events are typed as a discriminated union (`BoardEvent`), checked at compile time where they are produced; the browser treats any event as "refetch", so it does not parse them. The queue carries intake rather than DO events, because intake is the work that must survive a crash | `pipeline.test.ts` queue, redelivery and DLQ |
| E6 | `scheduled()` UPSERT-on-conflict, run twice with an identical result | ✅ | `cron.ts` `rescoreCover`: `INSERT … ON CONFLICT (day, site_id, drug_id) DO UPDATE` through `batchAudited()` with a per-day audit id, so a rerun leaves identical rows and one audit entry. The 15-min sweep finalises reservations whose alarm was missed (projection retries themselves are the DO alarm's job, every 30 s until they land) | `search.test.ts` "running it twice leaves identical rows" (+ one audit row) |

## Cluster F: protecting the app (optional)

| # | Item | Status | Notes |
|---|---|---|---|
| F1 | Rate-limit binding on the busiest write route | ✅ | `WRITE_LIMITER` (`unsafe.bindings`, `type: ratelimit`, 30 per 60 s) in `wrangler.jsonc`; `src/lib/ratelimit.ts` runs after `authenticate` on every non-GET `/api` route and answers `429` + `Retry-After`. Keyed on the actor email, not the IP, because behind Access everyone shares edge IPs. **Why 30/60:** a planner working a lot makes a few writes a minute, so 30 never touches real use but stops a script; the 60 s period is the longest the binding allows. It fails open if the binding is missing, since the DO still serializes writes. Proof: `api.test.ts` "write rate limit" (first 429 within 31 writes, reads never limited, other actors unaffected). Two reads that cost real quota, `/api/search` (Workers AI) and the CSV export (table scan plus an audit row), have their own `<email>:read` bucket on the same binding (`limitCostlyReads`, proof: `api.test.ts` "costly read rate limit"). Live: 120 parallel writes as one persona gave 45 × `429`. 33 sequential curls did not trip it: the binding counts per location and is deliberately approximate, so "the sixth hit always 429s" only holds for a fast burst |
| F2 | Turnstile on a public form | ✅ | Since the Next.js move, `/sign-in` is a public form submitted through a Server Action. It has one explicit-render widget (`app/(public)/sign-in/sign-in-form.tsx`). The core `signInForm` (`src/actions/forms.ts`) checks the `cf-turnstile-response` token with `siteverify` (`src/lib/turnstile.ts`) before setting the `demo_user` cookie, and fails closed on a network error, a non-200 or bad JSON. A caller who is already signed in (the desk's persona switcher) needs no token, since they hold a demo identity already. With Turnstile on, `resolveUser` accepts only the signed `demo_user` cookie (`email.hmac`, keyed by `TURNSTILE_SECRET`) and ignores the `x-demo-user` header and `?as=`, so a script cannot skip the bot check by writing a cookie or sending a header (`actor.test.ts`). A site key without its secret refuses anonymous sign-in instead of running unprotected, and lets no demo identity in. Both unset turns the check off for dev, tests and e2e. Proof: `turnstile.test.ts` (missing, forged, oversized and valid tokens, switcher, misconfigured, off, siteverify fails closed). Locally, with Cloudflare's published test keys: the real widget's token signs in through the real siteverify; a forged `curl` submit of the Server Action with no token gets "Complete the bot check" and no cookie; with the always-fail test secret, a token gets "The bot check did not pass" and no cookie. **Live since 2026-11-05:** widget `shortstop-sign-in` (managed, restricted to the workers.dev host); `TURNSTILE_SITEKEY` and `TURNSTILE_SECRET` set together with one `wrangler secret bulk`. Against the real secret, forged `curl` submits with no cookie were refused with no token ("Complete the bot check") and with a fake token ("The bot check did not pass"), neither setting a cookie; a signed-in persona switch still works without a token, and a non-demo cookie does not count as signed in |
| F3 | Structured `[AUDIT]` JSON (actor, action, target, timestamp, outcome) | ✅ | `lib/audit.ts`: `{ ts, actor, action, target, outcome, id, payload }`, logged only after the D1 commit. A rejected commit is logged with `outcome: "rejected"`. `wrangler tail \| grep AUDIT` returns parseable lines |
| F4 | AI Gateway in front of model calls | ✅ | Every `AI.run` goes through `{ gateway: { id: AI_GATEWAY_ID } }` when the var is set (`lib/ai.ts`, `apps/ai-worker/src/index.ts`). Only the RAG note uses the gateway cache (1 h); extraction stays on the KV content-hash cache so nothing is cached twice. The Free plan has no dollar spend, so the "cap" is a gateway rate limit plus the 10k neurons/day quota: a quota guard, not a spend cap. The gateway `shortstop` was created with `cf ai-gateway gateways create` (authentication on, logs on, 60 requests/60 s sliding rate limit, 1 h cache TTL); live `/api/search` returns 200 through it. `cf` also exposes `--spend-limits-*` flags; they were not set because Workers AI here is free-tier |
| F5 | Secret-rotation drill | ✅ | The AI Worker accepts `AI_SHARED_SECRET` or `AI_SHARED_SECRET_NEXT` (`apps/ai-worker/src/index.ts`; test: "accepts either secret during a rotation window"). Wrong order first (precedent `null`, the call hit the 8 s timeout), then the dual-key order (200 throughout): [rotation-drill.md](rotation-drill.md) |

---

## Answers to the "questions to ask yourself"

**A: Can you follow a request from the browser to the page it renders?**
1. `GET /app` misses Static Assets and reaches `src/entry.ts`, which sends it to OpenNext (only `/api/*` goes to Hono).
2. The `(app)` layout calls `resolveUser` on the request (Access JWT, else the httpOnly `demo_user` cookie) and maps the identity to a D1 user.
3. The board page, a Server Component, calls `loadBoard(env)`, which reads D1 and asks `BoardDO` who is watching.
4. React renders it on the server; the browser hydrates only the board island (filters, editors, keyboard shortcuts).
5. A commit is a Server Action: `withActor` checks the role and the write limiter, then `commitLot` calls `LotDO`.
6. `LotDO` broadcasts through `BoardDO`; every open tab's `LiveRefresh` calls `router.refresh()` and the page re-renders on the server.

**A: Why does `fetchJson<T>` look the way it does?**
Types disappear at runtime. `T` is a promise to the compiler, not a check. That is why the old SPA's `api<T>` only parsed and typed the response, and why, after the Next.js move, there is no client fetch helper at all: data crosses from Server Components as props typed by `packages/shared/src/views.ts`, and every *untrusted* boundary is validated with Zod instead: form data and request bodies inside the services, and AI output.

**B: Where does your form's validation actually run?**
In both places, from one schema. The browser gives fast feedback. The server is the authority: `curl` a bad payload and it returns 400.

**C: Why doesn't `bcrypt` run on Workers, and what replaces it?**
It's a native C++ addon, and Workers can't load `.node` binaries. The pure-JS port is CPU-heavy on a CPU-billed runtime. The replacement is WebCrypto: `crypto.subtle.deriveBits` with PBKDF2 and a per-user salt. ShortStop sidesteps passwords entirely with Cloudflare Access.

**C: What is `ctx.waitUntil` for?**
It keeps work alive after the response has been sent (used in the drill). If you forget it, fire-and-forget promises can be cancelled when the response finishes. ShortStop awaits its side effects inside Durable Objects and Workflows instead, which have their own lifetimes and retries.

**C: Secrets vs vars?**
Vars are committed config that anyone with dashboard access can see: `AUTOPILOT_WINDOW_MINUTES`, `DEMO_AUTH`. Secrets are set with `wrangler secret put`, encrypted, and never in the repo: `AI_SHARED_SECRET`, `ACCESS_AUD`.

**C: Where does "cold start ≈ 0" break down?**
- Remote calls: Workers AI and Vectorize take hundreds of milliseconds.
- The first request to a Durable Object that has been evicted.
- Big bundles.

Startup itself was 12–17 ms here.

**D: Why does each piece of data live where it does?**

| Store | What lives there | Why |
|---|---|---|
| D1 | Records you query and join (notices, lots, allocations, audit) | Relational |
| DO SQLite | The ledger | Needs single-writer correctness |
| KV | Caches you can rebuild | Eventually consistent |
| R2 | Files | Object store |
| Vectorize | Embeddings | Search by meaning |

**D: D1 transaction limits?**
Writes are small batches: one lot's projection, or one notice's plan. The seed is applied as a file. The nightly UPSERT is a single `INSERT … SELECT`.

**E: In one sentence, what conflict does your DO prevent?**
Two planners committing more of a scarce lot than exists.

**E: What happens if the AI or service Worker is slow or down?**
- Extraction retries as a Workflow step, then the notice goes to triage.
- The precedent call times out after 8 s and returns `null`.
- Indexing failures are logged and skipped.
- Allocation never waits on AI.

**E: Why is it safe to run your scheduled task twice?**
- The cover history UPSERTs on `(day, site, drug)`.
- The sweep only finalizes reservations that are due, and re-drives outbox rows that are guarded by `state_version`.
- Replays change nothing.

**F: Could you trace every change to a record from logs alone?**
Yes. Every change has an `audit_log` row (in the same transaction) and an `[AUDIT]` line, with actor, action, target and outcome. Autopilot actors name the rule and policy version, for example `autopilot:small-confident-auto@v1`.

## Reference build
EdgeLedger (`NewPage-Solutions-Inc/typescript-cloudflare-project`) is now cloned read-only beside this repo and nothing was copied from it. The comparison is in [REFERENCE-COMPARISON.md](REFERENCE-COMPARISON.md).
