import { expect, test } from "bun:test";

// Isolate DOM globals and Studio context mocks from the rest of the web suite.
test("music lane selects, drags, trims and opens its menu", async () => {
  const child = Bun.spawn(["bun", "test", "./music-lane.browser.fixture.tsx"], {
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
