import { describe, expect, test } from "bun:test";

import {
  authorizeBusinessAutomation,
  createBusinessAutomation,
  type BusinessAutomationDependencies,
  type BusinessAutomationPrincipal,
  type WorkspaceActorContext,
} from "@narriflow/services";
import {
  createBusinessApiHttpHandler,
  type BusinessApiHttpDependencies,
} from "./business-api-http";

const workspaceId = "30000000-0000-4000-8000-000000000001";
const otherWorkspaceId = "30000000-0000-4000-8000-000000000002";
const userId = "30000000-0000-4000-8000-000000000003";
const apiKeyId = "30000000-0000-4000-8000-000000000004";
const projectId = "30000000-0000-4000-8000-000000000005";
const clipId = "30000000-0000-4000-8000-000000000006";
const operationId = "30000000-0000-4000-8000-000000000007";
const idempotencyKey = "30000000-0000-4000-8000-000000000008";

function actor(
  overrides: Partial<WorkspaceActorContext> = {},
): WorkspaceActorContext {
  return {
    userId,
    workspaceId,
    workspaceName: "Editorial",
    workspaceOwnerUserId: userId,
    role: "owner",
    status: "active",
    pricingTier: "business",
    isPersonalWorkspace: false,
    ...overrides,
  };
}

function automationDependencies(
  overrides: Partial<BusinessAutomationDependencies> = {},
): BusinessAutomationDependencies {
  const unused = async () => {
    throw new Error("unexpected workflow call");
  };
  return {
    listBrandProfiles: async () => [],
    getBrandProfile: unused,
    applyCampaignMotion: unused,
    applyCampaignBrandProfile: unused,
    applyCampaignStyle: unused,
    applyCampaignSceneTemplate: unused,
    previewCampaignEditorAction: unused,
    getCampaignEditorActionCatalog: unused,
    listCampaignOperations: async () => [],
    createReviewRound: unused,
    listReviewRounds: async () => ({ project: { id: projectId }, rounds: [] }),
    generateAssistedCopy: unused,
    getAssistedCopy: unused,
    requestThumbnailExtraction: unused,
    getThumbnailExtraction: unused,
    bulkSchedule: unused,
    submitGeneratedMedia: unused,
    getGeneratedMedia: unused,
    ...overrides,
  };
}

function request(
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer nf_valid_test_secret_that_is_long_enough");
  if (init.body) headers.set("Content-Type", "application/json");
  return new Request(`https://narriflow.test${path}`, { ...init, headers });
}

function handler(input: {
  scopes: string[];
  currentActor?: WorkspaceActorContext;
  automation?: BusinessAutomationDependencies;
  authenticate?: BusinessApiHttpDependencies["authenticateApiKey"];
  rateLimit?: BusinessApiHttpDependencies["rateLimit"];
  logs?: UnknownLog[];
}) {
  const current = input.currentActor ?? actor();
  const automation = createBusinessAutomation(
    automationDependencies(input.automation),
  );
  const logs = input.logs ?? [];
  return createBusinessApiHttpHandler({
    authenticateApiKey:
      input.authenticate ??
      (async () => ({
        apiKeyId,
        userId,
        workspaceId,
        name: "Test key",
        scopes: input.scopes,
      })),
    authorize(principal, access) {
      return authorizeBusinessAutomation(
        principal as BusinessAutomationPrincipal,
        access,
        {
          async requireActor() {
            return current;
          },
          async getPersonalWorkspaceId() {
            return workspaceId;
          },
        },
      );
    },
    automation,
    rateLimit: input.rateLimit ?? (async () => ({ allowed: true })),
    log(event) {
      logs.push(event);
    },
  });
}

type UnknownLog = Record<string, unknown>;

describe("Business REST v1", () => {
  test("rejects invalid or revoked keys before workflow access", async () => {
    const response = await handler({
      scopes: ["brand:read"],
      authenticate: async () => null,
    })(request(`/api/v1/workspaces/${workspaceId}/brand-profiles`));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "api_key_invalid",
      message: "API key is invalid or revoked",
    });
  });

  test("enforces least privilege and the API key workspace binding", async () => {
    let calls = 0;
    const api = handler({
      scopes: ["brand:read"],
      automation: {
        async applyCampaignMotion() {
          calls += 1;
          return { operationId, status: "completed" };
        },
      },
    });
    const missingScope = await api(request(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/campaign-operations/apply-motion`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          change: { scope: "clip_transition", transition: { type: "cut", durationSec: 0 } },
          clips: [{ clipId, expectedEditorRevision: 1 }],
        }),
      },
    ));
    const mismatch = await api(request(
      `/api/v1/workspaces/${otherWorkspaceId}/brand-profiles`,
    ));
    expect(missingScope.status).toBe(403);
    expect((await missingScope.json()).error).toBe("api_key_scope_required");
    expect(mismatch.status).toBe(403);
    expect((await mismatch.json()).error).toBe("workspace_boundary_violation");
    expect(calls).toBe(0);
  });

  test("passes campaign idempotency to the shared action and strips internal operation state", async () => {
    let receivedKey: string | null = null;
    const response = await handler({
      scopes: ["campaign:operate"],
      automation: {
        async applyCampaignBrandProfile(_actor, _projectId, key) {
          receivedKey = key;
          return {
            operationId,
            action: "apply_brand_profile",
            status: "completed",
            requestedCount: 1,
            succeededCount: 1,
            unchangedCount: 0,
            staleCount: 0,
            ineligibleCount: 0,
            failedCount: 0,
            items: [],
            createdAt: null,
            completedAt: null,
            validatedOptions: { private: true },
            claimToken: "must-not-leak",
            replayed: false,
          };
        },
      },
    })(request(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/campaign-operations/apply-brand-profile`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          profileFingerprint: "a".repeat(64),
          styleFingerprint: null,
          clips: [{ clipId, expectedEditorRevision: 1 }],
        }),
      },
    ));
    const result = await response.json();
    expect(response.status).toBe(202);
    expect(receivedKey).toBe(idempotencyKey);
    expect(result).toMatchObject({
      operationId,
      action: "apply_brand_profile",
      status: "completed",
      counts: { succeeded: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("validatedOptions");
    expect(JSON.stringify(result)).not.toContain("claimToken");
  });

  test("rejects raw editor patches at the campaign preview boundary", async () => {
    let previews = 0;
    const response = await handler({
      scopes: ["campaign:operate"],
      automation: {
        async previewCampaignEditorAction() {
          previews += 1;
          throw new Error("must not run");
        },
      },
    })(request(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/campaign-operations/preview-editor-action`,
      {
        method: "POST",
        body: JSON.stringify({
          action: "apply_style",
          input: {
            templateId: operationId,
            templateFingerprint: "b".repeat(64),
            clips: [{ clipId, expectedEditorRevision: 1 }],
          },
          patch: [{ op: "replace", path: "/caption", value: "unsafe" }],
        }),
      },
    ));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("request_invalid");
    expect(previews).toBe(0);
  });

  test.each([
    ["downgraded", actor({ pricingTier: "pro" })],
    ["restricted", actor({ status: "restricted" })],
  ])("blocks %s workspaces", async (_name, currentActor) => {
    const response = await handler({
      scopes: ["brand:read"],
      currentActor,
    })(request(`/api/v1/workspaces/${workspaceId}/brand-profiles`));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("workspace_access_unavailable");
  });

  test("replays the same durable review round after a lost response", async () => {
    const rounds = new Map<string, { id: string; replayed: boolean }>();
    const api = handler({
      scopes: ["review:write"],
      automation: {
        async createReviewRound(_actor, _projectId, input) {
          const existing = rounds.get(input.idempotencyKey);
          if (existing) return { ...existing, revision: 1, createdAt: new Date(0), replayed: true };
          const created = { id: input.idempotencyKey, replayed: false };
          rounds.set(input.idempotencyKey, created);
          return { ...created, revision: 1, createdAt: new Date(0) };
        },
      },
    });
    const body = JSON.stringify({
      idempotencyKey,
      title: "Client review",
      passcode: "customer-passcode",
      recipientEmails: ["reviewer@example.test"],
      items: [{
        clipId,
        exportId: operationId,
        expectedEditorRevision: 1,
        variantIds: [idempotencyKey],
      }],
    });
    const first = await api(request(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/review-rounds`,
      { method: "POST", body },
    ));
    const replay = await api(request(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/review-rounds`,
      { method: "POST", body },
    ));
    expect(first.status).toBe(202);
    expect(replay.status).toBe(200);
    expect(await first.json()).toMatchObject({ roundId: idempotencyKey, replayed: false });
    expect(await replay.json()).toMatchObject({ roundId: idempotencyKey, replayed: true });
    expect(rounds).toHaveLength(1);
  });

  test("logs mutation identity without customer text or credentials", async () => {
    const logs: UnknownLog[] = [];
    const api = handler({
      scopes: ["generated-media:submit"],
      logs,
      automation: {
        async submitGeneratedMedia() {
          return {
            id: operationId,
            projectId,
            clipId: null,
            kind: "image",
            status: "queued",
            aspectRatio: "1:1",
            style: "minimal",
            durationSec: null,
            resultAssetId: null,
            insertionCount: 0,
            lastInsertionKind: null,
            lastInsertedAt: null,
            errorCode: null,
            moderation: { outcome: "pending" },
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            replayed: false,
          };
        },
      },
    });
    const response = await api(request(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/generated-media/jobs`,
      {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey,
          projectId,
          clipId: null,
          kind: "image",
          prompt: "Customer launch text",
          includeDerivedContext: false,
          promptOrigin: { kind: "manual", sourceIds: [] },
          aspectRatio: "1:1",
          style: "minimal",
        }),
      },
    ));
    expect(response.status).toBe(202);
    const encoded = JSON.stringify(logs);
    expect(encoded).toContain("business_api_mutation");
    for (const secret of [
      "Customer launch text",
      "nf_valid_test_secret",
      "customer-passcode",
      "reviewer@example.test",
    ]) {
      expect(encoded).not.toContain(secret);
    }
  });

  test("rate limits by credential identity before reading a customer body", async () => {
    let submissions = 0;
    const response = await handler({
      scopes: ["generated-media:submit"],
      rateLimit: async ({ key, limit, windowSeconds }) => {
        expect(key).toBe(`business-api:${apiKeyId}`);
        expect(limit).toBe(300);
        expect(windowSeconds).toBe(60);
        return { allowed: false };
      },
      automation: {
        async submitGeneratedMedia() {
          submissions += 1;
          throw new Error("must not run");
        },
      },
    })(request(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/generated-media/jobs`,
      {
        method: "POST",
        body: JSON.stringify({ prompt: "customer body must not be parsed" }),
      },
    ));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(submissions).toBe(0);
  });

  test.each([
    ["provider", "raw-provider"],
    ["model", "raw-model"],
    ["seed", 42],
  ])("rejects low-level generated-media field %s", async (field, value) => {
    let submissions = 0;
    const response = await handler({
      scopes: ["generated-media:submit"],
      automation: {
        async submitGeneratedMedia() {
          submissions += 1;
          throw new Error("must not run");
        },
      },
    })(request(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/generated-media/jobs`,
      {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey,
          projectId,
          clipId: null,
          kind: "image",
          prompt: "High-level request",
          promptOrigin: { kind: "manual", sourceIds: [] },
          aspectRatio: "1:1",
          style: "minimal",
          [field]: value,
        }),
      },
    ));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("request_invalid");
    expect(submissions).toBe(0);
  });

  test("rejects a generated-media body targeting another project", async () => {
    let submissions = 0;
    const response = await handler({
      scopes: ["generated-media:submit"],
      automation: {
        async submitGeneratedMedia() {
          submissions += 1;
          throw new Error("must not run");
        },
      },
    })(request(
      `/api/v1/workspaces/${workspaceId}/projects/${projectId}/generated-media/jobs`,
      {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey,
          projectId: otherWorkspaceId,
          clipId: null,
          kind: "image",
          prompt: "High-level request",
          promptOrigin: { kind: "manual", sourceIds: [] },
          aspectRatio: "1:1",
          style: "minimal",
        }),
      },
    ));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("project_id_mismatch");
    expect(submissions).toBe(0);
  });
});
