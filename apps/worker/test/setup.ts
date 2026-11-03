import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import seedSql from "../../../packages/db/seed.sql?raw";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

const statements = seedSql
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("--"))
  .map((l) => testEnv.DB.prepare(l));
await testEnv.DB.batch(statements);
