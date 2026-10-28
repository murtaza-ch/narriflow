"use client";

import { Box, Flex, Input, Stack, Text } from "@chakra-ui/react";
import { describeApiFailure, type WorkspaceScope } from "@narriflow/api-client";
import { createPublishingClient, publishingKeys } from "@narriflow/api-client/publishing";
import {
  performanceGuidanceMutation,
  updateWorkspaceMutation,
  workspaceBootstrapQuery,
  workspaceCensorWordsQuery,
  workspaceProfileQuery,
} from "@narriflow/api-client/workspace";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Button } from "@narriflow/ui/components/button";
import { Combobox } from "@narriflow/ui/components/combobox";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { Building2, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { QueryLoadError, QueryMutationForm } from "@/app/_components/query-mutation-form";
import { AccessNote } from "../_components/access-note";
import { SettingsCard, StatusPill } from "../_components/settings-ui";
import { CensorWordsCard } from "./censor-words-card";
import WorkspaceSettingsLoading from "./loading";
import { PerformanceGuidanceField } from "./performance-guidance-field";
import { WorkspaceAvatarControl } from "./workspace-avatar-control";

const TIMEZONE_ITEMS = ["UTC", ...Intl.supportedValuesOf("timeZone")].map((timezone) => ({
  value: timezone,
  label: timezone.replaceAll("_", " "),
}),
);

export default function WorkspaceSettingsPage() {
  const scope = useWorkspaceScope();
  return scope ? <WorkspaceSettingsContent scope={scope} /> : <WorkspaceSettingsLoading />;
}

function performanceGuidanceQuery(
  transport: ReturnType<typeof useApiRuntime>["transport"],
  scope: WorkspaceScope,
) {
  const client = createPublishingClient(transport.scoped(scope));
  return queryOptions({
    queryKey: publishingKeys.guidance(scope),
    queryFn: async ({ signal }) =>
      (await client.performance.guidance.$get(undefined, { init: { signal } })).json(),
  });
}

function WorkspaceSettingsContent({ scope }: { scope: WorkspaceScope }) {
  const runtime = useApiRuntime();
  const { transport } = runtime;
  // Four independent reads, started together.
  const profile = useQuery(workspaceProfileQuery(transport, scope));
  const bootstrap = useQuery(workspaceBootstrapQuery(transport, scope));
  const guidanceRead = useQuery(performanceGuidanceQuery(transport, scope));
  const censorWords = useQuery(workspaceCensorWordsQuery(transport, scope));
  const update = useMutation(useMemo(() => updateWorkspaceMutation(runtime, scope), [runtime, scope]));
  const setGuidance = useMutation(useMemo(() => performanceGuidanceMutation(runtime, scope), [runtime, scope]));

  const reads = [profile, bootstrap, guidanceRead, censorWords];
  const failed = reads.find((query) => query.isError);
  if (failed && describeApiFailure(failed.error).kind !== "superseded") {
    return (
      <Stack gap="6">
        <PageHeader title="Workspace settings" description="Name, timezone, and how Narriflow picks clips here." />
        <QueryLoadError
          error={failed.error}
          what="Workspace settings"
          onRetry={() => {
            for (const query of reads) if (query.isError) void query.refetch();
          }}
        />
      </Stack>
    );
  }
  if (!profile.data || !bootstrap.data || !guidanceRead.data || !censorWords.data) return <WorkspaceSettingsLoading />;

  const workspace = profile.data;
  const guidance = guidanceRead.data.guidance;
  // The same capability the save routes and avatar routes admit with.
  const canManage = bootstrap.data.capabilities["workspace.manage"];
  return (
    <Stack gap="6">
      <PageHeader title="Workspace settings" description="Name, timezone, and how Narriflow picks clips here." />
      <AccessNote access={workspace} capability="workspace.manage" action="change workspace settings" mt="-2" />
      <SettingsCard
        icon={<Building2 size={16} />}
        title="Workspace"
        action={
          <>
            <StatusPill tone={workspace.status === "active" ? "accent" : "warning"}>
              <Text as="span" textTransform="capitalize">{workspace.status.replace("_", " ")}</Text>
            </StatusPill>
            <StatusPill>{workspace.isPersonal ? "Personal" : "Collaborative"}</StatusPill>
          </>
        }
      >
        <Flex gap={{ base: "5", md: "8" }} direction={{ base: "column", md: "row" }} align={{ md: "flex-start" }}>
          <WorkspaceAvatarControl scope={scope} avatarUrl={workspace.avatarUrl} workspaceName={workspace.name} canManage={canManage} />
          <Box flex="1" minW="0" maxW={{ md: "560px" }}>
            <QueryMutationForm
              mutation={update}
              toVariables={(formData) => ({
                name: String(formData.get("name") ?? ""),
                timezone: String(formData.get("timezone") ?? ""),
              })}
            >
              {({ pending }) => (
                <Stack gap="4">
                  <Stack gap="1.5">
                    <label htmlFor="workspace-name"><Text as="span" fontSize="13px" fontWeight="500">Name</Text></label>
                    <Input id="workspace-name" name="name" defaultValue={workspace.name} maxLength={80} disabled={!canManage} />
                  </Stack>
                  <Stack gap="1.5">
                    <label htmlFor="workspace-timezone"><Text as="span" fontSize="13px" fontWeight="500">Timezone</Text></label>
                    <Combobox id="workspace-timezone" name="timezone" ariaLabel="Workspace timezone" defaultValue={workspace.timezone} items={TIMEZONE_ITEMS} placeholder="Search timezones" disabled={!canManage} />
                    <Text fontSize="12px" color="fg.subtle">Used for the calendar and publishing defaults.</Text>
                  </Stack>
                  {canManage ? (
                    <Button type="submit" size="sm" alignSelf="flex-start" loading={pending} loadingText="Saving…">Save changes</Button>
                  ) : null}
                </Stack>
              )}
            </QueryMutationForm>
          </Box>
        </Flex>
      </SettingsCard>
      <SettingsCard icon={<Sparkles size={16} />} title="Clip picking" description="Let what performed well guide which moments become clips.">
        <QueryMutationForm
          mutation={setGuidance}
          toVariables={(formData) => formData.get("enabled") === "on"}
        >
          {({ pending }) => (
            <Stack gap="4" maxW="640px">
              <PerformanceGuidanceField
                enabled={guidance.enabled}
                qualifies={guidance.qualifies}
                minimumClips={guidance.minimumWorkspacePosts}
                canManage={canManage}
              />
              {canManage ? (
                <Button type="submit" size="sm" alignSelf="flex-start" loading={pending} loadingText="Saving…">Save</Button>
              ) : null}
            </Stack>
          )}
        </QueryMutationForm>
      </SettingsCard>
      <CensorWordsCard scope={scope} words={censorWords.data.words} customized={censorWords.data.customized} canManage={canManage} />
    </Stack>
  );
}
