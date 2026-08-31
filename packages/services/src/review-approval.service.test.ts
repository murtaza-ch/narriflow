import { describe, expect, test } from "bun:test";
import {
  ReviewApprovalRequiredError,
  ReviewOverrideForbiddenError,
  createInMemoryReviewApprovalStore,
  createReviewApprovalService,
  evaluateReviewApproval,
} from "./review-approval.service";
import { frozenProjectApprovalRequired } from "./review-project-policy";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("exact-export review approval", () => {
  test("exposes the frozen Project approval policy for campaign routing without an export", async () => {
    const service = createReviewApprovalService({
      store: createInMemoryReviewApprovalStore({
        projectApprovalRequired: true,
        exports: [],
      }),
      authorizeOverride: async () => undefined,
    });

    await expect(
      service.inspectProjectPolicy({
        workspaceId: id(1),
        projectId: id(2),
      }),
    ).resolves.toEqual({ approvalRequired: true });
  });

  test("advisory projects publish without a review", () => {
    expect(evaluateReviewApproval({
      projectApprovalRequired: false,
      exports: [{ exportId: id(1), evidence: [] }],
    })).toEqual({
      eligible: true,
      items: [{ exportId: id(1), eligible: true, required: false, code: null, roundId: null }],
    });
  });

  test("required projects reject missing, partial, changed, and inactive evidence", () => {
    const result = evaluateReviewApproval({
      projectApprovalRequired: true,
      exports: [
        { exportId: id(1), evidence: [] },
        { exportId: id(2), evidence: [{ roundId: id(20), approvalRequired: true, accessState: "open", itemDecision: "approved", campaignDecision: null }] },
        { exportId: id(3), evidence: [{ roundId: id(30), approvalRequired: true, accessState: "open", itemDecision: "changes_requested", campaignDecision: null }] },
        { exportId: id(4), evidence: [{ roundId: id(40), approvalRequired: true, accessState: "revoked", itemDecision: "approved", campaignDecision: "approved" }] },
      ],
    });

    expect(result.eligible).toBe(false);
    expect(result.items.map((item) => item.code)).toEqual([
      "review_approval_missing",
      "review_campaign_unapproved",
      "review_changes_requested",
      "review_round_inactive",
    ]);
  });

  test("campaign approval permits only the exact submitted export", () => {
    const result = evaluateReviewApproval({
      projectApprovalRequired: true,
      exports: [
        { exportId: id(1), evidence: [{ roundId: id(10), approvalRequired: true, accessState: "open", itemDecision: "approved", campaignDecision: "approved" }] },
        { exportId: id(2), evidence: [] },
      ],
    });

    expect(result.items[0]).toMatchObject({ eligible: true, roundId: id(10) });
    expect(result.items[1]).toMatchObject({ eligible: false, code: "review_approval_missing" });
  });

  test("a resubmission cannot inherit approval from its superseded export", () => {
    const result = evaluateReviewApproval({
      projectApprovalRequired: true,
      exports: [
        {
          exportId: id(1),
          evidence: [{
            roundId: id(10),
            approvalRequired: true,
            accessState: "superseded",
            itemDecision: "approved",
            campaignDecision: "approved",
          }],
        },
        {
          exportId: id(2),
          evidence: [{
            roundId: id(11),
            approvalRequired: true,
            accessState: "open",
            itemDecision: null,
            campaignDecision: null,
          }],
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      eligible: false,
      code: "review_round_inactive",
    });
    expect(result.items[1]).toMatchObject({
      eligible: false,
      code: "review_item_unapproved",
    });
  });

  test("a required Review Round keeps its gate when the Brand Profile is advisory", () => {
    const result = evaluateReviewApproval({
      projectApprovalRequired: false,
      exports: [{ exportId: id(1), evidence: [{ roundId: id(10), approvalRequired: true, accessState: "expired", itemDecision: "approved", campaignDecision: "approved" }] }],
    });

    expect(result).toMatchObject({ eligible: false, items: [{ required: true, code: "review_round_inactive" }] });
  });
});

describe("review approval authorization", () => {
  test("authorizes exact exports from the frozen project rule, not a later live-profile mutation", async () => {
    const profileId = id(90);
    const frozenAdvisory = {
      version: 1 as const,
      profileId,
      profileRevision: 1,
      name: "Frozen advisory profile",
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
      approvalRule: "none" as const,
      style: null,
    };
    let liveApprovalRule: "none" | "approval_required" = "none";
    const service = createReviewApprovalService({
      store: createInMemoryReviewApprovalStore({
        projectApprovalRequired: frozenProjectApprovalRequired({
          brandProfileId: profileId,
          brandProfileSnapshot: frozenAdvisory,
        }),
        exports: [{ exportId: id(1), evidence: [] }],
      }),
      authorizeOverride: async () => undefined,
    });

    liveApprovalRule = "approval_required";
    expect(liveApprovalRule).toBe("approval_required");
    await expect(service.authorizeExactExports({
      principal: { kind: "worker" },
      workspaceId: id(2),
      projectId: id(3),
      exportIds: [id(1)],
      idempotencyKey: id(4),
      overrideReason: null,
    })).resolves.toMatchObject({ eligible: true, overridden: false });
  });

  test("keeps exact-export authorization required after the live profile becomes advisory", async () => {
    const profileId = id(91);
    const frozenRequired = {
      version: 1 as const,
      profileId,
      profileRevision: 1,
      name: "Frozen required profile",
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
      approvalRule: "approval_required" as const,
      style: null,
    };
    let liveApprovalRule: "none" | "approval_required" = "approval_required";
    const service = createReviewApprovalService({
      store: createInMemoryReviewApprovalStore({
        projectApprovalRequired: frozenProjectApprovalRequired({
          brandProfileId: profileId,
          brandProfileSnapshot: frozenRequired,
        }),
        exports: [{ exportId: id(1), evidence: [] }],
      }),
      authorizeOverride: async () => undefined,
    });

    liveApprovalRule = "none";
    expect(liveApprovalRule).toBe("none");
    await expect(service.authorizeExactExports({
      principal: { kind: "worker" },
      workspaceId: id(2),
      projectId: id(3),
      exportIds: [id(1)],
      idempotencyKey: id(4),
      overrideReason: null,
    })).rejects.toBeInstanceOf(ReviewApprovalRequiredError);
  });

  test("warn-only still evaluates exact exports without fabricating an override", async () => {
    const store = createInMemoryReviewApprovalStore({
      projectApprovalRequired: true,
      exports: [{ exportId: id(1), evidence: [] }],
    });
    const warnings: unknown[] = [];
    const service = createReviewApprovalService({
      store,
      authorizeOverride: async () => {
        throw new Error("warn-only must not authorize an override");
      },
      rolloutPolicy: { modeFor: () => "warn" },
      onWarn: (warning) => warnings.push(warning),
    });

    const result = await service.authorizeExactExports({
      principal: { kind: "api_key", apiKeyId: id(9) },
      workspaceId: id(2),
      projectId: id(3),
      exportIds: [id(1)],
      idempotencyKey: id(4),
      overrideReason: "This reason must not become an override.",
    });

    expect(result).toMatchObject({
      eligible: true,
      overridden: false,
      overrideAuditId: null,
      items: [{
        exportId: id(1),
        eligible: false,
        code: "review_approval_missing",
      }],
    });
    expect(await store.countOverrides()).toBe(0);
    expect(warnings).toEqual([{
      level: "warn",
      message: "review_approval_warn_only",
      workspaceId: id(2),
      projectId: id(3),
      requiredExportCount: 1,
      blockedExportCount: 1,
      failureCodes: ["review_approval_missing"],
    }]);
    expect(JSON.stringify(warnings)).not.toContain(id(1));
    expect(JSON.stringify(warnings)).not.toContain("This reason");
  });

  test("uses the workspace and project rollout decision before enforcing", async () => {
    const store = createInMemoryReviewApprovalStore({
      projectApprovalRequired: true,
      exports: [{ exportId: id(1), evidence: [] }],
    });
    const service = createReviewApprovalService({
      store,
      authorizeOverride: async () => undefined,
      rolloutPolicy: {
        modeFor: ({ projectId }) => projectId === id(3) ? "enforce" : "warn",
      },
      onWarn: () => undefined,
    });

    await expect(service.authorizeExactExports({
      principal: { kind: "worker" },
      workspaceId: id(2),
      projectId: id(3),
      exportIds: [id(1)],
      idempotencyKey: id(4),
      overrideReason: null,
    })).rejects.toBeInstanceOf(ReviewApprovalRequiredError);

    await expect(service.authorizeExactExports({
      principal: { kind: "worker" },
      workspaceId: id(2),
      projectId: id(8),
      exportIds: [id(1)],
      idempotencyKey: id(5),
      overrideReason: null,
    })).resolves.toMatchObject({
      eligible: true,
      overridden: false,
      overrideAuditId: null,
    });
  });

  test("blocks unapproved exports and never lets API keys or workers override", async () => {
    const store = createInMemoryReviewApprovalStore({
      projectApprovalRequired: true,
      exports: [{ exportId: id(1), evidence: [] }],
    });
    const service = createReviewApprovalService({
      store,
      authorizeOverride: async () => undefined,
    });

    await expect(service.authorizeExactExports({
      principal: { kind: "api_key", apiKeyId: id(9) },
      workspaceId: id(2),
      projectId: id(3),
      exportIds: [id(1)],
      idempotencyKey: id(4),
      overrideReason: "Approved outside the room.",
    })).rejects.toBeInstanceOf(ReviewOverrideForbiddenError);

    await expect(service.authorizeExactExports({
      principal: { kind: "worker" },
      workspaceId: id(2),
      projectId: id(3),
      exportIds: [id(1)],
      idempotencyKey: id(5),
      overrideReason: null,
    })).rejects.toBeInstanceOf(ReviewApprovalRequiredError);
  });

  test("records one reasoned owner or admin override and replays it idempotently", async () => {
    const store = createInMemoryReviewApprovalStore({
      projectApprovalRequired: true,
      exports: [{ exportId: id(1), evidence: [] }],
    });
    const authorizedActors: string[] = [];
    const service = createReviewApprovalService({
      store,
      authorizeOverride: async ({ actorUserId }) => { authorizedActors.push(actorUserId); },
    });
    const input = {
      principal: { kind: "browser" as const, actorUserId: id(7) },
      workspaceId: id(2),
      projectId: id(3),
      exportIds: [id(1)],
      idempotencyKey: id(4),
      overrideReason: "Client approved by phone after viewing this export.",
    };

    const first = await service.authorizeExactExports(input);
    const replay = await service.authorizeExactExports(input);

    expect(first).toMatchObject({ eligible: true, overridden: true });
    expect(replay.overrideAuditId).toBe(first.overrideAuditId);
    expect(await store.countOverrides()).toBe(1);
    expect(authorizedActors).toEqual([id(7), id(7)]);
  });

  test("does not create an override when the actor lacks review.override", async () => {
    const store = createInMemoryReviewApprovalStore({
      projectApprovalRequired: true,
      exports: [{ exportId: id(1), evidence: [] }],
    });
    const service = createReviewApprovalService({
      store,
      authorizeOverride: async () => { throw new ReviewOverrideForbiddenError(); },
    });

    await expect(service.authorizeExactExports({
      principal: { kind: "browser", actorUserId: id(7) },
      workspaceId: id(2),
      projectId: id(3),
      exportIds: [id(1)],
      idempotencyKey: id(4),
      overrideReason: "Editor tried to bypass approval.",
    })).rejects.toBeInstanceOf(ReviewOverrideForbiddenError);
    expect(await store.countOverrides()).toBe(0);
  });
});
