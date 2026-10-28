import { getPrismaClient } from "@narriflow/db/client";
import { clipService } from "./clip.service";
import { createClipsCommands } from "./clips-commands";
import { prismaOperationReceiptPersistence } from "./operation-receipt-runtime";
import { workspaceService } from "./workspace.service";

function receiptPersistence() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prismaOperationReceiptPersistence(prisma);
}

/** Production wiring of the clips commands. The database client resolves on first use. */
export const clipsCommands = createClipsCommands({
  persistence: {
    read: (identity) => receiptPersistence().read(identity),
    transaction: (run) => receiptPersistence().transaction(run),
    lock: (tx, identity) => receiptPersistence().lock(tx, identity),
    readInTransaction: (tx, identity) => receiptPersistence().readInTransaction(tx, identity),
    create: (tx, receipt) => receiptPersistence().create(tx, receipt),
  },
  clips: clipService,
  requireEditor: (actorUserId, workspaceId) =>
    workspaceService.requireActor(actorUserId, workspaceId, "content.edit"),
});
