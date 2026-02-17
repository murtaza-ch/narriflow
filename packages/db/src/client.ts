import { PrismaClient } from "@prisma/client";

let prismaClient: PrismaClient | null = null;

export function getPrismaClient() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  if (!prismaClient) {
    prismaClient = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
    });
  }

  return prismaClient;
}
