# ShortStop vs the EdgeLedger reference

EdgeLedger was read after ShortStop's Clusters A–E were built. Nothing was copied. Only Cluster F was compared in detail so far.

| Topic | EdgeLedger | ShortStop | Why different |
|---|---|---|---|
| Rate limit | `LOGIN_LIMITER` (`unsafe.bindings`, 5 per 60 s) keyed on IP, guarding login | `WRITE_LIMITER`, 30 per 60 s keyed on actor email, on every write route | ShortStop has no password login; its busy path is writes, and Access hides client IPs |
| Turnstile | `siteverify` on the public login form, skipped when the secret is unset | `siteverify` in the public `/sign-in` Server Action. Skipped only for already-signed-in callers or when nothing is configured, and refused if a site key has no secret | The Next.js move created a public form; failing closed on misconfiguration avoids a silently unprotected form |
| AI Gateway | none found | Routes all model calls; cache on only for the RAG note | Brief asks for it; KV already caches extraction |
| Secret rotation | none found | Dual-key `AI_SHARED_SECRET_NEXT` on the AI Worker | Only one secret crosses Workers |
| Layout | Several Workers plus Next.js and TanStack front ends | One Worker (Next.js 16 on OpenNext plus the Hono API, the DOs, the queue consumer and the Workflow) and one AI Worker | One Worker keeps it on the Free plan with no cross-Worker hops; Next pages run under a measured soft CPU budget ([ADR 0001](adr/0001-free-plan-with-a-soft-cpu-budget.md)), and `/api/*` skips Next |

Still to compare: Clusters A–E file by file.
