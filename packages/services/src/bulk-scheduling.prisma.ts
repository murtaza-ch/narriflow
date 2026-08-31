import { randomUUID } from "node:crypto";

import { Prisma, type CampaignOperation, type PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import { clipAspectRatioToDb, socialProviderAcceptsMedia } from "@narriflow/validators";

import type { AssistedCopyContent } from "./assisted-copy.service";
import { brandOwnerWhereForWorkspace } from "./brand-ownership";
import {
  BulkSchedulingError,
  BulkScheduleReconciliationRequiredError,
  BulkScheduleItemError,
  createBulkSchedulingService,
  type BulkPublicationScheduler,
  type BulkScheduleItemResult,
  type BulkSchedulingStore,
  type StoredBulkScheduleResult,
} from "./bulk-scheduling.service";
import { hasFeature } from "./plan-features";
import {
  assertCampaignActionWriteEnabled,
  assertPublishingPreparationWriteEnabled,
} from "./program-rollout";
import { withSerializableTransaction } from "./serializable-transaction";
import {
  createProductionSocialPublicationScheduling,
  PublicationIntentConflictError,
  PublicationIntentStateError,
  publicationIntentHash,
  type SchedulePublicationInput,
} from "./social-publication-scheduling";
import {
  ReviewApprovalOverrideConflictError,
  ReviewApprovalRequiredError,
  ReviewApprovalTargetError,
  ReviewOverrideForbiddenError,
} from "./review-approval.service";
import { workspaceService } from "./workspace.service";

const ACTION = "bulk_schedule";
const CLAIM_LEASE_MS = 30_000;
const REPLAY_WAIT_MS = 5_000;

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

function parseCopy(value: Prisma.JsonValue | null): AssistedCopyContent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const content = value as Record<string, Prisma.JsonValue>;
  if (
    typeof content.caption !== "string" ||
    !Array.isArray(content.hashtags) ||
    content.hashtags.some((tag) => typeof tag !== "string") ||
    !(content.title === null || typeof content.title === "string")
  ) {
    return null;
  }
  return {
    caption: content.caption,
    hashtags: content.hashtags as string[],
    title: content.title,
  };
}

function parseItemResult(value: Prisma.JsonValue | null): {
  item: BulkScheduleItemResult;
  position: number;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, Prisma.JsonValue>;
  if (
    typeof item.itemKey !== "string" ||
    typeof item.clipId !== "string" ||
    typeof item.accountId !== "string" ||
    (item.status !== "scheduled" && item.status !== "failed") ||
    !(item.postId === null || typeof item.postId === "string") ||
    !(item.scheduledFor === null || typeof item.scheduledFor === "string") ||
    !(item.errorCode === null || typeof item.errorCode === "string") ||
    typeof item.position !== "number" ||
    !Number.isSafeInteger(item.position) ||
    item.position < 0
  ) {
    return null;
  }
  return {
    position: item.position,
    item: {
      itemKey: item.itemKey,
      clipId: item.clipId,
      accountId: item.accountId,
      status: item.status,
      postId: item.postId,
      scheduledFor: item.scheduledFor,
      errorCode: item.errorCode,
    },
  };
}

async function storedResult(
  prisma: PrismaClient,
  operation: CampaignOperation,
): Promise<StoredBulkScheduleResult | null> {
  if (!["completed", "partial", "failed"].includes(operation.status)) return null;
  const rows = await prisma.campaignOperationItem.findMany({
    where: { operationId: operation.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { result: true },
  });
  const storedItems = rows.map((row) => parseItemResult(row.result));
  if (
    storedItems.some((item) => item === null) ||
    storedItems.length !== operation.requestedCount
  ) {
    throw new BulkSchedulingError(
      "bulk_schedule_result_incomplete",
      "The durable bulk-scheduling result is incomplete",
    );
  }
  const items = storedItems
    .map((item) => item!)
    .sort((left, right) => left.position - right.position)
    .map(({ item }) => item);
  const scheduled = items.filter((item) => item!.status === "scheduled").length;
  return {
    operationId: operation.id,
    status:
      operation.status === "completed"
        ? "completed"
        : operation.status === "partial"
          ? "partial"
          : "failed",
    counts: { scheduled, failed: items.length - scheduled },
    items,
  };
}

async function waitForStoredResult(
  prisma: PrismaClient,
  operationId: string,
): Promise<StoredBulkScheduleResult | null> {
  const deadline = Date.now() + REPLAY_WAIT_MS;
  while (Date.now() < deadline) {
    const operation = await prisma.campaignOperation.findUnique({
      where: { id: operationId },
    });
    if (!operation) return null;
    const result = await storedResult(prisma, operation);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return null;
}

export function createPrismaBulkSchedulingStore(
  prisma: PrismaClient = requirePrisma(),
): BulkSchedulingStore {
  return {
    async readAccount(input) {
      const account = await prisma.socialAccount.findFirst({
        where: {
          id: input.accountId,
          workspaceId: input.workspaceId,
        },
        select: {
          id: true,
          workspaceId: true,
          platform: true,
          status: true,
          expiresAt: true,
					refreshTokenEncrypted: true,
        },
      });
      if (!account?.workspaceId) return null;
      return {
        id: account.id,
        workspaceId: account.workspaceId,
        platform: account.platform,
        status:
          account.status === "active"
            ? "active"
            : account.status === "expired"
              ? "expired"
              : "revoked",
        expiresAt: account.expiresAt,
		refreshable: account.refreshTokenEncrypted !== null,
      };
    },

    async readCopy(input) {
      const draft = await prisma.assistedCopyDraft.findFirst({
        where: {
          id: input.draftId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
        },
      });
      if (!draft) return null;
      return {
        id: draft.id,
        workspaceId: draft.workspaceId,
        projectId: draft.projectId,
        clipId: draft.clipId,
        platform: draft.platform,
        status: draft.status as
          | "generating"
          | "completed"
          | "rejected"
          | "failed"
          | "unknown",
        revision: draft.revision,
        confirmed: draft.confirmedAt !== null,
        content: parseCopy(draft.content),
      };
    },

    async readThumbnail(input) {
      const workspace = await prisma.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { personalOwnerUserId: true },
      });
      if (!workspace) return null;
      const asset = await prisma.visualAsset.findFirst({
        where: {
          id: input.assetId,
          ...brandOwnerWhereForWorkspace({
            workspaceId: input.workspaceId,
            personalOwnerUserId: workspace.personalOwnerUserId,
          }),
        },
        select: {
          id: true,
					kind: true,
					contentType: true,
					sizeBytes: true,
					fingerprint: true,
          provenance: true,
          sourceExportVariantId: true,
					sourceTimeMs: true,
          deletedAt: true,
        },
      });
      if (!asset) return null;
      return {
        id: asset.id,
        workspaceId: input.workspaceId,
				kind: asset.kind,
				contentType: asset.contentType,
				sizeBytes: Number(asset.sizeBytes),
				fingerprint: asset.fingerprint,
        provenance: asset.provenance,
        sourceExportVariantId: asset.sourceExportVariantId,
				sourceTimeMs: asset.sourceTimeMs,
        deletedAt: asset.deletedAt,
      };
    },

    async open(input) {
      const workspace = await prisma.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { pricingTier: true },
      });
      if (!workspace) {
        throw new BulkSchedulingError(
          "bulk_schedule_workspace_not_found",
          "The workspace is unavailable",
        );
      }

      let operation = await prisma.campaignOperation.findUnique({
        where: {
          workspaceId_projectId_action_idempotencyKey: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            action: ACTION,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (!operation) {
        try {
          operation = await prisma.campaignOperation.create({
            data: {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              actorUserId: input.actorUserId,
              action: ACTION,
              idempotencyKey: input.idempotencyKey,
              requestFingerprint: input.requestFingerprint,
              validatedOptions: { contract: "bulk-scheduling-v1" },
              pricingTier: workspace.pricingTier,
              requestedCount: input.requestedCount,
            },
          });
        } catch (error) {
          if (!isUniqueConstraintError(error)) throw error;
          operation = await prisma.campaignOperation.findUnique({
            where: {
              workspaceId_projectId_action_idempotencyKey: {
                workspaceId: input.workspaceId,
                projectId: input.projectId,
                action: ACTION,
                idempotencyKey: input.idempotencyKey,
              },
            },
          });
        }
      }
      if (!operation) throw new Error("Bulk scheduling operation disappeared");
      if (operation.requestFingerprint !== input.requestFingerprint) {
        throw new BulkSchedulingError(
          "bulk_schedule_idempotency_conflict",
          "The idempotency key was already used with different scheduling inputs",
        );
      }
      const replay = await storedResult(prisma, operation);
      if (replay) return { result: replay, replayed: true };

      const claimToken = randomUUID();
      const now = new Date();
      const claimed = await prisma.campaignOperation.updateMany({
        where: {
          id: operation.id,
          status: "running",
          OR: [{ claimToken: null }, { leaseExpiresAt: { lte: now } }],
        },
        data: {
          claimToken,
          leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS),
        },
      });
      if (claimed.count !== 1) {
        const completed = await waitForStoredResult(prisma, operation.id);
        if (completed) return { result: completed, replayed: true };
        throw new BulkSchedulingError(
          "bulk_schedule_in_progress",
          "This bulk-scheduling request is still being processed",
        );
      }

      try {
        const result = await input.execute(operation.id);
        await withSerializableTransaction(prisma, async (tx) => {
          const owned = await tx.campaignOperation.findFirst({
            where: { id: operation!.id, status: "running", claimToken },
						select: { id: true },
					});
          if (!owned) {
            throw new BulkSchedulingError(
              "bulk_schedule_claim_lost",
              "Bulk scheduling ownership was lost before settlement",
            );
          }
          const scheduledPostIds = result.items.flatMap((item) =>
            item.status === "scheduled" && item.postId ? [item.postId] : [],
          );
          const scheduledPosts =
            scheduledPostIds.length === 0
              ? []
              : await tx.socialPost.findMany({
                  where: {
                    id: { in: scheduledPostIds },
                    workspaceId: input.workspaceId,
                    projectId: input.projectId,
                  },
                  select: { id: true, reviewApprovalOverrideId: true },
                });
          const overrideByPostId = new Map(
            scheduledPosts.map((post) => [
              post.id,
              post.reviewApprovalOverrideId,
            ]),
          );
          for (const [position, item] of result.items.entries()) {
            const storedItem = {
              ...item,
              position,
            } as unknown as Prisma.InputJsonValue;
            const reviewApprovalOverrideId = item.postId
              ? (overrideByPostId.get(item.postId) ?? null)
              : null;
            await tx.campaignOperationItem.upsert({
              where: {
                operationId_itemKey: {
                  operationId: operation!.id,
                  itemKey: item.itemKey,
                },
              },
              update: {
                clipId: item.clipId,
                reviewApprovalOverrideId,
                status: item.status === "scheduled" ? "succeeded" : "failed",
                errorCode: item.errorCode,
                result: storedItem,
                settledAt: new Date(),
              },
              create: {
                operationId: operation!.id,
                itemKey: item.itemKey,
                requestedClipId: item.clipId,
                clipId: item.clipId,
                reviewApprovalOverrideId,
                status: item.status === "scheduled" ? "succeeded" : "failed",
                errorCode: item.errorCode,
                result: storedItem,
                settledAt: new Date(),
              },
            });
          }
          const settled = await tx.campaignOperation.updateMany({
            where: { id: operation!.id, status: "running", claimToken },
            data: {
              status: result.status,
              succeededCount: result.counts.scheduled,
              failedCount: result.counts.failed,
              completedAt: new Date(),
              claimToken: null,
              leaseExpiresAt: null,
            },
          });
          if (settled.count !== 1) {
            throw new BulkSchedulingError(
              "bulk_schedule_claim_lost",
              "Bulk scheduling ownership was lost before settlement",
            );
          }
        });
        const durable = await prisma.campaignOperation.findUniqueOrThrow({
          where: { id: operation.id },
        });
        return {
          result: (await storedResult(prisma, durable)) ?? result,
          replayed: false,
        };
      } catch (error) {
        await prisma.campaignOperation.updateMany({
          where: { id: operation.id, status: "running", claimToken },
          data: { claimToken: null, leaseExpiresAt: null },
        });
        throw error;
      }
    },
  };
}

export function createProductionBulkSchedulingService(
  scheduler: BulkPublicationScheduler,
) {
  return createBulkSchedulingService({
    store: createPrismaBulkSchedulingStore(),
    scheduler,
    async authorize(scope) {
      assertPublishingPreparationWriteEnabled("bulk_scheduling");
      assertCampaignActionWriteEnabled("schedule_selected");
      const actor = await workspaceService.requireActor(
        scope.actorUserId,
        scope.workspaceId,
        "publishing.manage",
      );
      if (!hasFeature(actor.pricingTier, "campaign.operations")) {
        throw new BulkSchedulingError(
          "bulk_schedule_feature_unavailable",
          "Bulk scheduling is unavailable on this plan",
        );
      }
    },
    diagnostics(event) {
      console.warn(
        JSON.stringify({
          level: "info",
          message: "bulk_scheduling_event",
          ...event,
          ts: new Date().toISOString(),
        }),
      );
    },
  });
}

export function createProductionBulkPublicationScheduler(
  options: {
    findExactVariant?: (
      input: Parameters<BulkPublicationScheduler["schedule"]>[0],
    ) => Promise<{ id: string; durationSec: number | null } | null>;
    publicationScheduling?: {
      schedule(input: SchedulePublicationInput): Promise<{
        id: string;
        status: "preparing_video" | "scheduled" | "cancelled";
      }>;
    };
    findCommittedIntent?: (input: {
      workspaceId: string;
      clientIdempotencyKey: string;
    }) => Promise<{
      id: string;
      status: "preparing_video" | "scheduled" | "cancelled";
      immutableRequestHash: string;
    } | null>;
  } = {},
): BulkPublicationScheduler {
  const publicationScheduling =
    options.publicationScheduling ?? createProductionSocialPublicationScheduling();
  const findCommittedIntent =
    options.findCommittedIntent ??
    (async (input: { workspaceId: string; clientIdempotencyKey: string }) =>
      requirePrisma().socialPost.findUnique({
        where: {
          workspaceId_clientIdempotencyKey: input,
        },
        select: {
          id: true,
          status: true,
          immutableRequestHash: true,
        },
      }).then((post) => {
        if (
          !post?.immutableRequestHash ||
          !["preparing_video", "scheduled", "cancelled"].includes(post.status)
        ) {
          return null;
        }
        return {
          id: post.id,
          status: post.status as "preparing_video" | "scheduled" | "cancelled",
          immutableRequestHash: post.immutableRequestHash,
        };
      }));
  return {
    async schedule(input) {
      const exactVariant = options.findExactVariant
        ? await options.findExactVariant(input)
        : await requirePrisma().clipExportVariant.findFirst({
            where: {
              id: input.exportVariantId,
              aspectRatio: clipAspectRatioToDb[input.aspectRatio],
              resolution: input.resolution,
              status: "completed",
              storageKey: { not: null },
              export: {
                projectId: input.projectId,
                clipId: input.clipId,
                editorRevision: input.expectedEditorRevision,
                project: { workspaceId: input.workspaceId },
              },
            },
            select: { id: true, durationSec: true },
          });
      if (!exactVariant) {
        throw new BulkScheduleItemError(
          "bulk_schedule_export_invalid",
          "The selected immutable export is unavailable or no longer matches the clip revision",
        );
      }
			if (
				exactVariant.durationSec === null ||
				Math.abs(exactVariant.durationSec - input.durationSec) > 0.001 ||
				!socialProviderAcceptsMedia({
					platform: input.platform,
					aspectRatio: input.aspectRatio,
					durationSec: exactVariant.durationSec,
				})
			) {
				throw new BulkScheduleItemError(
					"bulk_schedule_media_unsupported",
					"The selected immutable export does not satisfy the destination duration contract",
				);
			}
      const scheduleInput: SchedulePublicationInput = {
        actorUserId: input.actorUserId,
        approvalPrincipal: input.approvalPrincipal,
        ownerUserId: input.ownerUserId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        clientIdempotencyKey: input.clientIdempotencyKey,
        clipId: input.clipId,
        expectedEditorRevision: input.expectedEditorRevision,
        accountId: input.accountId,
        platform: input.platform,
        caption: input.caption,
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        scheduledFor: input.scheduledFor,
        providerSettings: input.providerSettings as Prisma.JsonObject,
        approvalOverrideReason: input.approvalOverrideReason,
        requiredExportVariantId: input.exportVariantId,
        assistedCopyDraftId: input.assistedCopyDraftId,
        assistedCopyRevision: input.assistedCopyRevision,
        thumbnailAssetId:
          typeof input.providerSettings.thumbnailAssetId === "string"
            ? input.providerSettings.thumbnailAssetId
            : null,
				thumbnailFingerprint:
					typeof input.providerSettings.thumbnailFingerprint === "string"
						? input.providerSettings.thumbnailFingerprint
						: null,
      };
      let intent: Awaited<ReturnType<typeof publicationScheduling.schedule>>;
      try {
        intent = await publicationScheduling.schedule(scheduleInput);
      } catch (error) {
        if (
          error instanceof BulkScheduleItemError ||
          error instanceof PublicationIntentConflictError ||
          error instanceof PublicationIntentStateError ||
          error instanceof ReviewApprovalRequiredError ||
          error instanceof ReviewOverrideForbiddenError ||
          error instanceof ReviewApprovalOverrideConflictError ||
          error instanceof ReviewApprovalTargetError
        ) {
          throw error;
        }
        let committed: Awaited<ReturnType<typeof findCommittedIntent>>;
        try {
          committed = await findCommittedIntent({
            workspaceId: input.workspaceId,
            clientIdempotencyKey: input.clientIdempotencyKey,
          });
        } catch {
          throw new BulkScheduleReconciliationRequiredError();
        }
        if (!committed) throw new BulkScheduleReconciliationRequiredError();
        if (committed.immutableRequestHash !== publicationIntentHash(scheduleInput)) {
          throw new BulkScheduleItemError(
            "bulk_schedule_publication_conflict",
            "The publication idempotency key is bound to different immutable inputs",
          );
        }
        if (committed.status === "cancelled") {
          throw new BulkScheduleItemError(
            "bulk_schedule_publication_cancelled",
            "The reconciled publication intent was cancelled",
          );
        }
        intent = committed;
      }
      return {
        postId: intent.id,
        status:
          intent.status === "preparing_video" ? "preparing_video" : "scheduled",
      };
    },
  };
}

export function createProductionBulkSchedulingRuntime() {
  return createProductionBulkSchedulingService(
    createProductionBulkPublicationScheduler(),
  );
}
