import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { User, Workspace, WorkspaceRole } from "@prisma/client";

const user = {
  id: "actor-user",
  clerkId: "clerk-actor",
  firstName: "Test",
  lastName: "Actor",
  primaryEmail: "actor@example.test",
  emailVerifiedAt: new Date(),
  imageUrl: "https://example.test/avatar.png",
  lastSignInAt: new Date(),
  defaultBrandTemplateId: "default-template",
} as User;
const workspace = {
  id: "personal-workspace",
  name: "Test Actor's workspace",
  ownerUserId: user.id,
  personalOwnerUserId: user.id,
  status: "active",
  pricingTier: "creator",
} as Workspace;

let currentWorkspace: Workspace | null;
let personalRole: WorkspaceRole | null;
let selectedMembership: { role: WorkspaceRole; userId: string; workspace: Workspace } | null;
let upsertFailure: unknown;
let calls: string[];

const membershipFindFirst = mock(async (input: {
  where: { userId: string; role?: WorkspaceRole; workspace: { personalOwnerUserId: string } };
}) => {
  calls.push("personal-membership-read");
  expect(input.where.userId).toBe(user.id);
  expect(input.where.workspace.personalOwnerUserId).toBe(user.id);
  if (!currentWorkspace || !personalRole ||
    input.where.role && input.where.role !== personalRole) return null;
  return { userId: user.id, role: personalRole, workspace: { ...currentWorkspace } };
});
const membershipFindUnique = mock(async (input: {
  where: { workspaceId_userId: { userId: string; workspaceId: string } };
}) => {
  calls.push("selected-membership-read");
  expect(input.where.workspaceId_userId.userId).toBe(user.id);
  if (input.where.workspaceId_userId.workspaceId === currentWorkspace?.id) {
    return personalRole
      ? { userId: user.id, role: personalRole, workspace: { ...currentWorkspace } }
      : null;
  }
  return selectedMembership;
});
const membershipUpsert = mock(async (input: {
  where: { workspaceId_userId: { userId: string; workspaceId: string } };
  create: { userId: string; role: WorkspaceRole };
  update: { role: WorkspaceRole };
}) => {
  calls.push("owner-membership-repair");
  expect(input.where.workspaceId_userId.userId).toBe(user.id);
  expect(input.where.workspaceId_userId.workspaceId).toBe(workspace.id);
  expect(input.create.role).toBe("owner");
  expect(input.update.role).toBe("owner");
  personalRole = "owner";
  return { role: personalRole };
});
const workspaceUpsert = mock(async (input: {
  where: { personalOwnerUserId: string };
  create: {
    name: string;
    ownerUserId: string;
    personalOwnerUserId: string;
    billingAccount: { create: object };
    members: { create: { userId: string; role: WorkspaceRole } };
  };
}) => {
  calls.push("workspace-provision");
  expect(input.where.personalOwnerUserId).toBe(user.id);
  expect(input.create.ownerUserId).toBe(user.id);
  expect(input.create.personalOwnerUserId).toBe(user.id);
  expect(input.create.billingAccount).toEqual({ create: {} });
  expect(input.create.members.create).toEqual({ userId: user.id, role: "owner" });
  if (upsertFailure) throw upsertFailure;
  currentWorkspace ??= { ...workspace, name: input.create.name };
  return { ...currentWorkspace };
});
const OTHER_WORKSPACE_ID = "7b0f4a52-3f1c-4d63-9d0e-1b2f3a4c5d6e";

// Rows the user table can return, by the unique key the service queries.
let userByClerkId: User | null;
let emailOwner: User | null;
const userWrites: string[] = [];
let userUpsertFailures: unknown[];
let defaultTemplateExists: boolean;
let builtInTemplateId: string | null;
let identityUpserts: Array<{ provider: string; providerUserId: string }>;

const prisma = {
  user: {
    findUnique: mock(async (input: { where: { id?: string; clerkId?: string; primaryEmail?: string } }) => {
      if (input.where.clerkId) {
        calls.push("user-clerk-read");
        return userByClerkId;
      }
      if (input.where.primaryEmail) {
        calls.push("email-owner-read");
        return emailOwner;
      }
      calls.push("user-provisioning-read");
      return storedUser ?? user;
    }),
    findFirst: mock(async () => {
      calls.push("authenticated-user-read");
      return storedUser;
    }),
    upsert: mock(async (input: { create: Record<string, unknown> }) => {
      calls.push("user-upsert");
      const failure = userUpsertFailures.shift();
      if (failure) throw failure;
      userWrites.push(String(input.create.clerkId));
      return { ...user, ...input.create };
    }),
    update: mock(async (input: { where: { id: string }; data: Record<string, unknown> }) => {
      calls.push("user-update");
      return { ...user, ...input.data };
    }),
    updateMany: mock(async (input: { where: { clerkId: string } }) => {
      calls.push(`user-soft-delete:${input.where.clerkId}`);
      return { count: 1 };
    }),
  },
  authIdentity: {
    upsert: mock(async (input: { create: { provider: string; providerUserId: string } }) => {
      identityUpserts.push(input.create);
      return input.create;
    }),
    deleteMany: mock(async () => ({ count: 1 })),
  },
  brandTemplate: {
    findFirst: mock(async (input: { where: { id?: string; builtInKey?: string } }) => {
      if (input.where.id) return defaultTemplateExists ? { id: input.where.id } : null;
      return builtInTemplateId ? { id: builtInTemplateId } : null;
    }),
  },
  $transaction: mock(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
  workspace: {
    upsert: workspaceUpsert,
    findUnique: mock(async () => currentWorkspace),
  },
  workspaceMember: {
    findFirst: membershipFindFirst,
    findUnique: membershipFindUnique,
    upsert: membershipUpsert,
  },
};

let storedUser: User | null;

mock.module("@narriflow/db/client", () => ({ getPrismaClient: () => prisma }));
const auth = await import("../src");
const {
  ClerkDirectoryUnavailableError,
  ensurePersonalWorkspace,
  getAppUserForClerkIdentity,
  markUserDeletedByClerkId,
  resolveScopedWorkspaceContext,
  resolveWorkspaceContext,
  selectWorkspaceForActor,
  syncClerkUserPayload,
} = auth;

class FakeClerkApiError extends Error {
  static kind = "ClerkAPIResponseError";
  constructor(readonly status: number) {
    super(`clerk ${status}`);
  }
}

let directoryLookups: string[];
let directoryOutcome: "complete-user-only" | { user: Record<string, unknown> } | { error: unknown };
const directory = {
  users: {
    getUser: mock(async (clerkUserId: string) => {
      directoryLookups.push(clerkUserId);
      if (directoryOutcome === "complete-user-only") {
        throw new Error("Complete users do not need a Clerk lookup");
      }
      if ("error" in directoryOutcome) throw directoryOutcome.error;
      return directoryOutcome.user as never;
    }),
  },
};

const clerkPayload = {
  id: user.clerkId,
  first_name: "Test",
  last_name: "Actor",
  image_url: "https://example.test/avatar.png",
  last_sign_in_at: 1_700_000_000_000,
  primary_email_address_id: "email_1",
  email_addresses: [
    {
      id: "email_1",
      email_address: "actor@example.test",
      verification: { status: "verified" },
      updated_at: 1_700_000_000_000,
    },
  ],
  external_accounts: [{ provider: "oauth_google", provider_user_id: "google-1" }],
};

beforeEach(() => {
  user.firstName = "Test";
  user.lastName = "Actor";
  user.imageUrl = "https://example.test/avatar.png";
  user.primaryEmail = "actor@example.test";
  currentWorkspace = { ...workspace };
  personalRole = "owner";
  selectedMembership = null;
  upsertFailure = null;
  calls = [];
  storedUser = user;
  userByClerkId = null;
  emailOwner = null;
  userWrites.length = 0;
  userUpsertFailures = [];
  defaultTemplateExists = true;
  builtInTemplateId = "karaoke-template";
  identityUpserts = [];
  directoryLookups = [];
  directoryOutcome = "complete-user-only";
  prisma.user.update.mockClear();
  prisma.$transaction.mockClear();
});

describe("personal workspace provisioning", () => {
  test("missing optional names and avatar do not trigger Clerk profile refreshes", async () => {
    user.firstName = null;
    user.lastName = null;
    user.imageUrl = null;
    expect(await getAppUserForClerkIdentity(user.clerkId, directory)).toBe(user);
    expect(await getAppUserForClerkIdentity(user.clerkId, directory)).toBe(user);
    expect(directoryLookups).toEqual([]);
  });

  test("a nameless account receives My workspace without onboarding", async () => {
    user.firstName = null;
    user.lastName = null;
    currentWorkspace = null;
    personalRole = null;
    const created = await ensurePersonalWorkspace(user.id);
    expect(created.name).toBe("My workspace");
    expect(personalRole).toBe("owner");
  });

  test("reads an intact Workspace and Owner membership without rewriting them", async () => {
    expect(await ensurePersonalWorkspace(user.id)).toEqual(workspace);
    expect(calls).toEqual(["personal-membership-read"]);
  });

  test.each([null, "viewer", "editor", "admin"] as const)(
    "repairs a %s personal membership instead of accepting it as Owner",
    async (role) => {
      personalRole = role;
      expect(await ensurePersonalWorkspace(user.id)).toEqual(workspace);
      expect(personalRole).toBe("owner");
      expect(calls).toEqual([
        "personal-membership-read",
        "user-provisioning-read",
        "workspace-provision",
        "owner-membership-repair",
      ]);
    },
  );

  test("provisions the missing Workspace with its billing account and Owner", async () => {
    currentWorkspace = null;
    personalRole = null;
    expect(await ensurePersonalWorkspace(user.id)).toEqual(workspace);
    expect(personalRole).toBe("owner");
    expect(calls).toHaveLength(4);
  });

  test("reads again on the next request and repairs a removed membership", async () => {
    await ensurePersonalWorkspace(user.id);
    personalRole = null;
    await ensurePersonalWorkspace(user.id);
    expect(calls.filter((call) => call === "personal-membership-read")).toHaveLength(2);
    expect(personalRole).toBe("owner");
  });

  test("preserves concurrent creation recovery and propagates unrelated errors", async () => {
    personalRole = null;
    upsertFailure = { code: "P2002" };
    expect(await ensurePersonalWorkspace(user.id)).toEqual(workspace);
    expect(personalRole).toBe("owner");
    personalRole = null;
    upsertFailure = new Error("Database unavailable");
    await expect(ensurePersonalWorkspace(user.id)).rejects.toThrow("Database unavailable");
  });
});

describe("App User for a verified Clerk identity", () => {
  test("an intact signed-in user takes two reads and never asks Clerk", async () => {
    expect(await getAppUserForClerkIdentity(user.clerkId, directory)).toEqual(user);
    expect(calls).toEqual(["authenticated-user-read", "personal-membership-read"]);
    expect(directoryLookups).toEqual([]);
  });

  test("a user without a default brand template receives the built-in first-use template", async () => {
    storedUser = { ...user, defaultBrandTemplateId: null } as User;
    expect(await getAppUserForClerkIdentity(user.clerkId, directory)).toBe(storedUser);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: user.id },
      data: { defaultBrandTemplateId: "karaoke-template" },
    });
  });

  test("an incomplete profile refreshes synchronously from the Backend API", async () => {
    storedUser = { ...user, lastSignInAt: null } as User;
    directoryOutcome = { user: clerkPayload };
    const refreshed = await getAppUserForClerkIdentity(user.clerkId, directory);
    expect(directoryLookups).toEqual([user.clerkId]);
    expect(refreshed.primaryEmail).toBe("actor@example.test");
    expect(userWrites).toEqual([user.clerkId]);
  });

  test("first login provisions the user, identities, brand template and personal Workspace", async () => {
    storedUser = null;
    directoryOutcome = { user: clerkPayload };
    const created = await getAppUserForClerkIdentity(user.clerkId, directory);
    expect(created.clerkId).toBe(user.clerkId);
    expect(directoryLookups).toEqual([user.clerkId]);
    expect(identityUpserts).toEqual([
      expect.objectContaining({ provider: "email_password", providerUserId: user.clerkId }),
      expect.objectContaining({ provider: "google", providerUserId: "google-1" }),
    ]);
    expect(calls).toContain("personal-membership-read");
  });

  test("a first-login Clerk outage is a typed unavailable error and invents no user", async () => {
    storedUser = null;
    for (const error of [new FakeClerkApiError(503), new FakeClerkApiError(429), new TypeError("fetch failed")]) {
      directoryOutcome = { error };
      const failure = await getAppUserForClerkIdentity(user.clerkId, directory).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ClerkDirectoryUnavailableError);
      expect((failure as Error).cause).toBe(error);
    }
    expect(userWrites).toEqual([]);
  });

  test("a stale-profile refresh outage is a typed unavailable error and keeps the stored user", async () => {
    storedUser = { ...user, lastSignInAt: null } as User;
    directoryOutcome = { error: new FakeClerkApiError(502) };
    await expect(getAppUserForClerkIdentity(user.clerkId, directory)).rejects.toBeInstanceOf(
      ClerkDirectoryUnavailableError,
    );
    expect(userWrites).toEqual([]);
  });

  test("a non-outage Clerk refusal and a database failure stay ordinary errors", async () => {
    storedUser = null;
    directoryOutcome = { error: new FakeClerkApiError(401) };
    const refusal = await getAppUserForClerkIdentity(user.clerkId, directory).catch((e: unknown) => e);
    expect(refusal).not.toBeInstanceOf(ClerkDirectoryUnavailableError);
    expect((refusal as Error).message).toBe("clerk 401");

    directoryOutcome = { user: clerkPayload };
    userUpsertFailures = [new Error("database down")];
    const database = await getAppUserForClerkIdentity(user.clerkId, directory).catch((e: unknown) => e);
    expect(database).not.toBeInstanceOf(ClerkDirectoryUnavailableError);
    expect((database as Error).message).toBe("database down");
  });
});

describe("Clerk user sync uniqueness races", () => {
  const p2002 = () => ({ code: "P2002" });

  test("a lost first-login race recovers the exact Clerk row", async () => {
    userUpsertFailures = [p2002()];
    userByClerkId = { ...user } as User;
    const synced = await syncClerkUserPayload(clerkPayload, directory);
    expect(synced.clerkId).toBe(user.clerkId);
    expect(calls).toContain("user-update");
    expect(calls).not.toContain("email-owner-read");
  });

  test("an unrelated uniqueness failure propagates", async () => {
    userUpsertFailures = [new Error("boom")];
    await expect(syncClerkUserPayload(clerkPayload, directory)).rejects.toThrow("boom");
  });

  test("a live email owner is never displaced", async () => {
    userUpsertFailures = [p2002()];
    emailOwner = { ...user, id: "other-user", clerkId: "clerk-other", deletedAt: null } as User;
    directoryOutcome = { user: {} };
    await expect(syncClerkUserPayload(clerkPayload, directory)).rejects.toMatchObject({ code: "P2002" });
    expect(directoryLookups).toEqual(["clerk-other"]);
    expect(calls.some((call) => call.startsWith("user-soft-delete"))).toBe(false);
  });

  test("only a confirmed Clerk 404 releases the email", async () => {
    userUpsertFailures = [p2002()];
    emailOwner = { ...user, id: "other-user", clerkId: "clerk-other", deletedAt: null } as User;
    directoryOutcome = { error: new FakeClerkApiError(404) };
    const synced = await syncClerkUserPayload(clerkPayload, directory);
    expect(synced.clerkId).toBe(user.clerkId);
    expect(calls).toContain("user-soft-delete:clerk-other");
    expect(userWrites).toEqual([user.clerkId]);
  });

  test("a Clerk outage fails closed and leaves the email owner untouched", async () => {
    userUpsertFailures = [p2002()];
    emailOwner = { ...user, id: "other-user", clerkId: "clerk-other", deletedAt: null } as User;
    directoryOutcome = { error: new FakeClerkApiError(500) };
    await expect(syncClerkUserPayload(clerkPayload, directory)).rejects.toBeInstanceOf(
      ClerkDirectoryUnavailableError,
    );
    expect(calls.some((call) => call.startsWith("user-soft-delete"))).toBe(false);
  });

  test("an already deleted email owner is released without asking Clerk", async () => {
    userUpsertFailures = [p2002()];
    emailOwner = { ...user, id: "other-user", clerkId: "clerk-other", deletedAt: new Date() } as User;
    await syncClerkUserPayload(clerkPayload, directory);
    expect(directoryLookups).toEqual([]);
    expect(calls).toContain("user-soft-delete:clerk-other");
  });

  test("a payload without an id is rejected before any write", async () => {
    await expect(syncClerkUserPayload({ first_name: "x" }, directory)).rejects.toThrow(
      "Missing Clerk user id in payload",
    );
    expect(calls).toEqual([]);
  });

  test("user.deleted removes identities and soft-deletes in one transaction", async () => {
    await markUserDeletedByClerkId(user.clerkId);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(calls).toContain(`user-soft-delete:${user.clerkId}`);
  });
});

describe("workspace selection", () => {
  const teamMembership = (role: WorkspaceRole = "editor") => ({
    userId: user.id,
    role,
    workspace: { ...workspace, id: OTHER_WORKSPACE_ID, personalOwnerUserId: null },
  });

  test("bootstrap resolves the personal selection from one live read", async () => {
    expect(await resolveWorkspaceContext(user)).toMatchObject({
      userId: user.id,
      workspaceId: workspace.id,
      role: "owner",
      pricingTier: "creator",
      status: "active",
      workspaceSelectionChanged: false,
    });
    expect(calls).toEqual(["personal-membership-read"]);
    currentWorkspace = { ...workspace, status: "restricted", pricingTier: "business" };
    expect(await resolveWorkspaceContext(user)).toMatchObject({
      status: "restricted",
      pricingTier: "business",
    });
    expect(calls).toHaveLength(2);
  });

  test("bootstrap fallback still repairs a downgraded personal membership", async () => {
    personalRole = "viewer";
    expect(await resolveWorkspaceContext(user)).toMatchObject({ role: "owner" });
    expect(personalRole).toBe("owner");
    expect(calls).toContain("owner-membership-repair");
  });

  test("bootstrap reads the selected team membership again and keeps its actual role", async () => {
    selectedMembership = teamMembership();
    expect(await resolveWorkspaceContext(user, OTHER_WORKSPACE_ID)).toMatchObject({
      role: "editor",
      userId: user.id,
      workspaceId: OTHER_WORKSPACE_ID,
      isPersonal: false,
      workspaceSelectionChanged: false,
    });
    selectedMembership.role = "viewer";
    selectedMembership.workspace.status = "restricted";
    expect(await resolveWorkspaceContext(user, OTHER_WORKSPACE_ID)).toMatchObject({
      role: "viewer",
      status: "restricted",
    });
    expect(calls).toEqual(["selected-membership-read", "selected-membership-read"]);
  });

  test("bootstrap falls back from a removed selection and reports the change", async () => {
    expect(await resolveWorkspaceContext(user, OTHER_WORKSPACE_ID)).toMatchObject({
      workspaceId: workspace.id,
      role: "owner",
      workspaceSelectionChanged: true,
    });
    expect(calls).toEqual(["selected-membership-read", "personal-membership-read"]);
  });

  test("bootstrap treats a malformed hint as a removed selection without querying it", async () => {
    expect(await resolveWorkspaceContext(user, "not-a-uuid")).toMatchObject({
      workspaceId: workspace.id,
      workspaceSelectionChanged: true,
    });
    expect(calls).toEqual(["personal-membership-read"]);
  });

  test("scoped requests honour a currently valid selection", async () => {
    selectedMembership = teamMembership("admin");
    expect(await resolveScopedWorkspaceContext(user, OTHER_WORKSPACE_ID)).toMatchObject({
      workspaceId: OTHER_WORKSPACE_ID,
      role: "admin",
      workspaceSelectionChanged: false,
    });
  });

  test("scoped requests refuse a removed selection instead of falling into the personal Workspace", async () => {
    expect(await resolveScopedWorkspaceContext(user, OTHER_WORKSPACE_ID)).toBeNull();
    expect(calls).toEqual(["selected-membership-read"]);
  });

  test("scoped requests refuse a missing or malformed selection without any read", async () => {
    expect(await resolveScopedWorkspaceContext(user, undefined)).toBeNull();
    expect(await resolveScopedWorkspaceContext(user, "../personal")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a switch validates live membership and returns the selected Workspace", async () => {
    selectedMembership = teamMembership();
    expect(await selectWorkspaceForActor(user.id, OTHER_WORKSPACE_ID)).toMatchObject({
      workspaceId: OTHER_WORKSPACE_ID,
      role: "editor",
    });
    selectedMembership = null;
    expect(await selectWorkspaceForActor(user.id, OTHER_WORKSPACE_ID)).toBeNull();
  });
});
