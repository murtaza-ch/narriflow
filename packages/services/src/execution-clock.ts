import type { Prisma } from "@prisma/client";

/** The database's wall clock, in UTC regardless of the session time zone. */
export async function databaseNow(db: Pick<Prisma.TransactionClient, "$queryRaw">): Promise<Date> {
  const [row] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`;
  if (!row) throw new Error("Database clock unavailable");
  return row.now;
}
