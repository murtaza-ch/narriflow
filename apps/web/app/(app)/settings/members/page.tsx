"use client";

import { Stack } from "@chakra-ui/react";
import { describeApiFailure, type WorkspaceScope } from "@narriflow/api-client";
import { billingStateQueryOptions } from "@narriflow/api-client/billing";
import { workspaceBootstrapQuery, workspaceMembersQuery } from "@narriflow/api-client/workspace";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { hasFeature } from "@narriflow/validators";
import { useQuery } from "@tanstack/react-query";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { QueryLoadError } from "@/app/_components/query-mutation-form";
import MembersLoading from "./loading";
import { MembersPanel } from "./members-panel";

export default function MembersSettingsPage() {
  const scope = useWorkspaceScope();
  return scope ? <MembersContent scope={scope} /> : <MembersLoading />;
}

function MembersContent({ scope }: { scope: WorkspaceScope }) {
  const { transport } = useApiRuntime();
  // Independent reads, started together: the lists, the plan (seats) and the viewer's role.
  const members = useQuery(workspaceMembersQuery(transport, scope));
  const billing = useQuery(billingStateQueryOptions({ transport, scope }));
  const bootstrap = useQuery(workspaceBootstrapQuery(transport, scope));

  const failed = [members, billing, bootstrap].find((query) => query.isError);
  if (failed && describeApiFailure(failed.error).kind !== "superseded") {
    return (
      <Stack gap="8">
        <PageHeader title="Members" description="Invite your team and choose what each person can do." />
        <QueryLoadError
          error={failed.error}
          what="Members"
          onRetry={() => {
            void members.refetch();
            void billing.refetch();
            void bootstrap.refetch();
          }}
        />
      </Stack>
    );
  }
  if (!members.data || !billing.data || !bootstrap.data) return <MembersLoading />;

  const billingView = billing.data.view;
  const { workspace } = bootstrap.data;
  return (
    <Stack gap="8">
      <PageHeader title="Members" description="Invite your team and choose what each person can do." />
      <MembersPanel
        scope={scope}
        actorRole={workspace.role}
        isBusiness={hasFeature(billingView.plan, "workspace.members")}
        workspaceStatus={workspace.status}
        billingView={billingView}
        members={members.data.members}
        invites={members.data.invites}
      />
    </Stack>
  );
}
