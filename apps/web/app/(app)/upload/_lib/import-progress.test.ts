import { describe, expect, test } from "bun:test";
import { deriveImportProgress } from "./import-progress";

type Detail = Parameters<typeof deriveImportProgress>[0];
function detail(statuses: string[], stage = "clip_rendering", status = "running"): Detail {
  return {
    snapshot: { project: { ingestStatus: "ready", ingestErrorCode: null }, activeRun: { stage, status, progress: 50, errorCode: null } },
    transcript: { data: { status: "completed" } },
    clips: statuses.map((status) => ({ renderVariants: [{ status, hasAsset: status === "completed" }] })),
  } as unknown as Detail;
}

describe("initial import completion", () => {
  test("the first playable clip does not open results", () => {
    expect(deriveImportProgress(detail(["completed", "rendering"]))).toMatchObject({ state: "processing", readyCount: 1, totalCount: 2 });
  });
  test("all assets still wait for the render coordinator to settle", () => {
    expect(deriveImportProgress(detail(["completed", "completed"])).state).toBe("processing");
  });
  test("a complete batch opens results only with every requested variant playable", () => {
    expect(deriveImportProgress(detail(["completed", "completed"], "clip_rendering", "completed")).state).toBe("ready");
    const missing = detail(["completed", "completed"], "clip_rendering", "completed");
    missing.clips[1]!.renderVariants[0]!.hasAsset = false;
    expect(deriveImportProgress(missing).state).toBe("processing");
    missing.clips[1]!.renderVariants = [];
    expect(deriveImportProgress(missing).state).toBe("processing");
  });
  test("partial and failed batches show recovery without silently opening a grid", () => {
    for (const status of ["partial", "failed"]) {
      expect(deriveImportProgress(detail(["completed", "failed"], "clip_rendering", status)).state).toBe("failed");
    }
  });
  test("completed transcription is still processing, and an empty detection result has recovery", () => {
    expect(deriveImportProgress(detail([], "stt", "completed")).state).toBe("processing");
    expect(deriveImportProgress(detail([], "moment_detection", "completed")).state).toBe("failed");
  });
});
