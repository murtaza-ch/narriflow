import { getPrismaClient } from "@narriflow/db/client";

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) {
    throw new Error("Database client unavailable");
  }
  return prisma;
}

/** Deletes webhook delivery logs older than the retention window. Returns count. */
export async function purgeOldWebhookDeliveryLogs(
  olderThanDays = 30,
): Promise<number> {
  const prisma = requirePrisma();
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const res = await prisma.webhookDeliveryLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return res.count;
}
