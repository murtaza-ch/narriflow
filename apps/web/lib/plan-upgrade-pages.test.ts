import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("server page upgrade promises match retained styles and the settlement period", async () => {
  const child = Bun.spawn(["bun", "test", "./apps/web/lib/plan-upgrade-pages.contract.fixture.ts"], {
    cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(code).toBe(0);
}, 30_000);
