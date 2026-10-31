import { buildDubTranscriptText as buildTranscriptText, shouldTranslateDub as shouldTranslate, dubTranslationRequestBody, dubSpeechRequestBody } from "@narriflow/services/dubbing-policy";
import { downloadObjectToFile, putFileFromPath } from "../r2-file-transfer";
import { probeDubbedMediaDuration, muxDubbedVideo, } from "../../../media/src/tasks/dub-mix";
export { probeDubbedMediaDuration, muxDubbedVideo } from "../../../media/src/tasks/dub-mix";
import { submitDubTranslation, submitDubSpeech } from "../../../media/src/dubbing-provider";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  analyticsService,
  type ClaimedWorkflowAttempt,
  deleteObject,
  dubbingService,
  getWorkflowRunLifecycle,
  rethrowWorkflowAttemptLost,
  WorkflowAttemptLost,
  type WorkflowAttemptContext,
  WorkflowFailure,
  workflowFailureFromUnknown,
} from "@narriflow/services";
import {
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
} from "@narriflow/validators";
import { productionWorkerProcessModule, type WorkerProcessModule } from "../../../media/src/worker-process";

class WorkflowWorkerError extends WorkflowFailure {
  constructor(
    code: string,
    message: string,
    disposition: "retryable" | "permanent" = "retryable",
  ) {
    super(code, disposition, message);
  }
}

function log(
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({
      level,
      message,
      ts: new Date().toISOString(),
      ...context,
    }),
  );
}

function getRequiredOpenAIApiKey() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new WorkflowWorkerError(
      "openai_api_key_missing",
      "OPENAI_API_KEY is not configured",
      "permanent",
    );
  }
  return apiKey;
}

async function translateForDub(params: {
  apiKey: string;
  sourceLanguageCode: string | null;
  targetLanguageCode: string;
  script: string;
  signal: AbortSignal;
}) {
  if (!shouldTranslate(params.sourceLanguageCode, params.targetLanguageCode)) {
    return params.script;
  }

  const model =
    process.env.OPENAI_DUB_TRANSLATION_MODEL ??
    process.env.OPENAI_CONTENT_MODEL ??
    process.env.OPENAI_CLIP_MODEL ??
    "gpt-5.4-mini";
  const result = await submitDubTranslation(dubTranslationRequestBody({ ...params, translationModel: model }), { apiKey: params.apiKey, signal: params.signal });
  if (result.outcome !== "completed") throw new WorkflowWorkerError(result.outcome === "unknown" ? "dub_provider_outcome_unknown" : "dub_provider_rejected", "Dubbing provider did not confirm a result", "permanent");
  return result.text;
}

async function synthesizeSpeech(params: { apiKey: string; model: string; voice: string; input: string; outputPath: string; signal: AbortSignal }) {
  const result = await submitDubSpeech(dubSpeechRequestBody(params, params.input), params.outputPath, { apiKey: params.apiKey, signal: params.signal });
  if (result.outcome !== "completed") throw new WorkflowWorkerError(result.outcome === "unknown" ? "dub_provider_outcome_unknown" : "dub_provider_rejected", "Dubbing provider did not confirm a result", "permanent");
}

interface DubbingPersistence {
  getPendingDubs: typeof dubbingService.getPendingDubsForProject;
  lifecycle: Pick<ReturnType<typeof getWorkflowRunLifecycle>,
    "markDubProcessing" | "completeDub" | "failDub" | "completeDubbing" | "failAttempt">;
}

export async function processDubbingRun(
  attempt: ClaimedWorkflowAttempt,
  context: WorkflowAttemptContext,
  workerProcess: WorkerProcessModule = productionWorkerProcessModule,
  persistence?: DubbingPersistence,
) {
  return workerProcess.withScratchDirectory("narriflow-dub-", (tempDir) =>
    processDubbingRunInScratch(attempt, context, workerProcess, tempDir, persistence ?? {
      getPendingDubs: (projectId) => dubbingService.getPendingDubsForProject(projectId),
      lifecycle: getWorkflowRunLifecycle(),
    }),
  );
}

async function processDubbingRunInScratch(
  attempt: ClaimedWorkflowAttempt,
  context: WorkflowAttemptContext,
  workerProcess: WorkerProcessModule,
  tempDir: string,
  persistence: DubbingPersistence,
) {
  const run = { ...attempt, id: attempt.workflowRunId };
  const { signal } = context;
  const { lifecycle } = persistence;
  signal?.throwIfAborted();
  log("info", "dubbing_run_started", {
    workflowRunId: run.id,
    projectId: run.projectId,
  });

  try {
    const pendingDubs = await persistence.getPendingDubs(
      run.projectId,
    );

    if (pendingDubs.length === 0) {
      await lifecycle.completeDubbing(attempt);
      return;
    }

    let completed = 0;
    let failed = 0;
    let failedDisposition: "retryable" | "permanent" = "permanent";

    for (let index = 0; index < pendingDubs.length; index += 1) {
      signal?.throwIfAborted();
      const dub = pendingDubs[index]!;
      const claimed = await lifecycle.markDubProcessing(attempt, dub.id);
      if (claimed.count === 0) continue;

      try {
        const aspectRatioDb = clipAspectRatioDbSchema.parse(dub.aspectRatio);
        const baseRender = dub.clip.renders.find(
          (render) =>
            render.aspectRatio === aspectRatioDb &&
            render.status === "completed" &&
            Boolean(render.storageKey),
        );
        if (!baseRender?.storageKey) {
          throw new WorkflowWorkerError(
            "base_render_missing",
            "A completed rendered clip is required before dubbing",
            "permanent",
          );
        }

        const sourceLanguageCode =
          dub.project.languageCode ?? dub.project.transcript?.languageCode ?? null;
        const transcriptText = buildTranscriptText({
          transcriptSlice: dub.clip.transcriptSlice,
          hookText: dub.clip.hookText,
          payoffText: dub.clip.payoffText,
        });
        if (!transcriptText) {
          throw new WorkflowWorkerError(
            "dub_transcript_empty",
            "Clip transcript text is empty",
            "permanent",
          );
        }

        await context.reportProgress(Math.min(25, 10 + index * 5));

        const apiKey = getRequiredOpenAIApiKey();
        const translatedText = await translateForDub({
          apiKey,
          sourceLanguageCode,
          targetLanguageCode: dub.targetLanguageCode,
          script: transcriptText,
          signal,
        });

        const baseVideoPath = join(tempDir, `${dub.id}-base.mp4`);
        const audioPath = join(tempDir, `${dub.id}.mp3`);
        const outputPath = join(tempDir, `${dub.id}.mp4`);

        await downloadObjectToFile({
          key: baseRender.storageKey,
          filePath: baseVideoPath,
        });

        await context.reportProgress(45);

        await synthesizeSpeech({
          apiKey,
          model: dub.model,
          voice: dub.voice,
          input: translatedText,
          outputPath: audioPath,
          signal,
        });

        await context.reportProgress(70);

        await muxDubbedVideo({
          workerProcess,
          signal,
          videoPath: baseVideoPath,
          audioPath,
          outputPath,
        });

        const [audioStat, videoStat, durationSec] = await Promise.all([
          stat(audioPath),
          stat(outputPath),
          probeDubbedMediaDuration(workerProcess, signal, outputPath).catch(() => {
            signal.throwIfAborted();
            return null;
          }),
        ]);

        const attemptSuffix = attempt.attemptId;
        const audioStorageKey = `projects/${run.projectId}/dubs/${dub.clipId}/${dub.id}-${attemptSuffix}.mp3`;
        const renderStorageKey = `projects/${run.projectId}/dubs/${dub.clipId}/${dub.id}-${attemptSuffix}.mp4`;

        await putFileFromPath({
          key: audioStorageKey,
          filePath: audioPath,
          contentType: "audio/mpeg",
          metadata: {
            project_id: run.projectId,
            clip_id: dub.clipId,
            dub_id: dub.id,
            language_code: dub.targetLanguageCode,
            voice: dub.voice,
          },
        });
        await putFileFromPath({
          key: renderStorageKey,
          filePath: outputPath,
          contentType: "video/mp4",
          metadata: {
            project_id: run.projectId,
            clip_id: dub.clipId,
            dub_id: dub.id,
            language_code: dub.targetLanguageCode,
            voice: dub.voice,
          },
        });

        let updated: { count: number };
        try {
          updated = await lifecycle.completeDub(attempt, dub.id, {
            status: "completed",
            transcriptText,
            translatedText,
            audioStorageKey,
            renderStorageKey,
            audioSizeBytes: BigInt(audioStat.size),
            renderSizeBytes: BigInt(videoStat.size),
            durationSec,
            model: dub.model,
            errorCode: null,
            completedAt: new Date(),
          });
        } catch (error) {
          // Nothing committed: neither the dub nor its count. Remove the upload.
          await Promise.all([
            deleteObject(audioStorageKey).catch(() => {}),
            deleteObject(renderStorageKey).catch(() => {}),
          ]);
          throw error;
        }
        if (updated.count === 0) {
          await Promise.all([
            deleteObject(audioStorageKey).catch(() => {}),
            deleteObject(renderStorageKey).catch(() => {}),
          ]);
          throw new WorkflowAttemptLost(attempt);
        }

        await analyticsService
          .recordProjectEvent({
            projectId: dub.projectId,
            clipId: dub.clipId,
            type: "dub_completed",
            metadata: {
              languageCode: dub.targetLanguageCode,
              voice: dub.voice,
              aspectRatio:
                clipAspectRatioFromDb[
                  clipAspectRatioDbSchema.parse(dub.aspectRatio)
                ],
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

        completed += 1;
        log("info", "dub_completed", {
          workflowRunId: run.id,
          projectId: run.projectId,
          dubId: dub.id,
          clipId: dub.clipId,
          targetLanguageCode: dub.targetLanguageCode,
          voice: dub.voice,
          renderSizeBytes: Number(videoStat.size),
        });
      } catch (error) {
        signal.throwIfAborted();
        rethrowWorkflowAttemptLost(error);
        failed += 1;
        const failure = workflowFailureFromUnknown(error);
        const code = failure.code;
        if (failure.disposition === "retryable") {
          failedDisposition = "retryable";
        }
        const updated = await lifecycle.failDub(attempt, dub.id, code);
        if (updated.count === 0) throw new WorkflowAttemptLost(attempt);
        log("error", "dub_failed", {
          workflowRunId: run.id,
          projectId: run.projectId,
          dubId: dub.id,
          clipId: dub.clipId,
          errorCode: code,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    if (completed === 0 && failed > 0) {
      await lifecycle.failAttempt(
        attempt,
        new WorkflowFailure(
          "dubbing_failed",
          failedDisposition,
          "Every requested dub failed",
        ),
      );
      return;
    }

    await lifecycle.completeDubbing(attempt);
    log("info", "dubbing_run_completed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      completed,
      failed,
    });
  } catch (error) {
    signal.throwIfAborted();
    rethrowWorkflowAttemptLost(error);
    const failure = workflowFailureFromUnknown(error);
    const code = failure.code;
    await lifecycle.failAttempt(attempt, failure).catch((failureError) => {
      rethrowWorkflowAttemptLost(failureError);
    });
    log("error", "dubbing_run_failed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      errorCode: code,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
