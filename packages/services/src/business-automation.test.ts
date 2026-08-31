import { describe, expect, test } from "bun:test";

import {
  createBusinessAutomation,
  createProductionBusinessAutomation,
  type BusinessAutomationDependencies,
} from "./business-automation";

const workspaceId = "20000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000002";
const projectId = "20000000-0000-4000-8000-000000000003";
const clipId = "20000000-0000-4000-8000-000000000004";
const jobId = "20000000-0000-4000-8000-000000000005";
const idempotencyKey = "20000000-0000-4000-8000-000000000006";

const actor = {
  userId,
  workspaceId,
  workspaceName: "Editorial",
  workspaceOwnerUserId: userId,
  role: "owner" as const,
  status: "active" as const,
  pricingTier: "business" as const,
  isPersonalWorkspace: false,
  automationPrincipal: {
    kind: "api_key" as const,
    apiKeyId: "20000000-0000-4000-8000-000000000007",
  },
};

function dependencies(
  overrides: Partial<BusinessAutomationDependencies> = {},
): BusinessAutomationDependencies {
  return {
    async listBrandProfiles() {
      return [{
        id: jobId,
        name: "Acme",
        slug: "acme",
        revision: 1,
        identity: {},
        voice: {},
        approvalRule: "none",
        assets: [{ id: clipId, accessUrl: "https://signed.example/secret", missing: false }],
        fonts: [{ id: jobId, accessUrl: "https://signed.example/font", missing: false }],
        templates: [],
        audio: [],
      }];
    },
    async getBrandProfile() {
      throw new Error("unused");
    },
    async applyCampaignMotion() {
      return { operationId: jobId, status: "completed", replayed: false };
    },
    async applyCampaignBrandProfile() {
      throw new Error("unused");
    },
    async applyCampaignStyle() {
      throw new Error("unused");
    },
    async applyCampaignSceneTemplate() {
      throw new Error("unused");
    },
    async previewCampaignEditorAction() {
      throw new Error("unused");
    },
    async getCampaignEditorActionCatalog() {
      throw new Error("unused");
    },
    async listCampaignOperations() {
      return [];
    },
    async createReviewRound(_scope, _projectId, input) {
      return {
        id: input.idempotencyKey,
        revision: 1,
        createdAt: new Date("2026-08-31T00:00:00Z"),
        token: "guest-token-must-not-leak",
        path: "/review/guest-token-must-not-leak",
        notificationIds: [jobId],
        replayed: false,
      };
    },
    async listReviewRounds() {
      return {
        project: { id: projectId, title: "Customer title" },
        candidates: [],
        rounds: [{
          id: jobId,
          revision: 1,
          status: "open",
          title: "Private review title",
          message: "Private review message",
          approvalRequired: true,
          allowDownloads: false,
          sentAt: new Date("2026-08-31T00:00:00Z"),
          expiresAt: null,
          revokedAt: null,
          supersededAt: null,
          decision: null,
          decidedAt: null,
          createdAt: new Date("2026-08-31T00:00:00Z"),
          updatedAt: new Date("2026-08-31T00:00:00Z"),
          recipients: [{ email: "reviewer@example.test" }],
          comments: [{ body: "Customer comment" }],
          auditEvents: [{ metadata: { passcode: "nope" } }],
          items: [],
          notifications: [],
          newerWorkAvailable: false,
        }],
      };
    },
    async generateAssistedCopy() {
      throw new Error("unused");
    },
    async getAssistedCopy() {
      throw new Error("unused");
    },
    async requestThumbnailExtraction() {
      throw new Error("unused");
    },
    async getThumbnailExtraction() {
      throw new Error("unused");
    },
    async bulkSchedule() {
      throw new Error("unused");
    },
    async submitGeneratedMedia() {
      return {
        id: jobId,
        workspaceId,
        projectId,
        clipId,
        kind: "image",
        status: "queued",
        provider: "openai",
        model: "configured-model",
        promptOrigin: {
          kind: "transcript_selection",
          sourceIds: [`clip:${clipId}:transcript:word-1`],
        },
        aspectRatio: "9:16",
        style: "editorial",
        durationSec: null,
        resultAssetId: null,
        insertionCount: 0,
        lastInsertionKind: null,
        lastInsertedAt: null,
        errorCode: null,
        moderation: { outcome: "pending", stage: null, categories: [] },
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:00.000Z",
        replayed: false,
        providerPayload: { secret: true },
        resultUrl: "https://signed.example/result",
      };
    },
    async getGeneratedMedia() {
      throw new Error("unused");
    },
    ...overrides,
  };
}

describe("Business automation workflow interface", () => {
  test("returns brand records without signed asset or font URLs", async () => {
    const automation = createBusinessAutomation(dependencies());
    const result = await automation.listBrandProfiles(actor, { limit: 20 });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("signed.example");
    expect(result[0]).toMatchObject({ id: jobId, name: "Acme" });
  });

  test("creates an idempotent review round without exposing access capabilities", async () => {
    const automation = createBusinessAutomation(dependencies());
    const result = await automation.createReviewRound(actor, projectId, {
      idempotencyKey,
      title: "Client cut",
      recipientEmails: ["reviewer@example.test"],
      items: [{
        clipId,
        exportId: jobId,
        expectedEditorRevision: 2,
        variantIds: [idempotencyKey],
      }],
    });

    expect(result).toEqual({
      roundId: idempotencyKey,
      revision: 1,
      createdAt: "2026-08-31T00:00:00.000Z",
      replayed: false,
    });
    expect(JSON.stringify(result)).not.toContain("guest-token");
    expect(JSON.stringify(result)).not.toContain("reviewer@example.test");
  });

  test("projects review reads to typed status without recipients or customer text", async () => {
    const automation = createBusinessAutomation(dependencies());
    const result = await automation.listReviewRounds(actor, projectId);
    const encoded = JSON.stringify(result);
    expect(result.rounds[0]).toMatchObject({ roundId: jobId, status: "open" });
    expect(encoded).not.toContain("reviewer@example.test");
    expect(encoded).not.toContain("Private review");
    expect(encoded).not.toContain("Customer comment");
    expect(encoded).not.toContain("passcode");
  });

  test("keeps assisted-copy provenance in the sanitized status projection", async () => {
    const automation = createBusinessAutomation(dependencies({
      async getAssistedCopy() {
        return {
          id: jobId,
          clipId,
          platform: "youtube_shorts",
          status: "completed",
          revision: 1,
          content: { caption: "Reviewed caption", hashtags: ["launch"], title: "Launch" },
          confirmed: false,
          moderationOutcome: "accepted",
          guidanceSkipped: false,
          errorCode: null,
          modelAlias: "configured-copy-alias",
          promptVersion: "assisted-copy-v1",
          replayed: false,
        };
      },
    }));

    await expect(automation.getAssistedCopy(actor, projectId, jobId)).resolves.toMatchObject({
      draftId: jobId,
      modelAlias: "configured-copy-alias",
      promptVersion: "assisted-copy-v1",
    });
  });

  test("projects campaign catalog and previews without editor documents or media access", async () => {
    const automation = createBusinessAutomation(dependencies({
      async getCampaignEditorActionCatalog() {
        return {
          profile: {
            id: jobId,
            name: "Acme",
            fingerprint: "a".repeat(64),
            styleFingerprint: null,
            currentStyle: null,
            internalSnapshot: { storageUrl: "https://signed.example/brand" },
          },
          styles: [],
          scenes: [],
          rawEditorDocument: { version: 2 },
        };
      },
      async previewCampaignEditorAction() {
        return {
          action: "apply_style",
          requestedCount: 1,
          counts: { eligible: 1, unchanged: 0, stale: 0, ineligible: 0 },
          items: [{
            clipId,
            expectedEditorRevision: 1,
            currentEditorRevision: 1,
            status: "eligible",
            code: null,
            patch: [{ op: "replace", path: "/caption" }],
          }],
          editorDocument: { version: 2 },
        };
      },
    }));
    const catalog = await automation.getCampaignEditorActionCatalog(actor, projectId);
    const preview = await automation.previewCampaignEditorAction(actor, projectId, {
      action: "apply_style",
      input: {
        templateId: jobId,
        templateFingerprint: "b".repeat(64),
        clips: [{ clipId, expectedEditorRevision: 1 }],
      },
    });
    const encoded = JSON.stringify({ catalog, preview });
    expect(encoded).not.toContain("signed.example");
    expect(encoded).not.toContain("rawEditorDocument");
    expect(encoded).not.toContain("editorDocument");
    expect(encoded).not.toContain("patch");
    expect(preview).toMatchObject({
      action: "apply_style",
      counts: { eligible: 1 },
    });
  });

  test("fails closed when a dependency returns an invented lifecycle state", async () => {
    const automation = createBusinessAutomation(dependencies({
      async applyCampaignMotion() {
        return {
          operationId: jobId,
          action: "apply_motion",
          status: "invented",
          replayed: false,
        };
      },
    }));

    await expect(
      automation.applyCampaignMotion(
        actor,
        projectId,
        idempotencyKey,
        {
          clips: [{ clipId, expectedEditorRevision: 1 }],
          change: {
            scope: "clip_transition",
            transition: { type: "wipe-left", durationSec: 0.4 },
          },
        },
      ),
    ).rejects.toThrow("business_automation_projection_invalid");
  });

  test("fails closed when a Campaign Operation omits required facts", async () => {
    const automation = createBusinessAutomation(dependencies({
      async applyCampaignMotion() {
        return {
          operationId: jobId,
          action: "apply_motion",
          status: "completed",
        };
      },
    }));

    await expect(
      automation.applyCampaignMotion(
        actor,
        projectId,
        idempotencyKey,
        {
          clips: [{ clipId, expectedEditorRevision: 1 }],
          change: {
            scope: "clip_transition",
            transition: { type: "wipe-left", durationSec: 0.4 },
          },
        },
      ),
    ).rejects.toThrow("business_automation_projection_invalid");
  });

  test("fails closed when a required nullable timestamp is omitted", async () => {
    const automation = createBusinessAutomation(dependencies({
      async applyCampaignMotion() {
        return {
          operationId: jobId,
          status: "completed",
          requestedCount: 0,
          counts: { succeeded: 0, unchanged: 0, stale: 0, ineligible: 0, failed: 0 },
          items: [],
          createdAt: null,
          replayed: false,
        };
      },
    }));

    await expect(
      automation.applyCampaignMotion(
        actor,
        projectId,
        idempotencyKey,
        {
          clips: [{ clipId, expectedEditorRevision: 1 }],
          change: {
            scope: "clip_transition",
            transition: { type: "wipe-left", durationSec: 0.4 },
          },
        },
      ),
    ).rejects.toThrow("business_automation_projection_invalid");
  });

  test("fails closed when a required nullable string is omitted", async () => {
    const automation = createBusinessAutomation(dependencies({
      async applyCampaignMotion() {
        return {
          operationId: jobId,
          status: "completed",
          requestedCount: 1,
          counts: { succeeded: 1, unchanged: 0, stale: 0, ineligible: 0, failed: 0 },
          items: [{
            requestedClipId: clipId,
            expectedEditorRevision: 1,
            status: "succeeded",
            settledAt: null,
          }],
          createdAt: null,
          completedAt: null,
          replayed: false,
        };
      },
    }));

    await expect(
      automation.applyCampaignMotion(
        actor,
        projectId,
        idempotencyKey,
        {
          clips: [{ clipId, expectedEditorRevision: 1 }],
          change: {
            scope: "clip_transition",
            transition: { type: "wipe-left", durationSec: 0.4 },
          },
        },
      ),
    ).rejects.toThrow("business_automation_projection_invalid");
  });

  test("fails closed when Thumbnail Extraction omits its asset field", async () => {
    const automation = createBusinessAutomation(dependencies({
      async getThumbnailExtraction() {
        return {
          id: jobId,
          status: "queued",
          attempts: 0,
          platform: "youtube_shorts",
          exportVariantId: clipId,
          sourceTimeMs: 0,
          errorCode: null,
          replayed: false,
        };
      },
    }));

    await expect(
      automation.getThumbnailExtraction(actor, projectId, jobId),
    ).rejects.toThrow("business_automation_projection_invalid");
  });

  test("fails closed when a Campaign Operation omits its item collection", async () => {
    const automation = createBusinessAutomation(dependencies({
      async applyCampaignMotion() {
        return {
          operationId: jobId,
          status: "completed",
          requestedCount: 0,
          counts: { succeeded: 0, unchanged: 0, stale: 0, ineligible: 0, failed: 0 },
          createdAt: null,
          completedAt: null,
          replayed: false,
        };
      },
    }));

    await expect(
      automation.applyCampaignMotion(
        actor,
        projectId,
        idempotencyKey,
        {
          clips: [{ clipId, expectedEditorRevision: 1 }],
          change: {
            scope: "clip_transition",
            transition: { type: "wipe-left", durationSec: 0.4 },
          },
        },
      ),
    ).rejects.toThrow("business_automation_projection_invalid");
  });

  test("fails closed when a Review Round omits its notification collection", async () => {
    const automation = createBusinessAutomation(dependencies({
      async listReviewRounds() {
        return {
          project: { id: projectId },
          rounds: [{
            id: jobId,
            revision: 1,
            status: "open",
            approvalRequired: true,
            allowDownloads: false,
            sentAt: null,
            expiresAt: null,
            revokedAt: null,
            supersededAt: null,
            decision: null,
            decidedAt: null,
            newerWorkAvailable: false,
            items: [],
            createdAt: null,
            updatedAt: null,
          }],
        };
      },
    }));

    await expect(
      automation.listReviewRounds(actor, projectId),
    ).rejects.toThrow("business_automation_projection_invalid");
  });

  test("fails closed when a campaign preview omits a nullable revision", async () => {
    const automation = createBusinessAutomation(dependencies({
      async previewCampaignEditorAction() {
        return {
          action: "apply_style",
          requestedCount: 1,
          counts: { eligible: 1, unchanged: 0, stale: 0, ineligible: 0 },
          items: [{
            clipId,
            expectedEditorRevision: 1,
            status: "eligible",
            code: null,
          }],
        };
      },
    }));

    await expect(
      automation.previewCampaignEditorAction(actor, projectId, {
        action: "apply_style",
        input: {
          templateId: jobId,
          templateFingerprint: "a".repeat(64),
          clips: [{ clipId, expectedEditorRevision: 1 }],
        },
      }),
    ).rejects.toThrow("business_automation_projection_invalid");
  });

  test("fails closed when assisted copy omits nullable content", async () => {
    const automation = createBusinessAutomation(dependencies({
      async getAssistedCopy() {
        return {
          id: jobId,
          clipId,
          platform: "youtube_shorts",
          status: "generating",
          revision: 1,
          confirmed: false,
          moderationOutcome: "pending",
          modelAlias: null,
          promptVersion: null,
          guidanceSkipped: false,
          errorCode: null,
          replayed: false,
        };
      },
    }));

    await expect(
      automation.getAssistedCopy(actor, projectId, jobId),
    ).rejects.toThrow("business_automation_projection_invalid");
  });

  test("fails closed when Generated Media omits nullable duration", async () => {
    const automation = createBusinessAutomation(dependencies({
      async getGeneratedMedia() {
        return {
          id: jobId,
          projectId,
          clipId: null,
          kind: "image",
          status: "queued",
          aspectRatio: "9:16",
          style: "editorial",
          resultAssetId: null,
          insertionCount: 0,
          lastInsertionKind: null,
          lastInsertedAt: null,
          errorCode: null,
          moderation: { outcome: "pending" },
          createdAt: null,
          updatedAt: null,
          replayed: false,
        };
      },
    }));

    await expect(
      automation.getGeneratedMedia(actor, jobId),
    ).rejects.toThrow("business_automation_projection_invalid");
  });

  test("returns generated-media status without provider controls, sources, or URLs", async () => {
    const automation = createBusinessAutomation(dependencies());
    const result = await automation.submitGeneratedMedia(actor, {
      idempotencyKey,
      projectId,
      clipId,
      kind: "image",
      prompt: "Customer prompt",
      includeDerivedContext: true,
      promptOrigin: {
        kind: "transcript_selection",
        sourceIds: [`clip:${clipId}:transcript:4:1`],
      },
      aspectRatio: "9:16",
      style: "editorial",
    });
    const encoded = JSON.stringify(result);
    expect(result).toMatchObject({ jobId, status: "queued", kind: "image" });
    for (const secret of [
      "openai",
      "configured-model",
			"transcript:4:1",
      "providerPayload",
      "signed.example",
      "Customer prompt",
      "Customer transcript",
    ]) {
      expect(encoded).not.toContain(secret);
    }
  });

  test("rejects low-level fields through the shared validator before mutation", async () => {
    let submissions = 0;
    const automation = createBusinessAutomation(dependencies({
      async submitGeneratedMedia() {
        submissions += 1;
        throw new Error("must not run");
      },
    }));
    await expect(
      automation.submitGeneratedMedia(actor, {
        idempotencyKey,
        projectId,
        clipId: null,
        kind: "image",
        prompt: "Safe prompt",
        promptOrigin: { kind: "manual", sourceIds: [] },
        aspectRatio: "1:1",
        style: "minimal",
        provider: "raw-provider-control",
      }),
    ).rejects.toBeDefined();
    await expect(
      automation.submitGeneratedMedia(actor, {
        idempotencyKey,
        projectId,
        clipId: null,
        kind: "image",
        prompt: "Safe prompt",
        promptOrigin: { kind: "manual", sourceIds: [] },
        aspectRatio: "1:1",
        style: "minimal",
        seed: 42,
      }),
    ).rejects.toBeDefined();
    await expect(
      automation.applyCampaignBrandProfile(
        actor,
        projectId,
        idempotencyKey,
        {
          profileId: jobId,
          profileFingerprint: "a".repeat(64),
          styleFingerprint: null,
          clips: [{ clipId, expectedEditorRevision: 1 }],
        },
      ),
    ).rejects.toBeDefined();
    expect(submissions).toBe(0);
  });

  test("keeps approval overrides out of the production automation adapter", async () => {
    const scopes: unknown[] = [];
    const production = createProductionBusinessAutomation(
      {},
      {
        bulkSchedulingRuntime: {
          async schedule(scope) {
            scopes.push(scope);
            return {
              operationId: jobId,
              status: "completed",
              counts: { scheduled: 1, failed: 0 },
              items: [],
              replayed: false,
            };
          },
        },
      },
    );
    const request = {
      idempotencyKey,
      timezone: "UTC",
      startDate: "2026-09-01",
      postingWindow: {
        startTime: "09:00",
        endTime: "11:00",
        frequencyMinutes: 60,
      },
      items: [{
        itemKey: jobId,
        occurrenceIndex: 0,
        clipId,
        expectedEditorRevision: 1,
        exportVariantId: "20000000-0000-4000-8000-000000000008",
        accountId: "20000000-0000-4000-8000-000000000009",
        platform: "linkedin" as const,
        assistedCopyDraftId: "20000000-0000-4000-8000-000000000010",
        assistedCopyRevision: 1,
        aspectRatio: "9:16" as const,
        resolution: "1080p" as const,
        durationSec: 30,
        thumbnailAssetId: null,
      }],
    };

    await expect(production.bulkSchedule(actor, projectId, request)).resolves.toMatchObject({
      operationId: jobId,
      status: "completed",
    });
    expect(scopes).toEqual([expect.objectContaining({
      approvalPrincipal: actor.automationPrincipal,
    })]);

    await expect(production.bulkSchedule(actor, projectId, {
      ...request,
      items: [{
        ...request.items[0],
        approvalOverrideReason: "Automation must not override review",
      }],
    })).rejects.toBeDefined();
    expect(scopes).toHaveLength(1);
  });

  test("reads the owned Campaign Operation after mutation and preserves replay", async () => {
    let admissions = 0;
    const reads: Array<{ workspaceId: string; projectId: string; operationId: string }> = [];
    const unused = async () => {
      throw new Error("unused campaign mutation");
    };
    const production = createProductionBusinessAutomation({}, {
      campaignOperationGateway: {
        async applyMotionSelected() {
          admissions += 1;
          return {
            operationId: jobId,
            status: "completed",
            requestedCount: 1,
            counts: { succeeded: 1, unchanged: 0, stale: 0, ineligible: 0, failed: 0 },
            replayed: admissions > 1,
          };
        },
        applyProjectBrandProfileSelected: unused,
        applyStyleSelected: unused,
        applySceneTemplate: unused,
        async getOperation(scope, operationId) {
          reads.push({ ...scope, operationId });
          return {
            id: operationId,
            action: "apply_motion",
            status: "completed",
            requestedCount: 1,
            succeededCount: 1,
            unchangedCount: 0,
            staleCount: 0,
            ineligibleCount: 0,
            failedCount: 0,
            items: [{
              requestedClipId: clipId,
              expectedEditorRevision: 1,
              status: "succeeded",
              errorCode: null,
              settledAt: new Date("2026-08-31T00:00:01.000Z"),
            }],
            createdAt: new Date("2026-08-31T00:00:00.000Z"),
            completedAt: new Date("2026-08-31T00:00:01.000Z"),
          };
        },
      },
    });
    const input = {
      clips: [{ clipId, expectedEditorRevision: 1 }],
      change: {
        scope: "clip_transition" as const,
        transition: { type: "wipe-left" as const, durationSec: 0.4 },
      },
    };

    const first = await production.applyCampaignMotion(actor, projectId, idempotencyKey, input);
    const replay = await production.applyCampaignMotion(actor, projectId, idempotencyKey, input);

    expect(first).toMatchObject({ operationId: jobId, replayed: false });
    expect(replay).toMatchObject({ operationId: jobId, replayed: true });
    expect(reads).toEqual([
      { workspaceId, projectId, operationId: jobId },
      { workspaceId, projectId, operationId: jobId },
    ]);
  });

  test("keeps existing job status readable when generation writes are rolled back", async () => {
    const production = createProductionBusinessAutomation(
      {
        NARRIFLOW_WRITES_GENERATED_MEDIA: "0",
        NARRIFLOW_WRITES_GENERATED_IMAGES: "0",
        NARRIFLOW_WRITES_GENERATED_VIDEOS: "0",
      },
      {
        generatedMediaStatusStore: {
          async get(scope, requestedJobId) {
            expect(scope.workspaceId).toBe(workspaceId);
            expect(requestedJobId).toBe(jobId);
            return {
              id: jobId,
              workspaceId,
              projectId,
              clipId,
              kind: "image",
              status: "completed",
              provider: "disabled-provider",
              model: "disabled-model",
              promptOrigin: { kind: "manual", sourceIds: [] },
              aspectRatio: "9:16",
              style: "editorial",
              durationSec: null,
              resultAssetId: clipId,
              insertionCount: 0,
              lastInsertionKind: null,
              lastInsertedAt: null,
              errorCode: null,
              moderation: { outcome: "passed" },
              createdAt: "2026-08-31T00:00:00.000Z",
              updatedAt: "2026-08-31T00:00:00.000Z",
              replayed: false,
            };
          },
        },
      },
    );

    await expect(production.getGeneratedMedia(actor, jobId)).resolves.toMatchObject({
      jobId,
      status: "completed",
      resultAssetId: clipId,
    });
    await expect(production.submitGeneratedMedia(actor, {
      idempotencyKey,
      projectId,
      clipId: null,
      kind: "image",
      prompt: "New write remains disabled",
			includeDerivedContext: false,
      promptOrigin: { kind: "manual", sourceIds: [] },
      aspectRatio: "1:1",
      style: "minimal",
    })).rejects.toMatchObject({ code: "generated_media_not_configured" });
  });

  test("reads the durable Generated Media job after Studio admission and preserves replay", async () => {
    let admissions = 0;
    const statusReads: Array<{ workspaceId: string; jobId: string }> = [];
    const durableJob = {
      id: jobId,
      workspaceId,
      projectId,
      clipId: null,
      kind: "image" as const,
      status: "queued" as const,
      provider: "private-provider",
      model: "private-model",
      promptOrigin: { kind: "manual" as const, sourceIds: [] },
      aspectRatio: "1:1" as const,
      style: "minimal" as const,
      durationSec: null,
      resultAssetId: null,
      insertionCount: 0,
      lastInsertionKind: null,
      lastInsertedAt: null,
      errorCode: null,
      moderation: { outcome: "pending" as const },
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      replayed: false,
    };
    const production = createProductionBusinessAutomation({}, {
      generatedMediaStudioService: {
        async submitAutomation(scope) {
          admissions += 1;
          expect(scope.workspaceId).toBe(workspaceId);
          return { ...durableJob, replayed: admissions > 1 };
        },
      },
      generatedMediaStatusStore: {
        async get(scope, requestedJobId) {
          statusReads.push({ workspaceId: scope.workspaceId, jobId: requestedJobId });
          return durableJob;
        },
      },
    });
    const request = {
      idempotencyKey,
      projectId,
      clipId: null,
      kind: "image" as const,
      prompt: "A clean product still",
      includeDerivedContext: false,
      promptOrigin: { kind: "manual" as const, sourceIds: [] },
      aspectRatio: "1:1" as const,
      style: "minimal" as const,
    };

    const first = await production.submitGeneratedMedia(actor, request);
    const replay = await production.submitGeneratedMedia(actor, request);

    expect(first).toMatchObject({ jobId, replayed: false });
    expect(replay).toMatchObject({ jobId, replayed: true });
    expect(statusReads).toEqual([
      { workspaceId, jobId },
      { workspaceId, jobId },
    ]);
  });
});
