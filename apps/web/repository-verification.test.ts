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
      "apps/mcp/package.json",
      "apps/web/package.json",
      "apps/worker/package.json",
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

describe("critical PostgreSQL CI gates", () => {
  const workflow = readFileSync(
    resolve(repositoryRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  const commands = [
    "test:workflow:db",
    "test:upload-session:db",
    "test:workspace-billing:db",
    "test:social-publication:db",
    "test:clip-editor-persistence:db",
    "test:authenticated-request-policy:db",
  ];

  test("runs all six domains through a parallel matrix", () => {
    expect(workflow).toContain("postgres-invariants:");
    expect(workflow).toContain("strategy:");
    expect(workflow).toContain("matrix:");
    for (const command of commands) {
      expect(workflow.match(new RegExp(`command: ${command}`, "g"))?.length).toBe(1);
    }
    expect(workflow).toContain(`run: bun run \${{ matrix.command }}`);
  });

  test("keeps fast checks database-free and retains lint, audit, and build gates", () => {
    const checkJob = workflow.slice(
      workflow.indexOf("  check:"),
      workflow.indexOf("  postgres-invariants:"),
    );
    expect(checkJob).toContain("run: bun run lint");
    expect(checkJob).toContain("run: bun run typecheck");
    expect(checkJob).toContain("run: bun run test");
    expect(checkJob).toContain("run: bun run audit:production");
    expect(checkJob).toContain("run: bun run build");
    expect(checkJob).not.toContain("TEST_DATABASE_URL");
    for (const command of commands) expect(checkJob).not.toContain(command);
  });

  test("each database job gets an isolated Postgres service and fails fast", () => {
    const databaseJob = workflow.slice(workflow.indexOf("  postgres-invariants:"));
    expect(databaseJob).toContain("fail-fast: false");
    expect(databaseJob).toContain("image: postgres:17");
    expect(databaseJob).toContain("DATABASE_URL:");
    expect(databaseJob).not.toContain("continue-on-error");
  });
});
