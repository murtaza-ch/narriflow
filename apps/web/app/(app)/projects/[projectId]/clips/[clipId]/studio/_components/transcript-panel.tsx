"use client";

import { memo, useRef, useEffect, useCallback, useState, useMemo } from "react";
import { Box, Flex, Text, Checkbox } from "@chakra-ui/react";
import { editedToSource, sourceToEdited } from "@narriflow/validators";
import type { EditedTimeMap, TranscriptUtterance, TranscriptWord } from "@narriflow/validators";
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
  editedTimeMap: EditedTimeMap,
) {
  // The clock reports EDITED time (vizard-parity.md Phase B step 8) —
  // convert through the map to the absolute SOURCE seconds `utterances`'
  // own startSec/endSec live in, same as captions (use-current-caption.ts).
  const absoluteTime = editedToSource(editedTimeMap, playbackClock.getSnapshot());
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
            bg="studio.fgSubtle"
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
  onSeek: (editedTime: number) => void;
}) {
  const { updateUtteranceText, editedTimeMap, captionPreset } = useStudio();
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
        borderRadius="l1"
        bg={isActive ? "studio.accent/10" : "transparent"}
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
                color={isActiveWord ? highlightColor : "studio.fg"}
                fontWeight="inherit"
                cursor="pointer"
                borderRadius="2px"
                transition="color 80ms ease-out"
                _hover={{ bg: "rgba(255,255,255,0.06)" }}
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  onSeek(sourceToEdited(editedTimeMap, token.word.startSec));
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
      borderRadius="l1"
      bg="studio.accent/15"
      boxShadow="0 0 0 1.5px var(--chakra-colors-studio-ring)"
      color="studio.fg"
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
    editedTimeMap,
    playbackClock,
  } = useStudio();

  const scrollRef = useRef<HTMLDivElement>(null);
  const manualScrollRef = useRef(false);
  const manualScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeState, setActiveState] = useState(() =>
    getActiveTranscriptState(playbackClock, utterances, editedTimeMap),
  );

  useEffect(() => {
    const update = () => {
      const next = getActiveTranscriptState(playbackClock, utterances, editedTimeMap);
      setActiveState((prev) =>
        prev.utteranceIndex === next.utteranceIndex && prev.wordIndex === next.wordIndex
          ? prev
          : next,
      );
    };

    update();
    return playbackClock.subscribe(update);
  }, [editedTimeMap, playbackClock, utterances]);

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
      w={{ base: "240px", md: "280px", xl: "300px" }}
      minW={{ base: "240px", md: "280px", xl: "300px" }}
      maxW={{ base: "240px", md: "280px", xl: "300px" }}
      h="100%"
      bg="studio.surface"
      borderRightWidth="1px"
      borderColor="studio.border"
      display={{ base: "none", lg: "flex" }}
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
        borderColor="studio.border"
        flexShrink={0}
        gap="2"
      >
        <Text textStyle="eyebrow" color="studio.fgMuted">
          Transcript
        </Text>
        <Checkbox.Root
          checked={transcriptOnly}
          onCheckedChange={(e) => setTranscriptOnly(!!e.checked)}
          size="sm"
          colorPalette="accent"
          gap="8px"
          cursor="pointer"
        >
          <Checkbox.HiddenInput />
          <Checkbox.Control />
          <Checkbox.Label>
            <Text fontSize="12px" color="studio.fgMuted">Transcript only</Text>
          </Checkbox.Label>
        </Checkbox.Root>
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
          "&::-webkit-scrollbar-thumb": {
            background: "var(--chakra-colors-studio-raised)",
            borderRadius: "4px",
          },
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
                color="studio.accentFg"
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
                  <Box flex="1" h="1px" bg="studio.border" />
                  <Flex align="center" gap="3px" px="6px" py="2px" borderRadius="l1" bg="rgba(255,255,255,0.03)">
                    {[0, 1, 2].map((d) => (
                      <Box key={d} w="4px" h="4px" borderRadius="full" bg="studio.fgSubtle" />
                    ))}
                    <Text textStyle="data" fontSize="10.5px" color="studio.fgMuted" ml="2px">
                      {pauseAfter.toFixed(1)}s
                    </Text>
                  </Flex>
                  <Box flex="1" h="1px" bg="studio.border" />
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
