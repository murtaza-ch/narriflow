import Link from "next/link";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, Braces, Plus, Webhook } from "lucide-react";
import { callbackSigningSecrets, socialOAuthService, workspaceAllowsCapability, workspaceService } from "@narriflow/services";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import type { SocialAccountSnapshot, SocialPlatform } from "@narriflow/validators";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import { docsUrl } from "@/lib/docs-url";
import { type AssistantBrand, BrandTile } from "./_components/brand-tile";

const PLATFORMS: Array<{ id: SocialPlatform; name: string }> = [
  { id: "tiktok", name: "TikTok" },
  { id: "youtube_shorts", name: "YouTube" },
  { id: "instagram_reels", name: "Instagram" },
  { id: "facebook_reels", name: "Facebook" },
  { id: "linkedin", name: "LinkedIn" },
  { id: "x", name: "X" },
];

const ASSISTANTS: AssistantBrand[] = ["claude", "chatgpt", "cursor", "codex"];

type Tone = "on" | "off" | "warn";

function Status({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <Flex align="center" gap="1.5" fontSize="12px" minW="0" color={tone === "on" ? "accent.fg" : tone === "warn" ? "warning.fg" : "fg.subtle"}>
      {tone === "on" ? <Box boxSize="1.5" flexShrink={0} borderRadius="full" bg="accent.solid" /> : null}
      <Text as="span" truncate>
        {children}
      </Text>
    </Flex>
  );
}

function IntegrationTile({
  href,
  external = false,
  native = false,
  label,
  logo,
  name,
  status,
  tone,
  trailing,
}: {
  href: string;
  external?: boolean;
  /** A plain anchor: the OAuth start route writes state, so it must not be prefetched. */
  native?: boolean;
  label?: string;
  logo: React.ReactNode;
  name: string;
  status: React.ReactNode;
  tone: Tone;
  trailing?: React.ReactNode;
}) {
  const body = (
    <>
      {logo}
      <Stack gap="0" flex="1" minW="0">
        <Text fontSize="14px" fontWeight="500">
          {name}
        </Text>
        <Status tone={tone}>{status}</Status>
      </Stack>
      {trailing}
    </>
  );
  return (
    <Flex
      asChild
      align="center"
      gap="3"
      p="3.5"
      bg="bg.subtle"
      borderRadius="12px"
      transition="background 120ms ease"
      _hover={{ bg: "bg.muted" }}
    >
      {external ? (
        <a href={href} target="_blank" rel="noreferrer" aria-label={label}>
          {body}
        </a>
      ) : native ? (
        <a href={href} aria-label={label}>
          {body}
        </a>
      ) : (
        <Link href={href} aria-label={label}>
          {body}
        </Link>
      )}
    </Flex>
  );
}

function IconTile({ children }: { children: React.ReactNode }) {
  return (
    <Flex boxSize="36px" borderRadius="10px" bg="bg.muted" color="fg" align="center" justify="center" flexShrink={0} aria-hidden="true">
      {children}
    </Flex>
  );
}

function AddMark() {
  return (
    <Flex boxSize="7" borderRadius="8px" bg="bg.soft" color="fg" align="center" justify="center" flexShrink={0} aria-hidden="true">
      <Plus size={16} />
    </Flex>
  );
}

function accountLabel([first, ...rest]: [SocialAccountSnapshot, ...SocialAccountSnapshot[]]) {
  const name = first.handle ? `@${first.handle.replace(/^@/, "")}` : first.displayName;
  return rest.length ? `${name} +${rest.length}` : name;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack as="section" gap="3">
      <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
        {title}
      </Text>
      <Grid templateColumns={{ base: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(3, minmax(0, 1fr))" }} gap="2">
        {children}
      </Grid>
    </Stack>
  );
}

export default async function IntegrationsPage() {
  const appUser = await admitWorkspacePage("content.view");
  const { workspace } = appUser;
  const isBusiness = workspace.pricingTier === "business";
  const canManageApi = workspaceAllowsCapability(workspace, "api.manage");
  const canManageSocial = workspaceAllowsCapability(workspace, "social.manage");
  const [accounts, keys, signing] = await Promise.all([
    socialOAuthService.listAccounts(appUser),
    canManageApi ? workspaceService.listApiKeys(appUser.actorUserId, appUser.workspaceId) : null,
    canManageApi ? callbackSigningSecrets.status(appUser.workspaceId) : null,
  ]);

  return (
    <Stack gap="8" maxW="1120px" mx="auto" w="full">
      <PageHeader title="Integrations" />

      <Flex
        align={{ base: "flex-start", md: "center" }}
        justify="space-between"
        direction={{ base: "column", md: "row" }}
        gap="5"
        p={{ base: "5", md: "6" }}
        borderRadius="14px"
        bg="bg.subtle"
        bgImage="radial-gradient(120% 160% at 90% 0%, color-mix(in srgb, var(--chakra-colors-accent-solid) 18%, transparent) 0%, transparent 55%)"
      >
        <Stack gap="4" minW="0">
          <Flex>
            {ASSISTANTS.map((brand, index) => (
              <BrandTile
                key={brand}
                brand={brand}
                size="lg"
                ms={index ? "-2" : "0"}
                boxShadow="0 0 0 3px var(--chakra-colors-bg-subtle)"
              />
            ))}
          </Flex>
          <Stack gap="1">
            <Flex align="center" gap="2" wrap="wrap">
              <Text as="h2" fontSize="18px" fontWeight="500" letterSpacing="-0.01em">
                Use Narriflow from your AI assistant
              </Text>
              {!isBusiness ? (
                <Text as="span" fontSize="12px" color="fg.muted" bg="bg.soft" px="2" py="0.5" borderRadius="full">
                  Business
                </Text>
              ) : null}
            </Flex>
            <Text fontSize="14px" color="fg.muted">
              Clip, export and schedule from Claude, ChatGPT, Cursor or Codex.
            </Text>
          </Stack>
        </Stack>
        <Button asChild size="sm" flexShrink={0}>
          <Link href="/integrations/mcp">
            Connect
            <ArrowRight size={16} />
          </Link>
        </Button>
      </Flex>

      <Section title="Publishing">
        {PLATFORMS.map(({ id, name }) => {
          const connected = accounts.filter((account) => account.platform === id);
          const [firstActive, ...moreActive] = connected.filter((account) => account.status === "active");
          const canConnect = canManageSocial && connected.length === 0;
          return (
            <IntegrationTile
              key={id}
              href={canConnect ? `/api/social/oauth/start/${id}?redirect=/settings/social-accounts` : "/settings/social-accounts"}
              native={canConnect}
              label={canConnect ? `Connect ${name} account` : undefined}
              logo={<BrandTile brand={id} />}
              name={name}
              tone={firstActive ? "on" : connected.length ? "warn" : "off"}
              status={firstActive ? accountLabel([firstActive, ...moreActive]) : connected.length ? "Needs reconnecting" : "Not connected"}
              trailing={canConnect ? <AddMark /> : undefined}
            />
          );
        })}
      </Section>

      <Section title="Automation">
        <IntegrationTile
          href={docsUrl("api/n8n")}
          external
          logo={<BrandTile brand="n8n" />}
          name="n8n"
          tone="off"
          status="Google Drive to clips template"
        />
        <IntegrationTile
          href={canManageApi ? "/settings/api" : docsUrl("api/introduction")}
          external={!canManageApi}
          logo={
            <IconTile>
              <Braces size={18} />
            </IconTile>
          }
          name="REST API"
          tone={keys?.length ? "on" : "off"}
          status={!isBusiness ? "Business plan" : keys ? (keys.length ? `${keys.length} ${keys.length === 1 ? "key" : "keys"}` : "No keys yet") : "Workspace API keys"}
        />
        <IntegrationTile
          href={canManageApi ? "/settings/api#callbacks" : docsUrl("api/callbacks")}
          external={!canManageApi}
          logo={
            <IconTile>
              <Webhook size={18} />
            </IconTile>
          }
          name="Webhooks"
          tone={signing?.current ? "on" : "off"}
          status={!isBusiness ? "Business plan" : signing ? (signing.current ? "Signing secret set" : "Not set up") : "Completion callbacks"}
        />
      </Section>
    </Stack>
  );
}
