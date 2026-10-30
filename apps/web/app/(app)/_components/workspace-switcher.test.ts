import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("the workspace switcher offers quiet pending checkout recovery", async () => {
  // The fixture installs DOM globals, so it runs in its own process.
  const child = Bun.spawn(["bun", "test", "./apps/web/app/(app)/_components/workspace-switcher.browser.fixture.tsx"], {
    cwd: resolve(import.meta.dir, "../../../../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(exitCode).toBe(0);
}, 60_000);
