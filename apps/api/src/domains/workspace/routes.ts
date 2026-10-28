import type { listUserWorkspaces } from "@narriflow/auth";
import type { sendEmail } from "@narriflow/email";
import type {
  WorkspaceCommands,
  autoCensorService,
  performanceService,
  projectService,
  workspaceMembershipService,
  workspaceService,
} from "@narriflow/services";
import { WorkspaceOperationError } from "@narriflow/services";
import { resolvePricingTier } from "@narriflow/validators";
import { workspaceCapabilities } from "@narriflow/validators/api/session";
import {
  changeMemberRoleRequestSchema,
  inviteMemberRequestSchema,
  performanceGuidanceRequestSchema,
  presignAvatarRequestSchema,
  replaceCensorWordsRequestSchema,
  setAvatarRequestSchema,
  updateWorkspaceRequestSchema,
  type InviteIssued,
  type WorkspaceBootstrap,
  type WorkspaceMembers,
  type WorkspaceProfile,
  type WorkspaceUsage,
} from "@narriflow/validators/api/workspace";
import type { Context } from "hono";
import { createRouteApp, getActor, getRecordedRateLimit } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import { getIdempotencyKey, requireIdempotencyKey } from "../../http/idempotency";
import { enforceRecordedRateLimit } from "../../http/limits";
import { validate } from "../../http/route";
import { uuidParams } from "../platform/params";
import { readMemberships, toSessionUser } from "../session/projection";
import { workspaceAdmission as access } from "./admission";
import { deliverWorkspaceInvite } from "./invite-delivery";

/** Services the workspace routes call. `runtime.ts` supplies the production instances. */
export interface WorkspaceRouteDeps {
  workspaceService: typeof workspaceService;
  workspaceMembershipService: Pick<typeof workspaceMembershipService, "changeRole" | "removeMember">;
  workspaceCommands: Pick<WorkspaceCommands, "inviteMember" | "resendInvite">;
  projectService: Pick<typeof projectService, "getUsageSummary">;
  performanceService: Pick<typeof performanceService, "setGuidanceEnabled">;
  autoCensorService: Pick<
    typeof autoCensorService,
    "getWorkspaceWords" | "replaceWorkspaceWords" | "resetWorkspaceWords"
  >;
  listUserWorkspaces: typeof listUserWorkspaces;
  sendEmail: typeof sendEmail;
  /** W: invitation links are for people, so they use the web origin. */
  webOrigin: string;
}

/** The column is free text; only the two known intervals are exposed. */
function billingIntervalOf(value: string | null | undefined): "monthly" | "annual" | null {
  return value === "monthly" || value === "annual" ? value : null;
}

function toUsage(summary: Awaited<ReturnType<WorkspaceRouteDeps["projectService"]["getUsageSummary"]>>): WorkspaceUsage {
  return {
    tier: resolvePricingTier(summary.tier),
    usedCredits: summary.usedCredits,
    reservedCredits: summary.reservedCredits,
    limitCredits: summary.limitCredits,
    remainingCredits: summary.remainingCredits,
    periodStart: summary.periodStart.toISOString(),
    renewsAt: summary.renewsAt.toISOString(),
    inFlight: summary.inFlight,
    inFlightLimit: summary.inFlightLimit,
    maxUploadSeconds: summary.maxUploadSeconds,
  };
}

/** Workspace profile and settings, members and invites, censor words and avatar. */
export function createWorkspaceRoutes(deps: WorkspaceRouteDeps) {
  const {
    workspaceService,
    workspaceMembershipService,
    workspaceCommands,
    projectService,
    performanceService,
    autoCensorService,
  } = deps;

  /** An invite response: the link and delivery result exist only for the request that issued it. */
  async function inviteIssued(
    c: Context<ApiEnv>,
    accepted: Awaited<ReturnType<WorkspaceCommands["inviteMember"]>>,
  ) {
    let inviteUrl: string | null = null;
    let emailSent: boolean | null = null;
    if (accepted.token) {
      const delivery = await deliverWorkspaceInvite(deps, {
        ...accepted.invite,
        token: accepted.token,
        workspaceName: getActor(c).workspaceName,
      });
      inviteUrl = delivery.url;
      emailSent = delivery.emailSent;
    }
    if (accepted.replayed) c.header("Idempotent-Replayed", "true");
    const body: InviteIssued = { invite: accepted.invite, inviteUrl, emailSent, replayed: accepted.replayed };
    return c.json(body, accepted.replayed ? 200 : 201);
  }

  const mutationFor = (c: Context<ApiEnv>) => ({
    clientIdempotencyKey: getIdempotencyKey(c),
    beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)),
  });

  return createRouteApp(access)
    .get("/workspace/bootstrap", async (c) => {
      const actor = getActor(c);
      const [memberships, usage] = await Promise.all([
        readMemberships(deps, actor.actorUserId),
        projectService.getUsageSummary(actor),
      ]);
      const body: WorkspaceBootstrap = {
        user: toSessionUser(actor),
        workspace: memberships.find((entry) => entry.id === actor.workspaceId) ?? {
          id: actor.workspaceId,
          name: actor.workspaceName,
          role: actor.role,
          status: actor.status,
          pricingTier: resolvePricingTier(actor.pricingTier),
          isPersonal: actor.isPersonalWorkspace,
          avatarUrl: null,
        },
        memberships,
        capabilities: workspaceCapabilities(actor),
        usage: toUsage(usage),
      };
      return c.json(body, 200);
    })

    .get("/workspace", async (c) => {
      const actor = getActor(c);
      const [workspace, avatarUrls] = await Promise.all([
        workspaceService.getWorkspace(actor.actorUserId, actor.workspaceId),
        workspaceService.getAvatarUrls(actor.actorUserId, [actor.workspaceId]),
      ]);
      if (!workspace) {
        throw new WorkspaceOperationError("workspace_access_denied", "You do not have access to this Workspace");
      }
      const body: WorkspaceProfile = {
        id: workspace.id,
        name: workspace.name,
        role: actor.role,
        status: workspace.status,
        pricingTier: resolvePricingTier(workspace.pricingTier),
        isPersonal: workspace.personalOwnerUserId !== null,
        avatarUrl: avatarUrls[workspace.id] ?? null,
        timezone: workspace.timezone,
        createdAt: workspace.createdAt.toISOString(),
        billingInterval: billingIntervalOf(workspace.billingAccount?.billingInterval),
        currentPeriodEndAt: workspace.billingAccount?.currentPeriodEndAt?.toISOString() ?? null,
      };
      return c.json(body, 200);
    })

    .patch("/workspace", validate("json", updateWorkspaceRequestSchema), async (c) => {
      const actor = getActor(c);
      const updated = await workspaceService.updateWorkspace(
        actor.actorUserId,
        actor.workspaceId,
        c.req.valid("json"),
      );
      return c.json(updated, 200);
    })

    .get("/workspace/usage", async (c) => {
      const summary = await projectService.getUsageSummary(getActor(c));
      return c.json(toUsage(summary), 200);
    })

    .get("/workspace/members", async (c) => {
      const actor = getActor(c);
      const { members, invites } = await workspaceService.listMembers(actor.actorUserId, actor.workspaceId);
      const body: WorkspaceMembers = {
        members: members.map((member) => ({ ...member, joinedAt: member.joinedAt.toISOString() })),
        invites: invites.map((invite) => ({
          ...invite,
          expiresAt: invite.expiresAt.toISOString(),
          createdAt: invite.createdAt.toISOString(),
        })),
      };
      return c.json(body, 200);
    })

    .post(
      "/workspace/invites",
      requireIdempotencyKey(),
      validate("json", inviteMemberRequestSchema),
      async (c) => {
        const accepted = await workspaceCommands.inviteMember(getActor(c), c.req.valid("json"), mutationFor(c));
        return inviteIssued(c, accepted);
      },
    )

    .post(
      "/workspace/invites/:inviteId/resend",
      requireIdempotencyKey(),
      uuidParams("inviteId"),
      async (c) => {
        const { inviteId } = c.req.valid("param");
        const accepted = await workspaceCommands.resendInvite(getActor(c), inviteId, mutationFor(c));
        return inviteIssued(c, accepted);
      },
    )

    .delete("/workspace/invites/:inviteId", uuidParams("inviteId"), async (c) => {
      const actor = getActor(c);
      await workspaceService.revokeInvite(actor.actorUserId, actor.workspaceId, c.req.valid("param").inviteId);
      return c.json({ ok: true as const }, 200);
    })

    .patch(
      "/workspace/members/:memberId",
      uuidParams("memberId"),
      validate("json", changeMemberRoleRequestSchema),
      async (c) => {
        const actor = getActor(c);
        const member = await workspaceMembershipService.changeRole(
          actor.actorUserId,
          actor.workspaceId,
          c.req.valid("param").memberId,
          c.req.valid("json").role,
        );
        return c.json({ id: member.id, role: member.role }, 200);
      },
    )

    .delete("/workspace/members/:memberId", uuidParams("memberId"), async (c) => {
      const actor = getActor(c);
      await workspaceMembershipService.removeMember(
        actor.actorUserId,
        actor.workspaceId,
        c.req.valid("param").memberId,
      );
      return c.json({ ok: true as const }, 200);
    })

    .patch(
      "/workspace/performance-guidance",
      validate("json", performanceGuidanceRequestSchema),
      async (c) => {
        const { enabled } = c.req.valid("json");
        await performanceService.setGuidanceEnabled(getActor(c), enabled);
        return c.json({ enabled }, 200);
      },
    )

    .get("/workspace/censor-words", async (c) => {
      return c.json(await autoCensorService.getWorkspaceWords(getActor(c)), 200);
    })

    .put("/workspace/censor-words", validate("json", replaceCensorWordsRequestSchema), async (c) => {
      const saved = await autoCensorService.replaceWorkspaceWords(getActor(c), c.req.valid("json").words);
      return c.json(saved, 200);
    })

    // Back to the built-in defaults.
    .delete("/workspace/censor-words", async (c) => {
      return c.json(await autoCensorService.resetWorkspaceWords(getActor(c)), 200);
    })

    .post("/workspace/avatar/presign", validate("json", presignAvatarRequestSchema), async (c) => {
      const actor = getActor(c);
      const result = await workspaceService.presignAvatarUpload(
        actor.actorUserId,
        actor.workspaceId,
        c.req.valid("json"),
      );
      return c.json(result, 200);
    })

    .patch("/workspace/avatar", validate("json", setAvatarRequestSchema), async (c) => {
      const actor = getActor(c);
      await workspaceService.setAvatar(actor.actorUserId, actor.workspaceId, c.req.valid("json").storageKey || null);
      return c.json({ ok: true as const }, 200);
    });
}

export type WorkspaceRoutes = ReturnType<typeof createWorkspaceRoutes>;
