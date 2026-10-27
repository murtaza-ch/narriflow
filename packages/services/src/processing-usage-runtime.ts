import { getPrismaClient } from "@narriflow/db/client";
import { ProcessingUsage } from "./processing-usage";

let runtime: { prisma: object; usage: ProcessingUsage } | undefined;
/** Production Processing Usage bound to the current database client. */
export function getProcessingUsage(): ProcessingUsage {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  if (runtime?.prisma !== prisma) {
    runtime = {
      prisma,
      usage: new ProcessingUsage({ prisma }),
    };
  }
  return runtime.usage;
}
