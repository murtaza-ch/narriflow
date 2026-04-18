"use client";

import { memo, useRef, useEffect, useCallback, useState, useMemo } from "react";
import { Box, Flex, Text, Checkbox } from "@chakra-ui/react";
import { Plus } from "lucide-react";
import type { TranscriptUtterance, TranscriptWord } from "@narriflow/validators";
import { useStudio } from "./studio-shell";
import type { PlaybackClock } from "./playback-clock";

// ─── Pause threshold (seconds) ──────────────────────────────────────────────

const PAUSE_THRESHOLD = 0.4;

// ─── Build words with pause indicators ──────────────────────────────────────

interface DisplayToken {
  type: "word" | "pause";
  word: TranscriptWord;
  pauseDuration?: number;
}

function buildDisplayTokens(words: TranscriptWord[]): DisplayToken[] {
  const tokens: DisplayToken[] = [];
  for (let i = 0; i < words.length; i++) {
    tokens.push({ type: "word", word: words[i]! });

    if (i < words.length - 1) {
      const gap = words[i + 1]!.startSec - words[i]!.endSec;
      if (gap >= PAUSE_THRESHOLD) {
        tokens.push({
          type: "pause",
          word: words[i]!,
          pauseDuration: gap,
        });
      }
    }
  }
  return tokens;
}

function getWordsForUtterance(utterance: TranscriptUtterance): TranscriptWord[] {
  if (utterance.words.length > 0) return utterance.words;

  const textWords = utterance.text.split(/\s+/).filter(Boolean);
  const count = Math.max(1, textWords.length);
  const duration = Math.max(0.001, utterance.endSec - utterance.startSec);
  const wordDuration = duration / count;

  return textWords.map((word, i) => ({
    word,
    startSec: utterance.startSec + i * wordDuration,
    endSec: utterance.startSec + (i + 1) * wordDuration,
    confidence: null,
  }));
}

function getActiveTranscriptState(
  playbackClock: PlaybackClock,
  utterances: TranscriptUtterance[],
  clipStartSec: number,
) {
  const absoluteTime = playbackClock.getSnapshot() + clipStartSec;
  const utteranceIndex = utterances.findIndex(
    (u) => absoluteTime >= u.startSec && absoluteTime < u.endSec,
  );

  if (utteranceIndex === -1) {
    return { utteranceIndex: -1, wordIndex: -1 };
  }

  const words = getWordsForUtterance(utterances[utteranceIndex]!);
  const wordIndex = words.findIndex(
    (w) => absoluteTime >= w.startSec && absoluteTime < w.endSec,
  );

  return { utteranceIndex, wordIndex };
}

// ─── Pause indicator ────────────────────────────────────────────────────────

function PauseIndicator({ duration }: { duration: number }) {
  const label = `${duration.toFixed(1)}s`;
  return (
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      gap="3px"
      mx="4px"
      px="6px"
      py="1px"
      borderRadius="4px"
      bg="rgba(255,255,255,0.06)"
      verticalAlign="middle"
      title={`${label} pause`}
      cursor="default"
    >
      <Box
        as="span"
        display="inline-flex"
        gap="2px"
        alignItems="center"
      >
        {[0, 1, 2].map((d) => (
          <Box
            key={d}
            w="4px"
            h="4px"
            borderRadius="full"
            bg="#555"
          />
        ))}
      </Box>
    </Box>
  );
}

// ─── Editable Utterance ─────────────────────────────────────────────────────

const EditableUtterance = memo(function EditableUtterance({
  utterance,
  utteranceIndex,
  isActive,
  activeWordIndex,
  onSeek,
}: {
  utterance: TranscriptUtterance;
  utteranceIndex: number;
  isActive: boolean;
  activeWordIndex: number;
  onSeek: (clipRelativeTime: number) => void;
}) {
  const { updateUtteranceText, clipStartSec, captionPreset } = useStudio();
  const blockRef = useRef<HTMLDivElement>(null);
  const [isEditing, setIsEditing] = useState(false);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    const text = blockRef.current?.innerText?.trim();
    if (text && text !== utterance.text) {
      updateUtteranceText(utteranceIndex, text);
    }
  }, [utteranceIndex, utterance.text, updateUtteranceText]);

  const handleFocus = useCallback(() => {
    setIsEditing(true);
  }, []);

  // Build words (with fallback for utterances without word-level timing)
  const words: TranscriptWord[] = useMemo(() => {
    return getWordsForUtterance(utterance);
  }, [utterance]);

  // Build display tokens with pause indicators
  const tokens = useMemo(() => buildDisplayTokens(words), [words]);

  const highlightColor = captionPreset.highlightColor;

  // When not editing, render clickable word spans with highlights
  if (!isEditing) {
    return (
      <Box
        ref={blockRef}
        px="16px"
        py="8px"
        lineHeight="1.75"
        fontSize="13.5px"
        borderRadius="4px"
        bg={isActive ? "rgba(99,102,241,0.08)" : "transparent"}
        _hover={{ bg: "rgba(255,255,255,0.04)" }}
        transition="background 150ms"
        contentEditable
        suppressContentEditableWarning
        onFocus={handleFocus}
        onBlur={handleBlur}
        outline="none"
        cursor="text"
      >
        {tokens.map((token, i) => {
          if (token.type === "pause") {
            return (
              <PauseIndicator
                key={`pause-${i}`}
                duration={token.pauseDuration!}
              />
            );
          }

          const wordIdx = words.indexOf(token.word);
          const isActiveWord = wordIdx === activeWordIndex;

          return (
            <Box as="span" key={i} display="inline">
              <Box
                as="span"
                display="inline"
                color={isActiveWord ? highlightColor : "#d4d4d4"}
                fontWeight="inherit"
                cursor="pointer"
                borderRadius="2px"
                transition="color 80ms ease-out"
                _hover={{ bg: "rgba(255,255,255,0.06)" }}
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  onSeek(token.word.startSec - clipStartSec);
                }}
              >
                {token.word.word}
              </Box>
              {i < tokens.length - 1 && tokens[i + 1]?.type !== "pause"
                ? " "
                : tokens[i + 1]?.type === "pause"
                  ? ""
                  : ""}
            </Box>
          );
        })}
      </Box>
    );
  }

  // Editing mode — plain contentEditable text
  return (
    <Box
      ref={blockRef}
      contentEditable
      suppressContentEditableWarning
      onBlur={handleBlur}
      onFocus={handleFocus}
      outline="none"
      cursor="text"
      px="16px"
      py="8px"
      lineHeight="1.75"
      fontSize="13.5px"
      borderRadius="4px"
      bg="rgba(99,102,241,0.12)"
      boxShadow="0 0 0 1px rgba(99,102,241,0.3)"
      color="#e0e0e0"
      transition="background 150ms"
    >
      {utterance.text}
    </Box>
  );
});

// ─── Main Panel ─────────────────────────────────────────────────────────────

export function TranscriptPanel() {
  const {
    utterances,
    transcriptOnly,
    setTranscriptOnly,
    seekTo,
    clipStartSec,
    playbackClock,
  } = useStudio();

  const scrollRef = useRef<HTMLDivElement>(null);
  const manualScrollRef = useRef(false);
  const manualScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeState, setActiveState] = useState(() =>
    getActiveTranscriptState(playbackClock, utterances, clipStartSec),
  );

  useEffect(() => {
    const update = () => {
      const next = getActiveTranscriptState(playbackClock, utterances, clipStartSec);
      setActiveState((prev) =>
        prev.utteranceIndex === next.utteranceIndex && prev.wordIndex === next.wordIndex
          ? prev
          : next,
      );
    };

    update();
    return playbackClock.subscribe(update);
  }, [clipStartSec, playbackClock, utterances]);

  // Auto-scroll when the active utterance changes, not on every playback tick.
  useEffect(() => {
    if (manualScrollRef.current) return;
    const container = scrollRef.current;
    if (!container) return;
    if (activeState.utteranceIndex < 0) return;

    const active = container.querySelector(
      `[data-utterance-index="${activeState.utteranceIndex}"]`,
    );
    if (!active) return;

    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const isOutside =
      activeRect.top < containerRect.top + 16 ||
      activeRect.bottom > containerRect.bottom - 16;

    if (isOutside) {
      active.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeState.utteranceIndex]);

  const handleScroll = useCallback(() => {
    manualScrollRef.current = true;
    if (manualScrollTimer.current) clearTimeout(manualScrollTimer.current);
    manualScrollTimer.current = setTimeout(() => {
      manualScrollRef.current = false;
    }, 3000);
  }, []);

  // Detect pauses between utterances
  const utterancePauses = useMemo(() => {
    const pauses: Map<number, number> = new Map();
    for (let i = 0; i < utterances.length - 1; i++) {
      const gap = utterances[i + 1]!.startSec - utterances[i]!.endSec;
      if (gap >= PAUSE_THRESHOLD) {
        pauses.set(i, gap);
      }
    }
    return pauses;
  }, [utterances]);

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
        {utterances.map((utterance, i) => {
          const isActive = activeState.utteranceIndex === i;
          const clipRelativeTimestamp = utterance.startSec - clipStartSec;
          const pauseAfter = utterancePauses.get(i);

          return (
            <Box
              key={`u-${utterance.index ?? i}`}
              data-timestamp={clipRelativeTimestamp}
              data-utterance-index={i}
            >
              {/* Speaker label */}
              <Text
                fontSize="11px"
                fontWeight="600"
                color="#6366F1"
                px="16px"
                pt={i === 0 ? "4px" : "12px"}
                pb="2px"
              >
                {utterance.speakerLabel}
              </Text>

              <EditableUtterance
                utterance={utterance}
                utteranceIndex={i}
                isActive={isActive}
                activeWordIndex={isActive ? activeState.wordIndex : -1}
                onSeek={seekTo}
              />

              {/* Pause between utterances */}
              {pauseAfter !== undefined && (
                <Flex
                  px="16px"
                  py="4px"
                  align="center"
                  gap="6px"
                >
                  <Box flex="1" h="1px" bg="#1e1e1e" />
                  <Flex align="center" gap="3px" px="6px" py="2px" borderRadius="4px" bg="rgba(255,255,255,0.03)">
                    {[0, 1, 2].map((d) => (
                      <Box key={d} w="4px" h="4px" borderRadius="full" bg="#444" />
                    ))}
                    <Text fontSize="10px" color="#444" ml="2px">
                      {pauseAfter.toFixed(1)}s
                    </Text>
                  </Flex>
                  <Box flex="1" h="1px" bg="#1e1e1e" />
                </Flex>
              )}
            </Box>
          );
        })}

        {/* Bottom padding */}
        <Box h="32px" />
      </Box>
    </Box>
  );
}
