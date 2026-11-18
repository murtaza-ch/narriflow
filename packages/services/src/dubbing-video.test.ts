import { describe, expect, test } from "bun:test";
import { buildClipExportFingerprint } from "./clip-export.service";
import { dubVideoState, type DubVideoSource } from "./dubbing-policy";

const variant = (overrides: Partial<NonNullable<DubVideoSource["export"]>["variants"][number]> = {}) =>
  ({ status: "completed", storageKey: "projects/p/exports/e/v-9x16.mp4", sizeBytes: 4096n, errorCode: null, ...overrides });
const dub = (overrides: Partial<DubVideoSource> = {}): DubVideoSource => ({ status: "completed", videoErrorCode: null, export: null, ...overrides });
const exported = (status: string, variants: ReturnType<typeof variant>[], errorCode: string | null = null) => ({ status, errorCode, variants });

describe("dub video state", () => {
  test("a dub that has not completed has no video, whatever its export says", () => {
    for (const status of ["queued", "processing", "failed", "unknown"]) {
      expect(dubVideoState(dub({ status, export: exported("ready", [variant()]) })).video).toEqual({ status: "none", errorCode: null });
    }
  });

  test("a completed dub with no export is none, or failed with the admission code that stopped it", () => {
    expect(dubVideoState(dub()).video).toEqual({ status: "none", errorCode: null });
    expect(dubVideoState(dub({ videoErrorCode: "plan_feature_required" })).video).toEqual({ status: "failed", errorCode: "plan_feature_required" });
  });

  test("the export's aggregate status decides once there is an export", () => {
    expect(dubVideoState(dub({ export: exported("queued", [variant({ status: "pending", storageKey: null, sizeBytes: null })]) })).video.status).toBe("rendering");
    expect(dubVideoState(dub({ export: exported("rendering", [variant({ status: "rendering", storageKey: null, sizeBytes: null })]) })).video.status).toBe("rendering");
    const failed = dubVideoState(dub({ videoErrorCode: "stale", export: exported("failed", [variant({ status: "failed", storageKey: null, sizeBytes: null, errorCode: "render_failed" })], "render_failed") }));
    expect(failed.video).toEqual({ status: "failed", errorCode: "render_failed" });
    expect(failed.storageKey).toBeNull();
  });

  test("ready carries the variant's file and size, and only a finished file is ready", () => {
    const ready = dubVideoState(dub({ export: exported("ready", [variant()]) }));
    expect(ready).toEqual({ video: { status: "ready", errorCode: null }, storageKey: "projects/p/exports/e/v-9x16.mp4", sizeBytes: 4096n });
    expect(dubVideoState(dub({ export: exported("ready", [variant({ storageKey: null })]) })).video.status).toBe("rendering");
  });
});

describe("dub export fingerprint", () => {
  const base = { editorRevision: 3, aspectRatios: ["9:16"] as const, resolution: "1080p" as const, watermark: false };
  const input = () => ({ ...base, aspectRatios: [...base.aspectRatios] });

  test("includes the dub id, so a dub's export never matches an ordinary one", () => {
    const ordinary = buildClipExportFingerprint(input());
    const first = buildClipExportFingerprint({ ...input(), dubId: "00000000-0000-4000-8000-0000000000d1" });
    const second = buildClipExportFingerprint({ ...input(), dubId: "00000000-0000-4000-8000-0000000000d2" });
    expect(new Set([ordinary, first, second]).size).toBe(3);
    expect(buildClipExportFingerprint({ ...input(), dubId: "00000000-0000-4000-8000-0000000000d1" })).toBe(first);
  });

  test("leaves an ordinary export's fingerprint as it was", () => {
    expect(buildClipExportFingerprint(input())).toBe(buildClipExportFingerprint({ ...input(), dubId: undefined }));
  });
});
