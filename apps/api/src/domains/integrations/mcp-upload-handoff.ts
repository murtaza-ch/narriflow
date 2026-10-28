import type { McpUploadHandoffState, NarriflowMcpPrincipal } from "@narriflow/mcp-core";
import { assertInlineFinishing, ExpectedDomainFailureError, type ActorScope } from "@narriflow/services";
import { buildGenerationContext, openUploadSessionSchema } from "@narriflow/validators";

export interface McpUploadHandoffDependencies {
  verify(token: string, options: { actorUserId: string; workspaceId: string; allowExpired?: boolean }): McpUploadHandoffState;
  admitContinuation(state: McpUploadHandoffState, scope: "processing:write"): Promise<NarriflowMcpPrincipal>;
  requireToolWorkspace(principal: NarriflowMcpPrincipal, workspaceId: string): Promise<ActorScope>;
  requireOwnerActor(userId: string, workspaceId: string): Promise<ActorScope>;
  findOwnedSession(input: { sessionId: string; userId: string; workspaceId: string; clientIdempotencyKey: string }): Promise<boolean>;
  principalGuard(principal: NarriflowMcpPrincipal): Promise<() => void>;
  ownerGuard(userId: string): Promise<() => void>;
}

function failure(code: string, kind: "invalid" | "forbidden" | "conflict" | "missing", message: string): never {
  throw new ExpectedDomainFailureError({ code, kind, message });
}

/** The signed handoff authorizes only the initial `open`, within its expiry and
 * with `processing:write` in its signed grant. Every later action continues
 * the person's own Upload Session under their current Workspace authority;
 * the signed state, even expired, only identifies which session that is. */
export async function admitMcpUploadHandoff(
  request: Request,
  input: { workspaceId: string; token: string; userId: string },
  deps: McpUploadHandoffDependencies,
): Promise<{ actor: ActorScope; beforeAccept: () => void; authority: "assistant" | "owner"; credential?: { scopes: readonly string[] } }> {
  const { workspaceId, token, userId } = input;
  const action = new URL(request.url).pathname.split("/").at(-1);
  const body = await request.clone().json().catch(() => null) as unknown;
  if (action === "open") {
    const state = deps.verify(token, { actorUserId: userId, workspaceId });
    const parsed = openUploadSessionSchema.safeParse(body);
    if (!parsed.success) failure("mcp_upload_request_invalid", "invalid", "Upload request is invalid");
    const opening = parsed.data;
    // A handoff that names a Recipe opens with the Recipe, which admission reads once.
    const frozenGeneration = state.intent.recipeId ? undefined : buildGenerationContext(state.intent.generation, state.intent.finishing);
    if (opening.clientIdempotencyKey !== state.intent.clientIdempotencyKey || opening.brandProfileId !== state.intent.brandProfileId || opening.recipeId !== state.intent.recipeId || opening.brandTemplateId || JSON.stringify(opening.generationContext) !== JSON.stringify(frozenGeneration) || opening.title !== (state.intent.title ?? opening.source.fileName)) {
      failure("mcp_upload_handoff_conflict", "conflict", "Upload settings changed. Open the upload tool again before choosing the file.");
    }
    const principal = await deps.admitContinuation(state, "processing:write");
    const actor = await deps.requireToolWorkspace(principal, workspaceId);
    // The same rules as the tool call that signed this intent: review sending belongs to an Autopilot rule.
    await assertInlineFinishing(actor, state.intent.finishing);
    return { actor, beforeAccept: await deps.principalGuard(principal), authority: "assistant", credential: principal };
  }
  const state = deps.verify(token, { actorUserId: userId, workspaceId, allowExpired: true });
  const fields = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (action === "status") {
    if (fields.clientIdempotencyKey !== state.intent.clientIdempotencyKey) failure("mcp_upload_handoff_binding_mismatch", "forbidden", "This upload status request belongs to another handoff");
  } else {
    const sessionId = typeof fields.sessionId === "string" ? fields.sessionId : "";
    if (!/^[a-f0-9-]{36}$/i.test(sessionId)) failure("upload_session_not_found", "missing", "Upload Session not found");
    if (!await deps.findOwnedSession({ sessionId, userId, workspaceId, clientIdempotencyKey: state.intent.clientIdempotencyKey })) {
      failure("mcp_upload_handoff_binding_mismatch", "forbidden", "This Upload Session belongs to another handoff");
    }
  }
  const actor = await deps.requireOwnerActor(userId, workspaceId);
  return { actor, beforeAccept: await deps.ownerGuard(userId), authority: "owner" };
}
