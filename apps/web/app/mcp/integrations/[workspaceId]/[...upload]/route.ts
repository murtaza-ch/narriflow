import { hostHeaderValidationResponse, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { McpToolAdmission, MCP_WORKSPACE_ACCESS_MESSAGE, verifyMcpUploadHandoff } from "@narriflow/mcp-core";
import { getCurrentAppUser } from "@narriflow/auth";
import { getPrismaClient } from "@narriflow/db/client";
import { boundedMcpRequest, mcpCorsResponse, rejectMcpOrigin } from "@narriflow/mcp-core/http";
import { checkRateLimit, ExpectedDomainFailureError, hasFeature, uploadSessionService, workspaceService } from "@narriflow/services";
import { authenticateMcpRequest, getMcpAllowedHosts, getMcpAllowedOrigins, getMcpAuthFailureResponse, getMcpMutationGuard } from "@/lib/mcp-auth";
import { createMcpUploadHttpHandler } from "@/lib/mcp-upload-http";
import { admitMcpContinuation } from "@/lib/mcp-continuation-principal";
import { mcpIntegrationMutationGuard } from "@/lib/mcp-integration-admission";
import { admitMcpUploadHandoff } from "@/lib/mcp-upload-handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const admission = new McpToolAdmission(workspaceService);

/** A person finishing their own Upload Session acts under their current
 * Workspace authority, never the assistant credential that opened it. */
async function requireUploadOwnerActor(userId: string, workspaceId: string) {
  const actor = await workspaceService.requireActor(userId, workspaceId, "processing.consume");
  if (actor.status !== "active" || !hasFeature(actor.pricingTier, "integrations.mcp")) {
    throw new ExpectedDomainFailureError({ code: "mcp_workspace_access_unavailable", kind: "payment_required", message: MCP_WORKSPACE_ACCESS_MESSAGE });
  }
  return actor;
}

const handler = createMcpUploadHttpHandler({
  async admit(request, workspaceId) {
    const token = request.headers.get("X-Narriflow-Upload-Intent");
    if (!token) {
      const principal = await authenticateMcpRequest(request);
      const actor = await admission.requireWorkspace("narriflow_upload_video", principal, workspaceId);
      return { actor, beforeAccept: await getMcpMutationGuard(principal) };
    }
    const user = await getCurrentAppUser();
    if (!user) throw new OAuthError(OAuthErrorCode.InvalidToken, "Sign in to Narriflow to continue this upload");
    return admitMcpUploadHandoff(request, { workspaceId, token, userId: user.id }, {
      verify: verifyMcpUploadHandoff,
      admitContinuation: (state, scope) => admitMcpContinuation(state, scope),
      requireToolWorkspace: (principal, id) => admission.requireWorkspace("narriflow_upload_video", principal, id),
      requireOwnerActor: requireUploadOwnerActor,
      findOwnedSession: async ({ sessionId, userId, workspaceId: id, clientIdempotencyKey }) => Boolean(await getPrismaClient()?.uploadSession.findFirst({ where: { id: sessionId, actorUserId: userId, workspaceId: id, clientIdempotencyKey }, select: { id: true } })),
      principalGuard: getMcpMutationGuard,
      ownerGuard: async (userId) => mcpIntegrationMutationGuard(await checkRateLimit(`mcp-upload-owner:${userId}`, 300, 60)),
    });
  },
  authenticationFailure: getMcpAuthFailureResponse,
  service: uploadSessionService,
});

type Context = { params: Promise<{ workspaceId: string; upload: string[] }> };
export async function POST(request: Request, context: Context) {
  const origins = getMcpAllowedOrigins();
  const rejected = hostHeaderValidationResponse(request, getMcpAllowedHosts()) ?? rejectMcpOrigin(request, origins);
  if (rejected) return rejected;
  const { workspaceId } = await context.params;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(workspaceId)) return Response.json({ error: "invalid_workspace" }, { status: 400 });
  const bounded = await boundedMcpRequest(request);
  const response = bounded instanceof Response ? bounded : await handler(bounded, workspaceId);
  return mcpCorsResponse(response, request, origins);
}
export function OPTIONS(request: Request) {
  const origins = getMcpAllowedOrigins();
  return hostHeaderValidationResponse(request, getMcpAllowedHosts()) ?? rejectMcpOrigin(request, origins) ?? mcpCorsResponse(new Response(null, { status: 204 }), request, origins);
}
