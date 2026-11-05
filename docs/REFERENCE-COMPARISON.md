# ShortStop vs the EdgeLedger reference

EdgeLedger was read after ShortStop's Clusters A–E were built. Nothing was copied. Only Cluster F was compared in detail so far.

| Topic | EdgeLedger | ShortStop | Why different |
|---|---|---|---|
| Rate limit | `LOGIN_LIMITER` (`unsafe.bindings`, 5 per 60 s) keyed on IP, guarding login | `WRITE_LIMITER`, 30 per 60 s keyed on actor email, on every write route | ShortStop has no password login; its busy path is writes, and Access hides client IPs |
| Turnstile | `siteverify` on the public login form, skipped when the secret is unset | Not added | No public form exists (see CLUSTERS.md F2) |
| AI Gateway | none found | Routes all model calls; cache on only for the RAG note | Brief asks for it; KV already caches extraction |
| Secret rotation | none found | Dual-key `AI_SHARED_SECRET_NEXT` on the AI Worker | Only one secret crosses Workers |
| Layout | Several Workers plus Next.js and TanStack front ends | One API Worker, one AI Worker, a Vite SPA | Free-plan CPU limit rules out SSR |

Still to compare: Clusters A–E file by file.
