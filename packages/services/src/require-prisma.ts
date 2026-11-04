import { getPrismaClient } from "@narriflow/db/client";

/** The invocation's database client, for code that cannot run without it. */
export function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}
