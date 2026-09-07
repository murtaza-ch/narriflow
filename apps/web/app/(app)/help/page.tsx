import Link from "next/link";
import { Box, Card, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { ArrowRight, Braces, Clapperboard, Share2 } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";

const GUIDES = [
  {
    title: "Start with a project",
    description: "Paste a supported link or upload source media, then configure generation before processing begins.",
    href: "/upload",
    action: "Create a project",
    label: "Core workflow",
    icon: Clapperboard,
  },
  {
    title: "Connect Narriflow to AI assistants",
    description: "Set up the remote MCP server with Codex, Claude, ChatGPT, MCP Inspector, or another Streamable HTTP client.",
    href: "/integrations/mcp",
    action: "Open MCP setup",
    label: "Integrations",
    icon: Braces,
  },
  {
    title: "Connect social publishing accounts",
    description: "Authorize workspace destinations before scheduling finished clips from the Calendar.",
    href: "/settings/social-accounts",
    action: "Manage accounts",
    label: "Publishing",
    icon: Share2,
  },
] as const;

export default function HelpPage() {
  return (
    <Stack gap="8" maxW="1020px" mx="auto">
      <PageHeader
        title="Tutorials &amp; help"
      />
      <Grid templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap={{ base: "7", md: "6" }}>
        {GUIDES.map(({ title, description, href, action, label, icon: Icon }) => (
          <Card.Root key={href} as="article" minW="0"><Card.Body gap="4">
            <Flex align="center" gap="2.5"><Icon size={16} /><Text textStyle="eyebrow" color="fg.subtle">{label}</Text></Flex>
            <Box flex="1">
              <Text as="h2" fontSize="15px" fontWeight="500">{title}</Text>
              <Text fontSize="13px" lineHeight="1.65" color="fg.muted" mt="1.5">{description}</Text>
            </Box>
            <Button asChild size="sm" variant="outline" alignSelf="flex-start">
              <Link href={href}>{action}<ArrowRight size={14} /></Link>
            </Button>
          </Card.Body></Card.Root>
        ))}
      </Grid>
    </Stack>
  );
}
