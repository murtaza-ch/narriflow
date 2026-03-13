import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  narriflowAdapter?: PrismaNeon;
  narriflowPrismaClient?: PrismaClient;
};

export function getPrismaClient() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  if (!globalForPrisma.narriflowAdapter) {
    globalForPrisma.narriflowAdapter = new PrismaNeon({
      connectionString: process.env.DATABASE_URL,
    });
  }

  if (!globalForPrisma.narriflowPrismaClient) {
    globalForPrisma.narriflowPrismaClient = new PrismaClient({
      adapter: globalForPrisma.narriflowAdapter,
      log: ["error"],
    });
  }

  return globalForPrisma.narriflowPrismaClient;
}
