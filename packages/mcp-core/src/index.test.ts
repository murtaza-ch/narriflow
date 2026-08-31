import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  BusinessAutomationAccessError,
  createBusinessAutomation,
  type BusinessAutomationActorContext,
  type BusinessAutomationDependencies,
} from "@narriflow/services";

import {
  buildNarriflowMcpServer,
  NARRIFLOW_MCP_TOOL_NAMES,
  type NarriflowMcpDependencies,
  type NarriflowMcpPrincipal,
} from "./index";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(
  principal: NarriflowMcpPrincipal,
  versionNegotiation: { mode: "auto" } | { mode: "legacy" } = { mode: "auto" },
  dependencies: NarriflowMcpDependencies = {},
) {
  const currentDependencies: NarriflowMcpDependencies =
    principal.kind === "api_key"
      ? {
          revalidateApiKey: async () => ({
            apiKeyId: principal.apiKeyId,
            userId: principal.userId,
            workspaceId: principal.workspaceId,
            name: "Test key",
            scopes: [...principal.scopes],
          }),
          ...dependencies,
        }
      : dependencies;
  const handler = createMcpHandler(() =>
    buildNarriflowMcpServer(principal, currentDependencies));
  const client = new Client(
    { name: "narriflow-mcp-test", version: "1.0.0" },
    { versionNegotiation },
  );
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL("https://narriflow.test/mcp"), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  await client.connect(transport);
  return client;
}

const existingToolNames = [
  "narriflow_confirm_social_publication",
  "narriflow_create_rss_autopilot_rule",
  "narriflow_get_project",
  "narriflow_get_social_publication",
  "narriflow_get_workspace_usage",
  "narriflow_list_autopilot_rules",
  "narriflow_list_projects",
  "narriflow_list_workspaces",
  "narriflow_run_autopilot_rule_now",
  "narriflow_publish_social_publication_again",
  "narriflow_recheck_social_publication",
] as const;

const automationToolNames = [
  "narriflow_list_brand_profiles",
  "narriflow_get_brand_profile",
  "narriflow_list_campaign_operations",
  "narriflow_apply_campaign_motion",
  "narriflow_get_campaign_editor_action_catalog",
  "narriflow_preview_campaign_editor_action",
  "narriflow_apply_campaign_brand_profile",
  "narriflow_apply_campaign_style",
  "narriflow_apply_campaign_scene_template",
  "narriflow_list_review_rounds",
  "narriflow_create_review_round",
  "narriflow_generate_assisted_copy",
  "narriflow_get_assisted_copy",
  "narriflow_request_thumbnail_extraction",
  "narriflow_get_thumbnail_extraction",
  "narriflow_schedule_campaign",
  "narriflow_submit_generated_media",
  "narriflow_get_generated_media_job",
] as const;

const workspaceId = "00000000-0000-4000-8000-000000000003";
const userId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000004";
const clipId = "00000000-0000-4000-8000-000000000005";
const exportId = "00000000-0000-4000-8000-000000000006";
const idempotencyKey = "00000000-0000-4000-8000-000000000007";

const actor: BusinessAutomationActorContext = {
  userId,
  workspaceId,
  workspaceName: "Editorial",
  workspaceOwnerUserId: userId,
  role: "owner",
  status: "active",
  pricingTier: "business",
  isPersonalWorkspace: false,
  automationPrincipal: {
    kind: "api_key",
    apiKeyId: "00000000-0000-4000-8000-000000000002",
  },
};

function automationDependencies(
  overrides: Partial<BusinessAutomationDependencies> = {},
): BusinessAutomationDependencies {
  const unused = async () => {
    throw new Error("unexpected automation call");
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

describe("Narriflow MCP 2026-07-28 server", () => {
  test("negotiates stateless HTTP and advertises the curated tool catalog", async () => {
    const client = await connect({
      kind: "oauth",
      userId: "00000000-0000-4000-8000-000000000001",
      clientId: "test-oauth-client",
      scopes: ["openid"],
    });

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names.slice(0, existingToolNames.length)).toEqual(existingToolNames);
    expect(names).toEqual(NARRIFLOW_MCP_TOOL_NAMES);
    expect(NARRIFLOW_MCP_TOOL_NAMES).toEqual([
      ...existingToolNames,
      ...automationToolNames,
    ]);

    const createRule = tools.find((tool) => tool.name === "narriflow_create_rss_autopilot_rule");
    const listProjects = tools.find((tool) => tool.name === "narriflow_list_projects");
    expect(createRule?.annotations?.readOnlyHint).toBe(false);
    expect(createRule?.annotations?.openWorldHint).toBe(true);
    expect(listProjects?.annotations?.readOnlyHint).toBe(true);
    expect(listProjects?.annotations?.destructiveHint).toBe(false);
    expect(
      tools.find((tool) => tool.name === "narriflow_publish_social_publication_again")
        ?.annotations?.destructiveHint,
    ).toBe(true);
  });

  test("keeps the legacy stateless protocol available during client migration", async () => {
    const client = await connect(
      {
        kind: "oauth",
        userId: "00000000-0000-4000-8000-000000000001",
        clientId: "test-legacy-client",
        scopes: ["openid"],
      },
      { mode: "legacy" },
    );

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).slice(0, existingToolNames.length))
      .toEqual(existingToolNames);
    expect(tools).toHaveLength(existingToolNames.length + automationToolNames.length);
  });

  test("returns a cacheable modern discovery document without issuing a session", async () => {
    const handler = createMcpHandler(() => buildNarriflowMcpServer({
      kind: "oauth",
      userId: "00000000-0000-4000-8000-000000000001",
      clientId: "test-raw-client",
      scopes: ["openid"],
    }));
    const response = await handler.fetch(new Request("https://narriflow.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-method": "server/discover",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "discover-1",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "raw-test", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(body).toContain("2026-07-28");
    expect(body).toContain("supportedVersions");
    expect(body).toContain("ttlMs");
    expect(body).toContain("300000");
    expect(body).toContain("public");
  });

  test("rejects an MCP-Method header that disagrees with the JSON-RPC method", async () => {
    const handler = createMcpHandler(() => buildNarriflowMcpServer({
      kind: "oauth",
      userId: "00000000-0000-4000-8000-000000000001",
      clientId: "test-raw-client",
      scopes: ["openid"],
    }));
    const response = await handler.fetch(new Request("https://narriflow.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "discover-2",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "raw-test", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("-32020");
  });

  test("rejects a key before database access when the required scope is absent", async () => {
    const client = await connect({
      kind: "api_key",
      userId: "00000000-0000-4000-8000-000000000001",
      clientId: "narriflow-api-key:test",
      apiKeyId: "00000000-0000-4000-8000-000000000002",
      workspaceId: "00000000-0000-4000-8000-000000000003",
      scopes: ["projects:read"],
    });

    const result = await client.callTool({ name: "narriflow_get_workspace_usage" });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        error: "mcp_api_key_scope_required",
        message: "This API key requires the usage:read scope",
      }),
    });
  });

  test("requires an explicit write scope before a social publication recheck", async () => {
    const client = await connect({
      kind: "api_key",
      userId: "00000000-0000-4000-8000-000000000001",
      clientId: "narriflow-api-key:test",
      apiKeyId: "00000000-0000-4000-8000-000000000002",
      workspaceId: "00000000-0000-4000-8000-000000000003",
      scopes: ["publishing:read"],
    });

    const result = await client.callTool({
      name: "narriflow_recheck_social_publication",
      arguments: {
        socialPostId: "00000000-0000-4000-8000-000000000004",
        reason: "Verify the existing provider operation",
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        error: "mcp_api_key_scope_required",
        message: "This API key requires the publishing:write scope",
      }),
    });
  });

  test.each([
    [
      "narriflow_confirm_social_publication",
      {
        socialPostId: "00000000-0000-4000-8000-000000000004",
        reason: "Verified on the provider",
        evidenceKind: "manual_unvalidated",
      },
    ],
    [
      "narriflow_publish_social_publication_again",
      {
        socialPostId: "00000000-0000-4000-8000-000000000004",
        reason: "Operator accepted duplicate risk",
        duplicateRiskAcknowledged: true,
      },
    ],
  ])("requires an explicit write scope before %s", async (name, arguments_) => {
    const client = await connect({
      kind: "api_key",
      userId: "00000000-0000-4000-8000-000000000001",
      clientId: "narriflow-api-key:test",
      apiKeyId: "00000000-0000-4000-8000-000000000002",
      workspaceId: "00000000-0000-4000-8000-000000000003",
      scopes: ["publishing:read"],
    });

    const result = await client.callTool({ name, arguments: arguments_ });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        error: "mcp_api_key_scope_required",
        message: "This API key requires the publishing:write scope",
      }),
    });
  });

  test("strictly rejects unknown recovery tool fields before service access", async () => {
    const client = await connect({
      kind: "oauth",
      userId: "00000000-0000-4000-8000-000000000001",
      clientId: "test-oauth-client",
      scopes: ["openid"],
    });

    const result = await client.callTool({
      name: "narriflow_get_social_publication",
      arguments: {
        socialPostId: "00000000-0000-4000-8000-000000000004",
        providerCheckpoint: "must-not-be-accepted",
      },
    });
    expect(result.isError).toBe(true);
  });

	test.each(["platform_url", "provider_reference"] as const)(
		"rejects %s confirmation without its required evidence at the MCP boundary",
		async (evidenceKind) => {
			const client = await connect({
				kind: "oauth",
				userId: "00000000-0000-4000-8000-000000000001",
				clientId: "test-oauth-client",
				scopes: ["openid", "publishing:write"],
			});
			const result = await client.callTool({
				name: "narriflow_confirm_social_publication",
				arguments: {
					socialPostId: "00000000-0000-4000-8000-000000000004",
					reason: "Validate the evidence shape",
					evidenceKind,
				},
			});
			expect(result.isError).toBe(true);
		},
	);

  test("rejects an API key targeting a workspace other than its bound workspace", async () => {
    const client = await connect({
      kind: "api_key",
      userId: "00000000-0000-4000-8000-000000000001",
      clientId: "narriflow-api-key:test",
      apiKeyId: "00000000-0000-4000-8000-000000000002",
      workspaceId: "00000000-0000-4000-8000-000000000003",
      scopes: ["projects:read"],
    });

    const result = await client.callTool({
      name: "narriflow_list_projects",
      arguments: { workspaceId: "00000000-0000-4000-8000-000000000004" },
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        error: "mcp_workspace_boundary_violation",
        message: "This API key is bound to a different workspace",
      }),
    });
  });

  test.each([
    ["revoked", null],
    ["rebound workspace", {
      apiKeyId: "00000000-0000-4000-8000-000000000002",
      userId,
      workspaceId: "00000000-0000-4000-8000-000000000099",
      name: "Changed key",
      scopes: ["brand:read"],
    }],
    ["rebound user", {
      apiKeyId: "00000000-0000-4000-8000-000000000002",
      userId: "00000000-0000-4000-8000-000000000098",
      workspaceId,
      name: "Changed key",
      scopes: ["brand:read"],
    }],
  ])("revalidates a %s API key before every tool authorization", async (_name, current) => {
    let authorizations = 0;
    const client = await connect(
      {
        kind: "api_key",
        userId,
        clientId: "narriflow-api-key:test",
        apiKeyId: "00000000-0000-4000-8000-000000000002",
        workspaceId,
        scopes: ["brand:read"],
      },
      { mode: "auto" },
      {
        revalidateApiKey: async () => current,
        async authorize() {
          authorizations += 1;
          return actor;
        },
        automation: createBusinessAutomation(automationDependencies()),
      },
    );

    const result = await client.callTool({
      name: "narriflow_list_brand_profiles",
      arguments: { workspaceId },
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        error: "mcp_api_key_invalid",
        message: "API key is invalid or revoked",
      }),
    });
    expect(authorizations).toBe(0);
  });

  test("uses current API-key scopes instead of the stdio startup snapshot", async () => {
    const seenScopes: string[][] = [];
    const client = await connect(
      {
        kind: "api_key",
        userId,
        clientId: "narriflow-api-key:test",
        apiKeyId: "00000000-0000-4000-8000-000000000002",
        workspaceId,
        scopes: ["brand:read"],
      },
      { mode: "auto" },
      {
        revalidateApiKey: async () => ({
          apiKeyId: "00000000-0000-4000-8000-000000000002",
          userId,
          workspaceId,
          name: "Current key",
          scopes: [],
        }),
        async authorize(current, access) {
          seenScopes.push([...current.scopes]);
          if (!current.scopes.includes(access.requiredScope)) {
            throw new BusinessAutomationAccessError(
              "api_key_scope_required",
              `This API key requires the ${access.requiredScope} scope`,
            );
          }
          return actor;
        },
        automation: createBusinessAutomation(automationDependencies()),
      },
    );

    const result = await client.callTool({
      name: "narriflow_list_brand_profiles",
      arguments: { workspaceId },
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        error: "mcp_api_key_scope_required",
        message: "This API key requires the brand:read scope",
      }),
    });
    expect(seenScopes).toEqual([[]]);
  });

  test("revalidates API keys before the workspace-list tool", async () => {
    const client = await connect(
      {
        kind: "api_key",
        userId,
        clientId: "narriflow-api-key:test",
        apiKeyId: "00000000-0000-4000-8000-000000000002",
        workspaceId,
        scopes: [],
      },
      { mode: "auto" },
      { revalidateApiKey: async () => null },
    );

    const result = await client.callTool({
      name: "narriflow_list_workspaces",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        error: "mcp_api_key_invalid",
        message: "API key is invalid or revoked",
      }),
    });
  });

  test("enforces the new review write scope before authorization or service access", async () => {
    let mutations = 0;
    const client = await connect(
      {
        kind: "api_key",
        userId,
        clientId: "narriflow-api-key:test",
        apiKeyId: "00000000-0000-4000-8000-000000000002",
        workspaceId,
        scopes: ["review:read"],
      },
      { mode: "auto" },
      {
        automation: createBusinessAutomation(automationDependencies({
          async createReviewRound() {
            mutations += 1;
            throw new Error("must not run");
          },
        })),
      },
    );

    const result = await client.callTool({
      name: "narriflow_create_review_round",
      arguments: {
        projectId,
        idempotencyKey,
        title: "Client review",
        recipientEmails: [],
        items: [{
          clipId,
          exportId,
          expectedEditorRevision: 1,
          variantIds: [idempotencyKey],
        }],
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        error: "mcp_api_key_scope_required",
        message: "This API key requires the review:write scope",
      }),
    });
    expect(mutations).toBe(0);
  });

  test("replays review creation without exposing access capabilities or customer text in logs", async () => {
    const rounds = new Set<string>();
    const automation = createBusinessAutomation(automationDependencies({
      async createReviewRound(_actor, _projectId, input) {
        const replayed = rounds.has(input.idempotencyKey);
        rounds.add(input.idempotencyKey);
        return {
          id: input.idempotencyKey,
          revision: 1,
          createdAt: new Date("2026-08-31T00:00:00.000Z"),
          replayed,
          token: "guest-token-must-not-leak",
          path: "/review/guest-token-must-not-leak",
          recipientEmails: input.recipientEmails,
        };
      },
    }));
    const log = spyOn(console, "warn").mockImplementation(() => undefined);
    const client = await connect(
      {
        kind: "api_key",
        userId,
        clientId: "narriflow-api-key:test",
        apiKeyId: "00000000-0000-4000-8000-000000000002",
        workspaceId,
        scopes: ["review:write"],
      },
      { mode: "auto" },
      { authorize: async () => actor, automation },
    );
    const arguments_ = {
      projectId,
      idempotencyKey,
      title: "Private customer launch",
      message: "Do not put this customer text in logs",
      passcode: "private-passcode",
      recipientEmails: ["reviewer@example.test"],
      items: [{
        clipId,
        exportId,
        expectedEditorRevision: 1,
        variantIds: [idempotencyKey],
      }],
    };
    const first = await client.callTool({
      name: "narriflow_create_review_round",
      arguments: arguments_,
    });
    const replay = await client.callTool({
      name: "narriflow_create_review_round",
      arguments: arguments_,
    });
    const firstText = JSON.stringify(first);
    const replayText = JSON.stringify(replay);
    expect(firstText).toContain(`"roundId":"${idempotencyKey}"`);
    expect(firstText).toContain("replayed");
    expect(replayText).toContain("true");
    expect(rounds).toHaveLength(1);
    const logs = JSON.stringify(log.mock.calls);
    for (const privateValue of [
      "Private customer launch",
      "Do not put this customer text in logs",
      "private-passcode",
      "reviewer@example.test",
      "guest-token-must-not-leak",
    ]) {
      expect(firstText).not.toContain(privateValue);
      expect(replayText).not.toContain(privateValue);
      expect(logs).not.toContain(privateValue);
    }
    log.mockRestore();
  });

  test("does not advertise provider, model, or seed controls for generated media", async () => {
    const client = await connect({
      kind: "oauth",
      userId,
      clientId: "test-oauth-client",
      scopes: ["openid"],
    });
    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === "narriflow_submit_generated_media",
    );
    const schema = JSON.stringify(tool?.inputSchema);
    expect(schema).not.toContain("provider");
    expect(schema).not.toContain("model");
    expect(schema).not.toContain("seed");
    expect(tool?.annotations?.idempotentHint).toBe(true);
  });

  test("advertises and returns an exact assisted-copy status projection", async () => {
    const baseAutomation = createBusinessAutomation(automationDependencies());
    const automation = {
      ...baseAutomation,
      async getAssistedCopy() {
        return {
          draftId: exportId,
          clipId,
          platform: "linkedin",
          status: "completed",
          revision: 2,
          content: { caption: "Reviewed copy", hashtags: [], title: null },
          confirmed: true,
          moderationOutcome: "accepted",
          modelAlias: "configured-copy-alias",
          promptVersion: "assisted-copy-v1",
          guidanceSkipped: false,
          errorCode: null,
          replayed: false,
          providerPayload: { customerText: "must-not-leak" },
        };
      },
    };
    const client = await connect(
      {
        kind: "oauth",
        userId,
        clientId: "test-oauth-client",
        scopes: ["openid"],
      },
      { mode: "auto" },
      { authorize: async () => actor, automation },
    );
    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === "narriflow_get_assisted_copy",
    );
    const properties = (
      (tool?.outputSchema as { properties?: { data?: { properties?: Record<string, unknown> } } })
        ?.properties?.data?.properties
    );
    expect(Object.keys(properties ?? {}).sort()).toEqual([
      "clipId",
      "confirmed",
      "content",
      "draftId",
      "errorCode",
      "guidanceSkipped",
      "modelAlias",
      "moderationOutcome",
      "platform",
      "promptVersion",
      "replayed",
      "revision",
      "status",
    ]);

    const result = await client.callTool({
      name: "narriflow_get_assisted_copy",
      arguments: { workspaceId, projectId, draftId: exportId },
    });
    expect(result.isError).not.toBe(true);
    const data = (result.structuredContent as { data?: Record<string, unknown> })?.data;
    expect(data).toMatchObject({
      modelAlias: "configured-copy-alias",
      promptVersion: "assisted-copy-v1",
    });
    expect(data).not.toHaveProperty("providerPayload");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  test("advertises only high-level campaign actions and marks every mutation retry-safe", async () => {
    const client = await connect({
      kind: "oauth",
      userId,
      clientId: "test-oauth-client",
      scopes: ["openid"],
    });
    const tools = (await client.listTools()).tools;
    const profile = tools.find(
      (tool) => tool.name === "narriflow_apply_campaign_brand_profile",
    );
    const profileProperties = (
      profile?.inputSchema as { properties?: Record<string, unknown> } | undefined
    )?.properties;
    expect(profileProperties?.profileId).toBeUndefined();
    expect(profileProperties?.profileFingerprint).toBeDefined();

    const preview = tools.find(
      (tool) => tool.name === "narriflow_preview_campaign_editor_action",
    );
    expect(JSON.stringify(preview?.inputSchema)).not.toContain('"patch"');
    expect(JSON.stringify(preview?.inputSchema)).not.toContain('"document"');

    for (const name of [
      "narriflow_apply_campaign_motion",
      "narriflow_apply_campaign_brand_profile",
      "narriflow_apply_campaign_style",
      "narriflow_apply_campaign_scene_template",
      "narriflow_create_review_round",
      "narriflow_generate_assisted_copy",
      "narriflow_request_thumbnail_extraction",
      "narriflow_schedule_campaign",
      "narriflow_submit_generated_media",
    ]) {
      expect(
        tools.find((tool) => tool.name === name)?.annotations?.idempotentHint,
      ).toBe(true);
    }
  });
});
