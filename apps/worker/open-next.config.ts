import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// Prerendered pages (the landing page) are read from Workers Static Assets instead of re-rendered per request
// (ADR 0001: ~2-3 ms CPU at the median vs ~26 ms). Read-only: no revalidation, so no tag cache or queue is needed.
// `opennextjs-cloudflare deploy` populates the cache; `preview` populates it locally.
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
