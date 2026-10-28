"use client";

import { describeApiFailure, type WorkspaceScope } from "@narriflow/api-client";
import { createExportsClient, exportQueries } from "@narriflow/api-client/exports";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import type { ClipExportDetail } from "@narriflow/validators/api/exports";
import type { WorkspaceBootstrap } from "@narriflow/validators/api/workspace";
import { planFeatureRequirement } from "@narriflow/validators";
import { useQuery } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { useMemo, useState } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { useWorkspaceBootstrap } from "../../../../../../_components/usage";
import { ExportDeliveryClient } from "./export-delivery-client";
import ExportDeliveryLoading from "./loading";

interface ExportRoute {
  projectId: string;
  clipId: string;
  exportId: string;
}

/** The export delivery page for the selected Workspace: scoped reads, no server data. */
export function ExportDeliveryScreen(route: ExportRoute) {
  const scope = useWorkspaceScope();
  if (!scope) return <ExportDeliveryLoading />;
  return <ExportDeliveryContent key={`${scope.workspaceId}:${route.exportId}`} scope={scope} {...route} />;
}

function ExportDeliveryContent({ scope, projectId, clipId, exportId }: ExportRoute & { scope: WorkspaceScope }) {
  const runtime = useApiRuntime();
  const client = useMemo(() => createExportsClient(runtime.transport.scoped(scope)), [runtime.transport, scope]);
  // The delivery client owns the export from its first render, and file URLs in the
  // snapshot expire: never serve a cached one, and do not refetch under it.
  const detail = useQuery({
    ...exportQueries.detail(client, scope, projectId, clipId, exportId),
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const bootstrap = useWorkspaceBootstrap(scope);

  if (detail.isError || bootstrap.isError) {
    const failure = describeApiFailure(detail.error ?? bootstrap.error);
    if (failure.kind === "missing") notFound();
    return (
      <Flex minH="100dvh" align="center" justify="center" bg="bg.sidebar" p="6">
        <Stack gap="4" role="alert" align="flex-start" maxW="420px">
          <Text fontSize="13px" color="fg.muted">
            {failure.kind === "offline"
              ? "You appear to be offline. Check your connection and try again."
              : failure.kind === "forbidden"
                ? "You don't have access to download this export."
                : "This export could not be loaded."}
          </Text>
          <Button size="sm" variant="subtle" onClick={() => { void detail.refetch(); void bootstrap.refetch(); }}>
            Try again
          </Button>
        </Stack>
      </Flex>
    );
  }
  if (!detail.data || !bootstrap.data) return <ExportDeliveryLoading />;
  return <ExportDeliveryReady detail={detail.data} bootstrap={bootstrap.data} />;
}

function ExportDeliveryReady({ detail, bootstrap }: { detail: ClipExportDetail; bootstrap: WorkspaceBootstrap }) {
  // The first read is the page's starting state; later changes arrive through the stream.
  const [{ lastSeq, ...initialExport }] = useState(detail);
  const tier = bootstrap.usage.tier;
  const { capabilities } = bootstrap;
  return (
    <ExportDeliveryClient
      initialExport={initialExport}
      initialSeq={lastSeq}
      timelineRequirement={planFeatureRequirement(tier, "export.timelines")?.message ?? null}
      timelineUpgrade={featureUpgradePrompt(tier, "export.timelines", "Upgrade to edit in your own editor")}
      canEdit={capabilities["content.edit"]}
      publishingUpgrade={featureUpgradePrompt(tier, "publishing.schedule", "Upgrade to publish your clips")}
      canSendForReview={capabilities["review.manage"]}
      reviewUpgrade={featureUpgradePrompt(tier, "review.rooms", "Upgrade to share projects for client review")}
    />
  );
}
