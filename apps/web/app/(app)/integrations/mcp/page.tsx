import Link from "next/link";
import { Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { ArrowLeft, ArrowRight, ArrowUpRight, CalendarClock, CircleAlert, Download, Rss, ScanEye, Scissors, Upload } from "lucide-react";
import { workspaceAllowsCapability } from "@narriflow/services";
import { hasFeature, lowestTierWithFeature, PLAN_CATALOG, resolvePricingTier } from "@narriflow/validators";
import { Button } from "@narriflow/ui/components/button";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { docsUrl } from "@/lib/docs-url";
import { featureUpgradePrompt } from "@/lib/feature-upgrade-prompt";
import { LockedButton } from "../../_components/upgrade";
import { inspectMcpConfiguration } from "@/lib/mcp-configuration";
import { AssistantSetup, PromptCards } from "./assistant-setup";

const CAPABILITIES = [
  { icon: Upload, title: "Import", description: "Video links or files from your computer" },
  { icon: Scissors, title: "Clip", description: "Scored, captioned and on brand" },
  { icon: ScanEye, title: "Review", description: "Scores, timing and transcripts" },
  { icon: Download, title: "Export", description: "The exact version you approved" },
  { icon: CalendarClock, title: "Schedule", description: "To your connected social accounts" },
  { icon: Rss, title: "Autopilot", description: "Clip new podcast episodes as they land" },
] as const;

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Flex align="center" justify="space-between" gap="3" mb="3">
      <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
        {children}
      </Text>
      {action}
    </Flex>
  );
}

export default async function McpIntegrationPage() {
  const appUser = await admitWorkspacePage("content.view");
  const mcpUrl = `${process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000"}/mcp`;
  const configuration = await inspectMcpConfiguration({ resourceUrl: process.env.NEXT_PUBLIC_APP_URL ? mcpUrl : undefined, issuerUrl: process.env.CLERK_OAUTH_ISSUER, hasVerificationSecret: Boolean(process.env.CLERK_SECRET_KEY), hasConfirmationSecret: Buffer.byteLength(process.env.MCP_CONTINUATION_SECRET ?? "") >= 32 });
  const { workspace } = appUser;
  const hasPlan = hasFeature(workspace.pricingTier, "integrations.mcp");
  const requiredPlan = PLAN_CATALOG[lowestTierWithFeature("integrations.mcp") ?? "business"].name;
  const currentPlan = PLAN_CATALOG[resolvePricingTier(workspace.pricingTier)].name;
  const upgrade = featureUpgradePrompt(workspace.pricingTier, "integrations.mcp", "Upgrade to connect your AI assistant");
  const isEligible = hasPlan && workspace.status === "active";
  const canManageApi = workspaceAllowsCapability(workspace, "api.manage");
  const canManageBilling = workspaceAllowsCapability(workspace, "billing.manage");

  const status = !hasPlan
    ? { ready: false, label: `Needs the ${requiredPlan} plan` }
    : !isEligible
      ? { ready: false, label: "Workspace inactive" }
      : configuration.verified
        ? { ready: true, label: `${currentPlan} plan · Ready to connect` }
        : { ready: false, label: configuration.label };

  const blocker = !hasPlan
    ? canManageBilling
      ? `Upgrade to ${requiredPlan} to connect an assistant. You can read the setup now.`
      : `Ask the workspace owner to upgrade to ${requiredPlan} to connect an assistant.`
    : !isEligible
      ? `This workspace is ${workspace.status.replace("_", " ")}. Tools stay off until it's active.${canManageBilling ? "" : " Ask the workspace owner to fix billing."}`
      : !configuration.verified
        ? configuration.description
        : null;

  const notice = blocker ? (
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
        <Text fontSize="13px">{blocker}</Text>
      </Flex>
      {!hasPlan ? (
        upgrade && canManageBilling ? (
          <LockedButton size="sm" variant="subtle" flexShrink={0} prompt={upgrade}>
            Upgrade
          </LockedButton>
        ) : null
      ) : !isEligible && canManageBilling ? (
        <Button asChild size="sm" variant="subtle" flexShrink={0}>
          <Link href="/settings/billing">
            Open billing
            <ArrowRight size={16} />
          </Link>
        </Button>
      ) : null}
    </Flex>
  ) : undefined;

  return (
    <Stack gap="10" maxW="880px" mx="auto" w="full" pt={{ base: "2", md: "4" }}>
      <Button asChild size="sm" variant="ghost" color="fg.muted" alignSelf="flex-start" mb="-8">
        <Link href="/integrations">
          <ArrowLeft size={16} />
          Integrations
        </Link>
      </Button>
      <AssistantSetup mcpUrl={mcpUrl} status={status} notice={notice} />

      <section>
        <SectionTitle>Try a prompt</SectionTitle>
        <PromptCards />
      </section>

      <section>
        <SectionTitle
          action={
            <Button asChild size="xs" variant="ghost" color="fg.muted">
              <a href={docsUrl("ai/tools")} target="_blank" rel="noreferrer">
                All tools
                <ArrowUpRight size={14} />
              </a>
            </Button>
          }
        >
          What your assistant can do
        </SectionTitle>
        <Grid templateColumns={{ base: "1fr", sm: "repeat(2, minmax(0, 1fr))", md: "repeat(3, minmax(0, 1fr))" }} gap="2">
          {CAPABILITIES.map(({ icon: Icon, title, description }) => (
            <Stack key={title} gap="3" bg="bg.subtle" borderRadius="12px" p="4">
              <Flex boxSize="8" borderRadius="full" bg="bg.soft" align="center" justify="center" color="fg">
                <Icon size={16} />
              </Flex>
              <Stack gap="0.5">
                <Text fontSize="14px" fontWeight="500">
                  {title}
                </Text>
                <Text fontSize="13px" color="fg.muted">
                  {description}
                </Text>
              </Stack>
            </Stack>
          ))}
        </Grid>
      </section>

      <Flex gap={{ base: "2", md: "6" }} direction={{ base: "column", md: "row" }} fontSize="13px" color="fg.muted" pb="4">
        <Text>
          Automating without a person?{" "}
          {canManageApi ? (
            <Link href="/settings/api" style={{ color: "var(--chakra-colors-fg)" }}>
              Create an API key →
            </Link>
          ) : (
            <a href={docsUrl("ai/permissions")} target="_blank" rel="noreferrer" style={{ color: "var(--chakra-colors-fg)" }}>
              Use a workspace API key →
            </a>
          )}
        </Text>
        <Text>
          Not working?{" "}
          <a href={docsUrl("ai/troubleshooting")} target="_blank" rel="noreferrer" style={{ color: "var(--chakra-colors-fg)" }}>
            Troubleshooting →
          </a>
        </Text>
      </Flex>
    </Stack>
  );
}
