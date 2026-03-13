import type { ClipSnapshot } from "@narriflow/validators";
import { Stack, Box, Flex, Text } from "@chakra-ui/react";
import { ClipCard } from "./clip-card";

export function ClipsPanel({
  clips,
  sourceVideoUrl,
  sourceType,
}: {
  clips: ClipSnapshot[];
  sourceVideoUrl: string | null;
  sourceType: "upload" | "youtube" | "rss";
}) {
  if (clips.length === 0) {
    return null;
  }

  const acceptedCount = clips.filter((c) => c.status === "accepted").length;
  const renderedCount = clips.filter(
    (c) => c.renderVariants.some((render) => render.hasAsset),
  ).length;

  return (
    <Box borderRadius="12px" borderWidth="1px" borderColor="border" bg="bg.panel" p="20px">
      <Stack gap="16px">
        <Flex align="center" justify="space-between" gap="8px">
          <Box>
            <Flex align="center" gap="8px">
              <Text fontSize="14px" fontWeight="500" color="fg">
                AI Clips
              </Text>
              <Text fontSize="12px" color="fg.muted">
                {clips.length} detected
                {acceptedCount > 0 && ` · ${acceptedCount} accepted`}
                {renderedCount > 0 &&
                  ` · ${renderedCount}/${clips.length} with renders`}
              </Text>
            </Flex>
            <Text mt="2px" fontSize="12px" color="fg.subtle">
              Ranked by virality score. Accept, reject, or adjust boundaries.
            </Text>
          </Box>
        </Flex>

        <Stack gap="12px">
          {clips.map((clip) => (
            <ClipCard key={clip.id} clip={clip} sourceVideoUrl={sourceVideoUrl} sourceType={sourceType} />
          ))}
        </Stack>
      </Stack>
    </Box>
  );
}
