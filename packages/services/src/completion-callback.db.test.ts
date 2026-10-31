import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { contentPackSchema, PLATFORM_PLAYBOOK_VERSION } from "@narriflow/validators";
import {
  callbackEventId,
  createCallbackCipher,
  createCallbackSigningSecrets,
  prepareCallbackRegistration,
} from "./completion-callback";
import { prismaUploadSessionPersistence } from "./upload-session.service";
import { projectService } from "./project.service";

const databaseUrl = process.env.INTEGRATION_TEST_DATABASE_URL;
const schema = process.env.INTEGRATION_TEST_DATABASE_SCHEMA;
const enabled = process.env.ALLOW_INTEGRATION_DB_TESTS === "1" && Boolean(databaseUrl);
const describeDb = enabled ? describe : describe.skip;
setDefaultTimeout(180_000);
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY ??= "completion-callback-test-key-not-a-secret";

const _publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const pack = contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 5, clipDurationSecTarget: 30, platformPlaybookVersion: PLATFORM_PLAYBOOK_VERSION });

describeDb("Completion Callback PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const globalPrisma = createDatabaseTestContext();
  let actorUserId: string;
  let workspaceId: string;
  const clock = new Date(Math.ceil(Date.now() / 1000) * 1000 + 1000);
  const now = () => clock;
  const cipher = createCallbackCipher(process.env.SOCIAL_TOKEN_ENCRYPTION_KEY);
  const scope = () => ({ actorUserId, workspaceId });
  const secrets = () => createCallbackSigningSecrets({ prisma, cipher, now });
  beforeAll(bindServiceTestEnvironment(globalPrisma.bind(async () => {
    if (!databaseUrl || !schema || !/^integration_test_[a-z0-9_]+$/.test(schema)) throw new Error("Integration DB tests require a disposable integration_test_ schema");
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }), transactionOptions: { maxWait: 120_000, timeout: 120_000 } });
    priorPrisma = globalPrisma.client;
    globalPrisma.client = prisma;
    const actor = await prisma.user.create({ data: { clerkId: `callback-test:${randomUUID()}` } });
    actorUserId = actor.id;
    const workspace = await prisma.workspace.create({ data: { name: "Callbacks", ownerUserId: actor.id, pricingTier: "business", members: { create: { userId: actor.id, role: "owner" } } } });
    workspaceId = workspace.id;
  })));

  afterAll(bindServiceTestEnvironment(globalPrisma.bind(async () => {
    globalPrisma.client = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  })));

  const link = (key: string, url: string) => projectService.queueLinkIngest(scope(), { title: `Callback ${key}`, url: "https://www.dropbox.com/s/callback-source/video.mp4" },
    { generationContext: { contentPack: pack, languageCode: "en" }, mutation: { clientIdempotencyKey: key, callback: { url: new URL(url) } } });

  test("a callback request refuses before any work commits when the Workspace has no signing secret", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const key = randomUUID();
    await expect(link(key, "https://hooks.example/a")).rejects.toMatchObject({ code: "callback_secret_required" });
    expect(await prisma.project.count({ where: { title: `Callback ${key}` } })).toBe(0);
    expect(await prisma.operationReceipt.count({ where: { clientIdempotencyKey: key } })).toBe(0);
  })));

  let _linkIntake: { receiptId: string; projectId: string; jobId: string };
  let _currentSecret: string;

  test("acceptance registers exactly one callback per receipt, including on replay", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    _currentSecret = (await secrets().rotate(workspaceId)).secret;
    const key = randomUUID();
    const first = await link(key, "https://hooks.example/a");
    const replay = await link(key, "https://hooks.example/a");
    expect(replay.replayed).toBe(true);
    const receipt = await prisma.operationReceipt.findFirstOrThrow({ where: { clientIdempotencyKey: key } });
    const rows = await prisma.completionCallback.findMany({ where: { receiptId: receipt.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "waiting", operationKind: "intake", operationId: first.queuedJobId, urlHost: "hooks.example", eventId: callbackEventId(receipt.id) });
    expect(rows[0]!.encryptedUrl).not.toContain("hooks.example");
    await expect(link(key, "https://hooks.example/b")).rejects.toMatchObject({ code: "operation_idempotency_conflict" });
    _linkIntake = { receiptId: receipt.id, projectId: first.project.id, jobId: first.queuedJobId! };
  })));

  test("an upload callback without a signing secret leaves the session uploading", bindServiceTestEnvironment(globalPrisma.bind(async () => {
    const other = await prisma.workspace.create({ data: { name: "No secret", ownerUserId: actorUserId, pricingTier: "business" } });
    const sessionId = randomUUID();
    await prisma.uploadSession.create({ data: { id: sessionId, workspaceId: other.id, actorUserId, clientIdempotencyKey: randomUUID(), immutableInputFingerprint: "fixture",
      preallocatedProjectId: randomUUID(), title: "Upload", fileName: "upload.mp4", fileSizeBytes: 10n, contentType: "video/mp4", browserFingerprint: "fixture",
      generationSettings: {}, transferKind: "single", storageKey: `uploads/${sessionId}.mp4`, status: "uploading",
      expiresAt: new Date(Date.now() + 3_600_000), hardExpiresAt: new Date(Date.now() + 7_200_000) } });
    await expect(prismaUploadSessionPersistence.beginFinalization({ sessionId, parts: [], reconcileAt: new Date(), updatedAt: new Date(),
      callback: prepareCallbackRegistration(new URL("https://hooks.example/upload"), cipher) })).rejects.toMatchObject({ code: "callback_secret_required" });
    expect((await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("uploading");
  })));


});
