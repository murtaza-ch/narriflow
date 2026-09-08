import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("social account presentation and connection interactions", async () => {
  const child = Bun.spawn(["bun", "test", "./apps/web/app/(app)/settings/social-accounts/social-accounts-panel.browser.fixture.tsx"], {
    cwd: resolve(import.meta.dir, "../../../../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(code).toBe(0);
});
