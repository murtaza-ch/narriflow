import { hostHeaderValidationResponse, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { McpToolAdmission, verifyMcpUploadHandoff } from "@narriflow/mcp-core";
import { getCurrentAppUser } from "@narriflow/auth";
import { getPrismaClient } from "@narriflow/db/client";
import { buildMcpContentPack, openUploadSessionSchema, type OpenUploadSessionInput } from "@narriflow/validators";
import { boundedMcpRequest, mcpCorsResponse, rejectMcpOrigin } from "@narriflow/mcp-core/http";
import { ExpectedDomainFailureError, isExpectedDomainFailure, uploadSessionService, workspaceService } from "@narriflow/services";
import { authenticateMcpRequest, getMcpAllowedHosts, getMcpAllowedOrigins, getMcpAuthFailureResponse, getMcpMutationGuard } from "@/lib/mcp-auth";
import { createMcpUploadHttpHandler } from "@/lib/mcp-upload-http";
import { admitMcpContinuation } from "@/lib/mcp-continuation-principal";
import { requireMcpUploadHandoffAdmission } from "@/lib/mcp-upload-handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const admission = new McpToolAdmission(workspaceService);
const handler = createMcpUploadHttpHandler({
  async admit(request, workspaceId) {
    let principal;
    let opening: OpenUploadSessionInput | undefined;
    let signedState: ReturnType<typeof verifyMcpUploadHandoff> | undefined;
    const handoff = request.headers.get("X-Narriflow-Upload-Intent");
    if (handoff) {
      const user = await getCurrentAppUser();
      if (!user) throw new OAuthError(OAuthErrorCode.InvalidToken, "Sign in to Narriflow to continue this upload");
      const initialOpen = new URL(request.url).pathname.endsWith("/open");
      const state = verifyMcpUploadHandoff(handoff, { actorUserId: user.id, workspaceId, allowAcceptedTransfer: true });
      signedState = state;
      if (initialOpen) {
        const parsed = openUploadSessionSchema.safeParse(await request.clone().json().catch(() => null));
        if (!parsed.success) throw new ExpectedDomainFailureError({ code: "mcp_upload_request_invalid", kind: "invalid", message: "Upload request is invalid" });
        const input = parsed.data;
        opening = input;
        const frozenGeneration = { contentPack: buildMcpContentPack(state.intent.generation), languageCode: state.intent.generation.languageCode };
        if (input.clientIdempotencyKey !== state.intent.clientIdempotencyKey || input.brandProfileId || input.brandTemplateId || JSON.stringify(input.generationContext) !== JSON.stringify(frozenGeneration) || input.title !== (state.intent.title ?? input.source.fileName)) throw new ExpectedDomainFailureError({ code: "mcp_upload_handoff_conflict", kind: "conflict", message: "Upload settings changed. Open the upload tool again before choosing the file." });
      } else {
        const input = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
        if (new URL(request.url).pathname.endsWith("/status")) {
          if (input?.clientIdempotencyKey !== state.intent.clientIdempotencyKey) throw new ExpectedDomainFailureError({ code: "mcp_upload_handoff_binding_mismatch", kind: "forbidden", message: "This upload status request belongs to another handoff" });
        } else {
          const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
          if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new ExpectedDomainFailureError({ code: "upload_session_not_found", kind: "missing", message: "Upload Session not found" });
          const session = await getPrismaClient()?.uploadSession.findFirst({ where: { id: sessionId, actorUserId: user.id, workspaceId, clientIdempotencyKey: state.intent.clientIdempotencyKey }, select: { id: true } });
          if (!session) throw new ExpectedDomainFailureError({ code: "mcp_upload_handoff_binding_mismatch", kind: "forbidden", message: "This Upload Session belongs to another handoff" });
        }
      }
      principal = await admitMcpContinuation(state, "processing:write");
    } else principal = await authenticateMcpRequest(request);
    const actor = await admission.requireWorkspace("narriflow_upload_video", principal, workspaceId);
    if (opening && signedState) {
      const input = opening;
      await requireMcpUploadHandoffAdmission(signedState, async () => {
        try { await uploadSessionService.status(actor, { clientIdempotencyKey: input.clientIdempotencyKey, sessionId: null, browserFingerprint: input.source.browserFingerprint }); return true; }
        catch (error) { if (isExpectedDomainFailure(error) && error.code === "upload_session_not_found") return false; throw error; }
      });
    }
    const beforeAccept = await getMcpMutationGuard(principal);
    return { actor, beforeAccept };
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
