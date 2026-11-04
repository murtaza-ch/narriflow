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
  planLimits,
  requestClipDubSchema,
  workspaceAllowsCapability,
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
import { buildDubTranscriptText, frozenDubbingRequestHash } from "./dubbing-policy";
import { frozenDubbingRequestSchema } from "@narriflow/validators/dubbing-execution";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";
import { requirePrisma } from "./require-prisma";

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
  dubbing_outcome_unknown: "conflict",
  dub_transcript_empty: "unprocessable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type DubbingFailureCode = keyof typeof dubbingFailureCatalog;

export class DubbingFailureError extends ExpectedDomainFailureError<DubbingFailureCode> {
  constructor(code: DubbingFailureCode, message: string) {
    super({ code, kind: dubbingFailureCatalog[code], message });
    this.name = "DubbingFailureError";
  }
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

    const tuple = { clipId: clip.id, targetLanguageCode: parsed.targetLanguageCode, voice: parsed.voice, aspectRatio: aspectRatioDb };
    const activeTuple = { ...tuple, status: { in: ["queued", "processing", "completed", "unknown"] as Array<ClipDub["status"]> } };
    const replay = async (dub: ClipDub, workflowRunId: string | null) => ({
      dub: toDubSnapshot(dub),
      workflowRunId,
      acceptedAt: dub.updatedAt.toISOString(),
      initialSeq: await getLastWorkflowSeq(projectId),
    });

    // An accepted dub replays without another count: completed returns its
    // output, a live one returns the run that owns it.
    const existing = await prisma.clipDub.findFirst({ where: activeTuple });
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

    const environment = readServiceEnvironment();
    const model = environment.OPENAI_TTS_MODEL ?? DEFAULT_TTS_MODEL;
    const translationModel = environment.OPENAI_DUB_TRANSLATION_MODEL ?? environment.OPENAI_CONTENT_MODEL ?? environment.OPENAI_CLIP_MODEL ?? "gpt-5.4-mini";
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
          const current = await tx.clipDub.findFirst({ where: activeTuple });
          if (current?.status === "unknown") throw new DubbingFailureError("dubbing_outcome_unknown", "Dubbing outcome needs review. This request will not be repeated automatically.");
          if (current) {
            if (current.workflowRunId !== run.id) throw new DubbingFailureError("dubbing_in_progress", "Another accepted dubbing request owns this clip and voice.");
            return current;
          }
          if (!run.created) throw new DubbingFailureError("dubbing_idempotency_conflict", "This request key already identifies a different dubbing request.");
          const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: scope.workspaceId }, select: { status: true, ownerUserId: true, pricingTier: true } });
          const membership = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: scope.workspaceId, userId: scope.actorUserId } }, select: { role: true } });
          const owner = workspace.ownerUserId === scope.actorUserId;
          const currentActor = await tx.user.findUnique({ where: { id: scope.actorUserId }, select: { deletedAt: true } });
          if (!currentActor || currentActor.deletedAt || !owner && !membership || !workspaceAllowsCapability({ role: owner ? "owner" : membership!.role, status: workspace.status }, "processing.consume")) throw new DubbingFailureError("clip_not_found", "Clip not found.");
          requirePlanFeature(workspace.pricingTier, "dubbing");
          const source = await tx.clip.findFirst({ where: { id: clip.id, projectId, project: { workspaceId: scope.workspaceId, ...accessibleProjectWhere() } },
            include: { renders: true, project: { include: { transcript: { select: { languageCode: true } } } } } });
          const render = source?.renders.find(render => render.aspectRatio === aspectRatioDb && render.status === "completed" && render.storageKey && render.sizeBytes && render.sizeBytes > 0n && render.sizeBytes <= 10n * 1024n ** 3n);
          if (!source || !render?.storageKey || !render.sizeBytes) throw new DubbingFailureError("dubbing_render_required", "Render the selected clip before dubbing.");
          const document = decodeClipEditorDocumentFromStorage(source, { durationSec: clipSourceEdgeSec(source.project), wholeSource: source.wholeSource });
          const seconds = render.durationSec ?? document.clipEndSec - document.clipStartSec;
          if (seconds > planLimits(workspace.pricingTier).dubs.maxClipSeconds) throw new DubbingFailureError("dubbing_clip_too_long", "The rendered clip is too long for dubbing.");
          const script = buildDubTranscriptText({ transcriptSlice: document.transcriptSlice, hookText: source.hookText, payoffText: source.payoffText });
          if (!script) throw new DubbingFailureError("dub_transcript_empty", "The clip has no transcript text to dub.");
          const id = randomUUID();
          const request = frozenDubbingRequestSchema.parse({ version: 1, kind: "dubbing_request", dubId: id, workflowRunId: run.id,
            projectId, workspaceId: scope.workspaceId, actorUserId: scope.actorUserId, clipId: source.id, editorRevision: source.editorRevision, sourceRevision: source.project.sourceRevision,
            baseRender: { id: render.id, storageKey: render.storageKey, byteLength: Number(render.sizeBytes), durationSec: seconds }, script,
            sourceLanguageCode: source.project.languageCode ?? source.project.transcript?.languageCode ?? null,
            targetLanguageCode: parsed.targetLanguageCode, voice: parsed.voice, aspectRatio: parsed.aspectRatio, provider: "openai", model, translationModel });
          const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
          if (!clock) throw Error("dubbing_clock_unavailable");
          const acceptedRun = await tx.workflowRun.findUniqueOrThrow({ where: { id: run.id }, select: { deploymentEpoch: true } });
          const dub = await tx.clipDub.create({ data: { id, projectId, clipId: source.id, aspectRatio: aspectRatioDb, targetLanguageCode: parsed.targetLanguageCode, voice: parsed.voice,
            model, status: "queued", workflowRunId: run.id, frozenRequest: request, requestHash: await frozenDubbingRequestHash(request), createdAt: clock.now, operationDeadlineAt: new Date(clock.now.getTime() + 45 * 60_000), deploymentEpoch: acceptedRun.deploymentEpoch } });
          await reserveGenerationUsage(tx, { kind: "dub", jobId: dub.id, workspaceId: scope.workspaceId, actorUserId: scope.actorUserId,
            pricingTier: workspace.pricingTier, now: clock.now, attached: true });
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
