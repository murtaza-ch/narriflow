import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("upload progress waits for the complete batch and recovers without stream events", async () => {
  const child = Bun.spawn(["bun", "test", "./apps/web/app/(app)/upload/_components/import-progress.browser.fixture.tsx"], {
    cwd: resolve(import.meta.dir, "../../../../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(code).toBe(0);
}, 15_000);
