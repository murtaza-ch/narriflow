"use client";

import Link from "next/link";
import { Box, Stack, Text } from "@chakra-ui/react";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import type { ProjectListItem } from "@narriflow/services";
import { formatDate, formatDateTime, formatDuration } from "@/lib/format";
import { DeleteProjectButton } from "./delete-project-button";
import { ProjectThumbnail } from "./project-thumbnail";
import { STATUS_CONFIG, type BadgeStatus } from "../_lib/status";

export { STATUS_CONFIG };

interface ProjectCardProps {
  project: ProjectListItem;
  priority?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
}

export interface ProjectActivity {
  /** Badge reflecting the live pipeline stage (ingest, then transcript). */
  status: BadgeStatus;
  label: string;
  /** True while ingest or transcription is still running. */
  active: boolean;
}

export function getProjectActivity(project: ProjectListItem): ProjectActivity {
  const ingest = STATUS_CONFIG[project.ingestStatus] ?? STATUS_CONFIG.queued!;
  if (project.ingestStatus === "ready") {
    const transcriptStatus = project.transcript?.status;
    if (transcriptStatus === "processing") {
      return { status: "processing", label: "Transcribing", active: true };
    }
    if (transcriptStatus === "queued") {
      return { status: "processing", label: "Transcript queued", active: true };
    }
    return { status: ingest.status, label: ingest.label, active: false };
  }
  const active =
    ingest.status === "processing" ||
    ingest.status === "queued" ||
    ingest.status === "pending";
  return { status: ingest.status, label: ingest.label, active };
}

export function buildProjectMeta(project: ProjectListItem): string {
  const parts: string[] = [formatDate(project.createdAt)];

  const durationSeconds =
    project.sourceDurationSeconds ??
    project.transcript?.durationSeconds ??
    null;
  if (durationSeconds !== null && durationSeconds > 0) {
    parts.push(formatDuration(durationSeconds));
  }

  parts.push(
    project.clipCount === 0
      ? "No clips"
      : `${project.clipCount} ${project.clipCount === 1 ? "clip" : "clips"}`,
  );

  if (
    project.transcript?.status === "completed" &&
    project.transcript.languageCode
  ) {
    parts.push(project.transcript.languageCode.replace("_", "-").toUpperCase());
  }

  return parts.join(" · ");
}

/**
 * ProjectCard — de-carded per the Blueline decision table: the footage sits
 * in a MediaWell, the text block sits directly on the page ground. The whole
 * card is one link (per-card actions are out of scope for this pass).
 */
export function ProjectCard({
  project,
  priority = false,
  selectable = false,
  selected = false,
  onSelectedChange,
}: ProjectCardProps) {
  const activity = getProjectActivity(project);

  return (
    <Box
      position="relative"
      borderRadius="l2"
      outline={selected ? "2px solid" : "none"}
      outlineColor="accent.solid"
      outlineOffset="3px"
      css={{
        "@media (hover: hover) and (pointer: fine)": {
          "& .project-card-action": { opacity: 0 },
          "&:hover .project-card-action, &:focus-within .project-card-action": {
            opacity: 1,
          },
          "& .project-select-action[data-selected=true]": { opacity: 1 },
        },
      }}
    >
      <Link
        href={`/projects/${project.id}`}
        style={{ textDecoration: "none", display: "block", height: "100%" }}
      >
        <Stack
          gap="3"
          h="full"
          css={{
            "&:hover .project-card-title": { textDecorationLine: "underline" },
          }}
        >
          <Box position="relative">
            <ProjectThumbnail project={project} priority={priority} />
            {activity.active ? <ShimmerStrip /> : null}
            {activity.status === "failed" ? (
              <Box
                position="absolute"
                top="0"
                insetInline="0"
                h="3px"
                bg="danger.solid"
                borderTopRadius="l2"
              />
            ) : null}
          </Box>

          <Stack gap="1">
            <Text fontSize="11px" color="fg.subtle">
              {formatDateTime(project.createdAt)}
            </Text>
            <Text
              className="project-card-title"
              minW="0"
              fontSize="14px"
              fontWeight="500"
              color="fg"
              letterSpacing="-0.01em"
              lineHeight="1.35"
              textDecorationColor="border.emphasized"
              textUnderlineOffset="3px"
              css={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {project.title}
            </Text>
          </Stack>
        </Stack>
      </Link>
      {selectable ? (
        <Box
          className="project-card-action project-select-action"
          data-selected={selected}
          position="absolute"
          top="2"
          left="2"
          zIndex={2}
          p="1.5"
          borderRadius="l1"
          bg="studio.scrimStrong"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => onSelectedChange?.(checked)}
            aria-label={`Select "${project.title}"`}
          />
        </Box>
      ) : null}
      <DeleteProjectButton
        projectId={project.id}
        projectTitle={project.title}
        variant="icon"
      />
    </Box>
  );
}

/**
 * Shimmer strip — the processing signature: an ultramarine sheen traveling
 * along the top edge of the well. CSS-only (`shimmer` token), covered by the
 * global reduced-motion kill-switch.
 */
export function ShimmerStrip() {
  return (
    <Box
      position="absolute"
      top="0"
      insetInline="0"
      h="3px"
      borderTopRadius="l2"
      backgroundImage="linear-gradient(90deg, transparent 20%, {colors.accent.solid} 50%, transparent 80%)"
      backgroundSize="200% 100%"
      animation="shimmer"
      pointerEvents="none"
    />
  );
}
