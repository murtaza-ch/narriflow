/** Source and workflow retries share stable failure classification. */
export const INGEST_AUTO_RETRY_MAX_ATTEMPTS = 3;
export const INGEST_RETRIES_EXHAUSTED_CODE = "ingest_retries_exhausted";
const AUTO_RETRY_BASE_DELAY_MS = 30_000;
export const PERMANENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "remote_url_unsafe",
  "link_unsupported_source",
  "link_missing_url",
  "link_download_missing_file",
  "rss_missing_enclosure",
  "remote_media_invalid_content_type",
  "remote_media_too_large",
  "media_duration_unavailable",
  "invalid_source_dimensions",
  "unsupported_aspect_ratio",
  "ingest_max_duration_exceeded",
  "upload_too_long",
  "processing_quota_exhausted",
  "workspace_processing_capacity_reached",
  "upload_source_changed",
  "requires_pro_plan",
  "requires_creator_plan",
  "assemblyai_api_key_missing",
  "openai_api_key_missing",
  "openai_quota_exhausted",
  "worker_command_missing",
  "source_provider_access_denied",
  "worker_invalid_payload",
  "worker_unknown_job_type",
  "upload_finalize_missing_key",
  "storage_metadata_invalid",
  "workflow_source_missing",
  "workflow_content_pack_invalid",
  "source_storage_key_missing",
  "base_render_missing",
  "no_renderable_clips",
  "no_clips_detected",
  "transcript_not_ready",
  "transcript_processing_window_empty",
  "dub_transcript_empty",
  "broll_cutaways_empty",
]);
export const TRANSIENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "remote_fetch_timeout",
  "worker_command_timeout",
  "source_download_failed",
  "worker_stalled",
]);
export function isAutoRetryableFailureCode(code: string): boolean {
  return !PERMANENT_FAILURE_CODES.has(code);
}
export type AutoRetryDecision =
  | { outcome: "requeue" }
  | { outcome: "permanent"; terminalErrorCode: string };
export function decideAutoRetry(
  attemptCount: number,
  errorCode: string,
  maxAttempts: number,
  exhaustedErrorCode: string,
): AutoRetryDecision {
  if (isAutoRetryableFailureCode(errorCode) && attemptCount < maxAttempts) {
    return { outcome: "requeue" };
  }
  return {
    outcome: "permanent",
    terminalErrorCode: isAutoRetryableFailureCode(errorCode)
      ? exhaustedErrorCode
      : errorCode,
  };
}

export function autoRetryBackoffMs(
  attemptCount: number,
  baseDelayMs = AUTO_RETRY_BASE_DELAY_MS,
): number {
  return baseDelayMs * 2 ** Math.max(0, attemptCount - 1);
}
/** Eligibility follows the requeue write time; a new job is immediately due. */
export function claimBackoffWhereClauses(
  maxAttempts: number,
  nowMs = Date.now(),
): Array<{ attemptCount: number; updatedAt?: { lt: Date } }> {
  const clauses: Array<{ attemptCount: number; updatedAt?: { lt: Date } }> = [
    { attemptCount: 0 },
  ];
  for (let attempt = 1; attempt < maxAttempts; attempt++)
    clauses.push({
      attemptCount: attempt,
      updatedAt: { lt: new Date(nowMs - autoRetryBackoffMs(attempt)) },
    });
  return clauses;
}
