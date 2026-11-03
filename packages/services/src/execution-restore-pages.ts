import { Prisma } from "@prisma/client";
import type { ExecutionRestorePhaseHandler, ExecutionRestorePage } from "./execution-restore";

/** Domain restore ports only run under the source pair already admitted by
 * rs2. This guard cannot open intake or invent a new restore epoch. */
export async function assertExecutionRestorePage(tx: Prisma.TransactionClient, page: ExecutionRestorePage) {
  const [state] = await tx.$queryRaw<Array<{ epoch: number; admissionOpen: boolean; changedAt: Date }>>`SELECT epoch,"admissionOpen","changedAt" FROM "ExecutionEpoch" WHERE id=1 FOR SHARE`;
  if (!state || state.admissionOpen || state.epoch !== page.deploymentEpoch || page.snapshotEpoch !== page.fenceAboveEpoch || page.deploymentEpoch !== page.snapshotEpoch + 1 || state.changedAt.getTime() !== page.cutoff.getTime()) throw new Error("restore_page_proof_invalid");
}

/** Historical owners remain audit facts. Epoch, status and revocation remove
 * every old permission before any domain is requeued under the new epoch. */
export const revokeRestoredAttemptsPage: ExecutionRestorePhaseHandler = async (tx, page) => {
  await assertExecutionRestorePage(tx,page);
  const after = page.after ? Prisma.sql`AND ("createdAt", "attemptToken") > ((${page.after.at}::timestamp), ${page.after.id}::uuid)` : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ id: string; at: Date }>>`SELECT "attemptToken" AS id, "createdAt" AS at FROM "ExecutionAttempt"
    WHERE "deploymentEpoch" < ${page.deploymentEpoch} AND status IN ('admitted','running') AND "createdAt" <= (${page.cutoff}::timestamp) ${after}
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

export async function lockRestoreMetadataPlans(tx:Prisma.TransactionClient,epoch:number){await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`restore-metadata-plan:${epoch}`},0)) IS NULL AS locked`;}
export async function readRestoreMetadataBarrier(tx:Prisma.TransactionClient,epoch:number,cutoff:Date){return tx.executionDispatch.findFirst({where:{deploymentEpoch:epoch,generation:1,kind:"maintenance",subjectKind:"maintenance",subjectId:`rs2.${epoch-1}.${epoch-1}.${epoch}.${cutoff.getTime()}.redispatch`,wakeKind:null,deadlineKind:null},select:{createdAt:true,id:true}});}
