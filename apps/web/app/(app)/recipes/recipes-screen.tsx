"use client";

import { Stack, Text } from "@chakra-ui/react";
import { brandQueries } from "@narriflow/api-client/brand";
import { CONNECTION_FAILURE_MESSAGE, describeApiFailure, type WorkspaceScope } from "@narriflow/api-client/core";
import { createPublishingClient, publishingKeys, publishingReads } from "@narriflow/api-client/publishing";
import { createRecipesActions, invalidateAfterRecipeChange, recipesListQueryOptions } from "@narriflow/api-client/recipes";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { hasFeature } from "@narriflow/validators";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { gateQueries } from "@/app/_components/query-gate";
import { useWorkspaceBootstrap } from "../_components/usage";
import RecipesLoading from "./loading";
import { type RecipeBrandLook, RecipesPanel, type RecipesPanelApi } from "./recipes-panel";

/** Recipes for the selected Workspace: four reads run together, no server data. */
export function RecipesScreen() {
  const scope = useWorkspaceScope();
  if (!scope) return <RecipesLoading />;
  return <RecipesContent key={scope.workspaceId} scope={scope} />;
}

function RecipesContent({ scope }: { scope: WorkspaceScope }) {
  const runtime = useApiRuntime();
  const { transport, queryClient } = runtime;
  const recipes = useQuery(recipesListQueryOptions({ transport, scope }));
  // Every Brand Profile, with the colors and logo each Recipe's clips are drawn in.
  const kit = useQuery(brandQueries({ transport, scope }).kit());
  const accounts = useQuery(
    queryOptions({
      queryKey: publishingKeys.accounts(scope),
      queryFn: () => publishingReads(createPublishingClient(transport.scoped(scope))).accounts(),
      staleTime: 60_000,
    }),
  );
  const bootstrap = useWorkspaceBootstrap(scope);

  const api = useMemo<RecipesPanelApi>(
    () => ({
      actions: createRecipesActions(transport, scope),
      createIntent: () => runtime.createIntent(),
      changed: () => invalidateAfterRecipeChange(queryClient, scope),
    }),
    [transport, scope, runtime, queryClient],
  );

  const gate = gateQueries([recipes, kit, accounts, bootstrap]);
  if (gate.status === "failed") {
    const failure = describeApiFailure(gate.error);
    return (
      <Stack gap="4" role="alert" align="flex-start">
        <PageHeader title="Recipes" />
        <Text fontSize="13px" color="fg.muted">
          {failure.kind === "offline"
            ? CONNECTION_FAILURE_MESSAGE
            : "Recipes could not be loaded. Nothing has been changed."}
        </Text>
        <Button size="sm" variant="subtle" onClick={gate.retry}>
          Try again
        </Button>
      </Stack>
    );
  }
  if (gate.status === "loading") return <RecipesLoading />;

  const [recipeList, brandKit, publishingAccounts, workspaceBootstrap] = gate.data;

  const brandProfiles = brandKit.profiles.map(({ id, name }) => ({
    id,
    name,
    isDefault: id === brandKit.defaultProfileId,
  }));
  const brandLooks: Record<string, RecipeBrandLook> = Object.fromEntries(
    brandKit.profiles.map((profile) => [
      profile.id,
      {
        colors: {
          primaryColor: profile.identity.primaryColor,
          secondaryColor: profile.identity.secondaryColor,
          accentColor: profile.identity.accentColor,
        },
        logoUrl:
          profile.assets.find((asset) => asset.id === profile.identity.primaryLogoAssetId || asset.role === "logo")
            ?.accessUrl ?? null,
      },
    ]),
  );

  return (
    <RecipesPanel
      recipes={recipeList}
      brandProfiles={brandProfiles}
      brandLooks={brandLooks}
      canEdit={workspaceBootstrap.capabilities["content.edit"]}
      finishingAvailable={hasFeature(workspaceBootstrap.usage.tier, "campaign.operations")}
      queueAccounts={publishingAccounts.accounts
        .filter((account) => account.status === "active")
        .map(({ id, platform, displayName }) => ({ id, platform, displayName }))}
      api={api}
    />
  );
}
