import { withServiceEnvironment } from "../src/runtime-environment";
import { createDatabaseScope, getPrismaClient, withDatabaseScope } from "@narriflow/db/client";
import { ExpectedDomainFailureError } from "../src/expected-domain-failure";
import {
  listOpenSourceRefundNeeds,
  parseProcessingUsageOperatorArgs,
  refundSourceRefundNeed,
} from "../src/processing-usage-operator";
import { getProcessingUsage } from "../src/processing-usage-runtime";

function write(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Database connection is required");
  await withServiceEnvironment(process.env, () => withDatabaseScope(createDatabaseScope({ connectionString }), async () => {
    const input = parseProcessingUsageOperatorArgs(process.argv.slice(2));
    const prisma = getPrismaClient();
    if (!prisma) throw new Error("Database client unavailable");
    if (input.mode === "list") {
      write({ mode: "list", needs: await listOpenSourceRefundNeeds(prisma) });
      return;
    }
    write({
      mode: "refund",
      ...(await refundSourceRefundNeed({ prisma, usage: getProcessingUsage() }, input)),
    });
  }));
} catch (error) {
  write({
    mode: "failed",
    error: error instanceof ExpectedDomainFailureError ? error.code : "operator_command_failed",
  });
  process.exitCode = 1;
}
