import Link from "next/link";
import { Card, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, Braces, KeyRound, Share2 } from "lucide-react";
import { workspaceAllowsCapability } from "@narriflow/services";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { StatBand } from "@narriflow/ui/components/stat-band";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";

function IntegrationRow({
  title,
  description,
  href,
  action,
  icon: Icon,
  status,
}: {
  title: string;
  description: string;
  href: string;
  action: string;
  icon: typeof Braces;
  status?: string;
}) {
  return (
    <Card.Root as="article" borderRadius="l3" borderWidth="1px"><Card.Body gap="4">
      <Flex align="center" justify="space-between" gap="3" color="fg.muted">
        <Icon size={20} />
        {status ? <Text fontSize="12px" color="fg.subtle">{status}</Text> : null}
      </Flex>
      <Stack gap="1.5" flex="1">
        <Text as="h2" fontSize="16px" fontWeight="500">{title}</Text>
        <Text fontSize="13px" lineHeight="1.65" color="fg.muted">{description}</Text>
      </Stack>
      <Button asChild size="sm" variant="subtle" alignSelf="flex-start">
        <Link href={href}>{action}<ArrowRight size={14} /></Link>
      </Button>
    </Card.Body></Card.Root>
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
      <PageHeader title="Integrations" />

      <StatBand columns={3}>
        <StatBand.Item label="AI assistant access" value={mcpAccessLabel} />
        <StatBand.Item label="Workspace role" value={<Text as="span" textTransform="capitalize">{appUser.workspace.role}</Text>} />
        <StatBand.Item label="Connection model" value="OAuth + keys" />
      </StatBand>

      <Grid templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap={{ base: "8", md: "6" }}>
        <IntegrationRow
          title="Work with Narriflow from your assistant"
          description="Use personal OAuth for interactive clients or a scoped workspace key for unattended automation."
          href="/integrations/mcp"
          action="Open setup guide"
          icon={Braces}
          status={isMcpEligible ? "Eligible" : appUser.workspace.pricingTier === "business" ? "Workspace inactive" : "Business required"}
        />
        <IntegrationRow
          title="Connect publishing accounts"
          description="Authorize TikTok, YouTube, Instagram, LinkedIn, and X accounts for scheduled workspace publishing."
          href="/settings/social-accounts"
          action="Manage social accounts"
          icon={Share2}
        />
        <IntegrationRow
          title="Manage workspace API keys"
          description={canManageApi
            ? "Create least-privilege credentials, inspect recent use, and revoke keys without affecting personal OAuth connections."
            : "API keys are managed separately by workspace members with developer-access permission."}
          href={canManageApi ? "/settings/api" : "/integrations/mcp#workspace-keys"}
          action={canManageApi ? "Manage API keys" : "Learn about API keys"}
          icon={KeyRound}
          status={canManageApi ? undefined : "Role protected"}
        />
      </Grid>
    </Stack>
  );
}
