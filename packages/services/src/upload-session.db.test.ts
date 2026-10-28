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
import { buildGenerationContentPack } from "@narriflow/validators";
import { encodeOperationId } from "./operation-status";
import { recipeService } from "./recipe.service";
import { listWorkspaceEvents } from "./workspace-event";
import { createMediaCleanupWorker, defaultMediaCleanupConfig, prismaMediaCleanupStore } from "./media-cleanup";
import {
  createUploadSessionModule,
  defaultUploadSessionConfig,
  UploadSessionIdempotencyConflictError,
  UploadSessionInvalidStateError,
  prismaUploadSessionPersistence,
  UploadSessionReconciliationClaimLostError,
  uploadSessionService,
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

  test.each([
    ["single", "finalize"],
    ["multipart", "finalize"],
    ["single", "discard"],
    ["multipart", "discard"],
  ] as const)("a recovered %s upload can %s after its reconciler's lease expires", async (transferKind, action) => {
    const user = await prisma.user.create({ data: { clerkId: `upload-recovery:${randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { name: "Recovered upload", ownerUserId: user.id } });
    try {
    const now = new Date();
    const session = await prisma.uploadSession.create({ data: {
      workspaceId: workspace.id,
      actorUserId: user.id,
      clientIdempotencyKey: randomUUID(),
      immutableInputFingerprint: "recovered-admission",
      preallocatedProjectId: randomUUID(),
      title: "Recovered admission",
      fileName: "recovered.mp4",
      fileSizeBytes: 2048n,
      contentType: "video/mp4",
      browserFingerprint: "recovered-admission",
      generationSettings: { languageCode: "en", contentPack: CONTENT_PACK },
      transferKind,
      partCount: 1,
      storageKey: `tests/${randomUUID()}.mp4`,
      status: "initiating",
      admissionClaimExpiresAt: new Date(now.getTime() - 1),
      expiresAt: new Date(now.getTime() + 60_000),
      hardExpiresAt: new Date(now.getTime() + 120_000),
    } });
    const reconciliationAttemptId = randomUUID();
    expect((await prismaUploadSessionPersistence.claimReconciliation({
      sessionId: session.id, reconciliationAttemptId,
      leaseExpiresAt: new Date(now.getTime() + 30_000), updatedAt: now,
    })).claimed).toBe(true);
    const admissionAttemptId = randomUUID();
    expect((await prismaUploadSessionPersistence.claimAdmission({
      sessionId: session.id, admissionAttemptId,
      claimExpiresAt: new Date(now.getTime() + 30_000), updatedAt: now,
    })).claimed).toBe(true);
    if (transferKind === "single") {
      await prismaUploadSessionPersistence.markSingleReady({ sessionId: session.id, admissionAttemptId, updatedAt: now });
    } else {
      await prismaUploadSessionPersistence.bindMultipartProvider({ sessionId: session.id, admissionAttemptId, providerUploadId: "recovered-provider", updatedAt: now });
    }
    // Recovery dies after binding, before releaseReconciliation. A live
    // recovery still owns cleanup, but its expired claim must not block intake.
    const proceed = (updatedAt: Date) => action === "finalize"
      ? prismaUploadSessionPersistence.beginFinalization({ sessionId: session.id, parts: [], reconcileAt: updatedAt, updatedAt })
      : prismaUploadSessionPersistence.beginDiscard({ sessionId: session.id, reconciliationAttemptId: randomUUID(), leaseExpiresAt: new Date(updatedAt.getTime() + 30_000), updatedAt });
    expect((await proceed(now)).claimed).toBe(false);
    const resumedAt = new Date(now.getTime() + 30_001);
    const resumed = await proceed(resumedAt);
    expect(resumed.claimed).toBe(true);
    expect(resumed.session.status).toBe(action === "finalize" ? "finalizing" : "compensating");
    expect(resumed.session.reconciliationAttemptId).not.toBe(reconciliationAttemptId);
    await expect(prismaUploadSessionPersistence.renewReconciliationClaim({
      sessionId: session.id, reconciliationAttemptId,
      leaseExpiresAt: new Date(resumedAt.getTime() + 30_000), updatedAt: resumedAt,
    })).rejects.toBeInstanceOf(UploadSessionReconciliationClaimLostError);
    } finally {
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("same-key concurrent opens replay the admitted session at the Workspace capacity limit", async () => {
    const user = await prisma.user.create({ data: { clerkId: `upload-capacity-race:${randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { name: "Last upload slot", ownerUserId: user.id, pricingTier: "free" } });
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const persistence = { ...prismaUploadSessionPersistence, async findByClientKey(input: { workspaceId: string; clientIdempotencyKey: string }) {
      const existing = await prismaUploadSessionPersistence.findByClientKey(input);
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
      return existing;
    } };
    const module = createUploadSessionModule({ config: defaultUploadSessionConfig(), persistence,
      storage: { async grantSinglePut() { return { url: "https://upload.invalid/direct" }; }, async headExactObjectIfExists() { return null; } } as unknown as UploadSessionStorage,
      admission: { async resolveBrand() { return null; } }, now: () => new Date(), createId: randomUUID,
    });
    const input = { actorUserId: user.id, workspaceId: workspace.id, clientIdempotencyKey: randomUUID(), title: "One slot",
      source: { fileName: "one.mp4", sizeBytes: 2048, contentType: "video/mp4", browserFingerprint: "same-file" }, brandTemplateId: null, generation: { languageCode: "en", contentPack: CONTENT_PACK } };
    try {
      const results = await Promise.allSettled([module.open(input), module.open(input)]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const ids = results.flatMap((result) => result.status === "fulfilled" ? [result.value.sessionId] : []);
      expect(new Set(ids).size).toBe(1);
      expect(await prisma.uploadSession.count({ where: { workspaceId: workspace.id } })).toBe(1);
      expect(await prisma.processingUsageReservation.count({ where: { workspaceId: workspace.id } })).toBe(1);
    } finally {
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("durable handoff survives removal of the non-owner creator", async () => {
    const owner = await prisma.user.create({ data: { clerkId: `upload-owner:${randomUUID()}` } });
    const creator = await prisma.user.create({ data: { clerkId: `upload-creator:${randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { name: "Surviving upload", ownerUserId: owner.id, pricingTier: "business", members: { create: [{ userId: owner.id, role: "owner" }, { userId: creator.id, role: "editor" }] } } });
    const now = new Date();
    const session = await prisma.uploadSession.create({ data: {
      workspaceId: workspace.id, actorUserId: creator.id, clientIdempotencyKey: randomUUID(),
      immutableInputFingerprint: "removed-creator", preallocatedProjectId: randomUUID(), title: "Preserved intake",
      fileName: "preserved.mp4", fileSizeBytes: 2048n, contentType: "video/mp4", browserFingerprint: "removed-creator",
      generationSettings: { languageCode: "en", contentPack: CONTENT_PACK }, transferKind: "single", storageKey: `workspaces/${workspace.id}/preserved.mp4`,
      status: "finalizing", expiresAt: new Date(now.getTime() + 60_000), hardExpiresAt: new Date(now.getTime() + 120_000),
    } });
    await prisma.user.delete({ where: { id: creator.id } });
    const jobId = randomUUID();
    const result = await prismaUploadSessionPersistence.handoff({ sessionId: session.id, queuedJobId: jobId, verifiedSizeBytes: 2048, verifiedContentType: "video/mp4", reconciliationAttemptId: null, updatedAt: now });
    expect(result.status).toBe("queued_for_ingest");
    expect(await prisma.project.findUnique({ where: { id: session.preallocatedProjectId } })).toMatchObject({ workspaceId: workspace.id, createdByUserId: null, ingestStatus: "queued" });
    expect(await prisma.ingestJob.findUnique({ where: { id: jobId } })).toMatchObject({ projectId: session.preallocatedProjectId, status: "queued" });
    expect(await prismaUploadSessionPersistence.handoff({ sessionId: session.id, queuedJobId: randomUUID(), verifiedSizeBytes: 2048, verifiedContentType: "video/mp4", reconciliationAttemptId: null, updatedAt: now })).toMatchObject({ queuedJobId: jobId });
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
        // Many sessions share this workspace; each unknown-duration open
        // reserves the per-video cap.
        pricingTier: "business",
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

    const deferredSessionId = randomUUID();
    await prisma.uploadSession.create({
      data: {
        id: deferredSessionId,
        workspaceId: workspace.id,
        actorUserId: user.id,
        clientIdempotencyKey: randomUUID(),
        immutableInputFingerprint: "compensation-deferral",
        preallocatedProjectId: randomUUID(),
        title: "Compensation deferral",
        fileName: "deferral.mp4",
        fileSizeBytes: 2_048n,
        contentType: "video/mp4",
        browserFingerprint: "compensation-deferral",
        generationSettings: { languageCode: "en", contentPack: CONTENT_PACK },
        transferKind: "single",
        partCount: 1,
        storageKey: `workspaces/${workspace.id}/upload-sessions/${deferredSessionId}/deferral.mp4`,
        completionParts: { version: 1, parts: [] },
        status: "reconciling",
        reconcileAt: new Date(leaseNow.getTime() - 1_000),
        expiresAt: new Date(leaseNow.getTime() + 60_000),
        hardExpiresAt: new Date(leaseNow.getTime() + 120_000),
      },
    });
    const deferralAttemptId = randomUUID();
    await prismaUploadSessionPersistence.claimReconciliation({
      sessionId: deferredSessionId,
      reconciliationAttemptId: deferralAttemptId,
      leaseExpiresAt: new Date(leaseNow.getTime() + 30_000),
      updatedAt: leaseNow,
    });
    await prismaUploadSessionPersistence.beginCompensation({
      sessionId: deferredSessionId,
      reconciliationAttemptId: deferralAttemptId,
      failureCode: "upload_session_expired",
      updatedAt: leaseNow,
    });
    await expect(
      prismaUploadSessionPersistence.deferReconciliation({
        sessionId: deferredSessionId,
        reconciliationAttemptId: randomUUID(),
        failureCode: "upload_reconciliation_deferred",
        reconcileAt: new Date(leaseNow.getTime() + 5_000),
        updatedAt: leaseNow,
      }),
    ).rejects.toBeInstanceOf(UploadSessionReconciliationClaimLostError);
    await prismaUploadSessionPersistence.deferReconciliation({
      sessionId: deferredSessionId,
      reconciliationAttemptId: deferralAttemptId,
      failureCode: "upload_reconciliation_deferred",
      reconcileAt: new Date(leaseNow.getTime() + 5_000),
      updatedAt: leaseNow,
    });
    expect(
      await prisma.uploadSession.findUniqueOrThrow({
        where: { id: deferredSessionId },
        select: { status: true, failureCode: true, reconciliationAttemptId: true },
      }),
    ).toEqual({
      status: "compensating",
      failureCode: "upload_session_expired",
      reconciliationAttemptId: null,
    });

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
        // Unknown-length uploads each hold a full per-video cap of credits;
        // Business has room for every session this test opens.
        pricingTier: "business",
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

  test("an Upload Session that ends before its import emits one intake event, whichever way it ends", async () => {
    const owner = await prisma.user.create({ data: { clerkId: `upload-events:${randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { name: "Upload events", ownerUserId: owner.id, pricingTier: "business", members: { create: { userId: owner.id, role: "owner" } } } });
    const now = new Date();
    const session = async (status: "compensating" | "finalizing") => {
      const attemptId = randomUUID();
      const row = await prisma.uploadSession.create({ data: {
        workspaceId: workspace.id, actorUserId: owner.id, clientIdempotencyKey: randomUUID(), immutableInputFingerprint: `events-${randomUUID()}`,
        preallocatedProjectId: randomUUID(), title: "Ends early", fileName: "early.mp4", fileSizeBytes: 2048n, contentType: "video/mp4",
        browserFingerprint: "events", generationSettings: { languageCode: "en", contentPack: CONTENT_PACK }, transferKind: "single",
        storageKey: `workspaces/${workspace.id}/${randomUUID()}.mp4`, status, failureCode: status === "compensating" ? "upload_session_expired" : null,
        reconciliationAttemptId: status === "compensating" ? attemptId : null, expiresAt: new Date(now.getTime() + 60_000), hardExpiresAt: new Date(now.getTime() + 120_000),
      } });
      return { row, attemptId };
    };
    const intake = (id: string, state: string) => ({ operation: { kind: "intake", id: encodeOperationId({ kind: "intake", id }) }, projectId: null, state });
    const feed = async () => (await listWorkspaceEvents(prisma, { workspaceId: workspace.id }, { limit: 200 })).data.map((event) => event.subject);

    const expired = await session("compensating");
    await prismaUploadSessionPersistence.settleTerminal({ sessionId: expired.row.id, reconciliationAttemptId: expired.attemptId, status: "expired", failureCode: "upload_session_expired", updatedAt: now });
    const aborted = await session("compensating");
    await prismaUploadSessionPersistence.settleTerminal({ sessionId: aborted.row.id, reconciliationAttemptId: aborted.attemptId, status: "aborted", failureCode: "user_discarded", updatedAt: now });
    const unverified = await session("finalizing");
    await prismaUploadSessionPersistence.recordFailure({ sessionId: unverified.row.id, status: "failed", failureCode: "upload_size_mismatch", updatedAt: now });
    expect(await feed()).toEqual([intake(expired.row.id, "failed"), intake(aborted.row.id, "cancelled"), intake(unverified.row.id, "failed")]);

    // Compensating is not the end, and a lost-claim replay of a settled session writes nothing.
    const compensating = await session("finalizing");
    await prismaUploadSessionPersistence.recordFailure({ sessionId: compensating.row.id, status: "compensating", failureCode: "upload_size_mismatch", updatedAt: now });
    await expect(prismaUploadSessionPersistence.settleTerminal({ sessionId: expired.row.id, reconciliationAttemptId: expired.attemptId, status: "expired", failureCode: "upload_session_expired", updatedAt: now }))
      .rejects.toBeInstanceOf(UploadSessionReconciliationClaimLostError);
    expect(await feed()).toHaveLength(3);
  });

  test.each(["aborted", "expired", "failed"] as const)("a %s single upload retains delayed cleanup for bytes written by a still-valid grant", async (status) => {
    const user = await prisma.user.create({ data: { clerkId: `upload-late-put:${randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { name: "Late PUT", ownerUserId: user.id } });
    const at = new Date();
    let clock = at;
    const key = `late-put/${randomUUID()}.mp4`;
    const reconciliationAttemptId = randomUUID();
    const session = await prisma.uploadSession.create({ data: {
      workspaceId: workspace.id, actorUserId: user.id, clientIdempotencyKey: randomUUID(), immutableInputFingerprint: "late-put",
      preallocatedProjectId: randomUUID(), title: "Late PUT", fileName: "late.mp4", fileSizeBytes: 2048n, contentType: "video/mp4",
      browserFingerprint: "late-put", generationSettings: {}, transferKind: "single", storageKey: key,
      status: status === "failed" ? "finalizing" : "compensating",
      reconciliationAttemptId: status === "failed" ? null : reconciliationAttemptId,
      expiresAt: new Date(at.getTime() + 60_000), hardExpiresAt: new Date(at.getTime() + 120_000),
    } });
    try {
      if (status === "failed") {
        await prismaUploadSessionPersistence.recordFailure({ sessionId: session.id, status, failureCode: "upload_size_mismatch", updatedAt: at });
      } else {
        await prismaUploadSessionPersistence.settleTerminal({ sessionId: session.id, reconciliationAttemptId, status, failureCode: status === "aborted" ? "user_discarded" : "upload_session_expired", updatedAt: at });
      }
      const obligations = await prisma.mediaCleanupObligation.findMany({ where: { objectKey: key } });
      expect(obligations).toHaveLength(1);
      const obligation = obligations[0]!;
      expect(obligation.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(at.getTime() + 60 * 60_000);
      // Terminal cleanup deleted an empty key; a PUT already in flight then
      // recreates it. The durable obligation survives deleting its session.
      const stored = new Set([key]);
      await prisma.uploadSession.delete({ where: { id: session.id } });
      const worker = createMediaCleanupWorker({
        store: prismaMediaCleanupStore,
        storage: { async deleteExact(objectKey) { stored.delete(objectKey); } },
        config: defaultMediaCleanupConfig(),
        now: () => clock,
      });
      await worker.processDue();
      expect(stored.has(key)).toBe(true);
      clock = obligation.nextAttemptAt;
      await worker.processDue();
      expect(stored.has(key)).toBe(false);
      expect((await prisma.mediaCleanupObligation.findUniqueOrThrow({ where: { id: obligation.id } })).completedAt).not.toBeNull();
    } finally {
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("single-PUT cleanup retains its exact key when transfer finishes after the old 70-minute window", async () => {
    const user = await prisma.user.create({ data: { clerkId: `upload-very-late:${randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { name: "In-flight PUT", ownerUserId: user.id } });
    const at = new Date();
    let clock = at;
    const key = `late-single-put/${randomUUID()}.mp4`;
    const session = await prisma.uploadSession.create({ data: {
      workspaceId: workspace.id, actorUserId: user.id, clientIdempotencyKey: randomUUID(), immutableInputFingerprint: "very-late-put",
      preallocatedProjectId: randomUUID(), title: "In-flight PUT", fileName: "large.mp4", fileSizeBytes: 5_363_466_240n, contentType: "video/mp4",
      browserFingerprint: "very-late-put", generationSettings: {}, transferKind: "single", storageKey: key, status: "finalizing",
      expiresAt: new Date(at.getTime() + 60_000), hardExpiresAt: new Date(at.getTime() + 120_000),
    } });
    try {
      await prismaUploadSessionPersistence.recordFailure({ sessionId: session.id, status: "failed", failureCode: "upload_size_mismatch", updatedAt: at });
      await prisma.uploadSession.delete({ where: { id: session.id } });
      const stored = new Set<string>();
      const worker = createMediaCleanupWorker({ store: prismaMediaCleanupStore, storage: { async deleteExact(objectKey) { stored.delete(objectKey); } }, config: defaultMediaCleanupConfig(), now: () => clock });
      // The former one-shot cleanup succeeds on a missing object here.
      clock = new Date(at.getTime() + 70 * 60_000);
      await worker.processDue();
      // A request accepted before grant expiry finishes two hours later.
      clock = new Date(at.getTime() + 2 * 60 * 60_000);
      stored.add(key);
      await worker.processDue();
      clock = new Date(at.getTime() + 24 * 60 * 60_000);
      await worker.processDue();
      expect(stored.has(key)).toBe(false);
      expect(await prisma.mediaCleanupObligation.findFirstOrThrow({ where: { objectKey: key } })).toMatchObject({ completedAt: expect.any(Date) });
    } finally {
      await prisma.workspace.delete({ where: { id: workspace.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("an upload opened with a Recipe replays after the Recipe is edited, keeps the revision it froze, and a new key sees the edit", async () => {
    const user = await prisma.user.create({ data: { clerkId: `upload-recipe-${randomUUID()}` } });
    const workspace = await prisma.workspace.create({ data: { name: "Upload Recipe", ownerUserId: user.id, pricingTier: "business", members: { create: { userId: user.id, role: "owner" } } } });
    const scope = { actorUserId: user.id, workspaceId: workspace.id };
    const recipe = await recipeService.create(scope, { name: "Uploads", brandProfileId: null, contentPack: buildGenerationContentPack({ clipCountTarget: 10 }) });
    const storage = {
      async grantSinglePut() { return { url: "https://upload.invalid/direct" }; },
      async headExactObjectIfExists() { return null; },
      async deleteExactObject() {},
    } as unknown as UploadSessionStorage;
    const module = createUploadSessionModule({
      config: defaultUploadSessionConfig(),
      persistence: prismaUploadSessionPersistence,
      storage,
      admission: { async resolveBrand() { return null; } },
      now: () => new Date(),
      createId: randomUUID,
    });
    const recipeUse = { id: recipe.id, resolve: () => recipeService.resolve(scope, recipe.id) };
    const open = (clientIdempotencyKey: string) => module.open({
      actorUserId: user.id,
      workspaceId: workspace.id,
      clientIdempotencyKey,
      title: "From a Recipe",
      source: { fileName: "recipe.mp4", sizeBytes: 2_048, contentType: "video/mp4", browserFingerprint: '["recipe.mp4",2048,"video/mp4",1]' },
      brandTemplateId: null,
      brandProfileId: null,
      generation: null,
      recipe: recipeUse,
    });
    const stored = async (sessionId: string) => (await prisma.uploadSession.findUniqueOrThrow({ where: { id: sessionId } })).generationSettings as {
      contentPack: { clipCountTarget: number };
      recipe: { id: string; revision: number };
    };

    const key = randomUUID();
    const first = await open(key);
    expect(await stored(first.sessionId)).toMatchObject({ contentPack: { clipCountTarget: 10 }, recipe: { id: recipe.id, revision: 1 } });

    await recipeService.update(scope, recipe.id, { expectedRevision: 1, contentPack: buildGenerationContentPack({ clipCountTarget: 4 }) });
    const retry = await open(key);
    expect(retry.sessionId).toBe(first.sessionId);
    expect(await stored(first.sessionId)).toMatchObject({ contentPack: { clipCountTarget: 10 }, recipe: { id: recipe.id, revision: 1 } });
    expect(await prisma.uploadSession.count({ where: { workspaceId: workspace.id } })).toBe(1);

    const fresh = await open(randomUUID());
    expect(fresh.sessionId).not.toBe(first.sessionId);
    expect(await stored(fresh.sessionId)).toMatchObject({ contentPack: { clipCountTarget: 4 }, recipe: { id: recipe.id, revision: 2 } });
  });
  test("a handoff past its expiry can find the caller's own session by key, and nobody else's", async () => {
    const owner = await prisma.user.create({ data: { clerkId: `upload-lookup-${randomUUID()}` } });
    const other = await prisma.user.create({ data: { clerkId: `upload-lookup-other-${randomUUID()}` } });
    const workspace = await prisma.workspace.create({
      data: {
        name: "Upload Lookup",
        ownerUserId: owner.id,
        pricingTier: "business",
        members: { create: [{ userId: owner.id, role: "owner" }, { userId: other.id, role: "editor" }] },
      },
    });
    const storage = {
      async grantSinglePut() { return { url: "https://upload.invalid/direct" }; },
      async headExactObjectIfExists() { return null; },
      async deleteExactObject() {},
    } as unknown as UploadSessionStorage;
    const module = createUploadSessionModule({
      config: defaultUploadSessionConfig(),
      persistence: prismaUploadSessionPersistence,
      storage,
      admission: { async resolveBrand() { return null; } },
      now: () => new Date(),
      createId: randomUUID,
    });
    const key = randomUUID();
    await module.open({
      actorUserId: owner.id,
      workspaceId: workspace.id,
      clientIdempotencyKey: key,
      title: "Lookup",
      source: { fileName: "lookup.mp4", sizeBytes: 2_048, contentType: "video/mp4", browserFingerprint: '["lookup.mp4",2048,"video/mp4",1]' },
      brandTemplateId: null,
      brandProfileId: null,
      generation: null,
    });
    const ownerScope = { actorUserId: owner.id, workspaceId: workspace.id } as never;
    const otherScope = { actorUserId: other.id, workspaceId: workspace.id } as never;

    expect(await uploadSessionService.hasOwnSessionByClientKey(ownerScope, key)).toBe(true);
    expect(await uploadSessionService.hasOwnSessionByClientKey(ownerScope, randomUUID())).toBe(false);
    expect(await uploadSessionService.hasOwnSessionByClientKey(otherScope, key)).toBe(false);
  });
});
