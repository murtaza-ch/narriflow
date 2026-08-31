import {
  createReviewRolloutPolicy,
  decideAutoRetry,
  createProductionReviewNotificationDelivery,
  INGEST_AUTO_RETRY_MAX_ATTEMPTS,
  INGEST_RETRIES_EXHAUSTED_CODE,
  notificationService,
  WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS,
  WORKFLOW_RETRIES_EXHAUSTED_CODE,
  type NotificationLedgerRow,
  type NotificationOutcome,
  type RetryNotificationInput,
} from "@narriflow/services";

const DEFAULT_WORKER_APP_BASE_URL = "http://localhost:3000";
const REVIEW_NOTIFICATION_CONFIGURATION_FAILURE =
  "review_notification_worker_configuration_invalid" as const;

type ReviewNotificationConfigurationField =
  | "WORKER_APP_BASE_URL"
  | "REVIEW_ACCESS_SECRET"
  | "REVIEW_SESSION_SECRET"
  | "RESEND_API_KEY";

export type ReviewNotificationWorkerConfiguration =
  | { enabled: false; ready: true }
  | {
      enabled: true;
      ready: false;
      failureCode: typeof REVIEW_NOTIFICATION_CONFIGURATION_FAILURE;
      invalidFields: ReviewNotificationConfigurationField[];
    }
  | {
      enabled: true;
      ready: true;
      appBaseUrl: string;
      accessSecret: string;
      dataSecret: string;
    };

function log(
  level: "warn" | "error",
  message: string,
  context: Record<string, unknown>,
): void {
  const write = level === "error" ? console.error : console.warn;
  write(
    JSON.stringify({
      level,
      message,
      ...context,
    }),
  );
}

function warn(message: string, context: Record<string, unknown>): void {
  log("warn", message, context);
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]"
  );
}

export function getWorkerAppBaseUrl(options: { report?: boolean } = {}): string | null {
  const report = options.report ?? true;
  const configured = process.env.WORKER_APP_BASE_URL?.trim();
  const isProduction = process.env.NODE_ENV === "production";

  if (!configured) {
    if (isProduction) {
      if (report) {
        log("error", "worker_app_base_url_missing", {
          action: "notification_send_skipped",
        });
      }
      return null;
    }
    return DEFAULT_WORKER_APP_BASE_URL;
  }

  try {
    const url = new URL(configured);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      (isProduction && isLoopbackHostname(url.hostname))
    ) {
      throw new Error("URL must be a public HTTP(S) origin");
    }
    return url.origin;
  } catch {
    if (report) {
      log(isProduction ? "error" : "warn", "worker_app_base_url_invalid", {
        configured,
        action: isProduction
          ? "notification_send_skipped"
          : "localhost_fallback_used",
        ...(isProduction ? {} : { fallback: DEFAULT_WORKER_APP_BASE_URL }),
      });
    }
    return isProduction ? null : DEFAULT_WORKER_APP_BASE_URL;
  }
}

export function resolveReviewNotificationWorkerConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
  resolveBaseUrl: () => string | null = () =>
    getWorkerAppBaseUrl({ report: false }),
): ReviewNotificationWorkerConfiguration {
  if (!createReviewRolloutPolicy(env).isEnabled("notification_admission")) {
    return { enabled: false, ready: true };
  }

  const appBaseUrl = resolveBaseUrl();
  const accessSecret = env.REVIEW_ACCESS_SECRET?.trim() ?? "";
  const dataSecret = env.REVIEW_SESSION_SECRET?.trim() ?? "";
  const resendApiKey = env.RESEND_API_KEY?.trim() ?? "";
  const invalidFields: ReviewNotificationConfigurationField[] = [];
  if (!appBaseUrl) invalidFields.push("WORKER_APP_BASE_URL");
  if (accessSecret.length < 32) invalidFields.push("REVIEW_ACCESS_SECRET");
  if (dataSecret.length < 32) invalidFields.push("REVIEW_SESSION_SECRET");
  if (!resendApiKey) invalidFields.push("RESEND_API_KEY");
  if (invalidFields.length > 0) {
    return {
      enabled: true,
      ready: false,
      failureCode: REVIEW_NOTIFICATION_CONFIGURATION_FAILURE,
      invalidFields,
    };
  }

  return {
    enabled: true,
    ready: true,
    appBaseUrl: appBaseUrl!,
    accessSecret,
    dataSecret,
  };
}

export function reviewNotificationWorkerHealth(
  configuration: ReviewNotificationWorkerConfiguration,
) {
  return {
    enabled: configuration.enabled,
    ready: configuration.ready,
    failureCode:
      configuration.enabled && !configuration.ready
        ? configuration.failureCode
        : null,
  };
}

export function reportReviewNotificationWorkerConfiguration(
  configuration: ReviewNotificationWorkerConfiguration,
  write: (message: string) => void = (message) => console.warn(message),
): void {
  if (!configuration.enabled || configuration.ready) return;
  write(
    JSON.stringify({
      level: "error",
      message: configuration.failureCode,
      invalidFields: configuration.invalidFields,
      action: "review_notification_delivery_paused",
    }),
  );
}

export function getProjectDeepLink(projectId: string): string | null {
  const baseUrl = getWorkerAppBaseUrl();
  if (!baseUrl) {
    return null;
  }
  return new URL(
    `/projects/${encodeURIComponent(projectId)}`,
    baseUrl,
  ).toString();
}

export function buildRetryNotificationInput(
  ledger: NotificationLedgerRow,
): RetryNotificationInput | null {
  const baseUrl = getWorkerAppBaseUrl();
  const deepLink =
    ledger.outcome === "project_expiring" && baseUrl
      ? new URL("/settings/billing", baseUrl).toString()
      : getProjectDeepLink(ledger.projectId);
  return deepLink ? { deepLink } : null;
}

export async function retryPendingNotifications(
  limit: number,
  reviewConfiguration = resolveReviewNotificationWorkerConfiguration(),
) {
  const result = await notificationService.resendPendingNotifications(
    limit,
    buildRetryNotificationInput,
  );
  if (!reviewConfiguration.enabled || !reviewConfiguration.ready) {
    return result;
  }
  const reviewResults = await createProductionReviewNotificationDelivery({
    appBaseUrl: reviewConfiguration.appBaseUrl,
    accessSecret: reviewConfiguration.accessSecret,
    dataSecret: reviewConfiguration.dataSecret,
  }).processDue(limit);
  return {
    ...result,
    scanned: result.scanned + reviewResults.length,
    claimed:
      result.claimed +
      reviewResults.filter(
        (entry) =>
          entry.status !== "already_claimed" && entry.status !== "not_found",
      ).length,
    sent:
      result.sent +
      reviewResults.filter((entry) => entry.status === "sent").length,
    pending:
      result.pending +
      reviewResults.filter((entry) => entry.status === "pending").length,
    failed:
      result.failed +
      reviewResults.filter((entry) => entry.status === "failed").length,
  };
}

export async function notifyTerminalOutcome(input: {
  projectId: string;
  sourceId: string;
  outcome: NotificationOutcome;
  clipCount?: number;
  reason?: string;
}): Promise<void> {
  try {
    const deepLink = getProjectDeepLink(input.projectId);
    if (!deepLink) {
      warn("terminal_notification_skipped", {
        projectId: input.projectId,
        sourceId: input.sourceId,
        outcome: input.outcome,
        reason: "WORKER_APP_BASE_URL is unavailable",
      });
      return;
    }

    await notificationService.enqueueAndSend({
      ...input,
      deepLink,
    });
  } catch (error) {
    warn("terminal_notification_enqueue_failed", {
      projectId: input.projectId,
      sourceId: input.sourceId,
      outcome: input.outcome,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function notifyExpiringProject(projectId: string): Promise<void> {
  try {
    const baseUrl = getWorkerAppBaseUrl();
    if (!baseUrl) return;
    await notificationService.enqueueAndSend({
      projectId,
      sourceId: projectId,
      outcome: "project_expiring",
      deepLink: new URL("/settings/billing", baseUrl).toString(),
      reason: "The Free-plan project retention deadline is approaching.",
    });
  } catch (error) {
    warn("project_expiry_notification_enqueue_failed", {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function notifyWorkflowFailureAfterSettlement(input: {
  workflowRunId: string;
  projectId: string;
  errorCode: string;
  reason: string;
  autoRenderOnly?: boolean;
}): Promise<void> {
  try {
    const context = await notificationService.getWorkflowRunContext(
      input.workflowRunId,
    );

    if (!context) {
      warn("workflow_notification_context_missing", {
        workflowRunId: input.workflowRunId,
        projectId: input.projectId,
        errorCode: input.errorCode,
      });
      return;
    }

    if (
      input.autoRenderOnly &&
      !context.idempotencyKey.startsWith("auto-render-")
    ) {
      return;
    }

    const decision = decideAutoRetry(
      context.attemptCount,
      input.errorCode,
      WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS,
      WORKFLOW_RETRIES_EXHAUSTED_CODE,
    );
    if (decision.outcome !== "permanent") {
      return;
    }

    await notifyTerminalOutcome({
      projectId: input.projectId,
      sourceId: input.workflowRunId,
      outcome:
        input.errorCode === "no_clips_detected"
          ? "no_clips"
          : "generation_failed",
      reason: input.reason,
    });
  } catch (error) {
    warn("workflow_terminal_notification_failed", {
      workflowRunId: input.workflowRunId,
      projectId: input.projectId,
      errorCode: input.errorCode,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function notifyIngestFailureAfterSettlement(input: {
  jobId: string;
  projectId: string;
  attemptCount: number;
  errorCode: string;
  reason: string;
}): Promise<void> {
  const decision = decideAutoRetry(
    input.attemptCount,
    input.errorCode,
    INGEST_AUTO_RETRY_MAX_ATTEMPTS,
    INGEST_RETRIES_EXHAUSTED_CODE,
  );
  if (decision.outcome !== "permanent") {
    return;
  }

  await notifyTerminalOutcome({
    projectId: input.projectId,
    sourceId: input.jobId,
    outcome: "import_failed",
    reason: input.reason,
  });
}
