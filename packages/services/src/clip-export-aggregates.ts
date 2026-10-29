import type { Prisma } from "@prisma/client";
import { deriveClipExportAggregate } from "./clip-export-aggregate";
import { queueExportFinished } from "./operation-finished";

/** The caller flushes Workspace Events last, in the same transaction. */
export async function syncClipExportAggregate(tx: Prisma.TransactionClient, exportId: string): Promise<ReturnType<typeof deriveClipExportAggregate>> {
  // Serialize sibling aggregates after child writes. Bulk callers lock in ID order.
  await tx.$queryRaw`SELECT "id" FROM "ClipExport" WHERE "id" = ${exportId}::uuid FOR UPDATE`;
  const variants = await tx.clipExportVariant.findMany({
    where: { exportId },
    select: { status: true, errorCode: true },
  });
  const aggregate = deriveClipExportAggregate(variants.map((variant) => variant.status));
  await tx.clipExport.update({
    where: { id: exportId },
    data: {
      status: aggregate.status,
      progress: aggregate.progress,
      errorCode: aggregate.status === "failed" ? variants.find((variant) => variant.errorCode)?.errorCode ?? null : null,
      completedAt: aggregate.terminal ? new Date() : null,
    },
  });
  if (aggregate.terminal) await queueExportFinished(tx, exportId);
  return aggregate;
}

/** Recompute every export affected by a variant mutation, inside its transaction. */
export async function syncClipExportAggregates(tx: Prisma.TransactionClient, exportVariantIds: string[]): Promise<void> {
  if (exportVariantIds.length === 0) return;
  const owners = await tx.clipExportVariant.findMany({
    where: { id: { in: exportVariantIds } },
    select: { exportId: true },
    distinct: ["exportId"],
    orderBy: { exportId: "asc" },
  });
  for (const { exportId } of owners) await syncClipExportAggregate(tx, exportId);
}
