import { retryNotificationDeliveryWithinTransaction } from "./notification-execution";

import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@narriflow/db/client";

import { accessibleProjectWhere } from "./project-access";

import { signReviewOptOutToken } from "./review-opt-out";

import { decryptReviewValue, reviewDeliverySecret } from "./review.service";

export type ReviewNotificationKind = "round_sent" | "first_change_requested" | "all_approved" | "mention";

export interface ReviewNotificationContext {
    ledgerId: string;
    recipient: string;
    projectTitle: string;
    roundTitle: string;
    reviewPath: string;
    kind: ReviewNotificationKind;
    /** For a round a Standing Grant sent: the signed link that stops automated review requests from the Workspace. */
    optOut: {
        path: string;
        workspaceName: string;
    } | null;
}

export interface ReviewNotificationStore {
    getContext(id: string): Promise<ReviewNotificationContext | null>;
    retry(scope: {
        workspaceId: string;
        projectId: string;
    }, reviewRoundId: string, id: string, now: Date): Promise<boolean>;
}

export interface ReviewNotificationMailInput {
    to: string;
    kind: ReviewNotificationKind;
    projectTitle: string;
    roundTitle: string;
    reviewUrl: string;
    /** Present on a round a Standing Grant sent. */
    optOut?: {
        url: string;
        workspaceName: string;
    };
    idempotencyKey: string;
}

function requirePrisma() {
    const prisma = getPrismaClient();
    if (!prisma)
        throw new Error("Database client unavailable");
    return prisma;
}

export function createReviewNotificationStore(transaction?: Prisma.TransactionClient): ReviewNotificationStore {
    return {
        async getContext(id) {
            const ledger = await (transaction ?? requirePrisma()).reviewNotificationLedger.findUnique({
                where: { id, reviewRound: { project: accessibleProjectWhere() } },
                include: { reviewRound: { select: {
                            id: true,
                            title: true,
                            status: true,
                            revokedAt: true,
                            expiresAt: true,
                            projectId: true,
                            deliveryTokenEncrypted: true,
                            workspaceId: true,
                            standingGrantId: true,
                            workspace: { select: { name: true } },
                            project: { select: { title: true } },
                        } } },
            });
            if (!ledger)
                return null;
            if (ledger.kind === "round_sent" && ledger.reviewRound.standingGrantId && await (transaction ?? requirePrisma()).reviewerOptOut.findUnique({ where: { workspaceId_email: { workspaceId: ledger.reviewRound.workspaceId, email: ledger.recipientEmail.trim().toLowerCase() } } }))
                return null;
            const kind = ledger.kind as ReviewNotificationKind;
            if (!(["round_sent", "first_change_requested", "all_approved", "mention"] as const).includes(kind))
                return null;
            const internal = kind === "first_change_requested" || kind === "all_approved";
            if (!internal && (ledger.reviewRound.status !== "open" || ledger.reviewRound.revokedAt ||
                (ledger.reviewRound.expiresAt && ledger.reviewRound.expiresAt <= new Date())))
                return null;
            return {
                ledgerId: ledger.id,
                recipient: ledger.recipientEmail,
                projectTitle: ledger.reviewRound.project.title,
                roundTitle: ledger.reviewRound.title,
                reviewPath: internal
                    ? `/projects/${ledger.reviewRound.projectId}?tab=review`
                    : `/review/${decryptReviewValue(ledger.reviewRound.deliveryTokenEncrypted, reviewDeliverySecret())}`,
                kind,
                optOut: kind === "round_sent" && ledger.reviewRound.standingGrantId
                    ? {
                        path: `/review/opt-out?token=${encodeURIComponent(signReviewOptOutToken({ workspaceId: ledger.reviewRound.workspaceId, email: ledger.recipientEmail }, reviewDeliverySecret()))}`,
                        workspaceName: ledger.reviewRound.workspace.name,
                    }
                    : null,
            };
        },
        async retry(scope, reviewRoundId, id, _now) {
            const run = async (tx: Prisma.TransactionClient) => {
                const owned = await tx.reviewNotificationLedger.findFirst({ where: { id, reviewRoundId, reviewRound: { workspaceId: scope.workspaceId, projectId: scope.projectId } }, select: { id: true } });
                return owned ? retryNotificationDeliveryWithinTransaction(tx, { kind: "review", id }, scope) : false;
            };
            return transaction ? run(transaction) : requirePrisma().$transaction(run);
        }
    };
}

export async function buildReviewNotificationMail(input: ReviewNotificationMailInput) {
    const email = await import("@narriflow/email/worker");
    const template = email.reviewNotification({
        kind: input.kind,
        projectTitle: input.projectTitle,
        roundTitle: input.roundTitle,
        reviewUrl: input.reviewUrl,
        optOut: input.optOut,
    });
    return {
        to: input.to,
        ...template,
        idempotencyKey: input.idempotencyKey,
    };
}
