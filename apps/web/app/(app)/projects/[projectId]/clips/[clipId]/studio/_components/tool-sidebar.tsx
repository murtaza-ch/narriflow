"use client";

import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import {
  Subtitles,
  LayoutGrid,
  Clapperboard,
  Shuffle,
  Type,
  Music,
  X,
} from "lucide-react";
import { ScoreMeter } from "@narriflow/ui";
import { formatDuration } from "@/lib/format";
import { useStudio } from "./studio-shell";
import type { ToolId } from "./studio-shell";

// Tool panel imports
import { CaptionsPanel } from "./tool-panels/captions-panel";
import { BRollPanel } from "./tool-panels/broll-panel";
import { TextPanel } from "./tool-panels/text-panel";
import { MusicPanel } from "./tool-panels/music-panel";
import { BrandTemplatePanel } from "./tool-panels/brand-template-panel";
import { TransitionsPanel } from "./tool-panels/transitions-panel";

const TOOLS: { id: ToolId; label: string; icon: React.ReactNode }[] = [
  { id: "captions",    label: "Captions",       icon: <Subtitles size={17} /> },
  { id: "brand",       label: "Brand template", icon: <LayoutGrid size={17} /> },
  { id: "broll",       label: "B-Roll",         icon: <Clapperboard size={17} /> },
  { id: "transitions", label: "Transitions",    icon: <Shuffle size={17} /> },
  { id: "text",        label: "Text",           icon: <Type size={17} /> },
  { id: "music",       label: "Music",          icon: <Music size={17} /> },
];

const PANEL_MAP: Record<ToolId, React.ReactNode> = {
  "captions":    <CaptionsPanel />,
  "brand":       <BrandTemplatePanel />,
  "broll":       <BRollPanel />,
  "transitions": <TransitionsPanel />,
  "text":        <TextPanel />,
  "music":       <MusicPanel />,
};

/** Hairline definition row for the no-selection Inspector view. */
function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex
      align="center"
      justify="space-between"
      gap="3"
      py="3"
      borderBottomWidth="1px"
      borderColor="studio.border"
    >
      <Text fontSize="12px" color="studio.fgMuted">
        {label}
      </Text>
      {children}
    </Flex>
  );
}

/**
 * Default Inspector contents when no tool is active — the clip's own data
 * (virality score, category, duration, format).
 */
function ClipProperties() {
  const { clipInfo, aspectRatio, segments } = useStudio();

  return (
    <Stack gap="0" px="4" pt="2">
      <PropertyRow label="Virality score">
        <ScoreMeter score={clipInfo.viralityScore} size="md" showLabel />
      </PropertyRow>
      <PropertyRow label="Category">
        <Text fontSize="12px" fontWeight="600" color="studio.fg" textTransform="capitalize">
          {clipInfo.category || "—"}
        </Text>
      </PropertyRow>
      <PropertyRow label="Duration">
        <Text textStyle="data" fontSize="12px" color="studio.timecode">
          {formatDuration(clipInfo.duration)}
        </Text>
      </PropertyRow>
      <PropertyRow label="Format">
        <Text textStyle="data" fontSize="12px" color="studio.fg">
          {aspectRatio}
        </Text>
      </PropertyRow>
      <PropertyRow label="Segments">
        <Text textStyle="data" fontSize="12px" color="studio.fg">
          {segments.length}
        </Text>
      </PropertyRow>
      <Text fontSize="12px" color="studio.fgSubtle" lineHeight="1.6" pt="4">
        Select a tool above to style captions, add overlays, or swap in B-roll.
        Click the caption on the video to edit it directly.
      </Text>
    </Stack>
  );
}

/**
 * The Inspector — one fixed-width contextual panel replacing the old
 * icon-rail + slide-out pair. Contents follow the active tool; with nothing
 * selected it shows the clip's properties.
 */
export function ToolSidebar() {
  const { activeTool, setActiveTool } = useStudio();

  const handleToolClick = (id: ToolId) => {
    setActiveTool(activeTool === id ? null : id);
  };

  const activeLabel = TOOLS.find((t) => t.id === activeTool)?.label;

  return (
    <Flex
      direction="column"
      w={{ base: "260px", md: "300px" }}
      h="100%"
      bg="studio.surface"
      borderLeftWidth="1px"
      borderColor="studio.border"
      flexShrink={0}
      overflow="hidden"
    >
      {/* Tool tabs */}
      <Flex
        px="2"
        py="2"
        gap="1"
        borderBottomWidth="1px"
        borderColor="studio.border"
        role="tablist"
        aria-label="Studio tools"
        flexShrink={0}
      >
        {TOOLS.map((tool) => {
          const isActive = activeTool === tool.id;
          return (
            <Flex
              key={tool.id}
              as="button"
              role="tab"
              aria-selected={isActive}
              aria-label={tool.label}
              title={tool.label}
              align="center"
              justify="center"
              flex="1"
              h="36px"
              borderRadius="l1"
              position="relative"
              bg={isActive ? "studio.raised" : "transparent"}
              border="none"
              color={isActive ? "studio.accentFg" : "studio.fgMuted"}
              cursor="pointer"
              transition="background 120ms ease, color 120ms ease"
              _hover={{ bg: "studio.raised", color: isActive ? "studio.accentFg" : "studio.fg" }}
              onClick={() => handleToolClick(tool.id)}
            >
              {tool.icon}
              {/* 3px active stripe — state is never hue alone */}
              {isActive && (
                <Box
                  position="absolute"
                  bottom="-1px"
                  left="6px"
                  right="6px"
                  h="3px"
                  borderRadius="full"
                  bg="studio.accent"
                />
              )}
            </Flex>
          );
        })}
      </Flex>

      {/* Panel header */}
      <Flex
        px="4"
        py="3"
        align="center"
        justify="space-between"
        borderBottomWidth="1px"
        borderColor="studio.border"
        flexShrink={0}
      >
        <Text textStyle="eyebrow" color="studio.fgMuted">
          {activeLabel ?? "Clip properties"}
        </Text>
        {activeTool && (
          <Flex
            as="button"
            aria-label="Close tool panel"
            align="center"
            justify="center"
            w="24px"
            h="24px"
            borderRadius="l1"
            bg="transparent"
            border="none"
            color="studio.fgMuted"
            cursor="pointer"
            _hover={{ color: "studio.fg", bg: "studio.raised" }}
            transition="background 120ms ease, color 120ms ease"
            onClick={() => setActiveTool(null)}
          >
            <X size={14} />
          </Flex>
        )}
      </Flex>

      {/* Panel content */}
      <Box
        flex="1"
        overflowY="auto"
        css={{
          "&::-webkit-scrollbar": { width: "4px" },
          "&::-webkit-scrollbar-thumb": {
            background: "var(--chakra-colors-studio-raised)",
            borderRadius: "4px",
          },
        }}
      >
        {activeTool ? PANEL_MAP[activeTool] : <ClipProperties />}
      </Box>
    </Flex>
  );
}
