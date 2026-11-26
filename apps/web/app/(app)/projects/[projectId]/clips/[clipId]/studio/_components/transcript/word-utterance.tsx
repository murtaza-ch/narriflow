"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Input } from "@chakra-ui/react";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  autoCensorWordId,
  censoredCaptionWordText,
  hasSpaceBefore,
  sourceToEdited,
  splitSpacedTokens,
  type TranscriptUtterance,
  type TranscriptWord,
} from "@narriflow/validators";
import { useStudio } from "../studio-shell";
import { isWordDeleted } from "../transcript-selection";
import { AUTO_CENSOR_SOUNDS, AUTO_CENSOR_TEXT_STYLES, type CensorWordMarker } from "../auto-censor-review-model";
import type { TranscriptHighlight } from "../transcript-highlight";
import { textAttributes } from "./row-text-field";

// The Word view's line: every word of an utterance inline, struck when cut, masked when censored,
// lit when spoken; double-click (or Enter) corrects one word, a click seeks to it.

/** A pause between two words this long shows as a dot marker. */
export const PAUSE_THRESHOLD = 0.4;

interface DisplayToken {
  type: "word" | "pause";
  word: TranscriptWord;
  /** The word's index in its utterance. */
  wordIndex: number;
  pauseDuration?: number;
}

function buildDisplayTokens(words: TranscriptWord[]): DisplayToken[] {
  const tokens: DisplayToken[] = [];
  for (let i = 0; i < words.length; i++) {
    tokens.push({ type: "word", word: words[i]!, wordIndex: i });

    if (i < words.length - 1) {
      const gap = words[i + 1]!.startSec - words[i]!.endSec;
      if (gap >= PAUSE_THRESHOLD) {
        tokens.push({
          type: "pause",
          word: words[i]!,
          wordIndex: i,
          pauseDuration: gap,
        });
      }
    }
  }
  return tokens;
}

function joiningSpaceAfter(tokens: DisplayToken[], index: number): string {
  const current = tokens[index]!;
  if (current.type !== "word") return "";
  const next = tokens.slice(index + 1).find((token) => token.type === "word");
  return next && hasSpaceBefore(current.word.word, next.word) ? " " : "";
}

export function getWordsForUtterance(utterance: TranscriptUtterance): TranscriptWord[] {
  if (utterance.words.length > 0) return utterance.words;

  const textWords = splitSpacedTokens(utterance.text);
  const count = Math.max(1, textWords.length);
  const duration = Math.max(0.001, utterance.endSec - utterance.startSec);
  const wordDuration = duration / count;

  return textWords.map(({ word, spaceBefore }, i) => ({
    word,
    ...(spaceBefore ? { spaceBefore } : {}),
    startSec: utterance.startSec + i * wordDuration,
    endSec: utterance.startSec + (i + 1) * wordDuration,
    confidence: null,
  }));
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

// ─── Word-level Correct (Vizard-parity Phase B step 10) ────────────────────
//
// Inline single-word input — double-click a word to open it. Multi-word
// input is rejected client-side (the reducer's `updateWordText` action only
// ever touches one word and never redistributes timing; there's no batch
// text-edit path yet, so the toast below points at the caption text editor
// instead of silently truncating or erroring on the reducer side).

function WordCorrectInput({
  initialValue,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter/Escape and blur can all race to "finish" this input — this makes
  // finishing idempotent so only the FIRST one takes effect (e.g. Enter's
  // commit followed by the blur it triggers must not double-dispatch).
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = useCallback(() => {
    if (doneRef.current) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      doneRef.current = true;
      onCancel();
      return;
    }
    if (/\s/.test(trimmed)) {
      toaster.create({
        type: "error",
        title: "Enter one word",
        description: "Use the caption text editor for bigger changes.",
      });
      return; // Leave the input open so the user can fix it in place.
    }
    doneRef.current = true;
    if (trimmed === initialValue) {
      onCancel();
      return;
    }
    onCommit(trimmed);
  }, [value, initialValue, onCommit, onCancel]);

  const cancel = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  }, [onCancel]);

  return (
    <Input
      ref={inputRef}
      aria-label={`Correct word ${initialValue}`}
      value={value}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
        // Keep studio-shell's global shortcut handler (Backspace/Delete,
        // undo, etc.) from firing while typing a correction.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={commit}
      htmlSize={Math.max(2, value.length)}
      w="auto"
      minW="24px"
      h="auto"
      display="inline-block"
      verticalAlign="baseline"
      bg="studio.raised"
      color="studio.fg"
      fontSize="13.5px"
      fontFamily="inherit"
      lineHeight="inherit"
      borderRadius="3px"
      borderWidth="1px"
      borderColor="border.control"
      px="3px"
      py="0"
      outline="none"
    />
  );
}

/** "Censored · F**k · Beep": what this word does on the video. */
function censorTooltip(marker: CensorWordMarker): string {
  const style = marker.maskPolicy
    ? AUTO_CENSOR_TEXT_STYLES.find((option) => option.value === marker.maskPolicy?.replacement)?.label
    : null;
  const sound = marker.sound
    ? AUTO_CENSOR_SOUNDS.find((option) => option.value === marker.sound)?.label
    : null;
  return ["Censored", style, sound].filter(Boolean).join(" · ");
}

// ─── Editable Utterance ─────────────────────────────────────────────────────

export const EditableUtterance = memo(function EditableUtterance({
  utterance,
  utteranceIndex,
  isActive,
  activeWordIndex,
  highlight,
  censorMarkers,
  onSeek,
}: {
  utterance: TranscriptUtterance;
  utteranceIndex: number;
  isActive: boolean;
  activeWordIndex: number;
  /** The caption style's active-word look; null keeps the Studio accent. */
  highlight: TranscriptHighlight | null;
  /** Censored words by id, so they read here as they will on the video. */
  censorMarkers: ReadonlyMap<string, CensorWordMarker>;
  onSeek: (editedTime: number) => void;
}) {
  const { editedTimeMap, updateWord, deletedRanges, clipInfo, editingElsewhere } = useStudio("editedTimeMap", "updateWord", "deletedRanges", "clipInfo", "editingElsewhere");
  const [editingWordIndex, setEditingWordIndex] = useState<number | null>(null);

  // Build words (with fallback for utterances without word-level timing)
  const words: TranscriptWord[] = useMemo(() => {
    return getWordsForUtterance(utterance);
  }, [utterance]);

  // Real per-word STT timing is required for a correction to actually land
  // anywhere (the reducer indexes into `utterance.words`, which is empty for
  // the synthesized-fallback case) — so double-click is a no-op without it.
  const hasRealWordTiming = utterance.words.length > 0;

  // Build display tokens with pause indicators
  const tokens = useMemo(() => buildDisplayTokens(words), [words]);

  const startEdit = useCallback(
    (wordIndex: number) => {
      // A reader's correction would save nothing.
      if (!hasRealWordTiming || editingElsewhere) return;
      // Double-click's native "select the word" behavior would otherwise
      // leave a stale selection (and its floating toolbar) behind the
      // now-open correction input.
      window.getSelection()?.removeAllRanges();
      setEditingWordIndex(wordIndex);
    },
    [hasRealWordTiming, editingElsewhere],
  );

  const cancelEdit = useCallback(() => setEditingWordIndex(null), []);

  const commitEdit = useCallback(
    (wordIndex: number, text: string) => {
      setEditingWordIndex(null);
      updateWord(utteranceIndex, wordIndex, text);
    },
    [utteranceIndex, updateWord],
  );

  return (
    // Inset 8px from the panel edges so the active-line fill floats inside
    // the rounded panel; 8 + 12px keeps the text on the 20px column.
    <Box
      data-word-container={utteranceIndex}
      {...textAttributes(utterance.text, clipInfo.captionLanguage)}
      mx="8px"
      px="12px"
      py="4px"
      lineHeight="2"
      fontSize="14px"
      borderRadius="l2"
      bg={isActive ? "studio.accent/10" : "transparent"}
      _hover={{ bg: "rgba(255,255,255,0.04)" }}
      transition="background 150ms"
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

        const wordIdx = token.wordIndex;
        const isActiveWord = wordIdx === activeWordIndex;
        const isDeleted = isWordDeleted(token.word, deletedRanges);
        // The spoken word looks as it does in the captions; a pill grows by
        // a shadow, not padding, so the line never reflows as it moves.
        const pill = isActiveWord && !isDeleted ? (highlight?.pill ?? null) : null;
        const isEditingThisWord = editingWordIndex === wordIdx;
        const censor = hasRealWordTiming
          ? censorMarkers.get(autoCensorWordId({ utteranceIndex: utterance.index, wordIndex: wordIdx, word: token.word }))
          : undefined;
        // The transcript always shows punctuation; only the mask is the captions'.
        const shownText = censor?.maskPolicy
          ? censoredCaptionWordText(token.word.word, censor.maskPolicy, { punctuation: true })
          : token.word.word;

        return (
          <Box as="span" key={i} display="inline">
            {isEditingThisWord ? (
              <WordCorrectInput
                initialValue={token.word.word}
                onCommit={(text) => commitEdit(wordIdx, text)}
                onCancel={cancelEdit}
              />
            ) : (
              <Box
                as="span"
                role="button"
                tabIndex={isDeleted ? -1 : 0}
                display="inline"
                color={
                  isDeleted
                    ? "studio.fgSubtle"
                    : isActiveWord
                      ? (highlight?.color ?? "studio.accentFg")
                      : "studio.fg"
                }
                bg={pill ?? undefined}
                boxShadow={pill ? `0 0 0 2px ${pill}` : undefined}
                textDecoration={isDeleted ? "line-through" : censor ? "underline dotted" : "none"}
                textDecorationColor="studio.fgSubtle"
                textUnderlineOffset="3px"
                title={censor ? censorTooltip(censor) : undefined}
                opacity={isDeleted ? 0.65 : 1}
                fontWeight="inherit"
                cursor="pointer"
                borderRadius={pill ? "3px" : "2px"}
                transition="color 80ms ease-out"
                _hover={pill ? undefined : { bg: "rgba(255,255,255,0.06)" }}
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  // `sourceToEdited` already collapses an instant inside a
                  // cut forward onto the edited time of the cut point (see
                  // edit-ranges.ts) — a struck word seeks to the nearest
                  // kept time for free, no special-casing needed here.
                  onSeek(sourceToEdited(editedTimeMap, token.word.startSec));
                }}
                onDoubleClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  // Correcting text on already-deleted (struck) footage is
                  // inert and confusing — Revert first, then correct.
                  if (isDeleted) return;
                  startEdit(wordIdx);
                }}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (isDeleted) return;
                  if (e.key === "Enter" || e.key === "F2") {
                    e.preventDefault();
                    e.stopPropagation();
                    startEdit(wordIdx);
                  } else if (e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onSeek(sourceToEdited(editedTimeMap, token.word.startSec));
                  }
                }}
                aria-label={`${shownText}. ${censor ? `${censorTooltip(censor)}. ` : ""}Press Enter to correct; Space to seek.`}
              >
                {shownText}
              </Box>
            )}
            {/* The joining space comes from the next word, never suppressed
                around a pause indicator, which renders no text of its own —
                keeps this block's rendered text identical to
                `joinTranscriptWords(words)`, which the selection char-offset
                math in transcript-selection.ts assumes. */}
            {joiningSpaceAfter(tokens, i)}
          </Box>
        );
      })}
    </Box>
  );
});
