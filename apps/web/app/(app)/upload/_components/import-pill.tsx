"use client";

import { Box, Flex, Text } from "@chakra-ui/react";
import { Link2 } from "lucide-react";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  ingestStageWord,
  type IngestStageStatus,
} from "../_lib/use-ingest-stream";
import {
  extractYoutubeId,
  youtubeThumbnailUrl,
} from "../../projects/_lib/youtube";

/** Compact pinned pill: thumbnail, title, and ingest stage only — no
 *  percentage, no download-speed detail (those are deferred, real
 *  worker/yt-dlp work, not UI). */
export function ImportPill({
  title,
  sourceMediaUrl,
  sourceInput = null,
  ingestStatus,
}: {
  title: string;
  sourceMediaUrl: string;
  /** The link as pasted, which names the video when the stored URL doesn't. */
  sourceInput?: string | null;
  ingestStatus: IngestStageStatus;
}) {
  const youtubeId = extractYoutubeId(sourceInput, sourceMediaUrl);
  const stageWord = ingestStageWord(ingestStatus);
  const isTerminal = ingestStatus === "ready" || ingestStatus === "failed";

  return (
    <Flex
      position="relative"
      overflow="hidden"
      align="center"
      gap="3"
      bg="bg.panel"
      borderWidth="1px"
      borderColor="border.card"
      px="3"
      py="2.5"
      borderRadius="l3"
    >
      {/* While the import runs, a sheen travels the bottom edge (the same
          signature as a processing project card). */}
      {!isTerminal ? (
        <Box
          position="absolute"
          insetX="0"
          bottom="0"
          h="2px"
          backgroundImage="linear-gradient(90deg, transparent 20%, {colors.accent.solid} 50%, transparent 80%)"
          backgroundSize="200% 100%"
          animation="shimmer"
          pointerEvents="none"
        />
      ) : null}
      <MediaWell
        ratio={16 / 9}
        w={{ base: "72px", sm: "80px" }}
        flexShrink={0}
      >
        {youtubeId ? (
          <img
            src={youtubeThumbnailUrl(youtubeId, "hq")}
            alt=""
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : (
          <Flex
            align="center"
            justify="center"
            position="absolute"
            inset="0"
            color="studio.fgMuted"
          >
            <Link2 size={14} strokeWidth={1.75} />
          </Flex>
        )}
      </MediaWell>
      <Box minW="0" flex="1">
        <Text fontSize="13px" fontWeight="500" color="fg" truncate>
          {title || "Link import"}
        </Text>
      </Box>
      <Flex
        role="status"
        align="center"
        gap="1.5"
        flexShrink={0}
      >
        {!isTerminal && <Spinner size="xs" />}
        <Text
          fontSize="13px"
          fontWeight="500"
          color={ingestStatus === "failed" ? "danger.fg" : "accent.fg"}
        >
          {stageWord}
        </Text>
      </Flex>
    </Flex>
  );
}
