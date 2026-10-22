"use client";

import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import {
  Subtitles,
  LayoutGrid,
  Clapperboard,
  Shuffle,
  Type,
  Music,
  Crop,
  X,
  PanelsTopLeft,
} from "lucide-react";
import { useStudio } from "./studio-shell";
import type { ToolId } from "./studio-shell";

// Tool panel imports
import { CaptionsPanel } from "./tool-panels/captions-panel";
import { BRollPanel } from "./tool-panels/broll-panel";
import { TextPanel } from "./tool-panels/text-panel";
import { MusicPanel } from "./tool-panels/music-panel";
import { BrandTemplatePanel } from "./tool-panels/brand-template-panel";
import { TransitionsPanel } from "./tool-panels/transitions-panel";
import { LayoutPanel } from "./tool-panels/layout-panel";
import { ScenesPanel } from "./tool-panels/scenes-panel";

/** `railLabel` is the short name under the rail icon; `label` titles the panel. */
const TOOLS: { id: ToolId; label: string; railLabel?: string; icon: React.ReactNode }[] = [
  { id: "captions",    label: "Captions", icon: <Subtitles size={22} /> },
  { id: "brand",       label: "Brand template", railLabel: "Brand", icon: <LayoutGrid size={22} /> },
  { id: "broll",       label: "B-Roll",   icon: <Clapperboard size={22} /> },
  { id: "transitions", label: "Motion",   icon: <Shuffle size={22} /> },
  { id: "text",        label: "Text",     icon: <Type size={22} /> },
  { id: "music",       label: "Music",    icon: <Music size={22} /> },
  { id: "layout",      label: "Layout",   icon: <Crop size={22} /> },
  { id: "scenes",      label: "Scenes",   icon: <PanelsTopLeft size={22} /> },
]

const PANEL_MAP: Record<ToolId, React.ReactNode> = {
  "captions":    <CaptionsPanel />,
  "brand":       <BrandTemplatePanel />,
  "broll":       <BRollPanel />,
  "transitions": <TransitionsPanel />,
  "text":        <TextPanel />,
  "music":       <MusicPanel />,
  "layout":      <LayoutPanel />,
  "scenes":      <ScenesPanel />,
};

/**
 * Tool rail on the editor's right edge, and — only while a tool is open — its
 * panel floating beside it. With no tool selected the canvas gets the room.
 */
export function ToolSidebar() {
  const { activeTool, setActiveTool } = useStudio("activeTool", "setActiveTool");

  const handleToolClick = (id: ToolId) => {
    setActiveTool(activeTool === id ? null : id);
  };

  const activeLabel = TOOLS.find((t) => t.id === activeTool)?.label;

  return (
    <Flex h="100%" flexShrink={0} gap="2">
      {activeTool ? (
        <Flex
          direction="column"
          w={{ base: "300px", md: "380px" }}
          bg="studio.canvas"
          borderRadius="12px"
          overflow="hidden"
        >
          <Flex px="5" pt="4" pb="3" align="center" justify="space-between" flexShrink={0}>
            <Text fontSize="16px" fontWeight="500" color="studio.fg">
              {activeLabel}
            </Text>
            <Flex
              as="button"
              aria-label="Close tool panel"
              align="center"
              justify="center"
              w="30px"
              h="30px"
              borderRadius="l2"
              bg="transparent"
              border="none"
              color="studio.fgMuted"
              cursor="pointer"
              _hover={{ color: "studio.fg", bg: "studio.raised" }}
              transition="background 120ms ease, color 120ms ease"
              onClick={() => setActiveTool(null)}
            >
              <X size={16} />
            </Flex>
          </Flex>
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
            {PANEL_MAP[activeTool]}
          </Box>
        </Flex>
      ) : null}

      {/* Eight tools must fit short laptop screens: below 900px tall the
          buttons compact, below 760px they drop to icons (names stay in the
          tooltip and accessible label); anything shorter scrolls. */}
      <Stack
        w="92px"
        h="100%"
        gap="1"
        py="3"
        px="2"
        bg="studio.canvas"
        borderRadius="12px"
        role="tablist"
        aria-label="Studio tools"
        aria-orientation="vertical"
        overflowY="auto"
        css={{
          "@media (max-height: 900px)": { paddingBlock: "8px" },
          "& > [role=tab]": {
            "@media (max-height: 900px)": { minHeight: "58px", gap: "4px", paddingBlock: "6px" },
            "@media (max-height: 760px)": { minHeight: "44px" },
          },
          "@media (max-height: 760px)": { "& [data-rail-label]": { display: "none" } },
        }}
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
              direction="column"
              align="center"
              justify="center"
              gap="1.5"
              w="full"
              minH="76px"
              py="2"
              flexShrink={0}
              borderRadius="10px"
              bg={isActive ? "studio.accentSubtle" : "transparent"}
              border="none"
              color={isActive ? "studio.accentFg" : "studio.fgMuted"}
              cursor="pointer"
              transition="background 120ms ease, color 120ms ease"
              _hover={{ bg: isActive ? "studio.accentSubtle" : "studio.subtle", color: isActive ? "studio.accentFg" : "studio.fg" }}
              onClick={() => handleToolClick(tool.id)}
            >
              {tool.icon}
              <Text data-rail-label fontSize="12px" fontWeight="500" lineHeight="1.25" textAlign="center">
                {tool.railLabel ?? tool.label}
              </Text>
            </Flex>
          );
        })}
      </Stack>
    </Flex>
  );
}
