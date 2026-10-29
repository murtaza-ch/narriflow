import { expect, test } from "bun:test";
import { resolve } from "node:path";

// The panel needs a DOM, so they run in the repo's happy-dom fixture subprocess, which keeps browser globals out of this process.
test("one-time signing secret disclosure", async () => {
  const child = Bun.spawn(["bun", "test", "./apps/web/app/(app)/settings/api/one-time-credentials.browser.fixture.tsx"], {
    cwd: resolve(import.meta.dir, "../../../../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(code).toBe(0);
});
