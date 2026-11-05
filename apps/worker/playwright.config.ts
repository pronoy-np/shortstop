import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 8799);

/**
 * `pnpm test:e2e`: the real Worker (Next pages, Server Actions, Hono, Durable Objects) via `opennextjs-cloudflare
 * preview` under the wrangler `e2e` env, against fresh local state. No AI is called: the e2e env has no queue
 * consumer and no AI bindings. `E2E_SKIP_BUILD=1` reuses the last build.
 */
export default defineConfig({
  testDir: "./e2e",
  // One Worker and one D1 for the whole run; tests seed their own lots, but run one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  webServer: {
    command: "./scripts/e2e-server.sh",
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
