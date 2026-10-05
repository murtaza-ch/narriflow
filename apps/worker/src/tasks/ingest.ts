import { stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
  assertPublicHttpUrl,
  assertResponseContentLength,
  createByteLimitTransform,
  guardedFetch,
  getIngestJobLifecycle,
  IngestJobClaimLost,
  type IngestJobLifecycle,
  redactUrlForDisplay,
  RemoteFetchError,
  UnsafeUrlError,
  WorkflowFailure,
} from "@narriflow/services";
import {
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
import { youtubeProxyRotates, ytdlpCommonArgs } from "../youtube-import";
import {
  productionWorkerProcessModule,
  WorkerProcessFailure,
  type WorkerProcessModule,
} from "../worker-process";

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
  jobType: "upload_finalize" | "rss_import" | "link_import";
  payload: unknown;
  attemptCount: number;
  claimId: string;
}

interface IngestRuntime {
  lifecycle: Pick<IngestJobLifecycle, "progress" | "complete" | "fail">;
  putSource: typeof putFileFromPath;
}

class IngestWorkerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function classifyYtdlpProviderFailure(
  stderr: string,
): { code: string; message: string } | null {
  if (/sign in to confirm you(?:['’]re| are) not a bot/i.test(stderr)) {
    return {
      code: "source_provider_access_denied",
      message: "YouTube blocked this import. Upload the video file instead.",
    };
  }
  if (/HTTP Error 403\b|HTTP 403\b|403 Forbidden/i.test(stderr)) {
    return {
      code: "source_provider_access_denied",
      message:
        "The video provider refused the download. Upload the video file instead.",
    };
  }

  return null;
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

async function execCommand(
  workerProcess: WorkerProcessModule,
  signal: AbortSignal,
  command: string,
  args: string[],
  options: { timeoutMs: number; acceptableExitCodes?: readonly number[] },
) {
  const result = await workerProcess.execute({
    command,
    args,
    signal,
    deadlineMs: options.timeoutMs,
    acceptableExitCodes: options.acceptableExitCodes,
    captureStdout: true,
  });
  return { stdout: result.stdout.toString("utf8") };
}

export async function executeYtdlpCommand(
  workerProcess: WorkerProcessModule,
  signal: AbortSignal,
  args: string[],
  options: { timeoutMs: number; acceptableExitCodes?: readonly number[] },
) {
  try {
    return await execCommand(workerProcess, signal, process.env.YTDLP_EXECUTABLE || "yt-dlp", args, options);
  } catch (error) {
    const classified = classifyYtdlpProviderFailure(
      error instanceof WorkerProcessFailure
        ? error.diagnostic
        : error instanceof Error
          ? error.message
          : String(error),
    );
    if (classified) {
      throw new IngestWorkerError(classified.code, classified.message);
    }
    throw error;
  }
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
  "source_provider_access_denied",
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

// A rotating residential pool can hand out an exit IP that YouTube already
// flagged, so a block there is retried on a fresh session. A direct
// connection or a fixed proxy would only meet the same block again.
const YOUTUBE_PROXY_SESSIONS_PER_IMPORT = 3;

/** yt-dlp arguments for one import, rotating the proxy session after a block. */
function ytdlpSessions(job: IngestJob, provider: LinkProviderId) {
  let args = ytdlpCommonArgs(provider);
  let remaining = provider === "youtube" && youtubeProxyRotates()
    ? YOUTUBE_PROXY_SESSIONS_PER_IMPORT - 1
    : 0;
  return {
    args: () => args,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      for (;;) {
        try {
          return await fn();
        } catch (error) {
          if (
            remaining <= 0
            || !(error instanceof IngestWorkerError && error.code === "source_provider_access_denied")
          ) throw error;
          remaining--;
          args = ytdlpCommonArgs(provider);
          log("info", "youtube_proxy_session_rotated", {
            jobId: job.id,
            projectId: job.projectId,
            remaining,
          });
        }
      }
    },
  };
}

async function runUploadFinalize(
  job: IngestJob,
  workerProcess: WorkerProcessModule,
  signal: AbortSignal,
  runtime: IngestRuntime,
) {
  const verified = readVerifiedUploadPayload(job.payload);

  await runtime.lifecycle.progress(job, "normalizing");

  // ffprobe reads the header over range requests, so a presigned URL avoids
  // downloading the whole file here while still using the stored object as the
  // authoritative source.
  let probedDuration: number | null = null;
  try {
    const url = await presignDownloadUrl({ key: verified.storageKey });
    probedDuration = await probeDurationSeconds(workerProcess, signal, url);
  } catch {
    probedDuration = null;
  }
  const durationSeconds = requireDuration(probedDuration);

  await runtime.lifecycle.complete(job, {
    sourceStorageKey: verified.storageKey,
    sourceMimeType: verified.contentType,
    sourceSizeBytes: verified.sizeBytes,
    sourceDurationSeconds: durationSeconds,
  });
}

export function readVerifiedUploadPayload(payload: unknown): {
  storageKey: string;
  sizeBytes: number;
  contentType: string;
} {
  const value = assertObject(payload);
  const storageKey = String(value.storageKey ?? "").trim();
  const sizeBytes = Number(value.verifiedSizeBytes);
  const contentType = String(value.verifiedContentType ?? "").trim();

  if (!storageKey) {
    throw new IngestWorkerError(
      "upload_finalize_missing_key",
      "storageKey is required",
    );
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new IngestWorkerError(
      "upload_finalize_missing_verified_size",
      "verifiedSizeBytes must be a positive safe integer",
    );
  }
  if (!contentType) {
    throw new IngestWorkerError(
      "upload_finalize_missing_verified_content_type",
      "verifiedContentType is required",
    );
  }

  return { storageKey, sizeBytes, contentType };
}

async function probeDurationSeconds(
  workerProcess: WorkerProcessModule,
  signal: AbortSignal,
  input: string,
): Promise<number | null> {
  try {
    return normalizeDuration(
      (
        await workerProcess.inspectMedia({
          sourcePath: input,
          signal,
          deadlineMs: METADATA_PROBE_TIMEOUT_MS,
        })
      ).durationSec,
    );
  } catch {
    signal.throwIfAborted();
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

async function runLinkImport(
  job: IngestJob,
  workerProcess: WorkerProcessModule,
  signal: AbortSignal,
  runtime: IngestRuntime,
) {
  const payload = assertObject(job.payload);
  const rawUrl = String(payload.url ?? "").trim();

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
    detectLinkProvider(parsedUrl.toString());

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

  await runtime.lifecycle.progress(job, "downloading");

  if (providerDef.strategy === "direct") {
    await runDirectLinkDownload(job, rawUrl, provider, workerProcess, signal, runtime);
    return;
  }

  await runYtdlpLinkDownload(job, rawUrl, provider, workerProcess, signal, runtime);
}

/** yt-dlp-backed providers: YouTube, Google Drive, StreamYard, Loom, Twitch,
 *  X, TikTok, LinkedIn, Facebook, Vimeo. */
async function runYtdlpLinkDownload(
  job: IngestJob,
  url: string,
  provider: LinkProviderId,
  workerProcess: WorkerProcessModule,
  signal: AbortSignal,
  runtime: IngestRuntime,
) {
  return workerProcess.withScratchDirectory("narriflow-link-", async (tempDir) => {
    const ytdlp = ytdlpSessions(job, provider);
    const probeStartedAtMs = Date.now();
    const metadataOutput = await ytdlp.run(() => withTransientRetry("yt_dlp_metadata_probe", () =>
      executeYtdlpCommand(
        workerProcess,
        signal,
        // Full info JSON includes captions and format URLs and can exceed
        // the process output limit. Project only the fields ingestion needs.
        [...ytdlp.args(), "--skip-download", "--print", "%(.{id,title,duration})j", url],
        { timeoutMs: METADATA_PROBE_TIMEOUT_MS },
      ),
    ));
    const metadata = JSON.parse(metadataOutput.stdout) as {
      title?: string;
      id?: string;
      duration?: number;
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
    // Each yt-dlp run extracts its own media URLs, which are bound to the IP
    // that requested them, so a fresh session for the download alone is safe.
    const downloadOutput = await ytdlp.run(() => withTransientRetry("yt_dlp_download", () =>
      executeYtdlpCommand(
        workerProcess,
        signal,
        [
          ...ytdlp.args(),
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
        {
          timeoutMs: LINK_DOWNLOAD_TIMEOUT_MS,
          acceptableExitCodes: [0, 101],
        },
      ),
    ));

    const lines = downloadOutput.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const downloadedPath = lines.at(-1);

    if (!downloadedPath) {
      throw new IngestWorkerError("link_download_missing_file", "yt-dlp did not return a downloaded file path");
    }

    await runtime.lifecycle.progress(job, "normalizing");

    const fileInfo = await stat(downloadedPath);
    if (fileInfo.size > MAX_UPLOAD_SIZE_BYTES) {
      throw new IngestWorkerError(
        "remote_media_too_large",
        "The downloaded media is too large to process.",
      );
    }

    const durationSeconds = requireDuration(
      metadataDuration ?? (await probeDurationSeconds(workerProcess, signal, downloadedPath)),
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
    await runtime.putSource({
      signal,
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

    await runtime.lifecycle.complete(job, {
      sourceStorageKey: key,
      sourceInput: url,
      sourceMimeType: "video/mp4",
      sourceSizeBytes: fileInfo.size,
      sourceDurationSeconds: durationSeconds,
    });
  });
}

/** Direct-download providers: Dropbox. */
async function runDirectLinkDownload(
  job: IngestJob,
  url: string,
  provider: LinkProviderId,
  workerProcess: WorkerProcessModule,
  signal: AbortSignal,
  runtime: IngestRuntime,
) {
  return workerProcess.withScratchDirectory("narriflow-link-", async (tempDir) => {
    const downloadUrl = provider === "dropbox" ? normalizeDropboxDownloadUrl(url) : url;

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
    const downloadMeta = await downloadToFile(downloadUrl, tempFile, signal);

    await runtime.lifecycle.progress(job, "normalizing");

    const fileInfo = await stat(tempFile);
    const durationSeconds = requireDuration(
      await probeDurationSeconds(workerProcess, signal, tempFile),
    );
    if (durationSeconds > MAX_MEDIA_DURATION_SECONDS) {
      throw new IngestWorkerError(
        "ingest_max_duration_exceeded",
        "This video is longer than your plan allows.",
      );
    }

    const baseName = sanitizeFileName(basename(urlPath, ext) || "source");
    const key = `projects/${job.projectId}/link/${Date.now()}-${baseName}${ext}`;

    await runtime.putSource({
      signal,
      key,
      filePath: tempFile,
      contentType: downloadMeta.contentType ?? "application/octet-stream",
      metadata: {
        source: provider,
        source_url: url,
      },
    });

    await runtime.lifecycle.complete(job, {
      sourceStorageKey: key,
      sourceInput: url,
      sourceMimeType: downloadMeta.contentType,
      sourceSizeBytes: fileInfo.size,
      sourceDurationSeconds: durationSeconds,
    });
  });
}

async function downloadToFile(url: string, targetPath: string, signal: AbortSignal) {
  const maxRetries = INGEST_RETRY_MAX_ATTEMPTS;

  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const isLastAttempt = attempt >= maxRetries;
    let response: Response | undefined;

    try {
      response = await guardedFetch(url, {
        headers: {
          accept: "audio/*, video/*, application/octet-stream;q=0.8",
          "user-agent": "NarriflowBot/1.0 (+https://narriflow.app)",
        },
        timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
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
        { signal },
      );

      return { contentType };
    } catch (error) {
      signal.throwIfAborted();
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

async function runRssImport(
  job: IngestJob,
  workerProcess: WorkerProcessModule,
  signal: AbortSignal,
  runtime: IngestRuntime,
) {
  const payload = assertObject(job.payload);
  const episode = assertObject(payload.episode);
  const enclosureUrl = String(episode.enclosureUrl ?? "").trim();
  const rssUrl = String(payload.rssUrl ?? "").trim();
  const episodeTitle = String(episode.title ?? "RSS Episode").trim();

  if (!enclosureUrl) {
    throw new IngestWorkerError("rss_missing_enclosure", "episode enclosure URL is required");
  }

  await runtime.lifecycle.progress(job, "downloading");

  return workerProcess.withScratchDirectory("narriflow-rss-", async (tempDir) => {
    let enclosurePath: string;
    try {
      enclosurePath = assertPublicHttpUrl(enclosureUrl).pathname;
    } catch (error) {
      throw mapRemoteDownloadError(error);
    }
    const enclosureExt = extname(enclosurePath) || ".mp3";
    const tempFile = join(tempDir, `source${enclosureExt}`);
    const downloadMeta = await downloadToFile(enclosureUrl, tempFile, signal);

    await runtime.lifecycle.progress(job, "normalizing");

    const fileInfo = await stat(tempFile);
    const durationSeconds = requireDuration(
      await probeDurationSeconds(workerProcess, signal, tempFile),
    );
    const key = `projects/${job.projectId}/rss/${Date.now()}-${sanitizeFileName(episodeTitle)}${enclosureExt}`;

    await runtime.putSource({
      signal,
      key,
      filePath: tempFile,
      contentType: downloadMeta.contentType ?? "audio/mpeg",
      metadata: {
        source: "rss",
        rss_url: redactUrlForDisplay(rssUrl),
        enclosure_url: redactUrlForDisplay(enclosureUrl),
      },
    });

    await runtime.lifecycle.complete(job, {
      sourceStorageKey: key,
      sourceInput: redactUrlForDisplay(rssUrl),
      sourceMimeType: downloadMeta.contentType,
      sourceSizeBytes: fileInfo.size,
      sourceDurationSeconds: durationSeconds,
    });
  });
}

export async function processIngestJob(
  job: IngestJob,
  options: {
    signal?: AbortSignal;
    workerProcess?: WorkerProcessModule;
    lifecycle?: IngestRuntime["lifecycle"];
    putSource?: IngestRuntime["putSource"];
  } = {},
) {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const workerProcess = options.workerProcess ?? productionWorkerProcessModule;
  const runtime: IngestRuntime = { lifecycle: options.lifecycle ?? getIngestJobLifecycle(), putSource: options.putSource ?? putFileFromPath };
  const jobStartedAtMs = Date.now();
  log("info", "ingest_job_started", {
    jobId: job.id,
    projectId: job.projectId,
    jobType: job.jobType,
  });

  try {
    if (job.jobType === "upload_finalize") {
      await runUploadFinalize(job, workerProcess, signal, runtime);
    } else if (job.jobType === "link_import") {
      await runLinkImport(job, workerProcess, signal, runtime);
    } else if (job.jobType === "rss_import") {
      await runRssImport(job, workerProcess, signal, runtime);
    } else {
      throw new IngestWorkerError(
        "worker_unknown_job_type",
        `Unsupported ingest job type: ${job.jobType}`,
      );
    }

    log("info", "ingest_job_completed", {
      jobId: job.id,
      projectId: job.projectId,
      jobType: job.jobType,
      totalMs: Date.now() - jobStartedAtMs,
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof IngestJobClaimLost) throw error;
    const normalizedError =
      error instanceof InvalidObjectMetadataError
        ? new IngestWorkerError(
            "storage_metadata_invalid",
            "Internal object metadata was invalid",
          )
        : error;
    const code =
      normalizedError instanceof IngestWorkerError || normalizedError instanceof WorkflowFailure
        ? normalizedError.code
        : "worker_unhandled_error";
    const message =
      normalizedError instanceof Error
        ? normalizedError.message
        : "Unknown worker error";

    const decision = await runtime.lifecycle.fail(job, code, message);
    log("error", "ingest_job_failed", {
      jobId: job.id,
      projectId: job.projectId,
      jobType: job.jobType,
      code,
      message,
      outcome: decision.outcome,
    });
  }
}
