import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("continuations skip selected-Workspace admission while app routes keep it", async () => {
  // The fixture installs DOM globals, so it runs in its own process.
  const child = Bun.spawn(["bun", "test", "./apps/web/app/(continuation)/continuation-shell.browser.fixture.tsx"], {
    cwd: resolve(import.meta.dir, "../../../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(code).toBe(0);
}, 60_000);
