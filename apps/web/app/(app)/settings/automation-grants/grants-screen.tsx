"use client";

import { Stack, Text } from "@chakra-ui/react";
import {
  createAutomationActions,
  invalidateAfterAutomationChange,
  standingGrantsQueryOptions,
} from "@narriflow/api-client/automation";
import { describeApiFailure, type WorkspaceScope } from "@narriflow/api-client/core";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { useWorkspaceBootstrap } from "../../_components/usage";
import { GrantsPanel, type GrantsPanelApi } from "./grants-panel";
import GrantsLoading from "./loading";

/** Automation grants for the selected Workspace: the grants aggregate and the viewer's access are read together. */
export function GrantsScreen() {
  const scope = useWorkspaceScope();
  if (!scope) return <GrantsLoading />;
  return <GrantsContent key={scope.workspaceId} scope={scope} />;
}

function GrantsContent({ scope }: { scope: WorkspaceScope }) {
  const runtime = useApiRuntime();
  const { transport, queryClient } = runtime;
  const rule = useSearchParams().get("rule");
  const grants = useQuery(standingGrantsQueryOptions({ transport, scope }));
  const bootstrap = useWorkspaceBootstrap(scope);

  const api = useMemo<GrantsPanelApi>(
    () => ({
      actions: createAutomationActions(transport, scope),
      changed: () => invalidateAfterAutomationChange(queryClient, scope),
    }),
    [transport, scope, queryClient],
  );

  const failed = [grants, bootstrap].find((query) => query.isError);
  if (failed) {
    const failure = describeApiFailure(failed.error);
    return (
      <Stack gap="8">
        <PageHeader title="Automation grants" description="Let an Autopilot rule post or send review rounds without a click." />
        <Stack gap="4" role="alert" align="flex-start">
          <Text fontSize="13px" color="fg.muted">
            {failure.kind === "offline"
              ? "You appear to be offline. Check your connection and try again."
              : "Automation grants could not be loaded. Nothing has been changed."}
          </Text>
          <Button
            size="sm"
            variant="subtle"
            onClick={() => {
              for (const query of [grants, bootstrap]) if (query.isError) void query.refetch();
            }}
          >
            Try again
          </Button>
        </Stack>
      </Stack>
    );
  }
  if (!grants.data || !bootstrap.data) return <GrantsLoading />;

  const data = grants.data;
  const { role, status } = bootstrap.data.workspace;
  return (
    <Stack gap="8">
      <PageHeader title="Automation grants" description="Let an Autopilot rule post or send review rounds without a click." />
      <GrantsPanel
        api={api}
        grants={data.grants}
        rules={data.rules}
        accounts={data.accounts}
        canManage={data.canManage}
        reviewAvailable={data.reviewAvailable}
        // Grants belong to Autopilot rules, so a plan without Autopilot offers the upgrade.
        autopilotUpgrade={featureUpgradePrompt(data.pricingTier, "automation.autopilot", "Upgrade to publish automatically")}
        reviewUpgrade={featureUpgradePrompt(data.pricingTier, "review.rooms", "Upgrade to send review rounds")}
        access={{ role, status }}
        initialRuleId={data.rules.some((entry) => entry.id === rule) ? rule : null}
      />
    </Stack>
  );
}
