import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("custom auth and passkey settings browser contracts", async () => {
  const child = Bun.spawn(["bun", "test", "./apps/web/app/_components/auth/auth-form.browser.fixture.tsx"], { cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(exitCode).toBe(0);
}, 30_000);

test("authentication proxy and server continuation contracts", async () => {
  const child = Bun.spawn(["bun", "test", "./apps/web/lib/auth-server.contract.fixture.ts"], { cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(exitCode).toBe(0);
}, 30_000);
