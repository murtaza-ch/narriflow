import type { Prisma, PrismaClient } from "@prisma/client";
import type { MediaCleanupOrigin, MediaCleanupClass } from "./media-cleanup-contract";
import { WorkflowFailure } from "./workflow-attempt-contract";

/** Adoption and a cleanup claim serialize on the planned exact-key row. A
 * destination previously claimed by cleanup can never acquire a new reference,
 * including after an unknown DELETE is rescheduled and its live claim clears. */
export async function lockPlannedExecutionObject(tx: Prisma.TransactionClient, input: { origin: MediaCleanupOrigin; storageKey: string }) {
  return lockPlannedMediaCleanupObject(tx, { ...input, cleanupClass: "execution_input" });
}
export async function lockPlannedMediaCleanupObject(tx: Prisma.TransactionClient, input: { origin: MediaCleanupOrigin; cleanupClass: MediaCleanupClass; storageKey: string }) {
  const [row] = await tx.$queryRaw<Array<{ id: string; claimId: string | null; completedAt: Date | null; attemptCount: number }>>`SELECT id, "claimId", "completedAt", "attemptCount"
    FROM "MediaCleanupObligation" WHERE origin = ${input.origin} AND "cleanupClass" = ${input.cleanupClass} AND "objectKey" = ${input.storageKey} FOR UPDATE`;
  if (!row || row.claimId || row.completedAt || row.attemptCount > 0) throw new WorkflowFailure("execution_object_deletion_admitted", "retryable", "The tentative object is no longer available for adoption");
  return row.id;
}

const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const inputKey = new RegExp(`^projects/(${uuid})/selection/(${uuid})/${uuid}/([a-f0-9]{64})\\.json$`);
const resultKey = new RegExp(`^execution/([1-9][0-9]*)/clip_selection_window/(${uuid})/([1-9][0-9]*)/(?:server|${uuid}/${uuid})/selection_window/${uuid}/([a-f0-9]{64})\\.json$`);
export function isSelectionExecutionObjectKey(key: string) { return inputKey.test(key) || resultKey.test(key); }

/** Both shared inputs and successful sibling results stay held by exact
 * immutable row references, including after the parent has settled. */
export async function selectionExecutionObjectRetainUntil(database: Pick<PrismaClient, "clipSelectionWindow" | "$queryRaw">, objectKey: string): Promise<Date | null> {
  const input = inputKey.exec(objectKey), result = resultKey.exec(objectKey);
  if (!input && !result) throw new Error("Invalid selection cleanup key");
  const row = input ? await database.clipSelectionWindow.findFirst({ where: { projectId: input[1], workflowRunId: input[2], inputStorageKey: objectKey, inputChecksumSha256: input[3] },
    orderBy: { operationDeadlineAt: "desc" }, select: { operationDeadlineAt: true } })
    : await database.clipSelectionWindow.findFirst({ where: { id: result![2], deploymentEpoch: Number(result![1]), generation: Number(result![3]), resultStorageKey: objectKey, resultHash: result![4] },
      select: { operationDeadlineAt: true } });
  if (!row) return null;
  const [clock] = await database.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  if (!clock) throw new Error("Cleanup clock unavailable");
  return new Date(Math.max(clock.now.getTime() + 86_400_000, row.operationDeadlineAt.getTime() + 120_000));
}
