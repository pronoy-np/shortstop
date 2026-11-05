// Optional secret: set with `wrangler secret put ACCESS_AUD` once Cloudflare Access is configured.
interface Env {
  ACCESS_AUD?: string;
  // Shared with the shortstop-ai Worker; precedents are skipped when unset.
  AI_SHARED_SECRET?: string;
  // Per-actor write throttle (30 / 60 s). Optional so a missing binding fails open.
  WRITE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}
