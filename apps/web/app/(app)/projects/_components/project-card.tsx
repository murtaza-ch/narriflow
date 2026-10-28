"use client";

import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import type { ProjectListItem } from "@narriflow/services";
import { formatDate } from "@/lib/format";
import { DeleteProjectButton } from "./delete-project-button";
import { ProjectExpiration } from "./project-expiration";
import { ProjectThumbnail } from "./project-thumbnail";
import { STATUS_CONFIG, type BadgeStatus } from "../_lib/status";

export { STATUS_CONFIG };

interface ProjectCardProps {
  project: ProjectListItem;
  priority?: boolean;
  selectable?: boolean;
  /** Members who can't edit never see a delete that would be refused. */
  canDelete?: boolean;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
}

export interface ProjectActivity {
	/** Badge reflecting the shared product progress result from the list query. */
  status: BadgeStatus;
  label: string;
	/** True while intake or a Workflow Run is still moving. */
  active: boolean;
}

export function getProjectActivity(project: ProjectListItem): ProjectActivity {
	return project.progress;
}

/** A project's quiet line: what's happening if anything is, when it was made, and what came of it. */
export function ProjectMeta({ project }: { project: ProjectListItem }) {
  const activity = getProjectActivity(project);
  const settled = !activity.active && activity.status !== "failed";
  const parts = [formatDate(project.createdAt)];
  // A clip count once there is one, or once the project is done.
  if (project.clipCount > 0) parts.push(`${project.clipCount} ${project.clipCount === 1 ? "clip" : "clips"}`);
  else if (settled) parts.push("No clips");
  return (
    <Flex align="center" gap="1.5" fontSize="12px" color="fg.subtle">
      {settled ? null : (
        <>
          <Flex as="span" align="center" gap="1.5" flexShrink={0} color={activity.active ? "fg.muted" : "danger.fg"}>
            <Box as="span" boxSize="1.5" borderRadius="full" bg={activity.active ? "accent.solid" : "danger.solid"} />
            {activity.label}
          </Flex>
          <span aria-hidden>·</span>
        </>
      )}
      <Text as="span" truncate>
        {parts.join(" · ")}
      </Text>
    </Flex>
  );
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
  canDelete = false,
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
            "& img": { transition: "transform 400ms ease" },
            "@media (hover: hover)": { "&:hover img": { transform: "scale(1.03)" } },
          }}
        >
          <Box position="relative">
            <ProjectThumbnail project={project} priority={priority} />
            {activity.active ? <ShimmerStrip /> : null}
          </Box>

          <Stack gap="1" minW="0">
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
            <ProjectMeta project={project} />
            {project.expiresAt ? <ProjectExpiration expiresAt={project.expiresAt} /> : null}
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
          boxSize="8"
          display="grid"
          placeItems="center"
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
      {canDelete ? (
        <DeleteProjectButton
          projectId={project.id}
          projectTitle={project.title}
          variant="icon"
        />
      ) : null}
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
