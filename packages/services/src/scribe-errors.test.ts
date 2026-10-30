import { describe, expect, test } from "bun:test";
import { scribeCallbackFailure, scribeErrorDetail, scribeHttpFailure } from "./scribe-errors";

const detail = (code: string, status = "error") => ({ detail: { type: "x", code, message: "provider prose", status } });

describe("Scribe error classification (D13)", () => {
  test("reads only the machine-readable tokens of nested, array and string details", () => {
    expect(scribeErrorDetail(detail("Transcript_Not_Found"))).toEqual({ type: "x", code: "transcript_not_found", status: "error" });
    expect(scribeErrorDetail({ detail: [{ loc: ["body"], msg: "bad" }] })).toEqual({ type: null, code: null, status: null });
    expect(scribeErrorDetail({ detail: "Not found" })).toEqual({ type: null, code: null, status: null });
    expect(scribeErrorDetail(null)).toEqual({ type: null, code: null, status: null });
  });

  test.each([
    ["submit", 400, detail("no_webhooks_configured"), "elevenlabs_webhook_not_configured", "permanent"],
    ["submit", 401, detail("invalid_api_key"), "elevenlabs_auth_failed", "permanent"],
    ["submit", 403, detail("forbidden"), "elevenlabs_auth_failed", "permanent"],
    ["submit", 401, detail("quota_exceeded"), "elevenlabs_quota_exhausted", "permanent"],
    ["submit", 400, detail("unsupported_language"), "elevenlabs_invalid_language", "permanent"],
    ["submit", 400, detail("invalid_file"), "elevenlabs_invalid_media", "permanent"],
    ["submit", 422, { detail: [{ msg: "field required" }] }, "elevenlabs_invalid_media", "permanent"],
    ["submit", 429, detail("too_many_concurrent_requests"), "elevenlabs_transcription_submit_failed", "retryable"],
    ["submit", 429, null, "elevenlabs_transcription_submit_failed", "retryable"],
    ["submit", 408, null, "elevenlabs_transcription_submit_failed", "retryable"],
    ["submit", 503, null, "elevenlabs_transcription_submit_failed", "retryable"],
    ["result", 429, detail("system_busy"), "elevenlabs_transcript_fetch_failed", "retryable"],
    ["result", 502, null, "elevenlabs_transcript_fetch_failed", "retryable"],
    ["result", 401, detail("invalid_api_key"), "elevenlabs_auth_failed", "permanent"],
    ["result", 404, detail("some_other_not_found"), "elevenlabs_auth_failed", "permanent"],
  ] as const)("%s %i %j → %s (%s)", (stage, status, body, code, disposition) => {
    const failure = scribeHttpFailure(stage, status, body);
    expect(failure.code).toBe(code);
    expect(failure.disposition).toBe(disposition);
  });

  test("failure messages never echo the provider's prose", () => {
    expect(scribeHttpFailure("submit", 400, detail("invalid_file")).message).not.toContain("provider prose");
  });
});

describe("scribeCallbackFailure (webhook_error)", () => {
  test.each([
    ["The audio could not be decoded", "elevenlabs_invalid_media"],
    ["Unsupported file format: .xyz", "elevenlabs_invalid_media"],
    ["Invalid audio file", "elevenlabs_invalid_media"],
    ["File exceeds the maximum allowed size", "elevenlabs_invalid_media"],
    ["Unsupported language code 'xx'", "elevenlabs_invalid_language"],
    ["Invalid API key", "elevenlabs_auth_failed"],
    ["Unauthorized", "elevenlabs_auth_failed"],
    ["This request was forbidden for your plan", "elevenlabs_auth_failed"],
    ["Transcript not found", "elevenlabs_auth_failed"],
    ["You have exceeded your character quota", "elevenlabs_quota_exhausted"],
    ["Insufficient credits to run this request", "elevenlabs_quota_exhausted"],
    ["The language 'xx' is not supported", "elevenlabs_invalid_language"],
    ["Invalid language code", "elevenlabs_invalid_language"],
    ["The file has no audio stream: no audio", "elevenlabs_invalid_media"],
    ["Corrupt file", "elevenlabs_invalid_media"],
  ])("%j is permanent: %s", (message, code) => {
    const failure = scribeCallbackFailure(message);
    expect(failure.code).toBe(code);
    expect(failure.disposition).toBe("permanent");
  });

  test.each([
    "Service temporarily unavailable, please try again",
    "Too many concurrent requests",
    "Internal server error",
    "HTTP 503 Service Unavailable",
    "Rate limit hit (429)",
    "The service is overloaded",
    "Connection reset by peer",
    "Something odd happened",
    "",
    null,
    undefined,
    { message: "object" },
  ])("%j stays retryable", (message) => {
    const failure = scribeCallbackFailure(message);
    expect(failure.code).toBe("elevenlabs_transcription_failed");
    expect(failure.disposition).toBe("retryable");
  });

  test.each([
    "Could not download audio from the source URL (404 not found)",
    "Failed to download source URL: HTTP 403 Forbidden (signed URL expired)",
    "Failed to fetch the file from the remote URL",
    "The signed URL expired before the file could be read",
    "Unable to read audio from source URL: 404",
  ])("source-fetch trouble (%j) retries under its own code", (message) => {
    const failure = scribeCallbackFailure(message);
    expect(failure.code).toBe("elevenlabs_source_fetch_failed");
    expect(failure.disposition).toBe("retryable");
  });

  // Mixed causes: explicit service trouble outranks the permanent-looking word,
  // and source-fetch trouble outranks the auth/media words (Sol finding 11).
  test.each([
    ["Unable to read audio from source URL: connection timed out", "elevenlabs_transcription_failed"],
    ["Failed to fetch the file from the remote URL: connection timed out", "elevenlabs_transcription_failed"],
    ["Language detection failed: internal server error, please try again", "elevenlabs_transcription_failed"],
    ["Language detection temporarily unavailable", "elevenlabs_transcription_failed"],
    ["Invalid API key lookup failed: 503 service unavailable", "elevenlabs_transcription_failed"],
    ["Quota service is unavailable right now", "elevenlabs_transcription_failed"],
    ["Invalid audio at source URL: HTTP 403 forbidden", "elevenlabs_source_fetch_failed"],
    ["Could not download the file: unauthorized (expired signed URL)", "elevenlabs_source_fetch_failed"],
  ])("mixed cause %j is retryable as %s", (message, code) => {
    const failure = scribeCallbackFailure(message);
    expect(failure.code).toBe(code);
    expect(failure.disposition).toBe("retryable");
  });

  test.each([
    ["Language detection failed", "elevenlabs_transcription_failed"],
    ["File exceeds the maximum of 500 MB", "elevenlabs_invalid_media"],
  ])("narrow patterns: %j → %s", (message, code) => {
    expect(scribeCallbackFailure(message).code).toBe(code);
  });

  test("the failure carries fixed text, never the provider's prose", () => {
    for (const prose of ["Invalid audio for jane@example.com", "weird failure for jane@example.com"]) {
      expect(scribeCallbackFailure(prose).message).not.toContain("jane@example.com");
    }
  });
});
