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
      // Prisma's default interactive-transaction timeout is 5s of wall
      // clock, which is statement time — not held-lock time — and our
      // transactions ship large JSON columns (transcriptSlice/studioEdits)
      // across whatever latency separates the process from Neon. Two live
      // incidents on 2026-08-06 from a high-RTT connection: the editor
      // autosave PUT expired at 10.3s, and the worker's post-render
      // completion bookkeeping expired at 7.5s (which cascaded into a
      // requeued run that then failed permanently on no_renderable_clips).
      // Every mutating transaction in this codebase is either
      // revision-guarded or a conditional update, so a longer window can
      // only fail cleanly — never produce a torn write.
      transactionOptions: {
        timeout: 30_000,
        maxWait: 10_000,
      },
    });
  }

  return globalForPrisma.narriflowPrismaClient;
}
