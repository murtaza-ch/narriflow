import { spawn } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadObjectToFile,
  dubbingService,
  projectService,
  putFileFromPath,
  rethrowWorkflowAttemptLost,
  WorkflowFailure,
  workflowFailureFromUnknown,
  workflowHttpFailureDisposition,
} from "@narriflow/services";
import {
  clipAspectRatioDbSchema,
  transcriptUtteranceSchema,
  type TranscriptUtterance,
} from "@narriflow/validators";

interface WorkflowRunJob {
  id: string;
  projectId: string;
  attemptId?: string | null;
  project: {
    title: string;
  };
}

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

function extractResponseText(response: unknown): string | null {
  const payload = response as {
    output_text?: unknown;
    output?: Array<{
      content?: Array<{
        text?: unknown;
      }>;
    }>;
  };

  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const textParts =
    payload.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text)
      .filter((text): text is string => typeof text === "string") ?? [];

  return textParts.length > 0 ? textParts.join("") : null;
}

function languageRoot(code: string | null | undefined) {
  return code?.split("-")[0]?.toLowerCase() ?? null;
}

function shouldTranslate(sourceCode: string | null, targetCode: string) {
  const source = languageRoot(sourceCode);
  const target = languageRoot(targetCode);
  return Boolean(target && source !== target);
}

function targetLanguageLabel(code: string) {
  const labels: Record<string, string> = {
    ar: "Arabic",
    de: "German",
    en: "English",
    es: "Spanish",
    fr: "French",
    hi: "Hindi",
    it: "Italian",
    ja: "Japanese",
    ko: "Korean",
    nl: "Dutch",
    pt: "Portuguese",
    tr: "Turkish",
    ur: "Urdu",
    zh: "Chinese",
  };
  return labels[languageRoot(code) ?? ""] ?? code;
}

function buildTranscriptText(input: {
  transcriptSlice: unknown;
  hookText: string;
  payoffText: string | null;
}) {
  const parsed = transcriptUtteranceSchema
    .array()
    .safeParse(input.transcriptSlice);
  const utterances: TranscriptUtterance[] = parsed.success ? parsed.data : [];
  const text = utterances
    .map((utterance) => utterance.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (text) return text;

  return [input.hookText, input.payoffText]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function callOpenAIText(params: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      input: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
    }),
  });

  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  if (!response.ok || !payload) {
    throw new WorkflowWorkerError(
      "openai_request_failed",
      payload?.error?.message ??
        `OpenAI request failed with status ${response.status}`,
      workflowHttpFailureDisposition(response.status),
    );
  }

  const text = extractResponseText(payload)?.trim();
  if (!text) {
    throw new WorkflowWorkerError(
      "openai_request_failed",
      "OpenAI returned an empty translation",
    );
  }

  return text;
}

async function translateForDub(params: {
  apiKey: string;
  sourceLanguageCode: string | null;
  targetLanguageCode: string;
  script: string;
}) {
  if (!shouldTranslate(params.sourceLanguageCode, params.targetLanguageCode)) {
    return params.script;
  }

  const model =
    process.env.OPENAI_DUB_TRANSLATION_MODEL ??
    process.env.OPENAI_CONTENT_MODEL ??
    process.env.OPENAI_CLIP_MODEL ??
    "gpt-5.4-mini";
  const target = targetLanguageLabel(params.targetLanguageCode);
  return callOpenAIText({
    apiKey: params.apiKey,
    model,
    systemPrompt:
      "Translate creator video transcripts for natural voiceover dubbing. Preserve meaning, names, numbers, and tone. Return only the translated script with no markdown or commentary.",
    userPrompt: `Source language: ${params.sourceLanguageCode ?? "auto"}
Target language: ${target} (${params.targetLanguageCode})

SCRIPT:
${params.script}`,
  });
}

async function synthesizeSpeech(params: {
  apiKey: string;
  model: string;
  voice: string;
  input: string;
  outputPath: string;
}) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      voice: params.voice,
      input: params.input,
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new WorkflowWorkerError(
      "openai_tts_failed",
      `OpenAI speech request failed with status ${response.status}: ${body.slice(0, 300)}`,
      workflowHttpFailureDisposition(response.status),
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new WorkflowWorkerError("openai_tts_failed", "OpenAI returned empty audio");
  }

  await writeFile(params.outputPath, buffer);
}

async function execCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new WorkflowWorkerError(
              "worker_command_missing",
              `${command} is not installed`,
              "permanent",
            )
          : error,
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new WorkflowWorkerError(
          "worker_command_failed",
          `${command} failed with code ${code}: ${stderr.slice(-500)}`,
        ),
      );
    });
  });
}

async function execCommandOutput(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new WorkflowWorkerError(
              "worker_command_missing",
              `${command} is not installed`,
              "permanent",
            )
          : error,
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new WorkflowWorkerError(
          "worker_command_failed",
          `${command} failed with code ${code}: ${stderr.slice(-500)}`,
        ),
      );
    });
  });
}

async function probeDurationSec(filePath: string): Promise<number | null> {
  const output = await execCommandOutput("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const value = Number(output.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function muxDubbedVideo(params: {
  videoPath: string;
  audioPath: string;
  outputPath: string;
}) {
  await execCommand("ffmpeg", [
    "-y",
    "-i",
    params.videoPath,
    "-i",
    params.audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-shortest",
    "-movflags",
    "+faststart",
    params.outputPath,
  ]);
}

export async function processDubbingRun(
  run: WorkflowRunJob,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  log("info", "dubbing_run_started", {
    workflowRunId: run.id,
    projectId: run.projectId,
  });

  const tempDir = await mkdtemp(join(tmpdir(), "narriflow-dub-"));

  try {
    const apiKey = getRequiredOpenAIApiKey();
    const pendingDubs = await dubbingService.getPendingDubsForProject(
      run.projectId,
    );

    if (pendingDubs.length === 0) {
      await projectService.completeDubbingWorkflowRun(run.id);
      return;
    }

    let completed = 0;
    let failed = 0;
    let failedDisposition: "retryable" | "permanent" = "permanent";

    for (let index = 0; index < pendingDubs.length; index += 1) {
      signal?.throwIfAborted();
      const dub = pendingDubs[index]!;
      const claimed = await dubbingService.markDubProcessing(dub.id);
      if (!claimed) continue;

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

        await projectService.publishWorkflowProgress({
          projectId: run.projectId,
          workflowRunId: run.id,
          stage: "dubbing",
          status: "running",
          progress: Math.min(25, 10 + index * 5),
          errorCode: null,
        });

        const translatedText = await translateForDub({
          apiKey,
          sourceLanguageCode,
          targetLanguageCode: dub.targetLanguageCode,
          script: transcriptText,
        });

        const baseVideoPath = join(tempDir, `${dub.id}-base.mp4`);
        const audioPath = join(tempDir, `${dub.id}.mp3`);
        const outputPath = join(tempDir, `${dub.id}.mp4`);

        await downloadObjectToFile({
          key: baseRender.storageKey,
          filePath: baseVideoPath,
        });

        await projectService.publishWorkflowProgress({
          projectId: run.projectId,
          workflowRunId: run.id,
          stage: "dubbing",
          status: "running",
          progress: 45,
          errorCode: null,
        });

        await synthesizeSpeech({
          apiKey,
          model: dub.model,
          voice: dub.voice,
          input: translatedText,
          outputPath: audioPath,
        });

        await projectService.publishWorkflowProgress({
          projectId: run.projectId,
          workflowRunId: run.id,
          stage: "dubbing",
          status: "running",
          progress: 70,
          errorCode: null,
        });

        await muxDubbedVideo({
          videoPath: baseVideoPath,
          audioPath,
          outputPath,
        });

        const [audioStat, videoStat, durationSec] = await Promise.all([
          stat(audioPath),
          stat(outputPath),
          probeDurationSec(outputPath).catch(() => null),
        ]);

        const attemptSuffix = run.attemptId ?? "legacy";
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

        await dubbingService.completeDub(dub.id, {
          transcriptText,
          translatedText,
          audioStorageKey,
          renderStorageKey,
          audioSizeBytes: Number(audioStat.size),
          renderSizeBytes: Number(videoStat.size),
          durationSec,
          model: dub.model,
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
        rethrowWorkflowAttemptLost(error);
        failed += 1;
        const failure = workflowFailureFromUnknown(error);
        const code = failure.code;
        if (failure.disposition === "retryable") {
          failedDisposition = "retryable";
        }
        await dubbingService.failDub(dub.id, code).catch(() => {});
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
      await projectService.failDubbingWorkflowRun(
        run.id,
        new WorkflowFailure(
          "dubbing_failed",
          failedDisposition,
          "Every requested dub failed",
        ),
      );
      return;
    }

    await projectService.completeDubbingWorkflowRun(run.id);
    log("info", "dubbing_run_completed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      completed,
      failed,
    });
  } catch (error) {
    rethrowWorkflowAttemptLost(error);
    const failure = workflowFailureFromUnknown(error);
    const code = failure.code;
    await projectService
      .failDubbingWorkflowRun(run.id, failure)
      .catch(() => {});
    log("error", "dubbing_run_failed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      errorCode: code,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
