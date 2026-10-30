import { afterAll, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ClerkUserDirectory } from "@narriflow/auth";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

// A Clerk deletion is terminal for its identity: no reordered, retried or
// concurrent user.created/user.updated event may restore the account, and no
// Workspace API key, REST request or MCP token may act for it afterwards.
setDefaultTimeout(180_000);
const url = process.env.AUTHENTICATED_REQUEST_POLICY_TEST_DATABASE_URL;
const schema = process.env.AUTHENTICATED_REQUEST_POLICY_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_AUTHENTICATED_REQUEST_POLICY_DB_TESTS === "1" && Boolean(url);
const dbDescribe = enabled ? describe : describe.skip;
let prisma: PrismaClient;
let pool: Pool;

if (enabled) {
  mock.module("@narriflow/db/client", () => ({ getPrismaClient: () => prisma }));
}
const auth = enabled ? await import("@narriflow/auth") : ({} as typeof import("@narriflow/auth"));
const { workspaceService } = enabled
  ? await import("@narriflow/services")
  : ({} as typeof import("@narriflow/services"));
const { createNarriflowTokenVerifier } = enabled
  ? await import("@narriflow/mcp-core/auth")
  : ({} as typeof import("@narriflow/mcp-core/auth"));

const directory = {
  users: { getUser: async () => { throw new Error("Clerk deleted this user"); } },
} as unknown as ClerkUserDirectory;

function clerkProfile() {
  const id = `user_deleted_${randomUUID()}`;
  return {
    id,
    firstName: "Gone",
    lastName: null,
    imageUrl: null,
    lastLoginAt: null,
    lastSignInAt: Date.now(),
    primaryEmailAddressId: "email",
    emailAddresses: [{ id: "email", emailAddress: `${id}@example.test`, verification: { status: "verified" } }],
    externalAccounts: [{ provider: "oauth_google", providerUserId: id, emailAddress: `${id}@example.test` }],
  };
}

/** A provisioned account with a Workspace API key and a standing grant. */
async function provision() {
  const profile = clerkProfile();
  const user = await auth.syncClerkUserPayload(profile, directory);
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { personalOwnerUserId: user.id } });
  const secret = `nf_${randomBytes(30).toString("base64url")}`;
  const key = await prisma.apiKey.create({
    data: {
      userId: user.id, createdByUserId: user.id, workspaceId: workspace.id, name: "ci",
      prefix: secret.slice(0, 11), hashedSecret: createHash("sha256").update(secret).digest("hex"),
      scopes: ["projects:read"],
    },
  });
  const grant = await prisma.standingGrant.create({
    data: {
      workspaceId: workspace.id, kind: "review_send", dailyCap: 1, weeklyCap: 1,
      expiresAt: new Date(Date.now() + 86_400_000), ruleFingerprint: "fingerprint", grantedByUserId: user.id,
    },
  });
  return { profile, user, workspace, secret, key, grant };
}

type Account = Awaited<ReturnType<typeof provision>>;

async function expectClosed(account: Account) {
  const { user, workspace, secret, key, grant } = account;
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(row.deletedAt).not.toBeNull();
  expect(row.primaryEmail).toBeNull();
  expect(await prisma.clerkDeletedIdentity.count({ where: { clerkId: user.clerkId } })).toBe(1);
  expect(await prisma.authIdentity.count({ where: { userId: user.id } })).toBe(0);
  expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt).not.toBeNull();
  expect((await prisma.standingGrant.findUniqueOrThrow({ where: { id: grant.id } })).status).toBe("revoked");

  // REST authenticates with this call; the MCP verifier wraps the same one.
  expect(await workspaceService.authenticateApiKey(secret)).toBeNull();
  // Even if the key were somehow restored, admission refuses the deleted user.
  await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: null } });
  expect(await workspaceService.authenticateApiKey(secret)).toBeNull();
  await expect(workspaceService.requireActor(user.id, workspace.id)).rejects.toThrow();
  const verifier = createNarriflowTokenVerifier({
    resourceUrl: () => "https://api.example.test/mcp",
    secretKey: () => "inert",
    authenticateApiKey: (token: string) => workspaceService.authenticateApiKey(token),
    findUser: async () => null,
  });
  await expect(verifier.verifyAccessToken(secret)).rejects.toThrow();
}

beforeAll(async () => {
  if (!enabled) return;
  if (!url || !schema || !schema.startsWith("authenticated_request_policy_test_")) throw new Error("Disposable authentication schema required");
  pool = new Pool({ connectionString: url, max: 8 });
  prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
  await prisma.brandTemplate.upsert({ where: { builtInKey: "karaoke" }, create: { name: "Karaoke", builtInKey: "karaoke", isBuiltIn: true, captionPreset: {} }, update: {} });
});
afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
  await pool.end();
});

dbDescribe("Clerk deletion is terminal", () => {
  test("a live account works, then deletion closes its keys, grants and admission", async () => {
    const account = await provision();
    const principal = await workspaceService.authenticateApiKey(account.secret);
    expect(principal?.userId).toBe(account.user.id);
    await workspaceService.requireActor(account.user.id, account.workspace.id);
    await auth.markUserDeletedByClerkId(account.user.clerkId);
    await expectClosed(account);
  });

  test("a delayed older user.updated or user.created after user.deleted is refused", async () => {
    const account = await provision();
    await auth.markUserDeletedByClerkId(account.user.clerkId);
    for (const stale of [{ ...account.profile, updated_at: Date.now() - 86_400_000 }, account.profile]) {
      await expect(auth.syncClerkUserPayload(stale, directory)).rejects.toBeInstanceOf(auth.ClerkIdentityDeletedError);
    }
    await expectClosed(account);
  });

  test("a deletion that arrives before the first provisioning keeps the identity from ever being created", async () => {
    const profile = clerkProfile();
    await auth.markUserDeletedByClerkId(profile.id);
    await expect(auth.syncClerkUserPayload(profile, directory)).rejects.toBeInstanceOf(auth.ClerkIdentityDeletedError);
    await expect(auth.getAppUserForClerkIdentity(profile.id, { users: { getUser: async () => profile } } as never)).rejects.toBeInstanceOf(auth.ClerkIdentityDeletedError);
    expect(await prisma.user.count({ where: { clerkId: profile.id } })).toBe(0);
    expect(await prisma.clerkDeletedIdentity.count({ where: { clerkId: profile.id } })).toBe(1);
  });

  test("concurrent deletes and updates in any interleaving end deleted, never revived", async () => {
    for (let round = 0; round < 6; round++) {
      const account = await provision();
      const sync = () => auth.syncClerkUserPayload(account.profile, directory).catch((error: unknown) => {
        if (!(error instanceof auth.ClerkIdentityDeletedError)) throw error;
      });
      const events = [sync(), sync(), auth.markUserDeletedByClerkId(account.user.clerkId), sync(), sync(), auth.markUserDeletedByClerkId(account.user.clerkId)];
      await Promise.all(events);
      await expectClosed(account);
    }
  });

  test("concurrent delete and first provisioning of an unknown identity leaves no live user", async () => {
    for (let round = 0; round < 6; round++) {
      const profile = clerkProfile();
      const sync = () => auth.syncClerkUserPayload(profile, directory).catch((error: unknown) => {
        if (!(error instanceof auth.ClerkIdentityDeletedError)) throw error;
      });
      await Promise.all([sync(), auth.markUserDeletedByClerkId(profile.id), sync()]);
      expect(await prisma.user.count({ where: { clerkId: profile.id, deletedAt: null } })).toBe(0);
      expect(await prisma.clerkDeletedIdentity.count({ where: { clerkId: profile.id } })).toBe(1);
    }
  });

  test("a delivery claim is exclusive, replayable after success and retaken after failure", async () => {
    const input = { provider: "clerk" as const, eventId: `msg_${randomUUID()}`, eventType: "email.created" };
    const claims = await Promise.all([auth.claimWebhookDelivery(input), auth.claimWebhookDelivery(input), auth.claimWebhookDelivery(input)]);
    expect(claims.filter((claim) => claim === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim === "in_progress")).toHaveLength(2);
    await auth.recordWebhookDeliveryLog({ ...input, status: "failed" });
    expect(await auth.claimWebhookDelivery(input)).toBe("claimed");
    await auth.recordWebhookDeliveryLog({ ...input, status: "success" });
    expect(await auth.claimWebhookDelivery(input)).toBe("replay");
    await prisma.webhookDeliveryLog.update({
      where: { provider_eventId: { provider: input.provider, eventId: input.eventId } },
      data: { status: "processing", processedAt: new Date(Date.now() - 10 * 60_000) },
    });
    expect(await auth.claimWebhookDelivery(input)).toBe("claimed");
  });
});
