import type { Prisma, PrismaClient } from "@prisma/client";
import type { MediaCleanupAdmissionStore, MediaCleanupObligationInput, MediaCleanupAdmissionOptions } from "./media-cleanup-contract";
import { queueMediaCleanupRangeWithinTransaction } from "./media-cleanup-drain";

export async function admitMediaCleanupObligations(
  store: MediaCleanupAdmissionStore | Prisma.TransactionClient,
  obligations: readonly MediaCleanupObligationInput[],
  options: MediaCleanupAdmissionOptions = {},
): Promise<number> {
  const unique = [
    ...new Map(
      obligations.map((obligation) => [
        `${obligation.origin}\u0000${obligation.cleanupClass}\u0000${obligation.objectKey}`,
        obligation,
      ]),
    ).values(),
  ];
  if (unique.length === 0) return 0;
  const target = "mediaCleanupObligation" in store ? store.mediaCleanupObligation : store;
  const result = await target.createMany({
    data: unique.map((obligation) => ({
      origin: obligation.origin,
      cleanupClass: obligation.cleanupClass,
      projectId: obligation.projectId ?? null,
      clipId: obligation.clipId ?? null,
      objectKey: obligation.objectKey,
      ...(obligation.notBefore ? { nextAttemptAt: obligation.notBefore } : {}),
      ...(options.heldClaim ?? {}),
    })),
    skipDuplicates: true,
  });
  if ("mediaCleanupObligation" in store) {
    const rows = await store.mediaCleanupObligation.findMany({ where: { OR: unique.map(row => ({ origin: row.origin, cleanupClass: row.cleanupClass, objectKey: row.objectKey })) }, select: { id: true } });
    await queueMediaCleanupRangeWithinTransaction(store, rows.map(row => row.id));
  }
  return result.count;
}

/** Adapter for producers that plan storage I/O outside their later domain
 * publication transaction. The intent and its range wake still commit together. */
export function createScheduledMediaCleanupAdmissionStore(database: PrismaClient): MediaCleanupAdmissionStore {
  return { async createMany(input) {
    return database.$transaction(async tx => {
      const result = await tx.mediaCleanupObligation.createMany(input);
      const rows = await tx.mediaCleanupObligation.findMany({ where: { OR: input.data.map(row => ({ origin: row.origin, cleanupClass: row.cleanupClass, objectKey: row.objectKey })) }, select: { id: true } });
      await queueMediaCleanupRangeWithinTransaction(tx, rows.map(row => row.id));
      return result;
    });
  } };
}
