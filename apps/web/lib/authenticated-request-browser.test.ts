import { describe, expect, test } from "bun:test";
import { PLAN_CATALOG } from "@narriflow/validators";
import {
  authenticatedRequestFailureMessage,
  authenticatedActionResultMessage,
  classifyAuthenticatedRequestFailure,
  isAuthenticatedActionFailure,
  upgradePromptFromFailure,
} from "./authenticated-request-browser";

describe("authenticated request browser recovery", () => {
  test("preserves a safe destination and rejects an external sign-in return", () => {
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "authentication_required" },
        "/projects/p1?tab=clips",
      ),
    ).toMatchObject({
      kind: "sign_in",
      preserveInput: true,
      returnDestination: "/projects/p1?tab=clips",
    });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "authentication_required" },
        "https://attacker.test/steal",
      ),
    ).toMatchObject({ returnDestination: "/home" });
  });

  test("keeps Workspace mismatch, validation, conflict, wait, and retry distinct", () => {
    expect(
      classifyAuthenticatedRequestFailure(
        {
          error: "active_workspace_mismatch",
          details: { workspaceId: "w2", workspaceName: "Team" },
        },
        "/home",
      ),
    ).toMatchObject({ kind: "switch_workspace", workspaceId: "w2" });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "invalid_input", issues: [{ path: ["title"] }] },
        "/home",
      ),
    ).toMatchObject({ kind: "correct_input", focusPath: ["title"] });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "revision_conflict" },
        "/home",
      ),
    ).toMatchObject({ kind: "refresh", preserveInput: true });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "rate_limited", retryAfterSeconds: 12.1 },
        "/home",
      ),
    ).toMatchObject({ kind: "wait", retryAfterSeconds: 13 });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "storage_unavailable" },
        "/home",
      ),
    ).toMatchObject({ kind: "retry", preserveInput: true });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "remote_fetch_timeout" },
        "/upload",
      ),
    ).toMatchObject({ kind: "retry", preserveInput: true });
  });

  test("recognizes only the discriminated serialized action failure", () => {
    expect(
      isAuthenticatedActionFailure({
        ok: false,
        error: "invalid_input",
        code: "invalid_input",
        message: "Check the fields.",
        requestId: "request-action-1",
      }),
    ).toBe(true);
    expect(isAuthenticatedActionFailure({ ok: true })).toBe(false);
    expect(isAuthenticatedActionFailure({ error: "invalid_input" })).toBe(false);
    expect(
      isAuthenticatedActionFailure({
        ok: false,
        error: "Could not save the Project.",
        errorCode: "project_save_failed",
        requestId: "request-domain-1",
      }),
    ).toBe(false);
    expect(
      authenticatedActionResultMessage(
        {
          ok: false,
          error: "Could not save the Project.",
          errorCode: "project_save_failed",
          requestId: "request-domain-1",
        },
        "Fallback",
      ),
    ).toBe("Could not save the Project.");
  });

  test("directs restricted owners to billing and other members to the owner", () => {
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "workspace_restricted", details: { ownerCanResolve: true } },
        "/home",
      ),
    ).toMatchObject({ kind: "billing" });
    expect(
      classifyAuthenticatedRequestFailure(
        { error: "workspace_restricted", details: { ownerCanResolve: false } },
        "/home",
      ),
    ).toMatchObject({ kind: "contact_owner" });
  });

  test("turns the shared recovery decision into safe actionable copy", () => {
    expect(
      authenticatedRequestFailureMessage(
        { error: "rate_limited", retryAfterSeconds: 4.2 },
        "/upload",
        "Upload failed.",
      ),
    ).toBe("Wait 5 seconds before trying again.");
    expect(
      authenticatedRequestFailureMessage(
        { error: "internal_error", requestId: "request-browser-1" },
        "/upload",
        "Upload failed.",
      ),
    ).toContain("request-browser-1");
  });

  test("classifies upgrade recovery by exact code, not substring", () => {
    for (const error of [
      "plan_feature_required",
      "plan_limit_reached",
      "credits_exhausted",
      "upload_too_long",
    ]) {
      expect(
        classifyAuthenticatedRequestFailure({ error }, "/home"),
      ).toMatchObject({ kind: "upgrade", preserveInput: true, prompt: null });
    }
    for (const error of [
      "youtube_quota_exceeded",
      "publication_plan_required",
      "workspace_processing_capacity_reached",
    ]) {
      expect(
        classifyAuthenticatedRequestFailure({ error }, "/home").kind,
      ).not.toBe("upgrade");
    }
  });
});

describe("upgradePromptFromFailure", () => {
  test("offers the required tier for a plan feature", () => {
    const prompt = upgradePromptFromFailure({
      error: "plan_feature_required",
      message: "Export bundles need the Pro plan.",
      details: {
        currentTier: "creator",
        requiredTier: "pro",
        feature: "export.bundles",
      },
    });
    expect(prompt).toMatchObject({
      tier: "pro",
      headline: "Export bundles need the Pro plan.",
    });
    expect(prompt?.highlight).toBeTruthy();
  });

  test("offers the required tier for a count limit with its new maximum", () => {
    expect(
      upgradePromptFromFailure({
        error: "plan_limit_reached",
        details: {
          currentTier: "creator",
          requiredTier: "pro",
          limit: "brandProfiles",
          used: 1,
          max: 1,
        },
      }),
    ).toMatchObject({ tier: "pro", highlight: "Up to 4 Brand Profiles" });
  });

  test("has no prompt when no tier lifts the limit or details are malformed", () => {
    expect(
      upgradePromptFromFailure({
        error: "plan_limit_reached",
        details: {
          currentTier: "business",
          requiredTier: null,
          limit: "autopilotRules",
          used: 10,
          max: 10,
        },
      }),
    ).toBeNull();
    expect(
      upgradePromptFromFailure({
        error: "plan_feature_required",
        details: { currentTier: "free", requiredTier: "gold", feature: "x" },
      }),
    ).toBeNull();
    expect(
      upgradePromptFromFailure({
        error: "plan_feature_required",
        details: { currentTier: "pro", requiredTier: "creator", feature: "export.bundles" },
      }),
    ).toBeNull();
    expect(upgradePromptFromFailure({ error: "plan_feature_required" })).toBeNull();
    expect(
      upgradePromptFromFailure({
        error: "plan_feature_required",
        details: [] as unknown as Record<string, unknown>,
      }),
    ).toBeNull();
  });

  test("picks the cheapest plan whose allowance covers spent plus requested credits", () => {
    const base = {
      tier: "free",
      limitCredits: 60,
      remainingCredits: 10,
      spentCredits: 50,
      renewsAt: "2026-11-01T00:00:00.000Z",
    };
    // 50 spent + 40 requested = 90: Creator's 300 covers it.
    expect(
      upgradePromptFromFailure({
        error: "credits_exhausted",
        details: { ...base, requestedCredits: 40 },
      }),
    ).toMatchObject({ tier: "creator", highlight: "300 credits a month" });
    // 50 spent + 400 requested = 450: Pro.
    expect(
      upgradePromptFromFailure({
        error: "credits_exhausted",
        details: { ...base, requestedCredits: 400 },
      }),
    ).toMatchObject({ tier: "pro" });
    // Unknown request size still needs one more credit than is spent.
    expect(
      upgradePromptFromFailure({
        error: "credits_exhausted",
        details: { ...base, remainingCredits: 0, spentCredits: 60, requestedCredits: null },
      }),
    ).toMatchObject({ tier: "creator" });
    // Business is the top allowance; nothing above it.
    expect(
      upgradePromptFromFailure({
        error: "credits_exhausted",
        details: {
          tier: "business",
          limitCredits: 1800,
          remainingCredits: 0,
          spentCredits: 1800,
          requestedCredits: 5,
          renewsAt: base.renewsAt,
        },
      }),
    ).toBeNull();
    // Creator after 1,000 credits used (a downgrade): Pro's 900 cannot admit
    // 1,001, so Business is offered, and nothing is when even it cannot.
    const downgraded = { tier: "creator", limitCredits: 300, remainingCredits: 0, renewsAt: base.renewsAt };
    const offered = upgradePromptFromFailure({
      error: "credits_exhausted",
      details: { ...downgraded, spentCredits: 1000, requestedCredits: 1 },
    });
    expect(offered?.tier).toBe("business");
    expect(PLAN_CATALOG.business.limits.monthlyCredits).toBeGreaterThanOrEqual(1000 + 1);
    expect(
      upgradePromptFromFailure({
        error: "credits_exhausted",
        details: { ...downgraded, spentCredits: 1800, requestedCredits: 1 },
      }),
    ).toBeNull();
    // Without the real spent total the old limit-minus-remaining guess is not used.
    expect(
      upgradePromptFromFailure({
        error: "credits_exhausted",
        details: { ...base, spentCredits: undefined, requestedCredits: 1 },
      }),
    ).toBeNull();
    expect(
      upgradePromptFromFailure({
        error: "credits_exhausted",
        details: { ...base, requestedCredits: "lots" },
      }),
    ).toBeNull();
  });

  test("capacity refusals wait with the server message, no purchase and no retry", () => {
    const failure = {
      error: "workspace_processing_capacity_reached",
      message: "This workspace already has 2 of 2 videos processing on the Free plan. Try again when one finishes.",
      retryAfterSeconds: 60,
      details: { tier: "free", inFlight: 2, inFlightLimit: 2 },
    };
    expect(classifyAuthenticatedRequestFailure(failure, "/upload")).toEqual({
      kind: "wait",
      preserveInput: true,
      retryAfterSeconds: 60,
      message: failure.message,
    });
    expect(authenticatedRequestFailureMessage(failure, "/upload", "RSS import failed.")).toBe(failure.message);
    expect(upgradePromptFromFailure(failure)).toBeNull();
    // Without a hint it still waits, with a default.
    expect(
      classifyAuthenticatedRequestFailure({ error: "workspace_processing_capacity_reached" }, "/upload"),
    ).toMatchObject({ kind: "wait", retryAfterSeconds: 60 });
  });

  test("offers a longer-video plan only when one admits the source", () => {
    expect(
      upgradePromptFromFailure({
        error: "upload_too_long",
        details: { tier: "free", maxSeconds: 3600, seconds: 100 * 60, spentCredits: 0, requestedCredits: 100 },
      }),
    ).toMatchObject({ tier: "creator", highlight: "Videos up to 2 hours" });
    expect(
      upgradePromptFromFailure({
        error: "upload_too_long",
        details: { tier: "creator", maxSeconds: 7200, seconds: 150 * 60, spentCredits: 0, requestedCredits: 150 },
      }),
    ).toMatchObject({ tier: "pro", highlight: "Videos up to 3 hours" });
    // 181 minutes: Pro and Business both stop at three hours.
    expect(
      upgradePromptFromFailure({
        error: "upload_too_long",
        details: { tier: "pro", maxSeconds: 10800, seconds: 181 * 60, spentCredits: 0, requestedCredits: 181 },
      }),
    ).toBeNull();
    expect(
      upgradePromptFromFailure({
        error: "upload_too_long",
        details: { tier: "free", maxSeconds: 3600, seconds: 4 * 3600, spentCredits: 0, requestedCredits: 240 },
      }),
    ).toBeNull();
    // Over both limits: Creator allows 61 minutes but not 250 + 61 credits; Pro does both.
    expect(
      upgradePromptFromFailure({
        error: "upload_too_long",
        details: { tier: "free", maxSeconds: 3600, seconds: 61 * 60, spentCredits: 250, requestedCredits: 61 },
      }),
    ).toMatchObject({ tier: "pro" });
    // Without usage facts no plan can be promised.
    expect(
      upgradePromptFromFailure({ error: "upload_too_long", details: { tier: "free", maxSeconds: 3600, seconds: 61 * 60 } }),
    ).toBeNull();
  });

  test("never turns capacity or billing repair into an upgrade", () => {
    expect(
      upgradePromptFromFailure({
        error: "workspace_processing_capacity_reached",
        details: { tier: "free", inFlight: 2, inFlightLimit: 2 },
      }),
    ).toBeNull();
    expect(
      upgradePromptFromFailure({
        error: "workspace_restricted",
        details: { ownerCanResolve: true },
      }),
    ).toBeNull();
  });
});
