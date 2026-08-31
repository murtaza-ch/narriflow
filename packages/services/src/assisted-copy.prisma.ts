import { Prisma, type AssistedCopyDraft } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  brandVoiceGuidanceSchema,
  type SocialPlatform,
} from "@narriflow/validators";
import { analyticsService } from "./analytics.service";
import {
  ASSISTED_COPY_GENERATION_DEADLINE_MS,
  AssistedCopyError,
  createAssistedCopyService,
  type AssistedCopyContent,
  type AssistedCopyRecord,
  type AssistedCopyStore,
  type AssistedCopyVoiceGuidance,
} from "./assisted-copy.service";
import { createOpenAiAssistedCopyProvider } from "./openai-assisted-copy.provider";
import { hasFeature } from "./plan-features";
import { assertPublishingPreparationWriteEnabled } from "./program-rollout";
import { workspaceService } from "./workspace.service";

function requirePrisma() {
  const prisma = getPrismaClient();
  if (!prisma) throw new Error("Database client unavailable");
  return prisma;
}

function copyContent(value: Prisma.JsonValue | null): AssistedCopyContent | null {
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

function record(row: AssistedCopyDraft): AssistedCopyRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    actorUserId: row.actorUserId,
    clipId: row.clipId,
    platform: row.platform,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    sourceDraftId: row.sourceDraftId,
    status: row.status as AssistedCopyRecord["status"],
    revision: row.revision,
    content: copyContent(row.content),
    confirmed: row.confirmedAt !== null,
    confirmedAt: row.confirmedAt,
    modelAlias: row.modelAlias,
    promptVersion: row.promptVersion,
    moderationOutcome:
      row.moderationOutcome as AssistedCopyRecord["moderationOutcome"],
    errorCode: row.errorCode,
    brandProfileId: row.brandProfileId,
    brandProfileRevision: row.brandProfileRevision,
    guidanceSkipped: row.guidanceSkipped,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function voiceFromSnapshot(value: Prisma.JsonValue | null): {
  profileId: string;
  profileRevision: number;
  voice: AssistedCopyVoiceGuidance | null;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, Prisma.JsonValue>;
  if (
    typeof snapshot.profileId !== "string" ||
    typeof snapshot.profileRevision !== "number"
  ) {
    return null;
  }
  const parsed = brandVoiceGuidanceSchema.safeParse(snapshot.voice);
  if (!parsed.success) {
    return {
      profileId: snapshot.profileId,
      profileRevision: snapshot.profileRevision,
      voice: null,
    };
  }
  const guidance = parsed.data;
  const hasGuidance = Boolean(
    guidance.audience ||
      guidance.tone.length ||
      guidance.preferredTerms.length ||
      guidance.blockedTerms.length ||
      guidance.hashtagGuidance,
  );
  return {
    profileId: snapshot.profileId,
    profileRevision: snapshot.profileRevision,
    voice: hasGuidance
      ? {
          tone: guidance.tone.join(", ") || "clear and direct",
          audience: guidance.audience || "the intended social audience",
          preferredPhrases: guidance.preferredTerms,
          avoidedPhrases: guidance.blockedTerms,
          hashtagGuidance: guidance.hashtagGuidance,
        }
      : null,
  };
}

export function createPrismaAssistedCopyStore(): AssistedCopyStore {
  return {
    async readContext(input) {
      const clip = await requirePrisma().clip.findFirst({
        where: {
          id: input.clipId,
          projectId: input.projectId,
          project: { workspaceId: input.workspaceId },
        },
        select: {
          id: true,
          title: true,
          hookText: true,
          payoffText: true,
          project: { select: { brandProfileSnapshot: true } },
        },
      });
      if (!clip) return null;
      const frozen = voiceFromSnapshot(clip.project.brandProfileSnapshot);
      return {
        clipId: clip.id,
        title: clip.title,
        hook: clip.hookText,
        payoff: clip.payoffText,
        brandProfileId: frozen?.profileId ?? null,
        brandProfileRevision: frozen?.profileRevision ?? null,
        voiceGuidance: frozen?.voice ?? null,
      };
    },

    async reserve(input) {
      const prisma = requirePrisma();
      try {
        const created = await prisma.assistedCopyDraft.create({
          data: {
            id: input.id,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            actorUserId: input.actorUserId,
            clipId: input.clipId,
            platform: input.platform,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            sourceDraftId: input.sourceDraftId,
            status: input.status,
            revision: input.revision,
            content: Prisma.JsonNull,
            confirmedAt: null,
            modelAlias: null,
            promptVersion: input.promptVersion,
            moderationOutcome: input.moderationOutcome,
            errorCode: null,
            brandProfileId: input.brandProfileId,
            brandProfileRevision: input.brandProfileRevision,
            guidanceSkipped: input.guidanceSkipped,
            inputTokens: null,
            outputTokens: null,
            generationDeadline: new Date(
              input.createdAt.getTime() + ASSISTED_COPY_GENERATION_DEADLINE_MS,
            ),
            createdAt: input.createdAt,
          },
        });
        return { record: record(created), created: true };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
          throw error;
        }
      }

      const existing = await prisma.assistedCopyDraft.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: input.workspaceId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (!existing) throw new Error("Assisted-copy idempotency row disappeared");
      if (
        existing.status === "generating" &&
        existing.generationDeadline <= input.createdAt
      ) {
        await prisma.assistedCopyDraft.updateMany({
          where: {
            id: existing.id,
            status: "generating",
            generationDeadline: { lte: input.createdAt },
          },
          data: {
            status: "unknown",
            moderationOutcome: "unknown",
            errorCode: "assisted_copy_provider_outcome_unknown",
          },
        });
      }
      return {
        record: record(
          await prisma.assistedCopyDraft.findUniqueOrThrow({ where: { id: existing.id } }),
        ),
        created: false,
      };
    },

    async reconcileOverdue(input) {
      const reconciled = await requirePrisma().assistedCopyDraft.updateMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          status: "generating",
          generationDeadline: { lte: input.now },
          ...(input.id ? { id: input.id } : {}),
          ...(input.platform ? { platform: input.platform } : {}),
        },
        data: {
          status: "unknown",
          moderationOutcome: "unknown",
          errorCode: "assisted_copy_provider_outcome_unknown",
          updatedAt: input.now,
        },
      });
      return reconciled.count;
    },

    async settle(input) {
      const prisma = requirePrisma();
      const settled = await prisma.assistedCopyDraft.updateMany({
        where: {
          id: input.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          status: "generating",
        },
        data: {
          status: input.status,
          content: input.content
            ? (input.content as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          modelAlias: input.modelAlias,
          moderationOutcome: input.moderationOutcome,
          errorCode: input.errorCode,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          updatedAt: input.now,
        },
      });
      const row = await prisma.assistedCopyDraft.findFirst({
        where: {
          id: input.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
        },
      });
      if (!row) {
        throw new AssistedCopyError(
          "assisted_copy_not_found",
          "The assisted-copy draft is unavailable",
        );
      }
      if (settled.count === 0 && row.status === "generating") {
        throw new AssistedCopyError(
          "assisted_copy_settlement_conflict",
          "The assisted-copy generation could not be settled",
        );
      }
      return record(row);
    },

    async read(input) {
      const row = await requirePrisma().assistedCopyDraft.findFirst({
        where: {
          id: input.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
        },
      });
      return row ? record(row) : null;
    },

    async listLatest(input) {
      const rows = await requirePrisma().assistedCopyDraft.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          platform: input.platform,
        },
        distinct: ["clipId"],
        orderBy: [
          { clipId: "asc" },
          { createdAt: "desc" },
          { updatedAt: "desc" },
        ],
        take: Math.max(1, Math.min(100, input.limit)),
      });
      return rows.map(record);
    },

    async confirm(input) {
      const prisma = requirePrisma();
      const updated = await prisma.assistedCopyDraft.updateMany({
        where: {
          id: input.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          status: "completed",
          revision: input.expectedRevision,
        },
        data: {
          content: input.content as unknown as Prisma.InputJsonValue,
          confirmedAt: input.now,
          revision: { increment: 1 },
          updatedAt: input.now,
        },
      });
      if (updated.count !== 1) return null;
      return record(
        await prisma.assistedCopyDraft.findUniqueOrThrow({ where: { id: input.id } }),
      );
    },
  };
}

export function createProductionAssistedCopyAuthorization(dependencies: {
  requireActor(
    actorUserId: string,
    workspaceId: string,
    capability: "content.view" | "publishing.manage",
  ): Promise<{ pricingTier: string | null | undefined }>;
  assertWriteEnabled(): void;
}) {
  return {
    async authorize(scope: { actorUserId: string; workspaceId: string }) {
      dependencies.assertWriteEnabled();
      const actor = await dependencies.requireActor(
        scope.actorUserId,
        scope.workspaceId,
        "publishing.manage",
      );
      if (!hasFeature(actor.pricingTier, "publishing.assistedCopy")) {
        throw new AssistedCopyError(
          "assisted_copy_feature_unavailable",
          "Assisted copy is unavailable on this plan",
        );
      }
    },
    async authorizeRead(scope: { actorUserId: string; workspaceId: string }) {
      await dependencies.requireActor(
        scope.actorUserId,
        scope.workspaceId,
        "content.view",
      );
    },
  };
}

export function createProductionAssistedCopyService() {
  const authorization = createProductionAssistedCopyAuthorization({
    requireActor: (actorUserId, workspaceId, capability) =>
      workspaceService.requireActor(actorUserId, workspaceId, capability),
    assertWriteEnabled: () =>
      assertPublishingPreparationWriteEnabled("assisted_copy"),
  });
  return createAssistedCopyService({
    store: createPrismaAssistedCopyStore(),
    provider: () => createOpenAiAssistedCopyProvider(),
    authorize: authorization.authorize,
    authorizeRead: authorization.authorizeRead,
    diagnostics(event) {
      console.warn(
        JSON.stringify({
          level: "info",
          message: "assisted_copy_event",
          ...event,
          ts: new Date().toISOString(),
        }),
      );
      const projectId = typeof event.projectId === "string" ? event.projectId : null;
      const clipId = typeof event.clipId === "string" ? event.clipId : null;
      if (!projectId) return;
      const eventName = typeof event.event === "string" ? event.event : "";
      const type = eventName === "assisted_copy_confirmed"
        ? "assisted_copy_confirmed"
        : eventName.startsWith("assisted_copy_")
          ? "assisted_copy_generated"
          : null;
      if (!type) return;
      const inputTokens = typeof event.inputTokens === "number" ? event.inputTokens : 0;
      const outputTokens = typeof event.outputTokens === "number" ? event.outputTokens : 0;
      void analyticsService.recordProjectEvent({
        projectId,
        clipId,
        type,
        platform:
          typeof event.platform === "string"
            ? (event.platform as SocialPlatform)
            : null,
        metadata: {
          featureVersion: "assisted-copy-v1",
          outcome: eventName.replace("assisted_copy_", ""),
          ...(typeof event.modelAlias === "string" ? { modelAlias: event.modelAlias } : {}),
          ...(typeof event.moderationOutcome === "string"
            ? { moderationOutcome: event.moderationOutcome }
            : {}),
          ...(typeof event.revision === "number" ? { revisionCount: event.revision } : {}),
          usageUnits: inputTokens + outputTokens,
        },
      }).catch(() => {
        console.warn(JSON.stringify({
          level: "warn",
          message: "assisted_copy_analytics_record_failed",
          projectId,
          eventType: type,
        }));
      });
    },
  });
}
