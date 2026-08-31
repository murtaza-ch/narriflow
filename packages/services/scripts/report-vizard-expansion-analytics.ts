import { getPrismaClient } from "@narriflow/db/client";

import { AnalyticsService } from "../src/analytics.service";

export type CampaignAnalyticsReportArguments = {
  windowStart: Date;
  windowEnd: Date;
  workspaceIds?: string[];
};

function usage(): never {
  process.stderr.write(
    "Usage: bun run report:vizard-analytics -- --from <RFC3339> --to <RFC3339> [--workspace <UUID> ...]\n",
  );
  process.exit(2);
}

function requiredValue(args: readonly string[], index: number) {
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) usage();
  return value;
}

export function parseCampaignAnalyticsReportArgs(
  args: readonly string[],
): CampaignAnalyticsReportArguments {
  let from: string | null = null;
  let to: string | null = null;
  const workspaceIds: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--from") {
      from = requiredValue(args, index);
      index += 1;
      continue;
    }
    if (argument === "--to") {
      to = requiredValue(args, index);
      index += 1;
      continue;
    }
    if (argument === "--workspace") {
      workspaceIds.push(requiredValue(args, index));
      index += 1;
      continue;
    }
    usage();
  }
  if (!from || !to) usage();
  const windowStart = new Date(from);
  const windowEnd = new Date(to);
  if (
    !Number.isFinite(windowStart.getTime()) ||
    !Number.isFinite(windowEnd.getTime()) ||
    windowStart >= windowEnd
  ) {
    usage();
  }
  return {
    windowStart,
    windowEnd,
    ...(workspaceIds.length > 0 ? { workspaceIds } : {}),
  };
}

async function main() {
  const input = parseCampaignAnalyticsReportArgs(process.argv.slice(2));
  const prisma = getPrismaClient();
  if (!prisma) {
    process.stderr.write('{"error":"database_unavailable"}\n');
    process.exitCode = 1;
    return;
  }
  try {
    const report = await new AnalyticsService().getCampaignCompletionIntervalReport(
      input,
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    process.stderr.write('{"error":"program_analytics_report_failed"}\n');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) {
  await main();
}
