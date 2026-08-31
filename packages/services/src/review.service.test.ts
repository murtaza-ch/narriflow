import { describe, expect, test } from "bun:test";
import {
  deriveReviewRoundStatus,
  enforceReviewAccessFailureRateLimit,
  enforceReviewAccessSourceRateLimit,
  enforceReviewAccessTokenAndIdentityRateLimits,
  hashReviewAccessToken,
  hashReviewPasscode,
  issueReviewSession,
  ReviewService,
  ReviewServiceError,
  retryReviewNotification,
  reviewNotificationRetrySource,
  reviewNotificationRetrySourceId,
  reviewRoundAutomationFingerprint,
  verifyReviewPasscode,
  verifyReviewSession,
} from "./review.service";
import { ProgramWriteDisabledError } from "./program-rollout";
import { frozenProjectApprovalRequired } from "./review-project-policy";
import { createReviewRolloutPolicy } from "./review-rollout";

function brandProfileSnapshot(
  profileId: string,
  approvalRule: "none" | "approval_required",
) {
  return {
    version: 1 as const,
    profileId,
    profileRevision: 1,
    name: "Frozen campaign brand",
    identity: {
      primaryColor: "#FFFFFF",
      secondaryColor: "#111522",
      accentColor: null,
      primaryLogoAssetId: null,
      alternateLogoAssetId: null,
    },
    voice: {
      audience: "",
      tone: [],
      preferredTerms: [],
      blockedTerms: [],
      hashtagGuidance: "",
    },
    approvalRule,
    style: null,
  };
}

function memoryReviewRateLimiter() {
  const counts = new Map<string, number>();
  return {
    counts,
    enforce: async (key: string, limit: number) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > limit) {
        throw new ReviewServiceError(
          "review_access_rate_limited",
          "Too many review access attempts",
        );
      }
    },
  };
}

describe("review guest security primitives", () => {
  const secret = "s".repeat(64);

  test("hashes raw access tokens without retaining the capability", () => {
    const token = Buffer.alloc(32, 7).toString("base64url");
    const hash = hashReviewAccessToken(token);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(hashReviewAccessToken(token)).toBe(hash);
  });

  test("issues a round-scoped expiring session and rejects tampering", () => {
    const issued = issueReviewSession({ roundId: crypto.randomUUID(), guestId: crypto.randomUUID(), grant: "a".repeat(32), identity: "Client reviewer", subject: crypto.randomUUID() }, secret, new Date("2026-08-30T00:00:00Z"));
    expect(verifyReviewSession(issued, secret, new Date("2026-08-30T01:00:00Z")).identity).toBe("Client reviewer");
    expect(() => verifyReviewSession(`${issued.slice(0, -1)}x`, secret)).toThrow();
    expect(() => verifyReviewSession(issued, secret, new Date("2026-08-31T00:00:00Z"))).toThrow();
  });

  test("uses Argon2id for an optional passcode", async () => {
    const hash = await hashReviewPasscode("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyReviewPasscode("correct horse battery staple", hash)).toBe(true);
    expect(await verifyReviewPasscode("wrong", hash)).toBe(false);
  });

  test("admits all 50 intended reviewers behind one corporate source", async () => {
    const { counts, enforce } = memoryReviewRateLimiter();
    const tokenHash = hashReviewAccessToken("fanout-review-token");
    const source = "shared-corporate-source";

    for (let reviewer = 1; reviewer <= 50; reviewer += 1) {
      await enforceReviewAccessSourceRateLimit(source, enforce);
      await expect(
        enforceReviewAccessTokenAndIdentityRateLimits(
          {
            tokenHash,
            identity: `reviewer-${reviewer}@example.test`,
            identitySecret: "s".repeat(64),
          },
          enforce,
        ),
      ).resolves.toBeUndefined();
    }

    expect(counts.get(`review-access-token:${tokenHash}`)).toBe(50);
    expect(
      [...counts.entries()].filter(([key]) =>
        key.startsWith(`review-access-identity:${tokenHash}:`),
      ),
    ).toHaveLength(50);
    expect(
      [...counts.entries()].find(([key]) =>
        key.startsWith("review-access-source:"),
      )?.[1],
    ).toBe(50);
    expect(
      [...counts.keys()].some((key) =>
        key.includes("shared-corporate-source") ||
        key.includes("reviewer-1@example.test"),
      ),
    ).toBe(false);
  });

  test("bounds one public source even when an attacker rotates random tokens", async () => {
    const { enforce } = memoryReviewRateLimiter();

    for (let attempt = 1; attempt <= 128; attempt += 1) {
      await enforceReviewAccessSourceRateLimit("rotating-token-source", enforce);
    }
    await expect(
      enforceReviewAccessSourceRateLimit("rotating-token-source", enforce),
    ).rejects.toMatchObject({ code: "review_access_rate_limited" });
  });

  test("keeps failed source-token attempts and each identity at eight while bounding the token at 64", async () => {
    const { enforce } = memoryReviewRateLimiter();
    const identitySecret = "s".repeat(64);
    const sourceTokenHash = hashReviewAccessToken("source-bound-token");

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await enforceReviewAccessFailureRateLimit(
        {
          tokenHash: sourceTokenHash,
          source: "one-source",
        },
        enforce,
      );
    }
    await expect(
      enforceReviewAccessFailureRateLimit(
        {
          tokenHash: sourceTokenHash,
          source: "one-source",
        },
        enforce,
      ),
    ).rejects.toMatchObject({ code: "review_access_rate_limited" });

    const identityTokenHash = hashReviewAccessToken("identity-bound-token");
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await enforceReviewAccessTokenAndIdentityRateLimits(
        {
          tokenHash: identityTokenHash,
          identity: "same-reviewer@example.test",
          identitySecret,
        },
        enforce,
      );
    }
    await expect(
      enforceReviewAccessTokenAndIdentityRateLimits(
        {
          tokenHash: identityTokenHash,
          identity: "same-reviewer@example.test",
          identitySecret,
        },
        enforce,
      ),
    ).rejects.toMatchObject({ code: "review_access_rate_limited" });

    const globalTokenHash = hashReviewAccessToken("globally-bounded-token");
    for (let attempt = 1; attempt <= 64; attempt += 1) {
      await enforceReviewAccessTokenAndIdentityRateLimits(
        {
          tokenHash: globalTokenHash,
          identity: `global-reviewer-${attempt}@example.test`,
          identitySecret,
        },
        enforce,
      );
    }
    await expect(
      enforceReviewAccessTokenAndIdentityRateLimits(
        {
          tokenHash: globalTokenHash,
          identity: "global-reviewer-65@example.test",
          identitySecret,
        },
        enforce,
      ),
    ).rejects.toMatchObject({ code: "review_access_rate_limited" });
  });

  test("derives terminal and decision states without mutating the stored round", () => {
    const open = { status: "open", revokedAt: null, expiresAt: null, decision: null, items: [] };
    expect(deriveReviewRoundStatus({ ...open, decision: "approved" })).toBe("approved");
    expect(deriveReviewRoundStatus({ ...open, items: [{ currentDecision: "changes_requested" }] })).toBe("changes_requested");
    expect(deriveReviewRoundStatus({ ...open, expiresAt: new Date("2026-01-01T00:00:00Z") }, new Date("2026-01-02T00:00:00Z"))).toBe("expired");
    expect(deriveReviewRoundStatus({ ...open, revokedAt: new Date("2026-01-01T00:00:00Z"), decision: "approved" })).toBe("revoked");
  });

  test("binds automation retries to one workspace, project, and exact request", () => {
    const request = {
      title: "Private campaign launch",
      message: "Customer-only review context",
      passcode: "very-secret-passcode",
      expiresAt: null,
      allowDownloads: false,
      approvalRequired: true,
      recipientEmails: ["reviewer@example.test"],
      sourceRoundId: null,
      items: [{
        clipId: crypto.randomUUID(),
        exportId: crypto.randomUUID(),
        expectedEditorRevision: 3,
        variantIds: [crypto.randomUUID()],
        required: true,
      }],
    };
    const first = reviewRoundAutomationFingerprint({
      workspaceId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      request,
    });
    const otherTenant = reviewRoundAutomationFingerprint({
      workspaceId: crypto.randomUUID(),
      projectId: crypto.randomUUID(),
      request,
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(otherTenant);
    expect(first).not.toContain(request.title);
    expect(first).not.toContain(request.passcode);
  });
});

describe("Review project policy snapshot", () => {
  test("keeps Review creation and view advisory after the live profile becomes required", () => {
    const profileId = crypto.randomUUID();
    const project = {
      brandProfileId: profileId,
      brandProfileSnapshot: brandProfileSnapshot(profileId, "none"),
      brandProfile: { approvalRule: "none" },
    };

    expect(frozenProjectApprovalRequired(project)).toBe(false);
    project.brandProfile.approvalRule = "approval_required";
    expect(frozenProjectApprovalRequired(project)).toBe(false);
  });

  test("keeps Review creation and view required after the live profile becomes advisory", () => {
    const profileId = crypto.randomUUID();
    const project = {
      brandProfileId: profileId,
      brandProfileSnapshot: brandProfileSnapshot(
        profileId,
        "approval_required",
      ),
      brandProfile: { approvalRule: "approval_required" },
    };

    expect(frozenProjectApprovalRequired(project)).toBe(true);
    project.brandProfile.approvalRule = "none";
    expect(frozenProjectApprovalRequired(project)).toBe(true);
  });

  test("fails closed only when an attached profile lacks its required frozen snapshot", () => {
    expect(
      frozenProjectApprovalRequired({
        brandProfileId: crypto.randomUUID(),
        brandProfileSnapshot: null,
      }),
    ).toBe(true);
    expect(
      frozenProjectApprovalRequired({
        brandProfileId: null,
        brandProfileSnapshot: null,
      }),
    ).toBe(false);
  });
});

describe("Review staged controls", () => {
  const secret = "s".repeat(64);
  const scope = {
    actorUserId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
  };

  test("denies each disabled seam before reading or mutating durable state", async () => {
    const service = new ReviewService(createReviewRolloutPolicy({}));

    await expect(service.createRound({
      ...scope,
      pricingTier: "business",
    }, {})).rejects.toBeInstanceOf(ProgramWriteDisabledError);
    await expect(service.authenticate(
      "opaque-token",
      {},
      "203.0.113.1",
      secret,
    )).rejects.toMatchObject({
      code: "review_access_temporarily_unavailable",
    });
    await expect(service.readRound("durable-session", secret)).rejects
      .toMatchObject({ code: "review_access_temporarily_unavailable" });
    await expect(service.addComment("durable-session", secret, {})).rejects
      .toMatchObject({ code: "review_feedback_temporarily_unavailable" });
    await expect(service.addInternalComment(
      scope,
      crypto.randomUUID(),
      {},
    )).rejects.toMatchObject({
      code: "review_feedback_temporarily_unavailable",
    });
    await expect(service.resendRound(
      scope,
      crypto.randomUUID(),
      crypto.randomUUID(),
    )).rejects.toMatchObject({
      code: "review_notifications_temporarily_unavailable",
    });
    await expect(service.retryNotification(
      scope,
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    )).rejects.toMatchObject({
      code: "review_notifications_temporarily_unavailable",
    });
  });

  test("denies round creation before durable work when the Campaign review stage is paused", async () => {
    const service = new ReviewService(
      createReviewRolloutPolicy({
        NARRIFLOW_WRITES_REVIEW_ROOMS: "1",
      }),
      {
        render: true,
        exports: true,
        creative: true,
        delivery: true,
        review: false,
        scheduling: false,
      },
    );

    await expect(
      service.createRound(
        {
          ...scope,
          pricingTier: "business",
        },
        {},
      ),
    ).rejects.toMatchObject({
      code: "program_write_disabled",
      group: "campaign_operations",
    });
  });

  test("uses a generic guest denial that carries no token or round metadata", async () => {
    const service = new ReviewService(createReviewRolloutPolicy({
      NARRIFLOW_WRITES_REVIEW_ROOMS: "1",
      NARRIFLOW_WRITES_REVIEW_FEEDBACK: "1",
      NARRIFLOW_WRITES_REVIEW_NOTIFICATIONS: "1",
    }));
    const token = "private-review-capability";

    const error = await service.authenticate(
      token,
      {},
      "203.0.113.1",
      secret,
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ReviewServiceError);
    expect(error).toMatchObject({
      code: "review_access_temporarily_unavailable",
      message: "Review access is temporarily unavailable",
    });
    expect(JSON.stringify(error)).not.toContain(token);
    expect(error.message).not.toContain(scope.projectId);
  });
});

describe("Review notification retry idempotency", () => {
  const sourceNotificationId = "10000000-0000-4000-8000-000000000001";
  const retryNotificationId = "10000000-0000-4000-8000-000000000002";
  const idempotencyKey = "10000000-0000-4000-8000-000000000003";
  const retrySource = reviewNotificationRetrySource(
    sourceNotificationId,
    idempotencyKey,
  );

  test("reserves one immutable retry notification and replays it after delivery", async () => {
    let retry: { id: string; status: string } | null = null;
    let auditWrites = 0;
    const store = {
      async readSource() {
        return {
          id: sourceNotificationId,
          reviewRoundId: "round-1",
          recipientId: "recipient-1",
          kind: "round_sent",
          status: "failed",
        };
      },
      async findRetry() {
        return retry;
      },
      async reserveRetry() {
        if (retry) return { notification: retry, created: false };
        retry = { id: retryNotificationId, status: "pending" };
        return { notification: retry, created: true };
      },
      async recordRetryAudit() {
        auditWrites += 1;
      },
    };

    const first = await retryReviewNotification(store, {
      scope: {
        actorUserId: "actor-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
      },
      roundId: "round-1",
      notificationId: sourceNotificationId,
      idempotencyKey,
      createId: () => retryNotificationId,
    });
    retry = { id: retryNotificationId, status: "sent" };
    const replay = await retryReviewNotification(store, {
      scope: {
        actorUserId: "actor-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
      },
      roundId: "round-1",
      notificationId: sourceNotificationId,
      idempotencyKey,
      createId: () => "must-not-be-used",
    });

    expect(first).toEqual({ notificationId: retryNotificationId, replayed: false });
    expect(replay).toEqual({ notificationId: retryNotificationId, replayed: true });
    expect(auditWrites).toBe(1);
    expect(reviewNotificationRetrySourceId(retrySource)).toBe(sourceNotificationId);
  });

  test("does not reset a pending notification when no matching retry exists", async () => {
    const store = {
      async readSource() {
        return {
          id: sourceNotificationId,
          reviewRoundId: "round-1",
          recipientId: "recipient-1",
          kind: "round_sent",
          status: "pending",
        };
      },
      async findRetry() {
        return null;
      },
      async reserveRetry() {
        throw new Error("must not reserve");
      },
      async recordRetryAudit() {
        throw new Error("must not audit");
      },
    };

    await expect(
      retryReviewNotification(store, {
        scope: {
          actorUserId: "actor-1",
          workspaceId: "workspace-1",
          projectId: "project-1",
        },
        roundId: "round-1",
        notificationId: sourceNotificationId,
        idempotencyKey,
        createId: () => retryNotificationId,
      }),
    ).rejects.toMatchObject({ code: "review_notification_not_retryable" });
  });
});
