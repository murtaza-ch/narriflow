import type { Prisma } from "@prisma/client";
import { lockWorkspaceUsage } from "./processing-usage";
export async function lockExecutionRecoveryParents(tx: Prisma.TransactionClient, rows: readonly { workspaceId: string; projectId?: string }[]) {
  for (const id of [...new Set(rows.map(row => row.workspaceId))].sort()) await lockWorkspaceUsage(tx,id);
  for (const id of [...new Set(rows.flatMap(row=>row.projectId?[row.projectId]:[]))].sort()) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id},0)) IS NULL AS locked`;
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id=${id}::uuid FOR UPDATE`;
  }
}
