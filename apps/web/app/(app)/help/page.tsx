import Link from "next/link";
import { Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { ArrowUpRight, Braces, Clapperboard, MessageSquareText, Rocket, Share2 } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { docsUrl } from "@/lib/docs-url";
import { BrandTile } from "../integrations/_components/brand-tile";

function IconTile({ children }: { children: React.ReactNode }) {
  return (
    <Flex boxSize="36px" borderRadius="10px" bg="bg.muted" color="fg" align="center" justify="center" flexShrink={0} aria-hidden="true">
      {children}
    </Flex>
  );
}

const ARTICLES = [
  { path: "quickstart", title: "Quickstart", description: "From a video link to scheduled clips", logo: <IconTile><Rocket size={18} /></IconTile> },
  { path: "ai/claude", title: "Connect Claude", description: "Use Narriflow from a Claude chat", logo: <BrandTile brand="claude" /> },
  { path: "ai/chatgpt", title: "Connect ChatGPT", description: "Add Narriflow as a ChatGPT connector", logo: <BrandTile brand="chatgpt" /> },
  { path: "ai/example-prompts", title: "Example prompts", description: "What to ask your assistant", logo: <IconTile><MessageSquareText size={18} /></IconTile> },
  { path: "api/quickstart", title: "API quickstart", description: "Your first request with a workspace key", logo: <IconTile><Braces size={18} /></IconTile> },
  { path: "api/n8n", title: "n8n template", description: "Turn Google Drive uploads into clips", logo: <BrandTile brand="n8n" /> },
];

const IN_APP = [
  { href: "/upload", title: "Create a project", description: "Paste a link or upload a video", icon: Clapperboard },
  { href: "/settings/social-accounts", title: "Connect social accounts", description: "Publish and schedule finished clips", icon: Share2 },
];

function Tile({ logo, title, description }: { logo: React.ReactNode; title: string; description: string }) {
  return (
    <>
      {logo}
      <Stack gap="0" minW="0">
        <Text fontSize="14px" fontWeight="500">
          {title}
        </Text>
        <Text fontSize="13px" color="fg.muted" truncate>
          {description}
        </Text>
      </Stack>
    </>
  );
}

const tileProps = {
  align: "center",
  gap: "3",
  p: "3.5",
  bg: "bg.subtle",
  borderRadius: "12px",
  transition: "background 120ms ease",
  _hover: { bg: "bg.muted" },
} as const;

const gridColumns = { base: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(3, minmax(0, 1fr))" };

export default function HelpPage() {
  return (
    <Stack gap="8" maxW="1120px" mx="auto" w="full">
      <PageHeader title="Tutorials &amp; help" />

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
        <Flex align="center" gap="4" minW="0">
          <Flex boxSize="48px" borderRadius="14px" bg="bg.muted" align="center" justify="center" flexShrink={0} aria-hidden="true">
            <Logo size="lg" showWordmark={false} />
          </Flex>
          <Stack gap="1" minW="0">
            <Text as="h2" fontSize="18px" fontWeight="500" letterSpacing="-0.01em">
              Narriflow docs
            </Text>
            <Text fontSize="14px" color="fg.muted">
              Guides, assistant setup and the API reference.
            </Text>
          </Stack>
        </Flex>
        <Button asChild size="sm" flexShrink={0}>
          <a href={docsUrl()} target="_blank" rel="noreferrer">
            Open docs
            <ArrowUpRight size={16} />
          </a>
        </Button>
      </Flex>

      <Stack as="section" gap="3">
        <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
          Popular
        </Text>
        <Grid templateColumns={gridColumns} gap="2">
          {ARTICLES.map(({ path, ...article }) => (
            <Flex key={path} asChild {...tileProps}>
              <a href={docsUrl(path)} target="_blank" rel="noreferrer">
                <Tile {...article} />
              </a>
            </Flex>
          ))}
        </Grid>
      </Stack>

      <Stack as="section" gap="3">
        <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
          Get started
        </Text>
        <Grid templateColumns={gridColumns} gap="2">
          {IN_APP.map(({ href, icon: Icon, ...item }) => (
            <Flex key={href} asChild {...tileProps}>
              <Link href={href}>
                <Tile
                  {...item}
                  logo={
                    <IconTile>
                      <Icon size={18} />
                    </IconTile>
                  }
                />
              </Link>
            </Flex>
          ))}
        </Grid>
      </Stack>
    </Stack>
  );
}
