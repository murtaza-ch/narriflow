import type { Prisma, WorkspaceRole } from "@prisma/client";
import type { ActorScope } from "./actor-scope";
import type { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import type { IntegrationMutation } from "./operation-receipt";
import {
  WorkspaceOperationError,
  assertWorkspaceInviteEntitlement,
  normalizeWorkspaceName,
  type WorkspaceService,
} from "./workspace.service";
import { WORKSPACE_RECEIPT_COMMANDS } from "./workspace-receipt-commands";

/** Transport facts the workspace commands need: the caller's key and the new-mutation limiter. */
export type WorkspaceMutation = Pick<IntegrationMutation, "clientIdempotencyKey" | "beforeAccept">;

export interface WorkspaceCommandDependencies {
  receipts: () => ReturnType<typeof getOperationReceiptExecutor>;
  workspaces: Pick<
    WorkspaceService,
    | "findActor"
    | "requireActor"
    | "getPersonalWorkspaceId"
    | "createPendingBusinessWorkspace"
    | "issueInvite"
    | "readResendableInvite"
  >;
}

export interface BusinessWorkspaceAccepted {
  workspaceId: string;
  name: string;
  replayed: boolean;
}

/** The invite facts a receipt may keep. The raw token is a credential and never enters a receipt. */
export interface InviteAcceptedFacts {
  id: string;
  email: string;
  role: Exclude<WorkspaceRole, "owner">;
  expiresAt: string;
}

export interface InviteAccepted {
  invite: InviteAcceptedFacts;
  /** The one-time invitation token. Null on a replay: the first response carried it and it cannot be recovered. */
  token: string | null;
  replayed: boolean;
}

/**
 * Receipt-backed retryable commands of the workspace domain. Only names
 * registered in `WORKSPACE_RECEIPT_COMMANDS` may be recorded. Each commits its
 * domain write and receipt in one transaction; the invitation email is sent by
 * the caller after commit.
 */
export function createWorkspaceCommands(deps: WorkspaceCommandDependencies) {
  const { receipts, workspaces } = deps;

  /** Issues the invite inside the acceptance transaction; the raw token stays in memory only. */
  async function acceptInvite(
    command: "invite_workspace_member" | "resend_workspace_invite",
    actor: ActorScope,
    input: { email: string; role: Exclude<WorkspaceRole, "owner"> } | { inviteId: string },
    mutation: WorkspaceMutation,
  ): Promise<InviteAccepted> {
    let issuedToken: string | null = null;
    const accepted = await receipts().execute<InviteAcceptedFacts>({
      identity: {
        workspaceId: actor.workspaceId,
        actorUserId: actor.actorUserId,
        command,
        clientIdempotencyKey: mutation.clientIdempotencyKey,
      },
      input,
      authorize: async () => {
        await workspaces.requireActor(actor.actorUserId, actor.workspaceId, "members.invite");
      },
      beforeAccept: mutation.beforeAccept,
      mutate: async (tx: Prisma.TransactionClient) => {
        // Entitlement and the acting member's role are read where the invite is
        // written, so a plan or role change between admission and commit refuses it.
        const current = await workspaces.requireActor(actor.actorUserId, actor.workspaceId, "members.invite");
        const target = "inviteId" in input
          ? await workspaces.readResendableInvite(tx, actor.workspaceId, input.inviteId)
          : input;
        assertWorkspaceInviteEntitlement({
          pricingTier: current.pricingTier,
          status: current.status,
          actorRole: current.role,
          invitedRole: target.role,
        });
        const issued = await workspaces.issueInvite(tx, actor.actorUserId, actor.workspaceId, target);
        issuedToken = issued.token;
        return {
          resourceType: "workspace_invite",
          resourceId: issued.id,
          value: {
            id: issued.id,
            email: issued.email,
            role: issued.role as Exclude<WorkspaceRole, "owner">,
            expiresAt: issued.expiresAt.toISOString(),
          },
        };
      },
    });
    return {
      invite: accepted.value,
      token: accepted.replayed ? null : issuedToken,
      replayed: accepted.replayed,
    };
  }

  return {
    receiptCommands: WORKSPACE_RECEIPT_COMMANDS,

    /**
     * Creates the pending Business Workspace. A signed-in user has no selected
     * Workspace yet, so the receipt is recorded under their personal Workspace.
     */
    async createBusinessWorkspace(
      actorUserId: string,
      input: { name: string },
      mutation: WorkspaceMutation,
    ): Promise<BusinessWorkspaceAccepted> {
      const name = normalizeWorkspaceName(input.name);
      const identityWorkspaceId = await workspaces.getPersonalWorkspaceId(actorUserId);
      const accepted = await receipts().execute<{ workspaceId: string; name: string }>({
        identity: {
          workspaceId: identityWorkspaceId,
          actorUserId,
          command: "create_business_workspace",
          clientIdempotencyKey: mutation.clientIdempotencyKey,
        },
        input: { name },
        authorize: async () => {
          await workspaces.requireActor(actorUserId, identityWorkspaceId, "content.view");
        },
        beforeAccept: mutation.beforeAccept,
        mutate: async (tx: Prisma.TransactionClient) => {
          const workspace = await workspaces.createPendingBusinessWorkspace(actorUserId, { name }, tx);
          return {
            resourceType: "workspace",
            resourceId: workspace.id,
            value: { workspaceId: workspace.id, name: workspace.name },
          };
        },
      });
      if (accepted.replayed && !await workspaces.findActor(actorUserId, accepted.value.workspaceId)) {
        throw new WorkspaceOperationError("workspace_no_longer_exists", "This workspace no longer exists. Start a new workspace checkout.");
      }
      return { ...accepted.value, replayed: accepted.replayed };
    },

    inviteMember: (
      actor: ActorScope,
      input: { email: string; role: Exclude<WorkspaceRole, "owner"> },
      mutation: WorkspaceMutation,
    ) => acceptInvite(
      "invite_workspace_member",
      actor,
      { email: input.email.trim().toLocaleLowerCase("en-US"), role: input.role },
      mutation,
    ),

    resendInvite: (actor: ActorScope, inviteId: string, mutation: WorkspaceMutation) =>
      acceptInvite("resend_workspace_invite", actor, { inviteId }, mutation),
  };
}

export type WorkspaceCommands = ReturnType<typeof createWorkspaceCommands>;
