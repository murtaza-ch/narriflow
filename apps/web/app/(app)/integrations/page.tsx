import Link from "next/link";
import { Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, Braces, KeyRound, Share2 } from "lucide-react";
import { workspaceAllowsCapability } from "@narriflow/services";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { StatBand } from "@narriflow/ui/components/stat-band";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";

function IntegrationRow({
  eyebrow,
  title,
  description,
  href,
  action,
  icon: Icon,
  status,
}: {
  eyebrow: string;
  title: string;
  description: string;
  href: string;
  action: string;
  icon: typeof Braces;
  status: string;
}) {
  return (
    <Stack
      as="article"
      gap="4"
      pt="4"
      borderTopWidth="1.5px"
      borderColor="border.strong"
      minW="0"
    >
      <Flex align="center" justify="space-between" gap="3">
        <Flex align="center" gap="2.5">
          <Icon size={17} />
          <Text textStyle="eyebrow" color="fg.subtle">{eyebrow}</Text>
        </Flex>
        <Text textStyle="data" fontSize="11px" color="fg.subtle">{status}</Text>
      </Flex>
      <Stack gap="1.5" flex="1">
        <Text as="h2" textStyle="title" fontSize="18px">{title}</Text>
        <Text fontSize="13px" lineHeight="1.65" color="fg.muted">{description}</Text>
      </Stack>
      <Button asChild size="sm" variant="outline" alignSelf="flex-start">
        <Link href={href}>{action}<ArrowRight size={14} /></Link>
      </Button>
    </Stack>
  );
}

export default async function IntegrationsPage() {
  const appUser = await admitWorkspacePage("content.view");
  const isMcpEligible =
    appUser.workspace.status === "active" && appUser.workspace.pricingTier === "business";
  const mcpAccessLabel = isMcpEligible
    ? "Ready"
    : appUser.workspace.pricingTier === "business"
      ? "Inactive"
      : "Business";
  const canManageApi = workspaceAllowsCapability(appUser.workspace, "api.manage",
  );

  return (
    <Stack gap="8" maxW="1120px" mx="auto">
      <PageHeader
        eyebrow={appUser.workspace.workspaceName}
        title="Integrations"
        description="Connect Narriflow to AI assistants, publishing destinations, and workspace automation."
      />

      <StatBand columns={3}>
        <StatBand.Item label="AI assistant access" value={mcpAccessLabel} />
        <StatBand.Item label="Workspace role" value={<Text as="span" textTransform="capitalize">{appUser.workspace.role}</Text>} />
        <StatBand.Item label="Connection model" value="OAuth + keys" />
      </StatBand>

      <Grid templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap={{ base: "8", md: "6" }}>
        <IntegrationRow
          eyebrow="AI clients / MCP"
          title="Work with Narriflow from your assistant"
          description="Use personal OAuth for interactive clients or a scoped workspace key for unattended automation."
          href="/integrations/mcp"
          action="Open setup guide"
          icon={Braces}
          status={isMcpEligible ? "ELIGIBLE" : appUser.workspace.pricingTier === "business" ? "WORKSPACE INACTIVE" : "BUSINESS REQUIRED"}
        />
        <IntegrationRow
          eyebrow="Social publishing"
          title="Connect publishing accounts"
          description="Authorize TikTok, YouTube, Instagram, LinkedIn, and X accounts for scheduled workspace publishing."
          href="/settings/social-accounts"
          action="Manage social accounts"
          icon={Share2}
          status="OAUTH"
        />
        <IntegrationRow
          eyebrow="Developer access"
          title="Manage workspace API keys"
          description={canManageApi
            ? "Create least-privilege credentials, inspect recent use, and revoke keys without affecting personal OAuth connections."
            : "API keys are managed separately by workspace members with developer-access permission."}
          href={canManageApi ? "/settings/api" : "/integrations/mcp#workspace-keys"}
          action={canManageApi ? "Manage API keys" : "Learn about API keys"}
          icon={KeyRound}
          status={canManageApi ? "MANAGE ACCESS" : "ROLE PROTECTED"}
        />
      </Grid>
    </Stack>
  );
}
