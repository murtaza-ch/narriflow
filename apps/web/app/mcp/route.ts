import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { buildNarriflowMcpServer } from "@narriflow/mcp-core";
import { checkRateLimit } from "@narriflow/services";
import {
  getMcpAllowedHosts,
  getMcpAllowedOrigins,
  getMcpPrincipal,
  getMcpResourceMetadataUrl,
  narriflowMcpTokenVerifier,
} from "@/lib/mcp-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mcpHandler = createMcpHandler(({ authInfo }) =>
  buildNarriflowMcpServer(getMcpPrincipal(authInfo)),
);

function authGate() {
  return requireBearerAuth({
    verifier: narriflowMcpTokenVerifier,
    resourceMetadataUrl: getMcpResourceMetadataUrl().href,
  });
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin");
  const headers = new Headers();
  if (!origin) return headers;
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Method, MCP-Name",
  );
  headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Protocol-Version");
  headers.set("Vary", "Origin");
  return headers;
}

function withCors(response: Response, request: Request) {
  const headers = new Headers(response.headers);
  corsHeaders(request).forEach((value, name) => {
    headers.set(name, value);
  });
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleMcp(request: Request) {
  const rejected =
    hostHeaderValidationResponse(request, getMcpAllowedHosts()) ??
    originValidationResponse(request, getMcpAllowedOrigins());
  if (rejected) return withCors(rejected, request);

  const auth = await authGate()(request);
  if (auth instanceof Response) return withCors(auth, request);

  const principal = getMcpPrincipal(auth);
  const rateLimit = await checkRateLimit(
    `mcp:${principal.kind}:${principal.clientId}:${principal.userId}`,
    300,
    60,
  );
  if (!rateLimit.allowed) {
    return withCors(Response.json(
      { error: "rate_limited", message: "MCP request limit exceeded" },
      { status: 429, headers: { "Retry-After": "60" } },
    ), request);
  }

  return withCors(await mcpHandler.fetch(request, { authInfo: auth }), request);
}

export const GET = handleMcp;
export const POST = handleMcp;
export const DELETE = handleMcp;

export function OPTIONS(request: Request) {
  const rejected =
    hostHeaderValidationResponse(request, getMcpAllowedHosts()) ??
    originValidationResponse(request, getMcpAllowedOrigins());
  if (rejected) return withCors(rejected, request);
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
