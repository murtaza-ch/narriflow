import { Flex, Heading, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";
import { ProjectCardSkeleton } from "../projects/_components/projects-skeleton";
import styles from "./hero-experience.module.css";

/** The four creation tools' copy (creation-tools.tsx is a client module). */
const TOOLS = [
  ["AI clips", "Extract short clips"],
  ["Captions", "Add and style subtitles"],
  ["Repurpose", "Create posts and summaries"],
  ["Dubbing", "Translate voice and captions"],
] as const;

/**
 * Mirrors the dashboard for an editor: the hero (laid out by the hero's own
 * stylesheet, so its height and padding can't drift), the creation tools, the
 * recent projects grid and the Autopilot card. Banner and read-only variants
 * depend on the workspace and are left out.
 */
export default function HomeLoading() {
  return (
    <LoadingScreen label="Loading dashboard" gap={{ base: "8", md: "10" }}>
      <section className={styles.experience}>
        <div className={styles.centeredHero}>
          <div className={styles.centerContent}>
            <h1>
              Long video. <span>Short-form magic.</span>
            </h1>
            <p className={styles.description}>Find your best moments. Turn them into captioned clips, ready to share.</p>
            <div className={styles.importArea}>
              {/* The paste-link field, then "Upload a file" and "Import a podcast" */}
              <Bone h={{ base: "60px", md: "67px" }} borderRadius="14px" />
              <div className={styles.importLinks}>
                <Bone h="34px" w="119px" borderRadius="8px" />
                <Bone h="34px" w="141px" borderRadius="8px" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <SimpleGrid columns={{ base: 2, xl: 4 }} gap="3">
        {TOOLS.map(([title, description]) => (
          <Flex
            key={title}
            wrap="wrap"
            align="center"
            gap="3"
            p={{ base: "4", md: "5" }}
            minH="176px"
            bg="bg.panel"
            borderRadius="l3"
          >
            {/* Artwork row, then the title and description */}
            <Flex w="full" h={{ base: "89px", md: "96px" }} align="center" justify="center">
              <Bone w="36" h="20" borderRadius="l2" />
            </Flex>
            <Stack gap="0.5" flex="1" flexBasis="70%" minW="0">
              <Heading as="h2" fontSize={{ base: "xs", md: "sm" }} fontWeight="500">
                {title}
              </Heading>
              <Text fontSize="12.5px" color="fg.muted" truncate>
                {description}
              </Text>
            </Stack>
          </Flex>
        ))}
      </SimpleGrid>

      <Stack gap="5">
        <Flex align="center" justify="space-between" gap="4">
          <Heading as="h2" fontSize="md" fontWeight="500">
            Recent projects
          </Heading>
          <Bone h="9" w="88px" borderRadius="control" />
        </Flex>
        <SimpleGrid columns={{ base: 1, sm: 2, xl: 3 }} gap="5">
          {Array.from({ length: 6 }).map((_, index) => (
            <ProjectCardSkeleton key={index} />
          ))}
        </SimpleGrid>
      </Stack>

      {/* Autopilot: the feed-to-clips mark, title and description, the action */}
      <Flex
        align={{ base: "flex-start", md: "center" }}
        direction={{ base: "column", md: "row" }}
        gap={{ base: "4", md: "6" }}
        p={{ base: "5", md: "6" }}
        bg="bg.panel"
        borderRadius="l3"
      >
        <Flex align="center" gap="2.5" flexShrink={0}>
          <Bone boxSize="10" borderRadius="full" />
          <Bone h="34px" w="20" />
        </Flex>
        <Stack gap="1" flex="1" minW="0" w="full">
          <Flex h="22px" align="center">
            <Bone h="3.5" w="44" maxW="full" />
          </Flex>
          <Flex h="20px" align="center">
            <Bone h="3" w="lg" maxW="full" />
          </Flex>
        </Stack>
        <Bone h="9" w="36" borderRadius="control" flexShrink={0} />
      </Flex>
    </LoadingScreen>
  );
}
