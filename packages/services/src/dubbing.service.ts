import { readServiceEnvironment } from "./runtime-environment";
import { collectExistingWorkflowRunDispatch } from "./workflow-dispatch";
import { accessibleProjectWhere } from "./project-access";
import type { ActorScope } from "./actor-scope";
import type { ClipDub } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
  clipAspectRatioToDb,
  clipSourceEdgeSec,
  planDubSegments,
  planLimits,
  requestClipDubSchema,
  workspaceAllowsCapability,
  type ClipAspectRatio,
  resolvePricingTier,
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
import { frozenDubbingRequestHash } from "./dubbing-policy";
import { frozenDubbingRequestSchema } from "@narriflow/validators/dubbing-execution";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";
import { requirePrisma } from "./require-prisma";
import { OPENAI_TEXT_MODEL } from "./openai-models";
import { requireExecutionAdmissionOpen } from "./execution-admission";
import {
  admitDubExportWithinTransaction,
  assertClipExportDocumentAllowed,
  clipExportService,
  ClipExportError,
} from "./clip-export.service";
import { dubVideoState, type DubVideoSource } from "./dubbing-policy";

const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const LIVE_DUB: readonly string[] = ["queued", "processing"];
const LIVE_RUN = ["queued", "running", "waiting"] as const;

const dubbingFailureCatalog = {
  clip_not_found: "missing",
  dub_asset_missing: "missing",
  dub_clip_superseded: "conflict",
  dub_not_found: "missing",
  dub_not_ready: "conflict",
  dubbing_censor_unsupported: "unprocessable",
  dubbing_clip_too_long: "unprocessable",
  dubbing_idempotency_conflict: "conflict",
  dubbing_idempotency_key_required: "invalid",
  dubbing_in_progress: "conflict",
  dubbing_outcome_unknown: "conflict",
  dub_transcript_empty: "unprocessable",
  dub_transcript_untimed_cut: "unprocessable",
  dub_transcript_too_long: "unprocessable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type DubbingFailureCode = keyof typeof dubbingFailureCatalog;

export class DubbingFailureError extends ExpectedDomainFailureError<DubbingFailureCode> {
  constructor(code: DubbingFailureCode, message: string) {
    super({ code, kind: dubbingFailureCatalog[code], message });
    this.name = "DubbingFailureError";
  }
}


const planRefusalMessage = {
  dub_transcript_empty: "The clip has no transcript text to dub.",
  dub_transcript_untimed_cut: "A cut falls inside a transcript line that has no word timing, so the clip cannot be dubbed.",
  dub_transcript_too_long: "The clip has too many sentences to dub.",
} as const satisfies Record<"dub_transcript_empty" | "dub_transcript_untimed_cut" | "dub_transcript_too_long", string>;

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
  audioSizeBytes: bigint | number | null;
  durationSec: number | null;
  errorCode: string | null;
  completedAt: Date | null;
  createdAt: Date;
} & DubVideoSource): ClipDubSnapshot {
  const video = dubVideoState(row);
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
    hasVideoAsset: video.storageKey !== null,
    video: video.video,
    audioSizeBytes: bigintToNumber(row.audioSizeBytes),
    renderSizeBytes: bigintToNumber(video.sizeBytes),
    durationSec: row.durationSec,
    errorCode: row.errorCode,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The dub's video export, as far as its video state and file go. */
const dubVideoInclude = {
  export: {
    select: {
      id: true,
      status: true,
      errorCode: true,
      variants: { select: { status: true, storageKey: true, sizeBytes: true, errorCode: true }, orderBy: { createdAt: "asc" as const }, take: 1 },
    },
  },
};

type ClipDubWithVideo = ClipDub & { export: DubVideoSource["export"] };

export class DubbingService {
  async listProjectDubs(
    scope: ActorScope,
    projectId: string,
  ): Promise<ClipDubSnapshot[]> {
    const prisma = requirePrisma();
    await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "content.view");
    const rows = await prisma.clipDub.findMany({
      where: { projectId, project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() } },
      include: dubVideoInclude,
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
    });

    if (!clip) {
      throw new DubbingFailureError("clip_not_found", "Clip not found.");
    }

    // A dub belongs to one editor revision: an edited clip is a new dub.
    const tuple = { clipId: clip.id, targetLanguageCode: parsed.targetLanguageCode, voice: parsed.voice, aspectRatio: aspectRatioDb };
    const activeStatus = { in: ["queued", "processing", "completed", "unknown"] as Array<ClipDub["status"]> };
    const activeTuple = { ...tuple, editorRevision: clip.editorRevision, status: activeStatus };
    const replay = async (dub: ClipDubWithVideo, workflowRunId: string | null) => ({
      dub: toDubSnapshot(dub),
      workflowRunId,
      acceptedAt: dub.updatedAt.toISOString(),
      initialSeq: await getLastWorkflowSeq(projectId),
    });

    // An accepted dub replays without another count: completed returns its
    // output, a live one returns the run that owns it.
    const existing = await prisma.clipDub.findFirst({ where: activeTuple, include: dubVideoInclude });
    if (existing?.status === "unknown") throw new DubbingFailureError("dubbing_outcome_unknown", "Dubbing outcome needs review. This request will not be repeated automatically.");
    if (existing?.status === "completed") return replay(existing, null);
    if (existing && LIVE_DUB.includes(existing.status)) {
      if (!existing.workflowRunId) throw new DubbingFailureError("dubbing_in_progress", "The accepted dubbing request is being reconciled.");
      const run = await prisma.workflowRun.findFirst({
        where: { id: existing.workflowRunId, projectId, stage: "dubbing", status: { in: [...LIVE_RUN] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (run) {
        await prisma.$transaction(tx => collectExistingWorkflowRunDispatch(tx, run.id));
        return replay(existing, run.id);
      }
      throw new DubbingFailureError("dubbing_in_progress", "The accepted dubbing request is being reconciled.");
    }


    const environment = readServiceEnvironment();
    const model = environment.OPENAI_TTS_MODEL ?? DEFAULT_TTS_MODEL;
    const translationModel = environment.OPENAI_DUB_TRANSLATION_MODEL ?? environment.OPENAI_CONTENT_MODEL ?? environment.OPENAI_CLIP_MODEL ?? OPENAI_TEXT_MODEL;
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
          // The same request again: whatever the clip's revision is now, it keeps its dub.
          const own = await tx.clipDub.findFirst({ where: { workflowRunId: run.id }, include: dubVideoInclude });
          if (own) return own;
          if (!run.created) throw new DubbingFailureError("dubbing_idempotency_conflict", "This request key already identifies a different dubbing request.");
          const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: scope.workspaceId }, select: { status: true, ownerUserId: true, pricingTier: true } });
          const membership = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: scope.workspaceId, userId: scope.actorUserId } }, select: { role: true } });
          const owner = workspace.ownerUserId === scope.actorUserId;
          const currentActor = await tx.user.findUnique({ where: { id: scope.actorUserId }, select: { deletedAt: true } });
          if (!currentActor || currentActor.deletedAt || !owner && !membership || !workspaceAllowsCapability({ role: owner ? "owner" : membership!.role, status: workspace.status }, "processing.consume")) throw new DubbingFailureError("clip_not_found", "Clip not found.");
          requirePlanFeature(workspace.pricingTier, "dubbing");
          const source = await tx.clip.findFirst({ where: { id: clip.id, projectId, project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() } },
            include: { project: { include: { transcript: { select: { languageCode: true } } } } } });
          if (!source) throw new DubbingFailureError("clip_not_found", "Clip not found.");
          // The identity lookup is for the revision this transaction sees, which may be newer than the one read above.
          const current = await tx.clipDub.findFirst({ where: { ...tuple, editorRevision: source.editorRevision, status: activeStatus } });
          if (current?.status === "unknown") throw new DubbingFailureError("dubbing_outcome_unknown", "Dubbing outcome needs review. This request will not be repeated automatically.");
          if (current) throw new DubbingFailureError("dubbing_in_progress", "Another accepted dubbing request owns this clip and voice.");
          const document = decodeClipEditorDocumentFromStorage(source, { durationSec: clipSourceEdgeSec(source.project), wholeSource: source.wholeSource });
          // Translated words have no source word ids, so there is nothing to mask or beep.
          if (document.censorSegments.some((segment) => segment.enabled)) throw new DubbingFailureError("dubbing_censor_unsupported", "Dubbing is not available for clips with Auto Censor edits.");
          // The dub's video is an export of this document: refuse before paid work what the export would refuse.
          assertClipExportDocumentAllowed(resolvePricingTier(workspace.pricingTier), document);
          const plan = planDubSegments(document);
          if (plan.kind === "refused") throw new DubbingFailureError(plan.code, planRefusalMessage[plan.code]);
          const seconds = plan.editedDurationSec + document.sceneBlocks.reduce((sum, block) => sum + block.durationSec, 0);
          if (seconds > planLimits(workspace.pricingTier).dubs.maxClipSeconds) throw new DubbingFailureError("dubbing_clip_too_long", "The clip is too long for dubbing.");
          const id = randomUUID();
          const request = frozenDubbingRequestSchema.parse({ version: 1, kind: "dubbing_request", dubId: id, workflowRunId: run.id,
            projectId, workspaceId: scope.workspaceId, actorUserId: scope.actorUserId, clipId: source.id, editorRevision: source.editorRevision, sourceRevision: source.project.sourceRevision,
            segments: plan.segments, editedDurationSec: plan.editedDurationSec,
            sourceLanguageCode: source.project.languageCode ?? source.project.transcript?.languageCode ?? null,
            targetLanguageCode: parsed.targetLanguageCode, voice: parsed.voice, aspectRatio: parsed.aspectRatio, provider: "openai", model, translationModel });
          const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
          if (!clock) throw Error("dubbing_clock_unavailable");
          const acceptedRun = await tx.workflowRun.findUniqueOrThrow({ where: { id: run.id }, select: { deploymentEpoch: true } });
          const dub = await tx.clipDub.create({ data: { id, projectId, clipId: source.id, aspectRatio: aspectRatioDb, targetLanguageCode: parsed.targetLanguageCode, voice: parsed.voice,
            model, editorRevision: source.editorRevision, status: "queued", transcriptText: plan.segments.map(segment => segment.text).join(" "), workflowRunId: run.id, frozenRequest: request, requestHash: await frozenDubbingRequestHash(request), createdAt: clock.now, operationDeadlineAt: new Date(clock.now.getTime() + 45 * 60_000), deploymentEpoch: acceptedRun.deploymentEpoch } });
          await reserveGenerationUsage(tx, { kind: "dub", jobId: dub.id, workspaceId: scope.workspaceId, actorUserId: scope.actorUserId,
            pricingTier: workspace.pricingTier, now: clock.now, attached: true });
          return { ...dub, export: null };
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

  /**
   * Starts the dub's video again: queues its failed export for another render,
   * or creates the export when the dub has none (its admission was refused at
   * completion). A video that is rendering or ready is returned as it is.
   */
  async renderDubVideo(scope: ActorScope, projectId: string, dubId: string): Promise<ClipDubSnapshot> {
    const prisma = requirePrisma();
    const actor = await workspaceService.requireActor(scope.actorUserId, scope.workspaceId, "processing.consume");
    requirePlanFeature(actor.pricingTier, "dubbing");
    const load = () => prisma.clipDub.findFirst({
      where: { id: dubId, projectId, project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() } },
      include: dubVideoInclude,
    });
    const dub = await load();
    if (!dub) throw new DubbingFailureError("dub_not_found", "Dub not found.");
    if (dub.status !== "completed") throw new DubbingFailureError("dub_not_ready", "The dub is not ready.");
    const { video } = dubVideoState(dub);
    if (video.status === "rendering" || video.status === "ready") return toDubSnapshot(dub);
    if (dub.export) {
      await clipExportService.retryDubExport(scope, projectId, dub.clipId, dub.export.id);
    } else {
      try {
        await prisma.$transaction(async (tx) => {
          await requireExecutionAdmissionOpen(tx);
          await admitDubExportWithinTransaction(tx, {
            dubId: dub.id,
            projectId,
            workspaceId: scope.workspaceId,
            actorUserId: scope.actorUserId,
            clipId: dub.clipId,
            aspectRatio: aspectRatioFromDb(dub.aspectRatio),
            editorRevision: dub.editorRevision,
          });
        });
      } catch (error) {
        if (error instanceof ClipExportError && error.code === "editor_revision_conflict") {
          throw new DubbingFailureError("dub_clip_superseded", "The clip was edited after this dub was made. Dub the new version.");
        }
        throw error;
      }
    }
    const updated = await load();
    if (!updated) throw new DubbingFailureError("dub_not_found", "Dub not found.");
    return toDubSnapshot(updated);
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
      include: { clip: true, ...dubVideoInclude },
    });

    if (!dub) {
      throw new DubbingFailureError("dub_not_found", "Dub not found.");
    }
    if (dub.status !== "completed") {
      throw new DubbingFailureError("dub_not_ready", "The dub is not ready.");
    }

    // The video is the dub export's file, ready only once its render finished.
    const key = asset === "audio" ? dub.audioStorageKey : dubVideoState(dub).storageKey;
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
