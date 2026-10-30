import { WorkflowFailure } from "./workflow-run-lifecycle";

// Provider error classification (D13). One classifier for the worker's HTTP
// answers and the webhook's `webhook_error`; the provider's prose is read to
// pick a code and never reused as user copy.

interface ScribeErrorDetail {
  type: string | null;
  code: string | null;
  status: string | null;
}

/** Scribe errors arrive as `{detail: {type, code, message, status}}`; validation
 * failures (422) carry a `detail` array and some gateways a bare string. Only
 * the machine-readable tokens are read: the provider's prose is never reused. */
export function scribeErrorDetail(payload: unknown): ScribeErrorDetail {
  const detail = (payload as { detail?: unknown } | null)?.detail;
  const record = detail && typeof detail === "object" && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : {};
  const token = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
  return { type: token(record.type), code: token(record.code), status: token(record.status) };
}

export type ScribeCallStage = "submit" | "result";

function retryableCode(stage: ScribeCallStage) {
  return stage === "submit" ? "elevenlabs_transcription_submit_failed" : "elevenlabs_transcript_fetch_failed";
}

/**
 * Maps a failed HTTP response to a workflow failure. Permanent: missing
 * webhook configuration, authentication, exhausted quota, unsupported language,
 * and rejected media/requests. Retryable (bounded by the attempt policy): 408,
 * 429, concurrency/busy codes and 5xx.
 */
export function scribeHttpFailure(
  stage: ScribeCallStage,
  status: number,
  payload: unknown,
): WorkflowFailure {
  const detail = scribeErrorDetail(payload);
  const tokens = [detail.code, detail.status, detail.type].filter(Boolean).join(" ");
  const label = `Scribe ${stage} failed with status ${status}${detail.code ? ` (${detail.code})` : ""}`;
  const permanent = (code: string) => new WorkflowFailure(code, "permanent", label);
  const retryable = () => new WorkflowFailure(retryableCode(stage), "retryable", label);

  if (/no_webhooks_configured|webhook/.test(tokens) && status >= 400 && status < 500) {
    return permanent("elevenlabs_webhook_not_configured");
  }
  if (/quota|insufficient|credits|billing|payment/.test(tokens)) {
    return permanent("elevenlabs_quota_exhausted");
  }
  if (
    status === 429 ||
    status === 408 ||
    /too_many|concurrent|system_busy|rate_limit|overload/.test(tokens)
  ) {
    return retryable();
  }
  if (status === 401 || status === 403 || /api_key|unauthorized|forbidden|permission/.test(tokens)) {
    return permanent("elevenlabs_auth_failed");
  }
  if (status >= 500) return retryable();
  if (/language/.test(tokens)) return permanent("elevenlabs_invalid_language");
  // A result GET answering 404 with any other code means the id is not ours to
  // read (wrong account or key), which is configuration, not media.
  if (stage === "result" && status === 404) return permanent("elevenlabs_auth_failed");
  return permanent("elevenlabs_invalid_media");
}

/** Transport-level or remote-fetch trouble: another attempt (which uploads the
 * audio itself) can succeed. */
const TRANSIENT_CALLBACK = /(?:fetch|download|retriev|reach|connect)\w*\b.*\b(?:url|source|remote|server|host)|\b(?:remote|url|source)\b.*\b(?:fetch|download|unreachable|unavailable|timed? ?out)|time(?:d)? ?out|temporar|try again|unavailable|too many|rate.?limit|concurren|overload|busy|internal (?:server )?error|\b5\d\d\b/;

// Ordered: the first class that matches wins. The permanent classes name the
// cause explicitly; anything unrecognised retries within the attempt budget.
const PERMANENT_CALLBACK: readonly (readonly [RegExp, string])[] = [
  [/quota|insufficient (?:credits?|balance)|out of credits|billing|payment/, "elevenlabs_quota_exhausted"],
  [/api[ _-]?key|unauthori[sz]ed|forbidden|permission|authenticat|invalid (?:token|credentials)/, "elevenlabs_auth_failed"],
  [/\blanguage\b/, "elevenlabs_invalid_language"],
  [
    /invalid (?:media|file|audio|video|format|input)|unsupported (?:media|file|audio|video|format|codec|container)|corrupt|malformed|no audio|contains no (?:audio|speech)|(?:could not|couldn't|cannot|can't|unable to|failed to) (?:be )?(?:decode|decoded|parse|read|open|process) (?:the )?(?:media|file|audio|video|input)|(?:could not|couldn't|cannot|can't|unable to) (?:be )?(?:decode|decoded|decoding)|not a valid (?:media|file|audio|video)|file (?:is )?(?:too (?:large|big|long)|empty)|exceeds? (?:the )?(?:maximum|max|limit)/,
    "elevenlabs_invalid_media",
  ],
];

/** `not found` with no sign of a remote fetch: the id is not ours to read. */
const NOT_FOUND_CALLBACK = /\bnot[ _]found\b|\b404\b/;

/**
 * Classifies a `webhook_error` from the fields the envelope carries
 * (`error_message`). Permanent causes name the actionable code; unknown,
 * transient and remote-fetch errors stay retryable. The returned message is
 * fixed text: raw provider prose never leaves this function.
 */
export function scribeCallbackFailure(errorMessage: unknown): WorkflowFailure {
  const text = typeof errorMessage === "string" ? errorMessage.toLowerCase() : "";
  for (const [pattern, code] of PERMANENT_CALLBACK) {
    if (pattern.test(text)) {
      return new WorkflowFailure(code, "permanent", `Scribe reported a permanent error (${code})`);
    }
  }
  if (!TRANSIENT_CALLBACK.test(text) && NOT_FOUND_CALLBACK.test(text)) {
    return new WorkflowFailure(
      "elevenlabs_auth_failed",
      "permanent",
      "Scribe reported a permanent error (elevenlabs_auth_failed)",
    );
  }
  return new WorkflowFailure(
    "elevenlabs_transcription_failed",
    "retryable",
    "ElevenLabs could not complete the transcription.",
  );
}
