import type { ActorScope } from "./actor-scope";
import { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import { receiptCallback } from "./completion-callback";
import type { IntegrationMutation } from "./operation-receipt";
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
  clipSourceEdgeSec,
  isCensorSegmentStale,
  resolvePricingTier,
} from "@narriflow/validators";
import type {
  ExportDownloadGrant,
  WorkspaceExportItem,
  WorkspaceExportPage,
  WorkspaceExportVariant,
} from "@narriflow/validators/api/exports";
import { syncClipExportAggregate } from "./clip-export-aggregates";
import { flushWorkspaceEvents } from "./workspace-event";
export { deriveClipExportAggregate } from "./clip-export-aggregate";
import { hasFeature, requirePlanFeature } from "./plan-features";
import { brandOwnerForWorkspace, brandOwnerWhereFor } from "./brand-ownership";
import { analyticsService } from "./analytics.service";
import { accessibleProjectWhere } from "./project-access";
import { headObject, presignDownloadUrl } from "./r2-storage";
import { clipExportSubtitleFiles, effectiveCaptionLanguage } from "./clip-export-subtitles";
import { workspaceService } from "./workspace.service";
import { WorkflowRunLifecycle, type WorkflowAttemptRef } from "./workflow-run-lifecycle";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
  type ExpectedDomainFailureDetails,
} from "./expected-domain-failure";
import {
  decodeClipEditorDocumentFromStorage,
  decodeFrozenClipEditorDocument,
  encodeClipEditorDocumentForStorage,
} from "./clip-editor-document-persistence";

const EXPORT_DOWNLOAD_TTL_SECONDS = 15 * 60;

/** What `workspaceLibraryService.listExports` returns; the service strips `storageKey` for the browser. */
export interface WorkspaceExportPageSource {
  items: Array<
    Omit<WorkspaceExportItem, "variants"> & {
      variants: Array<Omit<WorkspaceExportVariant, "hasAsset" | "previewUrl"> & { storageKey: string | null }>;
    }
  >;
  nextCursor: string | null;
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

const clipExportFailureCatalog = {
  clip_not_found: "missing",
  censor_segments_stale: "unprocessable",
  editor_revision_conflict: "conflict",
  export_not_found: "missing",
  export_not_ready: "conflict",
  export_snapshot_missing: "unprocessable",
  scene_asset_unavailable: "unprocessable",
  scene_font_unavailable: "unprocessable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

type ClipExportFailureCode = keyof typeof clipExportFailureCatalog;

export class ClipExportError extends ExpectedDomainFailureError<ClipExportFailureCode> {
  constructor(
    code: ClipExportFailureCode,
    message: string,
    details?: ExpectedDomainFailureDetails,
  ) {
    super({ code, kind: clipExportFailureCatalog[code], message, details });
    this.name = "ClipExportError";
  }
}

export class ClipExportRevisionConflictError extends ClipExportError {
  constructor(currentRevision: number) {
    super("editor_revision_conflict", "The clip changed before export started", {
      currentRevision,
    });
    this.name = "ClipExportRevisionConflictError";
  }
}

export function staleCensorSegmentCount(document: EditorDocument): number {
  return document.censorSegments.filter(
    (segment) => segment.enabled && isCensorSegmentStale(segment, document.transcriptSlice),
  ).length;
}

/**
 * What a document must satisfy before a new export or an export retry is
 * accepted, on every surface (new export, retry, bulk render): motion needs a
 * plan with motion, enabled Auto Censor segments need a plan with Auto Censor,
 * and they must still match the transcript.
 */
export function assertClipExportDocumentAllowed(
  pricingTier: PricingTier,
  document: EditorDocument,
): void {
  if (editorDocumentUsesMotion(document)) requirePlanFeature(pricingTier, "editor.motion");
  // A frozen snapshot can outlive the plan that saved it: enabled censor edits
  // render only where the plan has Auto Censor. Disabled ones render nothing.
  if (document.censorSegments.some((segment) => segment.enabled)) {
    requirePlanFeature(pricingTier, "editor.censoring");
  }
  const staleCount = staleCensorSegmentCount(document);
  if (staleCount > 0) {
    throw new ClipExportError(
      "censor_segments_stale",
      "Review stale Auto Censor segments before exporting",
      { staleCount },
    );
  }
}

function normalizeAspectRatios(values: ClipAspectRatio[]): ClipAspectRatio[] {
  const requested = new Set(values);
  return clipAspectRatioOptions
    .map((option) => option.value)
    .filter((value) => requested.has(value));
}

export function clipTitleSlug(clipTitle: string) {
  return clipTitle
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "narriflow-clip";
}

/** Subtitles describe the revision, not a format, so one file serves every variant. */
export function clipExportSubtitleBaseName(clipTitle: string, editorRevision: number) {
  return `${clipTitleSlug(clipTitle)}-v${editorRevision}`;
}

export function clipExportDownloadFileName(input: {
  clipTitle: string;
  aspectRatio: ClipAspectRatio;
  resolution: ClipRenderResolution;
  editorRevision: number;
}): string {
  const titleSlug = clipTitleSlug(input.clipTitle);
  const aspectSlug =
    clipAspectRatioOptions.find((option) => option.value === input.aspectRatio)
      ?.slug ?? input.aspectRatio.replace(":", "x");
  return `${titleSlug}-${aspectSlug}-${input.resolution}-v${input.editorRevision}.mp4`;
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

export interface ClipExportOutput {
  requested: { resolution: ClipRenderResolution };
  granted: { resolution: ClipRenderResolution; watermark: boolean };
  /** Set when the plan changed the requested output. */
  reason: "plan_limit" | null;
}

/** Exports never change silently: callers see what they asked for, what the
 * plan grants, and why the two differ. */
export function resolveClipExportOutput(tier: PricingTier, requested: ClipRenderResolution): ClipExportOutput {
  const resolution = requested === "1080p" && !hasFeature(tier, "export.1080p") ? "720p" : requested;
  const watermark = !hasFeature(tier, "export.noWatermark");
  return {
    requested: { resolution: requested },
    granted: { resolution, watermark },
    reason: resolution !== requested || watermark ? "plan_limit" : null,
  };
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
  wholeSource: boolean;
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
    decodeClipEditorDocumentFromStorage(clip, { durationSec: sourceDurationSec, wholeSource: clip.wholeSource }),
    { durationSec: sourceDurationSec, wholeSource: clip.wholeSource },
  );
  return {
    id: clip.id,
    projectId: clip.projectId,
    index: clip.index,
    startSec: document.startSec,
    endSec: document.endSec,
    wholeSource: document.wholeSource,
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

/** Inserts the Clip Export for one exact revision and output configuration,
 * or finds the identical one: the output fingerprint also reuses matching
 * exports requested under distinct keys. ClipRender rows are the durable work queue; the
 * poller attaches a one-live-per-project WorkflowRun, avoiding several
 * high-latency DB and Redis round trips on the caller's path. */
async function upsertClipExport(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    createdByUserId: string | null;
    projectId: string;
    clipId: string;
    clip: Parameters<typeof frozenClipSnapshot>[0];
    sourceDurationSec: number | null;
    fingerprint: string;
    resolution: ClipRenderResolution;
    watermark: boolean;
    aspectRatios: ClipAspectRatio[];
  },
) {
  const { clip, clipId, resolution, watermark } = input;
  const exportId = randomUUID();
  const snapshot = frozenClipSnapshot(clip, input.sourceDurationSec);
  const row = await tx.clipExport.upsert({
    where: { clipId_fingerprint: { clipId, fingerprint: input.fingerprint } },
    create: {
      id: exportId,
      workspaceId: input.workspaceId,
      createdByUserId: input.createdByUserId,
      projectId: input.projectId,
      clipId,
      editorRevision: clip.editorRevision,
      fingerprint: input.fingerprint,
      resolution,
      watermark,
      variants: {
        create: input.aspectRatios.map((aspectRatio) => ({
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
  if (row.id === exportId) await syncClipExportAggregate(tx, row.id);
  return { row, reused: row.id !== exportId };
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

async function assertSceneExportAvailability(
  document: EditorDocument,
  owner: { workspaceId: string } | { userId: string },
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

async function loadDeliverableExport(scope: ActorScope, where: { id: string; projectId?: string; clipId?: string }) {
  await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.download");
  const row = await requirePrisma().clipExport.findFirst({
    where: { ...where, workspaceId: scope.workspaceId, project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() } },
    include: {
      clip: { select: { title: true, hookText: true } },
      project: { select: { sourceDurationSeconds: true, sourceProbe: true, languageCode: true, transcript: { select: { languageCode: true } } } },
      variants: { orderBy: { createdAt: "asc" }, include: { render: { select: { clipSnapshot: true } } } },
    },
  });
  if (!row) throw new ClipExportError("export_not_found", "Export not found");
  return row;
}

/** Every variant of an export freezes the same revision, so any render's
 * snapshot is the export's snapshot. Never falls back to the live clip. */
function exportSubtitles(row: Awaited<ReturnType<typeof loadDeliverableExport>>) {
  const snapshot = row.variants.find((variant) => variant.render?.clipSnapshot)?.render?.clipSnapshot;
  if (!snapshot) throw new ClipExportError("export_snapshot_missing", "Export snapshot is missing");
  return clipExportSubtitleFiles(snapshot, clipSourceEdgeSec(row.project),
    clipExportSubtitleBaseName(row.clip.title?.trim() || row.clip.hookText, row.editorRevision),
    effectiveCaptionLanguage(row.project));
}

export class ClipExportService {
  async create(
    scope: ActorScope,
    projectId: string,
    clipId: string,
    input: {
      expectedRevision: number;
      aspectRatios: ClipAspectRatio[];
      resolution: ClipRenderResolution;
    },
    idempotencyKey: string,
    mutation?: IntegrationMutation,
  ): Promise<{ export: ClipExportSnapshot; reused: boolean; output: ClipExportOutput; replayed: boolean; receiptId: string }> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "processing.consume");
    const prisma = requirePrisma();
    let clip: NonNullable<Awaited<ReturnType<typeof loadClip>>>;
    let resolution: ClipRenderResolution;
    let watermark: boolean;
    let aspectRatios: ClipAspectRatio[];
    let fingerprint: string;
    let output: ClipExportOutput;
    const loadClip = () =>
      prisma.clip.findFirst({
        where: {
          id: clipId,
          projectId,
          project: {
            workspaceId: scope.workspaceId,
            ...accessibleProjectWhere(),
          },
        },
        include: {
          project: {
            select: {
              workspaceId: true,
              sourceDurationSeconds: true,
              sourceProbe: true,
              workspace: {
                select: { personalOwnerUserId: true, pricingTier: true },
              },
            },
          },
        },
      });
    const prepare = async () => {
      const loaded = await loadClip();
      if (!loaded) throw new ClipExportError("clip_not_found", "Clip not found");
      clip = loaded;
      const tier = resolvePricingTier(clip.project.workspace.pricingTier);
      if (clip.editorRevision !== input.expectedRevision) {
        throw new ClipExportRevisionConflictError(clip.editorRevision);
      }
      const document = decodeClipEditorDocumentFromStorage(clip, {
        durationSec: clipSourceEdgeSec(clip.project),
        wholeSource: clip.wholeSource,
      });
      // `mutate` fences this revision under the Clip lock before accepting.
      try {
        assertClipExportDocumentAllowed(tier, document);
      } catch (error) {
        if (error instanceof ClipExportError && error.code === "censor_segments_stale") {
          await analyticsService
            .recordProjectEvent({
              projectId,
              clipId,
              type: "auto_censor_export_notice",
              metadata: { staleCount: staleCensorSegmentCount(document) },
            })
            .catch(() => undefined);
        }
        throw error;
      }
      await assertSceneExportAvailability(
        document,
        brandOwnerWhereFor(brandOwnerForWorkspace({
          id: clip.project.workspaceId,
          personalOwnerUserId: clip.project.workspace.personalOwnerUserId,
        })),
      );

      output = resolveClipExportOutput(tier, input.resolution);
      ({ resolution, watermark } = output.granted);
      aspectRatios = normalizeAspectRatios(input.aspectRatios);
      fingerprint = buildClipExportFingerprint({
        editorRevision: clip.editorRevision,
        aspectRatios,
        resolution,
        watermark,
      });
    };
    const accepted = await getOperationReceiptExecutor().execute({
      identity: {
        workspaceId: scope.workspaceId,
        actorUserId: scope.actorUserId,
        command: "create_clip_export",
        clientIdempotencyKey: mutation?.clientIdempotencyKey ?? idempotencyKey,
      },
      input: {
        projectId,
        clipId,
        expectedRevision: input.expectedRevision,
        aspectRatios: normalizeAspectRatios(input.aspectRatios),
        resolution: input.resolution,
      },
      callback: receiptCallback(scope.workspaceId, mutation, (value: { export: { id: string } }) => ({ kind: "export", id: value.export.id })),
      authorize: async () => {
        await workspaceService.requireActor(
          scope.actorUserId,
          scope.workspaceId,
          "processing.consume",
        );
      },
      beforeAccept: mutation?.beforeAccept,
      prepare,
      mutate: async (tx) => {
        // Fence the prepared document against an edit that races admission.
        await tx.$queryRaw`SELECT "id" FROM "Clip" WHERE "id" = ${clipId}::uuid FOR UPDATE`;
        const current = await tx.clip.findFirst({
          where: {
            id: clipId,
            projectId,
            project: {
              workspaceId: scope.workspaceId,
              ...accessibleProjectWhere(),
            },
          },
          select: { editorRevision: true },
        });
        if (!current) throw new ClipExportError("clip_not_found", "Clip not found");
        if (current.editorRevision !== input.expectedRevision)
          throw new ClipExportRevisionConflictError(current.editorRevision);
        const { row, reused } = await upsertClipExport(tx, {
          workspaceId: scope.workspaceId,
          createdByUserId: scope.actorUserId,
          projectId,
          clipId,
          clip,
          sourceDurationSec: clipSourceEdgeSec(clip.project),
          fingerprint,
          resolution,
          watermark,
          aspectRatios,
        });
        return {
          resourceType: "clip_export",
          resourceId: row.id,
          // The receipt records the granted output; the idempotency fingerprint
          // above covers the requested input.
          value: { export: await toExportSnapshot(row, false), reused, output },
        };
      },
    });
    return { ...accepted.value, replayed: accepted.replayed, receiptId: accepted.receiptId };
  }

  /**
   * The write that admits a captioned video's export, for the transaction that
   * completes its moment detection (`completeMomentDetection`'s `admit`): the
   * whole-source clip at the formats frozen when the video was accepted. The
   * acceptance already authorized the work for an actor, so no actor is checked
   * here (the poller renders it like any export). The detection attempt that
   * owns the clip is the only one whose completion commits, and the export
   * exists only with that completion.
   */
  captionedExportWrite(
    attempt: WorkflowAttemptRef,
    settings: { aspectRatios: ClipAspectRatio[]; resolution: ClipRenderResolution },
  ): (tx: Prisma.TransactionClient) => Promise<{ exportId: string; clipId: string }> {
    return async (tx) => {
      const clip = await tx.clip.findFirst({
        where: { projectId: attempt.projectId, workflowRunId: attempt.workflowRunId },
        include: {
          project: {
            select: {
              workspaceId: true,
              createdByUserId: true,
              sourceDurationSeconds: true,
              sourceProbe: true,
              workspace: { select: { pricingTier: true } },
            },
          },
        },
      });
      if (!clip) throw new ClipExportError("clip_not_found", "Clip not found");
      const { granted } = resolveClipExportOutput(resolvePricingTier(clip.project.workspace.pricingTier), settings.resolution);
      const aspectRatios = normalizeAspectRatios(settings.aspectRatios);
      const { row } = await upsertClipExport(tx, {
        workspaceId: clip.project.workspaceId,
        createdByUserId: clip.project.createdByUserId,
        projectId: attempt.projectId,
        clipId: clip.id,
        clip,
        sourceDurationSec: clipSourceEdgeSec(clip.project),
        fingerprint: buildClipExportFingerprint({ editorRevision: clip.editorRevision, aspectRatios, ...granted }),
        resolution: granted.resolution,
        watermark: granted.watermark,
        aspectRatios,
      });
      return { exportId: row.id, clipId: clip.id };
    };
  }

  async getOwned(
    scope: ActorScope,
    projectId: string,
    clipId: string,
    exportId: string,
  ): Promise<ClipExportSnapshot | null> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.download");
    const prisma = requirePrisma();
    const row = await prisma.clipExport.findFirst({
      where: {
        id: exportId,
        projectId,
        clipId,
        project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
      },
      include: exportInclude,
    });
    return row ? toExportSnapshot(row, true) : null;
  }

  /** Download Grants: fresh short-lived private URLs for one completed
   * export's files, issued only on explicit request, plus subtitles derived
   * from the export's frozen snapshot. The audit log never records a URL. */
  async issueDownloadGrants(
    scope: ActorScope,
    exportId: string,
    options: { variantId?: string; credentialKind: string },
  ) {
    const row = await loadDeliverableExport(scope, { id: exportId });
    if (options.variantId && !row.variants.some((variant) => variant.id === options.variantId)) {
      throw new ClipExportError("export_not_found", "Export variant not found");
    }
    const ready = row.variants.filter((variant) =>
      variant.status === "completed" && variant.storageKey && (!options.variantId || variant.id === options.variantId));
    if (ready.length === 0) throw new ClipExportError("export_not_ready", "No finished file is available for this export yet");
    const clipTitle = row.clip.title?.trim() || row.clip.hookText;
    const expiresAt = new Date(Date.now() + EXPORT_DOWNLOAD_TTL_SECONDS * 1000).toISOString();
    const variants = await Promise.all(ready.map(async (variant) => {
      const aspectRatio = clipAspectRatioFromDb[clipAspectRatioDbSchema.parse(variant.aspectRatio)];
      const resolution = clipRenderResolutionSchema.parse(variant.resolution);
      const fileName = clipExportDownloadFileName({ clipTitle, aspectRatio, resolution, editorRevision: row.editorRevision });
      return {
        variantId: variant.id, aspectRatio, resolution, watermark: variant.watermark, fileName,
        sizeBytes: variant.sizeBytes === null ? null : Number(variant.sizeBytes),
        downloadUrl: await presignDownloadUrl({ key: variant.storageKey!, expiresIn: EXPORT_DOWNLOAD_TTL_SECONDS, fileName }),
        expiresAt,
      };
    }));
    const subtitles = exportSubtitles(row);
    console.warn(JSON.stringify({ level: "info", message: "export_download_granted", exportId: row.id, projectId: row.projectId,
      variantIds: variants.map((variant) => variant.variantId), actorUserId: scope.actorUserId, workspaceId: scope.workspaceId,
      credentialKind: options.credentialKind, expiresAt }));
    return { exportId: row.id, projectId: row.projectId, clipId: row.clipId, editorRevision: row.editorRevision, variants, subtitles };
  }

  /** Subtitle files for the web export page; same derivation as Download Grants. */
  async getSubtitles(scope: ActorScope, projectId: string, clipId: string, exportId: string) {
    return exportSubtitles(await loadDeliverableExport(scope, { id: exportId, projectId, clipId }));
  }

  async getWorkspaceOwned(
    scope: ActorScope,
    exportId: string,
  ): Promise<ClipExportSnapshot | null> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.download");
    const row = await requirePrisma().clipExport.findFirst({
      where: {
        id: exportId,
        workspaceId: scope.workspaceId,
        project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
      },
      include: exportInclude,
    });
    return row ? toExportSnapshot(row, true) : null;
  }

  /**
   * One Download Grant for a Workspace export file: the requested finished
   * variant, or the first finished one. Short-lived; the audit log never
   * records the URL.
   */
  async issueWorkspaceDownloadGrant(
    scope: ActorScope,
    exportId: string,
    variantId?: string,
  ): Promise<ExportDownloadGrant> {
    const grants = await this.issueDownloadGrants(scope, exportId, {
      ...(variantId ? { variantId } : {}),
      credentialKind: "session",
    });
    const [grant] = grants.variants;
    if (!grant) throw new ClipExportError("export_not_ready", "No finished file is available for this export yet");
    return {
      exportId: grants.exportId,
      variantId: grant.variantId,
      fileName: grant.fileName,
      sizeBytes: grant.sizeBytes,
      downloadUrl: grant.downloadUrl,
      expiresAt: grant.expiresAt,
    };
  }

  /** Retry a failed Workspace export from the Exports list, which knows only the export id. */
  async retryWorkspaceExport(scope: ActorScope, exportId: string) {
    const exported = await this.getWorkspaceOwned(scope, exportId);
    if (!exported) throw new ClipExportError("export_not_found", "Export not found");
    return this.retryFailed(scope, exported.projectId, exported.clipId, exported.id);
  }

  /**
   * Shapes a Workspace export page for the browser: storage keys never leave
   * the service, and each finished file gets a short-lived playback URL for
   * its card thumbnail.
   */
  async presentWorkspaceExports(page: WorkspaceExportPageSource): Promise<WorkspaceExportPage> {
    const items = await Promise.all(
      page.items.map(async (item) => ({
        ...item,
        variants: await Promise.all(
          item.variants.map(async ({ storageKey, ...variant }) => {
            const hasAsset = variant.status === "completed" && Boolean(storageKey);
            const previewUrl =
              hasAsset && storageKey
                ? await presignDownloadUrl({ key: storageKey, expiresIn: EXPORT_DOWNLOAD_TTL_SECONDS }).catch(() => null)
                : null;
            return { ...variant, hasAsset, previewUrl };
          }),
        ),
      })),
    );
    return { items, nextCursor: page.nextCursor };
  }

  async listCurrentProjectExports(
    scope: ActorScope,
    projectId: string,
  ): Promise<ClipExportSnapshot[]> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    const rows = await requirePrisma().clipExport.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId,
        project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
        status: { in: ["partial_ready", "ready"] },
      },
      orderBy: { createdAt: "desc" },
      include: exportInclude,
    });
    const current: ClipExportSnapshot[] = [];
    for (const row of rows) {
      if (row.editorRevision !== row.clip.editorRevision) continue;
      const snapshot = await toExportSnapshot(row, true);
      if (snapshot.variants.some((variant) => variant.hasAsset)) {
        current.push(snapshot);
      }
    }
    return current;
  }

  async retryFailed(
    scope: ActorScope,
    projectId: string,
    clipId: string,
    exportId: string,
  ) {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "processing.consume");
    const prisma = requirePrisma();
    const owned = await prisma.clipExport.findFirst({
      where: {
        id: exportId,
        projectId,
        clipId,
        project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
      },
      include: {
        project: {
          select: {
            workspaceId: true,
            sourceDurationSeconds: true,
            sourceProbe: true,
            workspace: { select: { personalOwnerUserId: true, pricingTier: true } },
          },
        },
        variants: { include: { render: true } },
      },
    });
    if (!owned) throw new ClipExportError("export_not_found", "Export not found");
    const failed = owned.variants.filter((variant) => variant.status === "failed");
    if (failed.length === 0) {
      return this.getOwned(scope, projectId, clipId, exportId);
    }
    const frozenSnapshot = failed.find((variant) => variant.render)?.render?.clipSnapshot;
    if (!frozenSnapshot || failed.some((variant) => !variant.render?.clipSnapshot)) {
      throw new ClipExportError("export_snapshot_missing", "Export snapshot is missing");
    }
    const frozenDocument = decodeFrozenClipEditorDocument(
      frozenSnapshot,
      clipSourceEdgeSec(owned.project),
    );
    assertClipExportDocumentAllowed(
      resolvePricingTier(owned.project.workspace?.pricingTier),
      frozenDocument,
    );
    await assertSceneExportAvailability(
      frozenDocument,
      brandOwnerWhereFor(brandOwnerForWorkspace({
        id: owned.project.workspaceId,
        personalOwnerUserId: owned.project.workspace.personalOwnerUserId,
      })),
    );

    await new WorkflowRunLifecycle({ prisma }).retryFailedClipExport({
      projectId, exportId, expectedRetryCount: owned.retryCount, variantIds: failed.map((variant) => variant.id),
    });

    return this.getOwned(scope, projectId, clipId, exportId);
  }

  async createShareLink(
    scope: ActorScope,
    projectId: string,
    clipId: string,
    exportId: string,
    expiresInDays: 1 | 7 | 30 | null,
  ): Promise<{ path: string; expiresAt: string | null }> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
    const prisma = requirePrisma();
    const owned = await prisma.clipExport.findFirst({
      where: {
        id: exportId,
        projectId,
        clipId,
        project: {
          workspaceId: scope.workspaceId,
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
    scope: ActorScope,
    projectId: string,
    clipId: string,
    exportId: string,
  ) {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.edit");
    const prisma = requirePrisma();
    const owned = await prisma.clipExport.findFirst({
      where: {
        id: exportId,
        projectId,
        clipId,
        project: {
          workspaceId: scope.workspaceId,
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

  async cancelQueuedOperation(scope: ActorScope, exportId: string): Promise<boolean> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "processing.consume");
    return requirePrisma().$transaction(async (tx) => {
      const owned = await tx.clipExport.findFirst({
        where: {
          id: exportId,
          workspaceId: scope.workspaceId,
          project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
        },
        select: { id: true },
      });
      if (!owned) throw new ClipExportError("export_not_found", "Export not found");

      // Match the worker's child-before-aggregate lock order. A worker which has
      // claimed a variant wins; shared runs and already rendering variants continue.
      const pending = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT r."id" FROM "ClipRender" r
        JOIN "ClipExportVariant" v ON v."id" = r."exportVariantId"
        WHERE v."exportId" = ${exportId}::uuid
          AND v."status" = 'pending' AND r."status" = 'pending'
        ORDER BY r."id" FOR UPDATE OF r
      `;
      const completedAt = new Date();
      await tx.clipRender.updateMany({
        where: { id: { in: pending.map((render) => render.id) }, status: "pending" },
        data: { status: "failed", errorCode: "MCP_CANCELLED", failureDisposition: "permanent", completedAt },
      });
      const cancelled = await tx.clipExportVariant.updateMany({
        where: {
          exportId,
          status: "pending",
          OR: [{ render: null }, { render: { status: "failed", errorCode: "MCP_CANCELLED" } }],
        },
        data: { status: "failed", errorCode: "MCP_CANCELLED", completedAt },
      });
      if (cancelled.count === 0) return false;

      await syncClipExportAggregate(tx, exportId);
      await flushWorkspaceEvents(tx);
      return true;
    });
  }

  async syncAggregate(exportId: string) {
    return requirePrisma().$transaction(async (tx) => {
      const aggregate = await syncClipExportAggregate(tx, exportId);
      await flushWorkspaceEvents(tx);
      return aggregate;
    });
  }
}

export const clipExportService = new ClipExportService();
