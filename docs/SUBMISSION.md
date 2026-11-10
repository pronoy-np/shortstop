# #project-jedi submission post (draft)

> Paste into `#project-jedi`. The repo is private: give the panel access first.

---

**ShortStop: a drug-shortage allocation desk on Cloudflare** 💊

**App:** https://shortstop.shortstop-worker.workers.dev
**Start here:** open the desk, pass the bot check, sign in as **Olu (Ops lead)**, and click **Multi-lot notice** under "How the desk works" on the board. Its lots appear within seconds. Use "Viewing as" at the top right to switch to the planner or pharmacist.
**Repo:** https://github.com/pronoy-np/shortstop (private: add the panel as collaborators, or make it public before posting)

**What it does:** When a drug is short, wholesalers send allocation notices ("you get 150 vials, not 400"). ShortStop handles them for a health system's central pharmacy:
- Workers AI reads the notice (PDF, .eml or text) into structured lots and refuses anything that isn't a valid notice.
- A deterministic engine proposes a split across 10 hospitals, evening out days of cover weighted by acuity.
- A human-configured **autopilot policy** decides what auto-commits, with a 15-minute cancel/take-over window, and what waits for a planner.
- **Hard floors in code:** tier-1 drugs never auto-commit, and substitutes always need a pharmacist.
- A Durable Object ledger guarantees a scarce lot is never over-allocated. If two planners commit at once, one wins and the other gets a live rebased split.
- Past shortages inform the next one: lots are embedded in Vectorize for search by meaning, and a separate RAG Worker (behind a service binding, no public URL) writes precedent notes that cite only retrieved records.

**How it's built:** the UI is **Next.js 16 on OpenNext inside the same Worker**: Server Components read through one service layer, every write is a Server Action, and a live board WebSocket triggers a server refresh. `/api/*` and the WebSocket skip Next (2–7 ms of CPU). Next pages go over the Free plan's 10 ms, so that cost is measured instead of forbidden: about 15–60 ms warm, zero `exceededCpu` in every sample, with a free per-route fallback written down in an ADR (never the Paid plan).

**Cloudflare services:** Workers (×2, service binding) · Static Assets · D1 (+ Drizzle migrations) · KV · R2 · Durable Objects (SQLite ledger + outbox + alarms, WebSocket hibernation) · Queues + DLQ · Workflows · Workers AI (JSON mode, toMarkdown, embeddings) · Vectorize · Cron Triggers · structured audit log. It all runs on the **Workers Free plan at $0**.

**Cluster F, done and live:** a rate-limit binding on every write (keyed by user, not IP), Turnstile on sign-in with an HMAC-signed session cookie, AI Gateway in front of every model call, and a secret-rotation drill run against the live Workers.

**Quality:** 165 tests (Worker suites in workerd) plus 7 Playwright end-to-end tests, including concurrent-commit races, idempotent replays, an injected D1 failure during auto-commit (recovered through a transactional outbox), the full upload → queue → workflow → confirmation path and role checks. Extraction evals run against the real model on 10 notices, including adversarial ones (a forwarded correction, a cancelled line, a marketing email); the latest run scored 10/10.

Happy to walk the panel through it. The demo takes about 5 minutes.
