import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  productionRenderClockAdapter,
  productionRenderWorkspaceAdapter,
} from "./render-runtime-adapters";

test("render workspace adapter retains non-lifetime file operations", async () => {
  const filePath = import.meta.path;
  expect((await productionRenderWorkspaceAdapter.stat(filePath)).size).toBeGreaterThan(0);
  expect(await readFile(filePath, "utf8")).toContain("render workspace adapter");
});

test("render clock adapter reports time and can schedule and cancel deadlines", async () => {
  const startedAtMs = productionRenderClockAdapter.nowMs();
  let cancelledTimerRan = false;
  const cancelledTimer = productionRenderClockAdapter.setTimeout(() => {
    cancelledTimerRan = true;
  }, 5);
  productionRenderClockAdapter.clearTimeout(cancelledTimer);

  await new Promise<void>((resolve) => {
    productionRenderClockAdapter.setTimeout(resolve, 5);
  });

  expect(productionRenderClockAdapter.nowMs()).toBeGreaterThanOrEqual(startedAtMs);
  expect(cancelledTimerRan).toBe(false);
});
