import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Clip, ClipRender } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { projectService } from "./project.service";
import {
  BRAND_DEFAULT_CAPTION_PRESET_ID,
  LEGACY_DEFAULT_CAPTION_PRESET_ID,
  brollCuesArraySchema,
  captionPresetSchema,
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
  clipAspectRatioOptions,
  clipAspectRatioToDb,
  contentPackSchema,
  getCaptionPresetById,
  getEffectiveClipTiming,
  isBrandDefaultCaptionPresetId,
  normalizeTranscriptSliceForClip,
  studioEditsSchema,
} from "@narriflow/validators";
import type {
  BrollCue,
  CaptionPreset,
  ClipAspectRatio,
  ClipCategory,
  ClipPlatformTarget,
  ClipRenderVariant,
  ClipSnapshot,
  ContentPack,
  StudioEdits,
  TranscriptUtterance,
  WorkflowStageUpdatedEvent,
} from "@narriflow/validators";
import {
  getLastWorkflowSeq,
  publishWorkflowStageUpdated,
} from "./workflow.service";
import { deleteObject, presignDownloadUrl } from "./r2-storage";
import { analyticsService } from "./analytics.service";
import { assertPublicHttpUrl } from "./url-guard";

interface DetectedClip {
  startSec: number;
  endSec: number;
  title: string | null;
  hookText: string;
  payoffText: string | null;
  reasoning: string;
  category: ClipCategory;
  platformFit: ClipPlatformTarget[];
  hookStrengthScore: number;
  emotionalIntensityScore: number;
  storyCompletenessScore: number;
  pacingScore: number;
  durationOptimalityScore: number;
  viralityScore: number;
  tiktokScore: number;
  youtubeScore: number;
  instagramScore: number;
  transcriptSlice: TranscriptUtterance[];
  /** LLM-suggested B-roll cutaway moments, `atSec` relative to the clip's own
   *  start. Optional: the caption-only detection path emits no cues, and older
   *  rows predate the column. When absent the render falls back to the
   *  keyword-derived Pexels query. */
  brollCues?: BrollCue[];
}

interface LlmMeta {
  provider: string;
  model: string;
  totalTokensUsed: number | null;
}

/** A clip still missing a preview proxy, with enough of its project's
 *  source info for the worker to cut one. Returned by
 *  {@link ClipService.getClipsNeedingPreview}. */
export interface ClipPendingPreview {
  id: string;
  projectId: string;
  startSec: number;
  endSec: number;
  sourceStorageKey: string;
  sourceDurationSec: number | null;
}

export function resolveClipCaptionPresetForContentPack(
  captionPresetId: string | null | undefined,
  templateCaptionPreset: CaptionPreset | null,
): CaptionPreset | null {
  const id =
    captionPresetId && captionPresetId.trim()
      ? captionPresetId
      : BRAND_DEFAULT_CAPTION_PRESET_ID;

  if (
    isBrandDefaultCaptionPresetId(id) ||
    id === LEGACY_DEFAULT_CAPTION_PRESET_ID
  ) {
    return templateCaptionPreset;
  }

  return getCaptionPresetById(id)?.preset ?? templateCaptionPreset;
}

type ClipWithRenders = Clip & {
  renders: ClipRender[];
  project?: { sourceDurationSeconds: number | null } | null;
};

const DEFAULT_RENDER_ASPECT_RATIOS: ClipAspectRatio[] = ["9:16"];
const aspectRatioOrder = new Map(
  clipAspectRatioOptions.map((option, index) => [option.value, index]),
);
const aspectRatioSlug = new Map(
  clipAspectRatioOptions.map((option) => [option.value, option.slug]),
);

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("Database client unavailable");
  }
  return prisma;
}

function normalizeAspectRatios(
  aspectRatios?: ClipAspectRatio[],
): ClipAspectRatio[] {
  const requested =
    aspectRatios && aspectRatios.length > 0
      ? aspectRatios
      : DEFAULT_RENDER_ASPECT_RATIOS;

  return [...new Set(requested)].sort(
    (left, right) =>
      (aspectRatioOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (aspectRatioOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

function toClipRenderVariantSnapshot(render: ClipRender): ClipRenderVariant {
  const aspectRatioDb = clipAspectRatioDbSchema.parse(render.aspectRatio);
  const aspectRatio = clipAspectRatioFromDb[aspectRatioDb];

  return {
    aspectRatio,
    status: render.status as ClipRenderVariant["status"],
    sizeBytes: render.sizeBytes ? Number(render.sizeBytes) : null,
    durationSec: render.durationSec ?? null,
    errorCode: render.errorCode ?? null,
    completedAt: render.completedAt?.toISOString() ?? null,
    hasAsset: render.status === "completed" && Boolean(render.storageKey),
  };
}

function toClipSnapshot(clip: ClipWithRenders): ClipSnapshot {
  const effective = getEffectiveClipTiming({
    utterances: clip.transcriptSlice as unknown as TranscriptUtterance[],
    startSec: clip.startSec,
    endSec: clip.endSec,
    sourceDurationSec: clip.project?.sourceDurationSeconds ?? null,
  });

  return {
    id: clip.id,
    projectId: clip.projectId,
    index: clip.index,
    status: clip.status as ClipSnapshot["status"],
    startSec: effective.startSec,
    endSec: effective.endSec,
    durationSec: Math.round(effective.durationSec * 10) / 10,
    title: clip.title,
    hookText: clip.hookText,
    payoffText: clip.payoffText,
    reasoning: clip.reasoning,
    category: clip.category as ClipSnapshot["category"],
    platformFit: clip.platformFit as ClipPlatformTarget[],
    viralityScore: clip.viralityScore,
    hookStrengthScore: clip.hookStrengthScore,
    emotionalIntensityScore: clip.emotionalIntensityScore,
    storyCompletenessScore: clip.storyCompletenessScore,
    pacingScore: clip.pacingScore,
    durationOptimalityScore: clip.durationOptimalityScore,
    tiktokScore: clip.tiktokScore,
    youtubeScore: clip.youtubeScore,
    instagramScore: clip.instagramScore,
    transcriptSlice: effective.transcriptSlice,
    renderVariants: clip.renders
      .map(toClipRenderVariantSnapshot)
      .sort(
        (left, right) =>
          (aspectRatioOrder.get(left.aspectRatio) ?? Number.MAX_SAFE_INTEGER) -
          (aspectRatioOrder.get(right.aspectRatio) ?? Number.MAX_SAFE_INTEGER),
      ),
    captionPreset: clip.captionPreset
      ? captionPresetSchema.parse(clip.captionPreset)
      : null,
    brollUrl: clip.brollUrl ?? null,
    // Tolerant parse: cues are LLM-authored and purely advisory, so a malformed
    // payload should degrade to keyword-derived B-roll, never fail the clip.
    brollCues: brollCuesArraySchema.safeParse(clip.brollCues).data ?? [],
    studioEdits: clip.studioEdits
      ? studioEditsSchema.parse(clip.studioEdits)
      : studioEditsSchema.parse({}),
    // Presence-only signal — never the storage key itself. See the schema
    // doc comment in packages/validators/src/clip.ts for why this exists.
    hasPreview: Boolean(clip.previewStorageKey),
    createdAt: clip.createdAt.toISOString(),
  };
}

function getClipRenderResetData(): Prisma.ClipRenderUpdateInput {
  return {
    status: "pending",
    storageKey: null,
    sizeBytes: null,
    durationSec: null,
    errorCode: null,
    startedAt: null,
    completedAt: null,
  };
}

async function deleteRenderAssets(storageKeys: string[]) {
  const uniqueKeys = [...new Set(storageKeys.filter(Boolean))];

  if (uniqueKeys.length === 0) {
    return;
  }

  await Promise.allSettled(uniqueKeys.map((key) => deleteObject(key)));
}

export class ClipService {
  async persistDetectedClips(
    projectId: string,
    workflowRunId: string,
    clips: DetectedClip[],
    llmMeta: LlmMeta,
    contentPack?: ContentPack | null,
  ) {
    const prisma = requirePrisma();
    const [staleRenderKeys, project] = await Promise.all([
      prisma.clipRender.findMany({
        where: {
          clip: { projectId },
          storageKey: { not: null },
        },
        select: { storageKey: true },
      }),
      prisma.project.findUnique({
        where: { id: projectId },
        select: { brandSnapshot: true },
      }),
    ]);

    let templateCaptionPreset: CaptionPreset | null = null;
    const snapshotRaw = project?.brandSnapshot;
    if (snapshotRaw && typeof snapshotRaw === "object" && !Array.isArray(snapshotRaw)) {
      const snap = snapshotRaw as Record<string, unknown>;
      if (snap.captionPreset && typeof snap.captionPreset === "object") {
        templateCaptionPreset = captionPresetSchema.parse(snap.captionPreset);
      }
    }
    const resolvedCaptionPreset = resolveClipCaptionPresetForContentPack(
      contentPack?.captionPreset,
      templateCaptionPreset,
    );

    await prisma.$transaction(async (tx) => {
      await tx.clip.deleteMany({ where: { projectId } });

      if (clips.length > 0) {
        await tx.clip.createMany({
          data: clips.map((clip, i) => ({
            projectId,
            workflowRunId,
            index: i,
            startSec: clip.startSec,
            endSec: clip.endSec,
            title: clip.title,
            hookText: clip.hookText,
            payoffText: clip.payoffText,
            reasoning: clip.reasoning,
            category: clip.category,
            platformFit: clip.platformFit,
            transcriptSlice:
              clip.transcriptSlice as unknown as Prisma.InputJsonValue,
            brollCues:
              clip.brollCues && clip.brollCues.length > 0
                ? (clip.brollCues as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            captionPreset: resolvedCaptionPreset
              ? (resolvedCaptionPreset as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            viralityScore: clip.viralityScore,
            hookStrengthScore: clip.hookStrengthScore,
            emotionalIntensityScore: clip.emotionalIntensityScore,
            storyCompletenessScore: clip.storyCompletenessScore,
            pacingScore: clip.pacingScore,
            durationOptimalityScore: clip.durationOptimalityScore,
            tiktokScore: clip.tiktokScore,
            youtubeScore: clip.youtubeScore,
            instagramScore: clip.instagramScore,
            llmProvider: llmMeta.provider,
            llmModel: llmMeta.model,
            llmTokensUsed: llmMeta.totalTokensUsed,
          })),
        });
      }
    });

    await deleteRenderAssets(
      staleRenderKeys
        .map((render) => render.storageKey)
        .filter((key): key is string => Boolean(key)),
    );
  }

  async listClips(userId: string, projectId: string): Promise<ClipSnapshot[]> {
    const prisma = requirePrisma();

    const clips = await prisma.clip.findMany({
      where: {
        projectId,
        project: { userId },
      },
      include: {
        project: { select: { sourceDurationSeconds: true } },
        renders: true,
      },
      orderBy: { viralityScore: "desc" },
    });

    return clips.map(toClipSnapshot);
  }

  async updateClipBoundaries(
    userId: string,
    projectId: string,
    clipId: string,
    input: { startSec: number; endSec: number },
  ): Promise<ClipSnapshot> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: {
        id: clipId,
        projectId,
        project: { userId },
      },
      include: {
        project: {
          include: { transcript: true },
        },
        renders: true,
      },
    });

    if (!clip) {
      throw new Error("clip not found");
    }

    const utterances = clip.project.transcript?.utterancesJson as
      | TranscriptUtterance[]
      | null;
    const effective = getEffectiveClipTiming({
      utterances: utterances ?? [],
      startSec: input.startSec,
      endSec: input.endSec,
      sourceDurationSec: clip.project.sourceDurationSeconds,
    });
    const newSlice = utterances ? effective.transcriptSlice : [];

    const durationSec = effective.durationSec;
    const durationOptimalityScore = computeDurationOptimality(durationSec);

    const tiktokScore = computePlatformScore(
      clip.viralityScore,
      durationSec,
      "tiktok",
    );
    const youtubeScore = computePlatformScore(
      clip.viralityScore,
      durationSec,
      "youtube",
    );
    const instagramScore = computePlatformScore(
      clip.viralityScore,
      durationSec,
      "instagram",
    );

    const staleRenderKeys = clip.renders
      .map((render) => render.storageKey)
      .filter((key): key is string => Boolean(key));

    const updated = await prisma.$transaction(async (tx) => {
      await tx.clipRender.deleteMany({
        where: { clipId },
      });

      return tx.clip.update({
        where: { id: clipId },
        data: {
          startSec: effective.startSec,
          endSec: effective.endSec,
          status: "edited",
          transcriptSlice: newSlice as unknown as Prisma.InputJsonValue,
          durationOptimalityScore,
          tiktokScore,
          youtubeScore,
          instagramScore,
        },
        include: {
          renders: true,
        },
      });
    });

    await deleteRenderAssets(staleRenderKeys);

    return toClipSnapshot(updated);
  }

  async updateClipStatus(
    userId: string,
    projectId: string,
    clipId: string,
    status: "accepted" | "rejected",
  ): Promise<ClipSnapshot> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: {
        id: clipId,
        projectId,
        project: { userId },
      },
    });

    if (!clip) {
      throw new Error("clip not found");
    }

    const updated = await prisma.clip.update({
      where: { id: clipId },
      data: { status },
      include: {
        renders: true,
      },
    });

    return toClipSnapshot(updated);
  }

  async regenerateClips(
    userId: string,
    projectId: string,
    idempotencyKey: string,
    contentPack?: ContentPack,
  ) {
    const prisma = requirePrisma();
    const parsedContentPack = contentPack
      ? contentPackSchema.parse(contentPack)
      : null;

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: {
        id: true,
        transcript: { select: { status: true } },
      },
    });

    if (!project) {
      throw new Error("project not found");
    }

    if (project.transcript?.status !== "completed") {
      throw new Error("transcript is not ready");
    }

    // Enforce plan-tier quota + per-upload length cap on this path too (the
    // project-page "Detect / Regenerate Clips" buttons route through here).
    await projectService.assertProjectGenerationAllowed(userId, projectId);

    const existing = await prisma.workflowRun.findFirst({
      where: {
        projectId,
        stage: "moment_detection",
        status: { in: ["queued", "running"] },
      },
    });

    if (existing) {
      return {
        workflowRunId: existing.id,
        acceptedAt: existing.updatedAt.toISOString(),
        initialSeq: await getLastWorkflowSeq(projectId),
      };
    }

    const workflowRunId = randomUUID();

    await prisma.$transaction(async (tx) => {
      if (parsedContentPack) {
        await tx.contentPack.create({
          data: {
            projectId,
            outputTypes: parsedContentPack.outputTypes,
            clipGenerationMode: parsedContentPack.clipGenerationMode,
            clipCountTarget: parsedContentPack.clipCountTarget,
            clipDurationSecTarget: parsedContentPack.clipDurationSecTarget,
            minDurationSec: parsedContentPack.minDurationSec,
            preferredMinDurationSec: parsedContentPack.preferredMinDurationSec,
            preferredMaxDurationSec: parsedContentPack.preferredMaxDurationSec,
            maxDurationSec: parsedContentPack.maxDurationSec,
            platformTargets: parsedContentPack.platformTargets,
            autoRenderClips: parsedContentPack.autoRenderClips,
            toneConstraints: parsedContentPack.toneConstraints,
            captionPreset: parsedContentPack.captionPreset,
            platformPlaybookVersion: parsedContentPack.platformPlaybookVersion,
            mode: parsedContentPack.mode,
            autoHook: parsedContentPack.autoHook,
            specificMoments: parsedContentPack.specificMoments,
            processingStartSec: parsedContentPack.processingStartSec,
            processingEndSec: parsedContentPack.processingEndSec,
          },
        });
      }

      await tx.workflowRun.create({
        data: {
          id: workflowRunId,
          projectId,
          idempotencyKey,
          stage: "moment_detection",
          status: "queued",
          progress: 0,
        },
      });
    });

    const event = await publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId,
      workflowRunId,
      stage: "moment_detection",
      status: "queued",
      progress: 0,
      errorCode: null,
    });

    return {
      workflowRunId,
      acceptedAt: event?.emittedAt ?? new Date().toISOString(),
      initialSeq: event?.seq ?? 0,
    };
  }

  async triggerClipRendering(
    userId: string,
    projectId: string,
    idempotencyKey: string,
    clipIds?: string[],
    aspectRatios?: ClipAspectRatio[],
  ) {
    const prisma = requirePrisma();
    const requestedAspectRatios = normalizeAspectRatios(aspectRatios);
    const requestedAspectRatioDbValues = requestedAspectRatios.map(
      (aspectRatio) => clipAspectRatioToDb[aspectRatio],
    );

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    });

    if (!project) {
      throw new Error("project not found");
    }

    const whereClause: Prisma.ClipWhereInput = clipIds
      ? {
          projectId,
          id: { in: clipIds },
          status: { not: "rejected" },
        }
      : { projectId, status: { not: "rejected" } };

    const clipsToRender = await prisma.clip.findMany({
      where: whereClause,
      select: { id: true },
    });

    if (clipsToRender.length === 0) {
      throw new Error("no clips available for rendering");
    }

    const clipIdsToRender = clipsToRender.map((clip) => clip.id);
    const existingRenderVariants = await prisma.clipRender.findMany({
      where: {
        clipId: { in: clipIdsToRender },
        aspectRatio: { in: requestedAspectRatioDbValues },
      },
      select: {
        id: true,
        clipId: true,
        aspectRatio: true,
        status: true,
      },
    });

    const existingRenderMap = new Map(
      existingRenderVariants.map((render) => [
        `${render.clipId}:${render.aspectRatio}`,
        render,
      ]),
    );

    const createOperations: Prisma.PrismaPromise<unknown>[] = [];
    const updateOperations: Prisma.PrismaPromise<unknown>[] = [];

    for (const clip of clipsToRender) {
      for (const aspectRatio of requestedAspectRatios) {
        const aspectRatioDb = clipAspectRatioToDb[aspectRatio];
        const key = `${clip.id}:${aspectRatioDb}`;
        const existingRender = existingRenderMap.get(key);

        if (!existingRender) {
          createOperations.push(
            prisma.clipRender.create({
              data: {
                clipId: clip.id,
                aspectRatio: aspectRatioDb,
                status: "pending",
              },
            }),
          );
          continue;
        }

        if (
          existingRender.status === "pending" ||
          existingRender.status === "rendering"
        ) {
          continue;
        }

        updateOperations.push(
          prisma.clipRender.update({
            where: { id: existingRender.id },
            data: getClipRenderResetData(),
          }),
        );
      }
    }

    if (createOperations.length > 0 || updateOperations.length > 0) {
      await prisma.$transaction([...createOperations, ...updateOperations]);
    }

    const existingWorkflowRun = await prisma.workflowRun.findFirst({
      where: {
        projectId,
        stage: "clip_rendering",
        status: { in: ["queued", "running"] },
      },
    });

    if (existingWorkflowRun) {
      return {
        workflowRunId: existingWorkflowRun.id,
        acceptedAt: existingWorkflowRun.updatedAt.toISOString(),
        initialSeq: await getLastWorkflowSeq(projectId),
        clipCount: clipsToRender.length,
        variantCount: clipsToRender.length * requestedAspectRatios.length,
      };
    }

    const workflowRunId = randomUUID();

    await prisma.workflowRun.create({
      data: {
        id: workflowRunId,
        projectId,
        idempotencyKey,
        stage: "clip_rendering",
        status: "queued",
        progress: 0,
      },
    });

    const event = await publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId,
      workflowRunId,
      stage: "clip_rendering",
      status: "queued",
      progress: 0,
      errorCode: null,
    });

    return {
      workflowRunId,
      acceptedAt: event?.emittedAt ?? new Date().toISOString(),
      initialSeq: event?.seq ?? 0,
      clipCount: clipsToRender.length,
      variantCount: clipsToRender.length * requestedAspectRatios.length,
    };
  }

  async getPendingClipRendersForProject(projectId: string) {
    const prisma = requirePrisma();
    const renders = await prisma.clipRender.findMany({
      where: {
        status: "pending",
        clip: { projectId },
      },
      include: {
        clip: true,
      },
    });

    return renders.sort((left, right) => {
      if (left.clip.index !== right.clip.index) {
        return left.clip.index - right.clip.index;
      }

      const leftAspectRatio = clipAspectRatioFromDb[
        clipAspectRatioDbSchema.parse(left.aspectRatio)
      ];
      const rightAspectRatio = clipAspectRatioFromDb[
        clipAspectRatioDbSchema.parse(right.aspectRatio)
      ];

      return (
        (aspectRatioOrder.get(leftAspectRatio) ?? Number.MAX_SAFE_INTEGER) -
        (aspectRatioOrder.get(rightAspectRatio) ?? Number.MAX_SAFE_INTEGER)
      );
    });
  }

  async markClipRenderVariantRendering(clipRenderId: string) {
    const prisma = requirePrisma();

    await prisma.clipRender.update({
      where: { id: clipRenderId },
      data: {
        status: "rendering",
        startedAt: new Date(),
        errorCode: null,
      },
    });
  }

  async completeClipRenderVariant(
    clipRenderId: string,
    input: {
      storageKey: string;
      sizeBytes: number;
      durationSec: number;
    },
  ) {
    const prisma = requirePrisma();

    const render = await prisma.clipRender.update({
      where: { id: clipRenderId },
      data: {
        status: "completed",
        storageKey: input.storageKey,
        sizeBytes: BigInt(input.sizeBytes),
        durationSec: input.durationSec,
        errorCode: null,
        completedAt: new Date(),
      },
      include: { clip: { select: { projectId: true } } },
    });

    await analyticsService.recordProjectEvent({
      projectId: render.clip.projectId,
      clipId: render.clipId,
      type: "render_completed",
      metadata: { aspectRatio: render.aspectRatio },
    });

    // Incremental delivery: nudge the project's live stream as soon as this
    // individual clip's render lands, instead of only on the run's overall
    // completed/failed transition — see project-events.tsx's throttled
    // refresh-on-progress handling.
    await this.pingActiveWorkflowRun(render.clip.projectId);
  }

  async failClipRenderVariant(clipRenderId: string, errorCode: string) {
    const prisma = requirePrisma();

    await prisma.clipRender.update({
      where: { id: clipRenderId },
      data: {
        status: "failed",
        errorCode,
      },
    });
  }

  async getClipDownloadUrl(
    userId: string,
    projectId: string,
    clipId: string,
    aspectRatio: ClipAspectRatio = "9:16",
  ): Promise<{
    downloadUrl: string;
    expiresInSeconds: number;
    fileName: string;
    /** True when `downloadUrl` points at the lightweight preview proxy
     *  rather than a finished render — see the fallback below. */
    isPreviewProxy?: boolean;
    /** The proxy's t=0 expressed in source time; only present alongside
     *  `isPreviewProxy`. Callers must subtract this from source-time
     *  boundaries before seeking/trimming against the proxy. */
    previewStartSec?: number;
  }> {
    const prisma = requirePrisma();
    const aspectRatioDb = clipAspectRatioToDb[aspectRatio];

    const render = await prisma.clipRender.findFirst({
      where: {
        clipId,
        aspectRatio: aspectRatioDb,
        clip: {
          projectId,
          project: { userId },
        },
      },
      include: {
        clip: true,
      },
    });

    if (render && render.status === "completed" && render.storageKey) {
      const slug = aspectRatioSlug.get(aspectRatio) ?? "9x16";
      const fileName = `clip-${render.clip.index + 1}-${render.clip.category}-${slug}.mp4`;
      const downloadUrl = await presignDownloadUrl({
        key: render.storageKey,
        fileName,
      });

      await analyticsService.recordProjectEvent({
        projectId,
        clipId,
        type: "download_opened",
        metadata: { aspectRatio },
      });

      return {
        downloadUrl,
        expiresInSeconds: 3600,
        fileName,
      };
    }

    // No completed render for this aspect ratio yet (or none was ever
    // queued) — fall back to the lightweight, aspect-ratio-agnostic preview
    // proxy so callers still get something playable instead of a hard
    // error. This path is never reached by an explicit "Download" click
    // (the UI only offers that button once `hasAsset` is true), so it's
    // exclusively the inline-preview path — no `download_opened` analytics.
    const clip =
      render?.clip ??
      (await prisma.clip.findFirst({
        where: { id: clipId, projectId, project: { userId } },
      }));

    if (clip?.previewStorageKey) {
      const fileName = `clip-${clip.index + 1}-preview.mp4`;
      const downloadUrl = await presignDownloadUrl({
        key: clip.previewStorageKey,
        fileName,
      });

      return {
        downloadUrl,
        expiresInSeconds: 3600,
        fileName,
        isPreviewProxy: true,
        previewStartSec: clip.previewStartSec ?? 0,
      };
    }

    if (!render) {
      throw new Error("clip render not found");
    }

    throw new Error("clip has not been rendered for this aspect ratio");
  }

  /**
   * Resolves a presigned URL for a clip's preview proxy (if one has been
   * generated yet) for the studio editor. Returns nulls when no proxy
   * exists so the caller can fall back to the full source. Kept separate
   * from {@link getClipDownloadUrl} because the studio has no aspect-ratio
   * selector to key a render lookup off of — it always wants "whatever
   * preview exists for this clip," full stop.
   */
  async getClipPreviewSource(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<{
    previewUrl: string | null;
    previewStartSec: number;
    previewDurationSec: number | null;
  }> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      select: {
        previewStorageKey: true,
        previewStartSec: true,
        previewDurationSec: true,
      },
    });

    if (!clip?.previewStorageKey) {
      return { previewUrl: null, previewStartSec: 0, previewDurationSec: null };
    }

    try {
      const previewUrl = await presignDownloadUrl({
        key: clip.previewStorageKey,
        expiresIn: 3600,
      });
      return {
        previewUrl,
        previewStartSec: clip.previewStartSec ?? 0,
        previewDurationSec: clip.previewDurationSec ?? null,
      };
    } catch {
      return { previewUrl: null, previewStartSec: 0, previewDurationSec: null };
    }
  }

  /**
   * Finds clips still missing a preview proxy, highest `viralityScore`
   * first (users look at the top clips first) — scoped to projects whose
   * source is still available and fully ingested. Backs the worker's
   * decoupled `processPendingClipPreviews` poll (apps/worker/src/tasks/
   * clip-preview.ts), which also backfills every pre-existing clip.
   *
   * Returns the *effective* (transcript-boundary-expanded) timing — the
   * exact same `getEffectiveClipTiming` computation `toClipSnapshot` uses
   * for what the studio/clip-card actually display — not the raw DB
   * columns. A freshly-detected clip's raw `startSec`/`endSec` can differ
   * from its displayed timing (boundary edits persist the effective values
   * back, but detection doesn't); padding around the raw columns could
   * leave the proxy not actually covering what's shown, silently reproducing
   * the exact off-by-`previewStartSec` desync this feature exists to avoid.
   */
  async getClipsNeedingPreview(limit: number): Promise<ClipPendingPreview[]> {
    const prisma = requirePrisma();
    const take = Math.max(1, Math.min(25, limit));

    const clips = await prisma.clip.findMany({
      where: {
        previewStorageKey: null,
        project: {
          sourceStorageKey: { not: null },
          ingestStatus: "ready",
        },
      },
      orderBy: [{ viralityScore: "desc" }, { createdAt: "asc" }],
      take,
      select: {
        id: true,
        projectId: true,
        startSec: true,
        endSec: true,
        transcriptSlice: true,
        project: {
          select: { sourceStorageKey: true, sourceDurationSeconds: true },
        },
      },
    });

    const pending: ClipPendingPreview[] = [];
    for (const clip of clips) {
      if (!clip.project.sourceStorageKey) continue;

      const effective = getEffectiveClipTiming({
        utterances: clip.transcriptSlice as unknown as TranscriptUtterance[],
        startSec: clip.startSec,
        endSec: clip.endSec,
        sourceDurationSec: clip.project.sourceDurationSeconds ?? null,
      });

      pending.push({
        id: clip.id,
        projectId: clip.projectId,
        startSec: effective.startSec,
        endSec: effective.endSec,
        sourceStorageKey: clip.project.sourceStorageKey,
        sourceDurationSec: clip.project.sourceDurationSeconds ?? null,
      });
    }
    return pending;
  }

  /**
   * Persists a clip's generated preview-proxy metadata — but only if no
   * proxy has been recorded yet. `previewStorageKey IS NULL` is the atomic
   * claim condition (mirroring the codebase's claim-via-conditional-update
   * idiom used by e.g. `claimNextWorkflowRun`), since the Clip model has no
   * separate "generating" status column to transition: two workers racing
   * to cut the same clip's proxy will both upload, but only one write wins
   * here — the loser (persisted: false) must delete its own upload.
   */
  async completeClipPreview(
    clipId: string,
    input: { storageKey: string; startSec: number; durationSec: number },
  ): Promise<{ persisted: boolean; projectId: string | null }> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findUnique({
      where: { id: clipId },
      select: { projectId: true },
    });
    if (!clip) {
      return { persisted: false, projectId: null };
    }

    const claim = await prisma.clip.updateMany({
      where: { id: clipId, previewStorageKey: null },
      data: {
        previewStorageKey: input.storageKey,
        previewStartSec: input.startSec,
        previewDurationSec: input.durationSec,
      },
    });

    if (claim.count === 0) {
      return { persisted: false, projectId: clip.projectId };
    }

    // Incremental delivery: nudge the project's live stream — see
    // project-events.tsx's throttled refresh-on-progress handling.
    await this.pingActiveWorkflowRun(clip.projectId);

    return { persisted: true, projectId: clip.projectId };
  }

  /**
   * Best-effort "something changed" ping for a project's live SSE stream —
   * reuses whatever WorkflowRun is currently queued/running for the
   * project rather than inventing a new event shape or stage (the shape is
   * the shared `workflow.stage.updated` event consumed by
   * apps/web/app/api/stream/[projectId]/route.ts). A no-op when nothing is
   * actively in flight for the project, so a backfill run touching an
   * already-finished project doesn't inject stale-looking "activity".
   * Never throws — a missed nudge just means the client catches up on its
   * next poll/navigation instead of getting an instant push.
   */
  private async pingActiveWorkflowRun(projectId: string): Promise<void> {
    try {
      const prisma = requirePrisma();
      const run = await prisma.workflowRun.findFirst({
        where: { projectId, status: { in: ["queued", "running"] } },
        orderBy: { updatedAt: "desc" },
      });
      if (!run) return;

      await publishWorkflowStageUpdated({
        event: "workflow.stage.updated",
        projectId,
        workflowRunId: run.id,
        stage: run.stage as WorkflowStageUpdatedEvent["stage"],
        status: run.status as WorkflowStageUpdatedEvent["status"],
        progress: run.progress,
        errorCode: run.errorCode,
      });
    } catch {
      // Best-effort only — the SSE route also polls the DB as a fallback.
    }
  }

  async updateClipCaptionPreset(
    userId: string,
    projectId: string,
    clipId: string,
    preset: CaptionPreset | null,
  ): Promise<ClipSnapshot> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: {
        id: clipId,
        projectId,
        project: { userId },
      },
    });

    if (!clip) {
      throw new Error("clip not found");
    }

    const updated = await prisma.clip.update({
      where: { id: clipId },
      data: {
        captionPreset: preset !== null ? (preset as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
      include: { renders: true },
    });

    return toClipSnapshot(updated);
  }

  /**
   * Sets (or clears, with null) the chosen stock B-roll URL for a clip, and
   * invalidates existing renders — but only when the value actually
   * changed. Mirrors `updateClipStudioEdits`'s no-op guard exactly (see
   * below): the studio can re-PATCH the same B-roll selection (e.g. an
   * autosave tick) without deleting a perfectly-valid completed render.
   */
  async updateClipBroll(
    userId: string,
    projectId: string,
    clipId: string,
    brollUrl: string | null,
  ): Promise<ClipSnapshot> {
    if (brollUrl !== null) {
      assertPublicHttpUrl(brollUrl);
    }

    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      include: { renders: true },
    });
    if (!clip) {
      throw new Error("clip not found");
    }

    if (!brollUrlChanged(clip.brollUrl, brollUrl)) {
      return toClipSnapshot(clip);
    }

    const staleRenderKeys = clip.renders
      .map((render) => render.storageKey)
      .filter((key): key is string => Boolean(key));

    let deletedRenderCount = 0;
    const updated = await prisma.$transaction(async (tx) => {
      const deleted = await tx.clipRender.deleteMany({ where: { clipId } });
      deletedRenderCount = deleted.count;
      return tx.clip.update({
        where: { id: clipId },
        data: { brollUrl },
        include: { renders: true },
      });
    });

    console.warn(
      JSON.stringify({
        level: "warn",
        message: "clip_broll_changed_invalidated_renders",
        clipId,
        deletedRenderCount,
      }),
    );

    await deleteRenderAssets(staleRenderKeys);

    return toClipSnapshot(updated);
  }

  /**
   * Persists export-affecting studio edits and clears stale renders — but
   * only when the value actually changed. The client autosaves this field on
   * every edit tick regardless of which field changed (see studio-shell.tsx's
   * persistEdits), so without this guard an unrelated change (e.g. picking a
   * different caption preset) would invalidate every completed render and
   * delete its R2 asset.
   */
  async updateClipStudioEdits(
    userId: string,
    projectId: string,
    clipId: string,
    studioEdits: StudioEdits,
  ): Promise<ClipSnapshot> {
    const prisma = requirePrisma();
    const parsed = studioEditsSchema.parse(studioEdits);

    const clip = await prisma.clip.findFirst({
      where: { id: clipId, projectId, project: { userId } },
      include: { renders: true },
    });
    if (!clip) {
      throw new Error("clip not found");
    }

    const existing = clip.studioEdits
      ? studioEditsSchema.parse(clip.studioEdits)
      : studioEditsSchema.parse({});

    // No-op write: both sides are the output of the same schema parse, so
    // comparing the serialized form is a valid deep-equality check (stable
    // key order, no undefined-vs-missing ambiguity).
    if (JSON.stringify(parsed) === JSON.stringify(existing)) {
      return toClipSnapshot(clip);
    }

    const staleRenderKeys = clip.renders
      .map((render) => render.storageKey)
      .filter((key): key is string => Boolean(key));

    let deletedRenderCount = 0;
    const updated = await prisma.$transaction(async (tx) => {
      const deleted = await tx.clipRender.deleteMany({ where: { clipId } });
      deletedRenderCount = deleted.count;
      return tx.clip.update({
        where: { id: clipId },
        data: {
          studioEdits: parsed as unknown as Prisma.InputJsonValue,
          status: "edited",
        },
        include: { renders: true },
      });
    });

    console.warn(
      JSON.stringify({
        level: "warn",
        message: "studio_edits_changed_invalidated_renders",
        clipId,
        deletedRenderCount,
      }),
    );

    await deleteRenderAssets(staleRenderKeys);

    return toClipSnapshot(updated);
  }

  /** Applies a caption preset to every clip in an owned project ("apply to all"). */
  async applyCaptionPresetToAllClips(
    userId: string,
    projectId: string,
    preset: CaptionPreset,
  ): Promise<{ updated: number }> {
    const prisma = requirePrisma();

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true },
    });
    if (!project) {
      throw new Error("project not found");
    }

    const result = await prisma.clip.updateMany({
      where: { projectId },
      data: { captionPreset: preset as Prisma.InputJsonValue },
    });

    return { updated: result.count };
  }

  async updateClipTranscriptSlice(
    userId: string,
    projectId: string,
    clipId: string,
    transcriptSlice: TranscriptUtterance[],
  ): Promise<ClipSnapshot> {
    const prisma = requirePrisma();

    const clip = await prisma.clip.findFirst({
      where: {
        id: clipId,
        projectId,
        project: { userId },
      },
    });

    if (!clip) {
      throw new Error("clip not found");
    }

    const effective = getEffectiveClipTiming({
      utterances: transcriptSlice,
      startSec: clip.startSec,
      endSec: clip.endSec,
    });

    const updated = await prisma.clip.update({
      where: { id: clipId },
      data: {
        startSec: effective.startSec,
        endSec: effective.endSec,
        transcriptSlice: effective.transcriptSlice as unknown as Prisma.InputJsonValue,
        status: "edited",
      },
      include: { renders: true },
    });

    return toClipSnapshot(updated);
  }

  async autoQueueDefaultRenders(
    projectId: string,
    detectionWorkflowRunId: string,
    aspectRatio: ClipAspectRatio = "9:16",
  ): Promise<void> {
    const prisma = requirePrisma();

    const clips = await prisma.clip.findMany({
      where: { projectId, status: { not: "rejected" } },
      select: { id: true },
    });

    if (clips.length === 0) {
      return;
    }

    const aspectRatioDb = clipAspectRatioToDb[aspectRatio];
    const clipIds = clips.map((c) => c.id);

    const existingRenders = await prisma.clipRender.findMany({
      where: {
        clipId: { in: clipIds },
        aspectRatio: aspectRatioDb,
        status: { in: ["pending", "rendering"] },
      },
      select: { clipId: true },
    });

    const alreadyQueued = new Set(existingRenders.map((r) => r.clipId));
    const toCreate = clipIds.filter((id) => !alreadyQueued.has(id));

    if (toCreate.length > 0) {
      await prisma.clipRender.createMany({
        data: toCreate.map((clipId) => ({
          clipId,
          aspectRatio: aspectRatioDb,
          status: "pending" as const,
        })),
        skipDuplicates: true,
      });
    }

    const existingWorkflowRun = await prisma.workflowRun.findFirst({
      where: {
        projectId,
        stage: "clip_rendering",
        status: { in: ["queued", "running"] },
      },
    });

    if (existingWorkflowRun) {
      return;
    }

    const workflowRunId = randomUUID();

    await prisma.workflowRun.create({
      data: {
        id: workflowRunId,
        projectId,
        idempotencyKey: `auto-render-${detectionWorkflowRunId}`,
        stage: "clip_rendering",
        status: "queued",
        progress: 0,
      },
    });

    await publishWorkflowStageUpdated({
      event: "workflow.stage.updated",
      projectId,
      workflowRunId,
      stage: "clip_rendering",
      status: "queued",
      progress: 0,
      errorCode: null,
    });
  }
}

/**
 * Whether a clip's chosen B-roll URL actually changed. Used by
 * `updateClipBroll` to decide whether completed renders need invalidating —
 * exported so the no-op guard is unit-testable without a database.
 */
export function brollUrlChanged(
  current: string | null,
  next: string | null,
): boolean {
  return current !== next;
}

// --- Scoring utilities ---

export function sliceTranscriptForClip(
  utterances: TranscriptUtterance[],
  startSec: number,
  endSec: number,
): TranscriptUtterance[] {
  return normalizeTranscriptSliceForClip(utterances, startSec, endSec);
}

export function computeDurationOptimality(
  durationSec: number,
  policy: {
    minDurationSec?: number;
    preferredMinDurationSec?: number;
    preferredMaxDurationSec?: number;
    maxDurationSec?: number;
  } = {},
): number {
  const minDurationSec = policy.minDurationSec ?? 15;
  const preferredMinDurationSec = policy.preferredMinDurationSec ?? 30;
  const preferredMaxDurationSec = policy.preferredMaxDurationSec ?? 60;
  const maxDurationSec = policy.maxDurationSec ?? 120;

  if (
    durationSec >= preferredMinDurationSec &&
    durationSec <= preferredMaxDurationSec
  ) {
    return 100;
  }

  if (durationSec >= minDurationSec && durationSec < preferredMinDurationSec) {
    const span = Math.max(1, preferredMinDurationSec - minDurationSec);
    return Math.round(60 + ((durationSec - minDurationSec) / span) * 40);
  }

  if (durationSec > preferredMaxDurationSec && durationSec <= maxDurationSec) {
    const span = Math.max(1, maxDurationSec - preferredMaxDurationSec);
    return Math.round(100 - ((durationSec - preferredMaxDurationSec) / span) * 60);
  }

  if (durationSec < minDurationSec) {
    return Math.max(20, Math.round((durationSec / minDurationSec) * 60));
  }

  return 20;
}

export function computePacingScore(
  utterances: TranscriptUtterance[],
  durationSec: number,
): number {
  if (durationSec <= 0 || utterances.length === 0) return 50;

  const totalWords = utterances.reduce(
    (sum, u) => sum + u.text.split(/\s+/).length,
    0,
  );
  const wps = totalWords / durationSec;
  const speakerTurns = utterances.length;
  const turnsPerMinute = (speakerTurns / durationSec) * 60;

  let score = 50;
  if (wps >= 2 && wps <= 3.5) score += 25;
  else if (wps >= 1.5 && wps < 2) score += 10;
  else if (wps > 3.5 && wps <= 4.5) score += 10;

  if (turnsPerMinute >= 4 && turnsPerMinute <= 12) score += 25;
  else if (turnsPerMinute >= 2 && turnsPerMinute < 4) score += 10;
  else if (turnsPerMinute > 12 && turnsPerMinute <= 20) score += 10;

  return Math.min(100, Math.max(1, score));
}

export function computeViralityScore(subScores: {
  hookStrength: number;
  emotionalIntensity: number;
  storyCompleteness?: number;
  pacing: number;
  durationOptimality: number;
}): number {
  return Math.round(
    subScores.hookStrength * 0.3 +
      subScores.emotionalIntensity * 0.22 +
      (subScores.storyCompleteness ?? 50) * 0.18 +
      subScores.pacing * 0.15 +
      subScores.durationOptimality * 0.15,
  );
}

export function computePlatformScore(
  compositeScore: number,
  durationSec: number,
  platform: "tiktok" | "youtube" | "instagram",
): number {
  const idealRanges: Record<string, [number, number]> = {
    tiktok: [15, 60],
    youtube: [30, 90],
    instagram: [15, 45],
  };

  const [minIdeal, maxIdeal] = idealRanges[platform]!;
  let modifier = 0;

  if (durationSec >= minIdeal && durationSec <= maxIdeal) {
    modifier = 10;
  } else if (durationSec < minIdeal) {
    modifier = -Math.round(((minIdeal - durationSec) / minIdeal) * 20);
  } else {
    modifier = -Math.round(((durationSec - maxIdeal) / maxIdeal) * 20);
  }

  return Math.min(100, Math.max(1, compositeScore + modifier));
}

export const clipService = new ClipService();
