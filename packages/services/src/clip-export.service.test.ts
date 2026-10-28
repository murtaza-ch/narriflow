import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { autoCensorWordId, editorDocumentSchema } from "@narriflow/validators";
import { brandOwnerForWorkspace } from "./brand-ownership";
import {
  assertClipExportDocumentAllowed,
  assertSceneExportReferenceRows,
  buildClipExportFingerprint,
  clipExportDownloadFileName,
  clipExportVariantStorageKey,
  deriveClipExportAggregate,
  hashClipShareToken,
  clipExportService,
  resolveClipExportOutput,
} from "./clip-export.service";

describe("clip export motion entitlement", () => {
  const motionDocument = editorDocumentSchema.parse({
    version: 1,
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
    expect(() => assertClipExportDocumentAllowed("free", motionDocument)).toThrow(
      expect.objectContaining({
        code: "plan_feature_required",
        kind: "payment_required",
        details: expect.objectContaining({ feature: "editor.motion", requiredTier: "creator" }),
      }),
    );
  });

  test("allows the same frozen snapshot on an entitled tier", () => {
    expect(() =>
      assertClipExportDocumentAllowed("creator", motionDocument),
    ).not.toThrow();
  });

  test("refuses enabled Auto Censor segments that no longer match the transcript", () => {
    const segment = {
      schemaVersion: 1,
      id: "50000000-0000-4000-8000-000000000001",
      sourceWordIds: ["word:gone"],
      sourceStartSec: 1,
      sourceEndSec: 1.4,
      treatment: "beep",
      paddingSec: 0.06,
      beepSettings: { frequencyHz: 1_000, levelDb: -8 },
      captionMaskPolicy: null,
      suggestionFingerprint: "e".repeat(64),
      policyVersion: "auto-censor-v1",
      enabled: true,
    };
    const stale = editorDocumentSchema.parse({ ...motionDocument, studioEdits: {}, censorSegments: [segment] });
    expect(() => assertClipExportDocumentAllowed("pro", stale)).toThrow(
      expect.objectContaining({ code: "censor_segments_stale", details: { staleCount: 1 } }),
    );
    const disabled = editorDocumentSchema.parse({ ...motionDocument, studioEdits: {}, censorSegments: [{ ...segment, enabled: false }] });
    expect(() => assertClipExportDocumentAllowed("free", disabled)).not.toThrow();
  });

  describe("Auto Censor entitlement", () => {
    const words = [{ word: "heck", startSec: 1, endSec: 1.4, confidence: 0.9 }];
    const wordId = autoCensorWordId({ utteranceIndex: 0, wordIndex: 0, word: words[0]! });
    const segment = (enabled: boolean) => ({
      schemaVersion: 1,
      id: "50000000-0000-4000-8000-000000000002",
      sourceWordIds: [wordId],
      sourceStartSec: 1,
      sourceEndSec: 1.4,
      treatment: "beep",
      paddingSec: 0.06,
      beepSettings: { frequencyHz: 1_000, levelDb: -8 },
      captionMaskPolicy: null,
      suggestionFingerprint: "e".repeat(64),
      policyVersion: "auto-censor-v2",
      enabled,
    });
    const current = (enabled: boolean) => editorDocumentSchema.parse({
      version: 1, clipStartSec: 0, clipEndSec: 10, captionPreset: {},
      transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9, startSec: 1, endSec: 1.4, text: "heck", words }],
      studioEdits: {}, brollUrl: null, deletedRanges: [], censorSegments: [segment(enabled)],
    });

    test("refuses current, enabled censor segments on Free (a downgraded workspace)", () => {
      expect(() => assertClipExportDocumentAllowed("free", current(true))).toThrow(
        expect.objectContaining({
          code: "plan_feature_required",
          kind: "payment_required",
          details: expect.objectContaining({ feature: "editor.censoring", requiredTier: "creator" }),
        }),
      );
    });

    test("allows only disabled censor segments on Free, and enabled ones on a paid plan", () => {
      expect(() => assertClipExportDocumentAllowed("free", current(false))).not.toThrow();
      for (const tier of ["creator", "pro", "business"] as const) {
        expect(() => assertClipExportDocumentAllowed(tier, current(true))).not.toThrow();
      }
    });
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
      version: 1,
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

  test("resolves Scene asset ownership from the Workspace kind, never its plan", () => {
    expect(brandOwnerForWorkspace({ id: "personal-workspace", personalOwnerUserId: "owner" }))
      .toEqual({ userId: "owner", workspaceId: null });
    expect(brandOwnerForWorkspace({ id: "shared-workspace", personalOwnerUserId: null }))
      .toEqual({ userId: null, workspaceId: "shared-workspace" });
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

describe("explicit export output", () => {
  test("reports the requested resolution, the granted output, and the plan-limit reason", () => {
    expect(resolveClipExportOutput("free", "1080p")).toEqual({ requested: { resolution: "1080p" }, granted: { resolution: "720p", watermark: true }, reason: "plan_limit" });
    expect(resolveClipExportOutput("free", "720p")).toEqual({ requested: { resolution: "720p" }, granted: { resolution: "720p", watermark: true }, reason: "plan_limit" });
    expect(resolveClipExportOutput("business", "1080p")).toEqual({ requested: { resolution: "1080p" }, granted: { resolution: "1080p", watermark: false }, reason: null });
  });
});

describe("Workspace export delivery", () => {
  const scope = { actorUserId: "actor", workspaceId: "workspace" };
  const R2_ENV = {
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "bucket",
  };
  const previous = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, R2_ENV);
  });
  afterEach(() => {
    for (const key of Object.keys(R2_ENV)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  const item = (variants: Array<{ id: string; status: "pending" | "rendering" | "completed" | "failed"; storageKey: string | null }>) => ({
    id: "export-1",
    projectId: "project-1",
    clipId: "clip-1",
    status: "ready" as const,
    progress: 100,
    resolution: "1080p",
    watermark: false,
    createdAt: "2026-10-29T00:00:00.000Z",
    completedAt: null,
    errorCode: null,
    project: { title: "Launch" },
    clip: { title: null, hookText: "Hook" },
    variants: variants.map((variant) => ({ ...variant, aspectRatio: "ratio_9_16" as const, sizeBytes: 10 })),
  });

  test("a page never exposes storage keys and previews only finished files", async () => {
    const page = await clipExportService.presentWorkspaceExports({
      items: [
        item([
          { id: "done", status: "completed", storageKey: "projects/p/exports/e/done.mp4" },
          { id: "failed", status: "failed", storageKey: null },
          { id: "lost", status: "completed", storageKey: null },
        ]),
      ],
      nextCursor: "next",
    });
    expect(page.nextCursor).toBe("next");
    const [done, failed, lost] = page.items[0]!.variants;
    expect(done).toMatchObject({ id: "done", hasAsset: true });
    expect(new URL(done!.previewUrl!).searchParams.get("X-Amz-Expires")).toBe("900");
    expect(failed).toMatchObject({ hasAsset: false, previewUrl: null });
    expect(lost).toMatchObject({ hasAsset: false, previewUrl: null });
    expect(JSON.stringify(page)).not.toContain("storageKey");
  });

  test("a grant is the first finished variant's file, name and expiry, without the subtitles", async () => {
    const grants = spyOn(clipExportService, "issueDownloadGrants").mockResolvedValue({
      exportId: "export-1",
      projectId: "project-1",
      clipId: "clip-1",
      editorRevision: 3,
      variants: [
        { variantId: "v1", aspectRatio: "9:16", resolution: "720p", watermark: false, fileName: "a.mp4", sizeBytes: 5, downloadUrl: "https://files.example/a", expiresAt: "2026-10-29T00:15:00.000Z" },
        { variantId: "v2", aspectRatio: "1:1", resolution: "720p", watermark: false, fileName: "b.mp4", sizeBytes: 6, downloadUrl: "https://files.example/b", expiresAt: "2026-10-29T00:15:00.000Z" },
      ],
      subtitles: [],
    } as never);
    try {
      const grant = await clipExportService.issueWorkspaceDownloadGrant(scope, "export-1", "v1");
      expect(grants).toHaveBeenCalledWith(scope, "export-1", { variantId: "v1", credentialKind: "session" });
      expect(grant).toEqual({
        exportId: "export-1",
        variantId: "v1",
        fileName: "a.mp4",
        sizeBytes: 5,
        downloadUrl: "https://files.example/a",
        expiresAt: "2026-10-29T00:15:00.000Z",
      });
      await clipExportService.issueWorkspaceDownloadGrant(scope, "export-1");
      expect(grants).toHaveBeenLastCalledWith(scope, "export-1", { credentialKind: "session" });
    } finally {
      grants.mockRestore();
    }
  });

  test("a Workspace retry resolves the export's project and clip, and a foreign export is not found", async () => {
    const owned = spyOn(clipExportService, "getWorkspaceOwned");
    const retry = spyOn(clipExportService, "retryFailed").mockResolvedValue({ id: "export-1" } as never);
    try {
      owned.mockResolvedValueOnce({ id: "export-1", projectId: "project-1", clipId: "clip-1" } as never);
      await clipExportService.retryWorkspaceExport(scope, "export-1");
      expect(retry).toHaveBeenCalledWith(scope, "project-1", "clip-1", "export-1");

      owned.mockResolvedValueOnce(null);
      await expect(clipExportService.retryWorkspaceExport(scope, "other")).rejects.toMatchObject({
        code: "export_not_found",
        kind: "missing",
      });
      expect(retry).toHaveBeenCalledTimes(1);
    } finally {
      owned.mockRestore();
      retry.mockRestore();
    }
  });
});
