import {
  decideAutoRetry,
  INGEST_AUTO_RETRY_MAX_ATTEMPTS,
  INGEST_RETRIES_EXHAUSTED_CODE,
  notificationService,
  reviewNotificationService,
  WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS,
  WORKFLOW_RETRIES_EXHAUSTED_CODE,
  type NotificationLedgerRow,
  type NotificationOutcome,
  type RetryNotificationInput,
} from "@narriflow/services";

const DEFAULT_WORKER_APP_BASE_URL = "http://localhost:3000";

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

export function getWorkerAppBaseUrl(): string | null {
  const configured = process.env.WORKER_APP_BASE_URL?.trim();
  const isProduction = process.env.NODE_ENV === "production";

  if (!configured) {
    if (isProduction) {
      log("error", "worker_app_base_url_missing", {
        action: "notification_send_skipped",
      });
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
    log(isProduction ? "error" : "warn", "worker_app_base_url_invalid", {
      configured,
      action: isProduction
        ? "notification_send_skipped"
        : "localhost_fallback_used",
      ...(isProduction ? {} : { fallback: DEFAULT_WORKER_APP_BASE_URL }),
    });
    return isProduction ? null : DEFAULT_WORKER_APP_BASE_URL;
  }
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

export async function retryPendingNotifications(limit: number) {
  return notificationService.resendPendingNotifications(
    limit,
    buildRetryNotificationInput,
  );
}

export async function retryPendingReviewNotifications(limit: number) {
  const baseUrl = getWorkerAppBaseUrl();
  if (!baseUrl) {
    return { scanned: 0, claimed: 0, sent: 0, pending: 0, failed: 0, skipped: 0 };
  }
  return reviewNotificationService.deliverDue(limit, baseUrl);
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
