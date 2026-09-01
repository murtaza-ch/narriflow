import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  autoCensorAnalyticsInputSchema,
  brandVoiceGuidanceSchema,
  projectCensorTermsSchema,
  resolvePricingTier,
  workspaceAllowsCapability,
  type AutoCensorAnalyticsInput,
} from "@narriflow/validators";
import type { BrandActorScope } from "./brand-ownership";
import { analyticsService } from "./analytics.service";
import { hasFeature } from "./plan-features";
import { isProgramWriteEnabled } from "./program-rollout";

export class AutoCensorAccessError extends Error {
  readonly code: "auto_censor_forbidden" | "auto_censor_entitlement_required";

  constructor(code: AutoCensorAccessError["code"]) {
    super(code === "auto_censor_forbidden"
      ? "Auto Censor editing is not allowed"
      : "This plan does not include Auto Censor");
    this.name = "AutoCensorAccessError";
    this.code = code;
  }
}

export class AutoCensorService {
  private requirePrisma() {
    const prisma = getPrismaClient();
    if (!prisma) throw new Error("Database client unavailable");
    return prisma;
  }

  async getPolicy(scope: BrandActorScope, projectId: string) {
    if (!workspaceAllowsCapability(scope, "content.view")) {
      throw new AutoCensorAccessError("auto_censor_forbidden");
    }
    const project = await this.requirePrisma().project.findFirst({
      where: { id: projectId, workspaceId: scope.workspaceId },
      select: {
        languageCode: true,
        censorTerms: true,
        brandProfile: { select: { voiceGuidance: true } },
      },
    });
    if (!project) throw new AutoCensorAccessError("auto_censor_forbidden");
    const voice = project.brandProfile
      ? brandVoiceGuidanceSchema.parse(project.brandProfile.voiceGuidance)
      : brandVoiceGuidanceSchema.parse({});
    return {
      locale: project.languageCode ?? "en",
      brandTerms: voice.blockedTerms,
      projectTerms: projectCensorTermsSchema.parse(project.censorTerms),
      canApply:
        workspaceAllowsCapability(scope, "content.edit") &&
        hasFeature(scope.pricingTier, "editor.censoring"),
      treatments: {
        caption_mask: isProgramWriteEnabled("auto_censor_caption_masks"),
        mute: isProgramWriteEnabled("auto_censor_mute"),
        beep: isProgramWriteEnabled("auto_censor_beep"),
      },
      planTier: resolvePricingTier(scope.pricingTier),
    } as const;
  }

  async replaceProjectTerms(
    scope: BrandActorScope,
    projectId: string,
    input: unknown,
  ) {
    if (!workspaceAllowsCapability(scope, "content.edit")) {
      throw new AutoCensorAccessError("auto_censor_forbidden");
    }
    const terms = projectCensorTermsSchema.parse(input);
    const result = await this.requirePrisma().project.updateMany({
      where: { id: projectId, workspaceId: scope.workspaceId },
      data: {
        censorTerms: terms as Prisma.InputJsonValue,
        updatedByUserId: scope.actorUserId,
      },
    });
    if (result.count !== 1) throw new AutoCensorAccessError("auto_censor_forbidden");
    return terms;
  }

  async recordEvent(
    scope: BrandActorScope,
    projectId: string,
    clipId: string,
    input: AutoCensorAnalyticsInput,
  ) {
    if (!workspaceAllowsCapability(scope, "content.view")) {
      throw new AutoCensorAccessError("auto_censor_forbidden");
    }
    const project = await this.requirePrisma().project.findFirst({
      where: { id: projectId, workspaceId: scope.workspaceId },
      select: { id: true },
    });
    if (!project) throw new AutoCensorAccessError("auto_censor_forbidden");
    const parsed = autoCensorAnalyticsInputSchema.parse(input);
    const { type, ...metadata } = parsed;
    await analyticsService.recordProjectEvent({
      projectId,
      clipId,
      type,
      metadata,
    });
  }
}

export const autoCensorService = new AutoCensorService();
