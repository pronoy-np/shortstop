import type { NextConfig } from "next";

// Local dev is `pnpm dev` (opennextjs-cloudflare build + preview): `next dev` can't reach the Durable Objects and
// Workflow declared in this same Worker, so there is no initOpenNextCloudflareForDev() here.
const nextConfig: NextConfig = {
  // packages/shared ships TypeScript source.
  transpilePackages: ["@shortstop/shared"],
  experimental: {
    // The intake form uploads notices up to 5 MB through a Server Action; the default 1 MB would reject them first.
    // The limit covers the whole multipart body, so it sits above the file limit: a file just over 5 MB then reaches
    // the service and gets its "file larger than 5 MB" message instead of an opaque framework error.
    serverActions: { bodySizeLimit: "6mb" },
  },
};

export default nextConfig;
