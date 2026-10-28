import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { brandProfileService, hasFeature, recipeService, socialOAuthService } from "@narriflow/services";
import { workspaceAllowsCapability } from "@narriflow/validators";
import { RecipesPanel } from "./recipes-panel";

export default async function RecipesPage() {
  const appUser = await admitWorkspacePage("content.view");
  const [recipes, brandProfiles, brandAggregates, accounts] = await Promise.all([
    recipeService.list(appUser),
    brandProfileService.listSummaries(appUser),
    // Colors and logo, so each Recipe's clips are drawn in its brand.
    brandProfileService.list(appUser),
    socialOAuthService.listAccounts(appUser),
  ]);

  return (
    <RecipesPanel
      initialRecipes={recipes}
      brandProfiles={brandProfiles.map(({ id, name, isDefault }) => ({ id, name, isDefault }))}
      brandLooks={Object.fromEntries(brandAggregates.map((profile) => [profile.id, {
        colors: { primaryColor: profile.identity.primaryColor, secondaryColor: profile.identity.secondaryColor, accentColor: profile.identity.accentColor },
        logoUrl: profile.assets.find((asset) => asset.id === profile.identity.primaryLogoAssetId || asset.role === "logo")?.accessUrl ?? null,
      }]))}
      canEdit={workspaceAllowsCapability({ role: appUser.role, status: appUser.status }, "content.edit")}
      finishingAvailable={hasFeature(appUser.pricingTier, "campaign.operations")}
      queueAccounts={accounts
        .filter((account) => account.status === "active")
        .map(({ id, platform, displayName }) => ({ id, platform, displayName }))}
    />
  );
}
