import { readServiceEnvironment } from "@narriflow/services/runtime-environment";
import { analyticsService } from "@narriflow/services/analytics.service";
import { autopilotService } from "@narriflow/services/autopilot.service";
import { brandProfileService } from "@narriflow/services/brand-profile.service";
import { clipService } from "@narriflow/services/clip.service";
import { contentSuiteService } from "@narriflow/services/content-suite.service";
import { dubbingService } from "@narriflow/services/dubbing.service";
import { finalizeScribeTranscript } from "@narriflow/services/scribe-transcript-runtime";
import { deliverExecutionDispatches } from "@narriflow/services/execution-dispatch-runtime";
import { getProcessingUsage } from "@narriflow/services/processing-usage-runtime";
import { getProjectFinishing } from "@narriflow/services/generation-finishing-runtime";
import { getWorkflowRunLifecycle, WorkflowFailure } from "@narriflow/services/workflow-run-lifecycle";
import { presignDownloadUrl } from "@narriflow/services/r2-storage";
import { projectService } from "@narriflow/services/project.service";
import { reviewService } from "@narriflow/services/review.service";
import { socialOAuthService } from "@narriflow/services/social-oauth.service";
import { socialService } from "@narriflow/services/social.service";
import { workspaceLibraryService } from "@narriflow/services/workspace-library.service";
import { workspaceService } from "@narriflow/services/workspace.service";
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
    webhookSecret: () => readServiceEnvironment().ELEVENLABS_WEBHOOK_SECRET?.trim() || null,
    deliverWakes: deliverExecutionDispatches,
    finalizeScribeTranscript,
    failProviderAttempt: (key, failure, ids) =>
      getWorkflowRunLifecycle().failProviderAttempt(
        key,
        new WorkflowFailure(failure.code, failure.retryable ? "retryable" : "permanent", failure.message),
        ids,
      ),
  };
}
