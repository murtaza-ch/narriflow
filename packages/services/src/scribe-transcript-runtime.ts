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
  sourceDurationSeconds: (projectId) => projectService.getSourceProbeDurationForWorker(projectId),
  storeRawJson: async ({ key, value, metadata }) => {
    await putJson({ key, value, metadata });
  },
});
