import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import {
  createUploadSessionModule,
  defaultUploadSessionConfig,
  UploadSessionIdempotencyConflictError,
  UploadSessionInvalidStateError,
  prismaUploadSessionPersistence,
  UploadSessionReconciliationClaimLostError,
  type UploadSessionStorage,
} from "./upload-session.service";

const databaseUrl = process.env.UPLOAD_SESSION_TEST_DATABASE_URL;
const databaseSchema = process.env.UPLOAD_SESSION_TEST_DATABASE_SCHEMA;
const enabled =
  process.env.ALLOW_UPLOAD_SESSION_DB_TESTS === "1" && Boolean(databaseUrl);
const dbDescribe = enabled ? describe : describe.skip;

setDefaultTimeout(180_000);

function assertSafeDatabase(url: string) {
  const parsed = new URL(url);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const namedTestDatabase = parsed.pathname.toLowerCase().includes("test");
  const isolatedSchema = databaseSchema?.startsWith("upload_session_test_");
  if (!local && !namedTestDatabase && !isolatedSchema) {
    throw new Error("Upload Session DB tests require an isolated test database");
  }
}

const CONTENT_PACK = {
  outputTypes: ["short_clip"],
  clipGenerationMode: "best",
  clipCountTarget: 10,
  clipDurationSecTarget: 45,
  minDurationSec: 15,
  preferredMinDurationSec: 30,
  preferredMaxDurationSec: 60,
  maxDurationSec: 90,
  platformTargets: ["tiktok", "youtube_shorts", "instagram_reels"],
  autoRenderClips: false,
  toneConstraints: ["concise", "conversational"],
  captionPreset: "brand_default",
  platformPlaybookVersion: "2026-07-01",
  mode: "clip",
  autoHook: true,
  specificMoments: "",
  processingStartSec: null,
  processingEndSec: null,
  clipLengthPreset: "auto",
  defaultAspectRatio: "9:16",
};

dbDescribe("Upload Session PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let priorPrisma: PrismaClient | undefined;
  const prismaGlobal = globalThis as unknown as {
    narriflowPrismaClient?: PrismaClient;
  };

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("UPLOAD_SESSION_TEST_DATABASE_URL is required");
    assertSafeDatabase(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    prisma = new PrismaClient({
      adapter: new PrismaPg(
        pool,
        databaseSchema ? { schema: databaseSchema } : undefined,
      ),
      transactionOptions: { maxWait: 120_000, timeout: 120_000 },
    });
    priorPrisma = prismaGlobal.narriflowPrismaClient;
    prismaGlobal.narriflowPrismaClient = prisma;
  });

  afterAll(async () => {
    prismaGlobal.narriflowPrismaClient = priorPrisma;
    await prisma?.$disconnect();
    await pool?.end();
  });

  test("concurrent open and finalize produce one session and one atomic handoff", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        clerkId: `upload-session-db-test:${suffix}`,
        primaryEmail: `upload-${suffix}@example.test`,
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: "Upload Session DB test",
        ownerUserId: user.id,
        personalOwnerUserId: user.id,
      },
    });
    const object = { sizeBytes: 2_048, contentType: "video/mp4" };
    let objectUploaded = false;
    const storage: UploadSessionStorage = {
      async grantSinglePut() {
        return { url: "https://upload.invalid/direct" };
      },
      async createMultipart() {
        throw new Error("multipart must not be used");
      },
      async grantMultipartParts() {
        throw new Error("multipart must not be used");
      },
      async completeMultipart() {
        throw new Error("multipart must not be used");
      },
      async listMultipartParts() {
        throw new Error("multipart must not be used");
      },
      async headExactObject() {
        return object;
      },
      async headExactObjectIfExists() {
        return objectUploaded ? object : null;
      },
      async listExactKeyMultipartUploads() {
        throw new Error("multipart must not be used");
      },
      async abortMultipart() {
        throw new Error("multipart must not be used");
      },
      async deleteExactObject() {},
    };
    const module = createUploadSessionModule({
      config: defaultUploadSessionConfig(),
      persistence: prismaUploadSessionPersistence,
      storage,
      admission: {
        async assertQuota() {},
        async resolveBrand() {
          return null;
        },
      },
      now: () => new Date(),
      createId: randomUUID,
    });
    const input = {
      actorUserId: user.id,
      workspaceId: workspace.id,
      legacyOwnerUserId: user.id,
      clientIdempotencyKey: randomUUID(),
      title: "Exactly once",
      source: {
        fileName: "exactly-once.mp4",
        sizeBytes: object.sizeBytes,
        contentType: object.contentType,
        browserFingerprint: '["exactly-once.mp4",2048,"video/mp4",1]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    };

    const [firstOpen, secondOpen] = await Promise.all([
      module.open(input),
      module.open(input),
    ]);
    expect(secondOpen.sessionId).toBe(firstOpen.sessionId);
    expect(
      await prisma.uploadSession.count({
        where: {
          workspaceId: workspace.id,
          clientIdempotencyKey: input.clientIdempotencyKey,
        },
      }),
    ).toBe(1);

    const recoverySessionId = randomUUID();
    const recoveryNow = new Date();
    await prisma.uploadSession.create({
      data: {
        id: recoverySessionId,
        workspaceId: workspace.id,
        actorUserId: user.id,
        legacyOwnerUserId: user.id,
        clientIdempotencyKey: randomUUID(),
        immutableInputFingerprint: "expired-recovery",
        preallocatedProjectId: randomUUID(),
        title: "Expired recovery",
        fileName: "expired.mp4",
        fileSizeBytes: 2_048n,
        contentType: "video/mp4",
        browserFingerprint: "expired-recovery",
        generationSettings: { languageCode: "en", contentPack: CONTENT_PACK },
        transferKind: "multipart",
        partSizeBytes: 16 * 1024 * 1024,
        partCount: 2,
        storageKey: `workspaces/${workspace.id}/upload-sessions/${recoverySessionId}/expired.mp4`,
        admissionAttemptId: randomUUID(),
        admissionClaimExpiresAt: new Date(recoveryNow.getTime() - 1_000),
        expiresAt: new Date(recoveryNow.getTime() + 60_000),
        hardExpiresAt: new Date(recoveryNow.getTime() + 120_000),
      },
    });
    const recoveryAttempts = [randomUUID(), randomUUID()];
    const recoveryClaims = await Promise.all(
      recoveryAttempts.map((admissionAttemptId) =>
        prismaUploadSessionPersistence.claimAdmission({
          sessionId: recoverySessionId,
          admissionAttemptId,
          claimExpiresAt: new Date(recoveryNow.getTime() + 30_000),
          updatedAt: recoveryNow,
        }),
      ),
    );
    expect(recoveryClaims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(
      recoveryAttempts.includes(
        (await prisma.uploadSession.findUniqueOrThrow({
          where: { id: recoverySessionId },
          select: { admissionAttemptId: true },
        })).admissionAttemptId!,
      ),
    ).toBe(true);

    const finalizeInput = {
      actorUserId: user.id,
      workspaceId: workspace.id,
      sessionId: firstOpen.sessionId,
      parts: [],
    };
    objectUploaded = true;
    const [firstFinalize, secondFinalize] = await Promise.all([
      module.finalize(finalizeInput),
      module.finalize(finalizeInput),
    ]);

    expect([firstFinalize.outcome, secondFinalize.outcome]).toContain(
      "queued_for_ingest",
    );
    expect(
      [firstFinalize.outcome, secondFinalize.outcome].every((outcome) =>
        ["queued_for_ingest", "reconciling"].includes(outcome),
      ),
    ).toBe(true);
    const replay = await module.finalize(finalizeInput);
    expect(replay.outcome).toBe("queued_for_ingest");
    expect(
      await prisma.project.count({
        where: { id: firstOpen.projectId, workspaceId: workspace.id },
      }),
    ).toBe(1);
    expect(
      await prisma.contentPack.count({ where: { projectId: firstOpen.projectId } }),
    ).toBe(1);
    expect(
      await prisma.ingestJob.count({
        where: { uploadSessionId: firstOpen.sessionId },
      }),
    ).toBe(1);
    expect(
      await prisma.workflowEvent.count({
        where: { projectId: firstOpen.projectId, seq: 1 },
      }),
    ).toBe(1);

    objectUploaded = false;
    const rollbackOpen = await module.open({
      ...input,
      clientIdempotencyKey: randomUUID(),
      title: "Rollback replay",
      source: {
        ...input.source,
        fileName: "rollback-replay.mp4",
        browserFingerprint: '["rollback-replay.mp4",2048,"video/mp4",2]',
      },
    });
    await prisma.project.create({
      data: {
        id: rollbackOpen.projectId,
        userId: user.id,
        workspaceId: workspace.id,
        title: "Conflicting transaction fixture",
        sourceMediaUrl: "r2://test/conflict",
        sourceInput: "conflict.mp4",
      },
    });
    objectUploaded = true;
    const ambiguousHandoff = await module.finalize({
      actorUserId: user.id,
      workspaceId: workspace.id,
      sessionId: rollbackOpen.sessionId,
      parts: [],
    });
    expect(ambiguousHandoff.outcome).toBe("reconciling");
    expect(
      await prisma.contentPack.count({
        where: { projectId: rollbackOpen.projectId },
      }),
    ).toBe(0);
    expect(
      await prisma.ingestJob.count({
        where: { uploadSessionId: rollbackOpen.sessionId },
      }),
    ).toBe(0);
    await prisma.project.delete({ where: { id: rollbackOpen.projectId } });
    await prisma.uploadSession.update({
      where: { id: rollbackOpen.sessionId },
      data: { reconcileAt: new Date(Date.now() - 1_000) },
    });

    const recoveredHandoff = await module.reconcileDueSessions();

    expect(recoveredHandoff).toEqual({ claimed: 1, settled: 1, deferred: 0 });
    expect(
      await prisma.contentPack.count({
        where: { projectId: rollbackOpen.projectId },
      }),
    ).toBe(1);
    expect(
      await prisma.ingestJob.count({
        where: { uploadSessionId: rollbackOpen.sessionId },
      }),
    ).toBe(1);

    const midTransactionInput = {
      ...input,
      clientIdempotencyKey: randomUUID(),
      title: "Mid-transaction takeover",
      source: {
        ...input.source,
        fileName: "mid-transaction.mp4",
        browserFingerprint: '["mid-transaction.mp4",2048,"video/mp4",2]',
      },
    };
    const midTransactionOpen = await module.open(midTransactionInput);
    objectUploaded = true;
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION upload_session_handoff_delay()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(8675309);
        PERFORM pg_sleep(1);
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER upload_session_handoff_delay_trigger
      BEFORE INSERT ON "ContentPack"
      FOR EACH ROW EXECUTE FUNCTION upload_session_handoff_delay()
    `);
    try {
      const staleFinalize = module.finalize({
        actorUserId: user.id,
        workspaceId: workspace.id,
        sessionId: midTransactionOpen.sessionId,
        parts: [],
      });
      let triggerEntered = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const probe = await pool.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(8675309) AS acquired",
        );
        if (!probe.rows[0]?.acquired) {
          triggerEntered = true;
          break;
        }
        await pool.query("SELECT pg_advisory_unlock(8675309)");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(triggerEntered).toBe(true);
      const takeoverAttemptId = randomUUID();
      await prisma.uploadSession.update({
        where: { id: midTransactionOpen.sessionId },
        data: {
          status: "reconciling",
          reconciliationAttemptId: takeoverAttemptId,
          reconciliationLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await expect(staleFinalize).resolves.toMatchObject({
        outcome: "reconciling",
      });
      expect(
        await prisma.project.count({
          where: { id: midTransactionOpen.projectId },
        }),
      ).toBe(0);
      expect(
        await prisma.ingestJob.count({
          where: { uploadSessionId: midTransactionOpen.sessionId },
        }),
      ).toBe(0);
      expect(
        await prisma.uploadSession.findUniqueOrThrow({
          where: { id: midTransactionOpen.sessionId },
          select: { status: true, reconciliationAttemptId: true },
        }),
      ).toEqual({
        status: "reconciling",
        reconciliationAttemptId: takeoverAttemptId,
      });
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS upload_session_handoff_delay_trigger ON "ContentPack"',
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS upload_session_handoff_delay()",
      );
    }

    const backoffSessionId = randomUUID();
    const backoffNow = new Date();
    const backoffDueAt = new Date(backoffNow.getTime() + 60_000);
    await prisma.uploadSession.create({
      data: {
        id: backoffSessionId,
        workspaceId: workspace.id,
        actorUserId: user.id,
        legacyOwnerUserId: user.id,
        clientIdempotencyKey: randomUUID(),
        immutableInputFingerprint: "initiating-backoff",
        preallocatedProjectId: randomUUID(),
        title: "Initiating backoff",
        fileName: "initiating.mp4",
        fileSizeBytes: 2_048n,
        contentType: "video/mp4",
        browserFingerprint: "initiating-backoff",
        generationSettings: { languageCode: "en", contentPack: CONTENT_PACK },
        transferKind: "multipart",
        partSizeBytes: 16 * 1024 * 1024,
        partCount: 1,
        storageKey: `workspaces/${workspace.id}/upload-sessions/${backoffSessionId}/initiating.mp4`,
        status: "initiating",
        admissionClaimExpiresAt: new Date(backoffNow.getTime() - 1_000),
        reconcileAt: backoffDueAt,
        expiresAt: new Date(backoffNow.getTime() + 120_000),
        hardExpiresAt: new Date(backoffNow.getTime() + 180_000),
      },
    });
    expect(
      (
        await prismaUploadSessionPersistence.findDueReconciliation({
          now: backoffNow,
          limit: 25,
        })
      ).some((session) => session.id === backoffSessionId),
    ).toBe(false);
    expect(
      (
        await prismaUploadSessionPersistence.claimReconciliation({
          sessionId: backoffSessionId,
          reconciliationAttemptId: randomUUID(),
          leaseExpiresAt: new Date(backoffNow.getTime() + 30_000),
          updatedAt: backoffNow,
        })
      ).claimed,
    ).toBe(false);
    const backoffClaim = await prismaUploadSessionPersistence.claimReconciliation({
      sessionId: backoffSessionId,
      reconciliationAttemptId: randomUUID(),
      leaseExpiresAt: new Date(backoffDueAt.getTime() + 30_000),
      updatedAt: backoffDueAt,
    });
    expect(backoffClaim.claimed).toBe(true);

    const leaseSessionId = randomUUID();
    const leaseNow = new Date();
    await prisma.uploadSession.create({
      data: {
        id: leaseSessionId,
        workspaceId: workspace.id,
        actorUserId: user.id,
        legacyOwnerUserId: user.id,
        clientIdempotencyKey: randomUUID(),
        immutableInputFingerprint: "reconciliation-lease",
        preallocatedProjectId: randomUUID(),
        title: "Reconciliation lease",
        fileName: "lease.mp4",
        fileSizeBytes: 2_048n,
        contentType: "video/mp4",
        browserFingerprint: "reconciliation-lease",
        generationSettings: { languageCode: "en", contentPack: CONTENT_PACK },
        transferKind: "single",
        partCount: 1,
        storageKey: `workspaces/${workspace.id}/upload-sessions/${leaseSessionId}/lease.mp4`,
        completionParts: { version: 1, parts: [] },
        status: "reconciling",
        reconcileAt: new Date(leaseNow.getTime() - 1_000),
        expiresAt: new Date(leaseNow.getTime() + 60_000),
        hardExpiresAt: new Date(leaseNow.getTime() + 120_000),
      },
    });
    const firstAttemptId = randomUUID();
    const takeoverAttemptId = randomUUID();
    const firstClaim = await prismaUploadSessionPersistence.claimReconciliation({
      sessionId: leaseSessionId,
      reconciliationAttemptId: firstAttemptId,
      leaseExpiresAt: new Date(leaseNow.getTime() + 30_000),
      updatedAt: leaseNow,
    });
    const blockedClaim = await prismaUploadSessionPersistence.claimReconciliation({
      sessionId: leaseSessionId,
      reconciliationAttemptId: randomUUID(),
      leaseExpiresAt: new Date(leaseNow.getTime() + 30_000),
      updatedAt: leaseNow,
    });
    const takeoverAt = new Date(leaseNow.getTime() + 30_001);
    const takeover = await prismaUploadSessionPersistence.claimReconciliation({
      sessionId: leaseSessionId,
      reconciliationAttemptId: takeoverAttemptId,
      leaseExpiresAt: new Date(takeoverAt.getTime() + 30_000),
      updatedAt: takeoverAt,
    });

    expect(firstClaim.claimed).toBe(true);
    expect(blockedClaim.claimed).toBe(false);
    expect(takeover.claimed).toBe(true);
    await prismaUploadSessionPersistence.beginCompensation({
      sessionId: leaseSessionId,
      reconciliationAttemptId: takeoverAttemptId,
      failureCode: "takeover_settlement",
      updatedAt: takeoverAt,
    });
    await expect(
      prismaUploadSessionPersistence.settleTerminal({
        sessionId: leaseSessionId,
        reconciliationAttemptId: firstAttemptId,
        status: "failed",
        failureCode: "stale_writer",
        updatedAt: takeoverAt,
      }),
    ).rejects.toBeInstanceOf(UploadSessionReconciliationClaimLostError);
    await prismaUploadSessionPersistence.settleTerminal({
      sessionId: leaseSessionId,
      reconciliationAttemptId: takeoverAttemptId,
      status: "failed",
      failureCode: "takeover_settlement",
      updatedAt: takeoverAt,
    });
    expect(
      await prisma.uploadSession.findUniqueOrThrow({
        where: { id: leaseSessionId },
        select: { status: true, failureCode: true },
      }),
    ).toEqual({ status: "failed", failureCode: "takeover_settlement" });

    const fairnessNow = new Date(Date.now() + 5 * 60_000);
    await prisma.uploadSession.updateMany({
      where: {
        workspaceId: workspace.id,
        status: {
          in: [
            "initiating",
            "uploading",
            "finalizing",
            "reconciling",
            "compensating",
          ],
        },
      },
      data: {
        status: "failed",
        failureCode: "test_fixture_settled",
        reconciliationAttemptId: null,
        reconciliationLeaseExpiresAt: null,
      },
    });
    const fairnessRows = Array.from({ length: 30 }, (_, index) => {
      const id = randomUUID();
      return {
        id,
        workspaceId: workspace.id,
        actorUserId: user.id,
        legacyOwnerUserId: user.id,
        clientIdempotencyKey: randomUUID(),
        immutableInputFingerprint: `batch-fairness-${index}`,
        preallocatedProjectId: randomUUID(),
        title: `Batch fairness ${index}`,
        fileName: `batch-${index}.mp4`,
        fileSizeBytes: 2_048n,
        contentType: "video/mp4",
        browserFingerprint: `batch-fairness-${index}`,
        generationSettings: { languageCode: "en", contentPack: CONTENT_PACK },
        transferKind: "single" as const,
        partCount: 1,
        storageKey: `workspaces/${workspace.id}/upload-sessions/${id}/batch-${index}.mp4`,
        completionParts: { version: 1, parts: [] },
        status: "reconciling" as const,
        reconcileAt: new Date(fairnessNow.getTime() - 1_000),
        expiresAt: new Date(fairnessNow.getTime() + 60_000),
        hardExpiresAt: new Date(fairnessNow.getTime() + 120_000),
      };
    });
    await prisma.uploadSession.createMany({ data: fairnessRows });
    const firstBatch = await prismaUploadSessionPersistence.findDueReconciliation({
      now: fairnessNow,
      limit: 25,
    });
    expect(firstBatch).toHaveLength(25);
    for (const session of firstBatch) {
      expect(
        (
          await prismaUploadSessionPersistence.claimReconciliation({
            sessionId: session.id,
            reconciliationAttemptId: randomUUID(),
            leaseExpiresAt: new Date(fairnessNow.getTime() + 60_000),
            updatedAt: fairnessNow,
          })
        ).claimed,
      ).toBe(true);
    }
    const secondBatch =
      await prismaUploadSessionPersistence.findDueReconciliation({
        now: fairnessNow,
        limit: 25,
      });
    expect(secondBatch).toHaveLength(5);
    expect(
      secondBatch.every(
        (session) => !firstBatch.some((claimed) => claimed.id === session.id),
      ),
    ).toBe(true);
  });

  test("Prisma persists immutable conflicts, lost binds, expiry cleanup, discard fencing, and event replay", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        clerkId: `upload-session-db-recovery:${suffix}`,
        primaryEmail: `upload-recovery-${suffix}@example.test`,
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: "Upload Session DB recovery",
        ownerUserId: user.id,
        personalOwnerUserId: user.id,
      },
    });
    await prisma.uploadSession.updateMany({
      where: {
        status: {
          in: [
            "initiating",
            "uploading",
            "finalizing",
            "reconciling",
            "compensating",
          ],
        },
      },
      data: {
        status: "failed",
        failureCode: "prior_test_fixture_settled",
        admissionAttemptId: null,
        admissionClaimExpiresAt: null,
        reconciliationAttemptId: null,
        reconciliationLeaseExpiresAt: null,
      },
    });
    let now = new Date("2026-08-28T00:00:00.000Z");
    let providerCreations = 0;
    const providerAborts: string[] = [];
    const providerUploads = new Map<
      string,
      Array<{ providerUploadId: string; initiatedAt: Date }>
    >();
    const multipartStorage: UploadSessionStorage = {
      async grantSinglePut() {
        throw new Error("single PUT must not be used");
      },
      async createMultipart({ storageKey }) {
        providerCreations += 1;
        const providerUploadId = `provider-${providerCreations}`;
        providerUploads.set(storageKey, [
          ...(providerUploads.get(storageKey) ?? []),
          { providerUploadId, initiatedAt: now },
        ]);
        return { providerUploadId };
      },
      async grantMultipartParts({ partNumbers }) {
        return partNumbers.map((partNumber) => ({
          partNumber,
          url: `https://upload.invalid/${partNumber}`,
        }));
      },
      async completeMultipart() {},
      async listMultipartParts() {
        return [];
      },
      async headExactObject() {
        throw new Error("multipart object must not be probed in this fixture");
      },
      async headExactObjectIfExists() {
        return null;
      },
      async listExactKeyMultipartUploads(storageKey) {
        return providerUploads.get(storageKey) ?? [];
      },
      async abortMultipart({ storageKey, providerUploadId }) {
        providerAborts.push(providerUploadId);
        providerUploads.set(
          storageKey,
          (providerUploads.get(storageKey) ?? []).filter(
            (candidate) => candidate.providerUploadId !== providerUploadId,
          ),
        );
      },
      async deleteExactObject() {},
    };
    const dependencies = {
      config: defaultUploadSessionConfig({ smallFileThresholdBytes: 1 }),
      persistence: prismaUploadSessionPersistence,
      storage: multipartStorage,
      admission: {
        async assertQuota() {},
        async resolveBrand() {
          return null;
        },
      },
      now: () => now,
      createId: randomUUID,
    };
    const module = createUploadSessionModule(dependencies);
    const immutableInput = {
      actorUserId: user.id,
      workspaceId: workspace.id,
      legacyOwnerUserId: user.id,
      clientIdempotencyKey: randomUUID(),
      title: "Immutable",
      source: {
        fileName: "immutable.mp4",
        sizeBytes: 2_048,
        contentType: "video/mp4",
        browserFingerprint: '["immutable.mp4",2048,"video/mp4",1]',
      },
      brandTemplateId: null,
      generation: { languageCode: "en", contentPack: CONTENT_PACK },
    };
    const immutableOpened = await module.open(immutableInput);
    await expect(
      module.open({ ...immutableInput, title: "Changed immutable title" }),
    ).rejects.toBeInstanceOf(UploadSessionIdempotencyConflictError);
    expect(
      await prisma.uploadSession.count({
        where: { id: immutableOpened.sessionId },
      }),
    ).toBe(1);

    const lostBindInput = {
      ...immutableInput,
      clientIdempotencyKey: randomUUID(),
      title: "Lost provider bind response",
      source: {
        ...immutableInput.source,
        fileName: "lost-bind.mp4",
        browserFingerprint: '["lost-bind.mp4",2048,"video/mp4",2]',
      },
    };
    let loseBindResponse = true;
    const lostBindModule = createUploadSessionModule({
      ...dependencies,
      persistence: {
        ...prismaUploadSessionPersistence,
        async bindMultipartProvider(input) {
          if (loseBindResponse) {
            loseBindResponse = false;
            throw new Error("simulated lost provider bind persistence");
          }
          return prismaUploadSessionPersistence.bindMultipartProvider(input);
        },
      },
    });
    await expect(lostBindModule.open(lostBindInput)).rejects.toThrow(
      "simulated lost provider bind persistence",
    );
    const replayedBind = await module.open(lostBindInput);
    expect(replayedBind.outcome).toBe("uploading");
    expect(providerCreations).toBe(2);
    expect(
      await prisma.uploadSession.findUniqueOrThrow({
        where: { id: replayedBind.sessionId },
        select: { providerUploadId: true },
      }),
    ).toEqual({ providerUploadId: "provider-2" });

    await expect(
      module.discard({
        actorUserId: user.id,
        workspaceId: workspace.id,
        sessionId: replayedBind.sessionId,
      }),
    ).resolves.toEqual({
      outcome: "discarded",
      sessionId: replayedBind.sessionId,
    });
    expect(
      await prisma.uploadSession.findUniqueOrThrow({
        where: { id: replayedBind.sessionId },
        select: { status: true, failureCode: true },
      }),
    ).toEqual({ status: "aborted", failureCode: "user_discarded" });

    const expiringInput = {
      ...immutableInput,
      clientIdempotencyKey: randomUUID(),
      title: "Persisted expiry",
      source: {
        ...immutableInput.source,
        fileName: "persisted-expiry.mp4",
        browserFingerprint: '["persisted-expiry.mp4",2048,"video/mp4",3]',
      },
    };
    const expiring = await module.open(expiringInput);
    now = new Date("2026-08-30T00:00:00.000Z");
    await expect(
      module.status({
        actorUserId: user.id,
        workspaceId: workspace.id,
        clientIdempotencyKey: expiringInput.clientIdempotencyKey,
        sessionId: expiring.sessionId,
        browserFingerprint: expiringInput.source.browserFingerprint,
      }),
    ).resolves.toMatchObject({ outcome: "reconciling" });
    let expiryRecoveryClaimed = 0;
    let expiryRecoverySettled = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const recovery = await module.reconcileDueSessions();
      expiryRecoveryClaimed += recovery.claimed;
      expiryRecoverySettled += recovery.settled;
      const current = await prisma.uploadSession.findUniqueOrThrow({
        where: { id: expiring.sessionId },
        select: { status: true },
      });
      if (current.status === "expired") break;
    }
    expect(expiryRecoveryClaimed).toBeGreaterThanOrEqual(1);
    expect(expiryRecoverySettled).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.uploadSession.findUniqueOrThrow({
        where: { id: expiring.sessionId },
        select: { status: true, failureCode: true },
      }),
    ).toEqual({
      status: "expired",
      failureCode: "upload_session_expired",
    });

    let announceHead!: () => void;
    let releaseHead!: () => void;
    const headStarted = new Promise<void>((resolve) => {
      announceHead = resolve;
    });
    const headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    const directObject = { sizeBytes: 2_048, contentType: "video/mp4" };
    const raceModule = createUploadSessionModule({
      ...dependencies,
      config: defaultUploadSessionConfig(),
      storage: {
        ...multipartStorage,
        async grantSinglePut() {
          return { url: "https://upload.invalid/direct" };
        },
        async headExactObject() {
          announceHead();
          await headGate;
          return directObject;
        },
        async headExactObjectIfExists() {
          return directObject;
        },
      },
    });
    const raceInput = {
      ...immutableInput,
      clientIdempotencyKey: randomUUID(),
      title: "Finalize discard race",
      source: {
        ...immutableInput.source,
        fileName: "finalize-discard-race.mp4",
        browserFingerprint: '["finalize-discard-race.mp4",2048,"video/mp4",4]',
      },
    };
    const racing = await raceModule.open(raceInput);
    const finalization = raceModule.finalize({
      actorUserId: user.id,
      workspaceId: workspace.id,
      sessionId: racing.sessionId,
      parts: [],
    });
    await headStarted;
    await expect(
      raceModule.discard({
        actorUserId: user.id,
        workspaceId: workspace.id,
        sessionId: racing.sessionId,
      }),
    ).rejects.toBeInstanceOf(UploadSessionInvalidStateError);
    releaseHead();
    await expect(finalization).resolves.toMatchObject({
      outcome: "queued_for_ingest",
      projectId: racing.projectId,
    });
    await expect(
      raceModule.finalize({
        actorUserId: user.id,
        workspaceId: workspace.id,
        sessionId: racing.sessionId,
        parts: [],
      }),
    ).resolves.toMatchObject({ outcome: "queued_for_ingest" });
    expect(
      await prisma.workflowEvent.count({
        where: { projectId: racing.projectId, seq: 1 },
      }),
    ).toBe(1);
    expect(
      await prisma.ingestJob.count({
        where: { uploadSessionId: racing.sessionId },
      }),
    ).toBe(1);
    expect(providerAborts).toContain("provider-2");
    expect(providerAborts).toContain("provider-3");
  });
});
