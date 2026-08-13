import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PricingTier, WorkspaceRole, WorkspaceStatus } from "@prisma/client";

import { getPrismaClient } from "@narriflow/db/client";
import { hasFeature } from "./plan-features";
import {
  isR2Configured,
  presignDownloadUrl,
  presignSingleUploadUrl,
} from "./r2-storage";

export type WorkspaceCapability =
  | "content.view"
  | "content.download"
  | "content.edit"
  | "processing.consume"
  | "publishing.manage"
  | "brand.manage"
  | "social.manage"
  | "workspace.manage"
  | "api.manage"
  | "members.invite"
  | "members.promote_admin"
  | "billing.manage";

export interface WorkspaceActorContext {
  userId: string;
  workspaceId: string;
  workspaceOwnerUserId: string;
  role: WorkspaceRole;
  status: WorkspaceStatus;
  pricingTier: PricingTier;
}

export interface WorkspaceApiKeyPrincipal {
  apiKeyId: string;
  userId: string;
  workspaceId: string;
  name: string;
  scopes: string[];
}

export const WORKSPACE_API_KEY_SCOPES = [
  "projects:read",
  "exports:read",
  "usage:read",
  "autopilot:read",
  "autopilot:write",
] as const;

export type WorkspaceApiKeyScope = (typeof WORKSPACE_API_KEY_SCOPES)[number];

const ROLE_CAPABILITIES: Record<WorkspaceRole, ReadonlySet<WorkspaceCapability>> = {
  owner: new Set([
    "content.view", "content.download", "content.edit", "processing.consume",
    "publishing.manage", "brand.manage", "social.manage", "workspace.manage", "api.manage", "members.invite",
    "members.promote_admin", "billing.manage",
  ]),
  admin: new Set([
    "content.view", "content.download", "content.edit", "processing.consume",
    "publishing.manage", "brand.manage", "social.manage", "workspace.manage", "api.manage", "members.invite",
  ]),
  editor: new Set([
    "content.view", "content.download", "content.edit", "processing.consume",
    "publishing.manage", "brand.manage", "api.manage",
  ]),
  viewer: new Set(["content.view", "content.download"]),
};

export function roleHasWorkspaceCapability(
  role: WorkspaceRole,
  capability: WorkspaceCapability,
): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

export function workspaceAllowsCapability(
  context: Pick<WorkspaceActorContext, "role" | "status">,
  capability: WorkspaceCapability,
): boolean {
  if (!roleHasWorkspaceCapability(context.role, capability)) return false;
  if (context.status === "active") return true;
  if (context.status === "pending_payment") {
    return (
      context.role === "owner" &&
      ["content.view", "content.download", "workspace.manage", "billing.manage"].includes(
        capability,
      )
    );
  }
  if (["processing.consume", "publishing.manage", "members.invite"].includes(capability)) {
    return false;
  }
  if (
    context.role !== "owner" &&
    [
      "content.edit",
      "brand.manage",
      "social.manage",
      "workspace.manage",
      "api.manage",
    ].includes(capability)
  ) {
    return false;
  }
  return true;
}

function requiredPrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("DATABASE_URL is required for workspace operations");
  return prisma;
}

function normalizeWorkspaceName(value: string) {
  const name = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 80) {
    throw new Error("Workspace names must be between 1 and 80 characters");
  }
  return name;
}

export function workspacesV1EnabledForUser(userId: string) {
  if (["1", "true", "on"].includes(process.env.WORKSPACES_V1?.trim().toLowerCase() ?? "")) {
    return true;
  }
  return (process.env.WORKSPACES_V1_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(userId);
}

export class WorkspaceService {
  async listAccessibleWorkspaces(userId: string) {
    return requiredPrisma().workspaceMember.findMany({
      where: { userId },
      select: {
        role: true,
        workspace: {
          select: {
            id: true,
            name: true,
            status: true,
            pricingTier: true,
            personalOwnerUserId: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    });
  }

  async createPendingBusinessWorkspace(userId: string, input: { name: string }) {
    if (!workspacesV1EnabledForUser(userId)) {
      throw new Error("Workspace creation is not enabled for this account");
    }
    const prisma = requiredPrisma();
    const name = normalizeWorkspaceName(input.name);
    const [user, ownedCount, personalWorkspace] = await Promise.all([
      prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true } }),
      prisma.workspace.count({ where: { ownerUserId: userId } }),
      prisma.workspace.findUnique({
        where: { personalOwnerUserId: userId },
        select: { timezone: true },
      }),
    ]);
    if (!user) throw new Error("User not found");
    if (ownedCount >= 25) throw new Error("Workspace limit reached");

    const workspace = await prisma.workspace.create({
      data: {
        name,
        ownerUserId: userId,
        status: "pending_payment",
        pricingTier: "business",
        timezone: personalWorkspace?.timezone ?? "UTC",
        members: { create: { userId, role: "owner" } },
      },
      select: { id: true, name: true, status: true, pricingTier: true },
    });
    console.warn(JSON.stringify({
      level: "info",
      message: "workspace_pending_payment_created",
      workspaceId: workspace.id,
      userId,
      role: "owner",
      action: "workspace.create",
    }));
    return workspace;
  }

  async requireActor(
    userId: string,
    workspaceId: string,
    capability: WorkspaceCapability = "content.view",
  ): Promise<WorkspaceActorContext> {
    const membership = await requiredPrisma().workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: {
        role: true,
        workspace: {
          select: { id: true, ownerUserId: true, status: true, pricingTier: true },
        },
      },
    });
    if (!membership) throw new Error("Forbidden");

    const context: WorkspaceActorContext = {
      userId,
      workspaceId: membership.workspace.id,
      workspaceOwnerUserId: membership.workspace.ownerUserId,
      role: membership.role,
      status: membership.workspace.status,
      pricingTier: membership.workspace.pricingTier,
    };
    if (!workspaceAllowsCapability(context, capability)) throw new Error("Forbidden");
    return context;
  }

  async getPersonalWorkspaceId(userId: string): Promise<string> {
    const workspace = await requiredPrisma().workspace.findUnique({
      where: { personalOwnerUserId: userId },
      select: { id: true },
    });
    if (!workspace) throw new Error("Personal workspace not initialized");
    return workspace.id;
  }

  async resolveLegacyOwnership(userId: string, workspaceId?: string) {
    const targetWorkspaceId = workspaceId ?? (await this.getPersonalWorkspaceId(userId));
    const actor = await this.requireActor(userId, targetWorkspaceId);
    return {
      workspaceId: actor.workspaceId,
      actorUserId: userId,
      legacyOwnerUserId: actor.workspaceOwnerUserId,
      role: actor.role,
      status: actor.status,
      pricingTier: actor.pricingTier,
    };
  }

  async getWorkspace(userId: string, workspaceId: string) {
    await this.requireActor(userId, workspaceId, "content.view");
    return requiredPrisma().workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        avatarStorageKey: true,
        status: true,
        timezone: true,
        pricingTier: true,
        billingInterval: true,
        subscriptionEndsAt: true,
        personalOwnerUserId: true,
        createdAt: true,
      },
    });
  }

  async updateWorkspace(
    userId: string,
    workspaceId: string,
    input: { name: string; timezone?: string },
  ) {
    await this.requireActor(userId, workspaceId, "workspace.manage");
    const name = normalizeWorkspaceName(input.name);
    const timezone = input.timezone?.trim() || "UTC";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    } catch {
      throw new Error("Enter a valid IANA timezone, such as America/New_York");
    }
    return requiredPrisma().workspace.update({
      where: { id: workspaceId },
      data: { name, timezone },
      select: { id: true, name: true, timezone: true },
    });
  }

  async presignAvatarUpload(
    userId: string,
    workspaceId: string,
    input: { contentType: string; sizeBytes: number },
  ) {
    await this.requireActor(userId, workspaceId, "workspace.manage");
    const types: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    };
    const extension = types[input.contentType];
    if (!extension || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 5 * 1024 * 1024) {
      throw new Error("Use a JPG, PNG, or WebP image up to 5 MB");
    }
    if (!isR2Configured()) throw new Error("R2 configuration is missing");
    const key = `workspaces/${workspaceId}/avatar/${randomUUID()}.${extension}`;
    const uploadUrl = await presignSingleUploadUrl({
      key,
      contentType: input.contentType,
    });
    return { key, uploadUrl, contentType: input.contentType };
  }

  async setAvatar(
    userId: string,
    workspaceId: string,
    storageKey: string | null,
  ) {
    await this.requireActor(userId, workspaceId, "workspace.manage");
    if (storageKey && !storageKey.startsWith(`workspaces/${workspaceId}/avatar/`)) {
      throw new Error("Avatar upload does not belong to this workspace");
    }
    await requiredPrisma().workspace.update({
      where: { id: workspaceId },
      data: { avatarStorageKey: storageKey },
    });
  }

  async getAvatarUrls(
    userId: string,
    workspaceIds: string[],
  ): Promise<Record<string, string | null>> {
    const memberships = await requiredPrisma().workspaceMember.findMany({
      where: { userId, workspaceId: { in: workspaceIds } },
      select: {
        workspaceId: true,
        workspace: { select: { avatarStorageKey: true } },
      },
    });
    const entries = await Promise.all(
      memberships.map(async (membership) => [
        membership.workspaceId,
        membership.workspace.avatarStorageKey
          ? await presignDownloadUrl({
              key: membership.workspace.avatarStorageKey,
              expiresIn: 60 * 60,
            }).catch(() => null)
          : null,
      ] as const),
    );
    return Object.fromEntries(entries);
  }

  async listMembers(userId: string, workspaceId: string) {
    await this.requireActor(userId, workspaceId, "content.view");
    const prisma = requiredPrisma();
    const [members, invites] = await Promise.all([
      prisma.workspaceMember.findMany({
        where: { workspaceId },
        select: {
          id: true,
          role: true,
          joinedAt: true,
          pendingPaymentOperation: true,
          user: {
            select: {
              id: true,
              primaryEmail: true,
              firstName: true,
              lastName: true,
              imageUrl: true,
            },
          },
        },
        orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      }),
      prisma.workspaceInvite.findMany({
        where: { workspaceId, acceptedAt: null, revokedAt: null },
        select: {
          id: true,
          email: true,
          role: true,
          expiresAt: true,
          createdAt: true,
          pendingPaymentOperation: true,
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return { members, invites };
  }

  async createInvite(
    userId: string,
    workspaceId: string,
    input: { email: string; role: Exclude<WorkspaceRole, "owner"> },
  ) {
    if (!workspacesV1EnabledForUser(userId)) {
      throw new Error("Workspace collaboration is not enabled for this account");
    }
    const actor = await this.requireActor(userId, workspaceId, "members.invite");
    if (actor.pricingTier !== "business") {
      throw new Error("Workspace invitations require the Business plan");
    }
    if (input.role === "admin" && actor.role !== "owner") {
      throw new Error("Only workspace owners can invite admins");
    }
    const email = input.email.trim().toLocaleLowerCase("en-US");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address");
    const prisma = requiredPrisma();
    const existingUser = await prisma.user.findFirst({
      where: { primaryEmail: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (existingUser) {
      const member = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: existingUser.id } },
      });
      if (member) throw new Error("This person is already a workspace member");
    }
    await prisma.workspaceInvite.updateMany({
      where: { workspaceId, email: { equals: email, mode: "insensitive" }, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const invite = await prisma.workspaceInvite.create({
      data: {
        workspaceId,
        email,
        role: input.role,
        tokenHash,
        invitedByUserId: userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      select: { id: true, email: true, role: true, expiresAt: true },
    });
    return { ...invite, token };
  }

  async revokeInvite(userId: string, workspaceId: string, inviteId: string) {
    await this.requireActor(userId, workspaceId, "members.invite");
    await requiredPrisma().workspaceInvite.updateMany({
      where: { id: inviteId, workspaceId, acceptedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async resendInvite(userId: string, workspaceId: string, inviteId: string) {
    await this.requireActor(userId, workspaceId, "members.invite");
    const invite = await requiredPrisma().workspaceInvite.findFirst({
      where: {
        id: inviteId,
        workspaceId,
        acceptedAt: null,
        revokedAt: null,
      },
      select: { email: true, role: true },
    });
    if (!invite || invite.role === "owner") {
      throw new Error("Invitation is no longer available");
    }
    return this.createInvite(userId, workspaceId, {
      email: invite.email,
      role: invite.role,
    });
  }

  async getInvitePreview(rawToken: string) {
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const invite = await requiredPrisma().workspaceInvite.findUnique({
      where: { tokenHash },
      select: {
        email: true,
        role: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        workspace: { select: { name: true, status: true } },
      },
    });
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= new Date()) return null;
    return invite;
  }

  async listApiKeys(userId: string, workspaceId: string) {
    await this.requireActor(userId, workspaceId, "api.manage");
    return requiredPrisma().apiKey.findMany({
      where: { workspaceId, revokedAt: null },
      select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async createApiKey(
    userId: string,
    workspaceId: string,
    input: { name: string; scopes?: string[] },
  ) {
    const actor = await this.requireActor(userId, workspaceId, "api.manage");
    if (!hasFeature(actor.pricingTier, "integrations.api")) {
      throw new Error("Workspace API keys require Business");
    }
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new Error("API key name is required");
    const requestedScopes = input.scopes?.length ? [...new Set(input.scopes)] : ["projects:read"];
    const invalidScopes = requestedScopes.filter(
      (scope) => !WORKSPACE_API_KEY_SCOPES.includes(scope as WorkspaceApiKeyScope),
    );
    if (invalidScopes.length) {
      throw new Error(`Unsupported API key scope: ${invalidScopes.join(", ")}`);
    }
    const secret = `nf_${randomBytes(32).toString("base64url")}`;
    const prefix = secret.slice(0, 11);
    const hashedSecret = createHash("sha256").update(secret).digest("hex");
    const key = await requiredPrisma().apiKey.create({
      data: {
        userId,
        workspaceId,
        createdByUserId: userId,
        name,
        prefix,
        hashedSecret,
        scopes: requestedScopes,
      },
      select: { id: true, name: true, prefix: true, scopes: true, createdAt: true },
    });
    return { ...key, secret };
  }

  async revokeApiKey(userId: string, workspaceId: string, keyId: string) {
    await this.requireActor(userId, workspaceId, "api.manage");
    await requiredPrisma().apiKey.updateMany({
      where: { id: keyId, workspaceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async authenticateApiKey(secret: string): Promise<WorkspaceApiKeyPrincipal | null> {
    if (!secret.startsWith("nf_") || secret.length < 32) return null;

    const prefix = secret.slice(0, 11);
    const key = await requiredPrisma().apiKey.findUnique({
      where: { prefix },
      select: {
        id: true,
        userId: true,
        createdByUserId: true,
        workspaceId: true,
        name: true,
        scopes: true,
        hashedSecret: true,
        revokedAt: true,
        lastUsedAt: true,
      },
    });
    if (!key || key.revokedAt || !key.workspaceId) return null;

    const suppliedHash = Buffer.from(createHash("sha256").update(secret).digest("hex"), "hex");
    const storedHash = Buffer.from(key.hashedSecret, "hex");
    if (suppliedHash.length !== storedHash.length || !timingSafeEqual(suppliedHash, storedHash)) {
      return null;
    }

    const lastUsedCutoff = new Date(Date.now() - 5 * 60 * 1000);
    if (!key.lastUsedAt || key.lastUsedAt < lastUsedCutoff) {
      await requiredPrisma().apiKey.updateMany({
        where: {
          id: key.id,
          revokedAt: null,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: lastUsedCutoff } }],
        },
        data: { lastUsedAt: new Date() },
      });
    }

    return {
      apiKeyId: key.id,
      userId: key.createdByUserId ?? key.userId,
      workspaceId: key.workspaceId,
      name: key.name,
      scopes: key.scopes,
    };
  }
}

export const workspaceService = new WorkspaceService();
