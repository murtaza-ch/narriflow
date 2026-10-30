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
  ])("%j is permanent: %s", (message, code) => {
    const failure = scribeCallbackFailure(message);
    expect(failure.code).toBe(code);
    expect(failure.disposition).toBe("permanent");
  });

  test.each([
    "Failed to fetch the file from the remote URL: connection timed out",
    "Could not download audio from the source URL (404 not found)",
    "Service temporarily unavailable, please try again",
    "Too many concurrent requests",
    "Internal server error",
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

  test("the failure carries fixed text, never the provider's prose", () => {
    for (const prose of ["Invalid audio for jane@example.com", "weird failure for jane@example.com"]) {
      expect(scribeCallbackFailure(prose).message).not.toContain("jane@example.com");
    }
  });
});
