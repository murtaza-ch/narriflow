"use client";

import { Box, Flex, Text } from "@chakra-ui/react";
import {
  Sparkles,
  Subtitles,
  Upload,
  LayoutGrid,
  Clapperboard,
  Shuffle,
  Type,
  Music,
  Mic2,
  X,
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
import { AiEnhancePanel } from "./tool-panels/ai-enhance-panel";
import { UploadPanel } from "./tool-panels/upload-panel";
import { AiHookPanel } from "./tool-panels/ai-hook-panel";

const TOOLS: { id: ToolId; label: string; icon: React.ReactNode }[] = [
  { id: "ai-enhance",  label: "AI enhance",     icon: <Sparkles size={20} /> },
  { id: "captions",    label: "Captions",        icon: <Subtitles size={20} /> },
  { id: "upload",      label: "Upload",          icon: <Upload size={20} /> },
  { id: "brand",       label: "Brand\ntemplate", icon: <LayoutGrid size={20} /> },
  { id: "broll",       label: "B-Roll",          icon: <Clapperboard size={20} /> },
  { id: "transitions", label: "Transitions",     icon: <Shuffle size={20} /> },
  { id: "text",        label: "Text",            icon: <Type size={20} /> },
  { id: "music",       label: "Music",           icon: <Music size={20} /> },
  { id: "ai-hook",     label: "AI hook",         icon: <Mic2 size={20} /> },
];

const PANEL_MAP: Record<ToolId, React.ReactNode> = {
  "ai-enhance":  <AiEnhancePanel />,
  "captions":    <CaptionsPanel />,
  "upload":      <UploadPanel />,
  "brand":       <BrandTemplatePanel />,
  "broll":       <BRollPanel />,
  "transitions": <TransitionsPanel />,
  "text":        <TextPanel />,
  "music":       <MusicPanel />,
  "ai-hook":     <AiHookPanel />,
};

export function ToolSidebar() {
  const { activeTool, setActiveTool } = useStudio();

  const handleToolClick = (id: ToolId) => {
    setActiveTool(activeTool === id ? null : id);
  };

  return (
    <Flex h="100%" position="relative" flexShrink={0}>
      {/* Sliding tool panel */}
      <Box
        position="absolute"
        right="72px"
        top="0"
        bottom="0"
        w="280px"
        bg="#141414"
        borderLeftWidth="1px"
        borderColor="#1e1e1e"
        transform={activeTool ? "translateX(0)" : "translateX(100%)"}
        transition="transform 200ms ease"
        zIndex={10}
        display="flex"
        flexDirection="column"
        overflow="hidden"
        boxShadow={activeTool ? "-4px 0 20px rgba(0,0,0,0.4)" : "none"}
      >
        {/* Panel header */}
        {activeTool && (
          <Flex
            px="16px"
            py="12px"
            align="center"
            justify="space-between"
            borderBottomWidth="1px"
            borderColor="#1e1e1e"
            flexShrink={0}
          >
            <Text fontSize="13px" fontWeight="600" color="#e5e5e5" textTransform="capitalize">
              {TOOLS.find((t) => t.id === activeTool)?.label.replace("\n", " ")}
            </Text>
            <Box
              as="button"
              onClick={() => setActiveTool(null)}
              p="4px"
              borderRadius="4px"
              bg="transparent"
              border="none"
              color="#555"
              cursor="pointer"
              _hover={{ color: "#aaa", bg: "#222" }}
              transition="all 150ms"
            >
              <X size={15} />
            </Box>
          </Flex>
        )}

        {/* Panel content */}
        <Box flex="1" overflowY="auto" css={{
          "&::-webkit-scrollbar": { width: "4px" },
          "&::-webkit-scrollbar-thumb": { background: "#2a2a2a", borderRadius: "4px" },
        }}>
          {activeTool && PANEL_MAP[activeTool]}
        </Box>
      </Box>

      {/* Icon rail */}
      <Flex
        direction="column"
        w="72px"
        h="100%"
        bg="#111111"
        borderLeftWidth="1px"
        borderColor="#1e1e1e"
        align="center"
        pt="8px"
        gap="2px"
        flexShrink={0}
        zIndex={11}
      >
        {TOOLS.map((tool) => {
          const isActive = activeTool === tool.id;
          return (
            <Flex
              key={tool.id}
              as="button"
              direction="column"
              align="center"
              justify="center"
              gap="4px"
              w="100%"
              py="10px"
              px="4px"
              cursor="pointer"
              bg={isActive ? "#1e1e1e" : "transparent"}
              border="none"
              borderLeft="2px solid"
              borderLeftColor={isActive ? "#6366F1" : "transparent"}
              color={isActive ? "#e5e5e5" : "#555"}
              transition="all 150ms ease"
              _hover={{ color: "#bbb", bg: "#181818" }}
              onClick={() => handleToolClick(tool.id)}
              position="relative"
            >
              {tool.icon}
              <Text
                fontSize="9px"
                fontWeight="500"
                textAlign="center"
                lineHeight="1.2"
                whiteSpace="pre-line"
              >
                {tool.label}
              </Text>
            </Flex>
          );
        })}
      </Flex>
    </Flex>
  );
}
