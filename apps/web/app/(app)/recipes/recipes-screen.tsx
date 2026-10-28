"use client";

import { Stack, Text } from "@chakra-ui/react";
import { brandQueries } from "@narriflow/api-client/brand";
import { describeApiFailure, type WorkspaceScope } from "@narriflow/api-client/core";
import { createPublishingClient, publishingKeys, publishingReads } from "@narriflow/api-client/publishing";
import { createRecipesActions, invalidateAfterRecipeChange, recipesListQueryOptions } from "@narriflow/api-client/recipes";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { hasFeature } from "@narriflow/validators";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
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

  const failed = [recipes, kit, accounts, bootstrap].find((query) => query.isError);
  if (failed) {
    const failure = describeApiFailure(failed.error);
    return (
      <Stack gap="4" role="alert" align="flex-start">
        <PageHeader title="Recipes" />
        <Text fontSize="13px" color="fg.muted">
          {failure.kind === "offline"
            ? "You appear to be offline. Check your connection and try again."
            : "Recipes could not be loaded. Nothing has been changed."}
        </Text>
        <Button
          size="sm"
          variant="subtle"
          onClick={() => {
            for (const query of [recipes, kit, accounts, bootstrap]) if (query.isError) void query.refetch();
          }}
        >
          Try again
        </Button>
      </Stack>
    );
  }
  if (!recipes.data || !kit.data || !accounts.data || !bootstrap.data) return <RecipesLoading />;

  const brandProfiles = kit.data.profiles.map(({ id, name }) => ({
    id,
    name,
    isDefault: id === kit.data.defaultProfileId,
  }));
  const brandLooks: Record<string, RecipeBrandLook> = Object.fromEntries(
    kit.data.profiles.map((profile) => [
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
      recipes={recipes.data}
      brandProfiles={brandProfiles}
      brandLooks={brandLooks}
      canEdit={bootstrap.data.capabilities["content.edit"]}
      finishingAvailable={hasFeature(bootstrap.data.usage.tier, "campaign.operations")}
      queueAccounts={accounts.data.accounts
        .filter((account) => account.status === "active")
        .map(({ id, platform, displayName }) => ({ id, platform, displayName }))}
      api={api}
    />
  );
}
