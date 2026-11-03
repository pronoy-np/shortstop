# #project-jedi submission post (draft)

> Paste into `#project-jedi`. The repo is private: give the panel access first.

---

**ShortStop: a drug-shortage allocation desk on Cloudflare** 💊

**App:** https://shortstop.shortstop-worker.workers.dev (demo sign-in: use the user switcher at the top right to play planner, pharmacist or ops lead)
**Repo:** https://github.com/pronoy-np/shortstop (private: add the panel as collaborators, or make it public before posting)

**What it does:** When a drug is short, wholesalers send allocation notices ("you get 150 vials, not 400"). ShortStop handles them for a health system's central pharmacy:
- Workers AI reads the notice (PDF, .eml or text) into structured lots and refuses anything that isn't a valid notice.
- A deterministic engine proposes a split across 10 hospitals, evening out days of cover weighted by acuity.
- A human-configured **autopilot policy** decides what auto-commits, with a 15-minute cancel/take-over window, and what waits for a planner.
- **Hard floors in code:** tier-1 drugs never auto-commit, and substitutes always need a pharmacist.
- A Durable Object ledger guarantees a scarce lot is never over-allocated. If two planners commit at once, one wins and the other gets a live rebased split.

**Cloudflare services:** Workers · Static Assets · D1 (+ Drizzle migrations) · KV · R2 · Durable Objects (SQLite ledger + alarms, WebSocket hibernation) · Queues + DLQ · Workflows · Workers AI (JSON mode + toMarkdown) · Cron Triggers · audit log. It all runs on the **Workers Free plan at $0**.

**Quality:** 73 tests run in workerd, including concurrent-commit races, idempotent replays, an injected D1 failure during auto-commit (recovered through a transactional outbox), the full upload → queue → workflow → confirmation path and role checks. Extraction evals run against the real model on 10 notices, including adversarial ones (a forwarded correction, a cancelled line, a marketing email); the latest run scored 10/10.

Happy to walk the panel through it. The demo takes about 5 minutes.
