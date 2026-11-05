# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Planners, pharmacists and an ops lead at the central pharmacy (the "desk") of an integrated delivery network. They sit at a desktop monitor in a lit office, working time-pressured allocation of scarce drug supply across member hospitals. A second audience is a judge or reviewer who opens the live demo cold, with synthetic data and a persona switcher.

## Product Purpose
ShortStop reads wholesaler allocation notices, proposes a deterministic split of each lot across hospital sites by days of cover (weighted by clinical tier), and lets planners commit it without ever over-allocating a lot. Success is a defensible split committed fast, with a full audit trail.

## Positioning
The AI only extracts notices; it never decides quantities. Splits are deterministic, tier-1 drugs and substitutes always need a human (hard floors in code), and a single Durable Object is the only writer of a lot's remaining quantity.

## Operating Context
Roles: planner (commits allocations), pharmacist (approves substitutes), ops lead (edits the policy). Data: allocation notices (PDF, .eml, pasted text), lots, sites, days of cover, tiers 1-3, reservations with a 15-minute window, policy versions, audit log. Runs on the Cloudflare Workers Free plan.

## Capabilities and Constraints
- Next.js 16 App Router on OpenNext; UI is /, /sign-in and the gated desk under /app. Styling is plain CSS in app/styles.css and app/nav.css, fonts via @fontsource.
- Pages run under a soft CPU budget; keep the UI cheap (no heavy client libraries, no runtime font fetches from third-party hosts).
- Status vocabulary carries meaning: critical, warning, ok, reserved/processing, tier 1/2/3, days-of-cover floor of 5 days.
- Synthetic demo data only.

## Brand Commitments
Name "ShortStop", the existing headline and UI copy, the vial-and-dashed-line logo shape, and behavior/layout stay. Confirmed by the user: restyle all surfaces (landing, sign-in, desk). Assumed, not explicitly confirmed (the user's "keep" answer was blank): critical/warning/ok keep their meanings and the logo may be recolored but not redrawn.

## Evidence on Hand
Live site https://shortstop.shortstop-worker.workers.dev. No customer logos, testimonials or benchmarks exist; none may be invented.

## Product Principles
- The number is the interface: days of cover, quantities and status must scan instantly.
- Never imply the AI decides; the human commit is the climax of every flow.
- Color means state; decoration earns no color.
- Everything on screen is explainable and auditable.

## Accessibility & Inclusion
WCAG AA contrast at minimum; keyboard-operable desk (shortcuts exist); respect prefers-reduced-motion; do not rely on color alone for status.
