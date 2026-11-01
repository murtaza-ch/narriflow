import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("cached MDX refreshes the API base URL and OpenAPI link when the build origin changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "narriflow-docs-origin-"));
  const compile = (origin: string) => {
    const env = { ...process.env, NODE_ENV: "production", NEXT_PUBLIC_API_URL: origin };
    // Every build process must initialize Fumadocs, even if another test imported next.config.
    delete env._FUMADOCS_MDX;
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "scripts/tests/docs-origin-cache.fixture.ts"), directory], {
      cwd: import.meta.dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  };
  try {
    const first = compile("https://origin-a.example.test");
    expect(first[1]).toEqual({ href: "https://origin-a.example.test/api/v1/openapi.json", hasBaseUrl: true });
    const changed = compile("https://origin-b.example.test");
    expect(changed[1]).toEqual({ href: "https://origin-b.example.test/api/v1/openapi.json", hasBaseUrl: true });
    expect(changed[0].cacheVersion).not.toBe(first[0].cacheVersion);
    expect(changed[0].cacheVersion).toStartWith("next-test-existing-version");
    const warm = compile("https://origin-b.example.test");
    expect(warm[1]).toEqual(changed[1]);
    expect(warm[0].cached).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
