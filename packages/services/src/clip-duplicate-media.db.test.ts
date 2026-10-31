import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { PrismaClient } from "@prisma/client";
import {
  clipPersistenceDbTestEnabled,
  createClipPersistenceFixture,
  openClipPersistenceTestDatabase,
} from "./clip-persistence-db-test-support";
import { ClipService } from "./clip.service";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createMediaCleanupControl, queueMediaCleanupWithinTransaction } from "./media-cleanup-control";
import { mediaCleanupObjectRetainUntil } from "./media-cleanup-holds";

const dbDescribe = clipPersistenceDbTestEnabled ? describe : describe.skip;

setDefaultTimeout(180_000);

dbDescribe("Clip duplicate media PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  const databaseScope = createDatabaseTestContext();
  let testDatabase: Awaited<ReturnType<typeof openClipPersistenceTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await openClipPersistenceTestDatabase();
    prisma = testDatabase.prisma;
    databaseScope.client = prisma;
  });

  afterAll(async () => {
    await testDatabase?.close();
  });

  test("a committed duplicate adopts every successful copy in the same transaction", bindServiceTestEnvironment(databaseScope.bind(async () => {
    const fixture = await createClipPersistenceFixture(prisma);
    const copied: Array<{ sourceKey: string; destinationKey: string }> = [];
    const service = new ClipService({
      clipDuplicationStorageAdapter: {
        async copy(input) {
          copied.push(input);
        },
      },
    });

    const duplicate = await service.duplicateClip(
      { actorUserId: fixture.user.id, workspaceId: fixture.workspace.id },
      fixture.project.id,
      fixture.clip.id,
    );
    const storedDuplicate = await prisma.clip.findUniqueOrThrow({
      where: { id: duplicate.id },
      include: { renders: true },
    });

    expect(copied).toHaveLength(2);
    expect(storedDuplicate.previewStorageKey).toBe(
      copied.find((item) => item.sourceKey === fixture.clip.previewStorageKey)
        ?.destinationKey,
    );
    expect(storedDuplicate.renders.map((render) => render.storageKey)).toEqual([
      copied.find((item) => item.sourceKey.includes("/renders/current.mp4"))
        ?.destinationKey,
    ]);
    expect(
      await prisma.mediaCleanupObligation.count({
        where: {
          origin: "clip_duplicate_compensation",
          clipId: duplicate.id,
          completedAt: null,
        },
      }),
    ).toBe(0);
    expect(
      await prisma.mediaCleanupObligation.count({
        where: {
          origin: "clip_duplicate_compensation",
          clipId: duplicate.id,
          completedAt: { not: null },
        },
      }),
    ).toBe(2);
  })));

  test("partial duplicate copies adopt only successful media and release the rest", bindServiceTestEnvironment(databaseScope.bind(async () => {
    const fixture = await createClipPersistenceFixture(prisma);
    const service = new ClipService({
      clipDuplicationStorageAdapter: {
        async copy(input) {
          if (input.sourceKey === fixture.clip.previewStorageKey) {
            throw new Error("injected preview copy failure");
          }
        },
      },
    });

    const duplicate = await service.duplicateClip(
      { actorUserId: fixture.user.id, workspaceId: fixture.workspace.id },
      fixture.project.id,
      fixture.clip.id,
    );

    expect(duplicate.hasPreview).toBe(false);
    expect(duplicate.renderVariants).toHaveLength(1);
    expect(
      await prisma.mediaCleanupObligation.findMany({
        where: {
          origin: "clip_duplicate_compensation",
          clipId: duplicate.id,
          completedAt: null,
        },
        select: {
          cleanupClass: true,
          claimId: true,
          completedAt: true,
        },
      }),
    ).toEqual([
      {
        cleanupClass: "preview_proxy",
        claimId: null,
        completedAt: null,
      },
    ]);
  })));

  test("a duplicate with no copyable media commits without compensation work", bindServiceTestEnvironment(databaseScope.bind(async () => {
    const fixture = await createClipPersistenceFixture(prisma);
    await Promise.all([
      prisma.clip.update({
        where: { id: fixture.clip.id },
        data: { previewStorageKey: null },
      }),
      prisma.clipRender.updateMany({
        where: { clipId: fixture.clip.id },
        data: { storageKey: null },
      }),
    ]);
    let copyCalls = 0;
    const service = new ClipService({
      clipDuplicationStorageAdapter: {
        async copy() {
          copyCalls += 1;
        },
      },
    });

    const duplicate = await service.duplicateClip(
      { actorUserId: fixture.user.id, workspaceId: fixture.workspace.id },
      fixture.project.id,
      fixture.clip.id,
    );

    expect(copyCalls).toBe(0);
    expect(duplicate.hasPreview).toBe(false);
    expect(duplicate.renderVariants).toEqual([]);
    expect(
      await prisma.mediaCleanupObligation.count({
        where: {
          origin: "clip_duplicate_compensation",
          clipId: duplicate.id,
        },
      }),
    ).toBe(0);
  })));

  for (const failedCopy of [null, "preview"] as const) {
    test(`persistence failure releases ${failedCopy ?? "all"} copied destinations`, bindServiceTestEnvironment(databaseScope.bind(async () => {
      const fixture = await createClipPersistenceFixture(prisma);
      const copied: string[] = [];
      const attempted: string[] = [];
      const service = new ClipService({
        clipDuplicationStorageAdapter: {
          async copy({ sourceKey, destinationKey }) {
            attempted.push(destinationKey);
            if (
              failedCopy === "preview" &&
              sourceKey === fixture.clip.previewStorageKey
            ) {
              throw new Error("injected preview copy failure");
            }
            copied.push(destinationKey);
          },
        },
      });
      const suffix = randomUUID().replaceAll("-", "");
      const functionName = `duplicate_insert_failure_${suffix}`;
      const triggerName = `duplicate_insert_failure_${suffix}`;
      await testDatabase.pool.query(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'duplicate_insert_failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER "${triggerName}"
        BEFORE INSERT ON "Clip"
        FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
      `);
      try {
        await expect(
          service.duplicateClip(
            { actorUserId: fixture.user.id, workspaceId: fixture.workspace.id },
            fixture.project.id,
            fixture.clip.id,
          ),
        ).rejects.toMatchObject({ code: "clip_duplicate_failed" });
      } finally {
        await testDatabase.pool.query(`
          DROP TRIGGER IF EXISTS "${triggerName}" ON "Clip";
          DROP FUNCTION IF EXISTS "${functionName}"();
        `);
      }

      expect(copied).toHaveLength(failedCopy === "preview" ? 1 : 2);
      expect(
        await prisma.clip.count({ where: { projectId: fixture.project.id } }),
      ).toBe(1);
      expect(
        await prisma.mediaCleanupObligation.findMany({
          where: {
            origin: "clip_duplicate_compensation",
            projectId: fixture.project.id,
          },
          select: { objectKey: true, claimId: true, completedAt: true },
          orderBy: { objectKey: "asc" },
        }),
      ).toEqual(
        [...new Set(attempted)]
          .sort()
          .map((objectKey) => ({ objectKey, claimId: null, completedAt: null })),
      );
    })));
  }

  test("an interrupted duplicate's expired obligation is reclaimed by its exact command", bindServiceTestEnvironment(databaseScope.bind(async () => {
    const fixture = await createClipPersistenceFixture(prisma);
    const interruptedClaimId = randomUUID();
    const obligation = await prisma.mediaCleanupObligation.create({ data: {
      origin: "clip_duplicate_compensation", projectId: fixture.project.id,
      clipId: randomUUID(), cleanupClass: "mutable_render",
      objectKey: `projects/${fixture.project.id}/clips/interrupted.mp4`,
      nextAttemptAt: new Date("2000-01-01T00:00:00.000Z"),
      claimId: interruptedClaimId, claimExpiresAt: new Date(Date.now() - 60_000),
    } });
    const unrelated = await prisma.mediaCleanupObligation.create({ data: {
      origin: "clip_duplicate_compensation", projectId: fixture.project.id,
      clipId: randomUUID(), cleanupClass: "mutable_render",
      objectKey: `projects/${fixture.project.id}/clips/unrelated.mp4`,
      nextAttemptAt: new Date("2000-01-01T00:00:00.000Z"),
    } });
    const reference = await prisma.$transaction(tx => queueMediaCleanupWithinTransaction(tx, obligation.id));
    if (!reference) throw Error("Expected cleanup command");
    const deleted: string[] = [];
    const control = createMediaCleanupControl({ database: prisma, register: async () => {},
      hold: mediaCleanupObjectRetainUntil, storage: { deleteExact: async key => {
        const claimed = await prisma.mediaCleanupObligation.findUniqueOrThrow({ where: { id: obligation.id } });
        expect(claimed.claimId).not.toBe(interruptedClaimId);
        expect(claimed.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now());
        deleted.push(key);
      } },
    });
    expect(await control.run(reference)).toMatchObject({ kind: "complete" });
    expect(await control.run(reference)).toMatchObject({ kind: "complete" });
    expect(deleted).toEqual([obligation.objectKey]);
    expect(await prisma.mediaCleanupObligation.findUniqueOrThrow({ where: { id: obligation.id } })).toMatchObject({ claimId: null, attemptCount: 1, completedAt: expect.any(Date) });
    expect(await prisma.mediaCleanupObligation.findUniqueOrThrow({ where: { id: unrelated.id } })).toMatchObject({ claimId: null, attemptCount: 0, completedAt: null });
  })));

  test("concurrent duplicate requests never expose winning media to cleanup", bindServiceTestEnvironment(databaseScope.bind(async () => {
    const fixture = await createClipPersistenceFixture(prisma);
    const service = new ClipService({
      clipDuplicationStorageAdapter: { copy: async () => undefined },
    });

    const outcomes = await Promise.allSettled([
      service.duplicateClip(
        { actorUserId: fixture.user.id, workspaceId: fixture.workspace.id },
        fixture.project.id,
        fixture.clip.id,
      ),
      service.duplicateClip(
        { actorUserId: fixture.user.id, workspaceId: fixture.workspace.id },
        fixture.project.id,
        fixture.clip.id,
      ),
    ]);
    const winners = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    expect(winners.length).toBeGreaterThanOrEqual(1);

    const winningRows = await prisma.clip.findMany({
      where: { id: { in: winners.map((winner) => winner.id) } },
      select: {
        previewStorageKey: true,
        renders: { select: { storageKey: true } },
      },
    });
    const winningKeys = winningRows
      .flatMap((winner) => [
        winner.previewStorageKey,
        ...winner.renders.map((render) => render.storageKey),
      ])
      .filter((key): key is string => Boolean(key));
    const cleanupKeys = await prisma.mediaCleanupObligation.findMany({
      where: {
        origin: "clip_duplicate_compensation",
        projectId: fixture.project.id,
        completedAt: null,
      },
      select: { objectKey: true },
    });
    expect(cleanupKeys.map((item) => item.objectKey)).not.toContainAnyValues(
      winningKeys,
    );
  })));
});
