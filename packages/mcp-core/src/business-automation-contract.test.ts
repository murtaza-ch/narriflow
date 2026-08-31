import { expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  createBusinessAutomation,
  GeneratedMediaError,
  ReviewServiceError,
  type BusinessAutomationActorContext,
  type BusinessAutomationDependencies,
} from "@narriflow/services";

import {
  createBusinessApiHttpHandler,
} from "../../../apps/web/app/api/v1/[[...route]]/business-api-http";
import { buildNarriflowMcpServer } from "./index";

const userId = "60000000-0000-4000-8000-000000000001";
const workspaceId = "60000000-0000-4000-8000-000000000002";
const projectId = "60000000-0000-4000-8000-000000000003";
const clipId = "60000000-0000-4000-8000-000000000004";
const templateId = "60000000-0000-4000-8000-000000000005";
const apiKeyId = "60000000-0000-4000-8000-000000000006";
const profileId = "60000000-0000-4000-8000-000000000007";
const operationId = "60000000-0000-4000-8000-000000000008";
const idempotencyKey = "60000000-0000-4000-8000-000000000009";

const actor: BusinessAutomationActorContext = {
  userId,
  workspaceId,
  workspaceName: "Editorial",
  workspaceOwnerUserId: userId,
  role: "owner",
  status: "active",
  pricingTier: "business",
  isPersonalWorkspace: false,
  automationPrincipal: { kind: "api_key", apiKeyId },
};

const bulkScheduleInput = {
  idempotencyKey,
  timezone: "UTC",
  startDate: "2026-09-01",
  postingWindow: {
    startTime: "09:00",
    endTime: "11:00",
    frequencyMinutes: 60,
  },
  items: [{
    itemKey: operationId,
    occurrenceIndex: 0,
    clipId,
    expectedEditorRevision: 3,
    exportVariantId: templateId,
    accountId: profileId,
    platform: "linkedin" as const,
    assistedCopyDraftId: workspaceId,
    assistedCopyRevision: 1,
    aspectRatio: "9:16" as const,
    resolution: "1080p" as const,
    durationSec: 30,
    thumbnailAssetId: null,
  }],
};

const revalidateApiKey = async () => ({
  apiKeyId,
  userId,
  workspaceId,
  name: "Contract key",
  scopes: [
    "campaign:operate",
    "review:write",
    "generated-media:submit",
    "publishing:prepare",
  ],
});

const previewInput = {
  action: "apply_style" as const,
  input: {
    templateId,
    templateFingerprint: "a".repeat(64),
    clips: [{ clipId, expectedEditorRevision: 3 }],
  },
};

const previewFixture = {
  action: "apply_style",
  requestedCount: 1,
  counts: { eligible: 1, unchanged: 0, stale: 0, ineligible: 0 },
  items: [{
    clipId,
    expectedEditorRevision: 3,
    currentEditorRevision: 3,
    status: "eligible",
    code: null,
  }],
};

function dependencies(): BusinessAutomationDependencies {
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
    previewCampaignEditorAction: async () => previewFixture,
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
  };
}

test("web service, REST v1, and MCP return the same campaign preview contract", async () => {
  const workflowDependencies = dependencies();
  const automation = createBusinessAutomation(workflowDependencies);
  const directWebServiceOutcome = await workflowDependencies.previewCampaignEditorAction(
    actor,
    projectId,
    previewInput,
  );

  const rest = createBusinessApiHttpHandler({
    authenticateApiKey: async () => ({
      apiKeyId,
      userId,
      workspaceId,
      name: "Contract key",
      scopes: ["campaign:operate"],
    }),
    authorize: async () => actor,
    automation,
    rateLimit: async () => ({ allowed: true }),
    log: () => undefined,
  });
  const restResponse = await rest(new Request(
    `https://narriflow.test/api/v1/workspaces/${workspaceId}/projects/${projectId}/campaign-operations/preview-editor-action`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer nf_contract_key_that_is_long_enough",
        "content-type": "application/json",
      },
      body: JSON.stringify(previewInput),
    },
  ));
  expect(restResponse.status).toBe(200);
  const restOutcome = await restResponse.json();

  const mcpHandler = createMcpHandler(() => buildNarriflowMcpServer(
    {
      kind: "api_key",
      userId,
      clientId: `narriflow-api-key:${apiKeyId}`,
      apiKeyId,
      workspaceId,
      scopes: ["campaign:operate"],
    },
    { automation, authorize: async () => actor, revalidateApiKey },
  ));
  const client = new Client(
    { name: "contract-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL("https://narriflow.test/mcp"),
      {
        fetch: (input, init) => mcpHandler.fetch(new Request(input, init)),
      },
    ));
    const result = await client.callTool({
      name: "narriflow_preview_campaign_editor_action",
      arguments: { projectId, request: previewInput },
    });
    expect(result.isError).not.toBe(true);
    const mcpOutcome = (
      result.structuredContent as { data: unknown } | undefined
    )?.data;
    expect(restOutcome).toEqual(directWebServiceOutcome);
    expect(mcpOutcome).toEqual(directWebServiceOutcome);
  } finally {
    await client.close();
  }
});

test("REST v1 and MCP execute the same scene mutation and expose its settled item status", async () => {
  const sceneInput = {
    templateFingerprint: "b".repeat(64),
    placement: "start" as const,
    clips: [{ clipId, expectedEditorRevision: 3 }],
  };
  const completedAt = new Date("2026-08-31T12:00:00.000Z");
  const mutationFixture = {
    operationId,
    status: "completed",
    requestedCount: 1,
    counts: {
      succeeded: 1,
      unchanged: 0,
      stale: 0,
      ineligible: 0,
      failed: 0,
    },
    items: [{
      requestedClipId: clipId,
      expectedEditorRevision: 3,
      status: "succeeded",
      errorCode: null,
      settledAt: completedAt,
    }],
    createdAt: new Date("2026-08-31T11:59:59.000Z"),
    completedAt,
    replayed: false,
  };
  const listFixture = {
    id: operationId,
    action: "apply_scene_template",
    status: "completed",
    requestedCount: 1,
    succeededCount: 1,
    unchangedCount: 0,
    staleCount: 0,
    ineligibleCount: 0,
    failedCount: 0,
    items: [{
      requestedClipId: clipId,
      expectedEditorRevision: 3,
      status: "succeeded",
      errorCode: null,
      settledAt: completedAt,
    }],
    createdAt: new Date("2026-08-31T11:59:59.000Z"),
    completedAt,
  };
  const sceneCalls: unknown[] = [];
  const workflowDependencies: BusinessAutomationDependencies = {
    ...dependencies(),
    async applyCampaignSceneTemplate(
      receivedActor,
      receivedProjectId,
      receivedProfileId,
      receivedTemplateId,
      receivedIdempotencyKey,
      receivedInput,
    ) {
      sceneCalls.push({
        actor: receivedActor,
        projectId: receivedProjectId,
        profileId: receivedProfileId,
        templateId: receivedTemplateId,
        idempotencyKey: receivedIdempotencyKey,
        input: receivedInput,
      });
      return mutationFixture;
    },
    async listCampaignOperations() {
      return [listFixture];
    },
  };
  const automation = createBusinessAutomation(workflowDependencies);
  const rest = createBusinessApiHttpHandler({
    authenticateApiKey: async () => ({
      apiKeyId,
      userId,
      workspaceId,
      name: "Contract key",
      scopes: ["campaign:operate"],
    }),
    authorize: async () => actor,
    automation,
    rateLimit: async () => ({ allowed: true }),
    log: () => undefined,
  });

  const restMutationResponse = await rest(new Request(
    `https://narriflow.test/api/v1/workspaces/${workspaceId}/projects/${projectId}/brand-profiles/${profileId}/scene-templates/${templateId}/apply`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer nf_contract_key_that_is_long_enough",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(sceneInput),
    },
  ));
  expect(restMutationResponse.status).toBe(202);
  const restMutation = await restMutationResponse.json();
  const restListResponse = await rest(new Request(
    `https://narriflow.test/api/v1/workspaces/${workspaceId}/projects/${projectId}/campaign-operations`,
    { headers: { authorization: "Bearer nf_contract_key_that_is_long_enough" } },
  ));
  expect(restListResponse.status).toBe(200);
  const restList = await restListResponse.json();

  const mcpHandler = createMcpHandler(() => buildNarriflowMcpServer(
    {
      kind: "api_key",
      userId,
      clientId: `narriflow-api-key:${apiKeyId}`,
      apiKeyId,
      workspaceId,
      scopes: ["campaign:operate"],
    },
    { automation, authorize: async () => actor, revalidateApiKey },
  ));
  const client = new Client(
    { name: "scene-contract-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL("https://narriflow.test/mcp"),
      {
        fetch: (input, init) => mcpHandler.fetch(new Request(input, init)),
      },
    ));
    const mcpMutationResult = await client.callTool({
      name: "narriflow_apply_campaign_scene_template",
      arguments: {
        workspaceId,
        projectId,
        profileId,
        templateId,
        idempotencyKey,
        ...sceneInput,
      },
    });
    expect(mcpMutationResult.isError).not.toBe(true);
    const mcpMutation = (
      mcpMutationResult.structuredContent as { data: unknown } | undefined
    )?.data;
    const mcpListResult = await client.callTool({
      name: "narriflow_list_campaign_operations",
      arguments: { workspaceId, projectId },
    });
    expect(mcpListResult.isError).not.toBe(true);
    const mcpList = (
      mcpListResult.structuredContent as { data: unknown } | undefined
    )?.data;

    expect(mcpMutation).toEqual(restMutation);
    expect(mcpList).toEqual(restList);
    expect(restList).toEqual([{
      operationId,
      action: "apply_scene_template",
      status: "completed",
      requestedCount: 1,
      counts: mutationFixture.counts,
      items: [{
        clipId,
        expectedEditorRevision: 3,
        status: "succeeded",
        errorCode: null,
        settledAt: completedAt.toISOString(),
      }],
      createdAt: "2026-08-31T11:59:59.000Z",
      completedAt: completedAt.toISOString(),
      replayed: false,
    }]);
    expect(sceneCalls).toEqual([
      {
        actor,
        projectId,
        profileId,
        templateId,
        idempotencyKey,
        input: sceneInput,
      },
      {
        actor,
        projectId,
        profileId,
        templateId,
        idempotencyKey,
        input: sceneInput,
      },
    ]);
  } finally {
    await client.close();
  }
});

test("REST v1 and MCP both reject campaign approval overrides before scheduling", async () => {
  let schedules = 0;
  const automation = createBusinessAutomation({
    ...dependencies(),
    async bulkSchedule() {
      schedules += 1;
      throw new Error("must not schedule");
    },
  });
  const rest = createBusinessApiHttpHandler({
    authenticateApiKey: async () => ({
      apiKeyId,
      userId,
      workspaceId,
      name: "Contract key",
      scopes: ["publishing:prepare"],
    }),
    authorize: async () => actor,
    automation,
    rateLimit: async () => ({ allowed: true }),
    log: () => undefined,
  });
  const unsafeInput = {
    ...bulkScheduleInput,
    items: [{
      ...bulkScheduleInput.items[0],
      approvalOverrideReason: "API credentials cannot waive client approval",
    }],
  };
  const restResponse = await rest(new Request(
    `https://narriflow.test/api/v1/workspaces/${workspaceId}/projects/${projectId}/bulk-schedules`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer nf_contract_key_that_is_long_enough",
        "content-type": "application/json",
      },
      body: JSON.stringify(unsafeInput),
    },
  ));
  expect(restResponse.status).toBe(400);
  expect(await restResponse.json()).toMatchObject({ error: "request_invalid" });

  const mcpHandler = createMcpHandler(() => buildNarriflowMcpServer(
    {
      kind: "api_key",
      userId,
      clientId: `narriflow-api-key:${apiKeyId}`,
      apiKeyId,
      workspaceId,
      scopes: ["publishing:prepare"],
    },
    { automation, authorize: async () => actor, revalidateApiKey },
  ));
  const client = new Client(
    { name: "schedule-contract-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL("https://narriflow.test/mcp"),
      {
        fetch: (input, init) => mcpHandler.fetch(new Request(input, init)),
      },
    ));
    const mcpResult = await client.callTool({
      name: "narriflow_schedule_campaign",
      arguments: { workspaceId, projectId, ...unsafeInput },
    });
    expect(mcpResult.isError).toBe(true);
    expect(schedules).toBe(0);
  } finally {
    await client.close();
  }
});

test("REST v1 and MCP expose the same content-free workflow failure codes", async () => {
  const automation = createBusinessAutomation({
    ...dependencies(),
    async createReviewRound() {
      throw new ReviewServiceError(
        "review_automation_configuration_invalid",
        "Private REVIEW_ACCESS_SECRET detail",
      );
    },
    async submitGeneratedMedia() {
      throw new GeneratedMediaError("generated_media_not_configured");
    },
  });
  const rest = createBusinessApiHttpHandler({
    authenticateApiKey: async () => ({
      apiKeyId,
      userId,
      workspaceId,
      name: "Contract key",
      scopes: ["review:write", "generated-media:submit"],
    }),
    authorize: async () => actor,
    automation,
    rateLimit: async () => ({ allowed: true }),
    log: () => undefined,
  });
  const mcpHandler = createMcpHandler(() => buildNarriflowMcpServer(
    {
      kind: "api_key",
      userId,
      clientId: `narriflow-api-key:${apiKeyId}`,
      apiKeyId,
      workspaceId,
      scopes: ["review:write", "generated-media:submit"],
    },
    {
      automation,
      authorize: async () => actor,
      revalidateApiKey: async () => ({
        apiKeyId,
        userId,
        workspaceId,
        name: "Contract key",
        scopes: ["review:write", "generated-media:submit"],
      }),
    },
  ));
  const client = new Client(
    { name: "error-contract-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL("https://narriflow.test/mcp"),
      {
        fetch: (input, init) => mcpHandler.fetch(new Request(input, init)),
      },
    ));
    const fixtures = [
      {
        expectedCode: "review_automation_configuration_invalid",
        restPath: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/review-rounds`,
        restBody: {
          idempotencyKey,
          title: "Private customer review",
          recipientEmails: [],
          items: [{
            clipId,
            exportId: operationId,
            expectedEditorRevision: 1,
            variantIds: [templateId],
          }],
        },
        mcpName: "narriflow_create_review_round",
        mcpArguments: {
          workspaceId,
          projectId,
          idempotencyKey,
          title: "Private customer review",
          recipientEmails: [],
          items: [{
            clipId,
            exportId: operationId,
            expectedEditorRevision: 1,
            variantIds: [templateId],
          }],
        },
      },
      {
        expectedCode: "generated_media_not_configured",
        restPath: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/generated-media/jobs`,
        restBody: {
          idempotencyKey,
          projectId,
          clipId: null,
          kind: "image",
          prompt: "Private customer launch",
					includeDerivedContext: false,
          promptOrigin: { kind: "manual", sourceIds: [] },
          aspectRatio: "1:1",
          style: "minimal",
        },
        mcpName: "narriflow_submit_generated_media",
        mcpArguments: {
          workspaceId,
          idempotencyKey,
          projectId,
          clipId: null,
          kind: "image",
          prompt: "Private customer launch",
					includeDerivedContext: false,
          promptOrigin: { kind: "manual", sourceIds: [] },
          aspectRatio: "1:1",
          style: "minimal",
        },
      },
    ];

    for (const fixture of fixtures) {
      const restResponse = await rest(new Request(
        `https://narriflow.test${fixture.restPath}`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer nf_contract_key_that_is_long_enough",
            "content-type": "application/json",
          },
          body: JSON.stringify(fixture.restBody),
        },
      ));
      const restError = await restResponse.json();
      const mcpResult = await client.callTool({
        name: fixture.mcpName,
        arguments: fixture.mcpArguments,
      });
      const mcpError = (
        mcpResult.structuredContent as { data?: unknown } | undefined
      )?.data;
      expect(mcpResult.isError).toBe(true);
      expect(mcpError).toEqual(restError);
      expect(restError).toEqual({
        error: fixture.expectedCode,
        message: "Workflow request could not be completed",
      });
      expect(JSON.stringify({ restError, mcpError })).not.toContain("Private");
    }
  } finally {
    await client.close();
  }
});
