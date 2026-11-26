"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { Box, Flex, Stack, Text } from "@chakra-ui/react";
import { Spinner } from "@narriflow/ui/components/spinner";
import {
  ArrowLeft,
  Subtitles,
  LayoutGrid,
  Clapperboard,
  Shuffle,
  Type,
  Music,
  Crop,
  X,
  PanelsTopLeft,
  ShieldCheck,
  WandSparkles,
} from "lucide-react";
import { useStudio } from "./studio-shell";
import type { ToolId } from "./studio-shell";
import { PANEL_SCROLL_ATTRIBUTE } from "./tool-target";
import { CaptionEmojiRunHost } from "./emoji/caption-emoji-run-host";

// Each panel is its own chunk, fetched when its tool is first opened.
function PanelPending() {
  return (
    <Flex justify="center" py="10" role="status" aria-label="Loading tool">
      <Spinner size="sm" />
    </Flex>
  );
}
const AiToolsPanel = dynamic(() => import("./tool-panels/ai-tools-panel").then((m) => m.AiToolsPanel), { loading: PanelPending });
const CaptionsPanel = dynamic(() => import("./tool-panels/captions-panel").then((m) => m.CaptionsPanel), { loading: PanelPending });
const BRollPanel = dynamic(() => import("./tool-panels/broll-panel").then((m) => m.BRollPanel), { loading: PanelPending });
const TextPanel = dynamic(() => import("./tool-panels/text-panel").then((m) => m.TextPanel), { loading: PanelPending });
const MusicPanel = dynamic(() => import("./tool-panels/music-panel").then((m) => m.MusicPanel), { loading: PanelPending });
const BrandTemplatePanel = dynamic(() => import("./tool-panels/brand-template-panel").then((m) => m.BrandTemplatePanel), { loading: PanelPending });
const TransitionsPanel = dynamic(() => import("./tool-panels/transitions-panel").then((m) => m.TransitionsPanel), { loading: PanelPending });
const LayoutPanel = dynamic(() => import("./tool-panels/layout-panel").then((m) => m.LayoutPanel), { loading: PanelPending });
const ScenesPanel = dynamic(() => import("./tool-panels/scenes-panel").then((m) => m.ScenesPanel), { loading: PanelPending });
const CensorPanel = dynamic(() => import("./tool-panels/censor-panel").then((m) => m.CensorPanel), { loading: PanelPending });

/**
 * `railLabel` is the short name under the rail icon; `label` titles the panel. A tool with a
 * `parent` has no rail button: it opens from a row of its parent's panel, which stays selected.
 */
export const TOOLS: { id: ToolId; label: string; railLabel?: string; icon: React.ReactNode; parent?: ToolId }[] = [
  { id: "ai",          label: "AI tools", icon: <WandSparkles size={22} strokeWidth={1.75} /> },
  { id: "captions",    label: "Captions", icon: <Subtitles size={22} strokeWidth={1.75} /> },
  { id: "brand",       label: "Brand template", railLabel: "Brand", icon: <LayoutGrid size={22} strokeWidth={1.75} /> },
  { id: "broll",       label: "B-Roll",   icon: <Clapperboard size={22} strokeWidth={1.75} /> },
  { id: "transitions", label: "Motion",   icon: <Shuffle size={22} strokeWidth={1.75} /> },
  { id: "text",        label: "Text",     icon: <Type size={22} strokeWidth={1.75} /> },
  { id: "music",       label: "Music",    icon: <Music size={22} strokeWidth={1.75} /> },
  { id: "layout",      label: "Layout",   icon: <Crop size={22} strokeWidth={1.75} /> },
  { id: "scenes",      label: "Scenes",   icon: <PanelsTopLeft size={22} strokeWidth={1.75} /> },
  { id: "censor",      label: "Auto-censor", icon: <ShieldCheck size={22} strokeWidth={1.75} />, parent: "ai" },
]

/** The tools with a rail button, in rail order. */
export const RAIL_TOOLS = TOOLS.filter((tool) => !tool.parent);

export const PANEL_MAP: Record<ToolId, React.ReactNode> = {
  "ai":          <AiToolsPanel />,
  "captions":    <CaptionsPanel />,
  "brand":       <BrandTemplatePanel />,
  "broll":       <BRollPanel />,
  "transitions": <TransitionsPanel />,
  "text":        <TextPanel />,
  "music":       <MusicPanel />,
  "layout":      <LayoutPanel />,
  "scenes":      <ScenesPanel />,
  "censor":      <CensorPanel />,
};

/**
 * While another tab holds the write lease, edits in this tab are refused. Say
 * so where the edits happen, with the same take-over the top bar offers.
 */
export function ReadOnlyPanelNotice({ onTakeOver }: { onTakeOver: () => void }) {
  return (
    <Flex mx="5" mb="3" px="3" py="2.5" gap="3" align="center" justify="space-between" bg="studio.subtle" borderRadius="10px" role="status">
      <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.4">
        Read-only here. This clip is open for editing in another tab.
      </Text>
      <Box
        as="button"
        flexShrink={0}
        h="28px"
        px="2.5"
        borderRadius="8px"
        bg="studio.raised"
        border="none"
        color="studio.fg"
        fontSize="12px"
        fontWeight="500"
        whiteSpace="nowrap"
        cursor="pointer"
        _hover={{ bg: "studio.borderStrong" }}
        onClick={onTakeOver}
      >
        Take over
      </Box>
    </Flex>
  );
}

/**
 * Tool rail on the editor's right edge, and — only while a tool is open — its
 * panel floating beside it. With no tool selected the canvas gets the room.
 */
export function ToolSidebar() {
  const { activeTool, setActiveTool, openTool, editingElsewhere, handleTakeOverEditing } = useStudio("activeTool", "setActiveTool", "openTool", "editingElsewhere", "handleTakeOverEditing");

  // The library list is prefetched with the Studio; warm the Music panel's code
  // too once the page is idle, so the first open paints rows, not a spinner.
  useEffect(() => {
    const warm = () => void import("./tool-panels/music-panel");
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(warm, 2000);
    return () => window.clearTimeout(timer);
  }, []);

  // A rail click opens the tool at its top, dropping any place an earlier row asked for.
  const handleToolClick = (id: ToolId) => {
    if (activeTool === id) setActiveTool(null);
    else openTool(id);
  };

  const active = TOOLS.find((t) => t.id === activeTool);
  const activeLabel = active?.label;
  const parent = active?.parent ? TOOLS.find((t) => t.id === active.parent) : undefined;

  return (
    <Flex h="100%" flexShrink={0} gap="2">
      <CaptionEmojiRunHost />
      {activeTool ? (
        <Flex
          direction="column"
          w={{ base: "300px", md: "380px" }}
          bg="studio.canvas"
          borderRadius="12px"
          overflow="hidden"
        >
          <Flex px="5" pt="4" pb="3" align="center" justify="space-between" flexShrink={0}>
            <Flex align="center" gap="1.5" minW="0">
              {parent ? (
                <Flex
                  as="button"
                  aria-label={`Back to ${parent.label}`}
                  title={`Back to ${parent.label}`}
                  align="center"
                  justify="center"
                  boxSize="32px"
                  ms="-2"
                  flexShrink={0}
                  borderRadius="8px"
                  bg="transparent"
                  border="none"
                  color="studio.fgMuted"
                  cursor="pointer"
                  _hover={{ color: "studio.fg", bg: "studio.raised" }}
                  _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "1px" }}
                  transition="background 120ms ease, color 120ms ease"
                  onClick={() => openTool(parent.id)}
                >
                  <ArrowLeft size={16} />
                </Flex>
              ) : null}
              <Text fontSize="16px" fontWeight="500" color="studio.fg">
                {activeLabel}
              </Text>
            </Flex>
            <Flex
              as="button"
              aria-label="Close tool panel"
              title="Close"
              align="center"
              justify="center"
              boxSize="32px"
              borderRadius="8px"
              bg="transparent"
              border="none"
              color="studio.fgMuted"
              cursor="pointer"
              _hover={{ color: "studio.fg", bg: "studio.raised" }}
              _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "1px" }}
              transition="background 120ms ease, color 120ms ease"
              onClick={() => setActiveTool(null)}
            >
              <X size={16} />
            </Flex>
          </Flex>
          {editingElsewhere ? <ReadOnlyPanelNotice onTakeOver={handleTakeOverEditing} /> : null}
          <Box
            {...{ [PANEL_SCROLL_ATTRIBUTE]: "" }}
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

      {/* The rail's tools must fit short laptop screens. The rail sizes its buttons by
          its own height (the timeline takes a variable share of the window):
          compact, then smaller labels, then icons only (names stay in the
          tooltip and accessible label), then tighter icons; anything shorter
          scrolls. Thresholds were set for 10 buttons + 9 gaps + the rail's padding. */}
      <Box w="92px" h="100%" flexShrink={0} css={{ containerType: "size" }}>
      <Stack
        w="full"
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
          "@container (max-height: 819px)": {
            paddingBlock: "8px",
            "& > [role=tab]": { minHeight: "58px", gap: "4px", paddingBlock: "6px" },
          },
          "@container (max-height: 631px)": {
            "& > [role=tab]": { minHeight: "48px", gap: "2px", paddingBlock: "4px" },
          },
          "@container (max-height: 531px)": {
            "& > [role=tab]": { minHeight: "36px", paddingBlock: "0" },
            "& [data-rail-label]": { display: "none" },
          },
          "@container (max-height: 411px)": {
            gap: "2px",
            paddingBlock: "6px",
            "& > [role=tab]": { minHeight: "30px" },
          },
        }}
      >
        {RAIL_TOOLS.map((tool) => {
          const isActive = activeTool === tool.id || active?.parent === tool.id;
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
              _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "-2px" }}
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
      </Box>
    </Flex>
  );
}
