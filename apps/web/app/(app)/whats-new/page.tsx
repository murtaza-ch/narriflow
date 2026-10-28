import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Sparkles } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { PageHeader } from "@narriflow/ui/components/page-header";

// A release note as a placeholder: a date, a headline and two lines. Bars only,
// so the page never reads as having notes it doesn't have.
function GhostNote({ first = false }: { first?: boolean }) {
  return (
    <Stack gap="2.5" p="4" bg="bg.raised" borderRadius="l2">
      <Flex align="center" gap="2">
        <Box h="5" w="16" borderRadius="full" bg={first ? "accent.subtle" : "bg.softHover"} />
        <Box h="2" w="12" borderRadius="full" bg="bg.soft" />
      </Flex>
      <Box h="3.5" w="64%" borderRadius="full" bg="bg.softHover" />
      <Stack gap="1.5">
        <Box h="2" borderRadius="full" bg="bg.soft" />
        <Box h="2" w="72%" borderRadius="full" bg="bg.soft" />
      </Stack>
    </Stack>
  );
}

/** Notes on a timeline, fading out: what this page fills with once there are releases. */
function GhostTimeline() {
  const fade = "linear-gradient(to bottom, black 35%, transparent 100%)";
  return (
    <Flex w="full" maxW="420px" gap="4" aria-hidden style={{ maskImage: fade, WebkitMaskImage: fade }}>
      <Flex direction="column" align="center" flexShrink={0}>
        <Flex boxSize="9" borderRadius="full" bg="accent.subtle" color="accent.fg" align="center" justify="center">
          <Sparkles size={16} />
        </Flex>
        <Box w="2px" flex="1" my="1.5" borderRadius="full" bg="bg.softHover" />
      </Flex>
      <Stack gap="3" flex="1" minW="0" pb="10">
        <GhostNote first />
        <GhostNote />
        <GhostNote />
      </Stack>
    </Flex>
  );
}

export default function WhatsNewPage() {
  return (
    <Stack gap="8">
      <PageHeader title="What's new" />
      <Flex
        as="section"
        aria-label="Release notes"
        direction="column"
        align="center"
        gap="5"
        pt={{ base: "8", md: "10" }}
        pb={{ base: "8", md: "10" }}
        px="6"
        bg="bg.subtle"
        borderRadius="l3"
        overflow="hidden"
      >
        <GhostTimeline />
        <Stack align="center" gap="1" textAlign="center" mt="-6" position="relative">
          <Text as="h2" fontSize="15px" fontWeight="500">
            No release notes yet
          </Text>
          <Text fontSize="13px" color="fg.muted" maxW="44ch">
            New features and improvements will appear here.
          </Text>
        </Stack>
        <Button asChild variant="subtle" size="sm">
          <Link href="/help">Tutorials &amp; help</Link>
        </Button>
      </Flex>
    </Stack>
  );
}
