import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  downloadObjectToFile,
  normalizeAssemblyAiTranscript,
  putJson,
  projectService,
} from "@narriflow/services";

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

const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com";
const ASSEMBLYAI_MODEL_PREFERENCE = ["universal-3-pro", "universal-2"];
const DEFAULT_KEYTERMS_PROMPT = [
  "MrBeast",
  "Xavien",
  "Juan",
  "Fort Freezy",
  "Square",
  "Coca-Cola",
];
const DEFAULT_ASSEMBLYAI_POLL_INTERVAL_MS = 5000;
const DEFAULT_ASSEMBLYAI_POLL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

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

function getRequiredAssemblyAiApiKey() {
  const apiKey = process.env.ASSEMBLYAI_API_KEY?.trim();

  if (!apiKey) {
    throw new WorkflowWorkerError(
      "assemblyai_api_key_missing",
      "ASSEMBLYAI_API_KEY is not configured",
    );
  }

  return apiKey;
}

function getAssemblyAiPollIntervalMs() {
  const value = Number(process.env.ASSEMBLYAI_POLL_INTERVAL_MS);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_ASSEMBLYAI_POLL_INTERVAL_MS;
}

function getAssemblyAiPollTimeoutMs() {
  const value = Number(process.env.ASSEMBLYAI_POLL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_ASSEMBLYAI_POLL_TIMEOUT_MS;
}

function getAssemblyAiKeytermsPrompt(extra: string[] = []) {
  const envTerms =
    process.env.ASSEMBLYAI_KEYTERMS_PROMPT?.split(",")
      .map((term) => term.trim())
      .filter(Boolean) ?? [];

  const userTerms = extra
    .flatMap((entry) => entry.split(/[,\n]/))
    .map((term) => term.trim())
    .filter(Boolean);

  return [
    ...new Set([...DEFAULT_KEYTERMS_PROMPT, ...envTerms, ...userTerms]),
  ];
}

function getErrorCode(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return "workflow_unhandled_error";
}

async function parseJsonResponse(response: Response) {
  return response.json().catch(() => null) as Promise<unknown>;
}

function getResponseMessage(
  payload: unknown,
  fallback: string,
) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const error = record.error ?? record.message;

    if (typeof error === "string" && error.trim()) {
      return error;
    }
  }

  return fallback;
}

async function uploadAssemblyAiAudio(audioPath: string, apiKey: string) {
  const response = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/upload`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/octet-stream",
    },
    body: readFileSync(audioPath),
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const payload = await parseJsonResponse(response);

  if (!response.ok || !payload || typeof payload !== "object") {
    throw new WorkflowWorkerError(
      "assemblyai_upload_failed",
      getResponseMessage(
        payload,
        `AssemblyAI upload failed with status ${response.status}`,
      ),
    );
  }

  const uploadUrl = (payload as Record<string, unknown>).upload_url;

  if (typeof uploadUrl !== "string" || !uploadUrl) {
    throw new WorkflowWorkerError(
      "assemblyai_upload_url_missing",
      "AssemblyAI upload did not return an upload URL",
    );
  }

  return uploadUrl;
}

async function submitAssemblyAiTranscript(
  uploadUrl: string,
  apiKey: string,
  options: {
    languageCode: string | null;
    specificMoments: string;
  },
) {
  const languageBranch = options.languageCode
    ? { language_code: options.languageCode }
    : { language_detection: true };

  const userKeyterms = options.specificMoments
    ? [options.specificMoments]
    : [];

  const response = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/transcript`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: uploadUrl,
      speech_models: ASSEMBLYAI_MODEL_PREFERENCE,
      keyterms_prompt: getAssemblyAiKeytermsPrompt(userKeyterms),
      speaker_labels: true,
      ...languageBranch,
    }),
  });

  const payload = await parseJsonResponse(response);

  if (!response.ok || !payload || typeof payload !== "object") {
    throw new WorkflowWorkerError(
      "assemblyai_transcription_submit_failed",
      getResponseMessage(
        payload,
        `AssemblyAI transcription submit failed with status ${response.status}`,
      ),
    );
  }

  const transcriptId = (payload as Record<string, unknown>).id;

  if (typeof transcriptId !== "string" || !transcriptId) {
    throw new WorkflowWorkerError(
      "assemblyai_transcript_id_missing",
      "AssemblyAI transcription submit did not return a transcript id",
    );
  }

  return transcriptId;
}

async function getAssemblyAiTranscript(transcriptId: string, apiKey: string) {
  const response = await fetch(
    `${ASSEMBLYAI_BASE_URL}/v2/transcript/${transcriptId}`,
    {
      headers: {
        Authorization: apiKey,
      },
    },
  );

  const payload = await parseJsonResponse(response);

  if (!response.ok || !payload || typeof payload !== "object") {
    throw new WorkflowWorkerError(
      "assemblyai_transcription_poll_failed",
      getResponseMessage(
        payload,
        `AssemblyAI transcription poll failed with status ${response.status}`,
      ),
    );
  }

  return payload as Record<string, unknown>;
}

async function transcribeWithAssemblyAi(
  audioPath: string,
  run: WorkflowRunJob,
  options: {
    languageCode: string | null;
    specificMoments: string;
  },
) {
  const apiKey = getRequiredAssemblyAiApiKey();

  const uploadUrl = await uploadAssemblyAiAudio(audioPath, apiKey);
  await projectService.publishWorkflowProgress({
    projectId: run.projectId,
    workflowRunId: run.id,
    stage: "stt",
    status: "running",
    progress: 30,
    errorCode: null,
  });

  const transcriptId = await submitAssemblyAiTranscript(
    uploadUrl,
    apiKey,
    options,
  );
  await projectService.publishWorkflowProgress({
    projectId: run.projectId,
    workflowRunId: run.id,
    stage: "stt",
    status: "running",
    progress: 40,
    errorCode: null,
  });

  const pollIntervalMs = getAssemblyAiPollIntervalMs();
  const pollTimeoutMs = getAssemblyAiPollTimeoutMs();
  const deadline = Date.now() + pollTimeoutMs;

  while (Date.now() < deadline) {
    const payload = await getAssemblyAiTranscript(transcriptId, apiKey);
    const status = payload.status;

    if (status === "completed") {
      return payload;
    }

    if (status === "error") {
      throw new WorkflowWorkerError(
        "assemblyai_transcription_failed",
        getResponseMessage(payload, "AssemblyAI transcription failed"),
      );
    }

    const elapsedRatio = Math.min(
      1,
      (Date.now() - (deadline - pollTimeoutMs)) / pollTimeoutMs,
    );
    await projectService.publishWorkflowProgress({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "stt",
      status: "running",
      progress: Math.min(90, 40 + Math.round(elapsedRatio * 45)),
      errorCode: null,
    });

    await sleep(pollIntervalMs);
  }

  throw new WorkflowWorkerError(
    "assemblyai_transcription_timeout",
    "AssemblyAI transcription did not complete before the polling timeout",
  );
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
    await projectService.publishWorkflowProgress({
      projectId: run.projectId,
      workflowRunId: run.id,
      stage: "stt",
      status: "running",
      progress: 20,
      errorCode: null,
    });

    const [languageCode, contentPack] = await Promise.all([
      projectService.getProjectLanguageCode(run.projectId),
      projectService.getLatestContentPack(run.projectId),
    ]);

    const assemblyAiPayload = await transcribeWithAssemblyAi(audioPath, run, {
      languageCode,
      specificMoments: contentPack?.specificMoments ?? "",
    });
    const normalized = normalizeAssemblyAiTranscript(assemblyAiPayload);
    const rawStorageKey = `projects/${run.projectId}/transcripts/${run.id}-assemblyai-${sanitizeFileName(
      normalized.providerModel,
    ) || "universal-3-pro-universal-2"}.json`;

    await putJson({
      key: rawStorageKey,
      value: assemblyAiPayload,
      metadata: {
        project_id: run.projectId,
        workflow_run_id: run.id,
        provider: "assemblyai",
        model: normalized.providerModel,
        ...(normalized.providerJobId
          ? { provider_job_id: normalized.providerJobId }
          : {}),
      },
    });

    await projectService.completeTranscriptWorkflowRun(run.id, {
      provider: normalized.provider,
      providerModel: normalized.providerModel,
      providerJobId: normalized.providerJobId,
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
    const code = getErrorCode(error);
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
