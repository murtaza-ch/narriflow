import { getPrismaClient } from "@narriflow/db/client";
import { deleteExpiredWorkspaceEvents } from "./workspace-event";

/** The worker's retention sweep: one bounded batch per call. */
export async function purgeExpiredWorkspaceEvents(batchSize = 1_000): Promise<number> {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("DATABASE_URL is required for Workspace Event maintenance");
  return deleteExpiredWorkspaceEvents(prisma, new Date(), batchSize);
}
