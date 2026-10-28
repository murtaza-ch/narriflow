import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { PrismaClient } from "@prisma/client";
import {
  clipPersistenceDbTestEnabled,
  createClipPersistenceFixture,
  openClipPersistenceTestDatabase,
} from "./clip-persistence-db-test-support";
import { ClipService } from "./clip.service";
import { createClipsCommands } from "./clips-commands";
import { OperationIdempotencyConflictError } from "./operation-receipt";
import { prismaOperationReceiptPersistence } from "./operation-receipt-runtime";

const dbDescribe = clipPersistenceDbTestEnabled ? describe : describe.skip;

setDefaultTimeout(180_000);

dbDescribe("Clip creation receipts on PostgreSQL", () => {
  let prisma: PrismaClient;
  let testDatabase: Awaited<ReturnType<typeof openClipPersistenceTestDatabase>>;

  beforeAll(async () => {
    testDatabase = await openClipPersistenceTestDatabase();
    prisma = testDatabase.prisma;
  });

  afterAll(async () => {
    await testDatabase?.close();
  });

  function harness() {
    const copies: string[] = [];
    const service = new ClipService({
      clipDuplicationStorageAdapter: {
        async copy(input) {
          copies.push(input.destinationKey);
        },
      },
    });
    const commands = createClipsCommands({
      persistence: prismaOperationReceiptPersistence(prisma),
      clips: service,
      requireEditor: async () => undefined,
    });
    return { commands, copies };
  }

  test("a duplicate and its receipt commit together, and a retry copies nothing", async () => {
    const fixture = await createClipPersistenceFixture(prisma);
    const actor = { actorUserId: fixture.user.id, workspaceId: fixture.workspace.id };
    const { commands, copies } = harness();

    const first = await commands.duplicateClip(actor, fixture.project.id, fixture.clip.id, {
      clientIdempotencyKey: "duplicate-1",
    });
    const copiesAfterFirst = copies.length;
    const retry = await commands.duplicateClip(actor, fixture.project.id, fixture.clip.id, {
      clientIdempotencyKey: "duplicate-1",
    });

    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.clip.id).toBe(first.clip.id);
    expect(copies).toHaveLength(copiesAfterFirst);
    expect(await prisma.clip.count({ where: { projectId: fixture.project.id } })).toBe(2);
    const receipt = await prisma.operationReceipt.findFirstOrThrow({
      where: { workspaceId: fixture.workspace.id, command: "duplicate_clip" },
    });
    expect(receipt.resourceType).toBe("clip");
    expect(receipt.resourceId).toBe(first.clip.id);
    await expect(
      commands.duplicateClip(actor, fixture.project.id, "00000000-0000-4000-8000-000000000009", {
        clientIdempotencyKey: "duplicate-1",
      }),
    ).rejects.toBeInstanceOf(OperationIdempotencyConflictError);
  });

  test("simultaneous requests with one key create a single clip and release the loser's copies", async () => {
    const fixture = await createClipPersistenceFixture(prisma);
    const actor = { actorUserId: fixture.user.id, workspaceId: fixture.workspace.id };
    const { commands } = harness();

    const outcomes = await Promise.all([
      commands.duplicateClip(actor, fixture.project.id, fixture.clip.id, { clientIdempotencyKey: "race-1" }),
      commands.duplicateClip(actor, fixture.project.id, fixture.clip.id, { clientIdempotencyKey: "race-1" }),
    ]);

    expect(outcomes[0].clip.id).toBe(outcomes[1].clip.id);
    expect(await prisma.clip.count({ where: { projectId: fixture.project.id } })).toBe(2);
    expect(await prisma.operationReceipt.count({ where: { workspaceId: fixture.workspace.id } })).toBe(1);
    // Every copy is either adopted by the accepted clip or released for cleanup.
    expect(
      await prisma.mediaCleanupObligation.count({
        where: { origin: "clip_duplicate_compensation", completedAt: null, claimId: { not: null } },
      }),
    ).toBe(0);
  });

  test("a refused limiter creates neither a clip nor a receipt, before any copy", async () => {
    const fixture = await createClipPersistenceFixture(prisma);
    const actor = { actorUserId: fixture.user.id, workspaceId: fixture.workspace.id };
    const { commands, copies } = harness();

    await expect(
      commands.duplicateClip(actor, fixture.project.id, fixture.clip.id, {
        clientIdempotencyKey: "limited-1",
        beforeAccept: async () => {
          throw new Error("rate_limited");
        },
      }),
    ).rejects.toThrow("rate_limited");

    expect(copies).toHaveLength(0);
    expect(await prisma.clip.count({ where: { projectId: fixture.project.id } })).toBe(1);
    expect(await prisma.operationReceipt.count({ where: { workspaceId: fixture.workspace.id } })).toBe(0);
  });
});
