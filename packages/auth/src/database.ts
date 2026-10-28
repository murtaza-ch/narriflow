import { getPrismaClient } from "@narriflow/db/client";

export function getRequiredPrisma() {
  const prisma = getPrismaClient();

  if (!prisma) {
    throw new Error("DATABASE_URL must be configured for authentication features");
  }

  return prisma;
}

/** Prisma P2002: a unique constraint lost a race. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
