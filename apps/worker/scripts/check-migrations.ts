/**
 * Fails if wrangler.jsonc's Durable Object `migrations` block or class bindings change. Live LotDO state (the only
 * writer of each lot's remaining quantity) survives a deploy only while the class names and migration tags stay the same.
 * Runs as part of `pnpm typecheck`. If a migration is ever genuinely needed, change EXPECTED here in the same reviewed PR.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXPECTED = {
  migrations: [{ tag: "v1", new_sqlite_classes: ["LotDO", "BoardDO"] }],
  classes: [
    { name: "LOT_DO", class_name: "LotDO" },
    { name: "BOARD_DO", class_name: "BoardDO" },
  ],
};

/** Strips // and /* *\/ comments and trailing commas (outside strings) so JSON.parse can read JSONC. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

type Config = { migrations?: unknown; durable_objects?: { bindings?: unknown }; env?: Record<string, { durable_objects?: { bindings?: unknown } }> };

const path = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const config = parseJsonc(readFileSync(path, "utf8")) as Config;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const problems: string[] = [];
if (!same(config.migrations, EXPECTED.migrations)) problems.push(`migrations changed: ${JSON.stringify(config.migrations)}`);
if (!same(config.durable_objects?.bindings, EXPECTED.classes)) problems.push(`durable_objects.bindings changed: ${JSON.stringify(config.durable_objects?.bindings)}`);
for (const [name, env] of Object.entries(config.env ?? {}))
  if (!same(env.durable_objects?.bindings, EXPECTED.classes)) problems.push(`env.${name}.durable_objects.bindings changed`);

if (problems.length) {
  console.error(`wrangler.jsonc: Durable Object classes or migrations changed. Live LotDO state depends on them.\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("wrangler.jsonc: Durable Object migrations unchanged");
