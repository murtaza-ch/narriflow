import { DATABASE_CHECKS, assertLocalTestDatabase } from "./local-verification-plan";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const gitConfig = (key: string) => {
  try { return execFileSync("git", ["config", "--get", key], { cwd: root, encoding: "utf8" }).trim(); }
  catch { return ""; }
};
const requiredBun = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager;
if (`bun@${Bun.version}` !== requiredBun) throw new Error(`Use ${requiredBun} for local verification.`);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone Git hook, outside Turborepo caching.
const database = process.env.SERVERLESS_TEST_DATABASE_URL || gitConfig("narriflow.testDatabaseUrl");
if (!database) throw new Error("Set SERVERLESS_TEST_DATABASE_URL or git config --local narriflow.testDatabaseUrl to an isolated local PostgreSQL 17 database with pgvector.");
assertLocalTestDatabase(database);
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !/^(DATABASE_URL|DIRECT_URL|ALLOW_.*DB_TESTS)$|_TEST_DATABASE_(URL|SCHEMA)$|KEEP.*SCHEMA|SKIP.*MIGRAT/.test(key)) env[key] = value;
}
env.PATH = `${dirname(process.execPath)}:${env.PATH ?? ""}`;
env.DATABASE_URL = database;
env.DIRECT_URL = database;
env.SERVERLESS_TEST_DATABASE_URL = database;
// Every domain runner receives the same isolated target, regardless of shell settings.
for (const directory of ["packages/services/scripts", "apps/api/scripts"]) {
  const glob = new Bun.Glob("run-*-db-tests.ts");
  for (const file of glob.scanSync({ cwd: join(root, directory) })) {
    const source = readFileSync(join(root, directory, file), "utf8");
    for (const match of source.matchAll(/\b[A-Z][A-Z0-9_]*_TEST_DATABASE_URL\b/g)) env[match[0]] = database;
  }
}
env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
env.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

async function run(command: string[], cwd = root) {
  console.log(`\nLocal verification: ${command.join(" ")}`);
  const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Local verification failed: ${command[0]} ${command[1] ?? ""}. Push blocked.`);
}
const bun = process.execPath;
const nextEnv = join(root, "apps/web/next-env.d.ts");
const originalNextEnv = readFileSync(nextEnv, "utf8");
try {
  await run([bun, "run", "lint"]);
  await run([bun, "run", "typecheck", "--", "--force"]);
  await run([bun, "run", "test", "--", "--concurrency=1", "--force"]);
  for (const name of DATABASE_CHECKS) {
    await run([bun, "--no-env-file", "run", `test:${name}:db`]);
  }
  await run([bun, "run", "--cwd", "apps/api", "test:inventory"]);
  await run([bun, "run", "--cwd", "apps/api", "openapi:check"]);
  await run([bun, "run", "--cwd", "apps/api", "build:worker"]);
  await run(["node", "--experimental-strip-types", "apps/api/scripts/run-development-binding-gates.ts"]);
  await run([bun, "run", "--cwd", "apps/api", "test:development-progress:workerd"]);
  await run([bun, "run", "test:mcp:integration"]);
  await run([bun, "run", "audit:production"]);
  await run([bun, "run", "env:check"]);
  await run(["npm", "ci"], join(root, "integrations/zapier"));
  for (const name of ["typecheck", "test", "validate"]) await run(["npm", "run", name], join(root, "integrations/zapier"));
  const makeTests = [...new Bun.Glob("integrations/make/test/*.test.mjs").scanSync({ cwd: root })].sort();
  await run(["node", "--test", ...makeTests]);
  await run([bun, "run", "build"]);
  await run([bun, "run", "check:web-split", "--", "--bundle"]);

  // Native Linux tests use only committed source, no host mounts or credentials.
  const context = mkdtempSync(join(tmpdir(), "narriflow-local-native-"));
  const docker = ["docker", "--context", gitConfig("narriflow.dockerContext") || "default"];
  try {
    const archive = join(context, "source.tar");
    execFileSync("git", ["archive", "--output", archive, "HEAD"], { cwd: root });
    execFileSync("tar", ["-xf", archive, "-C", context]);
    rmSync(archive);
    writeFileSync(join(context, ".dockerignore"), readFileSync(join(context, "apps/media/images/render.dockerignore")));
    const image = `narriflow-media:local-${execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()}`;
    await run([...docker, "build", "--platform", "linux/amd64", "-f", "apps/media/images/Dockerfile", "--build-arg", "MEDIA_PROFILE=render", "--build-arg", "MEDIA_THREADS=4", "-t", image, "."], context);
    await run([...docker, "run", "--rm", "--init", "--platform", "linux/amd64", "--network", "none", "--cpus", "4", "--memory", "8g", "--memory-swap", "8g", "--workdir", "/app", "--env", "PYTHONPATH=/app/apps/media/python:/app", image, "python", "-m", "unittest", "discover", "-s", "apps/media/python/tests", "-p", "test_*.py"]);
  } finally { rmSync(context, { recursive: true, force: true }); }
} finally {
  const current = readFileSync(nextEnv, "utf8");
  const normalized = (value: string) => value.replaceAll(".next/dev/types/", ".next/types/");
  if (normalized(current) === normalized(originalNextEnv)) writeFileSync(nextEnv, originalNextEnv);
  else { console.error("Unexpected next-env.d.ts change; preserved for review. Push blocked."); process.exitCode = 1; }
}

if (!process.exitCode) console.log("\nLocal verification passed. Push allowed.");
