import { getPrismaClient } from "@narriflow/db/client";
import {
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
  clipAspectRatioToDb,
  requestClipDubSchema,
  resolvePricingTier,
  type ClipAspectRatio,
  type ClipDubSnapshot,
  type RequestClipDubInput,
} from "@narriflow/validators";
import { analyticsService } from "./analytics.service";
import { deleteObject, presignDownloadUrl } from "./r2-storage";
import { getLastWorkflowSeq } from "./workflow.service";
import { workspaceService } from "./workspace.service";
import {
  currentWorkflowAttempt,
  getWorkflowRunLifecycle,
  requireProtocolV1WorkflowContext,
  WorkflowAttemptLost,
} from "./workflow-run-lifecycle";

const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";

export class DubbingTierError extends Error {
  readonly code = "requires_pro_plan";
  constructor() {
    super("Dubbing is available on the Pro plan.");
    this.name = "DubbingTierError";
  }
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("Database client unavailable");
  }
  return prisma;
}

function bigintToNumber(value: bigint | number | null) {
  return value === null ? null : Number(value);
}

function aspectRatioFromDb(value: unknown): ClipAspectRatio {
  return clipAspectRatioFromDb[clipAspectRatioDbSchema.parse(value)];
}

const aspectRatioSlug: Record<ClipAspectRatio, string> = {
  "9:16": "9x16",
  "1:1": "1x1",
  "16:9": "16x9",
  "4:5": "4x5",
};

function toDubSnapshot(row: {
  id: string;
  projectId: string;
  clipId: string;
  aspectRatio: unknown;
  targetLanguageCode: string;
  voice: string;
  provider: string;
  model: string;
  status: string;
  transcriptText: string | null;
  translatedText: string | null;
  audioStorageKey: string | null;
  renderStorageKey: string | null;
  audioSizeBytes: bigint | number | null;
  renderSizeBytes: bigint | number | null;
  durationSec: number | null;
  errorCode: string | null;
  completedAt: Date | null;
  createdAt: Date;
}): ClipDubSnapshot {
  return {
    id: row.id,
    projectId: row.projectId,
    clipId: row.clipId,
    aspectRatio: aspectRatioFromDb(row.aspectRatio),
    targetLanguageCode: row.targetLanguageCode,
    voice: row.voice,
    provider: row.provider,
    model: row.model,
    status: row.status as ClipDubSnapshot["status"],
    transcriptText: row.transcriptText,
    translatedText: row.translatedText,
    hasAudioAsset: Boolean(row.audioStorageKey),
    hasVideoAsset: Boolean(row.renderStorageKey),
    audioSizeBytes: bigintToNumber(row.audioSizeBytes),
    renderSizeBytes: bigintToNumber(row.renderSizeBytes),
    durationSec: row.durationSec,
    errorCode: row.errorCode,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DubbingService {
  async listProjectDubs(
    userId: string,
    projectId: string,
  ): Promise<ClipDubSnapshot[]> {
    const prisma = requirePrisma();
    const rows = await prisma.clipDub.findMany({
      where: { projectId, project: { userId } },
      orderBy: [{ createdAt: "desc" }],
    });
    return rows.map(toDubSnapshot);
  }

  async requestClipDub(
    userId: string,
    workspaceId: string,
    projectId: string,
    idempotencyKey: string,
    input: RequestClipDubInput,
  ): Promise<{
    dub: ClipDubSnapshot;
    workflowRunId: string | null;
    acceptedAt: string;
    initialSeq: number;
  }> {
    if (!idempotencyKey) {
      throw new Error("idempotency key is required");
    }

    const prisma = requirePrisma();
    const actor = await workspaceService.requireActor(
      userId,
      workspaceId,
      "processing.consume",
    );
    const tier = resolvePricingTier(actor.pricingTier);
    if (tier !== "pro") {
      throw new DubbingTierError();
    }

    const parsed = requestClipDubSchema.parse(input);
    const aspectRatioDb = clipAspectRatioToDb[parsed.aspectRatio];

    const clip = await prisma.clip.findFirst({
      where: {
        id: parsed.clipId,
        projectId,
        project: { workspaceId },
      },
      include: { renders: true },
    });

    if (!clip) {
      throw new Error("clip not found");
    }

    const selectedRender = clip.renders.find(
      (render) =>
        render.aspectRatio === aspectRatioDb &&
        render.status === "completed" &&
        Boolean(render.storageKey),
    );
    if (!selectedRender) {
      throw new Error("selected clip render is required before dubbing");
    }

    const model = process.env.OPENAI_TTS_MODEL ?? DEFAULT_TTS_MODEL;
    const existing = await prisma.clipDub.findUnique({
      where: {
        clipId_targetLanguageCode_voice_aspectRatio: {
          clipId: clip.id,
          targetLanguageCode: parsed.targetLanguageCode,
          voice: parsed.voice,
          aspectRatio: aspectRatioDb,
        },
      },
    });

    const dub =
      existing && ["queued", "processing", "completed"].includes(existing.status)
        ? existing
        : existing
          ? await prisma.clipDub.update({
              where: { id: existing.id },
              data: {
                status: "queued",
                model,
                transcriptText: null,
                translatedText: null,
                audioStorageKey: null,
                renderStorageKey: null,
                audioSizeBytes: null,
                renderSizeBytes: null,
                durationSec: null,
                errorCode: null,
                startedAt: null,
                completedAt: null,
              },
            })
          : await prisma.clipDub.create({
              data: {
                projectId,
                clipId: clip.id,
                aspectRatio: aspectRatioDb,
                targetLanguageCode: parsed.targetLanguageCode,
                voice: parsed.voice,
                model,
                status: "queued",
              },
            });

    if (dub.status === "completed") {
      return {
        dub: toDubSnapshot(dub),
        workflowRunId: null,
        acceptedAt: dub.updatedAt.toISOString(),
        initialSeq: await getLastWorkflowSeq(projectId),
      };
    }

    const admitted = await getWorkflowRunLifecycle().admit({
      projectId,
      idempotencyKey,
      stage: "dubbing",
    });

    return {
      dub: toDubSnapshot(dub),
      workflowRunId: admitted.id,
      acceptedAt: new Date().toISOString(),
      initialSeq: await getLastWorkflowSeq(projectId),
    };
  }

  async getPendingDubsForProject(projectId: string) {
    const prisma = requirePrisma();
    return prisma.clipDub.findMany({
      where: { projectId, status: "queued" },
      include: {
        clip: { include: { renders: true } },
        project: {
          select: {
            id: true,
            title: true,
            languageCode: true,
            transcript: { select: { languageCode: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async markDubProcessing(dubId: string): Promise<boolean> {
    const prisma = requirePrisma();
    const attempt = currentWorkflowAttempt();
    const lifecycle = attempt ? getWorkflowRunLifecycle() : null;
    if (attempt) await lifecycle?.assertOwnership(attempt);
    else requireProtocolV1WorkflowContext("dubbing");
    const updated =
      attempt && lifecycle
        ? await lifecycle.markDubProcessing(attempt, dubId)
        : await prisma.clipDub.updateMany({
            where: { id: dubId, status: "queued" },
            data: {
              status: "processing",
              workflowAttemptId: null,
              startedAt: new Date(),
              errorCode: null,
            },
          });
    return updated.count > 0;
  }

  async completeDub(
    dubId: string,
    input: {
      transcriptText: string;
      translatedText: string;
      audioStorageKey: string;
      renderStorageKey: string;
      audioSizeBytes: number;
      renderSizeBytes: number;
      durationSec: number | null;
      model: string;
    },
  ) {
    const prisma = requirePrisma();
    const attempt = currentWorkflowAttempt();
    const lifecycle = attempt ? getWorkflowRunLifecycle() : null;
    if (attempt) {
      try {
        await lifecycle?.assertOwnership(attempt);
      } catch {
        await Promise.all([
          deleteObject(input.audioStorageKey).catch(() => {}),
          deleteObject(input.renderStorageKey).catch(() => {}),
        ]);
        throw new WorkflowAttemptLost(attempt);
      }
    } else requireProtocolV1WorkflowContext("dubbing");
    let updated: { count: number };
    try {
      const data = {
        status: "completed" as const,
        transcriptText: input.transcriptText,
        translatedText: input.translatedText,
        audioStorageKey: input.audioStorageKey,
        renderStorageKey: input.renderStorageKey,
        audioSizeBytes: BigInt(input.audioSizeBytes),
        renderSizeBytes: BigInt(input.renderSizeBytes),
        durationSec: input.durationSec,
        model: input.model,
        errorCode: null,
        completedAt: new Date(),
      };
      updated =
        attempt && lifecycle
          ? await lifecycle.completeDub(attempt, dubId, data)
          : await prisma.clipDub.updateMany({
              where: { id: dubId },
              data,
            });
    } catch (error) {
      if (!(error instanceof WorkflowAttemptLost)) throw error;
      await Promise.all([
        deleteObject(input.audioStorageKey).catch(() => {}),
        deleteObject(input.renderStorageKey).catch(() => {}),
      ]);
      throw error;
    }
    if (updated.count === 0 && attempt) {
      await Promise.all([
        deleteObject(input.audioStorageKey).catch(() => {}),
        deleteObject(input.renderStorageKey).catch(() => {}),
      ]);
      throw new WorkflowAttemptLost(attempt);
    }
    const dub = await prisma.clipDub.findUniqueOrThrow({ where: { id: dubId } });

    await analyticsService
      .recordProjectEvent({
        projectId: dub.projectId,
        clipId: dub.clipId,
        type: "dub_completed",
        metadata: {
          languageCode: dub.targetLanguageCode,
          voice: dub.voice,
          aspectRatio: aspectRatioFromDb(dub.aspectRatio),
        },
      })
      .catch((error) => {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "dub_analytics_record_failed",
            projectId: dub.projectId,
            clipId: dub.clipId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });

    return toDubSnapshot(dub);
  }

  async failDub(dubId: string, errorCode: string) {
    const prisma = requirePrisma();
    const attempt = currentWorkflowAttempt();
    const lifecycle = attempt ? getWorkflowRunLifecycle() : null;
    if (attempt) {
      try {
        await lifecycle?.assertOwnership(attempt);
      } catch {
        return;
      }
    } else requireProtocolV1WorkflowContext("dubbing");
    let updated: { count: number };
    try {
      updated =
        attempt && lifecycle
          ? await lifecycle.failDub(attempt, dubId, errorCode)
          : await prisma.clipDub.updateMany({
              where: { id: dubId },
              data: {
                status: "failed",
                errorCode,
                completedAt: new Date(),
              },
            });
    } catch (error) {
      if (error instanceof WorkflowAttemptLost) return;
      throw error;
    }
    if (updated.count === 0 && attempt) throw new WorkflowAttemptLost(attempt);
  }

  async getDubDownloadUrl(
    userId: string,
    projectId: string,
    dubId: string,
    asset: "video" | "audio" = "video",
  ): Promise<{ downloadUrl: string; expiresInSeconds: number; fileName: string }> {
    const prisma = requirePrisma();
    const dub = await prisma.clipDub.findFirst({
      where: { id: dubId, projectId, project: { userId } },
      include: { clip: true },
    });

    if (!dub) {
      throw new Error("dub not found");
    }
    if (dub.status !== "completed") {
      throw new Error("dub is not ready");
    }

    const key = asset === "audio" ? dub.audioStorageKey : dub.renderStorageKey;
    if (!key) {
      throw new Error(`${asset} asset is missing`);
    }

    const aspectRatio = aspectRatioFromDb(dub.aspectRatio);
    const extension = asset === "audio" ? "mp3" : "mp4";
    const fileName = `dub-clip-${dub.clip.index + 1}-${dub.targetLanguageCode}-${dub.voice}-${aspectRatioSlug[aspectRatio]}.${extension}`;
    const downloadUrl = await presignDownloadUrl({ key, fileName });

    await analyticsService.recordProjectEvent({
      projectId,
      clipId: dub.clipId,
      type: "dub_download_opened",
      metadata: {
        asset,
        languageCode: dub.targetLanguageCode,
        voice: dub.voice,
        aspectRatio,
      },
    });

    return {
      downloadUrl,
      expiresInSeconds: 3600,
      fileName,
    };
  }
}

export const dubbingService = new DubbingService();
