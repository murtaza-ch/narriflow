import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("ReviewClient preserves its browser and keyboard contract", async () => {
  const child = Bun.spawn(
    ["bun", "test", "./apps/web/app/review/[token]/review-client.browser.fixture.tsx"],
    {
      cwd: resolve(import.meta.dir, "../../../../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(exitCode).toBe(0);
}, 15_000);
