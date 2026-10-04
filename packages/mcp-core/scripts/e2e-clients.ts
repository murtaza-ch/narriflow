import assert from "node:assert/strict";
import {
	Client,
	StreamableHTTPClientTransport,
	type Tool,
} from "@modelcontextprotocol/client";
import { MCP_TOOL_ADMISSIONS } from "../src/mcp-tool-admission";

// This live smoke check does not mint/revoke credentials, choose an arbitrary
// customer's workspace, start workers, or create domain work. Complete OAuth
// consent and clip delivery are separate recorded launch gates.
const credential = process.env.MCP_E2E_TOKEN?.trim() ?? "";
function progress(message: string, facts: Record<string, unknown> = {}) {
	console.log(
		JSON.stringify({ check: "mcp-live-acceptance", message, ...facts }),
	);
}
function safe(message: string) {
	return (
		credential ? message.replaceAll(credential, "[redacted]") : message
	).slice(0, 1000);
}
function modelVisible(tool: Tool) {
	const ui = tool._meta?.ui as { visibility?: unknown } | undefined;
	return !Array.isArray(ui?.visibility) || ui.visibility.includes("model");
}
function data(result: Awaited<ReturnType<Client["callTool"]>>) {
	assert.notEqual(
		result.isError,
		true,
		"A read tool returned an application error",
	);
	const content = result.structuredContent;
	assert(
		typeof content === "object" && content !== null && "data" in content,
		"Tool result must contain structured product facts",
	);
	const facts = content.data;
	assert(
		typeof facts === "object" && facts !== null && !Array.isArray(facts),
		"Tool product facts must be an object",
	);
	return facts as Record<string, unknown>;
}
async function metadata(url: URL) {
	const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	assert.equal(
		response.status,
		200,
		`Metadata request failed with HTTP ${response.status}`,
	);
	return response.json() as Promise<Record<string, unknown>>;
}

async function main() {
	assert.equal(
		process.env.MCP_E2E_ALLOW_LIVE,
		"1",
		"Set MCP_E2E_ALLOW_LIVE=1 to enable read-only checks against the configured endpoint",
	);
	assert(
		credential,
		"MCP_E2E_TOKEN must contain an existing scoped OAuth token or API key",
	);
	const authMode = process.env.MCP_E2E_AUTH_MODE;
	assert(
		authMode === "oauth" || authMode === "api_key",
		"Choose MCP_E2E_AUTH_MODE=oauth or api_key explicitly",
	);
	assert.equal(
		credential.startsWith("nf_"),
		authMode === "api_key",
		"The credential does not match the declared authentication mode",
	);
	const configured = process.env.MCP_E2E_BASE_URL;
	assert(
		configured,
		"MCP_E2E_BASE_URL must name the deployed or locally running Narriflow origin",
	);
	const base = new URL(configured);
	assert(
		!base.username && !base.password && !base.search && !base.hash,
		"The endpoint must not contain credentials, a query, or fragment",
	);
	assert(
		base.protocol === "https:" ||
			(base.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)),
		"Use HTTPS except for loopback development",
	);
	const mcpUrl = new URL("/mcp", base.origin);
	const protectedResource = await metadata(
		new URL("/.well-known/oauth-protected-resource/mcp", base.origin),
	);
	assert.equal(
		protectedResource.resource,
		mcpUrl.href,
		"Protected-resource metadata must identify this exact canonical MCP URL",
	);
	assert.deepEqual(protectedResource.bearer_methods_supported, ["header"]);
	assert(
		Array.isArray(protectedResource.scopes_supported) &&
			protectedResource.scopes_supported.includes("projects:read"),
		"Protected metadata must advertise application consent scopes",
	);
	const authorization = await metadata(
		new URL("/.well-known/oauth-authorization-server", base.origin),
	);
	assert.equal(typeof authorization.authorization_endpoint, "string");
	assert.equal(typeof authorization.token_endpoint, "string");
	progress("Public OAuth metadata checked", {
		resource: protectedResource.resource,
		issuer: authorization.issuer,
		pkce: authorization.code_challenge_methods_supported,
		dynamicRegistration:
			typeof authorization.registration_endpoint === "string",
	});

	const unauthenticated = await fetch(mcpUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: "challenge",
			method: "initialize",
			params: {},
		}),
	});
	assert.equal(unauthenticated.status, 401);
	assert.match(
		unauthenticated.headers.get("WWW-Authenticate") ?? "",
		/^Bearer /,
	);

	for (const mode of ["auto", "legacy"] as const) {
		const observedVersions = new Set<string>();
		const client = new Client(
			{ name: "narriflow-live-acceptance", version: "1.0.0" },
			{ versionNegotiation: { mode } },
		);
		const transport = new StreamableHTTPClientTransport(mcpUrl, {
			authProvider: { token: async () => credential },
			fetch: (input, init) => {
				const request = new Request(input, init);
				const protocol = request.headers.get("MCP-Protocol-Version");
				if (protocol) observedVersions.add(protocol);
				return fetch(request);
			},
		});
		try {
			await client.connect(transport);
			const catalog = await client.listTools();
			const modelTools = catalog.tools
				.filter(modelVisible)
				.map((tool) => tool.name)
				.sort();
			assert.deepEqual(
				modelTools,
				Object.keys(MCP_TOOL_ADMISSIONS).sort(),
				"The live model tool catalog differs from the current shared admission catalog",
			);
			const workspaceFacts = data(
				await client.callTool({
					name: "narriflow_list_workspaces",
					arguments: {},
				}),
			);
			assert(
				Array.isArray(workspaceFacts.workspaces),
				"Workspace discovery must return workspaces",
			);
			const workspaces = workspaceFacts.workspaces as Array<{
				workspaceId?: string;
				mcpEnabled?: boolean;
			}>;
			assert(
				workspaces.every(
					(workspace) => typeof workspace.workspaceId === "string",
				),
				"Discovery must consistently expose workspaceId",
			);
			const selected = process.env.MCP_E2E_WORKSPACE_ID;
			if (selected) {
				assert(
					workspaces.some(
						(workspace) =>
							workspace.workspaceId === selected && workspace.mcpEnabled,
					),
					"The selected workspace is not currently MCP eligible",
				);
				data(
					await client.callTool({
						name: "narriflow_list_projects",
						arguments: { workspaceId: selected, limit: 2 },
					}),
				);
			}
			progress("Supplied credential passed read-only SDK checks", {
				authentication: authMode,
				negotiationMode: mode,
				observedProtocolVersions: [...observedVersions],
				modelToolCount: modelTools.length,
				appOnlyToolCount: catalog.tools.length - modelTools.length,
				serverCapabilities: client.getServerCapabilities(),
			});
		} finally {
			await client.close();
		}
	}
	progress(
		"Authorization-code consent, real Codex/Claude/ChatGPT walkthroughs and clip/upload delivery remain unverified",
	);
}

await main().catch((error: unknown) => {
	console.error(
		JSON.stringify({
			check: "mcp-live-acceptance",
			outcome: "failed",
			message: safe(
				error instanceof Error ? error.message : "Live acceptance failed",
			),
		}),
	);
	process.exitCode = 1;
});
