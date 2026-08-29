import Link from "next/link";
import { Flex, Grid, Stack, Text } from "@chakra-ui/react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Braces,
  CheckCircle2,
  CircleAlert,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  TerminalSquare,
  UserRound,
} from "lucide-react";
import { workspaceAllowsCapability } from "@narriflow/services";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { StatBand } from "@narriflow/ui/components/stat-band";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { CopyControl } from "../_components/copy-control";

const TOOLS = [
  { name: "narriflow_list_workspaces", behavior: "Read", description: "List memberships and MCP eligibility.",
  },
  { name: "narriflow_list_projects", behavior: "Read", description: "Browse workspace projects and processing statistics.",
  },
  { name: "narriflow_get_project", behavior: "Read", description: "Fetch a project, transcript summary, and detected clips.",
  },
  { name: "narriflow_get_workspace_usage", behavior: "Read", description: "Check plan limits and monthly processing-minute usage.",
  },
  { name: "narriflow_list_autopilot_rules", behavior: "Read", description: "Inspect RSS autopilot rules.",
  },
  { name: "narriflow_create_rss_autopilot_rule", behavior: "Write", description: "Create a rule that can import and process new episodes.",
  },
  { name: "narriflow_run_autopilot_rule_now", behavior: "Write", description: "Mark an existing rule due for the worker.",
  },
] as const;

function SectionHeading({ eyebrow, title, description,
}: { eyebrow: string; title: string; description?: string;
}) {
  return (
    <Stack gap="1.5">
      <Text textStyle="eyebrow" color="fg.subtle">{eyebrow}</Text>
      <Text as="h2" textStyle="title" fontSize={{ base: "19px", md: "21px" }}>{title}</Text>
      {description ? (
        <Text fontSize="13px" lineHeight="1.65" color="fg.muted" maxW="76ch">{description}</Text>
      ) : null}
    </Stack>
  );
}

function ClientCard({
  title,
  label,
  steps,
  snippet,
}: {
  title: string;
  label: string;
  steps: string[];
  snippet?: string;
}) {
  return (
    <Stack as="article" gap="3" pt="4" borderTopWidth="1px" borderColor="border" minW="0">
      <Flex align="center" justify="space-between" gap="3">
        <Text as="h3" fontSize="14px" fontWeight="650">{title}</Text>
        <Text textStyle="eyebrow" color="fg.subtle">{label}</Text>
      </Flex>
      <Stack as="ol" gap="2" ps="5">
        {steps.map((step) => (
          <Text as="li" key={step} fontSize="13px" lineHeight="1.55" color="fg.muted">{step}</Text>))}
      </Stack>
      {snippet ? (
        <CopyControl value={snippet} label="Copy setup" multiline />
      ) : null}
    </Stack>
  );
}

function InfoColumn({ icon: Icon, title, children,
}: { icon: typeof ShieldCheck; title: string; children: React.ReactNode;
}) {
  return (
    <Stack gap="2.5" pt="4" borderTopWidth="1px" borderColor="border">
      <Flex align="center" gap="2"><Icon size={16} /><Text as="h3" fontSize="14px" fontWeight="650">{title}</Text></Flex>
      <Text as="div" fontSize="13px" lineHeight="1.65" color="fg.muted">{children}</Text>
    </Stack>
  );
}

export default async function McpIntegrationPage() {
  const appUser = await admitWorkspacePage("content.view");
  const mcpUrl = `${process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000"}/mcp`;
  const isEligible =
    appUser.workspace.status === "active" && appUser.workspace.pricingTier === "business";
  const accessLabel = isEligible
    ? "Eligible"
    : appUser.workspace.pricingTier === "business"
      ? "Inactive"
      : "Upgrade";
  const canManageApi = workspaceAllowsCapability(appUser.workspace, "api.manage",
  );
  const codexConfig = `[mcp_servers.narriflow]\nurl = "${mcpUrl}"`;
  const genericConfig = `Transport: Streamable HTTP\nURL: ${mcpUrl}\nAuthentication: OAuth 2.1 or Authorization: Bearer nf_…`;

  return (
    <Stack gap={{ base: "8", md: "10" }} maxW="1120px" mx="auto">
      <PageHeader
        eyebrow="Integrations / AI clients"
        title="Connect Narriflow to AI assistants"
        description="Give an AI client controlled access to Narriflow projects, usage, and RSS autopilot through the remote Model Context Protocol server."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/integrations"><ArrowLeft size={14} />All integrations</Link>
          </Button>
        }
      />

      <StatBand columns={3}>
        <StatBand.Item label="Remote endpoint" value="Ready" />
        <StatBand.Item label="Workspace access" value={accessLabel} />
        <StatBand.Item label="Live connection status" value="Client-side" />
      </StatBand>

      {!isEligible ? (
        <Flex
          align={{ base: "flex-start", md: "center" }}
          justify="space-between"
          direction={{ base: "column", md: "row" }}
          gap="4"
          borderInlineStartWidth="3px"
          borderColor="accent.solid"
          bg="bg.subtle"
          px="5"
          py="4"
        >
          <Stack gap="1">
            <Flex align="center" gap="2"><CircleAlert size={16} /><Text fontSize="14px" fontWeight="650">Active Business access is required for API &amp; MCP integrations</Text></Flex>
            <Text fontSize="13px" color="fg.muted">
              {appUser.workspace.pricingTier !== "business"
                ? appUser.workspace.role === "owner"
                  ? "Setup is visible now. Upgrade this workspace to Business before connecting a client."
                  : "Setup is visible now. Ask the workspace owner to upgrade to Business before connecting a client."
                : `This Business workspace is ${appUser.workspace.status.replace("_", " ")}; tools remain unavailable until it is active.`}
            </Text>
          </Stack>
          <Button asChild size="sm" flexShrink={0}>
            <Link href="/settings/billing">View Business plan<ArrowRight size={14} /></Link>
          </Button>
        </Flex>
      ) : null}

      <Stack as="section" gap="5" id="endpoint" scrollMarginTop="24">
        <SectionHeading
          eyebrow="01 / Remote endpoint"
          title="Use one URL in every supported client"
          description="Narriflow exposes a remote Streamable HTTP MCP server. A successful setup is confirmed inside your AI client; this dashboard does not track or imply a live client session."
        />
        <CopyControl value={mcpUrl} label="Copy URL" />
        <Flex align="flex-start" gap="2" color="fg.muted">
          <CheckCircle2 size={15} style={{ marginTop: 3, flexShrink: 0 }} />
          <Text fontSize="13px" lineHeight="1.6">The endpoint publishes OAuth discovery metadata and also accepts a workspace API key as a bearer token.</Text>
        </Flex>
      </Stack>

      <Stack as="section" gap="5" id="authentication" scrollMarginTop="24">
        <SectionHeading
          eyebrow="02 / Authentication"
          title="Choose identity for people; keys for automation"
          description="The methods are intentionally separate. Connecting yourself never creates or exposes a shared workspace credential."
        />
        <Grid templateColumns={{ base: "1fr", md: "repeat(2, minmax(0, 1fr))" }} gap="6">
          <InfoColumn icon={UserRound} title="Personal OAuth connection">
            Start the connection from your AI client. Narriflow sends you to Clerk&apos;s hosted authorization and consent flow, then the client acts as your Narriflow user. It can only reach workspaces where you remain an active member, and every tool still enforces your workspace role.
          </InfoColumn>
          <InfoColumn icon={KeyRound} title="Workspace API key">
            Use a scoped, workspace-bound key for unattended or non-OAuth clients. Keys can grant read scopes and optional autopilot writes, are shown once, and can be revoked independently of personal connections.{" "}
            {canManageApi ? (
              <Link href="/settings/api" style={{ textDecoration: "underline" }}>Manage workspace keys</Link>
            ) : (
              "A workspace member with developer-access permission must manage keys."
            )}
          </InfoColumn>
        </Grid>
      </Stack>

      <Stack as="section" gap="5" id="client-setup" scrollMarginTop="24">
        <SectionHeading
          eyebrow="03 / Client setup"
          title="Add Narriflow to your preferred AI client"
          description="Labels can move between client releases. In every case, choose a remote or Streamable HTTP server and use the endpoint above."
        />
        <Grid templateColumns={{ base: "1fr", lg: "repeat(2, minmax(0, 1fr))" }} gap={{ base: "7", lg: "6" }}>
          <ClientCard
            title="Codex"
            label="OAUTH"
            steps={[
              "Add the server block to your Codex config.toml.",
              "Run codex mcp login narriflow and complete the Clerk-hosted consent flow.",
              "Ask Codex to call narriflow_list_workspaces to verify access.",
            ]}
            snippet={`${codexConfig}\n\n# Then run\ncodex mcp login narriflow`}
          />
          <ClientCard
            title="Claude / Claude Code"
            label="OAUTH"
            steps={[
              "In Claude, add a custom remote connector; in Claude Code, run the command below.",
              "Open the connection and follow the browser authorization prompt.",
              "Use the client MCP status view to confirm Narriflow is available.",
            ]}
            snippet={`claude mcp add --transport http narriflow ${mcpUrl}`}
          />
          <ClientCard
            title="ChatGPT"
            label="OAUTH"
            steps={[
              "Open Settings → Apps & Connectors and enable developer mode if your workspace requires it.",
              "Create a custom app/connector and enter the Narriflow MCP URL.",
              "Complete the hosted OAuth prompt, then enable Narriflow in a conversation.",
            ]}
          />
          <ClientCard
            title="MCP Inspector"
            label="TEST"
            steps={[
              "Launch MCP Inspector and select Streamable HTTP.",
              "Paste the remote endpoint, connect, and complete OAuth when prompted.",
              "Open Tools and run narriflow_list_workspaces before testing workspace tools.",
            ]}
            snippet="npx @modelcontextprotocol/inspector"
          />
          <ClientCard
            title="Generic Streamable HTTP"
            label="OAUTH / KEY"
            steps={[
              "Use MCP Streamable HTTP rather than the legacy SSE transport.",
              "Prefer OAuth discovery for an interactive user; otherwise send a scoped nf_ key in the Authorization header.",
              "Start with narriflow_list_workspaces and pass workspaceId explicitly when needed.",
            ]}
            snippet={genericConfig}
          />
        </Grid>
      </Stack>

      <Stack as="section" gap="5" id="available-tools" scrollMarginTop="24">
        <SectionHeading
          eyebrow="04 / Available tools"
          title="Read by default; write only on clear intent"
          description="Narriflow advertises tool behavior to compatible clients. Write tools can start downstream imports or processing, so assistants should call them only after an explicit request."
        />
        <Stack gap="0" borderTopWidth="1.5px" borderColor="border.strong">
          {TOOLS.map((tool) => (
            <Grid
              key={tool.name}
              templateColumns={{ base: "1fr auto", md: "minmax(280px, .9fr) 80px 1.4fr",
              }}
              gap={{ base: "2", md: "4" }}
              alignItems="baseline"
              py="3.5"
              borderBottomWidth="1px"
              borderColor="border.subtle"
            >
              <Text fontFamily="mono" fontSize="12.5px" overflowWrap="anywhere">{tool.name}</Text>
              <Text textStyle="eyebrow" color={tool.behavior === "Write" ? "accent.fg" : "fg.subtle"}>{tool.behavior}</Text>
              <Text gridColumn={{ base: "1 / -1", md: "auto" }} fontSize="13px" color="fg.muted">{tool.description}</Text>
            </Grid>
          ))}
        </Stack>
      </Stack>

      <Stack as="section" gap="5" id="workspace-keys" scrollMarginTop="24">
        <SectionHeading
          eyebrow="05 / Access & billing"
          title="Workspace rules still apply outside the dashboard"
        />
        <Grid templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap="6">
          <InfoColumn icon={LockKeyhole} title="Membership and roles">
            OAuth tools re-check active membership and the required capability on every call. Viewers can read but cannot run write tools; removing a member ends their workspace access.
          </InfoColumn>
          <InfoColumn icon={Braces} title="Business entitlement">
            MCP and workspace API keys require an active Business workspace. A personal OAuth grant can remain valid while an ineligible workspace is rejected at tool execution.
          </InfoColumn>
          <InfoColumn icon={Bot} title="Processing minutes">
            MCP does not bypass plan limits. RSS imports and media processing consume the same shared monthly processing-minute quota as dashboard actions, and stop when quota is exhausted.
          </InfoColumn>
        </Grid>
      </Stack>

      <Stack as="section" gap="5" id="security" scrollMarginTop="24">
        <SectionHeading eyebrow="06 / Security & troubleshooting" title="Keep access narrow and recoverable" />
        <Grid templateColumns={{ base: "1fr", md: "repeat(2, minmax(0, 1fr))" }} gap="6">
          <InfoColumn icon={ShieldCheck} title="Revoke and rotate">
            Disconnect Narriflow in the AI client to end that client&apos;s OAuth use. Revoke a compromised workspace key from Developer access and replace it in the unattended client. Never paste an API key into prompts or shared configuration.
          </InfoColumn>
          <InfoColumn icon={TerminalSquare} title="Consent window does not complete">
            Narriflow intentionally uses Clerk-hosted consent—there is no custom Narriflow consent page. Allow the browser window or redirect, sign in to Narriflow once, then retry from the client. If the client reports an issuer or redirect mismatch, copy the endpoint exactly and ask the workspace owner to verify the deployed OAuth configuration.
          </InfoColumn>
          <InfoColumn icon={CircleAlert} title="Connected, but tools are denied">
            Run narriflow_list_workspaces first. Confirm the target workspace is active Business, use its returned workspace ID, and check that your membership role allows the operation. For keys, confirm the required read or autopilot scope is present.
          </InfoColumn>
          <InfoColumn icon={CheckCircle2} title="How to confirm a connection">
            Trust the client&apos;s MCP status and a successful tool call. Narriflow does not currently keep a dashboard list of OAuth client sessions, so this page reports endpoint readiness and workspace eligibility only.
          </InfoColumn>
        </Grid>
      </Stack>
    </Stack>
  );
}
