import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  productionRenderClockAdapter,
  productionRenderWorkspaceAdapter,
} from "./render-runtime-adapters";

test("render workspace adapter creates, writes, stats, and removes an isolated workspace", async () => {
  const directory = await productionRenderWorkspaceAdapter.mkdtemp(
    join(tmpdir(), "narriflow-render-runtime-contract-"),
  );
  const filePath = join(directory, "artifact.txt");

  try {
    await productionRenderWorkspaceAdapter.writeFile(filePath, "render bytes");
    expect(await readFile(filePath, "utf8")).toBe("render bytes");
    expect((await productionRenderWorkspaceAdapter.stat(filePath)).size).toBe(12);
  } finally {
    await productionRenderWorkspaceAdapter.rm(directory, {
      recursive: true,
      force: true,
    });
  }
  await expect(productionRenderWorkspaceAdapter.stat(filePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
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
