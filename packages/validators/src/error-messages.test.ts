import { describe, expect, test } from "bun:test";
import { hasUserErrorMessage, userErrorMessage, USER_ERROR_MESSAGES } from ".";

describe("userErrorMessage", () => {
  test("explains selection-scoped campaign attention states", () => {
    expect(userErrorMessage("campaign_motion_target_missing")).toBe(
      "This clip has no manual B-roll target. Add B-roll in Studio, then try again.",
    );
    expect(userErrorMessage("campaign_clip_stale")).toContain("changed");
  });

  test("returns friendly copy for a known code", () => {
    expect(userErrorMessage("quota_exceeded")).toBe(
      USER_ERROR_MESSAGES.quota_exceeded,
    );
    expect(userErrorMessage("quota_exceeded")).toContain(
      "processing minutes",
    );
  });

  test("explains how to recover from exhausted OpenAI credits", () => {
    const message = userErrorMessage("openai_quota_exhausted");
    expect(message).toBe(USER_ERROR_MESSAGES.openai_quota_exhausted);
    expect(message).toContain("no credits");
    expect(message).toContain("then retry detection");
  });

  test("distinguishes invalid clip lengths from retryable edit contention", () => {
    const invalid = userErrorMessage("editor_boundaries_invalid");
    const contention = userErrorMessage("retryable_contention");
    expect(invalid).toBe(USER_ERROR_MESSAGES.editor_boundaries_invalid);
    expect(invalid).toContain("range");
    expect(contention).toBe(USER_ERROR_MESSAGES.retryable_contention);
    expect(contention).toContain("changed while");
    expect(contention).not.toBe(invalid);
  });

  test("returns friendly copy for the tier-gate codes", () => {
    expect(userErrorMessage("requires_pro_plan")).toBe(
      USER_ERROR_MESSAGES.requires_pro_plan,
    );
    expect(userErrorMessage("requires_pro_plan")).toContain("Pro");
    expect(userErrorMessage("requires_creator_plan")).toBe(
      USER_ERROR_MESSAGES.requires_creator_plan,
    );
    expect(userErrorMessage("requires_creator_plan")).toContain("Creator");
  });

  test("returns friendly copy for the social OAuth codes", () => {
    expect(userErrorMessage("social_oauth_env_missing")).toBe(
      USER_ERROR_MESSAGES.social_oauth_env_missing,
    );
    expect(userErrorMessage("social_oauth_env_missing")).toContain(
      "configured on this server",
    );
    expect(userErrorMessage("social_oauth_start_failed")).toBe(
      USER_ERROR_MESSAGES.social_oauth_start_failed,
    );
    expect(userErrorMessage("social_oauth_start_failed")).toContain(
      "couldn't start the connection",
    );
    expect(userErrorMessage("social_oauth_origin_invalid")).toBe(
      USER_ERROR_MESSAGES.social_oauth_origin_invalid,
    );
    expect(userErrorMessage("social_oauth_origin_invalid")).toContain(
      "app URL",
    );
  });

  test("distinguishes safe stale-upload recovery from ambiguous completion", () => {
    const unavailable = userErrorMessage("upload_session_unavailable");
    expect(unavailable).toBe(
      USER_ERROR_MESSAGES.upload_session_unavailable,
    );
    expect(unavailable).toContain("fresh upload");

    const reconciliation = userErrorMessage(
      "upload_completion_reconciliation_required",
    );
    expect(reconciliation).toBe(
      USER_ERROR_MESSAGES.upload_completion_reconciliation_required,
    );
    expect(reconciliation).toContain("Don't start another upload");

    const completionFailure = userErrorMessage("upload_complete_failed");
    expect(completionFailure).toBe(
      USER_ERROR_MESSAGES.upload_complete_failed,
    );
    expect(completionFailure).toContain("Re-select the same file");
  });

  test.each([
    "remote_url_unsafe",
    "remote_fetch_timeout",
    "remote_media_too_large",
    "remote_media_invalid_content_type",
    "media_duration_unavailable",
    "rss_feed_too_large",
  ])("returns actionable copy for remote media code %s", (code) => {
    const message = userErrorMessage(code);
    expect(message).toBe(USER_ERROR_MESSAGES[code]);
    expect(message).not.toContain("localhost");
    expect(message).not.toContain("provider");
  });

  test("returns the generic fallback for an unknown code", () => {
    expect(userErrorMessage("totally_unknown_code")).toBe(
      "Something went wrong. Please try again or contact support.",
    );
  });

  test("distinguishes explicitly supported codes from generic fallback copy", () => {
    expect(hasUserErrorMessage("quota_exceeded")).toBe(true);
    expect(hasUserErrorMessage("P2024")).toBe(false);
  });

  test("does not tell users to retry deterministic storage metadata failures", () => {
    const message = userErrorMessage("storage_metadata_invalid");
    expect(message).toBe(USER_ERROR_MESSAGES.storage_metadata_invalid);
    expect(message).toContain("contact support");
    expect(message).toContain("won't resolve");
  });

  test("keeps an incomplete Clip deletion retryable without exposing storage details", () => {
    const message = userErrorMessage("clip_storage_delete_incomplete");
    expect(message).toBe(
      "Some clip media could not be deleted. The clip is still here, so try deleting it again.",
    );
    expect(message).not.toContain("object key");
    expect(message).not.toContain("provider");
  });

  test("returns null for null and undefined", () => {
    expect(userErrorMessage(null)).toBeNull();
    expect(userErrorMessage(undefined)).toBeNull();
  });
});
