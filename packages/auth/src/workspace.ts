import type { PricingTier, User, WorkspaceRole, WorkspaceStatus } from "@prisma/client";
import { getRequiredPrisma, isUniqueViolation } from "./database";

export interface WorkspaceActorContext {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceOwnerUserId: string;
  role: WorkspaceRole;
  status: WorkspaceStatus;
  pricingTier: PricingTier;
  isPersonal: boolean;
  workspaceSelectionChanged: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Workspace ids are Postgres UUIDs; anything else cannot name a membership. */
export function isWorkspaceId(value: string | undefined): value is string {
  return value !== undefined && UUID_PATTERN.test(value);
}

function personalWorkspaceName(user: Pick<User, "firstName" | "lastName">): string {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return fullName ? `${fullName}'s workspace` : "My workspace";
}

/**
 * Guarantees the invariant used by workspace resolution: every application
 * user has one and only one personal workspace plus an Owner membership.
 * The unique personalOwnerUserId makes concurrent sign-in/webhook creation
 * collapse safely at the database boundary.
 */
export async function ensurePersonalWorkspace(userId: string) {
  const prisma = getRequiredPrisma();
  const existingOwner = await prisma.workspaceMember.findFirst({
    where: {
      userId,
      role: "owner",
      workspace: { personalOwnerUserId: userId },
    },
    select: { workspace: true },
  });
  if (existingOwner) return existingOwner.workspace;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");

  let workspace;
  try {
    workspace = await prisma.workspace.upsert({
      where: { personalOwnerUserId: user.id },
      create: {
        name: personalWorkspaceName(user),
        ownerUserId: user.id,
        personalOwnerUserId: user.id,
        defaultBrandTemplateId: user.defaultBrandTemplateId,
        billingAccount: { create: {} },
        members: {
          create: { userId: user.id, role: "owner" },
        },
      },
      update: {},
    });
  } catch (error) {
    // Prisma can implement an upsert as a read followed by a create. Concurrent
    // first-login requests may both observe no personal workspace, leaving the
    // losing request with P2002 even though the invariant is now satisfied.
    // Recover only when the exact owner row exists; unrelated uniqueness
    // failures still propagate.
    if (!isUniqueViolation(error)) {
      throw error;
    }

    const concurrentWorkspace = await prisma.workspace.findUnique({
      where: { personalOwnerUserId: user.id },
    });
    if (!concurrentWorkspace) throw error;

    workspace = concurrentWorkspace;
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "auth_personal_workspace_race_recovered",
        userId: user.id,
        workspaceId: workspace.id,
      }),
    );
  }

  await prisma.workspaceMember.upsert({
    where: {
      workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
    },
    create: { workspaceId: workspace.id, userId: user.id, role: "owner" },
    update: { role: "owner" },
  });

  return workspace;
}

const workspaceSelect = {
  id: true,
  name: true,
  ownerUserId: true,
  personalOwnerUserId: true,
  status: true,
  pricingTier: true,
} as const;

export function toWorkspaceActorContext(
  input: {
    userId: string;
    role: WorkspaceRole;
    workspace: {
      id: string;
      name: string;
      ownerUserId: string;
      personalOwnerUserId: string | null;
      status: WorkspaceStatus;
      pricingTier: PricingTier;
    };
  },
  workspaceSelectionChanged = false,
): WorkspaceActorContext {
  return {
    userId: input.userId,
    workspaceId: input.workspace.id,
    workspaceName: input.workspace.name,
    workspaceOwnerUserId: input.workspace.ownerUserId,
    role: input.role,
    status: input.workspace.status,
    pricingTier: input.workspace.pricingTier,
    isPersonal: input.workspace.personalOwnerUserId !== null,
    workspaceSelectionChanged,
  };
}

/**
 * Live membership read: the only thing that makes a selection hint valid.
 * The membership and the Workspace are two single-table reads issued together,
 * one round trip where a relation include would be two sequential ones.
 */
async function readSelectedMembership(userId: string, workspaceId: string | undefined) {
  if (!isWorkspaceId(workspaceId)) return null;

  const prisma = getRequiredPrisma();
  const [membership, workspace] = await Promise.all([
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: workspaceSelect }),
  ]);
  return membership && workspace ? { userId, role: membership.role, workspace } : null;
}

/** The user's Owner membership of their own personal Workspace, read in one round trip. */
async function readPersonalMembership(userId: string) {
  const prisma = getRequiredPrisma();
  const [membership, workspace] = await Promise.all([
    prisma.workspaceMember.findFirst({
      where: { userId, role: "owner", workspace: { personalOwnerUserId: userId } },
      select: { role: true },
    }),
    prisma.workspace.findUnique({ where: { personalOwnerUserId: userId }, select: workspaceSelect }),
  ]);
  return membership && workspace ? { userId, role: membership.role, workspace } : null;
}

/**
 * Bootstrap resolution. A missing or removed selection hint falls back to the
 * personal Workspace and reports `workspaceSelectionChanged`. Never use this
 * for a scoped request: it would redirect an in-flight command to another
 * Workspace.
 */
export async function resolveWorkspaceContext(
  user: Pick<User, "id">,
  requestedWorkspaceId?: string,
): Promise<WorkspaceActorContext | null> {
  const requestedMembership = await readSelectedMembership(user.id, requestedWorkspaceId);
  if (requestedMembership) {
    return toWorkspaceActorContext(requestedMembership);
  }

  let fallbackMembership = await readPersonalMembership(user.id);
  if (!fallbackMembership) {
    await ensurePersonalWorkspace(user.id);
    fallbackMembership = await readPersonalMembership(user.id);
  }

  return fallbackMembership
    ? toWorkspaceActorContext(
        fallbackMembership,
        Boolean(requestedWorkspaceId && requestedWorkspaceId !== fallbackMembership.workspace.id),
      )
    : null;
}

/**
 * Scoped-request resolution. Requires an explicit selection that is a current
 * membership; `null` means the caller must answer 409 `workspace_selection_changed`
 * before invoking any operation.
 */
export async function resolveScopedWorkspaceContext(
  user: Pick<User, "id">,
  requestedWorkspaceId: string | undefined,
): Promise<WorkspaceActorContext | null> {
  const membership = await readSelectedMembership(user.id, requestedWorkspaceId);
  return membership ? toWorkspaceActorContext(membership) : null;
}

/**
 * Workspace switch: validates the actor's current membership and returns the
 * selected Workspace. `null` means the actor is not a member. Persistence of
 * the hint is the browser's concern; nothing here is trusted later.
 */
export async function selectWorkspaceForActor(
  actorUserId: string,
  workspaceId: string,
): Promise<WorkspaceActorContext | null> {
  return resolveScopedWorkspaceContext({ id: actorUserId }, workspaceId);
}

export async function listUserWorkspaces(userId: string) {
  const prisma = getRequiredPrisma();

  return prisma.workspaceMember.findMany({
    where: {
      userId,
    },
    orderBy: [{ workspace: { personalOwnerUserId: "desc" } }, { joinedAt: "asc" }],
    select: {
      role: true,
      workspace: {
        select: {
          id: true,
          name: true,
          avatarStorageKey: true,
          personalOwnerUserId: true,
          status: true,
          pricingTier: true,
        },
      },
    },
  });
}
