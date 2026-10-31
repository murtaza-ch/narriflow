import { getPrismaClient } from "@narriflow/db/client";
import { acceptedRecipe } from "@narriflow/validators";
import { AutopilotExecution,type AutopilotExecutionDependencies } from "./autopilot-execution";
import { getOutboundProbeService } from "./outbound-probe-runtime";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { projectService } from "./project.service";
import { ProcessingUsageError } from "./processing-usage";
import { BrandProfileMembershipError, BrandProfileMissingAssetError, BrandProfileNotFoundError } from "./brand-profile.service";
import { isBrandAccessRefusal } from "./brand-ownership";

export function getAutopilotExecution():AutopilotExecution {
  const database=getPrismaClient();if(!database)throw Error("autopilot_database_unavailable");
  return createAutopilotExecutionRuntime({database,probe:getOutboundProbeService(),register:deliverExecutionDispatches});
}
/** The production wiring is also the integration-test seam. Only native
 * object reads and scheduler confirmation are supplied at the boundary. */
export function createAutopilotExecutionRuntime(options:Omit<AutopilotExecutionDependencies,"importEpisode">):AutopilotExecution {
  const driver: AutopilotExecution = new AutopilotExecution({ ...options,
    importEpisode: async input => {
      try {
        return await projectService.importResolvedRssEpisodes(input.scope, {
          rssUrl: input.finalUrl, episodes: [input.episode], titlePrefix: input.plan.titlePrefix ?? undefined, brandProfileId: input.plan.recipe.brandProfileId,
        }, {
          autopilotSource: input.plan.source,
          generationContext: { contentPack: input.plan.recipe.contentPack, languageCode: input.plan.recipe.languageCode, finishing: input.plan.recipe.finishing, recipe: acceptedRecipe(input.plan.recipe) },
          beforeAutopilotAdmit: tx => driver.assertIntakeWithinTransaction(tx,input),
          confirmIngest: options.register,
        });
      } catch (error) {
        if (input.plan.recipe.brandProfileId && (error instanceof BrandProfileNotFoundError || error instanceof BrandProfileMissingAssetError || error instanceof BrandProfileMembershipError || isBrandAccessRefusal(error))) return { count: 0, refusal: "brand_profile" };
        if (error instanceof ProcessingUsageError) return { count: 0, refusal: error.code === "upload_too_long" ? "too_long" : "deferred" };
        throw error;
      }
    },
  });
  return driver;
}
