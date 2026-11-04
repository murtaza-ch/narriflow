import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");
const entry = resolve(repoRoot, "packages/api-client/src/core/index.ts");

// The core is shared with the future Expo app: no framework, no Clerk, no backend.
const FORBIDDEN_PACKAGES =
  /node_modules\/\.bun\/(next@|react@|react-dom@|server-only@|@clerk\+|hono@|@prisma\+|stripe@)/;
const FORBIDDEN_WORKSPACES =
  /(^|\/)(apps\/api|apps\/web|packages\/(services|db|auth|email|mcp-core|ui))\//;

async function browserGraph(entrypoint: string): Promise<string[]> {
  // Bun 1.3.6's in-process bundler can retain invalid file handles after the
  // transport suite forces GC. A fresh build process keeps this graph check
  // independent of those runtime tests without weakening either boundary.
  const child = Bun.spawn([process.execPath, "--eval", `
    const result = await Bun.build({ entrypoints: [${JSON.stringify(entrypoint)}], target: "browser", write: false, metafile: true });
    if (!result.success) { console.error(result.logs); process.exit(1); }
    console.log(JSON.stringify(Object.keys(result.metafile.inputs)));
  `], { stdout: "pipe", stderr: "pipe" });
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(errors).toBe("");
  expect(exitCode).toBe(0);
  return JSON.parse(output);
}

describe("api-client core stays framework-agnostic", () => {
  test("the full client, including typed domain RPC clients, bundles without backend values", async () => {
    const graph = await browserGraph(resolve(repoRoot, "packages/api-client/src/index.ts"));
    expect(graph.filter((path) => FORBIDDEN_WORKSPACES.test(path))).toEqual([]);
    expect(graph.filter((path) => /node_modules\/\.bun\/(next@|server-only@|@clerk\+|@prisma\+|stripe@|ioredis@)/.test(path))).toEqual([]);
  });

  test("browser bundle graph has no Next, React, Clerk, Hono or backend modules", async () => {
    const graph = await browserGraph(entry);
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
