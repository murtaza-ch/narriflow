import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importSpecifiers, runChecks, scanClientBundle, serverVariableNames } from "./check-web-backend-imports";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "web-split-"));
  roots.push(root);
  const all = { "apps/web/package.json": JSON.stringify({ dependencies: { next: "1" } }), ...files };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const rules = (root: string, options?: { requireBundle?: boolean }) =>
  runChecks(root, options).map((violation) => `${violation.rule}:${violation.file}`);

describe("web/API split guard", () => {
  test("finds static, dynamic, require and mock imports", () => {
    expect(importSpecifiers(`import a from "x"; import type { B } from "y"; const c = await import("z"); require("w"); mock.module("v", () => ({})); export * from "u"; import "t";`))
      .toEqual(["x", "y", "z", "w", "v", "u", "t"]);
  });

  test("a clean web app passes", () => {
    const root = repository({ "apps/web/app/page.tsx": `import { x } from "@narriflow/validators";\nexport default x;` });
    expect(rules(root)).toEqual([]);
  });

  test("bans backend packages, their subpaths and type-only imports", () => {
    const root = repository({
      "apps/web/app/a.ts": `import { s } from "@narriflow/services";`,
      "apps/web/app/b.ts": `import type { P } from "@narriflow/db/client";`,
      "apps/web/lib/c.test.ts": `mock.module("@narriflow/mcp-core", () => ({}));`,
      "apps/web/lib/d.ts": `const m = await import("@narriflow/auth");`,
    });
    expect(rules(root).sort()).toEqual([
      "backend-import:apps/web/app/a.ts",
      "backend-import:apps/web/app/b.ts",
      "backend-import:apps/web/lib/c.test.ts",
      "backend-import:apps/web/lib/d.ts",
    ]);
  });

  test("does not mistake the API client for the API runtime", () => {
    const root = repository({ "apps/web/app/a.ts": `import { q } from "@narriflow/api-client/brand";` });
    expect(rules(root)).toEqual([]);
  });

  test("follows a relative path into backend source", () => {
    const root = repository({
      "apps/web/lib/a.ts": `import { f } from "../../../packages/services/src/plan-features";`,
      "apps/web/lib/b.ts": `import { f } from "../../../packages/validators/src/pricing";`,
    });
    expect(rules(root)).toEqual(["backend-import:apps/web/lib/a.ts"]);
  });

  test("bans Server Actions and backend route handlers but not docs content handlers", () => {
    const root = repository({
      "apps/web/app/actions.ts": `"use server";\nexport async function save() {}`,
      "apps/web/app/api/projects/route.ts": `export const GET = () => new Response();`,
      "apps/web/app/api/docs/search/route.ts": `export const GET = () => new Response();`,
      "apps/web/app/(docs)/docs/llms.txt/route.ts": `export const GET = () => new Response();`,
    });
    expect(rules(root).sort()).toEqual(["route-handler:apps/web/app/api/projects/route.ts", "use-server:apps/web/app/actions.ts"]);
  });

  test("bans backend dependencies in the web manifest", () => {
    const root = repository({
      "apps/web/package.json": JSON.stringify({ dependencies: { "@narriflow/services": "workspace:*", svix: "1" }, devDependencies: { pg: "1" } }),
    });
    expect(rules(root).sort()).toEqual([
      "backend-dependency:apps/web/package.json",
      "backend-dependency:apps/web/package.json",
      "backend-dependency:apps/web/package.json",
    ]);
  });

  test("reads server variable names from the API and worker examples, not values", () => {
    const root = repository({
      "apps/api/.env.example": `PORT=4000\nCLERK_SECRET_KEY=\n# OPENAI_CLIP_MODEL=\nNEXT_PUBLIC_GOOGLE_CLIENT_ID=\nNODE_ENV=development\n`,
      "apps/worker/.env.example": `R2_SECRET_ACCESS_KEY=abc\n`,
    });
    // Clerk's SDK names its own secret setting in browser code, so that name is allowed.
    expect(serverVariableNames(root)).toEqual(["OPENAI_CLIP_MODEL", "R2_SECRET_ACCESS_KEY"]);
  });

  test("the bundle scan flags server module names and secret variable names", () => {
    const root = repository({
      "apps/web/.next/static/chunks/a.js": `console.log("R2_SECRET_ACCESS_KEY"); import("@prisma/client")`,
      "apps/web/.next/static/chunks/b.js": `console.log("fine")`,
    });
    const found = scanClientBundle(join(root, "apps/web/.next/static"), ["R2_SECRET_ACCESS_KEY"]);
    expect(found.map((violation) => violation.detail).sort()).toEqual(["@prisma/client", "R2_SECRET_ACCESS_KEY"]);
    // Substrings of longer names (public variables, redirect URLs) are not mentions.
    const clean = repository({ "apps/web/.next/static/chunks/c.js": `process.env.NEXT_PUBLIC_R2_SECRET_ACCESS_KEY; signInForceRedirectUrl; X_R2_SECRET_ACCESS_KEY_Y` });
    expect(scanClientBundle(join(clean, "apps/web/.next/static"), ["R2_SECRET_ACCESS_KEY"])).toEqual([]);
  });

  test("a required bundle scan fails when no build exists", () => {
    const root = repository({});
    expect(rules(root)).toEqual([]);
    expect(rules(root, { requireBundle: true })).toEqual(["client-bundle:apps/web/.next/static"]);
  });
});
