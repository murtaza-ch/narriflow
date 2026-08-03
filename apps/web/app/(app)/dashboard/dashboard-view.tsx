import Link from "next/link";
import { Box, Flex, Heading, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { FolderOpen, Rss, Upload } from "lucide-react";
import type { ProjectListItem } from "@narriflow/services";
import { HeroPasteLinkField } from "./dashboard-client";
import { ProjectCard } from "../projects/_components/project-card";

function reveal(index: number) {
  return {
    animation: "fade-up",
    animationDelay: `${index * 80}ms`,
    animationFillMode: "backwards",
  } as const;
}

export function DashboardView({
  greeting,
  items,
}: {
  greeting: string;
  items: ProjectListItem[];
}) {
  return (
    <Stack gap="8" maxW="1080px" mx="auto">
      {/* Hero */}
      <Box
        as="section"
        position="relative"
        overflow="hidden"
        borderWidth="1px"
        borderColor="border"
        borderRadius="l2"
        p={{ base: 6, md: 10 }}
        {...reveal(0)}
      >
        {/* Blueprint-grid ambient — sanctioned background treatment only */}
        <Box
          aria-hidden
          position="absolute"
          inset="0"
          layerStyle="blueprint"
          pointerEvents="none"
        />

        <Stack
          gap="5"
          align="center"
          textAlign="center"
          position="relative"
          maxW="560px"
          mx="auto"
        >
          <Text textStyle="eyebrow" color="fg.subtle">
            {greeting}
          </Text>

          <Heading
            as="h1"
            textStyle="display"
            fontSize={{ base: "28px", md: "40px" }}
            color="fg"
          >
            Turn long videos into{" "}
            <Box as="span" color="fg.accent">
              viral clips
            </Box>
            .
          </Heading>

          <Text color="fg.muted" fontSize="15px" lineHeight="1.65">
            Paste a video link or upload a file — Narriflow finds the
            moments worth posting.
          </Text>

          <Box w="full" maxW="480px" pt="2">
            <HeroPasteLinkField />
          </Box>

          <Stack gap="2" align="center" pt="3">
            <Flex gap="2" wrap="wrap" justify="center">
              <Button variant="ghost" size="sm" asChild>
                <Link href="/upload">
                  <Upload size={14} strokeWidth={1.75} aria-hidden />
                  Upload local file
                </Link>
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/upload">
                  <Rss size={14} strokeWidth={1.75} aria-hidden />
                  Import RSS feed
                </Link>
              </Button>
            </Flex>
            <Text textStyle="data" fontSize="11.5px" color="fg.subtle">
              MP4 · MOV · WebM · MKV · MP3 · WAV — up to 5 GB
            </Text>
          </Stack>
        </Stack>
      </Box>

      {/* Recent projects */}
      <Box as="section" {...reveal(1)}>
        <Flex align="baseline" justify="space-between" gap="3" mb="2">
          <Text textStyle="eyebrow" color="fg.subtle">
            Recent projects
          </Text>
          <Link href="/projects">
            <Text
              as="span"
              fontSize="13px"
              fontWeight="550"
              color="fg"
              textDecoration="underline"
              textUnderlineOffset="3px"
              transition="color 120ms ease"
              _hover={{ color: "fg.muted" }}
            >
              View all →
            </Text>
          </Link>
        </Flex>
        <Box layerStyle="band">
          {items.length === 0 ? (
            <EmptyState
              icon={<FolderOpen size={22} strokeWidth={1.5} />}
              title="No projects yet"
              description="Paste a link or upload a file above to get your first clips."
            />
          ) : (
            <SimpleGrid columns={{ base: 1, sm: 2, lg: 3, "2xl": 4 }} gap="5">
              {items.map((project, index) => (
                <Box
                  key={project.id}
                  animation="fade-up"
                  animationFillMode="backwards"
                  style={{ animationDelay: `${Math.min(index, 11) * 60}ms` }}
                >
                  <ProjectCard project={project} />
                </Box>
              ))}
            </SimpleGrid>
          )}
        </Box>
      </Box>
    </Stack>
  );
}
