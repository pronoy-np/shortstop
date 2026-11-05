# Run Next.js on Workers with OpenNext, not vinext

**Status:** accepted, 2026-11-05

## Context

Cloudflare's framework guides now recommend vinext for new Next.js apps on Workers, so a future reader will ask why ShortStop uses OpenNext. vinext is a Vite plugin that reimplements the Next.js API. OpenNext (`@opennextjs/cloudflare`) adapts the output of a real `next build`.

## Decision

Use OpenNext. Pin the exact versions the spike measured: `next@16.4.5`, `@opennextjs/cloudflare@1.20.16`, `wrangler@4.157.0`.

## Why

- **OpenNext is the only option measured on Workers Free.** The CPU numbers behind [ADR 0001](0001-free-plan-with-a-soft-cpu-budget.md) come from it.
- **vinext has no Workers CPU numbers.** The only benchmark found is on Node, and it shows server rendering slower than real Next.js.
- **ShortStop's exports are proven on OpenNext.** Everything the one Worker exports (Durable Objects, `scheduled()`, the WebSocket path) ran in the OpenNext spike. vinext has no source for `queue()` or Workflow exports.
- **OpenNext uses `wrangler.jsonc` natively.** vinext now defaults new projects to `cloudflare.config.ts`.
- **The course checks real Next.js.** The brief says `create-next-app`, and the reference build uses OpenNext.
- **vinext's one edge is already covered.** It serves prerendered pages from assets, and OpenNext's static-assets cache does the same (2–3 ms measured).

## Consequences

- Any Next or OpenNext upgrade re-runs `scripts/cpu-sample.ts` before it ships, because ADR 0001's numbers are tied to these versions.
- Revisit vinext once it leaves beta and publishes Workers CPU numbers, plus support for `queue()` and Workflow exports.
