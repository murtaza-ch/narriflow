import Link from "next/link";
import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Braces,
  CalendarClock,
  Check,
  Clapperboard,
  type LucideIcon,
  MessageSquareText,
  Rocket,
  Share2,
  Sparkles,
} from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { docsUrl } from "@/lib/docs-url";
import { FeatureHero } from "../_components/feature-hero";
import { BrandTile } from "../integrations/_components/brand-tile";

function IconTile({ icon: Icon, size = "md" }: { icon: LucideIcon; size?: "md" | "lg" }) {
  return (
    <Flex
      boxSize={size === "lg" ? "44px" : "36px"}
      borderRadius={size === "lg" ? "12px" : "10px"}
      bg="bg.muted"
      color="fg"
      align="center"
      justify="center"
      flexShrink={0}
      aria-hidden="true"
    >
      <Icon size={size === "lg" ? 20 : 18} />
    </Flex>
  );
}

/** The rest of the guides live in the docs; these are the ones people open first. */
const GUIDES = [
  { path: "ai/claude", title: "Connect Claude", description: "Use Narriflow from a Claude chat", logo: <BrandTile brand="claude" /> },
  { path: "ai/chatgpt", title: "Connect ChatGPT", description: "Add Narriflow as a ChatGPT connector", logo: <BrandTile brand="chatgpt" /> },
  { path: "ai/example-prompts", title: "Example prompts", description: "What to ask your assistant", logo: <IconTile icon={MessageSquareText} /> },
  { path: "publishing-queue", title: "Publishing queue", description: "Accept proposed posts into weekly slots", logo: <IconTile icon={CalendarClock} /> },
  { path: "api/quickstart", title: "API quickstart", description: "Your first request with a workspace key", logo: <IconTile icon={Braces} /> },
  { path: "api/n8n", title: "n8n template", description: "Turn Google Drive uploads into clips", logo: <BrandTile brand="n8n" /> },
];

const TOPICS = [
  { path: "", title: "Guides", description: "Features and workflows", icon: BookOpen },
  { path: "ai/overview", title: "AI assistants", description: "Claude, ChatGPT, Cursor and more", icon: Sparkles },
  { path: "api/introduction", title: "API", description: "Keys, uploads and webhooks", icon: Braces },
];

const START = [
  { href: "/upload", title: "Create a project", description: "Paste a link or upload a video", icon: Clapperboard, external: false },
  { href: "/settings/social-accounts", title: "Connect social accounts", description: "Publish and schedule finished clips", icon: Share2, external: false },
  { href: docsUrl("quickstart"), title: "Read the quickstart", description: "From a video link to scheduled clips", icon: Rocket, external: true },
];

const tileProps = {
  align: "center",
  gap: "3",
  p: "3.5",
  bg: "bg.subtle",
  borderRadius: "l2",
  transition: "background 120ms ease",
  _hover: { bg: "bg.muted" },
  _focusVisible: { outline: "2px solid", outlineColor: "accent.solid", outlineOffset: "2px" },
} as const;

const gridColumns = { base: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(3, minmax(0, 1fr))" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack as="section" gap="3">
      <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
        {title}
      </Text>
      {children}
    </Stack>
  );
}

/** A compact row: logo, title, one line, and the arrow that says where it opens. */
function Tile({ logo, title, description, external }: { logo: React.ReactNode; title: string; description: string; external: boolean }) {
  const Arrow = external ? ArrowUpRight : ArrowRight;
  return (
    <>
      {logo}
      <Stack gap="0" minW="0" flex="1">
        <Text fontSize="14px" fontWeight="500">
          {title}
        </Text>
        <Text fontSize="13px" color="fg.muted" truncate>
          {description}
        </Text>
      </Stack>
      <Box color="fg.subtle" flexShrink={0} aria-hidden="true">
        <Arrow size={15} />
      </Box>
    </>
  );
}

export default function HelpPage() {
  return (
    <Stack gap="8" maxW="1120px" mx="auto" w="full">
      <PageHeader title="Tutorials &amp; help" />

      <FeatureHero
        title="Narriflow docs"
        points={["Step-by-step guides, from link to scheduled clips", "Assistant setup and the full API reference"]}
        action={
          <Button asChild size="sm">
            <a href={docsUrl()} target="_blank" rel="noreferrer">
              Open docs
              <ArrowUpRight size={16} />
            </a>
          </Button>
        }
        visual={<DocsVisual />}
      />

      <Section title="Get started">
        <Grid templateColumns={gridColumns} gap="2">
          {START.map(({ href, icon, external, ...item }) => (
            <Flex key={href} asChild direction="column" align="stretch" gap="4" p="4" bg="bg.subtle" borderRadius="l2" transition="background 120ms ease" _hover={{ bg: "bg.muted" }} _focusVisible={tileProps._focusVisible}>
              {external ? (
                <a href={href} target="_blank" rel="noreferrer">
                  <StartCard icon={icon} external {...item} />
                </a>
              ) : (
                <Link href={href}>
                  <StartCard icon={icon} external={false} {...item} />
                </Link>
              )}
            </Flex>
          ))}
        </Grid>
      </Section>

      <Section title="Popular guides">
        <Grid templateColumns={gridColumns} gap="2">
          {GUIDES.map(({ path, ...guide }) => (
            <Flex key={path} asChild {...tileProps}>
              <a href={docsUrl(path)} target="_blank" rel="noreferrer">
                <Tile external {...guide} />
              </a>
            </Flex>
          ))}
        </Grid>
      </Section>

      <Section title="Browse by topic">
        <Grid templateColumns={gridColumns} gap="2">
          {TOPICS.map(({ path, icon, ...topic }) => (
            <Flex key={topic.title} asChild {...tileProps}>
              <a href={docsUrl(path)} target="_blank" rel="noreferrer">
                <Tile external logo={<IconTile icon={icon} />} {...topic} />
              </a>
            </Flex>
          ))}
        </Grid>
      </Section>
    </Stack>
  );
}

/** A getting-started card: the icon leads, the arrow closes the title row. */
function StartCard({ icon, title, description, external }: { icon: LucideIcon; title: string; description: string; external: boolean }) {
  const Arrow = external ? ArrowUpRight : ArrowRight;
  return (
    <>
      <Flex align="flex-start" justify="space-between">
        <IconTile icon={icon} size="lg" />
        <Box color="fg.subtle" aria-hidden="true">
          <Arrow size={16} />
        </Box>
      </Flex>
      <Stack gap="0.5">
        <Text fontSize="14px" fontWeight="500">
          {title}
        </Text>
        <Text fontSize="13px" color="fg.muted">
          {description}
        </Text>
      </Stack>
    </>
  );
}

/** Two tilted pages for the hero: a guide with a code sample, and a quickstart checklist. */
function DocsVisual() {
  return (
    <Box position="absolute" inset="0" overflow="hidden">
      <Stack
        position="absolute"
        left="8%"
        top="14%"
        w="54%"
        h="92%"
        gap="3"
        p="4"
        bg="bg.panel"
        borderRadius="14px"
        transform="rotate(-5deg)"
        transformOrigin="top left"
      >
        <Flex align="center" gap="2">
          <Box boxSize="2.5" borderRadius="full" bg="accent.solid" />
          <Box h="2" w="16" borderRadius="full" bg="bg.muted" />
        </Flex>
        <Box h="3.5" w="70%" borderRadius="full" bg="fg" opacity={0.75} />
        <Stack gap="1.5">
          <Box h="2" borderRadius="full" bg="bg.muted" />
          <Box h="2" w="88%" borderRadius="full" bg="bg.muted" />
          <Box h="2" w="64%" borderRadius="full" bg="bg.muted" />
        </Stack>
        <Stack gap="2" p="3" borderRadius="10px" bg="bg.inverted">
          <Flex gap="1.5">
            <Box h="1.5" w="8" borderRadius="full" bg="accent.solid" />
            <Box h="1.5" w="14" borderRadius="full" bg="fg.inverted" opacity={0.5} />
          </Flex>
          <Flex gap="1.5" ps="3">
            <Box h="1.5" w="12" borderRadius="full" bg="fg.inverted" opacity={0.5} />
            <Box h="1.5" w="6" borderRadius="full" bg="accent.solid" />
          </Flex>
          <Box h="1.5" w="20" ms="3" borderRadius="full" bg="fg.inverted" opacity={0.35} />
        </Stack>
      </Stack>

      <Stack
        position="absolute"
        right="6%"
        bottom="14%"
        w="46%"
        gap="2.5"
        p="3.5"
        bg="bg.panel"
        borderRadius="14px"
        transform="rotate(4deg)"
      >
        <Text fontSize="11px" fontWeight="500" color="fg.muted">
          Quickstart
        </Text>
        {[true, true, false].map((done, index) => (
          <Flex key={index} align="center" gap="2">
            <Flex boxSize="4" borderRadius="full" align="center" justify="center" flexShrink={0} bg={done ? "accent.solid" : "bg.muted"} color="accent.contrast">
              {done ? <Check size={10} strokeWidth={3} /> : null}
            </Flex>
            <Box h="2" flex="1" maxW={["60%", "70%", "50%"][index]} borderRadius="full" bg="bg.muted" />
          </Flex>
        ))}
      </Stack>
    </Box>
  );
}
