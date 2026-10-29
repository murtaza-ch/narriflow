"use client";

import { Flex, Stack, Text } from "@chakra-ui/react";
import type { WorkspaceScope } from "@narriflow/api-client";
import { developerSettingsQuery } from "@narriflow/api-client/developer";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { lowestTierWithFeature, planUpgradeHighlight } from "@narriflow/validators";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, KeyRound, ShieldCheck, Terminal, Webhook } from "lucide-react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { docsUrl } from "@/lib/docs-url";
import { PublishingLoadError } from "@/lib/publishing-load-error";
import { UpgradeHero } from "../../_components/upgrade";
import { ApiVisual } from "../../_components/upgrade-visuals";
import { useWorkspaceBootstrap } from "../../_components/usage";
import { AccessNote } from "../_components/access-note";
import { IconTile } from "../_components/settings-ui";
import { AddWebhookDialog } from "./add-webhook-dialog";
import { ApiKeysPanel } from "./api-keys-panel";
import { ApiQuickstart } from "./api-quickstart";
import { CallbackSecretPanel } from "./callback-secret-panel";
import { CreateKeyDialog } from "./create-key-dialog";
import ApiSettingsLoading from "./loading";
import { WebhooksPanel } from "./webhooks-panel";

const TITLE = "Developer access";
const DESCRIPTION = "API keys, callbacks and webhooks for connecting your own tools.";

/** A section's header: icon, title, one line on what it's for, and its action on the right. */
function SectionHeader({ icon, title, description, action }: { icon: React.ReactNode; title: string; description: string; action?: React.ReactNode }) {
  return (
    <Flex align={{ base: "flex-start", sm: "center" }} justify="space-between" gap="3" mb="4" direction={{ base: "column", sm: "row" }}>
      <Flex align="center" gap="3" minW="0">
        <IconTile>{icon}</IconTile>
        <Stack gap="0.5" minW="0">
          <Text as="h2" fontSize="15px" fontWeight="500">
            {title}
          </Text>
          <Text fontSize="13px" color="fg.muted">
            {description}
          </Text>
        </Stack>
      </Flex>
      {action ? <Flex align="center" gap="3" flexShrink={0}>{action}</Flex> : null}
    </Flex>
  );
}

/** The public REST base the quickstart snippets call. */
function apiBaseUrl() {
  return `${(process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "")}/api/v1`;
}

/** Developer access for the selected Workspace: one aggregate read, one-time secrets held by the dialogs that show them. */
export function ApiSettingsScreen() {
  const scope = useWorkspaceScope();
  if (!scope) return <ApiSettingsLoading />;
  return <ApiSettingsContent key={scope.workspaceId} scope={scope} />;
}

function ApiSettingsContent({ scope }: { scope: WorkspaceScope }) {
  const { transport } = useApiRuntime();
  const bootstrap = useWorkspaceBootstrap(scope);
  // Started together with the bootstrap, which the shell has normally cached already; a member
  // without api.manage (known from it) never asks for the private settings.
  const canManage = bootstrap.data ? bootstrap.data.capabilities["api.manage"] : true;
  const settings = useQuery({ ...developerSettingsQuery(transport, scope), enabled: canManage });

  const error = bootstrap.error ?? settings.error;
  if (error) {
    return (
      <PublishingLoadError
        error={error}
        title={TITLE}
        description={DESCRIPTION}
        what="Developer access"
        onRetry={() => {
          void bootstrap.refetch();
          void settings.refetch();
        }}
      />
    );
  }
  if (!bootstrap.data) return <ApiSettingsLoading />;
  const { workspace } = bootstrap.data;
  if (!canManage) {
    return (
      <Stack gap="6">
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <AccessNote access={workspace} capability="api.manage" action="manage API keys and webhooks" />
      </Stack>
    );
  }
  if (!settings.data) return <ApiSettingsLoading />;

  const { apiAccess: hasApi, keys, signing, webhooks } = settings.data;
  const apiTier = lowestTierWithFeature("integrations.api");

  return (
    <Stack gap="10">
      <PageHeader
        title={TITLE}
        description={DESCRIPTION}
        actions={
          <Button asChild size="sm" variant="subtle">
            <a href={docsUrl("api/introduction")} target="_blank" rel="noreferrer">
              API docs
              <ArrowUpRight size={16} />
            </a>
          </Button>
        }
      />

      {!hasApi ? (
        <UpgradeHero
          title="Automate Narriflow from your own tools"
          points={["Create projects and fetch clips with API keys, n8n, or your AI assistant.", "Get signed webhooks the moment renders finish."]}
          ctaLabel="Upgrade to use the API"
          visual={<ApiVisual />}
          prompt={{
            tier: apiTier,
            headline: "Upgrade to use the API",
            highlight: apiTier ? planUpgradeHighlight(apiTier, "integrations.api") : undefined,
            canManageBilling: workspace.role === "owner",
          }}
        />
      ) : null}

      <section>
        <SectionHeader icon={<KeyRound size={16} />} title="API keys" description="Each key acts for this workspace with the permissions you give it." action={hasApi ? <CreateKeyDialog scope={scope} /> : undefined} />
        <ApiKeysPanel scope={scope} keys={keys} />
      </section>

      {hasApi ? (
        <section>
          <SectionHeader icon={<Terminal size={16} />} title="Quickstart" description="Check a key works with one request." />
          <ApiQuickstart apiBase={apiBaseUrl()} />
        </section>
      ) : null}

      {hasApi ? (
        <section id="callbacks">
          <SectionHeader icon={<ShieldCheck size={16} />} title="Callbacks" description="Narriflow signs every callback so your endpoint can trust it." />
          <CallbackSecretPanel scope={scope} status={signing} />
        </section>
      ) : null}

      {hasApi ? (
        <section id="webhooks">
          <SectionHeader
            icon={<Webhook size={16} />}
            title="Webhooks"
            description="Push finished work to your tools as signed events."
            action={<AddWebhookDialog scope={scope} disabledReason={signing.current ? null : "Create a callback signing secret above first."} />}
          />
          <WebhooksPanel scope={scope} webhooks={webhooks} />
        </section>
      ) : null}
    </Stack>
  );
}
