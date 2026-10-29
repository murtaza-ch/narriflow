import type {
  listUserWorkspaces,
  resolveWorkspaceContext,
  selectWorkspaceForActor,
} from "@narriflow/auth";
import type { projectService, workspaceMembershipService, workspaceService } from "@narriflow/services";
import { WorkspaceOperationError } from "@narriflow/services";
import { resolvePricingTier } from "@narriflow/validators";
import {
  type AuthContinuationConfig,
  type InviteAcceptance,
  type InvitePreview,
  bootstrapQuerySchema,
  inviteTokenParamSchema,
  type SessionBootstrap,
  type WorkspaceSelection,
  workspaceCapabilities,
  workspaceSelectionRequestSchema,
} from "@narriflow/validators/api/session";
import { createRouteApp, getSignedInActor } from "../../http/admission";
import { WORKSPACE_HEADER } from "../../http/request-policy-runtime";
import { validate } from "../../http/route";
import { sessionAdmission as access } from "./admission";
import { readMemberships, toSessionUser, toUsage } from "./projection";

/** Services the session routes call. `runtime.ts` supplies the production instances. */
export interface SessionRouteDeps {
  resolveWorkspaceContext: typeof resolveWorkspaceContext;
  selectWorkspaceForActor: typeof selectWorkspaceForActor;
  listUserWorkspaces: typeof listUserWorkspaces;
  workspaceService: Pick<typeof workspaceService, "getAvatarUrls" | "getInvitePreview">;
  workspaceMembershipService: Pick<typeof workspaceMembershipService, "acceptInvite">;
  projectService: Pick<typeof projectService, "getUsageSummary">;
  /** Validated Clerk origins for client navigation; never request-supplied. */
  authContinuation: AuthContinuationConfig;
}

/** Identity bootstrap, Workspace selection and invite acceptance (signed-in admissions). */
export function createSessionRoutes(deps: SessionRouteDeps) {
  const { workspaceService } = deps;

  async function selectionOf(
    userId: string,
    context: { workspaceId: string; workspaceName: string; role: "owner" | "admin" | "editor" | "viewer"; status: "active" | "pending_payment" | "restricted"; pricingTier: string; isPersonal: boolean },
  ): Promise<WorkspaceSelection> {
    const avatarUrls = await workspaceService.getAvatarUrls(userId, [context.workspaceId]);
    return {
      workspace: {
        id: context.workspaceId,
        name: context.workspaceName,
        role: context.role,
        status: context.status,
        pricingTier: resolvePricingTier(context.pricingTier),
        isPersonal: context.isPersonal,
        avatarUrl: avatarUrls[context.workspaceId] ?? null,
      },
      capabilities: workspaceCapabilities(context),
    };
  }

  return createRouteApp(access)
    // Provisions the user on first use, so it is idempotent despite GET. It lists memberships
    // without enforcing any one Workspace's status, so recovery pages work from a restricted one.
    .get("/session/bootstrap", validate("query", bootstrapQuerySchema), async (c) => {
      const user = getSignedInActor(c);
      // Identity-only client requests never carry the header, so the hint may also come as a query parameter.
      const hint = c.req.header(WORKSPACE_HEADER)?.trim() || c.req.valid("query").workspaceId;
      const contextRead = deps.resolveWorkspaceContext({ id: user.actorUserId }, hint);
      // The shell's credits ride along so it needs no second request. They start
      // as soon as the Workspace is known and overlap the memberships. A
      // Workspace this member cannot view gets none: its own bootstrap says why.
      const usageRead = contextRead.then(async (resolved) =>
        resolved && workspaceCapabilities(resolved)["content.view"]
          ? toUsage(
              await deps.projectService.getUsageSummary({
                actorUserId: user.actorUserId,
                workspaceId: resolved.workspaceId,
              }),
            )
          : null,
      );
      const [context, memberships, usage] = await Promise.all([
        contextRead,
        readMemberships(deps, user.actorUserId),
        usageRead,
      ]);
      if (!context) throw new Error("A signed-in user has no Workspace to select");
      const capabilities = workspaceCapabilities(context);
      c.header("X-Workspace-Id", context.workspaceId);
      const body: SessionBootstrap = {
        user: toSessionUser(user),
        memberships,
        selection: {
          workspaceId: context.workspaceId,
          workspaceSelectionChanged: context.workspaceSelectionChanged,
        },
        capabilities,
        usage,
        authContinuation: deps.authContinuation,
      };
      return c.json(body, 200);
    })

    // Validates live membership only. The browser stores the hint; nothing later trusts that storage.
    .post(
      "/session/workspace-selection",
      validate("json", workspaceSelectionRequestSchema),
      async (c) => {
        const user = getSignedInActor(c);
        const { workspaceId } = c.req.valid("json");
        const context = await deps.selectWorkspaceForActor(user.actorUserId, workspaceId);
        // A foreign and a nonexistent Workspace answer the same way.
        if (!context) {
          throw new WorkspaceOperationError(
            "workspace_access_denied",
            "You do not have access to this Workspace",
          );
        }
        c.header("X-Workspace-Id", context.workspaceId);
        const body: WorkspaceSelection = await selectionOf(user.actorUserId, context);
        return c.json(body, 200);
      },
    )

    .get("/invites/:token", validate("param", inviteTokenParamSchema), async (c) => {
      const { token } = c.req.valid("param");
      const invite = await workspaceService.getInvitePreview(token);
      if (!invite) {
        throw new WorkspaceOperationError(
          "workspace_invite_invalid",
          "This invitation is invalid or has expired",
        );
      }
      const body: InvitePreview = {
        workspaceName: invite.workspace.name,
        workspaceStatus: invite.workspace.status,
        role: invite.role,
        email: invite.email,
        expiresAt: invite.expiresAt.toISOString(),
      };
      return c.json(body, 200);
    })

    // The accepted Workspace is returned as the explicit selection; the client adopts it and
    // navigates to `destination`. Nothing here sets a cookie.
    .post("/invites/:token/accept", validate("param", inviteTokenParamSchema), async (c) => {
      const user = getSignedInActor(c);
      const { token } = c.req.valid("param");
      const accepted = await deps.workspaceMembershipService.acceptInvite(user.actorUserId, token);
      const context = await deps.selectWorkspaceForActor(user.actorUserId, accepted.workspaceId);
      if (!context) {
        throw new WorkspaceOperationError(
          "workspace_invite_unavailable",
          "This invitation is no longer available",
        );
      }
      c.header("X-Workspace-Id", context.workspaceId);
      const body: InviteAcceptance = { ...(await selectionOf(user.actorUserId, context)), destination: "/home" };
      return c.json(body, 200);
    });
}

export type SessionRoutes = ReturnType<typeof createSessionRoutes>;
