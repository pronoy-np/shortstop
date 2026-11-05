// Optional secret: set with `wrangler secret put ACCESS_AUD` once Cloudflare Access is configured.
interface Env {
  ACCESS_AUD?: string;
  // Shared with the shortstop-ai Worker; precedents are skipped when unset.
  AI_SHARED_SECRET?: string;
  // Per-actor write throttle (30 / 60 s). Optional so a missing binding fails open.
  WRITE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  // `wrangler types` marks these optional because the e2e env leaves them out (no model calls in e2e). Production
  // always binds them, and e2e never reaches the code that uses them (no queue consumer; search is not exercised).
  AI: Ai;
  VEC: VectorizeIndex;
  AI_SVC: Fetcher;
}

// The same narrowing for `env` from "cloudflare:workers" (tests).
declare namespace Cloudflare {
  interface Env {
    AI: Ai;
    VEC: VectorizeIndex;
    AI_SVC: Fetcher;
  }
}
