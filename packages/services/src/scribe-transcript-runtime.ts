import { getPrismaClient } from "@narriflow/db/client";
import { projectService } from "./project.service";
import { putJson } from "./r2-storage";
import { createScribeFinalizer } from "./scribe-transcript";
import { getWorkflowRunLifecycle } from "./workflow-run-lifecycle";

/** Production Scribe finalizer: the API webhook and the worker's GET recovery. */
export const finalizeScribeTranscript = createScribeFinalizer({
  get lifecycle() {
    return getWorkflowRunLifecycle();
  },
  allowsEmptyTranscript: (workflowRunId) => projectService.runAllowsEmptyTranscript(workflowRunId),
  sourceDurationSeconds: async ({ projectId, sourceAudioId, sourceRevision }) => {
    if (!sourceAudioId) return null;
    const db = getPrismaClient();
    if (!db) throw new Error("Database client unavailable");
    const audio = await db.sourceAudio.findFirst({ where: { id: sourceAudioId, projectId, sourceRevision }, select: { durationSeconds: true } });
    return audio?.durationSeconds ?? null;
  },
  storeRawJson: async ({ key, value, metadata }) => {
    await putJson({ key, value, metadata });
  },
});
