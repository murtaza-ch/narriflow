"use client";

import { Stack, Text } from "@chakra-ui/react";
import {
  automationOverviewQueryOptions,
  createAutomationActions,
  invalidateAfterAutomationChange,
} from "@narriflow/api-client/automation";
import {
  describeApiFailure,
  type WorkspaceScope,
} from "@narriflow/api-client/core";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import {
  useApiRuntime,
  useWorkspaceScope,
} from "@/app/_components/api-provider";
import { AutopilotPanel, type AutopilotPanelApi } from "./autopilot-panel";
import AutopilotLoading from "./loading";

/** Autopilot for the selected Workspace: one aggregate read, no server data. */
export function AutopilotScreen() {
  const scope = useWorkspaceScope();
  if (!scope) return <AutopilotLoading />;
  return <AutopilotContent key={scope.workspaceId} scope={scope} />;
}

function AutopilotContent({ scope }: { scope: WorkspaceScope }) {
  const runtime = useApiRuntime();
  const { transport, queryClient } = runtime;
  const zoomNotice = useSearchParams().get("zoom") ?? undefined;
  const overview = useQuery(
    automationOverviewQueryOptions({ transport, scope }),
  );

  const api = useMemo<AutopilotPanelApi>(
    () => ({
      actions: createAutomationActions(transport, scope),
      createIntent: () => runtime.createIntent(),
      changed: () => invalidateAfterAutomationChange(queryClient, scope),
    }),
    [transport, scope, runtime, queryClient],
  );

  if (overview.isError) {
    const failure = describeApiFailure(overview.error);
    return (
      <Stack gap="4" role="alert" align="flex-start">
        <PageHeader title="Autopilot" />
        <Text fontSize="13px" color="fg.muted">
          {failure.kind === "offline"
            ? "You appear to be offline. Check your connection and try again."
            : "Autopilot could not be loaded. Nothing has been changed."}
        </Text>
        <Button
          size="sm"
          variant="subtle"
          onClick={() => void overview.refetch()}
        >
          Try again
        </Button>
      </Stack>
    );
  }
  if (!overview.data) return <AutopilotLoading />;

  const { access, ...data } = overview.data;
  return (
    <AutopilotPanel
      api={api}
      rules={data.rules}
      recipes={data.recipes}
      grants={data.grants}
      newRuleRequirement={data.newRuleRequirement}
      newRuleUpgradeTier={data.newRuleUpgradeTier}
      autopilotIncluded={data.autopilotIncluded}
      finishingAvailable={data.finishingAvailable}
      workspaceStatus={data.workspaceStatus}
      zoomEnabled={data.zoomEnabled}
      zoomConnections={data.zoomConnections}
      zoomNotice={zoomNotice}
      canManageBilling={access.canManageBilling}
      canConnectZoom={access.canConnectZoom}
      canEdit={access.canEdit}
      canRun={access.canRun}
      canTakeOver={access.canTakeOver}
    />
  );
}
