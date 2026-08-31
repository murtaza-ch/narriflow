import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@narriflow/db/client";
import { reviewNotification, sendEmail } from "@narriflow/email/worker";
import {
  decryptReviewEmail,
  deriveReviewAccessToken,
} from "./review.service";
import { reviewRolloutPolicy } from "./review-rollout";

export type ReviewNotificationKind =
  | "round_sent"
  | "round_resent"
  | "first_changes_requested"
  | "all_approved"
  | "mention";

export type ReviewNotificationStatus =
  | "pending"
  | "claimed"
  | "sent"
  | "failed";

export interface ReviewNotificationDeliveryContext {
  to: string;
  projectTitle: string;
  roundNumber: number;
  audience: "guest" | "internal";
  actionUrl: string;
}

export interface ReviewNotificationRow {
  id: string;
  reviewRoundId: string;
  projectId: string;
  recipientId: string;
  kind: ReviewNotificationKind;
  status: ReviewNotificationStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  claimId: string | null;
  leaseExpiresAt: Date | null;
  providerMessageId: string | null;
  failureCode: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

export interface ReviewNotificationSeed extends ReviewNotificationRow {
  delivery: ReviewNotificationDeliveryContext;
}

export interface ReviewNotificationStore {
  listDue(input: { now: Date; limit: number }): Promise<ReviewNotificationRow[]>;
  claim(input: {
    id: string;
    claimId: string;
    now: Date;
    leaseExpiresAt: Date;
    maxAttempts: number;
  }): Promise<ReviewNotificationRow | null>;
  deliveryContext(id: string): Promise<ReviewNotificationDeliveryContext | null>;
  markSent(input: {
    id: string;
    claimId: string;
    providerMessageId: string | null;
    sentAt: Date;
  }): Promise<boolean>;
  markFailure(input: {
    id: string;
    claimId: string;
    attemptCount: number;
    status: "pending" | "failed";
    failureCode: string;
    nextAttemptAt: Date;
  }): Promise<boolean>;
}

export interface ReviewNotificationMailInput
  extends ReviewNotificationDeliveryContext {
  kind: ReviewNotificationKind;
  idempotencyKey: string;
}

export interface ReviewNotificationMailResult {
  sent: boolean;
  id?: string;
  error?: string;
  reason?: string;
}

export type ReviewNotificationMailer = (
  input: ReviewNotificationMailInput,
) => Promise<ReviewNotificationMailResult>;

export type ReviewNotificationDeliveryResult =
  | {
      status: "sent" | "pending" | "failed";
      notificationId: string;
      failureCode: string | null;
    }
  | {
      status: "already_claimed" | "not_found" | "disabled";
      notificationId: string;
      failureCode: null;
    };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function logDeliveryFailure(input: {
  notificationId: string;
  reviewRoundId: string;
  projectId: string;
  kind: ReviewNotificationKind;
  attemptCount: number;
  failureCode: string;
}) {
  console.warn(
    JSON.stringify({
      level: "warn",
      message: "review_notification_delivery_failed",
      ...input,
    }),
  );
}

export function createReviewNotificationDelivery(dependencies: {
  store: ReviewNotificationStore;
  mailer: ReviewNotificationMailer;
  now?: () => Date;
  createClaimId?: () => string;
  leaseMs?: number;
  maxAttempts?: number;
  retryDelayMs?: (attemptCount: number) => number;
  admissionEnabled?: () => boolean;
}) {
  const now = dependencies.now ?? (() => new Date());
  const createClaimId = dependencies.createClaimId ?? randomUUID;
  const leaseMs = dependencies.leaseMs ?? 5 * 60_000;
  const maxAttempts = dependencies.maxAttempts ?? 5;
  const retryDelayMs =
    dependencies.retryDelayMs ??
    ((attemptCount: number) => Math.min(60 * 60_000, 30_000 * 2 ** (attemptCount - 1)));
  const admissionEnabled = dependencies.admissionEnabled ?? (() => true);

  async function fail(
    claimed: ReviewNotificationRow,
    claimId: string,
    failureCode: string,
    terminal: boolean,
  ): Promise<ReviewNotificationDeliveryResult> {
    const attemptCount = claimed.attemptCount + 1;
    const status = terminal || attemptCount >= maxAttempts ? "failed" : "pending";
    const failureAt = now();
    const settled = await dependencies.store.markFailure({
      id: claimed.id,
      claimId,
      attemptCount,
      status,
      failureCode,
      nextAttemptAt:
        status === "pending"
          ? new Date(failureAt.getTime() + retryDelayMs(attemptCount))
          : failureAt,
    });
    if (!settled) {
      return {
        status: "already_claimed",
        notificationId: claimed.id,
        failureCode: null,
      };
    }
    logDeliveryFailure({
      notificationId: claimed.id,
      reviewRoundId: claimed.reviewRoundId,
      projectId: claimed.projectId,
      kind: claimed.kind,
      attemptCount,
      failureCode,
    });
    return { status, notificationId: claimed.id, failureCode };
  }

  return {
    async deliver(notificationId: string): Promise<ReviewNotificationDeliveryResult> {
      if (!admissionEnabled()) {
        return { status: "disabled", notificationId, failureCode: null };
      }
      const claimAt = now();
      const claimId = createClaimId();
      const claimed = await dependencies.store.claim({
        id: notificationId,
        claimId,
        now: claimAt,
        leaseExpiresAt: new Date(claimAt.getTime() + leaseMs),
        maxAttempts,
      });
      if (!claimed) {
        return {
          status: "already_claimed",
          notificationId,
          failureCode: null,
        };
      }
      const context = await dependencies.store.deliveryContext(claimed.id);
      if (!context) {
        return fail(
          claimed,
          claimId,
          "review_notification_context_missing",
          true,
        );
      }
      if (
        context.to.length > 254 ||
        !EMAIL_PATTERN.test(context.to) ||
        context.actionUrl.length > 2_048
      ) {
        return fail(
          claimed,
          claimId,
          "review_notification_recipient_invalid",
          true,
        );
      }

      let result: ReviewNotificationMailResult;
      try {
        result = await dependencies.mailer({
          ...context,
          kind: claimed.kind,
          idempotencyKey: `review-notification-${claimed.id}`,
        });
      } catch {
        result = { sent: false };
      }
      if (!result.sent) {
        return fail(
          claimed,
          claimId,
          "review_notification_provider_unavailable",
          false,
        );
      }
      const settled = await dependencies.store.markSent({
        id: claimed.id,
        claimId,
        providerMessageId: result.id ?? null,
        sentAt: now(),
      });
      if (!settled) {
        return {
          status: "already_claimed",
          notificationId: claimed.id,
          failureCode: null,
        };
      }
      return {
        status: "sent",
        notificationId: claimed.id,
        failureCode: null,
      };
    },

    async processDue(limit: number) {
      if (!admissionEnabled()) return [];
      const rows = await dependencies.store.listDue({
        now: now(),
        limit: Math.max(1, Math.min(100, Math.floor(limit))),
      });
      const results: ReviewNotificationDeliveryResult[] = [];
      for (const row of rows) results.push(await this.deliver(row.id));
      return results;
    },
  };
}

export function createInMemoryReviewNotificationStore(
  seeds: ReviewNotificationSeed[],
): ReviewNotificationStore & {
  inspect(id: string): Promise<ReviewNotificationRow | null>;
} {
  const rows = new Map(
    seeds.map((seed) => [
      seed.id,
      {
        row: structuredClone((({ delivery: _delivery, ...row }) => row)(seed)),
        delivery: structuredClone(seed.delivery),
      },
    ]),
  );

  return {
    async listDue(input) {
      return [...rows.values()]
        .map((entry) => entry.row)
        .filter(
          (row) =>
            (row.status === "pending" ||
              (row.status === "claimed" &&
                row.leaseExpiresAt !== null &&
                row.leaseExpiresAt <= input.now)) &&
            row.nextAttemptAt <= input.now,
        )
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .slice(0, input.limit)
        .map((row) => structuredClone(row));
    },
    async claim(input) {
      const entry = rows.get(input.id);
      if (!entry) return null;
      const row = entry.row;
      const claimable =
        row.attemptCount < input.maxAttempts &&
        row.nextAttemptAt <= input.now &&
        (row.status === "pending" ||
          (row.status === "claimed" &&
            row.leaseExpiresAt !== null &&
            row.leaseExpiresAt <= input.now));
      if (!claimable) return null;
      row.status = "claimed";
      row.claimId = input.claimId;
      row.leaseExpiresAt = input.leaseExpiresAt;
      return structuredClone(row);
    },
    async deliveryContext(id) {
      const context = rows.get(id)?.delivery;
      return context ? structuredClone(context) : null;
    },
    async markSent(input) {
      const row = rows.get(input.id)?.row;
      if (!row || row.status !== "claimed" || row.claimId !== input.claimId) {
        return false;
      }
      row.status = "sent";
      row.claimId = null;
      row.leaseExpiresAt = null;
      row.providerMessageId = input.providerMessageId;
      row.failureCode = null;
      row.sentAt = input.sentAt;
      return true;
    },
    async markFailure(input) {
      const row = rows.get(input.id)?.row;
      if (!row || row.status !== "claimed" || row.claimId !== input.claimId) {
        return false;
      }
      row.status = input.status;
      row.claimId = null;
      row.leaseExpiresAt = null;
      row.attemptCount = input.attemptCount;
      row.failureCode = input.failureCode;
      row.nextAttemptAt = input.nextAttemptAt;
      return true;
    },
    async inspect(id) {
      const row = rows.get(id)?.row;
      return row ? structuredClone(row) : null;
    },
  };
}

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function notificationRow(row: {
  id: string;
  reviewRoundId: string;
  recipientId: string;
  kind: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: Date;
  claimId: string | null;
  leaseExpiresAt: Date | null;
  providerMessageId: string | null;
  failureCode: string | null;
  sentAt: Date | null;
  createdAt: Date;
  reviewRound: { projectId: string };
}): ReviewNotificationRow {
  return {
    ...row,
    projectId: row.reviewRound.projectId,
    kind: row.kind as ReviewNotificationKind,
    status: row.status as ReviewNotificationStatus,
  };
}

export function createPrismaReviewNotificationStore(config: {
  appBaseUrl: string;
  accessSecret: string;
  dataSecret: string;
}): ReviewNotificationStore {
  const baseUrl = new URL(config.appBaseUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("Review app base URL must use HTTP(S)");
  }
  return {
    async listDue(input) {
      const rows = await requirePrisma().reviewNotification.findMany({
        where: {
          nextAttemptAt: { lte: input.now },
          OR: [
            { status: "pending" },
            { status: "claimed", leaseExpiresAt: { lte: input.now } },
          ],
        },
        include: { reviewRound: { select: { projectId: true } } },
        orderBy: { createdAt: "asc" },
        take: input.limit,
      });
      return rows.map(notificationRow);
    },
    async claim(input) {
      const claimed = await requirePrisma().reviewNotification.updateMany({
        where: {
          id: input.id,
          attemptCount: { lt: input.maxAttempts },
          nextAttemptAt: { lte: input.now },
          OR: [
            { status: "pending" },
            { status: "claimed", leaseExpiresAt: { lte: input.now } },
          ],
        },
        data: {
          status: "claimed",
          claimId: input.claimId,
          leaseExpiresAt: input.leaseExpiresAt,
        },
      });
      if (claimed.count !== 1) return null;
      const row = await requirePrisma().reviewNotification.findUniqueOrThrow({
        where: { id: input.id },
        include: { reviewRound: { select: { projectId: true } } },
      });
      return notificationRow(row);
    },
    async deliveryContext(id) {
      const row = await requirePrisma().reviewNotification.findUnique({
        where: { id },
        select: {
          recipient: {
            select: { role: true, emailEncrypted: true },
          },
          reviewRound: {
            select: {
              id: true,
              revision: true,
              projectId: true,
              project: { select: { title: true } },
            },
          },
        },
      });
      if (!row) return null;
      const audience =
        row.recipient.role === "reviewer" ? "guest" : "internal";
      const actionUrl =
        audience === "guest"
          ? new URL(
              `/review/${encodeURIComponent(
                deriveReviewAccessToken(
                  row.reviewRound.id,
                  config.accessSecret,
                ),
              )}`,
              baseUrl,
            ).toString()
          : new URL(
              `/projects/${encodeURIComponent(
                row.reviewRound.projectId,
              )}?tab=review`,
              baseUrl,
            ).toString();
      return {
        to: decryptReviewEmail(
          row.recipient.emailEncrypted,
          config.dataSecret,
        ),
        projectTitle: row.reviewRound.project.title,
        roundNumber: row.reviewRound.revision,
        audience,
        actionUrl,
      };
    },
    async markSent(input) {
      const updated = await requirePrisma().reviewNotification.updateMany({
        where: { id: input.id, status: "claimed", claimId: input.claimId },
        data: {
          status: "sent",
          claimId: null,
          leaseExpiresAt: null,
          providerMessageId: input.providerMessageId,
          failureCode: null,
          sentAt: input.sentAt,
        },
      });
      return updated.count === 1;
    },
    async markFailure(input) {
      const updated = await requirePrisma().reviewNotification.updateMany({
        where: { id: input.id, status: "claimed", claimId: input.claimId },
        data: {
          status: input.status,
          claimId: null,
          leaseExpiresAt: null,
          attemptCount: input.attemptCount,
          failureCode: input.failureCode,
          nextAttemptAt: input.nextAttemptAt,
        },
      });
      return updated.count === 1;
    },
  };
}

export function createProductionReviewNotificationDelivery(config: {
  appBaseUrl: string;
  accessSecret: string;
  dataSecret: string;
}) {
  return createReviewNotificationDelivery({
    store: createPrismaReviewNotificationStore(config),
    admissionEnabled: () =>
      reviewRolloutPolicy.isEnabled("notification_admission"),
    mailer: async (input) => {
      const template = reviewNotification({
        kind: input.kind,
        projectTitle: input.projectTitle,
        roundNumber: input.roundNumber,
        actionUrl: input.actionUrl,
      });
      return sendEmail({
        to: input.to,
        subject: template.subject,
        html: template.html,
        text: template.text,
        idempotencyKey: input.idempotencyKey,
      });
    },
  });
}
