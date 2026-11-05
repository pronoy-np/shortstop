/**
 * CPU sample, the cutover gate from ADR 0001: per-route median and p90 of `cpuTime` from `wrangler tail`, and a count
 * of `exceededCpu` outcomes. Exits 1 if any request ran out of CPU (the gate requires zero).
 *
 *   node scripts/cpu-sample.ts --worker shortstop-next --seconds 120   # tails live while you drive traffic
 *   node scripts/cpu-sample.ts --file tail.jsonl                        # a saved `wrangler tail --format json` log
 *
 * Read-only: it never deploys or sends traffic. Record the table in docs/CLUSTERS.md.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

type TailEvent = {
  outcome?: string;
  cpuTime?: number;
  event?: { request?: { url?: string; method?: string; headers?: Record<string, string> } };
};

type Sample = { route: string; cpu: number; outcome: string };

/** One row per route shape: ids collapsed, Server Actions told apart from page GETs, build assets grouped. */
export function routeOf(method: string, url: string, headers: Record<string, string> = {}): string {
  const path = new URL(url).pathname
    .replace(/\/n_[a-z0-9]+-\d+/g, "/:lot")
    .replace(/^\/_next\/static\/.*/, "/_next/static/*")
    .replace(/^\/notices\/.*/, "/notices/*");
  const action = method === "POST" && Object.keys(headers).some((h) => h.toLowerCase() === "next-action");
  const ws = Object.entries(headers).some(([k, v]) => k.toLowerCase() === "upgrade" && v.toLowerCase() === "websocket");
  return `${action ? "ACTION" : ws ? "WS" : method} ${path}`;
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export function summarize(samples: Sample[]) {
  const by = new Map<string, Sample[]>();
  for (const s of samples) by.set(s.route, [...(by.get(s.route) ?? []), s]);
  return [...by.entries()]
    .map(([route, rows]) => {
      const cpu = rows.map((r) => r.cpu).sort((a, b) => a - b);
      return {
        route,
        n: rows.length,
        median: percentile(cpu, 50),
        p90: percentile(cpu, 90),
        max: cpu.at(-1) ?? NaN,
        over10ms: cpu.filter((c) => c > 10).length,
        exceededCpu: rows.filter((r) => r.outcome === "exceededCpu").length,
      };
    })
    .sort((a, b) => a.route.localeCompare(b.route));
}

/** A complete tail event as a sample, `null` for events without a request (cron, queue, alarm), `undefined` if incomplete. */
function parse(text: string): Sample | null | undefined {
  let e: TailEvent;
  try {
    e = JSON.parse(text) as TailEvent;
  } catch {
    return undefined;
  }
  const req = e.event?.request;
  if (!req?.url || typeof e.cpuTime !== "number") return null;
  return { route: routeOf(req.method ?? "GET", req.url, req.headers), cpu: e.cpuTime, outcome: e.outcome ?? "unknown" };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = arg("file");
  const worker = arg("worker") ?? "shortstop";
  const seconds = Number(arg("seconds") ?? 120);
  const samples: Sample[] = [];

  // `wrangler tail --format json` pretty-prints one JSON object per event; accumulate lines until one parses.
  let buf = "";
  const take = (line: string) => {
    buf += line + "\n";
    const s = parse(buf);
    if (s) samples.push(s);
    if (s !== undefined || !buf.trimStart().startsWith("{")) buf = "";
  };

  if (file) {
    for await (const line of createInterface({ input: createReadStream(file) })) take(line);
  } else {
    console.error(`tailing ${worker} for ${seconds}s; drive traffic now…`);
    const tail = spawn("pnpm", ["exec", "wrangler", "tail", worker, "--format", "json"], { stdio: ["ignore", "pipe", "inherit"] });
    const lines = createInterface({ input: tail.stdout });
    lines.on("line", take);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    tail.kill("SIGINT");
  }

  const rows = summarize(samples);
  console.table(rows);
  const exceeded = rows.reduce((n, r) => n + r.exceededCpu, 0);
  console.log(`${samples.length} requests sampled · ${exceeded} exceededCpu`);
  if (!samples.length) console.error("no requests sampled: is the worker name right, and was there traffic?");
  process.exit(exceeded > 0 || !samples.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
