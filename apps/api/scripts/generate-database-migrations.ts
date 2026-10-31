import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const directory = new URL("../../../packages/db/prisma/migrations/", import.meta.url);
const target = new URL("../src/generated/database-migrations.json", import.meta.url);
const names = readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/migration.sql`, directory)))
  .map((entry) => entry.name)
  .sort();
const expected = `${JSON.stringify(names, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!existsSync(target) || readFileSync(target, "utf8") !== expected) {
    throw new Error("Database migration manifest is stale. Run migrations:generate in apps/api.");
  }
} else {
  writeFileSync(target, expected);
}
