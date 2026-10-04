import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

setDefaultTimeout(180_000);
const url = process.env.AUTHENTICATED_REQUEST_POLICY_TEST_DATABASE_URL;
const schema = process.env.AUTHENTICATED_REQUEST_POLICY_TEST_DATABASE_SCHEMA;
let prisma: PrismaClient;
let pool: Pool;
let payload: Record<string, unknown>;
let failProvisioning = false;
let templateId: string;
const { ClerkAPIResponseError } = createRequire(import.meta.resolve("@clerk/nextjs"))("@clerk/shared/error");
const getClerkUser = mock(async (id: string) => ({ id }));
mock.module("server-only", () => ({}));
mock.module("@narriflow/db/client", () => ({ getPrismaClient: () => failProvisioning ? { ...prisma, workspace: { ...prisma.workspace, upsert: async () => { throw new Error("Injected database outage"); } } } : prisma }));
mock.module("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: payload.id }), currentUser: async () => payload, clerkClient: async () => ({ users: { getUser: getClerkUser } }) }));
const { getCurrentAppUser, syncClerkUserPayload, markUserDeletedByClerkId } = await import("@narriflow/auth");

function clerkProfile(name?: string, provider = "oauth_apple") {
  const id = `workspace-entry-${randomUUID()}`;
  return { id, firstName: name ?? null, lastName: null, imageUrl: null, lastSignInAt: Date.now(), primaryEmailAddressId: "email", emailAddresses: [{ id: "email", emailAddress: `${id}@example.test`, verification: { status: "verified" } }], externalAccounts: [{ provider, providerUserId: id, emailAddress: `${id}@example.test` }] };
}

beforeAll(async () => {
  if (!url || !schema || !schema.startsWith("authenticated_request_policy_test_")) throw new Error("Disposable authentication schema required");
  pool = new Pool({ connectionString: url, max: 4 });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  const template = await prisma.brandTemplate.upsert({ where: { builtInKey: "karaoke" }, create: { name: "Karaoke", builtInKey: "karaoke", isBuiltIn: true, captionPreset: {} }, update: {} });
  templateId = template.id;
});
afterAll(async () => { await prisma?.$disconnect(); await pool?.end(); });

async function expectWorkspace(userId: string, name: string) {
  const workspaces = await prisma.workspace.findMany({ where: { personalOwnerUserId: userId }, include: { members: true, billingAccount: true } });
  expect(workspaces).toHaveLength(1);
  expect(workspaces[0].name).toBe(name);
  expect(workspaces[0].pricingTier).toBe("free");
  expect(workspaces[0].status).toBe("active");
  expect(workspaces[0].members.map((member) => [member.userId, member.role])).toEqual([[userId, "owner"]]);
  expect(workspaces[0].billingAccount).not.toBeNull();
  expect(workspaces[0].defaultBrandTemplateId).toBe(templateId);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).defaultBrandTemplateId).toBe(templateId);
  return workspaces[0];
}

describe("automatic workspace entry before webhook delivery", () => {
  test("concurrent first sign-ins create one free workspace, owner, and billing account", async () => {
    payload = clerkProfile("Ada");
    const users = await Promise.all([getCurrentAppUser(), getCurrentAppUser(), getCurrentAppUser()]);
    expect(new Set(users.map((user) => user?.id)).size).toBe(1);
    await expectWorkspace(users[0]!.id, "Ada's workspace");
    expect(await prisma.webhookDeliveryLog.count()).toBe(0);
    expect(await prisma.authIdentity.count({ where: { userId: users[0]!.id, provider: "apple" } })).toBe(1);
  });
  test("nameless verified accounts enter My workspace and keep custom names", async () => {
    payload = clerkProfile();
    const user = await getCurrentAppUser();
    const workspace = await expectWorkspace(user!.id, "My workspace");
    await prisma.workspace.update({ where: { id: workspace.id }, data: { name: "My studio" } });
    await syncClerkUserPayload(payload);
    await expectWorkspace(user!.id, "My studio");
  });
  test("database failure is retryable without a duplicate user or partial workspace", async () => {
    payload = clerkProfile(undefined, "oauth_google");
    failProvisioning = true;
    try { await expect(getCurrentAppUser()).rejects.toThrow("Injected database outage"); }
    finally { failProvisioning = false; }
    const user = await getCurrentAppUser();
    expect(await prisma.user.count({ where: { clerkId: String(payload.id) } })).toBe(1);
    await expectWorkspace(user!.id, "My workspace");
  });
  test("deletion releases email and identities while a new account receives its own workspace", async () => {
    const previous = clerkProfile("Former"); payload = previous;
    const oldUser = await getCurrentAppUser();
    const oldWorkspace = await expectWorkspace(oldUser!.id, "Former's workspace");
    await markUserDeletedByClerkId(previous.id);
    expect(await prisma.authIdentity.count({ where: { userId: oldUser!.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: oldUser!.id } })).primaryEmail).toBeNull();
    const next = clerkProfile("New"); next.emailAddresses[0].emailAddress = previous.emailAddresses[0].emailAddress; payload = next;
    const newUser = await getCurrentAppUser();
    expect(newUser!.id).not.toBe(oldUser!.id);
    expect((await expectWorkspace(newUser!.id, "New's workspace")).id).not.toBe(oldWorkspace.id);
    expect(await prisma.workspaceMember.count({ where: { userId: newUser!.id, workspaceId: oldWorkspace.id } })).toBe(0);
  });
  test("concurrent registrations can reuse an email left on an old soft-deleted fixture", async () => {
    const previous = clerkProfile(); payload = previous;
    const oldUser = await getCurrentAppUser();
    await prisma.user.update({ where: { id: oldUser!.id }, data: { deletedAt: new Date() } });
    const next = clerkProfile(); next.emailAddresses[0].emailAddress = previous.emailAddresses[0].emailAddress; payload = next;
    const users = await Promise.all([getCurrentAppUser(), getCurrentAppUser(), getCurrentAppUser()]);
    expect(new Set(users.map((user) => user!.id)).size).toBe(1);
    expect(users[0]!.id).not.toBe(oldUser!.id);
    await expectWorkspace(users[0]!.id, "My workspace");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: oldUser!.id } })).primaryEmail).toBeNull();
    expect(await prisma.authIdentity.count({ where: { userId: oldUser!.id } })).toBe(0);
  });
  test("a missed deletion webhook is repaired only after Clerk confirms the previous identity is gone", async () => {
    const previous = clerkProfile(); payload = previous;
    const oldUser = await getCurrentAppUser();
    const next = clerkProfile(); next.emailAddresses[0].emailAddress = previous.emailAddresses[0].emailAddress; payload = next;
    getClerkUser.mockRejectedValueOnce(new ClerkAPIResponseError("Not found", { status: 404, data: [{ code: "resource_not_found", message: "Not found" }] }));
    const newUser = await getCurrentAppUser();
    expect(getClerkUser).toHaveBeenLastCalledWith(previous.id);
    expect(newUser!.id).not.toBe(oldUser!.id);
    await expectWorkspace(newUser!.id, "My workspace");
    const deletedUser = await prisma.user.findUniqueOrThrow({ where: { id: oldUser!.id } });
    expect(deletedUser.deletedAt).not.toBeNull(); expect(deletedUser.primaryEmail).toBeNull();
  });
  test("a live identity or unavailable Clerk API cannot release another user's email", async () => {
    const previous = clerkProfile(); payload = previous;
    const oldUser = await getCurrentAppUser();
    const identityCount = await prisma.authIdentity.count({ where: { userId: oldUser!.id } });
    expect(identityCount).toBeGreaterThan(0);
    const next = clerkProfile(); next.emailAddresses[0].emailAddress = previous.emailAddresses[0].emailAddress; payload = next;
    await expect(getCurrentAppUser()).rejects.toMatchObject({ code: "P2002" });
    getClerkUser.mockRejectedValueOnce(new ClerkAPIResponseError("Clerk unavailable", { status: 503, data: [] }));
    await expect(getCurrentAppUser()).rejects.toThrow("Clerk unavailable");
    const retainedUser = await prisma.user.findUniqueOrThrow({ where: { id: oldUser!.id } });
    expect(retainedUser.deletedAt).toBeNull(); expect(retainedUser.primaryEmail).toBe(previous.emailAddresses[0].emailAddress);
    expect(await prisma.authIdentity.count({ where: { userId: oldUser!.id } })).toBe(identityCount);
    expect(await prisma.user.count({ where: { clerkId: next.id } })).toBe(0);
  });
});
