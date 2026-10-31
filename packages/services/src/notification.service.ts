
import { getPrismaClient } from "@narriflow/db/client";

import { finishingPicksSchema } from "@narriflow/validators";

import { accessibleProjectWhere } from "./project-access";

export type NotificationOutcome = "clips_ready" | "no_clips" | "generation_failed" | "import_failed" | "project_expiring" | "finishing_ready";

export interface NotificationProject {
    id: string;
    title: string;
    notifyOnComplete: boolean;
    primaryEmail: string | null;
    emailVerifiedAt: Date | null;
    expiresAt: Date | null;
    clipCount: number;
}

/** Who a finishing notification goes to: the person the finishing ran for,
 * not the Workspace owner the other outcomes address. */
export interface FinishingDelivery {
    primaryEmail: string | null;
    emailVerifiedAt: Date | null;
    /** The clips finishing exported, for a retry that has only the ledger row. */
    clipCount: number;
}

export interface NotificationStore {
    getProject(projectId: string): Promise<NotificationProject | null>;
    /** A `finishing_ready` ledger row's source is its Generation Finishing id. */
    getFinishingDelivery?(finishingId: string): Promise<FinishingDelivery | null>;
}

export interface NotificationMailInput {
    to: string;
    outcome: NotificationOutcome;
    projectTitle: string;
    clipCount: number;
    reason: string;
    deepLink: string;
    expiresAt: string | null;
    idempotencyKey: string;
}

export interface NotificationMailResult {
    sent: boolean;
    id?: string;
    error?: string;
    reason?: string;
}

export function createNotificationStore(): NotificationStore {
    function requirePrisma() {
        const prisma = getPrismaClient();
        if (!prisma) {
            throw new Error("Database client unavailable");
        }
        return prisma;
    }
    return {
        async getProject(projectId) {
            const row = await requirePrisma().project.findFirst({
                where: { id: projectId, ...accessibleProjectWhere() },
                select: {
                    id: true,
                    title: true,
                    notifyOnComplete: true,
                    expiresAt: true,
                    workspace: {
                        select: { owner: { select: { primaryEmail: true, emailVerifiedAt: true } } },
                    },
                    _count: { select: { clips: true } },
                },
            });
            return row
                ? {
                    id: row.id,
                    title: row.title,
                    notifyOnComplete: row.notifyOnComplete,
                    primaryEmail: row.workspace.owner.primaryEmail,
                    emailVerifiedAt: row.workspace.owner.emailVerifiedAt,
                    expiresAt: row.expiresAt,
                    clipCount: row._count.clips,
                }
                : null;
        },
        async getFinishingDelivery(finishingId) {
            const prisma = requirePrisma();
            const finishing = await prisma.generationFinishing.findUnique({
                where: { id: finishingId },
                select: { actorUserId: true, workspaceId: true, picks: true },
            });
            if (!finishing?.actorUserId)
                return null;
            const member = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: finishing.workspaceId, userId: finishing.actorUserId } }, select: { role: true } });
            if (!member || member.role === "viewer")
                return null;
            const user = await prisma.user.findFirst({
                where: { id: finishing.actorUserId, deletedAt: null },
                select: { primaryEmail: true, emailVerifiedAt: true },
            });
            if (!user)
                return null;
            const picks = finishingPicksSchema.catch([]).parse(finishing.picks);
            return {
                primaryEmail: user.primaryEmail,
                emailVerifiedAt: user.emailVerifiedAt,
                clipCount: picks.filter((pick) => pick.exportId && !pick.exportError).length,
            };
        }
    };
}

export async function buildNotificationMail(input: NotificationMailInput) {
    const emailModule = await import("@narriflow/email/worker");
    const email = emailModule as {
        clipsReady: (input: {
            clipCount: number;
            projectTitle: string;
            deepLink: string;
        }) => {
            subject: string;
            html: string;
            text: string;
        };
        noClipsFound: (input: {
            projectTitle: string;
            deepLink: string;
        }) => {
            subject: string;
            html: string;
            text: string;
        };
        generationFailed: (input: {
            projectTitle: string;
            reason: string;
            retryLink: string;
            kind?: "generation" | "import";
        }) => {
            subject: string;
            html: string;
            text: string;
        };
        projectExpiring: (input: {
            projectTitle: string;
            expiresAt: string;
            upgradeLink: string;
        }) => {
            subject: string;
            html: string;
            text: string;
        };
        finishingReady: (input: {
            clipCount: number;
            projectTitle: string;
            deepLink: string;
        }) => {
            subject: string;
            html: string;
            text: string;
        };
        sendEmail: (input: {
            to: string;
            subject: string;
            html: string;
            text: string;
            idempotencyKey: string;
        }) => Promise<NotificationMailResult>;
    };
    const template = input.outcome === "project_expiring" && input.expiresAt
        ? email.projectExpiring({
            projectTitle: input.projectTitle,
            expiresAt: input.expiresAt,
            upgradeLink: input.deepLink,
        })
        : input.outcome === "finishing_ready"
            ? email.finishingReady({
                clipCount: input.clipCount,
                projectTitle: input.projectTitle,
                deepLink: input.deepLink,
            })
            : input.outcome === "clips_ready"
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
    return {
        to: input.to,
        ...template,
        idempotencyKey: input.idempotencyKey,
    };
}
