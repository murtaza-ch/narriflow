import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";

type NarriflowPrismaClient = NonNullable<ReturnType<typeof getPrismaClient>>;

export async function withSerializableTransaction<T>(
  prisma: NarriflowPrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
      if (!retryable || attempt === 2) throw error;
    }
  }
  throw lastError;
}
