#!/usr/bin/env bash
# Starts the full Worker for `pnpm test:e2e`: a fresh local D1 (migrations + seed), the OpenNext build, and
# `opennextjs-cloudflare preview` under the wrangler `e2e` env (no queue consumers, no cron, no AI bindings).
# State lives in .wrangler/e2e so it never touches `pnpm dev`'s local data. Playwright starts and stops this.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${E2E_PORT:-8799}"
STATE=.wrangler/e2e
rm -rf "$STATE"
pnpm exec wrangler d1 migrations apply shortstop --local --env e2e --persist-to "$STATE"
pnpm exec wrangler d1 execute shortstop --local --env e2e --persist-to "$STATE" --file ../../packages/db/seed.sql
if [ -z "${E2E_SKIP_BUILD:-}" ]; then pnpm exec opennextjs-cloudflare build; fi
exec pnpm exec opennextjs-cloudflare preview --env e2e --port "$PORT" --ip 127.0.0.1 --persist-to "$STATE"
