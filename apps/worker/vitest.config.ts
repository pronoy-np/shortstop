import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run fully local in workerd/Miniflare. remoteBindings: false keeps Workers AI and Vectorize out of tests:
// extraction is exercised with fakes here and against the real model in evals/ (pnpm eval).
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("../../packages/db/migrations"),
          AI_SHARED_SECRET: "test-shared-secret",
        },
        // Stand-in for the shortstop-ai Worker (tested on its own in apps/ai-worker).
        serviceBindings: {
          AI_SVC: async (req: Request) => {
            if (req.headers.get("x-shortstop-secret") !== "test-shared-secret") return Response.json({ error: "forbidden" }, { status: 403 });
            const body = (await req.json()) as { text: string };
            if (body.text.includes("AI-DOWN")) return new Response("boom", { status: 500 });
            if (body.text.includes("AI-SLOW")) await new Promise((r) => setTimeout(r, 3000));
            return Response.json({ note: "Last cycle this wholesaler shipped less than half the order [1].", sources: ["n_past-1"] });
          },
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
}));
