import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";
import {
  downloadObjectToFile,
  putJson,
  projectService,
} from "@narriflow/services";
import { normalizeDeepgramTranscript } from "@narriflow/services";

interface WorkflowRunJob {
  id: string;
  projectId: string;
  project: {
    title: string;
    sourceStorageKey: string | null;
  };
}

class WorkflowWorkerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function sanitizeFileName(name: string) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
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

async function execCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new WorkflowWorkerError(
            "worker_command_missing",
            `${command} is not installed`,
          ),
        );
        return;
      }

      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new WorkflowWorkerError(
          "worker_command_failed",
          `${command} failed with code ${code}: ${stderr}`,
        ),
      );
    });
  });
}

function getRequiredDeepgramApiKey() {
  const apiKey = process.env.DEEPGRAM_API_KEY?.trim();

  if (!apiKey) {
    throw new WorkflowWorkerError(
      "deepgram_api_key_missing",
      "DEEPGRAM_API_KEY is not configured",
    );
  }

  return apiKey;
}

async function transcribeWithDeepgram(audioPath: string) {
  const apiKey = getRequiredDeepgramApiKey();
  const model = process.env.DEEPGRAM_MODEL?.trim() || "nova-3";
  const language = process.env.DEEPGRAM_LANGUAGE?.trim() || "en";
  const params = new URLSearchParams({
    model,
    smart_format: "true",
    diarize: "true",
    punctuate: "true",
    utterances: "true",
  });

  if (language) {
    params.set("language", language);
  }

  const response = await fetch(
    `https://api.deepgram.com/v1/listen?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/mpeg",
      },
      body: readFileSync(audioPath),
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  );

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload) {
    const message =
      payload && typeof payload === "object" && "err_msg" in payload
        ? String((payload as Record<string, unknown>).err_msg)
        : `Deepgram transcription failed with status ${response.status}`;
    throw new WorkflowWorkerError("deepgram_transcription_failed", message);
  }

  return payload;
}

async function extractTranscriptionAudio(
  inputPath: string,
  outputPath: string,
) {
  await execCommand("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    outputPath,
  ]);
}

export async function processTranscriptRun(run: WorkflowRunJob) {
  if (!run.project.sourceStorageKey) {
    throw new WorkflowWorkerError(
      "workflow_source_missing",
      "sourceStorageKey is required for transcription",
    );
  }

  log("info", "transcription_run_started", {
    workflowRunId: run.id,
    projectId: run.projectId,
  });

  const tempDir = await mkdtemp(join(tmpdir(), "narriflow-stt-"));

  try {
    const sourceExt = extname(run.project.sourceStorageKey) || ".bin";
    const sourcePath = join(tempDir, `source${sourceExt}`);
    const audioPath = join(tempDir, "transcription-input.mp3");

    await downloadObjectToFile({
      key: run.project.sourceStorageKey,
      filePath: sourcePath,
    });

    await extractTranscriptionAudio(sourcePath, audioPath);

    const deepgramPayload = await transcribeWithDeepgram(audioPath);
    const normalized = normalizeDeepgramTranscript(deepgramPayload);
    const rawStorageKey = `projects/${run.projectId}/transcripts/${Date.now()}-${sanitizeFileName(
      basename(run.project.title || "transcript"),
    )}-deepgram.json`;

    await putJson({
      key: rawStorageKey,
      value: deepgramPayload,
      metadata: {
        project_id: run.projectId,
        workflow_run_id: run.id,
        provider: "deepgram",
        model: normalized.providerModel,
      },
    });

    await projectService.completeTranscriptWorkflowRun(run.id, {
      provider: normalized.provider,
      providerModel: normalized.providerModel,
      languageCode: normalized.languageCode,
      text: normalized.text,
      utterances: normalized.utterances,
      speakerCount: normalized.speakerCount,
      durationSeconds: normalized.durationSeconds,
      rawStorageKey,
    });

    log("info", "transcription_run_completed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      utteranceCount: normalized.utterances.length,
    });
  } catch (error) {
    const code =
      error instanceof WorkflowWorkerError
        ? error.code
        : "workflow_unhandled_error";
    await projectService.failTranscriptWorkflowRun(run.id, code);
    log("error", "transcription_run_failed", {
      workflowRunId: run.id,
      projectId: run.projectId,
      code,
      message: error instanceof Error ? error.message : "Unknown worker error",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
