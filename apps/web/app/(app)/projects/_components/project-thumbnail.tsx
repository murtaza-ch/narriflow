"use client";

import { AspectRatio, Box, Center, Flex, Text } from "@chakra-ui/react";
import Image from "next/image";
import { Rss, Upload, Youtube } from "lucide-react";
import { useState } from "react";
import type { ProjectListItem } from "@narriflow/services";
import { extractYoutubeId, youtubeThumbnailUrl } from "../_lib/youtube";
import { gradientForId } from "../_lib/gradient";
import { formatDuration } from "../_lib/format";

interface ProjectThumbnailProps {
  project: ProjectListItem;
}

const NOISE_SVG =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.55'/></svg>\")";

export function ProjectThumbnail({ project }: ProjectThumbnailProps) {
  const youtubeId =
    project.sourceType === "youtube"
      ? extractYoutubeId(project.sourceInput, project.sourceMediaUrl)
      : null;

  return (
    <AspectRatio ratio={16 / 9} bg="bg.muted">
      <Box position="relative" overflow="hidden">
        {youtubeId ? (
          <YoutubeThumb
            youtubeId={youtubeId}
            alt={project.title}
            fallbackId={project.id}
          />
        ) : (
          <GradientThumb
            projectId={project.id}
            sourceType={project.sourceType}
          />
        )}

        <Overlays project={project} />
      </Box>
    </AspectRatio>
  );
}

function YoutubeThumb({
  youtubeId,
  alt,
  fallbackId,
}: {
  youtubeId: string;
  alt: string;
  fallbackId: string;
}) {
  const [src, setSrc] = useState(youtubeThumbnailUrl(youtubeId, "max"));
  const [usedFallback, setUsedFallback] = useState(false);
  const [failedAll, setFailedAll] = useState(false);

  if (failedAll) {
    return <GradientThumb projectId={fallbackId} sourceType="youtube" />;
  }

  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes="(min-width: 1280px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
      style={{
        objectFit: "cover",
        transition: "transform 400ms cubic-bezier(0.4, 0, 0.2, 1)",
      }}
      className="project-thumb-img"
      unoptimized
      onError={() => {
        if (!usedFallback) {
          setUsedFallback(true);
          setSrc(youtubeThumbnailUrl(youtubeId, "hq"));
        } else {
          setFailedAll(true);
        }
      }}
    />
  );
}

function GradientThumb({
  projectId,
  sourceType,
}: {
  projectId: string;
  sourceType: ProjectListItem["sourceType"];
}) {
  const gradient = gradientForId(projectId);
  const Icon =
    sourceType === "rss" ? Rss : sourceType === "youtube" ? Youtube : Upload;

  return (
    <Box
      position="absolute"
      inset={0}
      style={{
        background: `linear-gradient(135deg, ${gradient.from} 0%, ${gradient.to} 100%)`,
      }}
    >
      <Box
        position="absolute"
        inset={0}
        opacity={0.18}
        backgroundImage={NOISE_SVG}
        backgroundRepeat="repeat"
      />
      <Center position="absolute" inset={0}>
        <Box
          color="whiteAlpha.800"
          opacity={0.85}
          style={{ filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.35))" }}
        >
          <Icon size={36} strokeWidth={1.4} />
        </Box>
      </Center>
    </Box>
  );
}

function Overlays({ project }: { project: ProjectListItem }) {
  const duration = formatDuration(
    project.sourceDurationSeconds ?? project.transcript?.durationSeconds ?? null,
  );

  return (
    <>
      {duration ? (
        <Flex
          position="absolute"
          bottom="10px"
          right="10px"
          align="center"
          px="8px"
          py="3px"
          borderRadius="6px"
          bg="rgba(0, 0, 0, 0.7)"
          style={{ backdropFilter: "blur(8px)" }}
        >
          <Text
            fontFamily="mono"
            fontSize="11px"
            fontWeight="500"
            color="white"
            letterSpacing="0.02em"
          >
            {duration}
          </Text>
        </Flex>
      ) : null}

      <SourceChip sourceType={project.sourceType} />
    </>
  );
}

function SourceChip({
  sourceType,
}: {
  sourceType: ProjectListItem["sourceType"];
}) {
  const config = {
    youtube: { Icon: Youtube, label: "YouTube" },
    upload: { Icon: Upload, label: "Upload" },
    rss: { Icon: Rss, label: "RSS" },
  } as const;
  const { Icon, label } = config[sourceType];

  return (
    <Flex
      position="absolute"
      top="10px"
      left="10px"
      align="center"
      gap="5px"
      px="8px"
      py="3px"
      borderRadius="6px"
      bg="rgba(0, 0, 0, 0.55)"
      style={{ backdropFilter: "blur(8px)" }}
    >
      <Box color="white" opacity={0.95}>
        <Icon size={11} strokeWidth={2.2} />
      </Box>
      <Text
        fontFamily="mono"
        fontSize="10px"
        fontWeight="500"
        color="white"
        letterSpacing="0.06em"
        textTransform="uppercase"
      >
        {label}
      </Text>
    </Flex>
  );
}
