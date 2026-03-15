"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import { Box, Flex, Text, Stack, Checkbox } from "@chakra-ui/react";
import { Plus, Trash2, GripVertical } from "lucide-react";
import { useStudio } from "./studio-shell";
import type { TranscriptItem } from "./studio-shell";

const HIGHLIGHT_COLORS: Record<string, string> = {
  green: "#4ade80",
  amber: "#fbbf24",
  orange: "#fb923c",
};

function WordSpan({
  word,
  highlight,
  isActive,
  onClick,
}: {
  word: string;
  highlight?: { color: string } | undefined;
  isActive: boolean;
  onClick: () => void;
}) {
  const color = highlight ? HIGHLIGHT_COLORS[highlight.color] ?? "#e5e5e5" : "#d4d4d4";
  return (
    <Box
      as="span"
      display="inline"
      color={color}
      onClick={onClick}
      cursor="pointer"
      borderRadius="2px"
      transition="all 100ms"
      bg={isActive ? "rgba(99,102,241,0.2)" : "transparent"}
      borderBottomWidth={isActive ? "2px" : "0"}
      borderColor="#6366F1"
      _hover={{ bg: "rgba(255,255,255,0.06)" }}
      userSelect="none"
    >
      {word}
    </Box>
  );
}

function SpeechBlock({
  item,
  currentTime,
  onSeek,
}: {
  item: TranscriptItem;
  currentTime: number;
  onSeek: (t: number) => void;
}) {
  const words = (item.text ?? "").split(" ");
  const isBlockActive = currentTime >= (item.timestamp ?? 0);

  return (
    <Box
      px="16px"
      py="8px"
      lineHeight="1.75"
      fontSize="13.5px"
    >
      {words.map((word, i) => {
        const cleanWord = word.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
        const highlight = item.highlights?.find(
          (h) => h.word.toLowerCase() === cleanWord,
        );
        return (
          <Box as="span" key={i} display="inline">
            <WordSpan
              word={word}
              highlight={highlight}
              isActive={isBlockActive && i === Math.floor(words.length / 2)}
              onClick={() => onSeek(item.timestamp ?? 0)}
            />
            {i < words.length - 1 ? " " : ""}
          </Box>
        );
      })}
    </Box>
  );
}

function BRollCard({
  item,
  onRemove,
}: {
  item: TranscriptItem;
  onRemove: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <Box
      mx="16px"
      my="6px"
      px="12px"
      py="10px"
      bg="#1a1a1a"
      borderWidth="1px"
      borderColor="#2a2a2a"
      borderRadius="8px"
      position="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      transition="border-color 150ms"
      _hover={{ borderColor: "#3a3a3a" }}
    >
      <Flex align="flex-start" gap="10px">
        <GripVertical size={14} color="#444" style={{ marginTop: "2px", flexShrink: 0, cursor: "grab" }} />
        <Box flex="1">
          <Text
            fontSize="11px"
            fontFamily="mono"
            color="#6366F1"
            fontWeight="600"
            mb="3px"
          >
            {item.timestamp}s:
          </Text>
          <Text fontSize="12.5px" color="#888" lineHeight="1.5">
            {item.description}
          </Text>
        </Box>
        {hovered && (
          <Box
            as="button"
            onClick={() => onRemove(item.id)}
            p="4px"
            borderRadius="4px"
            color="#555"
            cursor="pointer"
            flexShrink={0}
            bg="transparent"
            border="none"
            _hover={{ color: "#ef4444", bg: "rgba(239,68,68,0.1)" }}
            transition="all 150ms"
          >
            <Trash2 size={13} />
          </Box>
        )}
      </Flex>
    </Box>
  );
}

export function TranscriptPanel() {
  const {
    transcript,
    transcriptOnly,
    setTranscriptOnly,
    currentTime,
    seekTo,
  } = useStudio();

  const [localTranscript, setLocalTranscript] = useState<TranscriptItem[]>(transcript);
  const scrollRef = useRef<HTMLDivElement>(null);
  const manualScrollRef = useRef(false);
  const manualScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleRemoveBRoll = useCallback((id: string) => {
    setLocalTranscript((prev) => prev.filter((item) => item.id !== id));
  }, []);

  // Auto-scroll to follow current time
  useEffect(() => {
    if (manualScrollRef.current) return;
    // find the active speech block and scroll to it
    const container = scrollRef.current;
    if (!container) return;
    const blocks = container.querySelectorAll("[data-timestamp]");
    let best: Element | null = null;
    for (const el of blocks) {
      const ts = parseFloat(el.getAttribute("data-timestamp") ?? "0");
      if (ts <= currentTime) best = el;
    }
    if (best) {
      best.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [currentTime]);

  const handleScroll = useCallback(() => {
    manualScrollRef.current = true;
    if (manualScrollTimer.current) clearTimeout(manualScrollTimer.current);
    manualScrollTimer.current = setTimeout(() => {
      manualScrollRef.current = false;
    }, 3000);
  }, []);

  const visibleItems = transcriptOnly
    ? localTranscript.filter((i) => i.type === "speech")
    : localTranscript;

  return (
    <Box
      w="300px"
      minW="300px"
      maxW="300px"
      h="100%"
      bg="#111111"
      borderRightWidth="1px"
      borderColor="#222222"
      display="flex"
      flexDirection="column"
      overflow="hidden"
    >
      {/* Header */}
      <Flex
        px="16px"
        pt="12px"
        pb="10px"
        align="center"
        justify="space-between"
        borderBottomWidth="1px"
        borderColor="#1e1e1e"
        flexShrink={0}
        gap="8px"
        flexWrap="wrap"
      >
        <Checkbox.Root
          checked={transcriptOnly}
          onCheckedChange={(e) => setTranscriptOnly(!!e.checked)}
          size="sm"
          colorPalette="purple"
          gap="8px"
          cursor="pointer"
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label>
            <Text fontSize="12px" color="#888">Transcript only</Text>
          </Checkbox.Label>
        </Checkbox.Root>

        <Flex
          as="button"
          align="center"
          gap="4px"
          bg="transparent"
          border="none"
          cursor="pointer"
          color="#6366F1"
          fontSize="12px"
          fontWeight="500"
          px="8px"
          py="4px"
          borderRadius="6px"
          _hover={{ bg: "rgba(99,102,241,0.1)" }}
          transition="background 150ms"
        >
          <Plus size={13} />
          Add a section
        </Flex>
      </Flex>

      {/* Scrollable transcript body */}
      <Box
        ref={scrollRef}
        flex="1"
        overflowY="auto"
        py="8px"
        onScroll={handleScroll}
        css={{
          "&::-webkit-scrollbar": { width: "4px" },
          "&::-webkit-scrollbar-track": { background: "transparent" },
          "&::-webkit-scrollbar-thumb": { background: "#2a2a2a", borderRadius: "4px" },
        }}
      >
        {visibleItems.map((item) => (
          <Box key={item.id} data-timestamp={item.timestamp}>
            {item.type === "speech" ? (
              <SpeechBlock
                item={item}
                currentTime={currentTime}
                onSeek={seekTo}
              />
            ) : (
              <BRollCard item={item} onRemove={handleRemoveBRoll} />
            )}
          </Box>
        ))}

        {/* Bottom padding */}
        <Box h="32px" />
      </Box>
    </Box>
  );
}
