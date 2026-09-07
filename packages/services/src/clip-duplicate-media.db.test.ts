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
import { prismaMediaCleanupStore } from "./media-cleanup";

const dbDescribe = clipPersistenceDbTestEnabled ? describe : describe.skip;

setDefaultTimeout(180_000);

dbDescribe("Clip duplicate media PostgreSQL invariants", () => {
  let prisma: PrismaClient;
  let testDatabase: Awaited<ReturnType<typeof openClipPersistenceTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await openClipPersistenceTestDatabase();
    prisma = testDatabase.prisma;
  });

  afterAll(async () => {
    await testDatabase?.close();
  });

  test("a committed duplicate adopts every successful copy in the same transaction", async () => {
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
      fixture.user.id,
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
  });

  test("partial duplicate copies adopt only successful media and release the rest", async () => {
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
      fixture.user.id,
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
  });

  test("a duplicate with no copyable media commits without compensation work", async () => {
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
      fixture.user.id,
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
  });

  for (const failedCopy of [null, "preview"] as const) {
    test(`persistence failure releases ${failedCopy ?? "all"} copied destinations`, async () => {
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
            fixture.user.id,
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
    });
  }

  test("an interrupted duplicate's expired obligation is reclaimable", async () => {
    const fixture = await createClipPersistenceFixture(prisma);
    await prisma.mediaCleanupObligation.updateMany({
      where: { completedAt: null },
      data: { nextAttemptAt: new Date("2100-01-01T00:00:00.000Z") },
    });
    const interruptedClaimId = randomUUID();
    const recoveryClaimId = randomUUID();
    const obligation = await prisma.mediaCleanupObligation.create({
      data: {
        origin: "clip_duplicate_compensation",
        projectId: fixture.project.id,
        clipId: randomUUID(),
        cleanupClass: "mutable_render",
        objectKey: `projects/${fixture.project.id}/clips/interrupted.mp4`,
        nextAttemptAt: new Date("2000-01-01T00:00:00.000Z"),
        claimId: interruptedClaimId,
        claimExpiresAt: new Date("2026-08-29T00:00:00.000Z"),
      },
    });
    const now = new Date("2026-08-29T00:01:00.000Z");
    const [claim] = await prismaMediaCleanupStore.claimDue({
      now,
      limit: 1,
      leaseMs: 30_000,
      createId: () => recoveryClaimId,
    });

    expect(claim).toMatchObject({
      id: obligation.id,
      claimId: recoveryClaimId,
      objectKey: obligation.objectKey,
    });
    await expect(
      prismaMediaCleanupStore.complete({
        id: obligation.id,
        claimId: recoveryClaimId,
        now,
      }),
    ).resolves.toBe(true);
  });

  test("concurrent duplicate requests never expose winning media to cleanup", async () => {
    const fixture = await createClipPersistenceFixture(prisma);
    const service = new ClipService({
      clipDuplicationStorageAdapter: { copy: async () => undefined },
    });

    const outcomes = await Promise.allSettled([
      service.duplicateClip(
        fixture.user.id,
        fixture.project.id,
        fixture.clip.id,
      ),
      service.duplicateClip(
        fixture.user.id,
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
  });
});
