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

type Tx = Prisma.TransactionClient;
type UserProfileData = Pick<
  User,
  "primaryEmail" | "emailVerifiedAt" | "firstName" | "lastName" | "imageUrl" | "lastSignInAt"
>;

/** Clerk refused to describe an identity it has deleted; no App User may be created or revived for it. */
export class ClerkIdentityDeletedError extends Error {
  constructor(readonly clerkId: string) {
    super("This Clerk identity was deleted");
    this.name = "ClerkIdentityDeletedError";
  }
}

/**
 * Serializes every write that creates, updates or deletes the App User of one
 * Clerk identity, so a deletion and a concurrent create/update cannot interleave.
 */
async function lockClerkIdentity(tx: Tx, clerkId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`clerk-identity:${clerkId}`}, 0))`;
}

function upsertIdentity(tx: Tx, userId: string, identity: ClerkIdentityShape) {
  return tx.authIdentity.upsert({
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

/** A delivery whose claim is older than this is presumed abandoned by a crashed handler. */
const WEBHOOK_DELIVERY_LEASE_MS = 2 * 60_000;

export type WebhookDeliveryClaim = "claimed" | "replay" | "in_progress";

/**
 * Atomically takes the right to process one provider delivery. Exactly one of
 * several overlapping deliveries of the same event is `claimed`; a recorded
 * `success` is a `replay`; a live claim held by another handler is
 * `in_progress`. A `failed` delivery, or a claim whose lease ran out, is taken
 * over; the side effects it may have already performed must be idempotent.
 */
export async function claimWebhookDelivery(input: {
  provider: WebhookProvider;
  eventId: string;
  eventType: string;
}): Promise<WebhookDeliveryClaim> {
  const prisma = getRequiredPrisma();
  try {
    await prisma.webhookDeliveryLog.create({ data: { ...input, status: "processing" } });
    return "claimed";
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  const taken = await prisma.webhookDeliveryLog.updateMany({
    where: {
      provider: input.provider,
      eventId: input.eventId,
      OR: [
        { status: "failed" },
        { status: "processing", processedAt: { lt: new Date(Date.now() - WEBHOOK_DELIVERY_LEASE_MS) } },
      ],
    },
    data: { status: "processing", eventType: input.eventType, processedAt: new Date() },
  });
  if (taken.count === 1) return "claimed";

  const row = await prisma.webhookDeliveryLog.findUnique({
    where: { provider_eventId: { provider: input.provider, eventId: input.eventId } },
    select: { status: true },
  });
  return row?.status === "success" ? "replay" : "in_progress";
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
 * Creates or updates the live App User and its identities under the identity
 * lock. A deleted Clerk identity is terminal: a tombstone (or a soft-deleted
 * row) refuses every create and update, whatever order the events arrive in.
 */
function writeLiveUser(
  clerkId: string,
  userData: UserProfileData,
  identities: ClerkIdentityShape[],
): Promise<User> {
  return getRequiredPrisma().$transaction(async (tx) => {
    await lockClerkIdentity(tx, clerkId);
    const tombstone = await tx.clerkDeletedIdentity.findUnique({
      where: { clerkId },
      select: { clerkId: true },
    });
    if (tombstone) throw new ClerkIdentityDeletedError(clerkId);

    const appUser = await tx.user.upsert({
      where: { clerkId },
      create: { clerkId, ...userData },
      update: userData,
    });
    if (appUser.deletedAt) throw new ClerkIdentityDeletedError(clerkId);

    for (const identity of identities) await upsertIdentity(tx, appUser.id, identity);
    return appUser;
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
  };

  const identities = extractIdentities(payload);

  let appUser: User;
  try {
    appUser = await writeLiveUser(clerkId, userData, identities);
  } catch (error) {
    // The only unique conflict left after the per-identity lock is the email.
    // Release it only after its previous identity's deletion is confirmed;
    // never transfer an existing workspace to another Clerk identity based on
    // an email match.
    if (
      !isUniqueViolation(error) ||
      !primaryEmail ||
      !(await releaseDeletedEmailOwner(primaryEmail, clerkId, directory))
    ) {
      throw error;
    }
    appUser = await writeLiveUser(clerkId, userData, identities);
  }

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

/**
 * Records Clerk's deletion of an identity and closes everything it could still
 * reach: the tombstone (terminal, see `ClerkDeletedIdentity`), identities, API
 * keys and standing grants the user made. MCP task handles are immutable and
 * only readable through admission, which now refuses their owner. Runs under the
 * identity lock, so a concurrent create/update either finishes first (and is
 * then deleted here) or sees the tombstone and writes nothing.
 */
export async function markUserDeletedByClerkId(clerkId: string) {
  return getRequiredPrisma().$transaction(async (tx) => {
    await lockClerkIdentity(tx, clerkId);
    await tx.clerkDeletedIdentity.upsert({ where: { clerkId }, create: { clerkId }, update: {} });

    const user = await tx.user.findUnique({ where: { clerkId }, select: { id: true, deletedAt: true } });
    if (!user) return { count: 0 };

    const now = new Date();
    await tx.authIdentity.deleteMany({ where: { userId: user.id } });
    await tx.apiKey.updateMany({
      where: { revokedAt: null, OR: [{ userId: user.id }, { createdByUserId: user.id }] },
      data: { revokedAt: now },
    });
    const grants = await tx.standingGrant.findMany({
      where: { grantedByUserId: user.id, status: { in: ["active", "paused", "expired"] } },
      select: { id: true, revision: true },
    });
    if (grants.length > 0) {
      await tx.standingGrant.updateMany({
        where: { id: { in: grants.map((grant) => grant.id) } },
        data: { status: "revoked", pauseNoticePending: false, pauseNoticeLeaseUntil: null },
      });
      await tx.standingGrantEvent.createMany({
        data: grants.map((grant) => ({
          grantId: grant.id,
          kind: "revoked",
          revision: grant.revision,
          actorUserId: null,
          reason: "granter_deleted",
        })),
      });
    }
    return tx.user.updateMany({
      where: { clerkId },
      data: { deletedAt: user.deletedAt ?? now, primaryEmail: null, emailVerifiedAt: null },
    });
  });
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
