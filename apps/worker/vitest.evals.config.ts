import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Evals hit the REAL Workers AI model (remote binding). Needs `wrangler login`; spends a few hundred neurons per run.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: true,
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations("../../packages/db/migrations") },
        // Extraction evals don't touch the RAG Worker; stub its binding so the runtime can start.
        serviceBindings: { AI_SVC: async () => Response.json({ note: null, sources: [] }) },
      },
    }),
  ],
  test: {
    include: ["evals/**/*.eval.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 120_000,
  },
}));
