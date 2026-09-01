import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
  clipAspectRatioOptions,
  clipAspectRatioToDb,
  clipRenderResolutionSchema,
  editorDocumentUsesMotion,
  type ClipAspectRatio,
  type ClipExportSnapshot,
  type ClipExportStatus,
  type ClipRenderResolution,
  type EditorDocument,
  type PricingTier,
  resolvePricingTier,
} from "@narriflow/validators";
import { deriveClipExportAggregate } from "./clip-export-aggregate";
export { deriveClipExportAggregate } from "./clip-export-aggregate";
import { hasFeature } from "./billing.service";
import { accessibleProjectWhere } from "./project-retention.service";
import { headObject, presignDownloadUrl } from "./r2-storage";
import { workspaceService } from "./workspace.service";
import {
  decodeClipEditorDocumentFromStorage,
  encodeClipEditorDocumentForStorage,
} from "./clip-editor-document-persistence";

const EXPORT_DOWNLOAD_TTL_SECONDS = 15 * 60;

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

export class ClipExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClipExportError";
  }
}

export class ClipExportRevisionConflictError extends ClipExportError {
  constructor(readonly currentRevision: number) {
    super("editor_revision_conflict", "The clip changed before export started");
    this.name = "ClipExportRevisionConflictError";
  }
}

export function assertMotionExportEntitlement(
  pricingTier: PricingTier,
  document: EditorDocument,
): void {
  if (
    !hasFeature(pricingTier, "editor.motion") &&
    editorDocumentUsesMotion(document)
  ) {
    throw new ClipExportError(
      "motion_feature_unavailable",
      "Motion export is available on Creator and above",
    );
  }
}

function normalizeAspectRatios(values: ClipAspectRatio[]): ClipAspectRatio[] {
  const requested = new Set(values);
  return clipAspectRatioOptions
    .map((option) => option.value)
    .filter((value) => requested.has(value));
}

export function clipExportDownloadFileName(input: {
  clipTitle: string;
  aspectRatio: ClipAspectRatio;
  resolution: ClipRenderResolution;
  editorRevision: number;
}): string {
  const titleSlug = input.clipTitle
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const aspectSlug =
    clipAspectRatioOptions.find((option) => option.value === input.aspectRatio)
      ?.slug ?? input.aspectRatio.replace(":", "x");
  return `${titleSlug || "narriflow-clip"}-${aspectSlug}-${input.resolution}-v${input.editorRevision}.mp4`;
}

export function buildClipExportFingerprint(input: {
  editorRevision: number;
  aspectRatios: ClipAspectRatio[];
  resolution: ClipRenderResolution;
  watermark: boolean;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contract: "clip-export-v1",
        editorRevision: input.editorRevision,
        aspectRatios: normalizeAspectRatios(input.aspectRatios),
        resolution: input.resolution,
        watermark: input.watermark,
      }),
    )
    .digest("hex");
}

export function hashClipShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function clipExportVariantStorageKey(input: {
  projectId: string;
  exportId: string;
  variantId: string;
  aspectRatio: ClipAspectRatio;
}): string {
  const slug =
    clipAspectRatioOptions.find((option) => option.value === input.aspectRatio)?.slug ??
    "9x16";
  return `projects/${input.projectId}/exports/${input.exportId}/${input.variantId}-${slug}.mp4`;
}

function frozenClipSnapshot(clip: {
  id: string;
  projectId: string;
  index: number;
  startSec: number;
  endSec: number;
  title: string | null;
  hookText: string;
  category: string;
  transcriptSlice: Prisma.JsonValue;
  captionPreset: Prisma.JsonValue | null;
  brollUrl: string | null;
  brollCues: Prisma.JsonValue | null;
  studioEdits: Prisma.JsonValue | null;
  deletedRanges: Prisma.JsonValue | null;
  layoutAnalysis: Prisma.JsonValue | null;
  autoLayoutAnalysis: Prisma.JsonValue | null;
  splitLayoutAnalysis: Prisma.JsonValue | null;
  previewStorageKey: string | null;
  editorRevision: number;
  llmModel: string;
}, sourceDurationSec: number | null): Prisma.InputJsonValue {
  const document = encodeClipEditorDocumentForStorage(
    decodeClipEditorDocumentFromStorage(clip, sourceDurationSec),
    sourceDurationSec,
  );
  return {
    id: clip.id,
    projectId: clip.projectId,
    index: clip.index,
    startSec: document.startSec,
    endSec: document.endSec,
    title: clip.title,
    hookText: clip.hookText,
    category: clip.category,
    transcriptSlice: document.transcriptSlice,
    captionPreset: document.captionPreset,
    brollUrl: document.brollUrl,
    brollCues: clip.brollCues ?? Prisma.JsonNull,
    studioEdits: document.studioEdits,
    deletedRanges: document.deletedRanges,
    editorDocumentVersion: document.editorDocumentVersion,
    sceneBlocks: document.sceneBlocks,
    censorSegments: document.censorSegments,
    mediaMotions: document.mediaMotions,
    layoutAnalysis: clip.layoutAnalysis ?? Prisma.JsonNull,
    autoLayoutAnalysis: clip.autoLayoutAnalysis ?? Prisma.JsonNull,
    splitLayoutAnalysis: clip.splitLayoutAnalysis ?? Prisma.JsonNull,
    previewStorageKey: clip.previewStorageKey,
    editorRevision: clip.editorRevision,
    llmModel: clip.llmModel,
  } as Prisma.InputJsonValue;
}

async function toExportSnapshot(
  row: {
    id: string;
    projectId: string;
    clipId: string;
    editorRevision: number;
    resolution: string;
    watermark: boolean;
    status: string;
    progress: number;
    errorCode: string | null;
    createdAt: Date;
    completedAt: Date | null;
    clip: { title: string | null; hookText: string; editorRevision: number };
    project: { title: string };
    variants: Array<{
      id: string;
      aspectRatio: string;
      resolution: string;
      watermark: boolean;
      status: string;
      storageKey: string | null;
      sizeBytes: bigint | null;
      durationSec: number | null;
      errorCode: string | null;
      completedAt: Date | null;
    }>;
  },
  includeDownloadUrls: boolean,
): Promise<ClipExportSnapshot> {
  const clipTitle = row.clip.title?.trim() || row.clip.hookText;
  const variants = await Promise.all(
    row.variants.map(async (variant) => {
      const aspectRatioDb = clipAspectRatioDbSchema.parse(variant.aspectRatio);
      const aspectRatio = clipAspectRatioFromDb[aspectRatioDb];
      const resolution = clipRenderResolutionSchema.parse(variant.resolution);
      const [previewUrl, downloadUrl] =
        includeDownloadUrls && variant.status === "completed" && variant.storageKey
          ? await Promise.all([
              presignDownloadUrl({
                key: variant.storageKey,
                expiresIn: EXPORT_DOWNLOAD_TTL_SECONDS,
              }).catch(() => null),
              presignDownloadUrl({
                key: variant.storageKey,
                expiresIn: EXPORT_DOWNLOAD_TTL_SECONDS,
                fileName: clipExportDownloadFileName({
                  clipTitle,
                  aspectRatio,
                  resolution,
                  editorRevision: row.editorRevision,
                }),
              }).catch(() => null),
            ])
          : [null, null];
      return {
        id: variant.id,
        aspectRatio,
        resolution,
        watermark: variant.watermark,
        status: variant.status as "pending" | "rendering" | "completed" | "failed",
        sizeBytes: variant.sizeBytes === null ? null : Number(variant.sizeBytes),
        durationSec: variant.durationSec,
        errorCode: variant.errorCode,
        hasAsset: variant.status === "completed" && Boolean(variant.storageKey),
        previewUrl,
        downloadUrl,
        completedAt: variant.completedAt?.toISOString() ?? null,
      };
    }),
  );

  return {
    id: row.id,
    projectId: row.projectId,
    clipId: row.clipId,
    clipTitle,
    projectTitle: row.project.title,
    editorRevision: row.editorRevision,
    currentEditorRevision: row.clip.editorRevision,
    isOlderVersion: row.clip.editorRevision > row.editorRevision,
    resolution: clipRenderResolutionSchema.parse(row.resolution),
    watermark: row.watermark,
    status: row.status as ClipExportStatus,
    progress: row.progress,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    variants,
  };
}

const exportInclude = {
  clip: { select: { title: true, hookText: true, editorRevision: true } },
  project: { select: { title: true } },
  variants: { orderBy: { createdAt: "asc" as const } },
};

type SceneExportOwner =
  | { workspaceId: string }
  | { userId: string; workspaceId: null };

export function sceneExportOwnerWhere(input: {
  projectUserId: string;
  workspaceId: string;
  workspace: { personalOwnerUserId: string | null; pricingTier: string };
}): SceneExportOwner {
  return input.workspace.personalOwnerUserId && input.workspace.pricingTier !== "business"
    ? { userId: input.workspace.personalOwnerUserId, workspaceId: null }
    : { workspaceId: input.workspaceId };
}

async function assertSceneExportAvailability(
  document: EditorDocument,
  owner: SceneExportOwner,
): Promise<void> {
  const visualReferences = [...new Map(document.sceneBlocks.flatMap((scene) =>
    scene.content.kind === "image" || scene.content.kind === "video"
      ? [[scene.content.asset.id, {
          id: scene.content.asset.id,
          fingerprint: scene.content.asset.fingerprint,
          kind: scene.content.kind,
        }] as const]
      : [],
  )).values()];
  const fontReferences = [...new Map(document.sceneBlocks.flatMap((scene) =>
    scene.content.kind === "text" && scene.content.fontAsset
      ? [[scene.content.fontAsset.id, {
          id: scene.content.fontAsset.id,
          fingerprint: scene.content.fontAsset.fingerprint,
          family: scene.content.fontFamily,
        }] as const]
      : [],
  )).values()];
  if (visualReferences.length === 0 && fontReferences.length === 0) return;
  const prisma = requirePrisma();
  const [visuals, fonts] = await Promise.all([
    visualReferences.length > 0
      ? prisma.visualAsset.findMany({
          where: { id: { in: visualReferences.map((reference) => reference.id) }, ...owner },
          select: { id: true, fingerprint: true, kind: true, storageKey: true },
        })
      : [],
    fontReferences.length > 0
      ? prisma.brandFont.findMany({
          where: { id: { in: fontReferences.map((reference) => reference.id) }, ...owner },
          select: { id: true, fingerprint: true, family: true, storageKey: true },
        })
      : [],
  ]);
  assertSceneExportReferenceRows(document, visuals, fonts);
  const objects = await Promise.all(
    [...visuals, ...fonts].map((asset) => headObject(asset.storageKey).catch(() => null)),
  );
  if (objects.some((object) => object === null)) {
    throw new ClipExportError(
      "scene_asset_unavailable",
      "Replace or remove the unavailable Scene asset or Brand font before exporting",
    );
  }
}

export function assertSceneExportReferenceRows(
  document: EditorDocument,
  visuals: readonly { id: string; fingerprint: string; kind: string }[],
  fonts: readonly { id: string; fingerprint: string; family: string }[],
): void {
  const visualById = new Map(visuals.map((asset) => [asset.id, asset]));
  const fontById = new Map(fonts.map((font) => [font.id, font]));
  const invalidVisual = document.sceneBlocks.some((scene) => {
    if (scene.content.kind !== "image" && scene.content.kind !== "video") return false;
    const asset = visualById.get(scene.content.asset.id);
    return !asset || asset.fingerprint !== scene.content.asset.fingerprint || asset.kind !== scene.content.kind;
  });
  if (invalidVisual) {
    throw new ClipExportError(
      "scene_asset_unavailable",
      "Replace or remove the unavailable Scene asset before exporting",
    );
  }
  const invalidFont = document.sceneBlocks.some((scene) => {
    if (scene.content.kind !== "text" || !scene.content.fontAsset) return false;
    const font = fontById.get(scene.content.fontAsset.id);
    return !font || font.fingerprint !== scene.content.fontAsset.fingerprint || font.family !== scene.content.fontFamily;
  });
  if (invalidFont) {
    throw new ClipExportError(
      "scene_font_unavailable",
      "Replace or remove the unavailable Brand font before exporting",
    );
  }
}

export class ClipExportService {
  async create(
    projectId: string,
    clipId: string,
    input: {
      expectedRevision: number;
      aspectRatios: ClipAspectRatio[];
      resolution: ClipRenderResolution;
    },
    _idempotencyKey: string,
    workspaceContext: { workspaceId: string; actorUserId: string },
  ): Promise<{ export: ClipExportSnapshot; reused: boolean }> {
    await workspaceService.requireActor(
      workspaceContext.actorUserId,
      workspaceContext.workspaceId,
      "processing.consume",
    );
    const prisma = requirePrisma();
    const clip = await prisma.clip.findFirst({
      where: {
        id: clipId,
        projectId,
        project: { workspaceId: workspaceContext.workspaceId },
      },
      include: {
        project: {
          select: {
            userId: true,
            workspaceId: true,
            sourceDurationSeconds: true,
            workspace: { select: { personalOwnerUserId: true, pricingTier: true } },
          },
        },
      },
    });
    if (!clip) throw new ClipExportError("clip_not_found", "Clip not found");
    const tier = resolvePricingTier(clip.project.workspace.pricingTier);
    if (clip.editorRevision !== input.expectedRevision) {
      throw new ClipExportRevisionConflictError(clip.editorRevision);
    }
    const document = decodeClipEditorDocumentFromStorage(
      clip,
      clip.project.sourceDurationSeconds,
    );
    await assertSceneExportAvailability(
      document,
      sceneExportOwnerWhere({
        projectUserId: clip.project.userId,
        workspaceId: clip.project.workspaceId,
        workspace: clip.project.workspace,
      }),
    );

    const resolution: ClipRenderResolution =
      input.resolution === "1080p" && !hasFeature(tier, "export.1080p")
        ? "720p"
        : input.resolution;
    const watermark = !hasFeature(tier, "export.noWatermark");
    const aspectRatios = normalizeAspectRatios(input.aspectRatios);
    const fingerprint = buildClipExportFingerprint({
      editorRevision: clip.editorRevision,
      aspectRatios,
      resolution,
      watermark,
    });

    const exportId = randomUUID();
    const snapshot = frozenClipSnapshot(clip, clip.project.sourceDurationSeconds);
    // One atomic upsert is both the idempotency boundary and the durable
    // enqueue. ClipRender rows are the work queue; the render poller attaches
    // a one-live-per-project WorkflowRun, avoiding several high-latency DB and
    // Redis round trips on the user's click path.
    const row = await prisma.clipExport.upsert({
      where: { clipId_fingerprint: { clipId, fingerprint } },
      create: {
        id: exportId,
        workspaceId: workspaceContext.workspaceId,
        createdByUserId: workspaceContext.actorUserId,
        projectId,
        clipId,
        editorRevision: clip.editorRevision,
        fingerprint,
        resolution,
        watermark,
        variants: {
          create: aspectRatios.map((aspectRatio) => ({
            id: randomUUID(),
            aspectRatio: clipAspectRatioToDb[aspectRatio],
            resolution,
            watermark,
            render: {
              create: {
                clipId,
                aspectRatio: clipAspectRatioToDb[aspectRatio],
                resolution,
                editorRevision: clip.editorRevision,
                clipSnapshot: snapshot,
              },
            },
          })),
        },
      },
      update: {},
      include: exportInclude,
    });
    const reused = row.id !== exportId;
    return { export: await toExportSnapshot(row, true), reused };
  }

  async getOwned(
    userId: string,
    projectId: string,
    clipId: string,
    exportId: string,
    workspaceId?: string,
  ): Promise<ClipExportSnapshot | null> {
    const prisma = requirePrisma();
    const row = await prisma.clipExport.findFirst({
      where: {
        id: exportId,
        projectId,
        clipId,
        project: workspaceId ? { workspaceId } : { userId },
      },
      include: exportInclude,
    });
    return row ? toExportSnapshot(row, true) : null;
  }

  async getWorkspaceOwned(
    workspaceId: string,
    exportId: string,
  ): Promise<ClipExportSnapshot | null> {
    const row = await requirePrisma().clipExport.findFirst({
      where: {
        id: exportId,
        workspaceId,
        project: accessibleProjectWhere(),
      },
      include: exportInclude,
    });
    return row ? toExportSnapshot(row, true) : null;
  }

  async retryFailed(
    userId: string,
    projectId: string,
    clipId: string,
    exportId: string,
    workspaceId?: string,
  ) {
    const prisma = requirePrisma();
    const owned = await prisma.clipExport.findFirst({
      where: {
        id: exportId,
        projectId,
        clipId,
        project: workspaceId ? { workspaceId } : { userId },
      },
      include: {
        project: {
          select: {
            userId: true,
            workspaceId: true,
            sourceDurationSeconds: true,
            workspace: { select: { personalOwnerUserId: true, pricingTier: true } },
          },
        },
        variants: { include: { render: true } },
      },
    });
    if (!owned) throw new ClipExportError("export_not_found", "Export not found");
    const failed = owned.variants.filter((variant) => variant.status === "failed");
    if (failed.length === 0) {
      return this.getOwned(userId, projectId, clipId, exportId, workspaceId);
    }
    const frozenSnapshot = failed.find((variant) => variant.render)?.render?.clipSnapshot;
    if (!frozenSnapshot) {
      throw new ClipExportError("export_snapshot_missing", "Export snapshot is missing");
    }
    const frozenDocument = decodeClipEditorDocumentFromStorage(
      frozenSnapshot,
      owned.project.sourceDurationSeconds,
    );
    assertMotionExportEntitlement(
      resolvePricingTier(owned.project.workspace?.pricingTier),
      frozenDocument,
    );
    await assertSceneExportAvailability(
      frozenDocument,
      sceneExportOwnerWhere({
        projectUserId: owned.project.userId,
        workspaceId: owned.project.workspaceId,
        workspace: owned.project.workspace,
      }),
    );

    await prisma.$transaction(async (tx) => {
      for (const variant of failed) {
        await tx.clipExportVariant.update({
          where: { id: variant.id },
          data: { status: "pending", errorCode: null, startedAt: null, completedAt: null },
        });
        if (variant.render) {
          await tx.clipRender.update({
            where: { id: variant.render.id },
            data: {
              status: "pending",
              errorCode: null,
              startedAt: null,
              completedAt: null,
              storageKey: null,
              sizeBytes: null,
              durationSec: null,
            },
          });
        }
      }
      await tx.clipExport.update({
        where: { id: exportId },
        data: { status: "queued", progress: 0, errorCode: null, completedAt: null },
      });
    });

    return this.getOwned(userId, projectId, clipId, exportId, workspaceId);
  }

  async createShareLink(
    userId: string,
    projectId: string,
    clipId: string,
    exportId: string,
    expiresInDays: 1 | 7 | 30 | null,
    workspaceId?: string,
  ): Promise<{ path: string; expiresAt: string | null }> {
    const prisma = requirePrisma();
    const owned = await prisma.clipExport.findFirst({
      where: {
        id: exportId,
        projectId,
        clipId,
        project: {
          ...(workspaceId ? { workspaceId } : { userId }),
          ...accessibleProjectWhere(),
        },
        variants: { some: { status: "completed" } },
      },
      select: { id: true },
    });
    if (!owned) throw new ClipExportError("export_not_ready", "Export is not ready to share");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;
    await prisma.clipShareLink.create({
      data: { exportId, tokenHash: hashClipShareToken(token), expiresAt },
    });
    return { path: `/share/${token}`, expiresAt: expiresAt?.toISOString() ?? null };
  }

  async revokeShareLinks(
    userId: string,
    projectId: string,
    clipId: string,
    exportId: string,
    workspaceId?: string,
  ) {
    const prisma = requirePrisma();
    const owned = await prisma.clipExport.findFirst({
      where: {
        id: exportId,
        projectId,
        clipId,
        project: {
          ...(workspaceId ? { workspaceId } : { userId }),
          ...accessibleProjectWhere(),
        },
      },
      select: { id: true },
    });
    if (!owned) throw new ClipExportError("export_not_found", "Export not found");
    const result = await prisma.clipShareLink.updateMany({
      where: { exportId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count };
  }

  async getShared(token: string): Promise<ClipExportSnapshot | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const prisma = requirePrisma();
    const now = new Date();
    const link = await prisma.clipShareLink.findFirst({
      where: {
        tokenHash: hashClipShareToken(token),
        revokedAt: null,
        export: { project: accessibleProjectWhere(now) },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      include: { export: { include: exportInclude } },
    });
    if (!link) return null;
    await prisma.clipShareLink.update({ where: { id: link.id }, data: { lastUsedAt: now } });
    return toExportSnapshot(link.export, true);
  }

  async syncAggregate(exportId: string) {
    const prisma = requirePrisma();
    const variants = await prisma.clipExportVariant.findMany({
      where: { exportId },
      select: { status: true, errorCode: true },
    });
    const aggregate = deriveClipExportAggregate(variants.map((variant) => variant.status));
    const firstError = variants.find((variant) => variant.errorCode)?.errorCode ?? null;
    await prisma.clipExport.update({
      where: { id: exportId },
      data: {
        status: aggregate.status,
        progress: aggregate.progress,
        errorCode: aggregate.status === "failed" ? firstError : null,
        completedAt: aggregate.terminal ? new Date() : null,
      },
    });
    return aggregate;
  }
}

export const clipExportService = new ClipExportService();
