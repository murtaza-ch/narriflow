import {
  analyticsService,
  autopilotService,
  brandProfileService,
  clipService,
  contentSuiteService,
  dubbingService,
  finalizeScribeTranscript,
  getProcessingUsage,
  getProjectFinishing,
  getWorkflowRunLifecycle,
  presignDownloadUrl,
  projectService,
  reviewService,
  socialOAuthService,
  socialService,
  workspaceLibraryService,
  WorkflowFailure,
  workspaceService,
} from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { ProjectsRouteDeps } from "./routes";
import type { ProjectsWebhookDeps } from "./webhooks";

/** Production wiring of the projects routes. */
export function createProjectsRouteDeps(_config: ApiConfig): ProjectsRouteDeps {
  return {
    projectService,
    workspaceLibraryService,
    contentSuiteService,
    analyticsService,
    dubbingService,
    clipService,
    socialService,
    socialOAuthService,
    brandProfileService,
    reviewService,
    workspaceService,
    autopilotService,
    getProjectFinishing,
    getProcessingUsage,
    presignDownloadUrl,
  };
}

/** Production wiring of the ElevenLabs webhook adapter. */
export function createProjectsWebhookDeps(): ProjectsWebhookDeps {
  return {
    webhookSecret: () => process.env.ELEVENLABS_WEBHOOK_SECRET?.trim() || null,
    finalizeScribeTranscript,
    failProviderAttempt: (key, failure, ids) =>
      getWorkflowRunLifecycle().failProviderAttempt(
        key,
        new WorkflowFailure(failure.code, failure.retryable ? "retryable" : "permanent", failure.message),
        ids,
      ),
  };
}
