# Stay on the Workers Free plan with a soft CPU budget for Next.js pages

**Status:** accepted, 2026-11-05

## Context

ShortStop's UI is moving from a Vite SPA to Next.js, run on Workers with `@opennextjs/cloudflare`. `CLAUDE.md` treated the Free plan's 10 ms CPU per request as a hard limit and ruled out server rendering for that reason.

A spike on the Free plan measured these costs per request:
- **Dynamic pages:** 13–40 ms warm and 146–352 ms cold.
- **Server Actions:** about 14 ms.
- **Prerendered pages:** about 2–3 ms at the median with OpenNext's static-assets cache, and 26 ms without it. A few requests still reached 13–21 ms.
- **Routes handled before Next:** 1–2 ms.

None of about 300 requests was cut off with error 1102, but Cloudflare says Workers that go over the limit consistently are terminated.

The owner's rule is absolute: **no money is spent.** The Paid plan is never the fallback.

## Decision

- Stay on Workers Free.
- Next.js routes may go over 10 ms. That cost is measured and written down, not forbidden.
- Hot paths skip Next in the custom worker entry, so they stay well under 10 ms: `/api/*` (Hono), the board WebSocket and static assets.
- A recorded `exceededCpu` outcome or a 1102 on any route triggers a free fallback, one route at a time, in this order:
  1. Make the route cheaper. Prerender it behind the static-assets cache, or render less on the server.
  2. Move that route's data rendering to the browser, fetching `/api/*`.
  3. Turn that route into a plain client page.

## Consequences

- Over-budget pages don't feel slow, because 20 ms of CPU is invisible to users. The real risk is that some requests fail with 1102 if Cloudflare stops tolerating the overage.
- A worst-case route ends up working the way the old SPA did, while the rest stays on Next.js.
- The "no SSR in the Worker" constraint in `CLAUDE.md` is replaced by this budget.
- CPU per route is sampled with `wrangler tail` as a cutover gate and recorded in `docs/CLUSTERS.md`.
- Considered and rejected:
  - **Workers Paid:** it costs money.
  - **Keeping the SPA:** the owner wants Next.js for the course requirements.
