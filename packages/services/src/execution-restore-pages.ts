import { Prisma } from "@prisma/client";
import type { ExecutionRestorePhaseHandler } from "./execution-restore";

/** Historical owners remain audit facts. Epoch, status and revocation remove
 * every old permission before any domain is requeued under the new epoch. */
export const revokeRestoredAttemptsPage: ExecutionRestorePhaseHandler = async (tx, page) => {
  const after = page.after ? Prisma.sql`AND ("createdAt", "attemptToken") > ((${page.after.at}::timestamptz AT TIME ZONE 'UTC'), ${page.after.id}::uuid)` : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ id: string; at: Date }>>`SELECT "attemptToken" AS id, "createdAt" AS at FROM "ExecutionAttempt"
    WHERE "deploymentEpoch" < ${page.deploymentEpoch} AND status IN ('admitted','running') AND "createdAt" <= (${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after}
    ORDER BY "createdAt", "attemptToken" LIMIT ${page.limit + 1}`;
  const selected = rows.slice(0, page.limit), tokens = selected.map(row => row.id).sort();
  if (tokens.length) {
    await tx.$queryRaw(Prisma.sql`SELECT "attemptToken" FROM "ExecutionAttempt" WHERE "attemptToken" IN (${Prisma.join(tokens.map(id => Prisma.sql`${id}::uuid`))}) ORDER BY "attemptToken" FOR UPDATE`);
    await tx.$executeRaw`UPDATE "ExecutionAttempt" SET status = 'superseded', "failureCode" = 'execution_epoch_restored',
      "revokedAt" = clock_timestamp() AT TIME ZONE 'UTC', "finishedAt" = clock_timestamp() AT TIME ZONE 'UTC', "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE "attemptToken" = ANY(${tokens}::uuid[]) AND "deploymentEpoch" < ${page.deploymentEpoch} AND status IN ('admitted','running')`;
  }
  return { processed: selected.length, next: rows.length > page.limit ? selected.at(-1)! : null };
};
