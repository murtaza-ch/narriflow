import {
  applyMotionSelectedSchema,
  applyProjectBrandProfileSelectedSchema,
  applySceneTemplateSchema,
  applyStyleSelectedSchema,
  businessAutomationAssistedCopyStatusSchema,
  businessAutomationBulkScheduleStatusSchema,
  businessAutomationCampaignOperationStatusSchema,
  businessAutomationCampaignPreviewSchema,
  businessAutomationGeneratedMediaStatusSchema,
  businessAutomationReviewRoundCreatedSchema,
  businessAutomationReviewRoundListSchema,
  businessAutomationThumbnailStatusSchema,
  brandProfileListSchema,
  bulkScheduleAutomationSchema,
  createReviewRoundAutomationSchema,
  generateAssistedCopySchema,
  generatedMediaAutomationSubmitSchema,
  requestThumbnailExtractionSchema,
  previewCampaignEditorActionSchema,
  resolvePricingTier,
  type ApplyMotionSelectedInput,
  type ApplyProjectBrandProfileSelectedInput,
  type ApplySceneTemplateInput,
  type ApplyStyleSelectedInput,
  type BrandProfileListInput,
  type BulkScheduleAutomationRequest,
  type CreateReviewRoundAutomationInput,
  type GenerateAssistedCopyRequest,
  type GeneratedMediaAutomationSubmit,
  type RequestThumbnailExtractionInput,
  type PreviewCampaignEditorActionInput,
} from "@narriflow/validators";

import { brandProfileService } from "./brand-profile.service";
import type { BrandActorScope } from "./brand-ownership";
import { createProductionAssistedCopyService } from "./assisted-copy.prisma";
import { createProductionBulkSchedulingRuntime } from "./bulk-scheduling.prisma";
import { campaignOperationService } from "./campaign-operation.service";
import { GeneratedMediaError } from "./generated-media";
import { createPrismaGeneratedMediaStore } from "./generated-media-prisma";
import { getGeneratedMediaRuntime } from "./generated-media-runtime";
import { getGeneratedMediaStudioService } from "./generated-media-studio.runtime";
import type { GeneratedMediaStore } from "./generated-media";
import { reviewService, ReviewServiceError } from "./review.service";
import { ThumbnailExtractionError } from "./thumbnail-extraction.service";
import { createProductionThumbnailExtractionService } from "./thumbnail-extraction.prisma";
import type { BusinessAutomationActorContext } from "./business-automation-access";
import type { WorkspaceActorContext } from "./workspace.service";

type UnknownRecord = Record<string, unknown>;

function exactAutomationProjection<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("business_automation_projection_invalid");
  }
  return parsed.data;
}

export interface BusinessAutomationDependencies {
  listBrandProfiles(
    actor: WorkspaceActorContext,
    input: BrandProfileListInput,
  ): Promise<unknown[]>;
  getBrandProfile(actor: WorkspaceActorContext, profileId: string): Promise<unknown>;
  applyCampaignMotion(
    actor: WorkspaceActorContext,
    projectId: string,
    idempotencyKey: string,
    input: ApplyMotionSelectedInput,
  ): Promise<unknown>;
  applyCampaignBrandProfile(
    actor: WorkspaceActorContext,
    projectId: string,
    idempotencyKey: string,
    input: ApplyProjectBrandProfileSelectedInput,
  ): Promise<unknown>;
  applyCampaignStyle(
    actor: WorkspaceActorContext,
    projectId: string,
    idempotencyKey: string,
    input: ApplyStyleSelectedInput,
  ): Promise<unknown>;
  applyCampaignSceneTemplate(
    actor: WorkspaceActorContext,
    projectId: string,
    profileId: string,
    templateId: string,
    idempotencyKey: string,
    input: ApplySceneTemplateInput,
  ): Promise<unknown>;
  previewCampaignEditorAction(
    actor: WorkspaceActorContext,
    projectId: string,
    input: PreviewCampaignEditorActionInput,
  ): Promise<unknown>;
  getCampaignEditorActionCatalog(
    actor: WorkspaceActorContext,
    projectId: string,
  ): Promise<unknown>;
  listCampaignOperations(
    actor: WorkspaceActorContext,
    projectId: string,
  ): Promise<unknown[]>;
  createReviewRound(
    actor: WorkspaceActorContext,
    projectId: string,
    input: CreateReviewRoundAutomationInput,
  ): Promise<unknown>;
  listReviewRounds(
    actor: WorkspaceActorContext,
    projectId: string,
  ): Promise<unknown>;
  generateAssistedCopy(
    actor: WorkspaceActorContext,
    projectId: string,
    input: GenerateAssistedCopyRequest,
  ): Promise<unknown>;
  getAssistedCopy(
    actor: WorkspaceActorContext,
    projectId: string,
    draftId: string,
  ): Promise<unknown>;
  requestThumbnailExtraction(
    actor: WorkspaceActorContext,
    projectId: string,
    input: RequestThumbnailExtractionInput,
  ): Promise<unknown>;
  getThumbnailExtraction(
    actor: WorkspaceActorContext,
    projectId: string,
    jobId: string,
  ): Promise<unknown>;
  bulkSchedule(
    actor: BusinessAutomationActorContext,
    projectId: string,
    input: BulkScheduleAutomationRequest,
  ): Promise<unknown>;
  submitGeneratedMedia(
    actor: WorkspaceActorContext,
    input: GeneratedMediaAutomationSubmit,
  ): Promise<unknown>;
  getGeneratedMedia(actor: WorkspaceActorContext, jobId: string): Promise<unknown>;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function iso(value: unknown) {
  if (value === null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return typeof value === "string" ? value : undefined;
}

function string(value: unknown) {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableNumber(value: unknown) {
  if (value === null) return null;
  return number(value);
}

function boolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function array(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function safeBrandProfile(value: unknown) {
  const profile = record(value);
  const withoutSignedUrl = (entry: unknown) => {
    const { accessUrl: _accessUrl, ...safe } = record(entry);
    return safe;
  };
  return {
    ...profile,
    assets: Array.isArray(profile.assets)
      ? profile.assets.map(withoutSignedUrl)
      : [],
    fonts: Array.isArray(profile.fonts)
      ? profile.fonts.map(withoutSignedUrl)
      : [],
  };
}

function campaignStatus(value: unknown) {
  const operation = record(value);
  const counts = record(operation.counts);
  const items = array(operation.items);
  return exactAutomationProjection(businessAutomationCampaignOperationStatusSchema, {
    operationId: string(operation.operationId) ?? string(operation.id),
    action: string(operation.action),
    status: string(operation.status),
    requestedCount: number(operation.requestedCount),
    counts: {
      succeeded: number(counts.succeeded ?? operation.succeededCount),
      unchanged: number(counts.unchanged ?? operation.unchangedCount),
      stale: number(counts.stale ?? operation.staleCount),
      ineligible: number(counts.ineligible ?? operation.ineligibleCount),
      failed: number(counts.failed ?? operation.failedCount),
    },
    items: items?.map((entry) => {
      const item = record(entry);
      return {
        clipId: string(item.requestedClipId) ?? string(item.clipId),
        expectedEditorRevision: nullableNumber(item.expectedEditorRevision),
        status: string(item.status),
        errorCode: string(item.errorCode),
        settledAt: iso(item.settledAt),
      };
    }),
    createdAt: iso(operation.createdAt),
    completedAt: iso(operation.completedAt),
    replayed: boolean(operation.replayed),
  });
}

function campaignPreview(value: unknown) {
  const preview = record(value);
  const counts = record(preview.counts);
  const items = array(preview.items);
  return exactAutomationProjection(businessAutomationCampaignPreviewSchema, {
    action: string(preview.action),
    requestedCount: number(preview.requestedCount),
    counts: {
      eligible: number(counts.eligible),
      unchanged: number(counts.unchanged),
      stale: number(counts.stale),
      ineligible: number(counts.ineligible),
    },
    items: items?.map((itemValue) => {
      const item = record(itemValue);
      return {
        clipId: string(item.clipId),
        expectedEditorRevision: number(item.expectedEditorRevision),
        currentEditorRevision: nullableNumber(item.currentEditorRevision),
        status: string(item.status),
        code: string(item.code),
      };
    }),
  });
}

function campaignCatalog(value: unknown) {
  const catalog = record(value);
  const profile = catalog.profile === null ? null : record(catalog.profile);
  const currentStyle =
    profile?.currentStyle && typeof profile.currentStyle === "object"
      ? record(profile.currentStyle)
      : null;
  const styles = Array.isArray(catalog.styles) ? catalog.styles : [];
  const scenes = Array.isArray(catalog.scenes) ? catalog.scenes : [];
  return {
    profile: profile
      ? {
          id: string(profile.id),
          name: string(profile.name),
          fingerprint: string(profile.fingerprint),
          styleFingerprint: string(profile.styleFingerprint),
          currentStyle: currentStyle
            ? {
                id: string(currentStyle.id),
                name: string(currentStyle.name),
                fontName: string(currentStyle.fontName),
                primaryColor: string(currentStyle.primaryColor),
                secondaryColor: string(currentStyle.secondaryColor),
              }
            : null,
        }
      : null,
    styles: styles.map((styleValue) => {
      const style = record(styleValue);
      return {
        id: string(style.id),
        name: string(style.name),
        fingerprint: string(style.fingerprint),
        fontName: string(style.fontName),
        captionPosition: string(style.captionPosition),
        primaryColor: string(style.primaryColor),
        secondaryColor: string(style.secondaryColor),
        accentColor: string(style.accentColor),
        current: boolean(style.current),
      };
    }),
    scenes: scenes.map((sceneValue) => {
      const scene = record(sceneValue);
      return {
        id: string(scene.id),
        name: string(scene.name),
        role: string(scene.role),
        fingerprint: string(scene.fingerprint),
        durationSec: number(scene.durationSec),
        contentKind: string(scene.contentKind),
        isDefault: boolean(scene.isDefault),
      };
    }),
  };
}

function reviewStatus(value: unknown) {
  const view = record(value);
  const rounds = array(view.rounds);
  return exactAutomationProjection(businessAutomationReviewRoundListSchema, {
    projectId: string(record(view.project).id),
    rounds: rounds?.map((entry) => {
      const round = record(entry);
      const items = array(round.items);
      const notifications = array(round.notifications);
      return {
        roundId: string(round.id),
        revision: number(round.revision),
        status: string(round.status),
        approvalRequired: boolean(round.approvalRequired),
        allowDownloads: boolean(round.allowDownloads),
        sentAt: iso(round.sentAt),
        expiresAt: iso(round.expiresAt),
        revokedAt: iso(round.revokedAt),
        supersededAt: iso(round.supersededAt),
        decision: string(round.decision),
        decidedAt: iso(round.decidedAt),
        newerWorkAvailable: boolean(round.newerWorkAvailable),
        items: items?.map((itemValue) => {
          const item = record(itemValue);
          return {
            itemId: string(item.id),
            clipId: string(item.clipId),
            exportId: string(item.exportId),
            editorRevision: number(item.editorRevision),
            required: boolean(item.required),
            currentDecision: string(item.currentDecision),
            newerWorkAvailable: boolean(item.newerWorkAvailable),
          };
        }),
        notificationStatus: notifications?.map((notificationValue) => {
          const notification = record(notificationValue);
          return {
            kind: string(notification.kind),
            status: string(notification.status),
            attemptCount: number(notification.attemptCount),
            failureCode: string(notification.failureCode),
            sentAt: iso(notification.sentAt),
          };
        }),
        createdAt: iso(round.createdAt),
        updatedAt: iso(round.updatedAt),
      };
    }),
  });
}

function reviewCreated(value: unknown) {
  const round = record(value);
  return exactAutomationProjection(businessAutomationReviewRoundCreatedSchema, {
    roundId: string(round.id),
    revision: number(round.revision),
    createdAt: iso(round.createdAt),
    replayed: boolean(round.replayed),
  });
}

function assistedCopyStatus(value: unknown) {
  const draft = record(value);
  return exactAutomationProjection(businessAutomationAssistedCopyStatusSchema, {
    draftId: string(draft.id),
    clipId: string(draft.clipId),
    platform: string(draft.platform),
    status: string(draft.status),
    revision: number(draft.revision),
    content: draft.content,
    confirmed: boolean(draft.confirmed),
    moderationOutcome: string(draft.moderationOutcome),
    modelAlias: string(draft.modelAlias),
    promptVersion: string(draft.promptVersion),
    guidanceSkipped: boolean(draft.guidanceSkipped),
    errorCode: string(draft.errorCode),
    replayed: boolean(draft.replayed),
  });
}

function thumbnailStatus(value: unknown) {
  const job = record(value);
  const asset = job.asset === null
    ? null
    : job.asset && typeof job.asset === "object" && !Array.isArray(job.asset)
      ? record(job.asset)
      : undefined;
  return exactAutomationProjection(businessAutomationThumbnailStatusSchema, {
    jobId: string(job.id),
    status: string(job.status),
    attempts: number(job.attempts),
    platform: string(job.platform),
    exportVariantId: string(job.exportVariantId),
    sourceTimeMs: number(job.sourceTimeMs),
    errorCode: string(job.errorCode),
    asset: asset === undefined
      ? undefined
      : asset
      ? {
          id: string(asset.id),
          title: string(asset.title),
          kind: string(asset.kind),
          width: number(asset.width),
          height: number(asset.height),
          sizeBytes: number(asset.sizeBytes),
          fingerprint: string(asset.fingerprint),
        }
      : null,
    replayed: boolean(job.replayed),
  });
}

function bulkScheduleStatus(value: unknown) {
  const operation = record(value);
  const counts = record(operation.counts);
  const items = array(operation.items);
  return exactAutomationProjection(businessAutomationBulkScheduleStatusSchema, {
    operationId: string(operation.operationId),
    status: string(operation.status),
    counts: {
      scheduled: number(counts.scheduled),
      failed: number(counts.failed),
    },
    items: items?.map((itemValue) => {
      const item = record(itemValue);
      return {
        itemKey: string(item.itemKey),
        clipId: string(item.clipId),
        accountId: string(item.accountId),
        status: string(item.status),
        postId: string(item.postId),
        scheduledFor: iso(item.scheduledFor),
        errorCode: string(item.errorCode),
      };
    }),
    replayed: boolean(operation.replayed),
  });
}

function generatedMediaStatus(value: unknown) {
  const job = record(value);
  const moderation = record(job.moderation);
  return exactAutomationProjection(businessAutomationGeneratedMediaStatusSchema, {
    jobId: string(job.id),
    projectId: string(job.projectId),
    clipId: string(job.clipId),
    kind: string(job.kind),
    status: string(job.status),
    aspectRatio: string(job.aspectRatio),
    style: string(job.style),
    durationSec: nullableNumber(job.durationSec),
    resultAssetId: string(job.resultAssetId),
    insertionCount: number(job.insertionCount),
    lastInsertionKind: string(job.lastInsertionKind),
    lastInsertedAt: iso(job.lastInsertedAt),
    errorCode: string(job.errorCode),
    moderationOutcome: string(moderation.outcome),
    createdAt: iso(job.createdAt),
    updatedAt: iso(job.updatedAt),
    replayed: boolean(job.replayed),
  });
}

export function createBusinessAutomation(
  dependencies: BusinessAutomationDependencies,
) {
  return {
    async listBrandProfiles(actor: WorkspaceActorContext, input: unknown) {
      const parsed = brandProfileListSchema.parse(input ?? {});
      return (await dependencies.listBrandProfiles(actor, parsed)).map(
        safeBrandProfile,
      );
    },

    async getBrandProfile(actor: WorkspaceActorContext, profileId: string) {
      return safeBrandProfile(
        await dependencies.getBrandProfile(actor, profileId),
      );
    },

    async applyCampaignMotion(
      actor: WorkspaceActorContext,
      projectId: string,
      idempotencyKey: string,
      input: unknown,
    ) {
      const parsed = applyMotionSelectedSchema.parse(input);
      return campaignStatus({
        ...record(await dependencies.applyCampaignMotion(
          actor,
          projectId,
          idempotencyKey,
          parsed,
        )),
        action: "apply_motion",
      });
    },

    async applyCampaignBrandProfile(
      actor: WorkspaceActorContext,
      projectId: string,
      idempotencyKey: string,
      input: unknown,
    ) {
      const parsed = applyProjectBrandProfileSelectedSchema.parse(input);
      return campaignStatus({
        ...record(await dependencies.applyCampaignBrandProfile(
          actor,
          projectId,
          idempotencyKey,
          parsed,
        )),
        action: "apply_brand_profile",
      });
    },

    async applyCampaignStyle(
      actor: WorkspaceActorContext,
      projectId: string,
      idempotencyKey: string,
      input: unknown,
    ) {
      const parsed = applyStyleSelectedSchema.parse(input);
      return campaignStatus({
        ...record(await dependencies.applyCampaignStyle(
          actor,
          projectId,
          idempotencyKey,
          parsed,
        )),
        action: "apply_style",
      });
    },

    async applyCampaignSceneTemplate(
      actor: WorkspaceActorContext,
      projectId: string,
      profileId: string,
      templateId: string,
      idempotencyKey: string,
      input: unknown,
    ) {
      const parsed = applySceneTemplateSchema.parse(input);
      return campaignStatus({
        ...record(await dependencies.applyCampaignSceneTemplate(
          actor,
          projectId,
          profileId,
          templateId,
          idempotencyKey,
          parsed,
        )),
        action: "apply_scene_template",
      });
    },

    async previewCampaignEditorAction(
      actor: WorkspaceActorContext,
      projectId: string,
      input: unknown,
    ) {
      const parsed = previewCampaignEditorActionSchema.parse(input);
      return campaignPreview(await dependencies.previewCampaignEditorAction(
        actor,
        projectId,
        parsed,
      ));
    },

    async getCampaignEditorActionCatalog(
      actor: WorkspaceActorContext,
      projectId: string,
    ) {
      return campaignCatalog(
        await dependencies.getCampaignEditorActionCatalog(actor, projectId),
      );
    },

    async listCampaignOperations(
      actor: WorkspaceActorContext,
      projectId: string,
    ) {
      return (await dependencies.listCampaignOperations(actor, projectId)).map(
        (operation) => campaignStatus({ ...record(operation), replayed: false }),
      );
    },

    async createReviewRound(
      actor: WorkspaceActorContext,
      projectId: string,
      input: unknown,
    ) {
      const parsed = createReviewRoundAutomationSchema.parse(input);
      return reviewCreated(
        await dependencies.createReviewRound(actor, projectId, parsed),
      );
    },

    async listReviewRounds(actor: WorkspaceActorContext, projectId: string) {
      return reviewStatus(
        await dependencies.listReviewRounds(actor, projectId),
      );
    },

    async generateAssistedCopy(
      actor: WorkspaceActorContext,
      projectId: string,
      input: unknown,
    ) {
      const parsed = generateAssistedCopySchema.parse(input);
      return assistedCopyStatus(
        await dependencies.generateAssistedCopy(actor, projectId, parsed),
      );
    },

    async getAssistedCopy(
      actor: WorkspaceActorContext,
      projectId: string,
      draftId: string,
    ) {
      return assistedCopyStatus(
        await dependencies.getAssistedCopy(actor, projectId, draftId),
      );
    },

    async requestThumbnailExtraction(
      actor: WorkspaceActorContext,
      projectId: string,
      input: unknown,
    ) {
      const parsed = requestThumbnailExtractionSchema.parse(input);
      return thumbnailStatus(
        await dependencies.requestThumbnailExtraction(actor, projectId, parsed),
      );
    },

    async getThumbnailExtraction(
      actor: WorkspaceActorContext,
      projectId: string,
      jobId: string,
    ) {
      return thumbnailStatus(
        await dependencies.getThumbnailExtraction(actor, projectId, jobId),
      );
    },

    async bulkSchedule(
      actor: BusinessAutomationActorContext,
      projectId: string,
      input: unknown,
    ) {
      const parsed = bulkScheduleAutomationSchema.parse(input);
      return bulkScheduleStatus(
        await dependencies.bulkSchedule(actor, projectId, parsed),
      );
    },

    async submitGeneratedMedia(actor: WorkspaceActorContext, input: unknown) {
      const parsed = generatedMediaAutomationSubmitSchema.parse(input);
      return generatedMediaStatus(
        await dependencies.submitGeneratedMedia(actor, parsed),
      );
    },

    async getGeneratedMedia(actor: WorkspaceActorContext, jobId: string) {
      return generatedMediaStatus(
        await dependencies.getGeneratedMedia(actor, jobId),
      );
    },
  };
}

export type BusinessAutomation = ReturnType<typeof createBusinessAutomation>;

function brandScope(actor: WorkspaceActorContext): BrandActorScope {
  return {
    actorUserId: actor.userId,
    workspaceId: actor.workspaceId,
    workspaceOwnerUserId: actor.workspaceOwnerUserId,
    role: actor.role,
    status: actor.status,
    pricingTier: actor.pricingTier,
    isPersonalWorkspace: actor.isPersonalWorkspace,
  };
}

function reviewAutomationSecrets(
  env: Readonly<Record<string, string | undefined>>,
) {
  const accessSecret = env.REVIEW_ACCESS_SECRET?.trim();
  const dataSecret = env.REVIEW_SESSION_SECRET?.trim();
  if (
    !accessSecret ||
    accessSecret.length < 32 ||
    !dataSecret ||
    dataSecret.length < 32
  ) {
    throw new ReviewServiceError(
      "review_automation_configuration_invalid",
      "Review automation is not configured",
    );
  }
  return { accessSecret, dataSecret };
}

function thumbnailRuntime() {
  return createProductionThumbnailExtractionService({
    async extract() {
      throw new ThumbnailExtractionError(
        "thumbnail_worker_required",
        "Thumbnail extraction must run in the media worker",
      );
    },
  });
}

export function createProductionBusinessAutomation(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: {
    campaignOperationGateway?: Pick<
      typeof campaignOperationService,
      | "applyMotionSelected"
      | "applyProjectBrandProfileSelected"
      | "applyStyleSelected"
      | "applySceneTemplate"
      | "getOperation"
    >;
    generatedMediaStatusStore?: Pick<GeneratedMediaStore, "get">;
    generatedMediaStudioService?: Pick<
      ReturnType<typeof getGeneratedMediaStudioService>,
      "submitAutomation"
    >;
    bulkSchedulingRuntime?: Pick<
      ReturnType<typeof createProductionBulkSchedulingRuntime>,
      "schedule"
    >;
  } = {},
) {
  const campaignGateway =
    options.campaignOperationGateway ?? campaignOperationService;
  async function completeCampaignMutation(
    actor: WorkspaceActorContext,
    projectId: string,
    admission: Promise<{ operationId: string; replayed: boolean }>,
  ) {
    const admitted = await admission;
    const operation = await campaignGateway.getOperation(
      { workspaceId: actor.workspaceId, projectId },
      admitted.operationId,
    );
    return { ...operation, replayed: admitted.replayed };
  }

  return createBusinessAutomation({
    listBrandProfiles: (actor, input) =>
      brandProfileService.list(brandScope(actor), input),
    getBrandProfile: (actor, profileId) =>
      brandProfileService.get(brandScope(actor), profileId),
    applyCampaignMotion: (actor, projectId, idempotencyKey, input) =>
      completeCampaignMutation(actor, projectId, campaignGateway.applyMotionSelected(
        {
          actorUserId: actor.userId,
          workspaceId: actor.workspaceId,
          projectId,
          pricingTier: resolvePricingTier(actor.pricingTier),
          role: actor.role,
          status: actor.status,
          idempotencyKey,
        },
        input,
      )),
    applyCampaignBrandProfile: (actor, projectId, idempotencyKey, input) =>
      completeCampaignMutation(actor, projectId, campaignGateway.applyProjectBrandProfileSelected(
        {
          ...brandScope(actor),
          projectId,
          idempotencyKey,
        },
        input,
      )),
    applyCampaignStyle: (actor, projectId, idempotencyKey, input) =>
      completeCampaignMutation(actor, projectId, campaignGateway.applyStyleSelected(
        {
          ...brandScope(actor),
          projectId,
          idempotencyKey,
        },
        input,
      )),
    applyCampaignSceneTemplate: (
      actor,
      projectId,
      profileId,
      templateId,
      idempotencyKey,
      input,
    ) => completeCampaignMutation(actor, projectId, campaignGateway.applySceneTemplate(
      {
        ...brandScope(actor),
        projectId,
        idempotencyKey,
      },
      profileId,
      templateId,
      input,
    )),
    previewCampaignEditorAction: (actor, projectId, input) =>
      campaignOperationService.previewEditorAction(
        { ...brandScope(actor), projectId },
        input,
      ),
    getCampaignEditorActionCatalog: (actor, projectId) =>
      campaignOperationService.getEditorActionCatalog({
        ...brandScope(actor),
        projectId,
      }),
    listCampaignOperations: (actor, projectId) =>
      campaignOperationService.listOperations({
        workspaceId: actor.workspaceId,
        projectId,
      }),
    async createReviewRound(actor, projectId, input) {
      const { idempotencyKey, ...request } = input;
      return reviewService.createRound(
        {
          actorUserId: actor.userId,
          workspaceId: actor.workspaceId,
          projectId,
          pricingTier: resolvePricingTier(actor.pricingTier),
          idempotencyKey,
        },
        request,
        reviewAutomationSecrets(env),
      );
    },
    listReviewRounds: (actor, projectId) =>
      reviewService.internalWorkspaceView(actor.workspaceId, projectId),
    generateAssistedCopy: (actor, projectId, input) =>
      createProductionAssistedCopyService().generate(
        { actorUserId: actor.userId, workspaceId: actor.workspaceId, projectId },
        input,
      ),
    getAssistedCopy: (actor, projectId, draftId) =>
      createProductionAssistedCopyService().get(
        { actorUserId: actor.userId, workspaceId: actor.workspaceId, projectId },
        draftId,
      ),
    requestThumbnailExtraction: (actor, projectId, input) =>
      thumbnailRuntime().request(
        { actorUserId: actor.userId, workspaceId: actor.workspaceId, projectId },
        input,
      ),
    getThumbnailExtraction: (actor, projectId, jobId) =>
      thumbnailRuntime().get(
        { actorUserId: actor.userId, workspaceId: actor.workspaceId, projectId },
        jobId,
      ),
    bulkSchedule: (actor, projectId, input) =>
      (
        options.bulkSchedulingRuntime ?? createProductionBulkSchedulingRuntime()
      ).schedule(
        {
          actorUserId: actor.userId,
          ownerUserId: actor.workspaceOwnerUserId,
          workspaceId: actor.workspaceId,
          projectId,
          approvalPrincipal: actor.automationPrincipal,
        },
        input,
      ),
    async submitGeneratedMedia(actor, input) {
      if (!options.generatedMediaStudioService) {
				const runtime = getGeneratedMediaRuntime();
				if (!runtime.available || !runtime.service) {
					throw new GeneratedMediaError("generated_media_not_configured");
				}
      }
      const scope = brandScope(actor);
      const admitted = await (
        options.generatedMediaStudioService ?? getGeneratedMediaStudioService()
      ).submitAutomation(scope, input);
      const store =
        options.generatedMediaStatusStore ?? createPrismaGeneratedMediaStore();
      const job = await store.get(scope, admitted.id);
      if (!job) throw new GeneratedMediaError("generated_media_not_found");
      return { ...job, replayed: admitted.replayed };
    },
    async getGeneratedMedia(actor, jobId) {
      const store =
        options.generatedMediaStatusStore ?? createPrismaGeneratedMediaStore();
      const job = await store.get(brandScope(actor), jobId);
      if (!job) throw new GeneratedMediaError("generated_media_not_found");
      return job;
    },
  });
}
