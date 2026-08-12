"use client";

import { Box, Center, Flex, Text } from "@chakra-ui/react";
import Image from "next/image";
import { Link2, Rss, Upload, Youtube } from "lucide-react";
import { useState } from "react";
import { MediaWell } from "@narriflow/ui/components/media-well";
import type { ProjectListItem } from "@narriflow/services";
import { LINK_PROVIDERS } from "@narriflow/validators";
import { formatDuration } from "@/lib/format";
import { extractYoutubeId, youtubeThumbnailUrl } from "../_lib/youtube";
import { gradientForId } from "../_lib/gradient";

function linkProviderLabel(sourceProvider: string | null | undefined): string {
  return (
    LINK_PROVIDERS.find((p) => p.id === sourceProvider)?.label ?? "Link"
  );
}

interface ProjectThumbnailProps {
  project: ProjectListItem;
  priority?: boolean;
  /**
   * "card" — full treatment: source chip + timecode chip.
   * "sliver" — bare footage for compact list rows.
   */
  variant?: "card" | "sliver";
}

const NOISE_SVG =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.55'/></svg>\")";

/**
 * ProjectThumbnail — footage always sits in a MediaWell (graphite in both
 * modes), never raw on the page ground.
 */
export function ProjectThumbnail({
  project,
  variant = "card",
  priority = false,
}: ProjectThumbnailProps) {
  const youtubeId =
    project.sourceType === "youtube"
      ? extractYoutubeId(project.sourceInput, project.sourceMediaUrl)
      : null;

  const durationSeconds =
    project.sourceDurationSeconds ?? project.transcript?.durationSeconds ?? null;
  const duration =
    durationSeconds !== null && durationSeconds >= 0
      ? formatDuration(durationSeconds)
      : null;

  return (
    <MediaWell
      ratio={16 / 9}
      timecode={variant === "card" && duration ? duration : undefined}
    >
      {youtubeId ? (
        <YoutubeThumb
          youtubeId={youtubeId}
          alt={project.title}
          fallbackId={project.id}
          priority={priority}
        />
      ) : (
        <GradientThumb
          projectId={project.id}
          sourceType={project.sourceType}
          iconSize={variant === "sliver" ? 16 : 32}
        />
      )}

      {variant === "card" ? (
        <SourceChip
          sourceType={project.sourceType}
          sourceProvider={project.sourceProvider}
        />
      ) : null}
    </MediaWell>
  );
}

function YoutubeThumb({
  youtubeId,
  alt,
  fallbackId,
  priority,
}: {
  youtubeId: string;
  alt: string;
  fallbackId: string;
  priority: boolean;
}) {
  const [src, setSrc] = useState(youtubeThumbnailUrl(youtubeId, "max"));
  const [usedFallback, setUsedFallback] = useState(false);
  const [failedAll, setFailedAll] = useState(false);

  if (failedAll) {
    return (
      <GradientThumb projectId={fallbackId} sourceType="youtube" iconSize={32} />
    );
  }

  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes="(min-width: 1280px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
      style={{ objectFit: "cover" }}
      unoptimized
      loading={priority ? "eager" : "lazy"}
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
  iconSize,
}: {
  projectId: string;
  sourceType: ProjectListItem["sourceType"];
  iconSize: number;
}) {
  const gradient = gradientForId(projectId);
  const Icon =
    sourceType === "rss"
      ? Rss
      : sourceType === "youtube"
        ? Youtube
        : sourceType === "link"
          ? Link2
          : Upload;

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
        <Box color="studio.fgMuted">
          <Icon size={iconSize} strokeWidth={1.4} />
        </Box>
      </Center>
    </Box>
  );
}

function SourceChip({
  sourceType,
  sourceProvider,
}: {
  sourceType: ProjectListItem["sourceType"];
  sourceProvider?: string | null;
}) {
  const Icon = sourceType === "rss" ? Rss : sourceType === "youtube" ? Youtube : sourceType === "link" ? Link2 : Upload;
  const label =
    sourceType === "rss"
      ? "RSS"
      : sourceType === "youtube"
        ? "YouTube"
        : sourceType === "link"
          ? linkProviderLabel(sourceProvider)
          : "Upload";

  return (
    <Flex
      position="absolute"
      top="1.5"
      left="1.5"
      align="center"
      gap="1"
      px="1.5"
      py="0.5"
      borderRadius="l1"
      // rgba of studio.canvas (#0E1013) — matches MediaWell's sanctioned
      // mode-invariant chip ground for overlays on footage.
      bg="studio.scrim"
      pointerEvents="none"
    >
      <Box color="studio.fg">
        <Icon size={10} strokeWidth={2.2} />
      </Box>
      <Text
        textStyle="data"
        fontSize="10px"
        color="studio.fg"
        letterSpacing="0.08em"
        textTransform="uppercase"
        lineHeight="1.4"
      >
        {label}
      </Text>
    </Flex>
  );
}
