import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Clip, ClipRender } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  captionPresetSchema,
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
  clipAspectRatioOptions,
  clipAspectRatioToDb,
  getEffectiveClipTiming,
  normalizeTranscriptSliceForClip,
} from "@narriflow/validators";
import type {
  CaptionPreset,
  ClipAspectRatio,
  ClipCategory,
  ClipRenderVariant,
  ClipSnapshot,
  TranscriptUtterance,
} from "@narriflow/validators";
import {
  getLastWorkflowSeq,
  publishWorkflowStageUpdated,
} from "./workflow.service";
import { deleteObject, presignDownloadUrl } from "./r2-storage";

interface DetectedClip {
  startSec: number;
  endSec: number;
  hookText: string;
  reasoning: string;
  category: ClipCategory;
  hookStrengthScore: number;
  emotionalIntensityScore: number;
  pacingScore: number;
  durationOptimalityScore: number;
  viralityScore: number;
  tiktokScore: number;
  youtubeScore: number;
  instagramScore: number;
  transcriptSlice: TranscriptUtterance[];
}

interface LlmMeta {
  provider: string;
  model: string;
  totalTokensUsed: number | null;
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
    hookText: clip.hookText,
    reasoning: clip.reasoning,
    category: clip.category as ClipSnapshot["category"],
    viralityScore: clip.viralityScore,
    hookStrengthScore: clip.hookStrengthScore,
    emotionalIntensityScore: clip.emotionalIntensityScore,
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
  ) {
    const prisma = requirePrisma();
    const staleRenderKeys = await prisma.clipRender.findMany({
      where: {
        clip: { projectId },
        storageKey: { not: null },
      },
      select: { storageKey: true },
    });

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
            hookText: clip.hookText,
            reasoning: clip.reasoning,
            category: clip.category,
            transcriptSlice:
              clip.transcriptSlice as unknown as Prisma.InputJsonValue,
            viralityScore: clip.viralityScore,
            hookStrengthScore: clip.hookStrengthScore,
            emotionalIntensityScore: clip.emotionalIntensityScore,
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
  ) {
    const prisma = requirePrisma();

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

    await prisma.workflowRun.create({
      data: {
        id: workflowRunId,
        projectId,
        idempotencyKey,
        stage: "moment_detection",
        status: "queued",
        progress: 0,
      },
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

    await prisma.clipRender.update({
      where: { id: clipRenderId },
      data: {
        status: "completed",
        storageKey: input.storageKey,
        sizeBytes: BigInt(input.sizeBytes),
        durationSec: input.durationSec,
        errorCode: null,
        completedAt: new Date(),
      },
    });
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
  ): Promise<{ downloadUrl: string; expiresInSeconds: number; fileName: string }> {
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

    if (!render) {
      throw new Error("clip render not found");
    }

    if (render.status !== "completed" || !render.storageKey) {
      throw new Error("clip has not been rendered for this aspect ratio");
    }

    const slug = aspectRatioSlug.get(aspectRatio) ?? "9x16";
    const fileName = `clip-${render.clip.index + 1}-${render.clip.category}-${slug}.mp4`;
    const downloadUrl = await presignDownloadUrl({
      key: render.storageKey,
      fileName,
    });

    return {
      downloadUrl,
      expiresInSeconds: 3600,
      fileName,
    };
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
  ): Promise<void> {
    const prisma = requirePrisma();

    const clips = await prisma.clip.findMany({
      where: { projectId, status: { not: "rejected" } },
      select: { id: true },
    });

    if (clips.length === 0) {
      return;
    }

    const aspectRatioDb = clipAspectRatioToDb["9:16"];
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

// --- Scoring utilities ---

export function sliceTranscriptForClip(
  utterances: TranscriptUtterance[],
  startSec: number,
  endSec: number,
): TranscriptUtterance[] {
  return normalizeTranscriptSliceForClip(utterances, startSec, endSec);
}

export function computeDurationOptimality(durationSec: number): number {
  if (durationSec >= 30 && durationSec <= 60) return 100;
  if (durationSec >= 15 && durationSec < 30) {
    return Math.round(60 + ((durationSec - 15) / 15) * 40);
  }
  if (durationSec > 60 && durationSec <= 90) {
    return Math.round(100 - ((durationSec - 60) / 30) * 30);
  }
  if (durationSec > 90 && durationSec <= 120) {
    return Math.round(70 - ((durationSec - 90) / 30) * 30);
  }
  if (durationSec < 15) {
    return Math.max(20, Math.round((durationSec / 15) * 60));
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
  pacing: number;
  durationOptimality: number;
}): number {
  return Math.round(
    subScores.hookStrength * 0.35 +
      subScores.emotionalIntensity * 0.25 +
      subScores.pacing * 0.2 +
      subScores.durationOptimality * 0.2,
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
