import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");
const entry = resolve(repoRoot, "packages/api-client/src/core/index.ts");

// The core is shared with the future Expo app: no framework, no Clerk, no backend.
const FORBIDDEN_PACKAGES =
  /node_modules\/\.bun\/(next@|react@|react-dom@|server-only@|@clerk\+|hono@|@prisma\+|stripe@|ioredis@)/;
const FORBIDDEN_WORKSPACES =
  /(^|\/)(apps\/api|apps\/web|packages\/(services|db|auth|email|mcp-core|ui))\//;

describe("api-client core stays framework-agnostic", () => {
  test("the full client, including typed domain RPC clients, bundles without backend values", async () => {
    const result = await Bun.build({
      entrypoints: [resolve(repoRoot, "packages/api-client/src/index.ts")],
      target: "browser",
      write: false,
      metafile: true,
    } as Parameters<typeof Bun.build>[0]);
    expect(result.success).toBe(true);
    const graph = Object.keys((result as unknown as { metafile: { inputs: object } }).metafile.inputs);
    expect(graph.filter((path) => FORBIDDEN_WORKSPACES.test(path))).toEqual([]);
    expect(graph.filter((path) => /node_modules\/\.bun\/(next@|server-only@|@clerk\+|@prisma\+|stripe@|ioredis@)/.test(path))).toEqual([]);
  });

  test("browser bundle graph has no Next, React, Clerk, Hono or backend modules", async () => {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      write: false,
      metafile: true,
    } as Parameters<typeof Bun.build>[0]);
    expect(result.success).toBe(true);
    const graph = Object.keys((result as unknown as { metafile: { inputs: object } }).metafile.inputs);
    expect(graph.length).toBeGreaterThan(5);
    expect(graph.filter((path) => FORBIDDEN_PACKAGES.test(path))).toEqual([]);
    expect(graph.filter((path) => FORBIDDEN_WORKSPACES.test(path))).toEqual([]);
  });

  test("core sources import nothing from the framework or backend", async () => {
    const files = [...new Bun.Glob("*.ts").scanSync(import.meta.dir)].filter(
      (file) => !file.endsWith(".test.ts") && file !== "test-helpers.ts",
    );
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = await Bun.file(resolve(import.meta.dir, file)).text();
      const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
      for (const specifier of specifiers) {
        expect(specifier).not.toMatch(
          /^(next|react|react-dom|hono|@clerk\/|@prisma\/|server-only|@narriflow\/(api|services|db|auth|email|mcp-core|ui)(\/|$))/,
        );
      }
    }
  });
});
