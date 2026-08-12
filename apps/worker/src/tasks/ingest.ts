import { mkdtemp, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  assertPublicHttpUrl,
  assertResponseContentLength,
  createByteLimitTransform,
  guardedFetch,
  projectService,
  redactUrlForDisplay,
  RemoteFetchError,
  UnsafeUrlError,
} from "@narriflow/services";
import {
  headObject,
  InvalidObjectMetadataError,
  presignDownloadUrl,
  putFileFromPath,
} from "@narriflow/services/r2-storage";
import {
  detectLinkProvider,
  LINK_PROVIDERS,
  MAX_MEDIA_DURATION_SECONDS,
  MAX_UPLOAD_SIZE_BYTES,
  type LinkProviderId,
} from "@narriflow/validators";
import { notifyIngestFailureAfterSettlement } from "../notifications";

const MEDIA_DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const METADATA_PROBE_TIMEOUT_MS = 120 * 1000;
const LINK_DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1000;

// The render pipeline never outputs above 1080p, so pulling a 4K source (seen
// in production at 531MB-1.1GB for a single video) wastes import time, R2
// storage, and forces the studio to decode 4K for playback. Cap height at
// 1080p; within that cap, prefer an mp4(h264) + m4a(AAC) pair, since muxing
// those two into the `--merge-output-format mp4` container below is a plain
// stream copy, whereas e.g. a webm(vp9)+webm(opus) pair would force yt-dlp to
// transcode to satisfy the mp4 output. Each `/`-separated tier is a fallback
// for when the previous tier's exact combination isn't available, ending in
// plain `best` so a source that only exposes unusual formats (or is already
// below 1080p) still downloads exactly as it did before this cap existed.
const YTDLP_FORMAT_SELECTOR =
  "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";

// DASH/HLS sources (YouTube in particular) download fragment-by-fragment;
// yt-dlp fetches them sequentially unless told otherwise, which routinely
// leaves most of the available bandwidth idle. Parallel fragments only affect
// fragmented formats — plain single-file downloads ignore the flag.
function getYtdlpConcurrentFragments(): number {
  const value = Number(process.env.YTDLP_CONCURRENT_FRAGMENTS);
  if (!Number.isFinite(value) || value < 1) return 4;
  return Math.min(Math.round(value), 16);
}

interface IngestJob {
  id: string;
  projectId: string;
  jobType: "upload_finalize" | "youtube_import" | "rss_import" | "link_import";
  payload: unknown;
  attemptCount: number;
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

const COMMAND_KILL_GRACE_MS = 5000;

async function execCommand(
  command: string,
  args: string[],
  options?: { timeoutMs?: number; acceptableExitCodes?: readonly number[] },
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    if (options?.timeoutMs) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, COMMAND_KILL_GRACE_MS);
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimers();
      if (error.code === "ENOENT") {
        reject(new IngestWorkerError("worker_command_missing", `${command} is not installed`));
        return;
      }

      reject(error);
    });

    child.on("close", (code) => {
      clearTimers();

      if (timedOut) {
        reject(
          new IngestWorkerError(
            "worker_command_timeout",
            `${command} timed out after ${options?.timeoutMs}ms`,
          ),
        );
        return;
      }

      const acceptableExitCodes = options?.acceptableExitCodes ?? [0];
      if (code !== null && acceptableExitCodes.includes(code)) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new IngestWorkerError("worker_command_failed", `${command} failed with code ${code}: ${stderr}`));
    });
  });
}

// attemptCount is tracked at the job level (packages/db) but nothing here
// ever retried within a single attempt — verified in production: a Google
// Drive import died on "The socket connection was closed unexpectedly" with
// attemptCount: 1 and no retry. Bounded retry with backoff for transient
// failures (socket resets, 429s, 5xx) around the external calls in this
// file; permanent failures (bad/unsupported input, timeouts, missing
// commands) still fail fast rather than being retried.
const INGEST_RETRY_MAX_ATTEMPTS = 3;
const INGEST_RETRY_BASE_DELAY_MS = 2000;
const TRANSIENT_ERROR_PATTERN =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ERR_STREAM_PREMATURE_CLOSE|UND_ERR_SOCKET|connection reset|connection refused|premature close|socket connection was closed|socket hang up|network error|fetch failed|temporarily unavailable|service unavailable|gateway timeout|too many requests|\b429\b|\b50[0-4]\b/i;
const PERMANENT_INGEST_ERROR_CODES = new Set([
  "ingest_max_duration_exceeded",
  "remote_media_too_large",
  "remote_media_invalid_content_type",
  "remote_url_unsafe",
  "remote_fetch_timeout",
  "link_unsupported_source",
  "link_missing_url",
  "link_download_missing_file",
  "rss_missing_enclosure",
  "media_duration_unavailable",
  "worker_command_missing",
  "worker_command_timeout",
  "worker_invalid_payload",
]);

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRetryableIngestError(error: unknown): boolean {
  // guardedFetch (packages/services/src/url-guard.ts) collapses every
  // non-timeout raw fetch failure — including socket resets — into this one
  // generic code, discarding the original error. It's deliberately ambiguous
  // (could be a dead host as easily as a blip), but treating it as retryable
  // is the only way to catch the transient case at all here; a genuinely
  // dead URL just costs a few bounded extra attempts before failing the same
  // way it would have anyway.
  if (error instanceof RemoteFetchError) {
    return error.code === "remote_download_failed";
  }
  if (error instanceof IngestWorkerError) {
    if (PERMANENT_INGEST_ERROR_CODES.has(error.code)) return false;
    return TRANSIENT_ERROR_PATTERN.test(error.message);
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && TRANSIENT_ERROR_PATTERN.test(code)) return true;
    return TRANSIENT_ERROR_PATTERN.test(error.message);
  }
  return false;
}

/** ±20% jitter so concurrent workers don't retry in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

async function waitBeforeIngestRetry(
  label: string,
  attempt: number,
  maxRetries: number,
  error: unknown,
) {
  const delayMs = jitter(INGEST_RETRY_BASE_DELAY_MS * 2 ** attempt);
  log("info", "ingest_transient_retry", {
    label,
    attempt: attempt + 1,
    maxRetries,
    delayMs,
    message: error instanceof Error ? error.message : String(error),
  });
  await sleep(delayMs);
}

/** Bounded retry with jittered exponential backoff for the transient
 *  failures (socket resets, 429s, 5xx) seen from yt-dlp. A permanently-bad
 *  input (unsupported source, oversized file, unsafe URL, ...) is rethrown
 *  immediately so it still fails fast. */
async function withTransientRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options?: { maxRetries?: number },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? INGEST_RETRY_MAX_ATTEMPTS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableIngestError(error)) {
        throw error;
      }
      await waitBeforeIngestRetry(label, attempt, maxRetries, error);
    }
  }
}

async function runUploadFinalize(job: IngestJob) {
  const payload = assertObject(job.payload);
  const storageKey = String(payload.storageKey ?? "").trim();

  if (!storageKey) {
    throw new IngestWorkerError("upload_finalize_missing_key", "storageKey is required");
  }

  await projectService.markIngestJobNormalizing(job.id);
  const objectMeta = await headObject(storageKey);

  // ffprobe reads the header over range requests, so a presigned URL avoids
  // downloading the whole file here while still using the stored object as the
  // authoritative source.
  let probedDuration: number | null = null;
  try {
    const url = await presignDownloadUrl({ key: storageKey });
    probedDuration = await probeDurationSeconds(url);
  } catch {
    probedDuration = null;
  }
  const durationSeconds = requireDuration(probedDuration);

  await projectService.completeIngestJob(job.id, {
    sourceStorageKey: storageKey,
    sourceMimeType: objectMeta.contentType,
    sourceSizeBytes: objectMeta.sizeBytes,
    sourceDurationSeconds: durationSeconds,
  });
}

async function probeDurationSeconds(input: string): Promise<number | null> {
  try {
    const { stdout } = await execCommand("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      input,
    ]);
    const data = JSON.parse(stdout) as { format?: { duration?: string } };
    const dur = data.format?.duration ? Number(data.format.duration) : NaN;
    return normalizeDuration(dur);
  } catch {
    return null;
  }
}

function normalizeDuration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : null;
}

function requireDuration(value: unknown): number {
  const duration = normalizeDuration(value);
  if (duration === null) {
    throw new IngestWorkerError(
      "media_duration_unavailable",
      "We couldn't verify the media duration. Check the file and try again.",
    );
  }
  return duration;
}

/** Normalizes a Dropbox share link (both legacy /s/... and /scl/fi/... forms)
 *  into a direct-download link by forcing the `dl=1` query param. */
export function normalizeDropboxDownloadUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("dl", "1");
  return url.toString();
}

async function runLinkImport(job: IngestJob) {
  const payload = assertObject(job.payload);
  // Legacy in-flight youtube_import jobs carry `youtubeUrl`; link_import jobs
  // carry `url` + `provider`.
  const rawUrl = String(
    (job.jobType === "youtube_import" ? payload.youtubeUrl : payload.url) ?? "",
  ).trim();

  if (!rawUrl) {
    throw new IngestWorkerError("link_missing_url", "A video link is required.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = assertPublicHttpUrl(rawUrl);
  } catch {
    throw new IngestWorkerError(
      "link_unsupported_source",
      "We couldn't recognize that link. Supported: YouTube, Google Drive, StreamYard, Loom, Twitch, X, TikTok, LinkedIn, Facebook, Vimeo, Dropbox.",
    );
  }

  const provider: LinkProviderId | null =
    job.jobType === "youtube_import"
      ? "youtube"
      : detectLinkProvider(parsedUrl.toString());

  if (!provider) {
    throw new IngestWorkerError(
      "link_unsupported_source",
      "We couldn't recognize that link. Supported: YouTube, Google Drive, StreamYard, Loom, Twitch, X, TikTok, LinkedIn, Facebook, Vimeo, Dropbox.",
    );
  }

  const providerDef = LINK_PROVIDERS.find((def) => def.id === provider);
  if (!providerDef) {
    throw new IngestWorkerError(
      "link_unsupported_source",
      "We couldn't recognize that link. Supported: YouTube, Google Drive, StreamYard, Loom, Twitch, X, TikTok, LinkedIn, Facebook, Vimeo, Dropbox.",
    );
  }

  await projectService.markIngestJobDownloading(job.id);

  if (providerDef.strategy === "direct") {
    await runDirectLinkDownload(job, rawUrl, provider);
    return;
  }

  await runYtdlpLinkDownload(job, rawUrl, provider);
}

/** yt-dlp-backed providers: YouTube, Google Drive, StreamYard, Loom, Twitch,
 *  X, TikTok, LinkedIn, Facebook, Vimeo. */
async function runYtdlpLinkDownload(
  job: IngestJob,
  url: string,
  provider: LinkProviderId,
) {
  const tempDir = await mkdtemp(join(tmpdir(), "narriflow-link-"));

  try {
    const probeStartedAtMs = Date.now();
    const metadataOutput = await withTransientRetry("yt_dlp_metadata_probe", () =>
      execCommand(
        "yt-dlp",
        ["--dump-single-json", "--no-warnings", "--no-playlist", url],
        { timeoutMs: METADATA_PROBE_TIMEOUT_MS },
      ),
    );
    const metadata = JSON.parse(metadataOutput.stdout) as {
      title?: string;
      id?: string;
      duration?: number;
      ext?: string;
    };

    const metadataDuration = normalizeDuration(metadata.duration);
    if (metadataDuration && metadataDuration > MAX_MEDIA_DURATION_SECONDS) {
      throw new IngestWorkerError(
        "ingest_max_duration_exceeded",
        "This video is longer than your plan allows.",
      );
    }

    const probeMs = Date.now() - probeStartedAtMs;
    const downloadStartedAtMs = Date.now();
    const outputTemplate = join(tempDir, "%(id)s.%(ext)s");
    // --max-downloads 1 makes yt-dlp exit 101 once the limit stops any extra
    // downloads it would otherwise attempt; that's success as long as the
    // first file landed, so 101 is an acceptable exit code alongside 0.
    // yt-dlp resumes/overwrites the same deterministic output path cleanly on
    // retry, so re-running the whole command on a transient failure is safe.
    const downloadOutput = await withTransientRetry("yt_dlp_download", () =>
      execCommand(
        "yt-dlp",
        [
          "--no-warnings",
          "--no-playlist",
          "--max-downloads",
          "1",
          "--max-filesize",
          String(MAX_UPLOAD_SIZE_BYTES),
          "--concurrent-fragments",
          String(getYtdlpConcurrentFragments()),
          "--format",
          YTDLP_FORMAT_SELECTOR,
          "--merge-output-format",
          "mp4",
          "--print",
          "after_move:filepath",
          "-o",
          outputTemplate,
          url,
        ],
        { timeoutMs: LINK_DOWNLOAD_TIMEOUT_MS, acceptableExitCodes: [0, 101] },
      ),
    );

    const lines = downloadOutput.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const downloadedPath = lines.at(-1);

    if (!downloadedPath) {
      throw new IngestWorkerError("link_download_missing_file", "yt-dlp did not return a downloaded file path");
    }

    await projectService.markIngestJobNormalizing(job.id);

    const fileInfo = await stat(downloadedPath);
    if (fileInfo.size > MAX_UPLOAD_SIZE_BYTES) {
      throw new IngestWorkerError(
        "remote_media_too_large",
        "The downloaded media is too large to process.",
      );
    }

    const durationSeconds = requireDuration(
      metadataDuration ?? (await probeDurationSeconds(downloadedPath)),
    );
    if (durationSeconds > MAX_MEDIA_DURATION_SECONDS) {
      throw new IngestWorkerError(
        "ingest_max_duration_exceeded",
        "This video is longer than your plan allows.",
      );
    }

    const downloadMs = Date.now() - downloadStartedAtMs;

    const extension = extname(downloadedPath) || ".mp4";
    const baseName =
      sanitizeFileName(metadata.title ?? basename(downloadedPath, extension)) || "source";
    const key = `projects/${job.projectId}/link/${Date.now()}-${baseName}${extension}`;

    const uploadStartedAtMs = Date.now();
    await putFileFromPath({
      key,
      filePath: downloadedPath,
      contentType: "video/mp4",
      metadata: {
        source: provider,
        source_url: url,
        source_id: metadata.id ?? "unknown",
      },
    });

    // The three network legs of a link import, separated so telemetry can say
    // which one actually dominates (source download vs the R2 upload leg).
    log("info", "ingest_link_import_timing", {
      jobId: job.id,
      projectId: job.projectId,
      provider,
      probeMs,
      downloadMs,
      uploadMs: Date.now() - uploadStartedAtMs,
      sizeBytes: fileInfo.size,
      durationSeconds,
    });

    await projectService.completeIngestJob(job.id, {
      sourceStorageKey: key,
      sourceInput: url,
      sourceMimeType: "video/mp4",
      sourceSizeBytes: fileInfo.size,
      sourceDurationSeconds: durationSeconds,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Direct-download providers: Dropbox. */
async function runDirectLinkDownload(
  job: IngestJob,
  url: string,
  provider: LinkProviderId,
) {
  const tempDir = await mkdtemp(join(tmpdir(), "narriflow-link-"));

  try {
    const downloadUrl =
      provider === "dropbox" ? normalizeDropboxDownloadUrl(url) : url;

    let urlPath: string;
    try {
      urlPath = assertPublicHttpUrl(downloadUrl).pathname;
    } catch (error) {
      throw mapRemoteDownloadError(error);
    }
    const ext = extname(urlPath) || ".mp4";
    const tempFile = join(tempDir, `source${ext}`);
    // downloadToFile retries transient failures internally (it needs the raw
    // pre-mapping error/status to classify retryability correctly).
    const downloadMeta = await downloadToFile(downloadUrl, tempFile);

    await projectService.markIngestJobNormalizing(job.id);

    const fileInfo = await stat(tempFile);
    const durationSeconds = requireDuration(await probeDurationSeconds(tempFile));
    if (durationSeconds > MAX_MEDIA_DURATION_SECONDS) {
      throw new IngestWorkerError(
        "ingest_max_duration_exceeded",
        "This video is longer than your plan allows.",
      );
    }

    const baseName = sanitizeFileName(basename(urlPath, ext) || "source");
    const key = `projects/${job.projectId}/link/${Date.now()}-${baseName}${ext}`;

    await putFileFromPath({
      key,
      filePath: tempFile,
      contentType: downloadMeta.contentType ?? "application/octet-stream",
      metadata: {
        source: provider,
        source_url: url,
      },
    });

    await projectService.completeIngestJob(job.id, {
      sourceStorageKey: key,
      sourceInput: url,
      sourceMimeType: downloadMeta.contentType,
      sourceSizeBytes: fileInfo.size,
      sourceDurationSeconds: durationSeconds,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function downloadToFile(url: string, targetPath: string) {
  const maxRetries = INGEST_RETRY_MAX_ATTEMPTS;

  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt >= maxRetries;
    let response: Response | undefined;

    try {
      response = await guardedFetch(url, {
        headers: {
          accept: "audio/*, video/*, application/octet-stream;q=0.8",
          "user-agent": "NarriflowBot/1.0 (+https://narriflow.app)",
        },
        timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
      });
    } catch (error) {
      if (!isLastAttempt && isRetryableIngestError(error)) {
        await waitBeforeIngestRetry("direct_media_fetch", attempt, maxRetries, error);
        continue;
      }
      throw mapRemoteDownloadError(error);
    }

    try {
      if (!response.ok || !response.body) {
        if (!isLastAttempt && isRetryableStatus(response.status)) {
          await waitBeforeIngestRetry(
            "direct_media_status",
            attempt,
            maxRetries,
            new Error(`upstream responded with status ${response.status}`),
          );
          continue;
        }
        throw new IngestWorkerError(
          "remote_media_download_failed",
          "We couldn't download that media. Check the link and try again.",
        );
      }

      assertResponseContentLength(response, MAX_UPLOAD_SIZE_BYTES);

      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (
        !contentType ||
        (!contentType.startsWith("audio/") &&
          !contentType.startsWith("video/") &&
          contentType !== "application/octet-stream")
      ) {
        throw new IngestWorkerError(
          "remote_media_invalid_content_type",
          "That link didn't return a supported audio or video file.",
        );
      }

      const fileStream = createWriteStream(targetPath);
      await pipeline(
        Readable.fromWeb(
          response.body as unknown as import("node:stream/web").ReadableStream,
        ),
        createByteLimitTransform(MAX_UPLOAD_SIZE_BYTES),
        fileStream,
      );

      return { contentType };
    } catch (error) {
      // A definitive classification (size limit, bad content-type, ...) is
      // never retried. Anything else gets one more transient-failure check
      // against the raw error before it's mapped to a friendly message.
      if (
        !(error instanceof IngestWorkerError) &&
        !isLastAttempt &&
        isRetryableIngestError(error)
      ) {
        await waitBeforeIngestRetry("direct_media_stream", attempt, maxRetries, error);
        continue;
      }
      if (error instanceof IngestWorkerError) {
        throw error;
      }
      throw mapRemoteDownloadError(error);
    } finally {
      if (response?.body && !response.body.locked) {
        await response.body.cancel().catch(() => undefined);
      }
    }
  }
}

function mapRemoteDownloadError(error: unknown) {
  if (error instanceof IngestWorkerError) {
    return error;
  }
  if (error instanceof UnsafeUrlError) {
    return new IngestWorkerError(
      "remote_url_unsafe",
      "That media link isn't safe to download. Choose another source.",
    );
  }
  if (error instanceof RemoteFetchError) {
    if (error.code === "remote_fetch_timeout") {
      return new IngestWorkerError(
        "remote_fetch_timeout",
        "The media download timed out. Try again or choose another source.",
      );
    }
    if (error.code === "remote_response_too_large") {
      return new IngestWorkerError(
        "remote_media_too_large",
        "The downloaded media is too large to process.",
      );
    }
    if (
      error.code === "remote_redirect_invalid" ||
      error.code === "remote_redirect_limit"
    ) {
      return new IngestWorkerError(
        "remote_url_unsafe",
        "That media link isn't safe to download. Choose another source.",
      );
    }
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new IngestWorkerError(
      "remote_fetch_timeout",
      "The media download timed out. Try again or choose another source.",
    );
  }
  return new IngestWorkerError(
    "remote_media_download_failed",
    "We couldn't download that media. Check the link and try again.",
  );
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
    let enclosurePath: string;
    try {
      enclosurePath = assertPublicHttpUrl(enclosureUrl).pathname;
    } catch (error) {
      throw mapRemoteDownloadError(error);
    }
    const enclosureExt = extname(enclosurePath) || ".mp3";
    const tempFile = join(tempDir, `source${enclosureExt}`);
    const downloadMeta = await downloadToFile(enclosureUrl, tempFile);

    await projectService.markIngestJobNormalizing(job.id);

    const fileInfo = await stat(tempFile);
    const durationSeconds = requireDuration(
      await probeDurationSeconds(tempFile),
    );
    const key = `projects/${job.projectId}/rss/${Date.now()}-${sanitizeFileName(episodeTitle)}${enclosureExt}`;

    await putFileFromPath({
      key,
      filePath: tempFile,
      contentType: downloadMeta.contentType ?? "audio/mpeg",
      metadata: {
        source: "rss",
        rss_url: redactUrlForDisplay(rssUrl),
        enclosure_url: redactUrlForDisplay(enclosureUrl),
      },
    });

    await projectService.completeIngestJob(job.id, {
      sourceStorageKey: key,
      sourceInput: redactUrlForDisplay(rssUrl),
      sourceMimeType: downloadMeta.contentType,
      sourceSizeBytes: fileInfo.size,
      sourceDurationSeconds: durationSeconds,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function processIngestJob(job: IngestJob) {
  const jobStartedAtMs = Date.now();
  log("info", "ingest_job_started", {
    jobId: job.id,
    projectId: job.projectId,
    jobType: job.jobType,
  });

  try {
    if (job.jobType === "upload_finalize") {
      await runUploadFinalize(job);
    } else if (job.jobType === "link_import" || job.jobType === "youtube_import") {
      // youtube_import is kept only to drain legacy in-flight jobs enqueued
      // before the link_import migration; runLinkImport maps its payload.
      await runLinkImport(job);
    } else if (job.jobType === "rss_import") {
      await runRssImport(job);
    } else {
      throw new IngestWorkerError("worker_unknown_job_type", `Unsupported ingest job type: ${job.jobType}`);
    }

    log("info", "ingest_job_completed", {
      jobId: job.id,
      projectId: job.projectId,
      jobType: job.jobType,
      totalMs: Date.now() - jobStartedAtMs,
    });
  } catch (error) {
    const normalizedError =
      error instanceof InvalidObjectMetadataError
        ? new IngestWorkerError(
            "storage_metadata_invalid",
            "Internal object metadata was invalid",
          )
        : error;
    const code =
      normalizedError instanceof IngestWorkerError
        ? normalizedError.code
        : "worker_unhandled_error";
    const message =
      normalizedError instanceof Error
        ? normalizedError.message
        : "Unknown worker error";

    await projectService.failIngestJob(job.id, code, message);
    log("error", "ingest_job_failed", {
      jobId: job.id,
      projectId: job.projectId,
      jobType: job.jobType,
      code,
      message,
    });
    await notifyIngestFailureAfterSettlement({
      jobId: job.id,
      projectId: job.projectId,
      attemptCount: job.attemptCount,
      errorCode: code,
      reason: message,
    });
  }
}
