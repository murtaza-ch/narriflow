import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("personal workspace reads preserve provisioning and fresh admission", async () => {
  // Keep these dependency replacements out of the rest of the web test process.
  const child = Bun.spawn(
    ["bun", "test", "./packages/auth/test-fixtures/personal-workspace-auth.ts"],
    {
      cwd: resolve(import.meta.dir, "../../.."),
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
