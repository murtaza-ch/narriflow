import { getPrismaClient } from "@narriflow/db/client";
import { decryptReviewValue, reviewDeliverySecret } from "./review.service";

export const REVIEW_NOTIFICATION_MAX_ATTEMPTS = 3;
export const REVIEW_NOTIFICATION_LEASE_MS = 5 * 60_000;
export const REVIEW_NOTIFICATION_RETRY_DELAY_MS = 60_000;

export type ReviewNotificationKind =
  | "round_sent"
  | "first_change_requested"
  | "all_approved"
  | "mention";

export interface ReviewNotificationLedgerRow {
  id: string;
  reviewRoundId: string;
  kind: ReviewNotificationKind;
  scopeKey: string;
  status: string;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  nextAttemptAt: Date;
  providerMessageId: string | null;
  sentAt: Date | null;
  failureCode: string | null;
}

export interface ReviewNotificationContext {
  ledgerId: string;
  recipient: string;
  projectTitle: string;
  roundTitle: string;
  reviewPath: string;
  kind: ReviewNotificationKind;
}

export interface ReviewNotificationStore {
  listDue(now: Date, limit: number): Promise<ReviewNotificationLedgerRow[]>;
  claim(id: string, now: Date, leaseExpiresAt: Date): Promise<boolean>;
  getContext(id: string): Promise<ReviewNotificationContext | null>;
  markSent(
    id: string,
    leaseExpiresAt: Date,
    providerMessageId: string | null,
    sentAt: Date,
  ): Promise<boolean>;
  markFailed(
    id: string,
    leaseExpiresAt: Date,
    attemptCount: number,
    nextAttemptAt: Date,
    terminal: boolean,
    failureCode: string,
  ): Promise<boolean>;
  retry(
    scope: { workspaceId: string; projectId: string },
    reviewRoundId: string,
    id: string,
    now: Date,
  ): Promise<boolean>;
}

export interface ReviewNotificationMailInput {
  to: string;
  kind: ReviewNotificationKind;
  projectTitle: string;
  roundTitle: string;
  reviewUrl: string;
  idempotencyKey: string;
}

export interface ReviewNotificationMailResult {
  sent: boolean;
  id?: string;
  retryable?: boolean;
  code?: string;
}

export type ReviewNotificationMailer = (
  input: ReviewNotificationMailInput,
) => Promise<ReviewNotificationMailResult>;

export interface ReviewNotificationDeliverySummary {
  scanned: number;
  claimed: number;
  sent: number;
  pending: number;
  failed: number;
  skipped: number;
}

interface ReviewNotificationDependencies {
  store: ReviewNotificationStore;
  mailer: ReviewNotificationMailer;
  now?: () => Date;
  leaseMs?: number;
  retryDelayMs?: number;
  enabled?: () => boolean;
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function defaultStore(): ReviewNotificationStore {
  return {
    listDue(now, limit) {
      return requirePrisma().reviewNotificationLedger.findMany({
        where: {
          attemptCount: { lt: REVIEW_NOTIFICATION_MAX_ATTEMPTS },
          nextAttemptAt: { lte: now },
          OR: [
            { status: "pending" },
            { status: "claimed", leaseExpiresAt: { lte: now } },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: limit,
      }) as Promise<ReviewNotificationLedgerRow[]>;
    },
    async claim(id, now, leaseExpiresAt) {
      const claimed = await requirePrisma().reviewNotificationLedger.updateMany({
        where: {
          id,
          attemptCount: { lt: REVIEW_NOTIFICATION_MAX_ATTEMPTS },
          nextAttemptAt: { lte: now },
          OR: [
            { status: "pending" },
            { status: "claimed", leaseExpiresAt: { lte: now } },
          ],
        },
        data: { status: "claimed", leaseExpiresAt },
      });
      return claimed.count === 1;
    },
    async getContext(id) {
      const ledger = await requirePrisma().reviewNotificationLedger.findUnique({
        where: { id },
        include: { reviewRound: { select: {
          id: true,
          title: true,
          projectId: true,
          deliveryTokenEncrypted: true,
          project: { select: { title: true } },
        } } },
      });
      if (!ledger) return null;
      const kind = ledger.kind as ReviewNotificationKind;
      if (!(["round_sent", "first_change_requested", "all_approved", "mention"] as const).includes(kind)) return null;
      const internal = kind === "first_change_requested" || kind === "all_approved";
      return {
        ledgerId: ledger.id,
        recipient: ledger.recipientEmail,
        projectTitle: ledger.reviewRound.project.title,
        roundTitle: ledger.reviewRound.title,
        reviewPath: internal
          ? `/projects/${ledger.reviewRound.projectId}?tab=review`
          : `/review/${decryptReviewValue(ledger.reviewRound.deliveryTokenEncrypted, reviewDeliverySecret())}`,
        kind,
      };
    },
    async markSent(id, leaseExpiresAt, providerMessageId, sentAt) {
      const updated = await requirePrisma().reviewNotificationLedger.updateMany({
        where: { id, status: "claimed", leaseExpiresAt },
        data: { status: "sent", leaseExpiresAt: null, providerMessageId, sentAt, failureCode: null },
      });
      return updated.count === 1;
    },
    async markFailed(id, leaseExpiresAt, attemptCount, nextAttemptAt, terminal, failureCode) {
      const updated = await requirePrisma().reviewNotificationLedger.updateMany({
        where: { id, status: "claimed", leaseExpiresAt },
        data: {
          status: terminal ? "failed" : "pending",
          leaseExpiresAt: null,
          attemptCount,
          nextAttemptAt,
          failureCode,
        },
      });
      return updated.count === 1;
    },
    async retry(scope, reviewRoundId, id, now) {
      const updated = await requirePrisma().reviewNotificationLedger.updateMany({
        where: {
          id,
          reviewRoundId,
          status: "failed",
          reviewRound: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
          },
        },
        data: { status: "pending", attemptCount: 0, nextAttemptAt: now, failureCode: null },
      });
      return updated.count === 1;
    },
  };
}

const defaultMailer: ReviewNotificationMailer = async (input) => {
  const email = await import("@narriflow/email/worker");
  const template = email.reviewNotification({
    kind: input.kind,
    projectTitle: input.projectTitle,
    roundTitle: input.roundTitle,
    reviewUrl: input.reviewUrl,
  });
  return email.sendEmail({
    to: input.to,
    ...template,
    idempotencyKey: input.idempotencyKey,
  });
};

function warn(message: string, context: Record<string, unknown>) {
  console.warn(JSON.stringify({ level: "warn", message, ...context }));
}

export class ReviewNotificationService {
  private readonly store: ReviewNotificationStore;
  private readonly mailer: ReviewNotificationMailer;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private readonly enabled: () => boolean;

  constructor(dependencies: ReviewNotificationDependencies) {
    this.store = dependencies.store;
    this.mailer = dependencies.mailer;
    this.now = dependencies.now ?? (() => new Date());
    this.leaseMs = dependencies.leaseMs ?? REVIEW_NOTIFICATION_LEASE_MS;
    this.retryDelayMs = dependencies.retryDelayMs ?? REVIEW_NOTIFICATION_RETRY_DELAY_MS;
    this.enabled = dependencies.enabled ?? (() => true);
  }

  async deliverDue(limit: number, appBaseUrl: string): Promise<ReviewNotificationDeliverySummary> {
    if (!this.enabled()) {
      return { scanned: 0, claimed: 0, sent: 0, pending: 0, failed: 0, skipped: 0 };
    }
    const now = this.now();
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
    const candidates = await this.store.listDue(now, boundedLimit);
    const summary: ReviewNotificationDeliverySummary = {
      scanned: candidates.length,
      claimed: 0,
      sent: 0,
      pending: 0,
      failed: 0,
      skipped: 0,
    };

    for (const row of candidates) {
      const claimNow = this.now();
      const leaseExpiresAt = new Date(claimNow.getTime() + this.leaseMs);
      if (!(await this.store.claim(row.id, claimNow, leaseExpiresAt))) continue;
      summary.claimed += 1;

      const context = await this.store.getContext(row.id);
      if (!context) {
        await this.store.markFailed(
          row.id,
          leaseExpiresAt,
          REVIEW_NOTIFICATION_MAX_ATTEMPTS,
          claimNow,
          true,
          "context_unavailable",
        );
        summary.failed += 1;
        warn("review_notification_context_unavailable", {
          ledgerId: row.id,
          reviewRoundId: row.reviewRoundId,
          kind: row.kind,
        });
        continue;
      }

      let outcome: ReviewNotificationMailResult;
      try {
        outcome = await this.mailer({
          to: context.recipient,
          kind: context.kind,
          projectTitle: context.projectTitle,
          roundTitle: context.roundTitle,
          reviewUrl: new URL(context.reviewPath, appBaseUrl).toString(),
          idempotencyKey: `review-notification-${row.id}`,
        });
      } catch {
        outcome = { sent: false, retryable: true, code: "provider_unavailable" };
      }

      if (outcome.sent) {
        await this.store.markSent(
          row.id,
          leaseExpiresAt,
          outcome.id ?? null,
          this.now(),
        );
        summary.sent += 1;
        continue;
      }

      const attemptCount = row.attemptCount + 1;
      const terminal = outcome.retryable === false || attemptCount >= REVIEW_NOTIFICATION_MAX_ATTEMPTS;
      const nextAttemptAt = new Date(this.now().getTime() + this.retryDelayMs * attemptCount);
      await this.store.markFailed(
        row.id,
        leaseExpiresAt,
        attemptCount,
        nextAttemptAt,
        terminal,
        outcome.code ?? "provider_failed",
      );
      summary[terminal ? "failed" : "pending"] += 1;
      warn("review_notification_delivery_failed", {
        ledgerId: row.id,
        reviewRoundId: row.reviewRoundId,
        kind: row.kind,
        attemptCount,
        terminal,
        failureCode: outcome.code ?? "provider_failed",
      });
    }

    return summary;
  }

  async retry(
    scope: { workspaceId: string; projectId: string },
    reviewRoundId: string,
    ledgerId: string,
  ) {
    const retrying = await this.store.retry(
      scope,
      reviewRoundId,
      ledgerId,
      this.now(),
    );
    return { retrying };
  }
}

export const reviewNotificationService = new ReviewNotificationService({
  store: defaultStore(),
  mailer: defaultMailer,
});
