import { DATABASE_CHECKS, assertLocalTestDatabase } from "../../scripts/local-verification-plan";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../..");

function packageJson(path: string) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8")) as {
    scripts?: Record<string, string>;
  };
}

describe("repository verification commands", () => {
  test("the documented lint command is the repository-wide Biome check", () => {
    const root = packageJson("package.json");
    expect(root.scripts?.lint).toBe("biome check .");
    expect(root.scripts?.["lint:biome"]).toBeUndefined();
  });

  test("official workspace aggregates contain no successful no-op lint or test tasks", () => {
    const workspaces = [
      "apps/api/package.json",
      "apps/mcp/package.json",
      "apps/web/package.json",
      "apps/media/package.json",
      "packages/api-client/package.json",
      "packages/auth/package.json",
      "packages/composition-plan/package.json",
      "packages/config/package.json",
      "packages/db/package.json",
      "packages/email/package.json",
      "packages/mcp-core/package.json",
      "packages/services/package.json",
      "packages/ui/package.json",
      "packages/validators/package.json",
    ];
    for (const workspace of workspaces) {
      const scripts = packageJson(workspace).scripts ?? {};
      expect(scripts.lint ?? "").not.toContain("no-op");
      expect(scripts.test ?? "").not.toContain("no-op");
    }
  });

  test("the fast aggregate names its scope before running every active package suite", () => {
    const command = packageJson("package.json").scripts?.test;
    expect(command).toContain("Fast tests exclude disposable-schema PostgreSQL invariants");
    expect(command).toContain("turbo run test");
    expect(packageJson("apps/web/package.json").scripts?.test).toBe("bun test");
  });
});

describe("local pre-push verification", () => {
  test("every disposable database command is included exactly once", () => {
    const commands = Object.keys(packageJson("package.json").scripts ?? {}).filter(command => command.startsWith("test:") && command.endsWith(":db")).sort();
    expect(DATABASE_CHECKS.map(name => `test:${name}:db`).sort()).toEqual(commands);
    expect(new Set(DATABASE_CHECKS).size).toBe(DATABASE_CHECKS.length);
  });

  test("the installed hook runs the local verifier and does not ignore failure", () => {
    const hook = readFileSync(resolve(repositoryRoot, ".githooks/pre-push"), "utf8");
    expect(hook).toContain("set -eu");
    expect(hook).toContain('exec "$bun_path" --no-env-file scripts/verify-local.ts');
    expect(hook).not.toContain("|| true");
    expect(packageJson("package.json").scripts?.["verify:local"]).toBe("bun --no-env-file scripts/verify-local.ts");
  });

  test("database gates accept isolated local targets and refuse shared or cloud targets", () => {
    expect(() => assertLocalTestDatabase("postgresql://localhost:55432/narriflow_serverless_gates_test")).not.toThrow();
    for (const target of ["postgresql://localhost/neondb", "postgresql://example.neon.tech/narriflow_serverless_gates_test", "https://localhost/narriflow_serverless_gates_test"]) expect(() => assertLocalTestDatabase(target)).toThrow();
  });
});
