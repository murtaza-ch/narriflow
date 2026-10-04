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
let selectedWorkspaceId: string | undefined;
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
const prisma = {
  user: {
    findUnique: mock(async () => {
      calls.push("user-provisioning-read");
      return user;
    }),
    findFirst: mock(async () => {
      calls.push("authenticated-user-read");
      return user;
    }),
  },
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

mock.module("server-only", () => ({}));
mock.module("@narriflow/db/client", () => ({ getPrismaClient: () => prisma }));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: user.clerkId }),
  clerkClient: async () => { throw new Error("Complete users do not need Clerk identity lookup"); },
  currentUser: async () => { throw new Error("Complete users do not need Clerk refresh"); },
}));
mock.module("next/headers", () => ({
  cookies: async () => ({
    get: () => selectedWorkspaceId ? { value: selectedWorkspaceId } : undefined,
  }),
}));
const { ensurePersonalWorkspace, getCurrentAppUser, getWorkspaceContextForUser } =
  await import("@narriflow/auth");

beforeEach(() => {
  user.firstName = "Test";
  user.lastName = "Actor";
  user.imageUrl = "https://example.test/avatar.png";
  currentWorkspace = { ...workspace };
  personalRole = "owner";
  selectedWorkspaceId = undefined;
  selectedMembership = null;
  upsertFailure = null;
  calls = [];
});

describe("personal workspace provisioning", () => {
  test("missing optional names and avatar do not trigger Clerk profile refreshes", async () => {
    user.firstName = null;
    user.lastName = null;
    user.imageUrl = null;
    expect(await getCurrentAppUser()).toBe(user);
    expect(await getCurrentAppUser()).toBe(user);
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
        "personal-membership-read", "user-provisioning-read",
        "workspace-provision", "owner-membership-repair",
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

describe("current actor workspace reads", () => {
  test("an intact signed-in user takes two reads before workspace resolution", async () => {
    expect(await getCurrentAppUser()).toEqual(user);
    expect(calls).toEqual(["authenticated-user-read", "personal-membership-read"]);
  });

  test("resolves the personal selection from one live read", async () => {
    expect(await getWorkspaceContextForUser(user)).toMatchObject({
      userId: user.id, workspaceId: workspace.id, role: "owner",
      pricingTier: "creator", status: "active", workspaceSelectionChanged: false,
    });
    expect(calls).toEqual(["personal-membership-read"]);
    currentWorkspace = { ...workspace, status: "restricted", pricingTier: "business" };
    expect(await getWorkspaceContextForUser(user)).toMatchObject({
      status: "restricted", pricingTier: "business",
    });
    expect(calls).toHaveLength(2);
  });

  test("fallback still repairs a downgraded personal membership", async () => {
    personalRole = "viewer";
    expect(await getWorkspaceContextForUser(user)).toMatchObject({ role: "owner" });
    expect(personalRole).toBe("owner");
    expect(calls).toContain("owner-membership-repair");
  });

  test("reads the selected team membership again and keeps its actual role", async () => {
    selectedWorkspaceId = "team-workspace";
    selectedMembership = {
      userId: user.id, role: "editor",
      workspace: { ...workspace, id: selectedWorkspaceId, personalOwnerUserId: null },
    };
    expect(await getWorkspaceContextForUser(user)).toMatchObject({
      role: "editor", userId: user.id, workspaceId: selectedWorkspaceId, isPersonal: false,
    });
    selectedMembership.role = "viewer";
    selectedMembership.workspace.status = "restricted";
    expect(await getWorkspaceContextForUser(user)).toMatchObject({
      role: "viewer", status: "restricted", userId: user.id,
    });
    expect(calls).toEqual(["selected-membership-read", "selected-membership-read"]);
  });

  test("a removed selected membership resolves the personal fallback", async () => {
    selectedWorkspaceId = "team-workspace";
    expect(await getWorkspaceContextForUser(user)).toMatchObject({
      workspaceId: workspace.id, role: "owner", workspaceSelectionChanged: true,
    });
    expect(calls).toEqual(["selected-membership-read", "personal-membership-read"]);
  });
});
