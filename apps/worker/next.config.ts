import type { NextConfig } from "next";

// Local dev is `pnpm dev` (opennextjs-cloudflare build + preview): `next dev` can't reach the Durable Objects and
// Workflow declared in this same Worker, so there is no initOpenNextCloudflareForDev() here.
const nextConfig: NextConfig = {
  // packages/shared ships TypeScript source.
  transpilePackages: ["@shortstop/shared"],
  experimental: {
    // The intake form uploads notices up to 5 MB through a Server Action; the default 1 MB would reject them first.
    serverActions: { bodySizeLimit: "5mb" },
  },
};

export default nextConfig;
