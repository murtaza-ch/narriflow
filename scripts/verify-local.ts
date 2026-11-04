import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Fast checks only. The owner disabled PostgreSQL gates and other resource-heavy
// suites (builds, Docker, workerd, integrations) on 2026-11-04: do not add them back.
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const requiredBun = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager;
if (`bun@${Bun.version}` !== requiredBun) throw new Error(`Use ${requiredBun} for local verification.`);
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
env.PATH = `${dirname(process.execPath)}:${env.PATH ?? ""}`;
const bun = process.execPath;

async function run(command: string[]) {
  console.log(`\nLocal verification: ${command.join(" ")}`);
  const child = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Local verification failed: ${command[0]} ${command[1] ?? ""}. Push blocked.`);
}

await run([bun, "run", "lint"]);
await run([bun, "run", "typecheck"]);
await run([bun, "run", "test"]);
await run([bun, "run", "--cwd", "apps/api", "test:inventory"]);
await run([bun, "run", "--cwd", "apps/api", "openapi:check"]);
await run([bun, "run", "--cwd", "apps/api", "build:worker"]);
await run([bun, "run", "check:web-split"]);
await run([bun, "run", "env:check"]);
console.log("\nLocal verification passed. Push allowed.");
