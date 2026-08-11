import { describe, expect, test } from "bun:test";
import {
  buildClipExportFingerprint,
  clipExportDownloadFileName,
  clipExportVariantStorageKey,
  deriveClipExportAggregate,
  hashClipShareToken,
} from "./clip-export.service";

describe("clip export fingerprint", () => {
  test("is stable across caller ordering and duplicate aspect ratios", () => {
    const first = buildClipExportFingerprint({
      editorRevision: 12,
      aspectRatios: ["16:9", "9:16", "9:16"],
      resolution: "1080p",
      watermark: false,
    });
    const second = buildClipExportFingerprint({
      editorRevision: 12,
      aspectRatios: ["9:16", "16:9"],
      resolution: "1080p",
      watermark: false,
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  test("changes for every output-affecting contract field", () => {
    const base = {
      editorRevision: 4,
      aspectRatios: ["9:16"] as const,
      resolution: "1080p" as const,
      watermark: false,
    };
    const fingerprint = buildClipExportFingerprint({ ...base, aspectRatios: [...base.aspectRatios] });
    expect(buildClipExportFingerprint({ ...base, editorRevision: 5, aspectRatios: [...base.aspectRatios] })).not.toBe(fingerprint);
    expect(buildClipExportFingerprint({ ...base, aspectRatios: ["1:1"] })).not.toBe(fingerprint);
    expect(buildClipExportFingerprint({ ...base, aspectRatios: [...base.aspectRatios], resolution: "720p" })).not.toBe(fingerprint);
    expect(buildClipExportFingerprint({ ...base, aspectRatios: [...base.aspectRatios], watermark: true })).not.toBe(fingerprint);
  });
});

describe("clip export aggregate state", () => {
  test("covers queued, rendering, ready, partial and failed terminal states", () => {
    expect(deriveClipExportAggregate(["pending", "pending"])).toEqual({
      status: "queued",
      progress: 0,
      terminal: false,
    });
    expect(deriveClipExportAggregate(["rendering", "pending"]).status).toBe("rendering");
    expect(deriveClipExportAggregate(["completed", "completed"])).toEqual({
      status: "ready",
      progress: 100,
      terminal: true,
    });
    expect(deriveClipExportAggregate(["completed", "failed"])).toEqual({
      status: "partial_ready",
      progress: 100,
      terminal: true,
    });
    expect(deriveClipExportAggregate(["failed", "failed"])).toEqual({
      status: "failed",
      progress: 100,
      terminal: true,
    });
  });

  test("fails closed for a corrupt empty export", () => {
    expect(deriveClipExportAggregate([])).toEqual({
      status: "failed",
      progress: 100,
      terminal: true,
    });
  });
});

describe("clip export storage and sharing", () => {
  test("builds a safe, descriptive download filename", () => {
    expect(
      clipExportDownloadFileName({
        clipTitle: 'My: “launch” / clip\r\n',
        aspectRatio: "16:9",
        resolution: "1080p",
        editorRevision: 12,
      }),
    ).toBe("My-launch-clip-16x9-1080p-v12.mp4");
  });

  test("uses export and variant identities in immutable storage keys", () => {
    expect(
      clipExportVariantStorageKey({
        projectId: "project-id",
        exportId: "export-id",
        variantId: "variant-id",
        aspectRatio: "9:16",
      }),
    ).toBe("projects/project-id/exports/export-id/variant-id-9x16.mp4");
  });

  test("hashes share tokens deterministically without retaining the token", () => {
    const token = "VwSuLaxd0mI6uP7Xa0xbsK_kulNPQruUB6PR6Oa7y_E";
    const hash = hashClipShareToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashClipShareToken(token)).toBe(hash);
    expect(hashClipShareToken(`${token}x`)).not.toBe(hash);
  });
});
