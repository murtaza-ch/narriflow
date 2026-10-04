import { buildNarriflowMcpServer } from "@narriflow/mcp-core";
import { createNarriflowMcpHttpHandler } from "@narriflow/mcp-core/http";
import { checkRateLimit } from "@narriflow/services";
import { getMcpAllowedHosts, getMcpAllowedOrigins, getMcpResourceMetadataUrl, narriflowMcpTokenVerifier } from "@/lib/mcp-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const handleMcp = createNarriflowMcpHttpHandler({
  verifier: narriflowMcpTokenVerifier, allowedHosts: getMcpAllowedHosts, allowedOrigins: getMcpAllowedOrigins,
  resourceMetadataUrl: () => getMcpResourceMetadataUrl().href, checkRateLimit, buildServer: buildNarriflowMcpServer,
});
export const GET = handleMcp;
export const POST = handleMcp;
export const DELETE = handleMcp;
export const OPTIONS = handleMcp;
