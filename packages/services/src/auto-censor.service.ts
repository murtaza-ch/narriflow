import { Prisma } from "@prisma/client";
import { getPrismaClient } from "@narriflow/db/client";
import {
  autoCensorAnalyticsInputSchema,
  brandVoiceGuidanceSchema,
  effectiveWorkspaceCensorWords,
  projectCensorTermsSchema,
  readProjectCensorTerms,
  resolvePricingTier,
  workspaceAllowsCapability,
  workspaceCensorWordsSchema,
  type AutoCensorAnalyticsInput,
  type WorkspaceCensorWords,
} from "@narriflow/validators";
import type { BrandActorScope } from "./brand-ownership";
import { analyticsService } from "./analytics.service";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";
import { hasFeature } from "./plan-features";

const autoCensorFailureCatalog = {
  auto_censor_forbidden: "forbidden",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type AutoCensorFailureCode = keyof typeof autoCensorFailureCatalog;

export class AutoCensorAccessError extends ExpectedDomainFailureError<AutoCensorFailureCode> {
  constructor(code: AutoCensorFailureCode) {
    super({
      code,
      kind: autoCensorFailureCatalog[code],
      message: "Auto Censor editing is not allowed",
    });
    this.name = "AutoCensorAccessError";
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
    const [project, workspaceTerms] = await Promise.all([
      this.requirePrisma().project.findFirst({
        where: { id: projectId, workspaceId: scope.workspaceId },
        select: {
          languageCode: true,
          censorTerms: true,
          brandProfile: { select: { voiceGuidance: true } },
        },
      }),
      this.getWorkspaceWords(scope),
    ]);
    if (!project) throw new AutoCensorAccessError("auto_censor_forbidden");
    const voice = project.brandProfile
      ? brandVoiceGuidanceSchema.parse(project.brandProfile.voiceGuidance)
      : brandVoiceGuidanceSchema.parse({});
    return {
      locale: project.languageCode ?? "en",
      workspaceTerms: workspaceTerms.words,
      workspaceTermsCustomized: workspaceTerms.customized,
      canEditWorkspaceTerms: workspaceAllowsCapability(scope, "workspace.manage"),
      brandTerms: voice.blockedTerms,
      // Read leniently: a stored term the rules now reject must not break the Studio.
      projectTerms: readProjectCensorTerms(project.censorTerms),
      canApply:
        workspaceAllowsCapability(scope, "content.edit") &&
        hasFeature(scope.pricingTier, "editor.censoring"),
      planTier: resolvePricingTier(scope.pricingTier),
    } as const;
  }

  /** The Workspace's censored words: the built-in defaults until someone edits the list. */
  async getWorkspaceWords(scope: BrandActorScope): Promise<WorkspaceCensorWords> {
    if (!workspaceAllowsCapability(scope, "content.view")) {
      throw new AutoCensorAccessError("auto_censor_forbidden");
    }
    const workspace = await this.requirePrisma().workspace.findUnique({
      where: { id: scope.workspaceId },
      select: { censorWords: true, censorWordsCustomized: true },
    });
    if (!workspace) throw new AutoCensorAccessError("auto_censor_forbidden");
    return effectiveWorkspaceCensorWords(workspace);
  }

  /** Replaces the whole list. Once edited, the stored list replaces the defaults. */
  async replaceWorkspaceWords(scope: BrandActorScope, input: unknown): Promise<WorkspaceCensorWords> {
    if (!workspaceAllowsCapability(scope, "workspace.manage")) {
      throw new AutoCensorAccessError("auto_censor_forbidden");
    }
    const words = workspaceCensorWordsSchema.parse(input);
    await this.requirePrisma().workspace.update({
      where: { id: scope.workspaceId },
      data: { censorWords: words, censorWordsCustomized: true },
    });
    return { words, customized: true };
  }

  /** Back to the built-in defaults. */
  async resetWorkspaceWords(scope: BrandActorScope): Promise<WorkspaceCensorWords> {
    if (!workspaceAllowsCapability(scope, "workspace.manage")) {
      throw new AutoCensorAccessError("auto_censor_forbidden");
    }
    await this.requirePrisma().workspace.update({
      where: { id: scope.workspaceId },
      data: { censorWords: [], censorWordsCustomized: false },
    });
    return this.getWorkspaceWords(scope);
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
    const prisma = this.requirePrisma();
    // The clip arrives as a URL segment, so it must belong to this Project:
    // an event never attaches to another Project's clip.
    const [project, clip] = await Promise.all([
      prisma.project.findFirst({
        where: { id: projectId, workspaceId: scope.workspaceId },
        select: { id: true },
      }),
      prisma.clip.findFirst({ where: { id: clipId, projectId }, select: { id: true } }),
    ]);
    if (!project || !clip) throw new AutoCensorAccessError("auto_censor_forbidden");
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
