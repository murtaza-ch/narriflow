import "server-only";

import { auth, currentUser, type UserJSON } from "@clerk/nextjs/server";
import { getPrismaClient } from "@narriflow/db/client";
import { cookies } from "next/headers";
import { Prisma } from "@prisma/client";
import type {
  AuthIdentity,
  AuthProvider,
  PricingTier,
  User,
  WebhookProvider,
  WorkspaceRole,
  WorkspaceStatus,
} from "@prisma/client";

export type AppUser = User;

export const ACTIVE_WORKSPACE_COOKIE = "narriflow_active_workspace";

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

export type { WorkspaceCapability } from "@narriflow/validators";

interface WebhookDeliveryRecordInput {
  provider: WebhookProvider;
  eventId: string;
  eventType: string;
  status: string;
  payload?: unknown;
}

function getRequiredPrisma() {
  const prisma = getPrismaClient();

  if (!prisma) {
    throw new Error("DATABASE_URL must be configured for authentication features",
    );
  }

  return prisma;
}

function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value) : null;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed;
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }

  return undefined;
}

function getString(record: Record<string, unknown>, keys: string[],
): string | null {
  const value = getValue(record, keys);
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getRecord(record: Record<string, unknown>, keys: string[],
): Record<string, unknown> | null {
  const value = getValue(record, keys);
  return asRecord(value);
}

function getArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  const value = getValue(record, keys);
  return Array.isArray(value) ? value : [];
}

function getEmailFromEntry(entry: Record<string, unknown>): string | null {
  return getString(entry, ["email_address", "emailAddress"]);
}

function getPrimaryEmailEntry(user: Record<string, unknown>,
): Record<string, unknown> | null {
  const primaryFromObject = getRecord(user, ["primaryEmailAddress", "primary_email_address",
  ]);
  if (primaryFromObject) {
    return primaryFromObject;
  }

  const emailEntries = getArray(user, ["email_addresses", "emailAddresses"])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  const primaryEmailAddressId = getString(user, ["primary_email_address_id", "primaryEmailAddressId",
  ]);

  if (primaryEmailAddressId) {
    const preferred = emailEntries.find((entry) => getString(entry, ["id"]) === primaryEmailAddressId,
    );
    if (preferred) {
      return preferred;
    }
  }

  return emailEntries[0] ?? null;
}

function extractPrimaryEmail(user: Record<string, unknown>): string | null {
  const primaryEntry = getPrimaryEmailEntry(user);
  if (!primaryEntry) {
    return null;
  }

  return getEmailFromEntry(primaryEntry);
}

function extractPrimaryEmailVerifiedAt(user: Record<string, unknown>,
): Date | null {
  const primaryEntry = getPrimaryEmailEntry(user);

  if (!primaryEntry) {
    return null;
  }

  const verification = getRecord(primaryEntry, ["verification"]);
  const verificationStatus = verification ? getString(verification, ["status"]) : null;

  if (verificationStatus !== "verified") {
    return null;
  }

  const emailUpdatedAt = parseDate(getValue(primaryEntry, ["updated_at", "updatedAt"]),
  );
  if (emailUpdatedAt) {
    return emailUpdatedAt;
  }

  const verificationUpdatedAt = verification
    ? parseDate(getValue(verification, ["updated_at", "updatedAt"]))
    : null;
  if (verificationUpdatedAt) {
    return verificationUpdatedAt;
  }

  const userUpdatedAt = parseDate(getValue(user, ["updated_at", "updatedAt"]));
  if (userUpdatedAt) {
    return userUpdatedAt;
  }

  return new Date();
}

function toJsonPayload(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  return value as Prisma.InputJsonValue;
}

function mapProvider(value: string | null | undefined): AuthProvider | null {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();

  if (normalized.includes("google")) {
    return "google";
  }

  if (normalized.includes("facebook")) {
    return "facebook";
  }

  if (normalized.includes("microsoft")) {
    return "microsoft";
  }

  return null;
}

interface ClerkIdentityShape {
  provider: AuthProvider;
  providerUserId: string;
  email: string | null;
}

function extractIdentities(user: Record<string, unknown>,
): ClerkIdentityShape[] {
  const identities: ClerkIdentityShape[] = [];
  const primaryEmail = extractPrimaryEmail(user);
  const clerkUserId = getString(user, ["id"]);

  if (clerkUserId) {
    identities.push({
      provider: "email_password",
      providerUserId: clerkUserId,
      email: primaryEmail,
    });
  }

  const externalAccounts = getArray(user, ["external_accounts", "externalAccounts",
  ])
    .map((account) => asRecord(account))
    .filter((account): account is Record<string, unknown> => account !== null);

  for (const account of externalAccounts) {
    const provider = mapProvider(getString(account, ["provider"]));
    const providerUserId = getString(account, ["provider_user_id", "providerUserId",
    ]);

    if (!provider || !providerUserId) {
      continue;
    }

    identities.push({
      provider,
      providerUserId,
      email: getString(account, ["email_address", "emailAddress"]) ?? primaryEmail,
    });
  }

  return identities;
}

async function upsertIdentity(userId: string, identity: ClerkIdentityShape,
): Promise<AuthIdentity> {
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

export async function getWebhookDeliveryLog(provider: WebhookProvider, eventId: string,
) {
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

export async function recordWebhookDeliveryLog(input: WebhookDeliveryRecordInput,
) {
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

export async function syncClerkUserPayload(clerkUser: Partial<UserJSON> | Record<string, unknown>,
) {
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
  const lastSignInAt = parseDate(getValue(payload, ["last_sign_in_at", "lastSignInAt"]),
  );

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
    // Two server components can try to provision the same first-login user at
    // once. Prisma may surface the losing upsert as P2002 on primaryEmail even
    // though the winning request has already created the same Clerk user.
    // Recover only when that exact Clerk row now exists; a genuine email
    // collision with a different identity must still fail closed.
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "P2002"
    ) {
      throw error;
    }

    const concurrentUser = await prisma.user.findUnique({ where: { clerkId } });
    if (!concurrentUser) throw error;

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
  }

  const identities = extractIdentities(payload);
  await Promise.all(identities.map((identity) => upsertIdentity(appUser.id, identity)),
  );

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
    where: { isBuiltIn: true, builtInKey: FIRST_USE_BRAND_TEMPLATE_KEY, deletedAt: null,
    },
    select: { id: true },
  });
  if (!fallback) return;

  await prisma.user.update({
    where: { id: userId },
    data: { defaultBrandTemplateId: fallback.id },
  });
}

function personalWorkspaceName(user: Pick<User, "firstName" | "lastName">,
): string {
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return fullName ? `${fullName}'s workspace` : "Personal workspace";
}

export function workspacesV1EnabledForUser(userId: string) {
  const globallyEnabled = ["1", "true", "on"].includes(
    process.env.WORKSPACES_V1?.trim().toLowerCase() ?? "",
  );
  if (globallyEnabled) return true;
  return new Set(
    (process.env.WORKSPACES_V1_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ).has(userId);
}

/**
 * Guarantees the invariant used by workspace resolution: every application
 * user has one and only one personal workspace plus an Owner membership.
 * The unique personalOwnerUserId makes concurrent sign-in/webhook creation
 * collapse safely at the database boundary.
 */
export async function ensurePersonalWorkspace(userId: string) {
  const prisma = getRequiredPrisma();
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
    // first-login renders may both observe no personal workspace, leaving the
    // losing request with P2002 even though the invariant is now satisfied.
    // Recover only when the exact owner row exists; unrelated uniqueness
    // failures still propagate.
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "P2002"
    ) {
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

function toWorkspaceActorContext(input: {
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

/** Resolve the active workspace for an already-authenticated application user. */
export async function getWorkspaceContextForUser(
  user: AppUser,
): Promise<WorkspaceActorContext | null> {
  const prisma = getRequiredPrisma();
  const cookieStore = await cookies();
  const requestedWorkspaceId = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;

  const includeWorkspace = {
    workspace: {
      select: {
        id: true,
        name: true,
        ownerUserId: true,
        personalOwnerUserId: true,
        status: true,
        pricingTier: true,
      },
    },
  } as const;

  const requestedMembership = requestedWorkspaceId
    ? await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId: requestedWorkspaceId, userId: user.id,
          },
        },
        include: includeWorkspace,
      })
    : null;

  if (
    requestedMembership) {
    return toWorkspaceActorContext(requestedMembership);
  }

  const personalWorkspace = await ensurePersonalWorkspace(user.id);
  const fallbackMembership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId: personalWorkspace.id, userId: user.id,
      },
    },
    include: includeWorkspace,
  });

  return fallbackMembership ? toWorkspaceActorContext(fallbackMembership,
        Boolean(
          requestedWorkspaceId && requestedWorkspaceId !== personalWorkspace.id,
        ),
      ) : null;
}

export async function listUserWorkspaces(userId: string) {
  const prisma = getRequiredPrisma();

  return prisma.workspaceMember.findMany({
    where: {
      userId,
    },
    orderBy: [{ workspace: { personalOwnerUserId: "desc" } }, { joinedAt: "asc" },
    ],
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

export async function listCurrentUserWorkspaces() {
  const user = await requireCurrentAppUser();
  await ensurePersonalWorkspace(user.id);
  return listUserWorkspaces(user.id);
}

/** Validate explicit actor membership before persisting the clean-URL workspace selection. */
export async function setActiveWorkspaceForActor(
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  const prisma = getRequiredPrisma();
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actorUserId } },
    select: { id: true, workspace: { select: { personalOwnerUserId: true } } },
  });
  if (!membership) throw new Error("Forbidden");
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function markUserDeletedByClerkId(clerkId: string) {
  const prisma = getRequiredPrisma();

  return prisma.user.updateMany({
    where: { clerkId },
    data: { deletedAt: new Date() },
  });
}

export async function completeUserOnboarding(userId: string) {
  const prisma = getRequiredPrisma();

  return prisma.user.update({
    where: { id: userId },
    data: { onboardingCompletedAt: new Date() },
  });
}

function needsUserRefresh(user: AppUser): boolean {
  return (
    !user.primaryEmail ||
    !user.emailVerifiedAt ||
    !user.firstName ||
    !user.lastName ||
    !user.imageUrl ||
    !user.lastSignInAt
  );
}

export async function getCurrentAppUser(): Promise<AppUser | null> {
  const session = await auth();

  if (!session.userId) {
    return null;
  }

  const prisma = getRequiredPrisma();
  const existing = await prisma.user.findFirst({
    where: { clerkId: session.userId, deletedAt: null },
  });

  if (existing) {
    if (!existing.defaultBrandTemplateId) {
      await ensureFirstUseBrandTemplate(existing.id);
    }
    await ensurePersonalWorkspace(existing.id);
    if (needsUserRefresh(existing)) {
      const clerkUser = await currentUser();
      if (clerkUser) {
        return syncClerkUserPayload(clerkUser);
      }
    }

    return existing;
  }

  const clerkUser = await currentUser();

  if (!clerkUser) {
    return null;
  }

  return syncClerkUserPayload(clerkUser);
}

export async function requireCurrentAppUser(): Promise<AppUser> {
  const user = await getCurrentAppUser();

  if (!user) {
    throw new Error("Unauthorized");
  }

  return user;
}

export async function getAppUserByClerkId(clerkId: string,
): Promise<AppUser | null> {
  const prisma = getRequiredPrisma();
  return prisma.user.findFirst({ where: { clerkId, deletedAt: null } });
}
