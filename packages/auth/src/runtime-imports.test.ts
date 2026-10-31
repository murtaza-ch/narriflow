import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

// Package directories under node_modules/.bun, e.g. `next@16.3.6+hash`.
const FORBIDDEN = /node_modules\/\.bun\/(next@|react@|react-dom@|server-only@|@clerk\+nextjs@)/;

async function moduleGraph(entry: string): Promise<string[]> {
  // The pinned Bun test resolver differs from the fresh runtime resolver.
  // Check the real dependency graph in its own process, like imports below.
  const code = `const result = await Bun.build({ entrypoints: [${JSON.stringify(resolve(repoRoot, entry))}], target: "bun", write: false, metafile: true });
    if (!result.success) { console.error(result.logs); process.exit(1); }
    console.log(JSON.stringify(Object.keys(result.metafile.inputs)));`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], {
    cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  return JSON.parse(stdout);
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
        [process.execPath, "--no-env-file", "-e", `await import(${JSON.stringify(resolve(repoRoot, entry))})`],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } },
      );
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    },
    20_000,
  );
});
