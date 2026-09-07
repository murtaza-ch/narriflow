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
  ingestStatus,
}: {
  title: string;
  sourceMediaUrl: string;
  ingestStatus: IngestStageStatus;
}) {
  const youtubeId = extractYoutubeId(sourceMediaUrl);
  const stageWord = ingestStageWord(ingestStatus);
  const isTerminal = ingestStatus === "ready" || ingestStatus === "failed";

  return (
    <Flex
      align="center"
      gap="3"
      bg="bg.subtle"
      px="3"
      py="2.5"
      borderRadius="xl"
    >
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
        px="2.5"
        py="1"
        rounded="full"
        bg="bg.panel"
      >
        {!isTerminal && <Spinner size="xs" />}
        <Text
          textStyle="eyebrow"
          color={
            ingestStatus === "failed"
              ? "danger.fg"
              : ingestStatus === "ready"
                ? "success.fg"
                : "fg.subtle"
          }
        >
          {stageWord}
        </Text>
      </Flex>
    </Flex>
  );
}
