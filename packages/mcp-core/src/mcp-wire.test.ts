import { describe, expect, test } from "bun:test";
import {
	McpServer,
	OAuthError,
	OAuthErrorCode,
} from "@modelcontextprotocol/server";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { createNarriflowMcpHttpHandler } from "./mcp-http-handler";

const origin = "https://narriflow.test";
const url = `${origin}/mcp`;
const version = "2026-07-28";
const meta = {
	"io.modelcontextprotocol/protocolVersion": version,
	"io.modelcontextprotocol/clientInfo": {
		name: "acceptance",
		version: "1.0.0",
	},
	"io.modelcontextprotocol/clientCapabilities": {},
};

function harness() {
	const factories: string[] = [];
	let active = true;
	const fetch = createNarriflowMcpHttpHandler({
		verifier: {
			verifyAccessToken: async (token) => {
				if (!active || !["caller-a", "caller-b"].includes(token))
					throw new OAuthError(OAuthErrorCode.InvalidToken, "Revoked");
				return {
					token,
					clientId: "acceptance",
					scopes: ["projects:read"],
					expiresAt: 2_100_000_000,
					extra: {
						narriflowPrincipal: {
							kind: "oauth",
							userId: token,
							clientId: "acceptance",
							scopes: ["projects:read"],
						},
					},
				};
			},
		},
		allowedHosts: () => ["narriflow.test"],
		allowedOrigins: () => [origin],
		resourceMetadataUrl: () =>
			`${origin}/.well-known/oauth-protected-resource/mcp`,
		checkRateLimit: async () => ({
			allowed: true,
			remaining: 299,
			limit: 300,
			availability: "available",
		}),
		diagnostic: () => {},
		buildServer(principal) {
			factories.push(principal.userId);
			const server = new McpServer(
				{ name: "acceptance", version: "1" },
				{
					cacheHints: {
						"server/discover": { cacheScope: "public", ttlMs: 300_000 },
					},
				},
			);
			server.registerTool(
				"narriflow_get_project",
				{
					inputSchema: z.strictObject({}),
					outputSchema: z.strictObject({ callerUserId: z.string() }),
				},
				async () => ({
					content: [{ type: "text", text: principal.userId }],
					structuredContent: { callerUserId: principal.userId },
					ttlMs: 0,
					cacheScope: "private",
				}),
			);
			return server;
		},
	});
	return {
		fetch,
		factories,
		revoke: () => {
			active = false;
		},
	};
}

function modernRequest(
	method: string,
	params: Record<string, unknown> = {},
	headers: Record<string, string> = {},
) {
	return new Request(url, {
		method: "POST",
		headers: {
			Host: "narriflow.test",
			authorization: "Bearer caller-a",
			"Content-Type": "application/json",
			"MCP-Protocol-Version": version,
			"MCP-Method": method,
			...(typeof params.name === "string" ? { "MCP-Name": params.name } : {}),
			...headers,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: "acceptance",
			method,
			params: { ...params, _meta: meta },
		}),
	});
}

describe("Authenticated stateless MCP wire", () => {
	test("serves a modern complete result and never issues a session", async () => {
		const h = harness();
		const response = await h.fetch(modernRequest("server/discover"));
		expect(response.status).toBe(200);
		expect(response.headers.get("MCP-Session-Id")).toBeNull();
		const body = await response.json();
		expect(body.result.resultType).toBe("complete");
		expect(h.factories).toEqual(["caller-a"]);
	});

	test("older clients use the same request factory and current credentials", async () => {
		const h = harness();
		const client = new Client(
			{ name: "older-acceptance", version: "1" },
			{ versionNegotiation: { mode: "legacy" } },
		);
		const seenVersions: Array<string | null> = [];
		const transport = new StreamableHTTPClientTransport(new URL(url), {
			authProvider: { token: async () => "caller-a" },
			fetch: (input, init) => {
				const request = new Request(input, init);
				request.headers.set("Host", "narriflow.test");
				seenVersions.push(request.headers.get("MCP-Protocol-Version"));
				return h.fetch(request);
			},
		});
		try {
			await client.connect(transport);
			const first = await client.callTool({
				name: "narriflow_get_project",
				arguments: {},
			});
			expect(first.structuredContent).toEqual({ callerUserId: "caller-a" });
			expect(seenVersions).toContain("2025-11-25");
			h.revoke();
			await expect(
				client.callTool({ name: "narriflow_get_project", arguments: {} }),
			).rejects.toThrow();
		} finally {
			await client.close();
		}
	});

	test("private complete results never reuse another caller's snapshot", async () => {
		const h = harness();
		for (const caller of ["caller-a", "caller-b", "caller-a"]) {
			const response = await h.fetch(
				modernRequest(
					"tools/call",
					{ name: "narriflow_get_project", arguments: {} },
					{ authorization: `Bearer ${caller}` },
				),
			);
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.result).toMatchObject({
				resultType: "complete",
				ttlMs: 0,
				cacheScope: "private",
				structuredContent: { callerUserId: caller },
			});
			expect(response.headers.get("MCP-Session-Id")).toBeNull();
		}
		expect(h.factories).toEqual(["caller-a", "caller-b", "caller-a"]);
	});

	for (const [label, headers] of [
		["method", { "MCP-Method": "tools/list" }],
		["version", { "MCP-Protocol-Version": "2025-11-25" }],
		["name", { "MCP-Name": "another_tool" }],
	] as const)
		test(`rejects ${label} header/body mismatch before dispatch`, async () => {
			const h = harness();
			const response = await h.fetch(
				modernRequest(
					"tools/call",
					{ name: "narriflow_get_project", arguments: {} },
					headers,
				),
			);
			expect(response.status).toBe(400);
			expect((await response.json()).error.code).toBe(-32020);
			expect(h.factories).toEqual([]);
		});

	test("malformed modern metadata is rejected without invoking a tool", async () => {
		const h = harness();
		const request = modernRequest("server/discover");
		const response = await h.fetch(
			new Request(request, {
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "server/discover",
					params: {
						_meta: {
							...meta,
							"io.modelcontextprotocol/clientCapabilities": "malformed",
						},
					},
				}),
			}),
		);
		expect(response.status).toBe(400);
		expect(h.factories).toEqual([]);
	});

	test("HTTP methods, CORS, bearer challenges and byte bounds share the serving boundary", async () => {
		const h = harness();
		const unauthorized = modernRequest(
			"server/discover",
			{},
			{ Origin: origin, authorization: "" },
		);
		const challenge = await h.fetch(unauthorized);
		expect(challenge.status).toBe(401);
		expect(challenge.headers.get("WWW-Authenticate")).toContain(
			"resource_metadata=",
		);
		expect(challenge.headers.get("Cache-Control")).toBe("no-store");
		expect(challenge.headers.get("Access-Control-Allow-Origin")).toBe(origin);
		const denied = await h.fetch(
			modernRequest(
				"server/discover",
				{},
				{ Origin: "http://narriflow.test:3000" },
			),
		);
		expect(denied.status).toBe(403);
		expect(denied.headers.get("Access-Control-Allow-Origin")).toBeNull();
		const options = await h.fetch(
			new Request(url, {
				method: "OPTIONS",
				headers: { Host: "narriflow.test", Origin: origin },
			}),
		);
		expect(options.status).toBe(204);
		expect(options.headers.get("Access-Control-Allow-Headers")).toContain(
			"MCP-Name",
		);
		const unsupported = await h.fetch(
			new Request(url, {
				method: "PUT",
				headers: { Host: "narriflow.test", authorization: "Bearer caller-a" },
			}),
		);
		expect(unsupported.status).toBe(405);
		const oversized = await h.fetch(
			new Request(url, {
				method: "POST",
				headers: { Host: "narriflow.test", authorization: "Bearer caller-a" },
				body: "x".repeat(1024 * 1024 + 1),
			}),
		);
		expect(oversized.status).toBe(413);
		expect(h.factories).toEqual([]);
	});

	test("application write consent fails with a standard scope challenge before tool dispatch", async () => {
		const h = harness();
		const response = await h.fetch(
			modernRequest("tools/call", {
				name: "narriflow_run_autopilot_rule_now",
				arguments: {},
			}),
		);
		expect(response.status).toBe(403);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			"insufficient_scope",
		);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			"autopilot:write",
		);
		expect(h.factories).toEqual([]);
	});
	for (const [tool, scope] of [
		["narriflow_upload_open", "processing:write"],
		["narriflow_upload_status", "processing:write"],
		["narriflow_upload_grants", "processing:write"],
		["narriflow_upload_finalize", "processing:write"],
		["narriflow_upload_discard", "processing:write"],
		["narriflow_accept_social_post_intent", "publishing:write"],
	] as const) test(`embedded ${tool} uses its public workflow scope challenge`, async () => {
		const h = harness();
		const response = await h.fetch(modernRequest("tools/call", { name: tool, arguments: {} }));
		expect(response.status).toBe(403);
		expect(response.headers.get("WWW-Authenticate")).toContain(scope);
		expect(h.factories).toEqual([]);
	});
});
