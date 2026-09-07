import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@narriflow/db/client";
import { resolvePricingTier, type CreateGeneratedImageInput } from "@narriflow/validators";
import type { BrandActorScope } from "./brand-ownership";
import {
  createGeneratedMediaModule,
  generatedMediaPublicJob,
  type CreateGeneratedMediaInput,
  type GeneratedMediaReconciliation,
  GeneratedMediaJobError,
} from "./generated-media";
import { prismaGeneratedMediaStore } from "./generated-media-prisma-store";
import { generatedMediaPromptProtectionFromEnv } from "./generated-media-prompt-protection";
import { createProductionGeneratedMediaPublisher } from "./generated-media-production-publisher";
import { createPrismaGenerationUsageLedger, getGeneratedImageUsageSummary } from "./generated-media-usage-ledger";
import { generatedImageCapability } from "./generation-usage";
import { openAiImageProviderFromEnv } from "./openai-image-provider";
import { analyticsService } from "./analytics.service";
import { visualAssetService } from "./visual-asset.service";

type GeneratedMediaModule = ReturnType<typeof createGeneratedMediaModule>;

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function createProductionModule(environment: NodeJS.ProcessEnv = process.env) {
  return createGeneratedMediaModule({
    store: prismaGeneratedMediaStore,
    provider: openAiImageProviderFromEnv(environment),
    publisher: createProductionGeneratedMediaPublisher(environment),
    usage: createPrismaGenerationUsageLedger(environment),
    promptProtection: generatedMediaPromptProtectionFromEnv(environment),
    ids: randomUUID,
    maxAttempts: boundedInteger(environment.GENERATED_IMAGE_MAX_ATTEMPTS, 4, 1, 10),
    maxPromptCharacters: boundedInteger(environment.GENERATED_IMAGE_MAX_PROMPT_CHARACTERS, 4_000, 64, 20_000),
    async authorizeAccess(scope) {
      if (!generatedImageCapability(scope, environment).available) {
        throw new GeneratedMediaJobError("generated_media_entitlement_required");
      }
    },
    async authorizeOrigin(scope, input) {
      const prisma = getPrismaClient();
      if (!prisma) throw new Error("Database client unavailable");
      const project = await prisma.project.findFirst({
        where: { id: input.projectId, workspaceId: scope.workspaceId },
        select: { id: true },
      });
      if (!project) throw new GeneratedMediaJobError("generated_media_origin_not_found");
      if (!input.clipId) return;
      const clip = await prisma.clip.findFirst({
        where: { id: input.clipId, projectId: input.projectId },
        select: { startSec: true, endSec: true },
      });
      if (!clip) throw new GeneratedMediaJobError("generated_media_origin_not_found");
      if (
        input.promptOrigin === "transcript_selection" &&
        (input.sourceStartSec == null || input.sourceEndSec == null ||
          input.sourceStartSec < clip.startSec || input.sourceEndSec > clip.endSec)
      ) {
        throw new GeneratedMediaJobError("generated_media_source_range_invalid");
      }
      if (
        input.promptOrigin === "broll_cue" &&
        (input.sourceCueAtSec == null || input.sourceCueAtSec > clip.endSec - clip.startSec)
      ) {
        throw new GeneratedMediaJobError("generated_media_source_cue_invalid");
      }
    },
    async recordCompleted({ jobId, scope, assetId, aspectRatio }) {
      await analyticsService.recordBrandProgramEventBestEffort({
        type: "generated_asset_completed",
        workspaceId: scope.workspaceId,
        actorUserId: scope.actorUserId,
        metadata: {
          generatedMediaJobId: jobId,
          assetId,
          assetKind: "image",
          aspectRatio,
          planTier: resolvePricingTier(scope.pricingTier),
          outcome: "succeeded",
        },
      });
    },
    async recordSettled({
      jobId,
      scope,
      projectId,
      aspectRatio,
      status,
      providerAlias,
      modelAlias,
      latencyBucket,
      retryCount,
      moderationOutcome,
      usageUnits,
    }) {
      await analyticsService.recordBrandProgramEventBestEffort({
        type: "generated_asset_settled",
        workspaceId: scope.workspaceId,
        actorUserId: scope.actorUserId,
        projectId,
        metadata: {
          generatedMediaJobId: jobId,
          assetKind: "image",
          aspectRatio,
          planTier: resolvePricingTier(scope.pricingTier),
          outcome: status === "completed" ? "succeeded" : status === "cancelled" ? "blocked" : "failed",
          providerAlias,
          modelAlias,
          lifecycleStatus: status,
          latencyBucket,
          retryCount,
          moderationOutcome,
          usageUnits,
        },
      });
    },
  });
}

export class GeneratedMediaService {
  private module: GeneratedMediaModule | null = null;

  constructor(private readonly factory = createProductionModule) {}

  private runtime() {
    this.module ??= this.factory();
    return this.module;
  }

  create(scope: BrandActorScope, input: CreateGeneratedImageInput) {
    return this.runtime().create(scope, input as CreateGeneratedMediaInput);
  }

  async list(scope: BrandActorScope, projectId: string, clipId?: string) {
    const jobs = await prismaGeneratedMediaStore.list(scope.workspaceId, projectId, clipId);
    return jobs.map((job) => generatedMediaPublicJob(job));
  }

  usageSummary(scope: BrandActorScope) {
    return getGeneratedImageUsageSummary(scope.workspaceId, scope.pricingTier);
  }

  async get(scope: BrandActorScope, id: string, projectId?: string) {
    const job = await prismaGeneratedMediaStore.get(id);
    if (!job || job.scope.workspaceId !== scope.workspaceId || (projectId && job.projectId !== projectId)) {
      throw new GeneratedMediaJobError("generated_media_job_not_found");
    }
    return generatedMediaPublicJob(job);
  }

  async cancel(scope: BrandActorScope, id: string, projectId?: string) {
    await this.get(scope, id, projectId);
    return this.runtime().cancel(scope, id);
  }

  process(id: string) {
    return this.runtime().process(id);
  }

  processDue(limit?: number) {
    return this.runtime().processDue(limit);
  }

  reconcile(id: string, decision: GeneratedMediaReconciliation) {
    return this.runtime().reconcile(id, decision);
  }

  async inspectForOperator(workspaceId: string, id: string) {
    const job = await prismaGeneratedMediaStore.get(id);
    if (!job || job.scope.workspaceId !== workspaceId) {
      throw new GeneratedMediaJobError("generated_media_job_not_found");
    }
    return generatedMediaPublicJob(job);
  }

  async reconcileForOperator(workspaceId: string, id: string, decision: GeneratedMediaReconciliation) {
    await this.inspectForOperator(workspaceId, id);
    return this.runtime().reconcile(id, decision);
  }

  async deleteResult(scope: BrandActorScope, id: string, projectId?: string) {
    const job = await this.get(scope, id, projectId);
    if (!job.resultAsset) throw new GeneratedMediaJobError("generated_media_result_not_found");
    await visualAssetService.softDeleteGenerated(scope, job.resultAsset.id, {});
  }
}

export const generatedMediaService = new GeneratedMediaService();
