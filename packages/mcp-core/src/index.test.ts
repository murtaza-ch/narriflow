import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { buildNarriflowMcpServer, type NarriflowMcpPrincipal } from "./index";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(
  principal: NarriflowMcpPrincipal,
  versionNegotiation: { mode: "auto" } | { mode: "legacy" } = { mode: "auto" },
) {
  const handler = createMcpHandler(() => buildNarriflowMcpServer(principal));
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

describe("Narriflow MCP 2026-07-28 server", () => {
  test("negotiates stateless HTTP and advertises the curated tool catalog", async () => {
    const client = await connect({
      kind: "oauth",
      userId: "00000000-0000-4000-8000-000000000001",
      clientId: "test-oauth-client",
      scopes: ["openid"],
    });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
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
    expect(tools).toHaveLength(11);
    expect(tools.some((tool) => tool.name === "narriflow_list_workspaces")).toBe(true);
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
});
