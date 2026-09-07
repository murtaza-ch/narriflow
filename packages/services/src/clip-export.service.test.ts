import { describe, expect, test } from "bun:test";
import { editorDocumentSchema } from "@narriflow/validators";
import {
  assertMotionExportEntitlement,
  assertSceneExportReferenceRows,
  buildClipExportFingerprint,
  clipExportDownloadFileName,
  clipExportVariantStorageKey,
  deriveClipExportAggregate,
  hashClipShareToken,
  sceneExportOwnerWhere,
} from "./clip-export.service";

describe("clip export motion entitlement", () => {
  const motionDocument = editorDocumentSchema.parse({
    version: 2,
    clipStartSec: 0,
    clipEndSec: 10,
    captionPreset: {},
    transcriptSlice: [],
    studioEdits: {
      transition: { type: "slide-left", durationSec: 0.35 },
    },
    brollUrl: null,
    deletedRanges: [],
  });

  test("blocks a frozen motion snapshot after a workspace downgrades", () => {
    expect(() => assertMotionExportEntitlement("free", motionDocument)).toThrow(
      expect.objectContaining({ code: "motion_feature_unavailable" }),
    );
  });

  test("allows the same frozen snapshot on an entitled tier", () => {
    expect(() =>
      assertMotionExportEntitlement("creator", motionDocument),
    ).not.toThrow();
  });
});

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
  test("blocks export admission when a frozen Scene file identity is unavailable", () => {
    const visualId = "11111111-1111-4111-8111-111111111111";
    const fontId = "22222222-2222-4222-8222-222222222222";
    const document = editorDocumentSchema.parse({
      version: 2,
      clipStartSec: 0,
      clipEndSec: 10,
      captionPreset: {},
      transcriptSlice: [],
      studioEdits: {},
      brollUrl: null,
      deletedRanges: [],
      sceneBlocks: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          schemaVersion: 1,
          anchorSec: 0,
          durationSec: 2,
          content: { kind: "image", asset: { kind: "visual_asset", id: visualId, fingerprint: "a".repeat(64) }, fit: "cover", backgroundColor: "#000000" },
          motion: { entrance: "none", exit: "none" },
          templateSnapshot: null,
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          schemaVersion: 1,
          anchorSec: 4,
          durationSec: 2,
          content: { kind: "text", text: "Opening", fontFamily: "Acme", fontAsset: { kind: "brand_font", id: fontId, fingerprint: "b".repeat(64) }, color: "#FFFFFF", backgroundColor: "#111827" },
          motion: { entrance: "fade", exit: "fade" },
          templateSnapshot: null,
        },
      ],
    });
    const visuals = [{ id: visualId, kind: "image", fingerprint: "a".repeat(64) }];
    const fonts = [{ id: fontId, family: "Acme", fingerprint: "b".repeat(64) }];
    expect(() => assertSceneExportReferenceRows(document, visuals, fonts)).not.toThrow();
    expect(() => assertSceneExportReferenceRows(document, [], fonts)).toThrow("unavailable Scene asset");
    expect(() => assertSceneExportReferenceRows(document, visuals, [])).toThrow("unavailable Brand font");
  });

  test("uses personal Brand ownership for Creator exports and workspace ownership for Business", () => {
    expect(sceneExportOwnerWhere({
      projectUserId: "project-user",
      workspaceId: "personal-workspace",
      workspace: { personalOwnerUserId: "owner", pricingTier: "creator" },
    })).toEqual({ userId: "owner", workspaceId: null });
    expect(sceneExportOwnerWhere({
      projectUserId: "project-user",
      workspaceId: "shared-workspace",
      workspace: { personalOwnerUserId: null, pricingTier: "business" },
    })).toEqual({ workspaceId: "shared-workspace" });
  });

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
