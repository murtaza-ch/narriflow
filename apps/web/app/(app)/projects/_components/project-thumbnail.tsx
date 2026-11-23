"use client";

import { Box, Center, Flex, Text } from "@chakra-ui/react";
import Image from "next/image";
import { Link2, Rss, Upload, Youtube } from "lucide-react";
import { useEffect, useState } from "react";
import { MediaWell } from "@narriflow/ui/components/media-well";
import type { ProjectListItem } from "../_lib/api";
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
  fetchPriority?: "high";
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
  fetchPriority,
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
      borderWidth="0"
    >
      {project.thumbnail ? (
        <UploadThumb key={`${project.id}:${project.sourceStorageKey}`} project={project} priority={priority} fetchPriority={fetchPriority} variant={variant} />
      ) : youtubeId ? (
        <YoutubeThumb
          youtubeId={youtubeId}
          alt={project.title}
          fallbackId={project.id}
          priority={priority}
          fetchPriority={fetchPriority}
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

export function UploadThumb({ project, priority, fetchPriority, variant, sizes }: { project: Pick<ProjectListItem, "id" | "sourceType" | "thumbnail">; priority: boolean; fetchPriority?: "high"; variant: "card" | "sliver"; sizes?: string }) {
  const [failed, setFailed] = useState(false);
  const [thumbnail, setThumbnail] = useState(project.thumbnail);
  // Progress polling issues fresh grants. Keep the loaded image until renewal
  // is needed, so polling never downloads every thumbnail again.
  useEffect(() => {
    if (!thumbnail || !project.thumbnail) return;
    const renew = () => { setThumbnail(project.thumbnail); setFailed(false); };
    const delay = Date.parse(thumbnail.expiresAt) - Date.now() - 60_000;
    if (delay <= 0) {
      if (thumbnail !== project.thumbnail) renew();
      return;
    }
    const timer = window.setTimeout(renew, delay);
    return () => window.clearTimeout(timer);
  }, [thumbnail, project.thumbnail]);
  if (failed || !thumbnail) return <GradientThumb projectId={project.id} sourceType={project.sourceType} iconSize={variant === "sliver" ? 16 : 32} />;
  const src = thumbnail.small ?? thumbnail.large;
  if (!src) return null;
  return (
    <img
      src={src}
      srcSet={thumbnail.small && thumbnail.large ? `${thumbnail.small} 480w, ${thumbnail.large} 960w` : undefined}
      sizes={sizes ?? (variant === "sliver" ? "80px" : `${priority ? "" : "auto, "}(min-width: 1280px) 33vw, (min-width: 640px) 50vw, 100vw`)}
      width={480}
      height={270}
      alt=""
      loading={priority ? "eager" : "lazy"}
      fetchPriority={fetchPriority}
      decoding="async"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }}
      onError={() => setFailed(true)}
    />
  );
}

function YoutubeThumb({
  youtubeId,
  alt,
  fallbackId,
  priority,
  fetchPriority,
}: {
  youtubeId: string;
  alt: string;
  fallbackId: string;
  priority: boolean;
  fetchPriority?: "high";
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
      fetchPriority={fetchPriority}
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
      bottom="2"
      left="2"
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
        <Icon size={13} strokeWidth={2.2} />
      </Box>
      <Text
        srOnly
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
