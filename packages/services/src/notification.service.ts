import { getPrismaClient } from "@narriflow/db/client";

export const NOTIFICATION_MAX_ATTEMPTS = 3;
export const NOTIFICATION_LEASE_MS = 5 * 60 * 1000;

export type NotificationOutcome =
  | "clips_ready"
  | "no_clips"
  | "generation_failed"
  | "import_failed";

export interface EnqueueNotificationInput {
  projectId: string;
  sourceId: string;
  outcome: NotificationOutcome;
  deepLink: string;
  clipCount?: number;
  reason?: string;
}

export interface NotificationLedgerRow {
  id: string;
  projectId: string;
  sourceId: string;
  outcome: string;
  status: string;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  providerMessageId: string | null;
  sentAt: Date | null;
}

export interface NotificationProject {
  id: string;
  title: string;
  notifyOnComplete: boolean;
  primaryEmail: string | null;
  clipCount: number;
}

export interface WorkflowRunNotificationContext {
  idempotencyKey: string;
  attemptCount: number;
}

export interface NotificationStore {
  getProject(projectId: string): Promise<NotificationProject | null>;
  listRetryable(input: {
    now: Date;
    limit: number;
  }): Promise<NotificationLedgerRow[]>;
  insertOrFind(input: {
    projectId: string;
    sourceId: string;
    outcome: NotificationOutcome;
  }): Promise<NotificationLedgerRow>;
  claim(input: {
    id: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean>;
  markSent(input: {
    id: string;
    leaseExpiresAt: Date;
    providerMessageId: string | null;
    sentAt: Date;
  }): Promise<boolean>;
  markSkipped(input: {
    id: string;
    leaseExpiresAt: Date;
  }): Promise<boolean>;
  markDeliveryFailure(input: {
    id: string;
    leaseExpiresAt: Date;
    attemptCount: number;
    terminal: boolean;
  }): Promise<boolean>;
  getWorkflowRunContext(
    workflowRunId: string,
  ): Promise<WorkflowRunNotificationContext | null>;
}

export interface NotificationMailInput {
  to: string;
  outcome: NotificationOutcome;
  projectTitle: string;
  clipCount: number;
  reason: string;
  deepLink: string;
  idempotencyKey: string;
}

export interface NotificationMailResult {
  sent: boolean;
  id?: string;
  error?: string;
  reason?: string;
}

export type NotificationMailer = (
  input: NotificationMailInput,
) => Promise<NotificationMailResult>;

export interface NotificationServiceDependencies {
  store?: NotificationStore;
  mailer?: NotificationMailer;
  now?: () => Date;
  hasResendApiKey?: () => boolean;
  leaseMs?: number;
}

export interface RetryNotificationInput {
  deepLink: string;
  clipCount?: number;
  reason?: string;
}

export type RetryNotificationInputBuilder = (
  ledger: NotificationLedgerRow,
) => RetryNotificationInput | null | Promise<RetryNotificationInput | null>;

export interface ResendPendingNotificationsResult {
  scanned: number;
  claimed: number;
  sent: number;
  pending: number;
  failed: number;
  skipped: number;
}

export interface EnqueueNotificationResult {
  ledgerId?: string;
  status:
    | "sent"
    | "pending"
    | "claimed"
    | "failed"
    | "skipped"
    | "disabled"
    | "project_not_found";
}

function structuredWarn(
  message: string,
  context: Record<string, unknown>,
): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      message,
      ...context,
    }),
  );
}

function normalizeLedgerStatus(status: string): EnqueueNotificationResult["status"] {
  if (
    status === "sent" ||
    status === "pending" ||
    status === "claimed" ||
    status === "failed" ||
    status === "skipped"
  ) {
    return status;
  }
  return "pending";
}

function isNotificationOutcome(value: string): value is NotificationOutcome {
  return (
    value === "clips_ready" ||
    value === "no_clips" ||
    value === "generation_failed" ||
    value === "import_failed"
  );
}

function getDefaultStore(): NotificationStore {
  function requirePrisma() {
    const prisma = getPrismaClient();
    if (!prisma) {
      throw new Error("Database client unavailable");
    }
    return prisma;
  }

  return {
    async getProject(projectId) {
      const row = await requirePrisma().project.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          title: true,
          notifyOnComplete: true,
          user: { select: { primaryEmail: true } },
          _count: { select: { clips: true } },
        },
      });

      return row
        ? {
            id: row.id,
            title: row.title,
            notifyOnComplete: row.notifyOnComplete,
            primaryEmail: row.user.primaryEmail,
            clipCount: row._count.clips,
          }
        : null;
    },

    async listRetryable(input) {
      return requirePrisma().notificationLedger.findMany({
        where: {
          attemptCount: { lt: NOTIFICATION_MAX_ATTEMPTS },
          OR: [
            { status: "pending" },
            {
              status: "claimed",
              leaseExpiresAt: { lte: input.now },
            },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: input.limit,
      });
    },

    async insertOrFind(input) {
      return requirePrisma().notificationLedger.upsert({
        where: {
          projectId_sourceId_outcome: {
            projectId: input.projectId,
            sourceId: input.sourceId,
            outcome: input.outcome,
          },
        },
        update: {},
        create: input,
      });
    },

    async claim(input) {
      const result = await requirePrisma().notificationLedger.updateMany({
        where: {
          id: input.id,
          attemptCount: { lt: NOTIFICATION_MAX_ATTEMPTS },
          OR: [
            { status: "pending" },
            {
              status: "claimed",
              leaseExpiresAt: { lte: input.now },
            },
          ],
        },
        data: {
          status: "claimed",
          leaseExpiresAt: input.leaseExpiresAt,
        },
      });
      return result.count === 1;
    },

    async markSent(input) {
      const result = await requirePrisma().notificationLedger.updateMany({
        where: {
          id: input.id,
          status: "claimed",
          leaseExpiresAt: input.leaseExpiresAt,
        },
        data: {
          status: "sent",
          leaseExpiresAt: null,
          providerMessageId: input.providerMessageId,
          sentAt: input.sentAt,
        },
      });
      return result.count === 1;
    },

    async markSkipped(input) {
      const result = await requirePrisma().notificationLedger.updateMany({
        where: {
          id: input.id,
          status: "claimed",
          leaseExpiresAt: input.leaseExpiresAt,
        },
        data: {
          status: "skipped",
          leaseExpiresAt: null,
        },
      });
      return result.count === 1;
    },

    async markDeliveryFailure(input) {
      const result = await requirePrisma().notificationLedger.updateMany({
        where: {
          id: input.id,
          status: "claimed",
          leaseExpiresAt: input.leaseExpiresAt,
        },
        data: {
          status: input.terminal ? "failed" : "pending",
          leaseExpiresAt: null,
          attemptCount: input.attemptCount,
        },
      });
      return result.count === 1;
    },

    async getWorkflowRunContext(workflowRunId) {
      return requirePrisma().workflowRun.findUnique({
        where: { id: workflowRunId },
        select: {
          idempotencyKey: true,
          attemptCount: true,
        },
      });
    },
  };
}

const EMAIL_WORKER_MODULE = "@narriflow/email/worker";
const EMAIL_WORKER_FALLBACK_MODULE = "../../email/src/worker.ts";

const defaultMailer: NotificationMailer = async (input) => {
  // This non-literal import keeps packages/services independently typecheckable.
  // The worker declares @narriflow/email and provides the runtime package.
  const emailModule = await import(EMAIL_WORKER_MODULE).catch((error) => {
    const code = (error as { code?: string })?.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
      throw error;
    }
    // Local worktrees can have a stale workspace install immediately after
    // package.json changes. The deployed workspace resolves the package
    // subpath; this source fallback keeps the same shared implementation.
    return import(EMAIL_WORKER_FALLBACK_MODULE);
  });
  const email = emailModule as {
    clipsReady: (input: {
      clipCount: number;
      projectTitle: string;
      deepLink: string;
    }) => { subject: string; html: string; text: string };
    noClipsFound: (input: {
      projectTitle: string;
      deepLink: string;
    }) => { subject: string; html: string; text: string };
    generationFailed: (input: {
      projectTitle: string;
      reason: string;
      retryLink: string;
      kind?: "generation" | "import";
    }) => { subject: string; html: string; text: string };
    sendEmail: (input: {
      to: string;
      subject: string;
      html: string;
      text: string;
      idempotencyKey: string;
    }) => Promise<NotificationMailResult>;
  };

  const template =
    input.outcome === "clips_ready"
      ? email.clipsReady({
          clipCount: input.clipCount,
          projectTitle: input.projectTitle,
          deepLink: input.deepLink,
        })
      : input.outcome === "no_clips"
        ? email.noClipsFound({
            projectTitle: input.projectTitle,
            deepLink: input.deepLink,
          })
        : email.generationFailed({
            projectTitle: input.projectTitle,
            reason: input.reason,
            retryLink: input.deepLink,
            kind: input.outcome === "import_failed" ? "import" : "generation",
          });

  return email.sendEmail({
    to: input.to,
    ...template,
    idempotencyKey: input.idempotencyKey,
  });
};

export class NotificationService {
  private readonly store: NotificationStore;
  private readonly mailer: NotificationMailer;
  private readonly now: () => Date;
  private readonly hasResendApiKey: () => boolean;
  private readonly leaseMs: number;

  constructor(dependencies: NotificationServiceDependencies = {}) {
    this.store = dependencies.store ?? getDefaultStore();
    this.mailer = dependencies.mailer ?? defaultMailer;
    this.now = dependencies.now ?? (() => new Date());
    this.hasResendApiKey =
      dependencies.hasResendApiKey ??
      (() => Boolean(process.env.RESEND_API_KEY?.trim()));
    this.leaseMs = dependencies.leaseMs ?? NOTIFICATION_LEASE_MS;
  }

  async getWorkflowRunContext(
    workflowRunId: string,
  ): Promise<WorkflowRunNotificationContext | null> {
    return this.store.getWorkflowRunContext(workflowRunId);
  }

  async enqueueAndSend(
    input: EnqueueNotificationInput,
  ): Promise<EnqueueNotificationResult> {
    const project = await this.store.getProject(input.projectId);

    if (!project) {
      structuredWarn("notification_project_not_found", {
        projectId: input.projectId,
        sourceId: input.sourceId,
        outcome: input.outcome,
      });
      return { status: "project_not_found" };
    }

    if (!project.notifyOnComplete) {
      return { status: "disabled" };
    }

    const ledger = await this.store.insertOrFind({
      projectId: input.projectId,
      sourceId: input.sourceId,
      outcome: input.outcome,
    });
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
    const claimed = await this.store.claim({
      id: ledger.id,
      now,
      leaseExpiresAt,
    });

    if (!claimed) {
      return {
        ledgerId: ledger.id,
        status: normalizeLedgerStatus(ledger.status),
      };
    }

    return this.deliverClaimed({
      ledger,
      project,
      leaseExpiresAt,
      deepLink: input.deepLink,
      clipCount: input.clipCount,
      reason: input.reason,
    });
  }

  async resendPendingNotifications(
    limit: number,
    buildInput: RetryNotificationInputBuilder,
  ): Promise<ResendPendingNotificationsResult> {
    const now = this.now();
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : 1;
    const candidates = await this.store.listRetryable({
      now,
      limit: normalizedLimit,
    });
    const summary: ResendPendingNotificationsResult = {
      scanned: candidates.length,
      claimed: 0,
      sent: 0,
      pending: 0,
      failed: 0,
      skipped: 0,
    };

    for (const ledger of candidates) {
      const claimNow = this.now();
      const leaseExpiresAt = new Date(claimNow.getTime() + this.leaseMs);
      const claimed = await this.store.claim({
        id: ledger.id,
        now: claimNow,
        leaseExpiresAt,
      });
      if (!claimed) {
        continue;
      }
      summary.claimed += 1;

      const project = await this.store.getProject(ledger.projectId);
      if (!project || !project.notifyOnComplete) {
        if (!project) {
          structuredWarn("notification_project_not_found", {
            ledgerId: ledger.id,
            projectId: ledger.projectId,
            sourceId: ledger.sourceId,
            outcome: ledger.outcome,
          });
        }
        await this.store.markSkipped({ id: ledger.id, leaseExpiresAt });
        summary.skipped += 1;
        continue;
      }

      if (!isNotificationOutcome(ledger.outcome)) {
        structuredWarn("notification_outcome_invalid", {
          ledgerId: ledger.id,
          projectId: ledger.projectId,
          sourceId: ledger.sourceId,
          outcome: ledger.outcome,
        });
        await this.store.markSkipped({ id: ledger.id, leaseExpiresAt });
        summary.skipped += 1;
        continue;
      }

      const retryInput = await buildInput(ledger);
      if (!retryInput) {
        structuredWarn("notification_retry_input_unavailable", {
          ledgerId: ledger.id,
          projectId: ledger.projectId,
          sourceId: ledger.sourceId,
          outcome: ledger.outcome,
        });
        await this.store.markSkipped({ id: ledger.id, leaseExpiresAt });
        summary.skipped += 1;
        continue;
      }

      const result = await this.deliverClaimed({
        ledger: { ...ledger, outcome: ledger.outcome },
        project,
        leaseExpiresAt,
        ...retryInput,
      });
      if (
        result.status === "sent" ||
        result.status === "pending" ||
        result.status === "failed" ||
        result.status === "skipped"
      ) {
        summary[result.status] += 1;
      }
    }

    return summary;
  }

  private async deliverClaimed(input: {
    ledger: NotificationLedgerRow;
    project: NotificationProject;
    leaseExpiresAt: Date;
    deepLink: string;
    clipCount?: number;
    reason?: string;
  }): Promise<EnqueueNotificationResult> {
    const { ledger, project, leaseExpiresAt } = input;
    if (!isNotificationOutcome(ledger.outcome)) {
      structuredWarn("notification_outcome_invalid", {
        ledgerId: ledger.id,
        projectId: ledger.projectId,
        sourceId: ledger.sourceId,
        outcome: ledger.outcome,
      });
      await this.store.markSkipped({ id: ledger.id, leaseExpiresAt });
      return { ledgerId: ledger.id, status: "skipped" };
    }

    if (!project.primaryEmail) {
      structuredWarn("notification_recipient_missing", {
        ledgerId: ledger.id,
        projectId: ledger.projectId,
        sourceId: ledger.sourceId,
        outcome: ledger.outcome,
      });
      await this.store.markSkipped({ id: ledger.id, leaseExpiresAt });
      return { ledgerId: ledger.id, status: "skipped" };
    }

    if (!this.hasResendApiKey()) {
      structuredWarn("notification_resend_api_key_missing", {
        ledgerId: ledger.id,
        projectId: ledger.projectId,
        sourceId: ledger.sourceId,
        outcome: ledger.outcome,
      });
      await this.store.markSkipped({ id: ledger.id, leaseExpiresAt });
      return { ledgerId: ledger.id, status: "skipped" };
    }

    let result: NotificationMailResult;
    try {
      result = await this.mailer({
        to: project.primaryEmail,
        outcome: ledger.outcome,
        projectTitle: project.title,
        clipCount: input.clipCount ?? project.clipCount,
        reason:
          input.reason?.trim() || "The operation could not be completed.",
        deepLink: input.deepLink,
        idempotencyKey: `notification-ledger-${ledger.id}`,
      });
    } catch (error) {
      result = {
        sent: false,
        error:
          error instanceof Error
            ? error.message
            : "Email provider threw an unknown error",
      };
    }

    if (result.sent) {
      await this.store.markSent({
        id: ledger.id,
        leaseExpiresAt,
        providerMessageId: result.id ?? null,
        sentAt: this.now(),
      });
      return { ledgerId: ledger.id, status: "sent" };
    }

    const attemptCount = ledger.attemptCount + 1;
    const terminal = attemptCount >= NOTIFICATION_MAX_ATTEMPTS;
    await this.store.markDeliveryFailure({
      id: ledger.id,
      leaseExpiresAt,
      attemptCount,
      terminal,
    });
    structuredWarn("notification_delivery_failed", {
      ledgerId: ledger.id,
      projectId: ledger.projectId,
      sourceId: ledger.sourceId,
      outcome: ledger.outcome,
      attemptCount,
      maxAttempts: NOTIFICATION_MAX_ATTEMPTS,
      error: result.error ?? result.reason ?? "Unknown email provider error",
    });

    return {
      ledgerId: ledger.id,
      status: terminal ? "failed" : "pending",
    };
  }
}

export const notificationService = new NotificationService();
