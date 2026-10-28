import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

// Package directories under node_modules/.bun, e.g. `next@16.3.6+hash`.
const FORBIDDEN = /node_modules\/\.bun\/(next@|react@|react-dom@|server-only@|@clerk\+nextjs@)/;

async function moduleGraph(entry: string): Promise<string[]> {
  const result = await Bun.build({
    entrypoints: [resolve(repoRoot, entry)],
    target: "bun",
    write: false,
    metafile: true,
  } as Parameters<typeof Bun.build>[0]);
  expect(result.success).toBe(true);
  return Object.keys((result as unknown as { metafile: { inputs: object } }).metafile.inputs);
}

describe("backend packages stay framework-free", () => {
  test.each(["packages/auth/src/index.ts", "packages/email/src/index.ts"])(
    "%s bundles without next, @clerk/nextjs, server-only or React",
    async (entry) => {
      const graph = await moduleGraph(entry);
      expect(graph.length).toBeGreaterThan(1);
      expect(graph.filter((path) => FORBIDDEN.test(path))).toEqual([]);
    },
  );

  test.each(["packages/auth/src/index.ts", "packages/email/src/index.ts"])(
    "%s imports under plain Bun",
    async (entry) => {
      const child = Bun.spawn(
        ["bun", "-e", `await import(${JSON.stringify(resolve(repoRoot, entry))})`],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } },
      );
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    },
    20_000,
  );
});
