import { getPrismaClient } from "@narriflow/db/client";
import { ProcessingUsage } from "./processing-usage";

/** Production Processing Usage bound to the current database client. */
export function getProcessingUsage(): ProcessingUsage {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return new ProcessingUsage({ prisma });
}
