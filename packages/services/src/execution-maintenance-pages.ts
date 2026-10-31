import { Prisma } from "@prisma/client";
import type { MaintenancePhaseHandler } from "./execution-maintenance";

/** Task expiry removes only the request-owned handle. The domain's work and
 * settlement history continue independently. */
export const expireMcpTaskPage: MaintenancePhaseHandler = async (tx, page) => {
  const after = page.after ? Prisma.sql`AND ("expiresAt", id) > ((${page.after.at}::timestamptz AT TIME ZONE 'UTC'), ${page.after.id}::uuid)` : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ id: string; at: Date }>>`SELECT id, "expiresAt" AS at FROM "McpTask"
    WHERE "expiresAt" <= (${page.cutoff}::timestamptz AT TIME ZONE 'UTC') ${after}
    ORDER BY "expiresAt", id LIMIT ${page.limit + 1}`;
  const selected = rows.slice(0, page.limit);
  if (selected.length) await tx.mcpTask.deleteMany({ where: { id: { in: selected.map(row => row.id) }, expiresAt: { lte: page.cutoff } } });
  return { processed: selected.length, next: rows.length > page.limit ? selected.at(-1)! : null };
};
