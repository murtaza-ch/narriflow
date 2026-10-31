import { readServiceEnvironment } from "./runtime-environment";
import { getPrismaClient } from "@narriflow/db/client";
import { IngestJobLifecycle } from "./ingest-job-lifecycle";
import { getWorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { isWorkflowRedisDeliveryEnabled } from "./workflow.service";
import { getProcessingUsage } from "./processing-usage-runtime";
import { workspaceService } from "./workspace.service";
export function getIngestJobLifecycle(): IngestJobLifecycle {
    const prisma = getPrismaClient();
    if (!prisma) throw new Error("Database client unavailable");
    return new IngestJobLifecycle({
      prisma,
      workflow: getWorkflowRunLifecycle(),
      redisRequired: isWorkflowRedisDeliveryEnabled(),
      sourceBucket: readServiceEnvironment().R2_BUCKET ?? "unknown-bucket",
      requireRetryActor: (actor, workspace) =>
        workspaceService.requireActor(actor, workspace, "processing.consume"),
      usage: {
        reserve: (tx, input) => getProcessingUsage().reserve(tx, input),
        settle: (tx, projectId) => getProcessingUsage().settle(tx, projectId),
        release: (tx, input) => getProcessingUsage().release(tx, input),
      },
    });
}
