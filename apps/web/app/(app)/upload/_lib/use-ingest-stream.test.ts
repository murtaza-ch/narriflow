import { expect, test } from "bun:test";
import { resolve } from "node:path";

// The hook needs a DOM, so it runs in the repo's happy-dom fixture subprocess, which keeps browser globals out of this process.
test("ingest stream hook: retry reset and snapshot fallback", async () => {
  const child = Bun.spawn(["bun", "test", "./apps/web/app/(app)/upload/_lib/use-ingest-stream.browser.fixture.tsx"], {
    cwd: resolve(import.meta.dir, "../../../../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(code).toBe(0);
});
