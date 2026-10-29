import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { createBearerAuthenticator, createServerClerkClient, getAppUserForClerkIdentity } from "@narriflow/auth";
import { getPrismaClient } from "@narriflow/db/client";
import { buildNarriflowMcpServer, McpToolAdmission, MCP_WORKSPACE_ACCESS_MESSAGE, verifyMcpPreparation, verifyMcpUploadHandoff, acceptMcpConfirmation } from "@narriflow/mcp-core";
import { principalFromMcpAuth } from "@narriflow/mcp-core/auth";
import { createNarriflowMcpHttpHandler } from "@narriflow/mcp-core/http";
import { checkRateLimit, ExpectedDomainFailureError, integrationUploadSessionKey, integrationUploadSessions, recipeService, requirePlanFeature, socialOAuthService, socialPublicationScheduling, uploadSessionService, workspaceService } from "@narriflow/services";
import { buildGenerationContext, hasFeature, roleHasWorkspaceCapability, type WorkspaceCapability } from "@narriflow/validators";
import type { ApiConfig } from "../../config";
import { createMcpAuth, getMcpMutationGuard } from "./mcp-auth";
import { inspectMcpConfiguration } from "./mcp-configuration";
import { admitMcpContinuation } from "./mcp-continuation-principal";
import { mcpIntegrationMutationGuard } from "./mcp-integration-admission";
import type { McpTransportDeps } from "./mcp";
import { admitMcpUploadHandoff } from "./mcp-upload-handoff";
import { createMcpUploadHttpHandler } from "./mcp-upload-http";
import type { IntegrationsRouteDeps } from "./routes";

function continuationAdmission(auth: ReturnType<typeof createMcpAuth>) {
  return (state: Parameters<typeof admitMcpContinuation>[0], scope: Parameters<typeof admitMcpContinuation>[1]) =>
    admitMcpContinuation(state, scope, undefined, async (token) => principalFromMcpAuth(await auth.verifier.verifyAccessToken(token)));
}

/** Recheck the signed Workspace, independently of the browser's selected hint. */
export async function requireContinuationActor(userId: string, workspaceId: string, capability: WorkspaceCapability) {
  const member = await workspaceService.findActor(userId, workspaceId);
  if (member && (!roleHasWorkspaceCapability(member.role, capability) || !hasFeature(member.pricingTier, "integrations.mcp") || member.status !== "active")) {
    const reason = !roleHasWorkspaceCapability(member.role, capability) ? "role" : !hasFeature(member.pricingTier, "integrations.mcp") ? "plan" : "status";
    throw new ExpectedDomainFailureError({
      code: "integration_access_unavailable", kind: reason === "role" ? "forbidden" : "payment_required", message: MCP_WORKSPACE_ACCESS_MESSAGE,
      details: { reason, workspace: { workspaceId: member.workspaceId, workspaceName: member.workspaceName, role: member.role, status: member.status, pricingTier: member.pricingTier } },
    });
  }
  const actor = await workspaceService.requireActor(userId, workspaceId, capability);
  requirePlanFeature(actor.pricingTier, "integrations.mcp");
  return actor;
}

export function createIntegrationsRouteDeps(config: ApiConfig): IntegrationsRouteDeps {
  const auth = createMcpAuth(config);
  const admitContinuation = continuationAdmission(auth);
  return {
    async status(actor) {
      const configuration = await inspectMcpConfiguration({ resourceUrl: auth.resourceUrl, issuerUrl: auth.issuerUrl, hasVerificationSecret: Boolean(config.clerk.secretKey), hasConfirmationSecret: Buffer.byteLength(process.env.MCP_CONTINUATION_SECRET ?? "") >= 32 });
      return { mcpUrl: auth.resourceUrl, configuration, workspace: { workspaceId: actor.workspaceId, workspaceName: actor.workspaceName, role: actor.role, status: actor.status, pricingTier: actor.pricingTier } };
    },
    async preparation(userId, token) {
      const state = verifyMcpPreparation(token, { actorUserId: userId });
      const actor = await requireContinuationActor(userId, state.workspaceId, "publishing.manage");
      await admitContinuation(state, "publishing:write");
      const [accounts, workspace] = await Promise.all([socialOAuthService.listAccounts(actor), workspaceService.getWorkspace(userId, state.workspaceId)]);
      const account = accounts.find((account) => account.id === state.intent.accountId && account.platform === state.intent.platform);
      return { workspaceId: state.workspaceId, workspaceName: `${workspace?.name ?? "Workspace"} · ${state.workspaceId}`, destinationAccount: account ? `${account.displayName}${account.handle ? ` (${account.handle})` : ""} · ${account.id}` : `${state.intent.accountId} · Account unavailable`, expiresAt: new Date(state.expiresAtMs).toISOString(), intent: state.intent };
    },
    async uploadHandoff(userId, token) {
      const state = verifyMcpUploadHandoff(token, { actorUserId: userId, allowExpired: true });
      const actor = await requireContinuationActor(userId, state.workspaceId, "processing.consume");
      const resumeOnly = Date.now() >= state.expiresAtMs;
      if (resumeOnly) {
        if (!await uploadSessionService.hasOwnSessionByClientKey(actor, integrationUploadSessionKey(actor.actorUserId, state.intent.clientIdempotencyKey))) {
          verifyMcpUploadHandoff(token, { actorUserId: userId });
        }
      } else {
        await admitContinuation(state, "processing:write");
      }
      const recipe = state.intent.recipeId && !resumeOnly ? await recipeService.get(actor, state.intent.recipeId) : null;
      return { workspaceId: state.workspaceId, clientIdempotencyKey: state.intent.clientIdempotencyKey, title: state.intent.title, brandProfileId: state.intent.brandProfileId, recipeId: state.intent.recipeId, recipeName: recipe?.name ?? null, resumeOnly, generationContext: state.intent.recipeId ? undefined : buildGenerationContext(state.intent.generation, state.intent.finishing) };
    },
    async confirm(userId, input, beforeAccept) {
      const state = verifyMcpPreparation(input.token, { actorUserId: userId });
      const actor = await requireContinuationActor(userId, state.workspaceId, "publishing.manage");
      if (input.decision === "decline") {
        const accepted = await socialPublicationScheduling.replay({ ...state.intent, actorUserId: userId, scheduledFor: new Date(state.intent.scheduledFor) }, { actor });
        return { destination: accepted ? `/projects/${state.intent.projectId}?publicationId=${encodeURIComponent(accepted.id)}` : "/integrations/mcp/confirm?declined=1" };
      }
      acceptMcpConfirmation(input.token, { actorUserId: userId, accepted: true });
      const guard = await getMcpMutationGuard(await admitContinuation(state, "publishing:write"));
      const publication = await socialPublicationScheduling.schedule({ ...state.intent, actorUserId: userId, scheduledFor: new Date(state.intent.scheduledFor), beforeAccept: async () => {
        verifyMcpPreparation(input.token, { actorUserId: userId });
        beforeAccept();
        guard();
      } }, { actor });
      return { destination: `/projects/${state.intent.projectId}?publicationId=${encodeURIComponent(publication.id)}` };
    },
  };
}

export function createMcpTransportDeps(config: ApiConfig, clerk = createServerClerkClient(config.clerk)): McpTransportDeps {
  const auth = createMcpAuth(config);
  const admission = new McpToolAdmission(workspaceService);
  const admitContinuation = continuationAdmission(auth);
  const authenticateSession = createBearerAuthenticator({ client: clerk, authorizedParties: config.clerk.authorizedParties });
  return {
    allowedHosts: auth.allowedHosts, allowedOrigins: auth.allowedOrigins, issuerUrl: auth.issuerUrl, protectedResourceMetadata: auth.protectedResourceMetadata,
    handleMcp: createNarriflowMcpHttpHandler({ verifier: auth.verifier, allowedHosts: () => auth.allowedHosts, allowedOrigins: () => auth.allowedOrigins, resourceMetadataUrl: () => auth.metadataUrl, checkRateLimit,
      buildServer: (principal, options) => buildNarriflowMcpServer(principal, { ...options, appOrigin: config.webOrigin, apiOrigin: config.apiOrigin }),
    }),
    handleUpload: createMcpUploadHttpHandler({
      async admit(request, workspaceId) {
        const token = request.headers.get("X-Narriflow-Upload-Intent");
        if (!token) {
          const principal = await auth.authenticate(request);
          const actor = await admission.requireWorkspace("narriflow_upload_video", principal, workspaceId);
          return { actor, beforeAccept: await getMcpMutationGuard(principal), credential: principal };
        }
        const result = await authenticateSession(request);
        if (result.status === "unavailable") throw new ExpectedDomainFailureError({ code: "authentication_unavailable", kind: "unavailable", message: "Sign-in verification is temporarily unavailable", retryAfterSeconds: 5 });
        if (result.status !== "authenticated") throw new OAuthError(OAuthErrorCode.InvalidToken, "Sign in to Narriflow to continue this upload");
        const user = await getAppUserForClerkIdentity(result.identity.clerkUserId, clerk);
        if (!user) throw new OAuthError(OAuthErrorCode.InvalidToken, "Sign in to Narriflow to continue this upload");
        return admitMcpUploadHandoff(request, { workspaceId, token, userId: user.id }, {
          verify: verifyMcpUploadHandoff, admitContinuation,
          requireToolWorkspace: (principal, id) => admission.requireWorkspace("narriflow_upload_video", principal, id),
          requireOwnerActor: (userId, id) => requireContinuationActor(userId, id, "processing.consume"),
          findOwnedSession: async ({ sessionId, userId, workspaceId: id, clientIdempotencyKey }) => Boolean(await getPrismaClient()?.uploadSession.findFirst({ where: { id: sessionId, actorUserId: userId, workspaceId: id, clientIdempotencyKey: integrationUploadSessionKey(userId, clientIdempotencyKey) }, select: { id: true } })),
          principalGuard: getMcpMutationGuard,
          ownerGuard: async (userId) => mcpIntegrationMutationGuard(await checkRateLimit(`mcp-upload-owner:${userId}`, 300, 60)),
        });
      },
      authenticationFailure: auth.authenticationFailure,
      service: integrationUploadSessions(uploadSessionService),
    }),
  };
}
