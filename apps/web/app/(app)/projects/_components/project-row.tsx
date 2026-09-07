"use client";

import Link from "next/link";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Checkbox } from "@narriflow/ui/components/checkbox";
import type { ProjectListItem } from "@narriflow/services";
import { formatDateTime } from "@/lib/format";
import { ProjectThumbnail } from "./project-thumbnail";
import { getProjectActivity, ShimmerStrip } from "./project-card";

interface ProjectRowProps {
  project: ProjectListItem;
  selectable?: boolean;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
}

export function ProjectRow({
  project,
  selectable = false,
  selected = false,
  onSelectedChange,
}: ProjectRowProps) {
  const activity = getProjectActivity(project);

  return (
    <Box position="relative">
      <Link
        href={`/projects/${project.id}`}
        style={{ textDecoration: "none", display: "block" }}
      >
      <Flex
        position="relative"
        align="center"
        gap={{ base: "3", md: "4" }}
        py="3"
        pr={{ base: "3", md: "4" }}
        pl={selectable ? "12" : { base: "3", md: "4" }}
        borderWidth="1px"
        borderColor={selected ? "accent.solid" : "border"}
        borderRadius="l2"
        bg="bg.panel"
        transition="background 120ms ease"
        _hover={{ bg: "bg.subtle" }}
        css={{
          "&:hover .project-row-title": { textDecorationLine: "underline" },
        }}
      >
        <Box position="relative" w="76px" flexShrink={0}>
          <ProjectThumbnail project={project} variant="sliver" />
          {activity.active ? <ShimmerStrip /> : null}
        </Box>

        <Stack gap="1" flex="1" minW="0">
          <Text
            className="project-row-title"
            fontSize="14px"
            fontWeight="500"
            color="fg"
            letterSpacing="-0.01em"
            truncate
            textDecorationColor="border.emphasized"
            textUnderlineOffset="3px"
          >
            {project.title}
          </Text>
          <Text fontSize="11px" color="fg.subtle" truncate>
            {formatDateTime(project.createdAt)}
          </Text>
        </Stack>
      </Flex>
      </Link>
      {selectable ? (
        <Box
          position="absolute"
          top="50%"
          left="3"
          zIndex={2}
          transform="translateY(-50%)"
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
    </Box>
  );
}
