import { Flex, Stack, Text } from "@chakra-ui/react";
import { ArrowUpRight, KeyRound, ShieldCheck, Terminal, Webhook } from "lucide-react";
import { callbackSigningSecrets, webhookSubscriptions, workspaceService } from "@narriflow/services";
import { hasFeature, lowestTierWithFeature, planUpgradeHighlight } from "@narriflow/validators";
import { UpgradeHero } from "../../_components/upgrade";
import { ApiVisual } from "../../_components/upgrade-visuals";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { docsUrl } from "@/lib/docs-url";
import { AddWebhookDialog } from "./add-webhook-dialog";
import { ApiKeysPanel } from "./api-keys-panel";
import { ApiQuickstart } from "./api-quickstart";
import { CallbackSecretPanel } from "./callback-secret-panel";
import { CreateKeyDialog } from "./create-key-dialog";
import { WebhooksPanel } from "./webhooks-panel";
import { IconTile } from "../_components/settings-ui";

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

export default async function ApiSettingsPage() {
  const appUser = await admitWorkspacePage("api.manage");
  const hasApi = hasFeature(appUser.workspace.pricingTier, "integrations.api");
  const apiTier = lowestTierWithFeature("integrations.api");
  const [keys, signing, webhooks] = await Promise.all([
    workspaceService.listApiKeys(appUser.actorUserId, appUser.workspaceId),
    callbackSigningSecrets.status(appUser.workspaceId),
    hasApi ? webhookSubscriptions.list({ actorUserId: appUser.actorUserId, workspaceId: appUser.workspaceId }) : [],
  ]);
  const apiBase = `${process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000"}/api/v1`;

  return (
    <Stack gap="10">
      <PageHeader
        title="Developer access"
        description="API keys, callbacks and webhooks for connecting your own tools."
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
            canManageBilling: appUser.workspace.role === "owner",
          }}
        />
      ) : null}

      <section>
        <SectionHeader icon={<KeyRound size={16} />} title="API keys" description="Each key acts for this workspace with the permissions you give it." action={hasApi ? <CreateKeyDialog /> : undefined} />
        <ApiKeysPanel
          keys={keys.map((key) => ({ ...key, createdAt: key.createdAt.toISOString(), lastUsedAt: key.lastUsedAt?.toISOString() ?? null }))}
        />
      </section>

      {hasApi ? (
        <section>
          <SectionHeader icon={<Terminal size={16} />} title="Quickstart" description="Check a key works with one request." />
          <ApiQuickstart apiBase={apiBase} />
        </section>
      ) : null}

      {hasApi ? (
        <section id="callbacks">
          <SectionHeader icon={<ShieldCheck size={16} />} title="Callbacks" description="Narriflow signs every callback so your endpoint can trust it." />
          <CallbackSecretPanel status={signing} />
        </section>
      ) : null}

      {hasApi ? (
        <section id="webhooks">
          <SectionHeader
            icon={<Webhook size={16} />}
            title="Webhooks"
            description="Push finished work to your tools as signed events."
            action={<AddWebhookDialog disabledReason={signing.current ? null : "Create a callback signing secret above first."} />}
          />
          <WebhooksPanel webhooks={webhooks} />
        </section>
      ) : null}
    </Stack>
  );
}
