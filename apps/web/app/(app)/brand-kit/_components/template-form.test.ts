import { expect, test } from "bun:test";

// Isolate DOM globals and module mocks from the rest of the web suite.
test("the template form's Title section edits, saves and reloads the title settings", async () => {
  const child = Bun.spawn(["bun", "test", "./template-form.browser.fixture.tsx"], {
    cwd: import.meta.dir,
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
}, 120_000);
