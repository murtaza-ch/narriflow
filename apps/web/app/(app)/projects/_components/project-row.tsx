"use client";

import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { ScoreMeter } from "@narriflow/ui/components/meter";
import type { ProjectListItem } from "@narriflow/services";
import { ProjectThumbnail } from "./project-thumbnail";
import {
  buildProjectMeta,
  getProjectActivity,
  ShimmerStrip,
} from "./project-card";

interface ProjectRowProps {
  project: ProjectListItem;
}

const STRIPE_COLORS: Record<string, string> = {
  ready: "success.solid",
  completed: "success.solid",
  processing: "accent.solid",
  failed: "danger.solid",
  error: "danger.solid",
  queued: "border.emphasized",
  pending: "border.emphasized",
};

/**
 * ProjectRow — the compact list view: hairline row with a 3px status stripe
 * on the leading edge and a thumbnail sliver in a small MediaWell. The whole
 * row is one link, mirroring the grid card.
 */
export function ProjectRow({ project }: ProjectRowProps) {
  const activity = getProjectActivity(project);
  const meta = buildProjectMeta(project);
  const stripe = STRIPE_COLORS[activity.status] ?? "border.emphasized";

  return (
    <Link
      href={`/projects/${project.id}`}
      style={{ textDecoration: "none", display: "block" }}
    >
      <Flex
        position="relative"
        align="center"
        gap="4"
        py="3"
        ps="4"
        pe="2"
        borderBottomWidth="1px"
        borderBottomColor="border.subtle"
        transition="background 120ms ease"
        _hover={{ bg: "bg.subtle" }}
        css={{
          "&:hover .project-row-title": { textDecorationLine: "underline" },
        }}
      >
        {/* 3px status stripe — state is stripe + label, never hue alone */}
        <Box
          position="absolute"
          insetInlineStart="0"
          top="0"
          bottom="0"
          w="3px"
          bg={stripe}
          aria-hidden="true"
        />

        <Box position="relative" w="76px" flexShrink={0}>
          <ProjectThumbnail project={project} variant="sliver" />
          {activity.active ? <ShimmerStrip /> : null}
        </Box>

        <Stack gap="1" flex="1" minW="0">
          <Text
            className="project-row-title"
            fontSize="14px"
            fontWeight="600"
            color="fg"
            letterSpacing="-0.01em"
            truncate
            textDecorationColor="border.emphasized"
            textUnderlineOffset="3px"
          >
            {project.title}
          </Text>
          <Text textStyle="data" fontSize="11px" color="fg.subtle" truncate>
            {meta}
          </Text>
        </Stack>

        {/* Fixed-width column so badges align down the list as one grid */}
        <Box
          display={{ base: "none", sm: "block" }}
          w="136px"
          flexShrink={0}
        >
          <StatusBadge status={activity.status} label={activity.label} />
        </Box>

        <Box w="10" flexShrink={0} display="flex" justifyContent="flex-end">
          {project.avgViralityScore !== null ? (
            <ScoreMeter
              score={Math.round(project.avgViralityScore)}
              size="sm"
            />
          ) : (
            <Text textStyle="data" fontSize="11px" color="fg.subtle">
              —
            </Text>
          )}
        </Box>
      </Flex>
    </Link>
  );
}
