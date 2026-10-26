import { accessibleProjectWhere } from "./project-access";
import type { ActorScope } from "./actor-scope";
import type { ClipDub } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
  clipAspectRatioToDb,
  clipSourceEdgeSec,
  planLimits,
  requestClipDubSchema,
  type ClipAspectRatio,
  type ClipDubSnapshot,
  type RequestClipDubInput,
} from "@narriflow/validators";
import { requirePlanFeature } from "./plan-features";
import {
  reserveGenerationUsage,
  summarizeGenerationUsage,
  type DubUsageSummary,
} from "./generated-media-usage-ledger";
import { analyticsService } from "./analytics.service";
import { presignDownloadUrl } from "./r2-storage";
import { getLastWorkflowSeq } from "./workflow.service";
import { workspaceService } from "./workspace.service";
import {
  getWorkflowRunLifecycle,
} from "./workflow-run-lifecycle";
import { decodeClipEditorDocumentFromStorage } from "./clip-editor-document-persistence";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const LIVE_DUB: readonly string[] = ["queued", "processing"];
const LIVE_RUN = ["queued", "running", "waiting"] as const;

const dubbingFailureCatalog = {
  clip_not_found: "missing",
  dub_asset_missing: "missing",
  dub_not_found: "missing",
  dub_not_ready: "conflict",
  dubbing_clip_too_long: "unprocessable",
  dubbing_idempotency_conflict: "conflict",
  dubbing_idempotency_key_required: "invalid",
  dubbing_in_progress: "conflict",
  dubbing_render_required: "unprocessable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type DubbingFailureCode = keyof typeof dubbingFailureCatalog;

export class DubbingFailureError extends ExpectedDomainFailureError<DubbingFailureCode> {
  constructor(code: DubbingFailureCode, message: string) {
    super({ code, kind: dubbingFailureCatalog[code], message });
    this.name = "DubbingFailureError";
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
    scope: ActorScope,
    projectId: string,
  ): Promise<ClipDubSnapshot[]> {
    const prisma = requirePrisma();
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    const rows = await prisma.clipDub.findMany({
      where: { projectId, project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() } },
      orderBy: [{ createdAt: "desc" }],
    });
    return rows.map(toDubSnapshot);
  }

  async requestClipDub(
    scope: ActorScope,
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
      throw new DubbingFailureError(
        "dubbing_idempotency_key_required",
        "An idempotency key is required.",
      );
    }

    const prisma = requirePrisma();
    const actor = await workspaceService.requireActor(
      scope.actorUserId,
      scope.workspaceId,
      "processing.consume",
    );
    requirePlanFeature(actor.pricingTier, "dubbing");

    const parsed = requestClipDubSchema.parse(input);
    const aspectRatioDb = clipAspectRatioToDb[parsed.aspectRatio];

    const clip = await prisma.clip.findFirst({
      where: {
        id: parsed.clipId,
        projectId,
        project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() },
      },
      include: { renders: true },
    });

    if (!clip) {
      throw new DubbingFailureError("clip_not_found", "Clip not found.");
    }

    const selectedRender = clip.renders.find(
      (render) =>
        render.aspectRatio === aspectRatioDb &&
        render.status === "completed" &&
        Boolean(render.storageKey),
    );
    if (!selectedRender) {
      throw new DubbingFailureError(
        "dubbing_render_required",
        "Render the selected clip before dubbing.",
      );
    }
    const maxClipSeconds = planLimits(actor.pricingTier).dubs.maxClipSeconds;
    const clipSeconds = selectedRender.durationSec ?? clip.endSec - clip.startSec;
    if (clipSeconds > maxClipSeconds) {
      throw new DubbingFailureError(
        "dubbing_clip_too_long",
        `Dubbing supports clips up to ${Math.floor(maxClipSeconds / 60)} minutes.`,
      );
    }

    const tuple = {
      clipId_targetLanguageCode_voice_aspectRatio: {
        clipId: clip.id,
        targetLanguageCode: parsed.targetLanguageCode,
        voice: parsed.voice,
        aspectRatio: aspectRatioDb,
      },
    };
    const replay = async (dub: ClipDub, workflowRunId: string | null) => ({
      dub: toDubSnapshot(dub),
      workflowRunId,
      acceptedAt: dub.updatedAt.toISOString(),
      initialSeq: await getLastWorkflowSeq(projectId),
    });

    // An accepted dub replays without another count: completed returns its
    // output, a live one returns the run that owns it.
    const existing = await prisma.clipDub.findUnique({ where: tuple });
    if (existing?.status === "completed") return replay(existing, null);
    if (existing && LIVE_DUB.includes(existing.status)) {
      const run = await prisma.workflowRun.findFirst({
        where: { projectId, stage: "dubbing", status: { in: [...LIVE_RUN] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (run) return replay(existing, run.id);
      // A queued dub with no live run is re-admitted below with its count.
    }

    const model = process.env.OPENAI_TTS_MODEL ?? DEFAULT_TTS_MODEL;
    let admitted;
    try {
      // The dub row, its count, and the Workflow Run commit together.
      admitted = await getWorkflowRunLifecycle().admitWithHandoff(
        { projectId, idempotencyKey, stage: "dubbing" },
        async (tx, run) => {
          if (!run.created) {
            const live = await tx.workflowRun.findFirst({
              where: { id: run.id, status: { in: [...LIVE_RUN] } },
              select: { id: true },
            });
            if (!live) {
              throw new DubbingFailureError(
                "dubbing_idempotency_conflict",
                "This request key was already used. Send a new one.",
              );
            }
          }
          const current = await tx.clipDub.findUnique({ where: tuple });
          if (current && (current.status === "completed" || LIVE_DUB.includes(current.status))) {
            return current;
          }
          const dub = current
            ? await tx.clipDub.update({
                where: { id: current.id },
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
                  workflowAttemptId: null,
                  startedAt: null,
                  completedAt: null,
                },
              })
            : await tx.clipDub.create({
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
          // A failed dub's re-request is a new request: it is counted again
          // in the current UTC month.
          await reserveGenerationUsage(tx, {
            kind: "dub",
            jobId: dub.id,
            workspaceId: scope.workspaceId,
            actorUserId: scope.actorUserId,
            pricingTier: actor.pricingTier,
            now: new Date(),
            attached: true,
            readmit: Boolean(current),
          });
          return dub;
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message === "workflow_stage_admission_busy") {
        throw new DubbingFailureError(
          "dubbing_in_progress",
          "Another dub for this project is still processing. Try again when it finishes.",
        );
      }
      throw error;
    }

    return {
      dub: toDubSnapshot(admitted.handoff),
      workflowRunId: admitted.id,
      acceptedAt: new Date().toISOString(),
      initialSeq: await getLastWorkflowSeq(projectId),
    };
  }

  /** The Workspace's dubbing entitlement and monthly count, for the Dubbing panel. */
  async getDubbingAllowance(scope: ActorScope): Promise<DubUsageSummary> {
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    return (await summarizeGenerationUsage(scope.workspaceId)).dubs;
  }

  async getPendingDubsForProject(projectId: string) {
    const prisma = requirePrisma();
    const dubs = await prisma.clipDub.findMany({
      where: { projectId, status: "queued" },
      include: {
        clip: { include: { renders: true } },
        project: {
          select: {
            id: true,
            title: true,
            languageCode: true,
            sourceDurationSeconds: true,
            sourceProbe: true,
            transcript: { select: { languageCode: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    return dubs.map((dub) => {
      const document = decodeClipEditorDocumentFromStorage(dub.clip, {
        durationSec: clipSourceEdgeSec(dub.project),
        wholeSource: dub.clip.wholeSource,
      });
      return {
        ...dub,
        clip: {
          ...dub.clip,
          startSec: document.clipStartSec,
          endSec: document.clipEndSec,
          captionPreset: document.captionPreset,
          transcriptSlice: document.transcriptSlice,
          studioEdits: document.studioEdits,
          brollUrl: document.brollUrl,
          deletedRanges: document.deletedRanges,
        },
      };
    });
  }

  async getDubDownloadUrl(
    scope: ActorScope,
    projectId: string,
    dubId: string,
    asset: "video" | "audio" = "video",
  ): Promise<{ downloadUrl: string; expiresInSeconds: number; fileName: string }> {
    const prisma = requirePrisma();
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.download");
    const dub = await prisma.clipDub.findFirst({
      where: { id: dubId, projectId, project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() } },
      include: { clip: true },
    });

    if (!dub) {
      throw new DubbingFailureError("dub_not_found", "Dub not found.");
    }
    if (dub.status !== "completed") {
      throw new DubbingFailureError("dub_not_ready", "The dub is not ready.");
    }

    const key = asset === "audio" ? dub.audioStorageKey : dub.renderStorageKey;
    if (!key) {
      throw new DubbingFailureError(
        "dub_asset_missing",
        `The ${asset} asset is missing.`,
      );
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
