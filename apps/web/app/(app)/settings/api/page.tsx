import Link from "next/link";
import { Flex, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, ArrowUpRight, CircleAlert } from "lucide-react";
import { callbackSigningSecrets, webhookSubscriptions, workspaceService } from "@narriflow/services";
import { hasFeature, lowestTierWithFeature, PLAN_CATALOG } from "@narriflow/validators";
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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted" mb="3">
      {children}
    </Text>
  );
}

export default async function ApiSettingsPage() {
  const appUser = await admitWorkspacePage("api.manage");
  const hasApi = hasFeature(appUser.workspace.pricingTier, "integrations.api");
  const apiPlan = PLAN_CATALOG[lowestTierWithFeature("integrations.api") ?? "business"].name;
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
        actions={
          <>
            <Button asChild size="sm" variant="ghost" color="fg.muted">
              <a href={docsUrl("api/introduction")} target="_blank" rel="noreferrer">
                API docs
                <ArrowUpRight size={16} />
              </a>
            </Button>
            {hasApi ? <CreateKeyDialog /> : null}
          </>
        }
      />

      {!hasApi ? (
        <Flex
          align={{ base: "flex-start", md: "center" }}
          justify="space-between"
          direction={{ base: "column", md: "row" }}
          gap="3"
          bg="bg.subtle"
          borderRadius="12px"
          px="4"
          py="3"
        >
          <Flex align="flex-start" gap="2.5" color="fg.muted">
            <CircleAlert size={16} style={{ marginTop: 2, flexShrink: 0 }} />
            <Text fontSize="13px">{`API keys, callbacks and webhooks need the ${apiPlan} plan.`}</Text>
          </Flex>
          <Button asChild size="sm" variant="subtle" flexShrink={0}>
            <Link href="/settings/billing">
              View plans
              <ArrowRight size={16} />
            </Link>
          </Button>
        </Flex>
      ) : null}

      <section>
        <SectionTitle>API keys</SectionTitle>
        <ApiKeysPanel
          keys={keys.map((key) => ({ ...key, createdAt: key.createdAt.toISOString(), lastUsedAt: key.lastUsedAt?.toISOString() ?? null }))}
        />
      </section>

      {hasApi ? <ApiQuickstart apiBase={apiBase} /> : null}

      {hasApi ? (
        <section id="callbacks">
          <SectionTitle>Callbacks</SectionTitle>
          <CallbackSecretPanel status={signing} />
        </section>
      ) : null}

      {hasApi ? (
        <section id="webhooks">
          <Flex align="center" justify="space-between" mb="3" gap="3">
            <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
              Webhooks
            </Text>
            <AddWebhookDialog disabledReason={signing.current ? null : "Create a callback signing secret first"} />
          </Flex>
          <WebhooksPanel webhooks={webhooks} />
        </section>
      ) : null}
    </Stack>
  );
}
