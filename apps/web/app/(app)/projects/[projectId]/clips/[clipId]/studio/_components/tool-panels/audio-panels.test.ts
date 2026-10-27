import { expect, test } from "bun:test";

// Isolate DOM globals and Studio context mocks from the rest of the web suite.
test("audio panels recover failed lists, accept browser MIME variants, and expose usable controls", async () => {
  const child = Bun.spawn(["bun", "test", "./audio-panels.browser.fixture.tsx"], {
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
}, 30_000);
