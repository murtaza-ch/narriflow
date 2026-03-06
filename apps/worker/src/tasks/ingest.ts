import { mkdtemp, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { projectService } from "@narriflow/services";
import { headObject, putFileFromPath } from "@narriflow/services/r2-storage";

interface IngestJob {
  id: string;
  projectId: string;
  jobType: "upload_finalize" | "youtube_import" | "rss_import";
  payload: unknown;
}

class IngestWorkerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function log(level: "info" | "error", message: string, context?: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      level,
      message,
      ts: new Date().toISOString(),
      ...context,
    }),
  );
}

function sanitizeFileName(name: string) {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function assertObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IngestWorkerError("worker_invalid_payload", "Ingest payload must be an object");
  }

  return value as Record<string, unknown>;
}

async function execCommand(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new IngestWorkerError("worker_command_missing", `${command} is not installed`));
        return;
      }

      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new IngestWorkerError("worker_command_failed", `${command} failed with code ${code}: ${stderr}`));
    });
  });
}

async function runUploadFinalize(job: IngestJob) {
  const payload = assertObject(job.payload);
  const storageKey = String(payload.storageKey ?? "").trim();

  if (!storageKey) {
    throw new IngestWorkerError("upload_finalize_missing_key", "storageKey is required");
  }

  await projectService.markIngestJobNormalizing(job.id);
  const objectMeta = await headObject(storageKey);

  await projectService.completeIngestJob(job.id, {
    sourceStorageKey: storageKey,
    sourceMimeType: objectMeta.contentType,
    sourceSizeBytes: objectMeta.sizeBytes,
  });
}

async function runYoutubeImport(job: IngestJob) {
  const payload = assertObject(job.payload);
  const youtubeUrl = String(payload.youtubeUrl ?? "").trim();

  if (!youtubeUrl) {
    throw new IngestWorkerError("youtube_missing_url", "youtubeUrl is required");
  }

  await projectService.markIngestJobDownloading(job.id);

  const tempDir = await mkdtemp(join(tmpdir(), "narriflow-youtube-"));

  try {
    const metadataOutput = await execCommand("yt-dlp", ["--dump-single-json", "--no-warnings", youtubeUrl]);
    const metadata = JSON.parse(metadataOutput.stdout) as {
      title?: string;
      id?: string;
      duration?: number;
      ext?: string;
    };

    const outputTemplate = join(tempDir, "%(id)s.%(ext)s");
    const downloadOutput = await execCommand("yt-dlp", [
      "--no-warnings",
      "--merge-output-format",
      "mp4",
      "--print",
      "after_move:filepath",
      "-o",
      outputTemplate,
      youtubeUrl,
    ]);

    const lines = downloadOutput.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const downloadedPath = lines.at(-1);

    if (!downloadedPath) {
      throw new IngestWorkerError("youtube_download_missing_file", "yt-dlp did not return a downloaded file path");
    }

    await projectService.markIngestJobNormalizing(job.id);

    const fileInfo = await stat(downloadedPath);
    const extension = extname(downloadedPath) || ".mp4";
    const baseName = sanitizeFileName(metadata.title ?? basename(downloadedPath, extension));
    const key = `projects/${job.projectId}/youtube/${Date.now()}-${baseName}${extension}`;

    await putFileFromPath({
      key,
      filePath: downloadedPath,
      contentType: "video/mp4",
      metadata: {
        source: "youtube",
        source_url: youtubeUrl,
        source_id: metadata.id ?? "unknown",
      },
    });

    await projectService.completeIngestJob(job.id, {
      sourceStorageKey: key,
      sourceInput: youtubeUrl,
      sourceMimeType: "video/mp4",
      sourceSizeBytes: fileInfo.size,
      sourceDurationSeconds:
        typeof metadata.duration === "number" && Number.isFinite(metadata.duration)
          ? Math.round(metadata.duration)
          : null,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function downloadToFile(url: string, targetPath: string) {
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new IngestWorkerError("rss_download_failed", `Failed to download enclosure (${response.status})`);
  }

  const fileStream = createWriteStream(targetPath);
  await pipeline(
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
    fileStream,
  );

  return {
    contentType: response.headers.get("content-type"),
  };
}

async function runRssImport(job: IngestJob) {
  const payload = assertObject(job.payload);
  const episode = assertObject(payload.episode);
  const enclosureUrl = String(episode.enclosureUrl ?? "").trim();
  const rssUrl = String(payload.rssUrl ?? "").trim();
  const episodeTitle = String(episode.title ?? "RSS Episode").trim();

  if (!enclosureUrl) {
    throw new IngestWorkerError("rss_missing_enclosure", "episode enclosure URL is required");
  }

  await projectService.markIngestJobDownloading(job.id);

  const tempDir = await mkdtemp(join(tmpdir(), "narriflow-rss-"));

  try {
    const enclosureExt = extname(new URL(enclosureUrl).pathname) || ".mp3";
    const tempFile = join(tempDir, `source${enclosureExt}`);
    const downloadMeta = await downloadToFile(enclosureUrl, tempFile);

    await projectService.markIngestJobNormalizing(job.id);

    const fileInfo = await stat(tempFile);
    const key = `projects/${job.projectId}/rss/${Date.now()}-${sanitizeFileName(episodeTitle)}${enclosureExt}`;

    await putFileFromPath({
      key,
      filePath: tempFile,
      contentType: downloadMeta.contentType ?? "audio/mpeg",
      metadata: {
        source: "rss",
        rss_url: rssUrl,
        enclosure_url: enclosureUrl,
      },
    });

    await projectService.completeIngestJob(job.id, {
      sourceStorageKey: key,
      sourceInput: rssUrl,
      sourceMimeType: downloadMeta.contentType ?? "audio/mpeg",
      sourceSizeBytes: fileInfo.size,
      sourceDurationSeconds:
        typeof episode.durationSeconds === "number" ? Math.round(episode.durationSeconds) : null,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function processIngestJob(job: IngestJob) {
  log("info", "ingest_job_started", {
    jobId: job.id,
    projectId: job.projectId,
    jobType: job.jobType,
  });

  try {
    if (job.jobType === "upload_finalize") {
      await runUploadFinalize(job);
    } else if (job.jobType === "youtube_import") {
      await runYoutubeImport(job);
    } else if (job.jobType === "rss_import") {
      await runRssImport(job);
    } else {
      throw new IngestWorkerError("worker_unknown_job_type", `Unsupported ingest job type: ${job.jobType}`);
    }

    log("info", "ingest_job_completed", {
      jobId: job.id,
      projectId: job.projectId,
      jobType: job.jobType,
    });
  } catch (error) {
    const code = error instanceof IngestWorkerError ? error.code : "worker_unhandled_error";
    const message = error instanceof Error ? error.message : "Unknown worker error";

    await projectService.failIngestJob(job.id, code, message);
    log("error", "ingest_job_failed", {
      jobId: job.id,
      projectId: job.projectId,
      jobType: job.jobType,
      code,
      message,
    });
  }
}
