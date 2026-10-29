import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("the app shell renders the page without waiting for billing state", async () => {
  // The fixture installs DOM globals, so it runs in its own process.
  const child = Bun.spawn(["bun", "test", "./apps/web/app/(app)/_components/app-shell.browser.fixture.tsx"], {
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
