import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { brandProfileService, hasFeature, recipeService, socialOAuthService } from "@narriflow/services";
import { workspaceAllowsCapability } from "@narriflow/validators";
import { RecipesPanel } from "./recipes-panel";

export default async function RecipesPage() {
  const appUser = await admitWorkspacePage("content.view");
  const [recipes, brandProfiles, accounts] = await Promise.all([
    recipeService.list(appUser),
    brandProfileService.listSummaries(appUser),
    socialOAuthService.listAccounts(appUser),
  ]);

  return (
    <RecipesPanel
      initialRecipes={recipes}
      brandProfiles={brandProfiles.map(({ id, name, isDefault }) => ({ id, name, isDefault }))}
      canEdit={workspaceAllowsCapability({ role: appUser.role, status: appUser.status }, "content.edit")}
      finishingAvailable={hasFeature(appUser.pricingTier, "campaign.operations")}
      queueAccounts={accounts
        .filter((account) => account.status === "active")
        .map(({ id, platform, displayName }) => ({ id, platform, displayName }))}
    />
  );
}
