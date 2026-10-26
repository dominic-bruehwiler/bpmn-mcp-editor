/**
 * Aligns the Prisma schema with DATABASE_URL and generates the client.
 * SQLite is the default. A postgres:// or postgresql:// URL switches the provider.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const schemaPath = new URL("../prisma/schema.prisma", import.meta.url);

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:../data/dev.db";
}

mkdirSync(new URL("../data", import.meta.url), { recursive: true });

const provider = process.env.DATABASE_URL.startsWith("postgres")
  ? "postgresql"
  : "sqlite";

const current = readFileSync(schemaPath, "utf8");
const next = current.replace(
  /provider\s*=\s*"(sqlite|postgresql)"/,
  `provider = "${provider}"`,
);
if (next !== current) {
  writeFileSync(schemaPath, next);
  console.log(`Prisma provider set to ${provider}`);
}

const generateOnly = process.argv.includes("--generate-only");

function run(args: string[]) {
  const result = spawnSync("bunx", ["prisma", ...args], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(["generate"]);

if (!generateOnly) {
  run(["db", "push", "--skip-generate"]);
  console.log(`Database ready (${provider})`);
}
