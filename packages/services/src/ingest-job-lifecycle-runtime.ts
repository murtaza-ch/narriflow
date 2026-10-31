import { readServiceEnvironment } from "./runtime-environment";
import { getPrismaClient } from "@narriflow/db/client";
import { createSourceVideoValidator } from "./source-readiness";
import { IngestJobLifecycle } from "./ingest-job-lifecycle";
import { getWorkflowRunLifecycle } from "./workflow-run-lifecycle";
import { getProcessingUsage } from "./processing-usage-runtime";
import { workspaceService } from "./workspace.service";
import { ingestExecutionInputHash } from "./ingest-source-execution";
export function getIngestJobLifecycle(): IngestJobLifecycle {
    const prisma = getPrismaClient();
    if (!prisma) throw new Error("Database client unavailable");
    const environment = readServiceEnvironment();
    return new IngestJobLifecycle({
      prisma,
      workflow: getWorkflowRunLifecycle(),
      validateVideo: createSourceVideoValidator(getProcessingUsage()),
      progressRequired: true,
      sourceBucket: readServiceEnvironment().R2_BUCKET ?? "unknown-bucket",
      executionInputHash: job => {
        const payload = job.payload;
        const local = environment.YOUTUBE_FETCH_MODE === "local" && payload && typeof payload === "object" && !Array.isArray(payload) && payload.provider === "youtube";
        return ingestExecutionInputHash(job, (local ? environment.MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT : environment.MEDIA_FETCH_TOOLCHAIN_FINGERPRINT) ?? "");
      },
      requireRetryActor: (actor, workspace) =>
        workspaceService.requireActor(actor, workspace, "processing.consume"),
      usage: {
        reserve: (tx, input) => getProcessingUsage().reserve(tx, input),
        settle: (tx, projectId) => getProcessingUsage().settle(tx, projectId),
        release: (tx, input) => getProcessingUsage().release(tx, input),
      },
    });
}
