import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { autopilotService, clipService, ExpectedDomainFailureError, projectService, workspaceService,
  type WorkspaceActorContext, type ExpectedDomainFailureKind } from "@narriflow/services";

import { buildNarriflowMcpServer, MCP_TOOL_ADMISSIONS, type NarriflowMcpPrincipal, type NarriflowMcpToolName } from "./index";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(
  principal: NarriflowMcpPrincipal,
) {
  const handler = createMcpHandler(() => buildNarriflowMcpServer(principal));
  const client = new Client(
    { name: "narriflow-mcp-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL("https://narriflow.test/mcp"), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  await client.connect(transport);
  return client;
}

describe("Narriflow MCP 2026-07-28 server", () => {
  test("negotiates stateless HTTP and advertises the curated tool catalog", async () => {
    const client = await connect({
      kind: "oauth",
      userId: "00000000-0000-4000-8000-000000000001",
      clientId: "test-oauth-client",
      scopes: ["projects:read", "usage:read", "publishing:read", "publishing:write"],
    });

    const { tools } = await client.listTools();
    const modelTools = tools.filter((tool) => (tool._meta?.ui as {visibility?: string[]}|undefined)?.visibility?.join() !== "app");
    expect(modelTools.map((tool) => tool.name).sort()).toEqual([
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
      "narriflow_submit_video", "narriflow_upload_video", "narriflow_generate_clips",
      "narriflow_list_clips", "narriflow_get_clip", "narriflow_create_clip_export", "narriflow_get_clip_export",
      "narriflow_list_social_accounts", "narriflow_get_publishing_options", "narriflow_prepare_social_post",
      "narriflow_schedule_social_post", "narriflow_list_social_publications",
    ].sort());
    expect(modelTools.map((tool) => tool.name).sort()).toEqual(Object.keys(MCP_TOOL_ADMISSIONS).sort());

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

  test("returns a cacheable modern discovery document without issuing a session", async () => {
    const handler = createMcpHandler(() => buildNarriflowMcpServer({
      kind: "oauth",
      userId: "00000000-0000-4000-8000-000000000001",
      clientId: "test-raw-client",
      scopes: ["projects:read", "usage:read", "publishing:read", "publishing:write"],
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
      scopes: ["projects:read", "usage:read", "publishing:read", "publishing:write"],
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
        error: "mcp_scope_required",
        kind: "forbidden",
        message: "This credential requires the usage:read scope",
        retryGuidance: "request_access",
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
        workspaceId: "00000000-0000-4000-8000-000000000003", clientIdempotencyKey: "00000000-0000-4000-8000-000000000009",
        reason: "Verify the existing provider operation",
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        error: "mcp_scope_required",
        kind: "forbidden",
        message: "This credential requires the publishing:write scope",
        retryGuidance: "request_access",
      }),
    });
  });

  test.each([
    [
      "narriflow_confirm_social_publication",
      {
        socialPostId: "00000000-0000-4000-8000-000000000004",
        workspaceId: "00000000-0000-4000-8000-000000000003", clientIdempotencyKey: "00000000-0000-4000-8000-000000000009",
        reason: "Verified on the provider",
        evidenceKind: "manual_unvalidated",
      },
    ],
    [
      "narriflow_publish_social_publication_again",
      {
        socialPostId: "00000000-0000-4000-8000-000000000004",
        workspaceId: "00000000-0000-4000-8000-000000000003", clientIdempotencyKey: "00000000-0000-4000-8000-000000000009",
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

    const result = await client.callTool({ name, arguments: { workspaceId: "00000000-0000-4000-8000-000000000003", clientIdempotencyKey: "00000000-0000-4000-8000-000000000009", ...arguments_ } });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]).toEqual({
      type: "text",
      text: JSON.stringify({
        error: "mcp_scope_required",
        kind: "forbidden",
        message: "This credential requires the publishing:write scope",
        retryGuidance: "request_access",
      }),
    });
  });

  test("strictly rejects unknown recovery tool fields before service access", async () => {
    const client = await connect({
      kind: "oauth",
      userId: "00000000-0000-4000-8000-000000000001",
      clientId: "test-oauth-client",
      scopes: ["projects:read", "usage:read", "publishing:read", "publishing:write"],
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
				scopes: ["projects:read", "exports:read", "usage:read", "autopilot:read", "autopilot:write", "publishing:read", "publishing:write", "processing:write", "exports:write"],
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
        kind: "forbidden",
        message: "This API key is bound to a different workspace",
        retryGuidance: "request_access",
      }),
    });
  });
  test("get_project returns the canonical snapshot progress without deriving another state", async () => {
    const actorUserId = "00000000-0000-4000-8000-000000000001";
    const workspaceId = "00000000-0000-4000-8000-000000000002";
    const projectId = "00000000-0000-4000-8000-000000000003";
    const progress = { status: "failed" as const, label: "Rendering failed", active: false };
    const actorSpy = spyOn(workspaceService, "requireActor").mockResolvedValue({
      actorUserId, workspaceId, workspaceOwnerUserId: actorUserId,
      role: "owner", status: "active", pricingTier: "business", isPersonalWorkspace: true,
    });
    const snapshotSpy = spyOn(projectService, "getProjectSnapshot").mockResolvedValue({
      project: {
        id: projectId, workspaceId, createdByUserId: actorUserId,
        title: "Progress fixture", sourceMediaUrl: "https://example.test/source.mp4",
        sourceType: "upload", sourceProvider: null, sourceInput: null,
        sourceStorageKey: null, sourceMimeType: null, sourceSizeBytes: null,
        sourceDurationSeconds: 30, languageCode: null, brandProfileId: null,
        brandTemplateId: null, ingestStatus: "ready", ingestErrorCode: null,
        ingestCompletedAt: null, notifyOnComplete: false, retentionPolicyKey: null,
        expiresAt: null, persisted: true, createdAt: "2026-10-04T00:00:00Z",
      },
      progress, activeRun: null, lastSeq: 0, ingestAttemptCount: 0,
    });
    const transcriptSpy = spyOn(projectService, "getTranscriptSnapshot").mockResolvedValue(null);
    const clipsSpy = spyOn(clipService, "listClips").mockResolvedValue([]);
    try {
      const client = await connect({ kind: "oauth", userId: actorUserId, clientId: "test-progress-client", scopes: ["projects:read", "usage:read", "publishing:read", "publishing:write"] });
      const result = await client.callTool({ name: "narriflow_get_project", arguments: { workspaceId, projectId } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { progress: { ...progress, stage: null, percent: null }, project: { projectId } } });
      expect(snapshotSpy).toHaveBeenCalledWith(expect.objectContaining({ actorUserId, workspaceId }), projectId);
    } finally {
      actorSpy.mockRestore(); snapshotSpy.mockRestore(); transcriptSpy.mockRestore(); clipsSpy.mockRestore();
    }
  });

});

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const RESOURCE_ID = "00000000-0000-4000-8000-000000000003";
const currentActor: WorkspaceActorContext = { actorUserId: ACTOR_ID, workspaceId: WORKSPACE_ID, workspaceName: "MCP Team",
  workspaceOwnerUserId: "another-user", role: "editor", status: "active", pricingTier: "business", isPersonalWorkspace: false };
const identityPrincipal: NarriflowMcpPrincipal = { kind: "oauth", userId: ACTOR_ID, clientId: "identity-only",
  scopes: ["projects:read", "exports:read", "usage:read", "autopilot:read", "autopilot:write", "publishing:read", "publishing:write", "processing:write", "exports:write"] };

const toolArguments: Record<Exclude<NarriflowMcpToolName, "narriflow_list_workspaces">, Record<string, unknown>> = {
  narriflow_confirm_social_publication: { clientIdempotencyKey: RESOURCE_ID, workspaceId: WORKSPACE_ID, socialPostId: RESOURCE_ID, reason: "Provider checked", evidenceKind: "manual_unvalidated" },
  narriflow_create_rss_autopilot_rule: { clientIdempotencyKey: RESOURCE_ID, workspaceId: WORKSPACE_ID, name: "Podcast", rssUrl: "https://podcast.test/feed.xml" },
  narriflow_get_project: { workspaceId: WORKSPACE_ID, projectId: RESOURCE_ID },
  narriflow_get_social_publication: { workspaceId: WORKSPACE_ID, socialPostId: RESOURCE_ID },
  narriflow_get_workspace_usage: { workspaceId: WORKSPACE_ID },
  narriflow_list_autopilot_rules: { workspaceId: WORKSPACE_ID },
  narriflow_list_projects: { workspaceId: WORKSPACE_ID },
  narriflow_run_autopilot_rule_now: { clientIdempotencyKey: RESOURCE_ID, workspaceId: WORKSPACE_ID, ruleId: RESOURCE_ID },
  narriflow_publish_social_publication_again: { clientIdempotencyKey: RESOURCE_ID, workspaceId: WORKSPACE_ID, socialPostId: RESOURCE_ID, reason: "Accept duplicate risk", duplicateRiskAcknowledged: true },
  narriflow_recheck_social_publication: { clientIdempotencyKey: RESOURCE_ID, workspaceId: WORKSPACE_ID, socialPostId: RESOURCE_ID, reason: "Inspect provider operation" },
  narriflow_submit_video: { workspaceId: WORKSPACE_ID, clientIdempotencyKey: RESOURCE_ID, url: "https://youtu.be/example" },
  narriflow_upload_video: { workspaceId: WORKSPACE_ID, clientIdempotencyKey: RESOURCE_ID },
  narriflow_generate_clips: { workspaceId: WORKSPACE_ID, clientIdempotencyKey: RESOURCE_ID, projectId: RESOURCE_ID },
  narriflow_list_clips: { workspaceId: WORKSPACE_ID, projectId: RESOURCE_ID },
  narriflow_get_clip: { workspaceId: WORKSPACE_ID, projectId: RESOURCE_ID, clipId: RESOURCE_ID },
  narriflow_create_clip_export: { workspaceId: WORKSPACE_ID, clientIdempotencyKey: RESOURCE_ID, projectId: RESOURCE_ID, clipId: RESOURCE_ID, expectedRevision: 3, aspectRatios: ["9:16"], resolution: "1080p" },
  narriflow_get_clip_export: { workspaceId: WORKSPACE_ID, projectId: RESOURCE_ID, clipId: RESOURCE_ID, exportId: RESOURCE_ID },
  narriflow_list_social_accounts: { workspaceId: WORKSPACE_ID },
  narriflow_get_publishing_options: { workspaceId: WORKSPACE_ID, accountId: RESOURCE_ID },
  narriflow_prepare_social_post: { workspaceId: WORKSPACE_ID, clientIdempotencyKey: RESOURCE_ID, projectId: RESOURCE_ID, clipId: RESOURCE_ID, expectedEditorRevision: 3, clipExportId: RESOURCE_ID, clipExportVariantId: RESOURCE_ID, accountId: RESOURCE_ID, platform: "youtube_shorts", caption: "Example caption", aspectRatio: "9:16", resolution: "1080p", scheduledFor: "2026-10-06T00:00:00.000Z" },
  narriflow_schedule_social_post: { workspaceId: WORKSPACE_ID, clientIdempotencyKey: RESOURCE_ID, preparationToken: "x".repeat(40) },
  narriflow_list_social_publications: { workspaceId: WORKSPACE_ID, projectId: RESOURCE_ID },
};

describe("MCP registered tool admission and failures", () => {
  test("all registered workspace handlers use the matching table row before domain reads", async () => {
    const actorSpy = spyOn(workspaceService, "requireActor").mockRejectedValue(new ExpectedDomainFailureError({
      code: "test_membership_denied", kind: "forbidden", message: "Current membership denied",
    }));
    const snapshotSpy = spyOn(projectService, "getProjectSnapshot").mockRejectedValue(new Error("domain read must not occur"));
    const usageSpy = spyOn(projectService, "getUsageSummary").mockRejectedValue(new Error("domain read must not occur"));
    const runSpy = spyOn(autopilotService, "triggerRuleNow").mockRejectedValue(new Error("domain mutation must not occur"));
    try {
      const client = await connect(identityPrincipal);
      for (const tool of Object.keys(toolArguments) as Array<keyof typeof toolArguments>) {
        const result = await client.callTool({ name: tool, arguments: toolArguments[tool] });
        expect(result.structuredContent).toMatchObject({ data: { error: "test_membership_denied", kind: "forbidden" } });
        expect(actorSpy).toHaveBeenLastCalledWith(ACTOR_ID, WORKSPACE_ID, MCP_TOOL_ADMISSIONS[tool].capability);
      }
      expect(actorSpy).toHaveBeenCalledTimes(22);
      expect(snapshotSpy).not.toHaveBeenCalled(); expect(usageSpy).not.toHaveBeenCalled(); expect(runSpy).not.toHaveBeenCalled();
    } finally { actorSpy.mockRestore(); snapshotSpy.mockRestore(); usageSpy.mockRestore(); runSpy.mockRestore(); }
  });

  test("all registered workspace handlers enforce their key scope and boundary before Workspace reads", async () => {
    const actorSpy = spyOn(workspaceService, "requireActor").mockRejectedValue(new Error("Workspace lookup must not occur"));
    try {
      const missingScope = await connect({ kind: "api_key", userId: ACTOR_ID, clientId: "key-client", apiKeyId: RESOURCE_ID,
        workspaceId: WORKSPACE_ID, scopes: [] });
      for (const tool of Object.keys(toolArguments) as Array<keyof typeof toolArguments>) {
        const result = await missingScope.callTool({ name: tool, arguments: toolArguments[tool] });
        expect(result.structuredContent).toMatchObject({ data: { error: "mcp_scope_required", kind: "forbidden",
          message: `This credential requires the ${MCP_TOOL_ADMISSIONS[tool].apiKeyScope} scope` } });
      }
      const scoped = await connect({ kind: "api_key", userId: ACTOR_ID, clientId: "key-client", apiKeyId: RESOURCE_ID,
        workspaceId: WORKSPACE_ID, scopes: ["projects:read", "exports:read", "usage:read", "autopilot:read", "autopilot:write", "publishing:read", "publishing:write", "processing:write", "exports:write"] });
      for (const tool of Object.keys(toolArguments) as Array<keyof typeof toolArguments>) {
        const result = await scoped.callTool({ name: tool, arguments: { ...toolArguments[tool], workspaceId: RESOURCE_ID } });
        expect(result.structuredContent).toMatchObject({ data: { error: "mcp_workspace_boundary_violation", kind: "forbidden" } });
      }
      expect(actorSpy).not.toHaveBeenCalled();
    } finally { actorSpy.mockRestore(); }
  });

  test.each(["invalid", "unprocessable", "forbidden", "payment_required", "missing", "conflict", "rate_limited", "unavailable"] satisfies ExpectedDomainFailureKind[])(
    "translates a %s domain failure through the MCP client", async (kind) => {
      const actorSpy = spyOn(workspaceService, "requireActor").mockResolvedValue(currentActor);
      const usageSpy = spyOn(projectService, "getUsageSummary").mockRejectedValue(new ExpectedDomainFailureError({
        code: `domain_${kind}`, kind, message: "Safe explanation", details: { requestedWorkspace: WORKSPACE_ID }, retryAfterSeconds: 1.1,
      }));
      try {
        const client = await connect(identityPrincipal);
        const result = await client.callTool({ name: "narriflow_get_workspace_usage", arguments: { workspaceId: WORKSPACE_ID } });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ data: { error: `domain_${kind}`, kind, message: "Safe explanation",
          details: { requestedWorkspace: WORKSPACE_ID }, retryAfterSeconds: 2 } });
        expect(usageSpy).toHaveBeenCalledWith(currentActor);
        expect(JSON.parse((result.content![0] as { text: string }).text)).toEqual((result.structuredContent as { data: unknown }).data);
      } finally { actorSpy.mockRestore(); usageSpy.mockRestore(); }
    },
  );

  test("hides unknown internal exceptions even when they resemble former admission messages", async () => {
    const actorSpy = spyOn(workspaceService, "requireActor").mockResolvedValue(currentActor);
    const usageSpy = spyOn(projectService, "getUsageSummary").mockRejectedValue(new Error("Narriflow MCP password=private"));
    try {
      const client = await connect(identityPrincipal);
      const result = await client.callTool({ name: "narriflow_get_workspace_usage", arguments: { workspaceId: WORKSPACE_ID } });
      expect(result.structuredContent).toEqual({ data: { error: "narriflow_tool_failed", message: "Narriflow tool failed without exposing internal details" } });
      expect(JSON.stringify(result)).not.toContain("password=private");
    } finally { actorSpy.mockRestore(); usageSpy.mockRestore(); }
  });
});
