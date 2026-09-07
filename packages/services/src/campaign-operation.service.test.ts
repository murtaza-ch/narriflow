import { describe, expect, test } from "bun:test";
import { allocateBundleFileNames, exportBundleRetentionMs } from "./campaign-operation.service";

describe("export bundle naming", () => {
  test("freezes collision-safe deterministic variant names", () => {
    const input = [
      { clipId: crypto.randomUUID(), title: "Launch Day!", variants: [{ id: crypto.randomUUID(), aspectRatio: "9:16" as const }, { id: crypto.randomUUID(), aspectRatio: "1:1" as const }] },
      { clipId: crypto.randomUUID(), title: "Launch day", variants: [{ id: crypto.randomUUID(), aspectRatio: "9:16" as const }] },
      { clipId: crypto.randomUUID(), title: "🔥", variants: [{ id: crypto.randomUUID(), aspectRatio: "16:9" as const }] },
    ];
    const first = allocateBundleFileNames(input);
    expect(first).toEqual(allocateBundleFileNames(input));
    expect(first.flatMap((clip) => clip.files.map((file) => file.name))).toEqual([
			"project/001-launch-day/9x16.mp4",
			"project/001-launch-day/1x1.mp4",
			"project/002-launch-day-2/9x16.mp4",
			"project/003-clip-3/16x9.mp4",
    ]);
  });
});

describe("export bundle retention", () => {
  test("defaults to seven days and accepts a bounded deployment override", () => {
    expect(exportBundleRetentionMs({})).toBe(7 * 24 * 60 * 60_000);
    expect(exportBundleRetentionMs({ EXPORT_BUNDLE_RETENTION_DAYS: "14" })).toBe(14 * 24 * 60 * 60_000);
    expect(() => exportBundleRetentionMs({ EXPORT_BUNDLE_RETENTION_DAYS: "0" })).toThrow();
    expect(() => exportBundleRetentionMs({ EXPORT_BUNDLE_RETENTION_DAYS: "31" })).toThrow();
    expect(() => exportBundleRetentionMs({ EXPORT_BUNDLE_RETENTION_DAYS: "7.5" })).toThrow();
  });
});
