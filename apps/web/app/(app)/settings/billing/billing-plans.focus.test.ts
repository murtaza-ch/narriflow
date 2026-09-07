import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("BillingPlans preserves keyboard focus through recovery", async () => {
  const child = Bun.spawn(
    [
      "bun",
      "test",
      "./apps/web/app/(app)/settings/billing/billing-plans.focus.fixture.tsx",
    ],
    {
      cwd: resolve(import.meta.dir, "../../../../../.."),
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
});
