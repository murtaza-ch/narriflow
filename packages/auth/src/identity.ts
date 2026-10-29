import type { User as ClerkUser, UserJSON } from "@clerk/backend";
import type { Prisma, User, WebhookProvider } from "@prisma/client";
import {
  asRecord,
  extractIdentities,
  extractPrimaryEmail,
  extractPrimaryEmailVerifiedAt,
  getString,
  getValue,
  parseDate,
  type ClerkIdentityShape,
} from "./clerk-payload";
import { ClerkDirectoryUnavailableError, isClerkNotFound, isClerkUnavailable } from "./clerk";
import { getRequiredPrisma, isUniqueViolation } from "./database";
import {
  ensurePersonalWorkspace,
  isWorkspaceId,
  toWorkspaceActorContext,
  type WorkspaceActorContext,
} from "./workspace";

export type AppUser = User;

/** The only Clerk capability identity provisioning needs. */
export interface ClerkUserDirectory {
  users: { getUser(clerkUserId: string): Promise<ClerkUser> };
}

/** A Clerk user as delivered by webhook JSON or fetched through the Backend API. */
export type ClerkUserSource = Partial<UserJSON> | ClerkUser | Record<string, unknown>;

interface WebhookDeliveryRecordInput {
  provider: WebhookProvider;
  eventId: string;
  eventType: string;
  status: string;
  payload?: unknown;
}

function toJsonPayload(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return value as Prisma.InputJsonValue;
}

async function upsertIdentity(userId: string, identity: ClerkIdentityShape) {
  const prisma = getRequiredPrisma();

  return prisma.authIdentity.upsert({
    where: {
      provider_providerUserId: {
        provider: identity.provider,
        providerUserId: identity.providerUserId,
      },
    },
    create: {
      userId,
      provider: identity.provider,
      providerUserId: identity.providerUserId,
      email: identity.email,
      lastUsedAt: new Date(),
    },
    update: {
      userId,
      email: identity.email,
      lastUsedAt: new Date(),
    },
  });
}

export async function getWebhookDeliveryLog(provider: WebhookProvider, eventId: string) {
  const prisma = getRequiredPrisma();

  return prisma.webhookDeliveryLog.findUnique({
    where: {
      provider_eventId: {
        provider,
        eventId,
      },
    },
  });
}

export async function recordWebhookDeliveryLog(input: WebhookDeliveryRecordInput) {
  const prisma = getRequiredPrisma();

  return prisma.webhookDeliveryLog.upsert({
    where: {
      provider_eventId: {
        provider: input.provider,
        eventId: input.eventId,
      },
    },
    create: {
      provider: input.provider,
      eventId: input.eventId,
      eventType: input.eventType,
      status: input.status,
      payload: toJsonPayload(input.payload),
    },
    update: {
      eventType: input.eventType,
      status: input.status,
      payload: toJsonPayload(input.payload),
      processedAt: new Date(),
    },
  });
}

/**
 * Upserts the App User for a Clerk payload and keeps the first-use invariants
 * (brand template default, personal Workspace). `directory` confirms a Clerk
 * deletion when an email uniqueness conflict must be resolved.
 */
export async function syncClerkUserPayload(
  clerkUser: ClerkUserSource,
  directory: ClerkUserDirectory,
): Promise<AppUser> {
  const payload = asRecord(clerkUser);
  const clerkId = payload ? getString(payload, ["id"]) : null;

  if (!payload || !clerkId) {
    throw new Error("Missing Clerk user id in payload");
  }

  const prisma = getRequiredPrisma();
  const primaryEmail = extractPrimaryEmail(payload);
  const emailVerifiedAt = extractPrimaryEmailVerifiedAt(payload);
  const firstName = getString(payload, ["first_name", "firstName"]);
  const lastName = getString(payload, ["last_name", "lastName"]);
  const imageUrl = getString(payload, ["image_url", "imageUrl"]);
  const lastSignInAt = parseDate(getValue(payload, ["last_sign_in_at", "lastSignInAt"]));

  const userData = {
    primaryEmail,
    emailVerifiedAt,
    firstName,
    lastName,
    imageUrl,
    lastSignInAt,
    deletedAt: null,
  };

  let appUser: User;
  try {
    appUser = await prisma.user.upsert({
      where: { clerkId },
      create: { clerkId, ...userData },
      update: userData,
    });
  } catch (error) {
    // Two requests can try to provision the same first-login user at once.
    // Prisma may surface the losing upsert as P2002 on primaryEmail even
    // though the winning request has already created the same Clerk user.
    // Recover the exact Clerk row, or release an email only after its previous
    // identity's deletion is confirmed. Never transfer an existing workspace
    // to another Clerk identity based on an email match.
    if (!isUniqueViolation(error)) {
      throw error;
    }

    const concurrentUser = await prisma.user.findUnique({ where: { clerkId } });
    if (concurrentUser) {
      appUser = await prisma.user.update({
        where: { id: concurrentUser.id },
        data: userData,
      });
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "auth_user_sync_race_recovered",
          clerkId,
        }),
      );
    } else if (primaryEmail && (await releaseDeletedEmailOwner(primaryEmail, clerkId, directory))) {
      appUser = await prisma.user.upsert({
        where: { clerkId },
        create: { clerkId, ...userData },
        update: userData,
      });
    } else {
      throw error;
    }
  }

  const identities = extractIdentities(payload);
  await Promise.all(identities.map((identity) => upsertIdentity(appUser.id, identity)));

  await ensureFirstUseBrandTemplate(appUser.id);
  await ensurePersonalWorkspace(appUser.id);

  return appUser;
}

const FIRST_USE_BRAND_TEMPLATE_KEY = "karaoke";

async function ensureFirstUseBrandTemplate(userId: string): Promise<void> {
  const prisma = getRequiredPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { defaultBrandTemplateId: true },
  });
  if (!user) return;

  if (user.defaultBrandTemplateId) {
    const stillExists = await prisma.brandTemplate.findFirst({
      where: { id: user.defaultBrandTemplateId, deletedAt: null },
      select: { id: true },
    });
    if (stillExists) return;
  }

  const fallback = await prisma.brandTemplate.findFirst({
    where: { isBuiltIn: true, builtInKey: FIRST_USE_BRAND_TEMPLATE_KEY, deletedAt: null },
    select: { id: true },
  });
  if (!fallback) return;

  await prisma.user.update({
    where: { id: userId },
    data: { defaultBrandTemplateId: fallback.id },
  });
}

export async function markUserDeletedByClerkId(clerkId: string) {
  const prisma = getRequiredPrisma();

  const [, result] = await prisma.$transaction([
    prisma.authIdentity.deleteMany({ where: { user: { clerkId } } }),
    prisma.user.updateMany({
      where: { clerkId },
      data: { deletedAt: new Date(), primaryEmail: null, emailVerifiedAt: null },
    }),
  ]);
  return result;
}

/** Backend API lookup that reports an unreachable directory as `ClerkDirectoryUnavailableError`. */
async function fetchClerkUser(directory: ClerkUserDirectory, clerkUserId: string) {
  try {
    return await directory.users.getUser(clerkUserId);
  } catch (error) {
    if (!isClerkNotFound(error) && isClerkUnavailable(error)) {
      throw new ClerkDirectoryUnavailableError(error);
    }
    throw error;
  }
}

async function releaseDeletedEmailOwner(
  primaryEmail: string,
  clerkId: string,
  directory: ClerkUserDirectory,
) {
  const prisma = getRequiredPrisma();
  const previousUser = await prisma.user.findUnique({ where: { primaryEmail } });
  if (!previousUser || previousUser.clerkId === clerkId) return true;

  if (!previousUser.deletedAt) {
    // A deletion webhook may be delayed or absent. Fail closed on a live
    // account or an unavailable Clerk API; only a confirmed 404 releases the
    // email.
    try {
      await fetchClerkUser(directory, previousUser.clerkId);
      return false;
    } catch (error) {
      if (!isClerkNotFound(error)) throw error;
    }
  }
  await markUserDeletedByClerkId(previousUser.clerkId);
  return true;
}

function needsUserRefresh(user: AppUser): boolean {
  return !user.primaryEmail || !user.emailVerifiedAt || !user.lastSignInAt;
}

/** The App User row of a live Clerk identity. */
function readLiveUser(clerkUserId: string) {
  return getRequiredPrisma().user.findFirst({ where: { clerkId: clerkUserId, deletedAt: null } });
}

/** Whether the identity owns its personal Workspace membership; keyed by Clerk id so it needs no App User first. */
function readPersonalOwnership(clerkUserId: string) {
  return getRequiredPrisma().workspaceMember.findFirst({
    where: {
      role: "owner",
      user: { clerkId: clerkUserId, deletedAt: null },
      workspace: { personalOwner: { clerkId: clerkUserId } },
    },
    select: { id: true },
  });
}

/**
 * Resolves the App User for a verified Clerk user id, provisioning on first
 * login. Callers must pass an id from verified session claims, never from a
 * request header or body.
 *
 * A provisioned, refreshed user costs one round trip: the user row and the
 * personal-Workspace invariant are read together, and nothing is written.
 */
export async function getAppUserForClerkIdentity(
  clerkUserId: string,
  clerkClient: ClerkUserDirectory,
): Promise<AppUser> {
  const [existing, personalOwnership] = await Promise.all([
    readLiveUser(clerkUserId),
    readPersonalOwnership(clerkUserId),
  ]);

  if (existing) {
    if (!existing.defaultBrandTemplateId) {
      await ensureFirstUseBrandTemplate(existing.id);
    }
    if (!personalOwnership) {
      await ensurePersonalWorkspace(existing.id);
    }
    if (needsUserRefresh(existing)) {
      return syncClerkUserPayload(await fetchClerkUser(clerkClient, clerkUserId), clerkClient);
    }

    return existing;
  }

  return syncClerkUserPayload(await fetchClerkUser(clerkClient, clerkUserId), clerkClient);
}

export interface WorkspaceRequestActor {
  user: AppUser;
  context: WorkspaceActorContext;
}

/**
 * The hot path of a Workspace-scoped request in one round trip: the App User,
 * the live membership of the selected Workspace, that Workspace and the
 * personal-Workspace invariant are independent reads keyed by the verified
 * Clerk id, so they are issued together. Returns null whenever anything needs
 * provisioning, refreshing or refusing; the caller then takes the full path
 * (`getAppUserForClerkIdentity` and `resolveScopedWorkspaceContext`), which
 * makes the decision. Nothing is cached across requests.
 */
export async function readWorkspaceRequestActor(
  clerkUserId: string,
  requestedWorkspaceId: string | undefined,
): Promise<WorkspaceRequestActor | null> {
  if (!isWorkspaceId(requestedWorkspaceId)) return null;

  const prisma = getRequiredPrisma();
  const [user, membership, workspace, personalOwnership] = await Promise.all([
    readLiveUser(clerkUserId),
    prisma.workspaceMember.findFirst({
      where: {
        workspaceId: requestedWorkspaceId,
        user: { clerkId: clerkUserId, deletedAt: null },
      },
      select: { userId: true, role: true },
    }),
    prisma.workspace.findUnique({
      where: { id: requestedWorkspaceId },
      select: {
        id: true,
        name: true,
        ownerUserId: true,
        personalOwnerUserId: true,
        status: true,
        pricingTier: true,
      },
    }),
    readPersonalOwnership(clerkUserId),
  ]);

  if (
    !user ||
    !membership ||
    !workspace ||
    !personalOwnership ||
    membership.userId !== user.id ||
    !user.defaultBrandTemplateId ||
    needsUserRefresh(user)
  ) {
    return null;
  }
  return { user, context: toWorkspaceActorContext({ userId: user.id, role: membership.role, workspace }) };
}

export async function getAppUserByClerkId(clerkId: string): Promise<AppUser | null> {
  const prisma = getRequiredPrisma();
  return prisma.user.findFirst({ where: { clerkId, deletedAt: null } });
}
