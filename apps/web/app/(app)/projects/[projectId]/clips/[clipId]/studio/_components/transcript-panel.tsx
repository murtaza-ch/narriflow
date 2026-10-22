"use client";

import { memo, useRef, useEffect, useCallback, useLayoutEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Box, Button, Flex, Input, Text, Textarea, Checkbox } from "@chakra-ui/react";
import { Combine, Copy, Plus, PanelsTopLeft, Scissors, ShieldCheck, Trash2, Undo2 } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import { editedToSource, sourceToEdited, userErrorMessage } from "@narriflow/validators";
import type {
  ClipSnapshot,
  EditedTimeMap,
  SourceRange,
  TranscriptUtterance,
  TranscriptWord,
} from "@narriflow/validators";
import { useStudio } from "./studio-shell";
import type { PlaybackClock } from "./playback-clock";
import {
  collectSelectedWords,
  computeRevertCoveringRange,
  isWordDeleted,
  selectedWordsToSourceRange,
  type SelectableWord,
  type SelectionEndpoint,
  type UtteranceWordSource,
} from "./transcript-selection";
import { subtitleParagraphGroups } from "./subtitle-lines";
import { sceneTextContent } from "./scene-fonts";
import { AutoCensorReviewDrawer } from "./auto-censor-review-drawer";

// ─── Pause threshold (seconds) ──────────────────────────────────────────────

const PAUSE_THRESHOLD = 0.4;

// ─── Selection toolbar layout (Phase B closing review finding 9a) ──────────
//
// SelectionToolbar floats ABOVE the selection via `transform: translate(-50%,
// calc(-100% - 8px))` — its own height plus an 8px gap. A selection on (or
// near) the scrollable transcript's first line puts `top` close to 0, and
// the toolbar's rendered top then lands ABOVE the scroll container's own
// content start, where `overflowY: auto` clips it — the toolbar is either
// invisible or cut off. `SELECTION_TOOLBAR_CLEARANCE_PX` is the toolbar's own
// 40px height (32px button row + 4px padding top/bottom) plus its 8px
// floating gap, rounded up — `top` is floored at the container's current
// scroll position plus this clearance so the toolbar always has room to
// render above its anchor without leaving the visible scrolled area. The
// toolbar is ~300px wide, so it fits the transcript panel's 320px minimum.
const SELECTION_TOOLBAR_CLEARANCE_PX = 52;
const SELECTION_TOOLBAR_HALF_WIDTH_PX = 154;

type TranscriptViewMode = "word" | "sentence" | "paragraph";

// ─── API error copy (Create clip, Phase B step 14) ─────────────────────────

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Prefers our own mapped copy for a known error code, then the API's
 *  message, then the caller's fallback — same precedence as
 *  clip-actions-menu.tsx's `apiErrorCopy`. */
function apiErrorCopy(payload: unknown, fallback: string): string {
  return (
    userErrorMessage(readPayloadString(payload, "error")) ??
    readPayloadString(payload, "message") ??
    fallback
  );
}

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

// ─── Selection → word mapping (DOM glue around transcript-selection.ts) ────
//
// Each per-utterance word container carries `data-word-container` (see
// EditableUtterance below), scoping a `Range`-based char-offset lookup to
// exactly that utterance's own rendered word text — which is kept
// byte-for-byte equal to `words.map(w => w.word).join(" ")` by always
// emitting a joining space after every word token (pause indicators render
// no text of their own), so the char offsets computed here line up exactly
// with `wordCharRanges` in transcript-selection.ts.

function resolveSelectionEndpoint(node: Node | null, offset: number): SelectionEndpoint | null {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const container = el?.closest<HTMLElement>("[data-word-container]");
  if (!container) return null;
  const utteranceIndex = Number(container.getAttribute("data-word-container"));
  if (Number.isNaN(utteranceIndex)) return null;
  const preRange = document.createRange();
  preRange.selectNodeContents(container);
  preRange.setEnd(node, offset);
  return { utteranceIndex, charOffset: preRange.toString().length };
}

interface TranscriptSelectionState {
  words: SelectableWord[];
  /** Non-null iff every selected word is already inside a deleted range —
   *  the toolbar collapses to a single Revert in that case (see
   *  transcript-selection.ts's `computeRevertCoveringRange`). */
  revertRange: SourceRange | null;
  /** Position within the scroll container's own content box (accounts for
   *  scrollTop, so the toolbar naturally scrolls with the selection). */
  top: number;
  left: number;
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
  const { editedTimeMap, updateWord, deletedRanges } = useStudio("editedTimeMap", "updateWord", "deletedRanges");
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
      if (!hasRealWordTiming) return;
      // Double-click's native "select the word" behavior would otherwise
      // leave a stale selection (and its floating toolbar) behind the
      // now-open correction input.
      window.getSelection()?.removeAllRanges();
      setEditingWordIndex(wordIndex);
    },
    [hasRealWordTiming],
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

        const wordIdx = words.indexOf(token.word);
        const isActiveWord = wordIdx === activeWordIndex;
        const isDeleted = isWordDeleted(token.word, deletedRanges);
        const isEditingThisWord = editingWordIndex === wordIdx;

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
                      ? "studio.accentFg"
                      : "studio.fg"
                }
                textDecoration={isDeleted ? "line-through" : "none"}
                opacity={isDeleted ? 0.65 : 1}
                fontWeight="inherit"
                cursor="pointer"
                borderRadius="2px"
                transition="color 80ms ease-out"
                _hover={{ bg: "rgba(255,255,255,0.06)" }}
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
                aria-label={`${token.word.word}. Press Enter to correct; Space to seek.`}
              >
                {token.word.word}
              </Box>
            )}
            {/* Always a single joining space after every word (never
                suppressed around a pause indicator, which renders no text
                of its own) — keeps this block's rendered text identical to
                `words.map(w => w.word).join(" ")`, which the selection char-
                offset math in transcript-selection.ts assumes. */}
            {i < tokens.length - 1 ? " " : ""}
          </Box>
        );
      })}
    </Box>
  );
});

function ViewModeButton({
  mode,
  current,
  onSelect,
}: {
  mode: TranscriptViewMode;
  current: TranscriptViewMode;
  onSelect: (mode: TranscriptViewMode) => void;
}) {
  const label = mode === "word" ? "Word" : mode === "sentence" ? "Sentence" : "Paragraph";
  const selected = mode === current;
  return (
    <Box
      as="button"
      position="relative"
      h="26px"
      bg="transparent"
      color={selected ? "studio.fg" : "studio.fgSubtle"}
      fontSize="13px"
      fontWeight={selected ? "600" : "500"}
      aria-pressed={selected}
      onClick={() => onSelect(mode)}
      transition="color 120ms ease"
      _hover={{ color: "studio.fg" }}
    >
      {label}
      {/* Underline marks the active view — no box around it */}
      {selected ? (
        <Box
          position="absolute"
          left="0"
          right="0"
          bottom="-1px"
          h="2px"
          borderRadius="full"
          bg="studio.accent"
        />
      ) : null}
    </Box>
  );
}

/** Grows a textarea to fit its text, so subtitle text is never cut off —
 *  re-measured when the text changes and when the column's width does. */
function useAutoHeight(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text is the trigger — re-measure whenever it changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) fitHeight(el);
  }, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitHeight(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return ref;
}

function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** Inline, boxless editing: the text reads like the transcript until focused. */
const inlineEditorProps = {
  mx: "-10px",
  px: "10px",
  py: "6px",
  w: "calc(100% + 20px)",
  minH: "0",
  bg: "transparent",
  borderWidth: "0",
  borderRadius: "10px",
  color: "studio.fg",
  fontSize: "14px",
  lineHeight: "1.7",
  resize: "none",
  overflow: "hidden",
  transition: "background 120ms ease",
  _hover: { bg: "studio.subtle" },
  // A subtle grey edge marks the focused line for keyboard users.
  _focusVisible: { bg: "studio.subtle", outline: "none", boxShadow: "inset 0 0 0 1px var(--chakra-colors-studio-border-focus)" },
} as const;

function LineAction({
  label,
  children,
  onClick,
  disabled = false,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Flex
      as="button"
      align="center"
      justify="center"
      w="28px"
      h="28px"
      borderRadius="8px"
      color="studio.fgSubtle"
      bg="transparent"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : undefined}
      opacity={disabled ? 0.3 : 1}
      cursor={disabled ? "not-allowed" : "pointer"}
      aria-label={label}
      title={label}
      onClick={disabled ? undefined : onClick}
      _hover={disabled ? undefined : { bg: "studio.raised", color: "studio.fg" }}
    >
      {children}
    </Flex>
  );
}

const SubtitleLineEditor = memo(function SubtitleLineEditor({
  utterance,
  index,
  isLast,
}: {
  utterance: TranscriptUtterance;
  index: number;
  isLast: boolean;
}) {
  const {
    updateUtteranceText,
    addSubtitleLineAfter,
    deleteSubtitleLine,
    mergeSubtitleLineWithNext,
    seekTo,
    editedTimeMap,
  } = useStudio("updateUtteranceText", "addSubtitleLineAfter", "deleteSubtitleLine", "mergeSubtitleLineWithNext", "seekTo", "editedTimeMap");
  const [draft, setDraft] = useState(utterance.text);
  useEffect(() => setDraft(utterance.text), [utterance.text]);
  const editedStartSec = sourceToEdited(editedTimeMap, utterance.startSec);
  const editedEndSec = sourceToEdited(editedTimeMap, utterance.endSec);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(utterance.text);
      return;
    }
    updateUtteranceText(index, trimmed);
  }, [draft, index, updateUtteranceText, utterance.text]);

  const textRef = useAutoHeight(draft);

  return (
    <Box
      px="20px"
      py="10px"
      css={{
        "& [data-line-actions]": { opacity: 0, transition: "opacity 120ms ease" },
        "&:hover [data-line-actions], &:focus-within [data-line-actions]": { opacity: 1 },
      }}
    >
      <Flex align="center" justify="space-between" gap="2" minH="28px">
        <Flex align="center" gap="8px" minW="0">
          <Text fontSize="12px" fontWeight="500" color="studio.fgSubtle">
            {utterance.speakerLabel}
          </Text>
          <Text textStyle="data" fontSize="11px" color="studio.timecode">
            {Math.max(0, editedStartSec).toFixed(2)}–{Math.max(0, editedEndSec).toFixed(2)}
          </Text>
        </Flex>
        <Flex data-line-actions align="center" gap="1px">
          <LineAction label="Add subtitle line after" onClick={() => addSubtitleLineAfter(index)}>
            <Plus size={15} />
          </LineAction>
          <LineAction
            label="Merge with next subtitle line"
            onClick={() => mergeSubtitleLineWithNext(index)}
            disabled={isLast}
          >
            <Combine size={15} />
          </LineAction>
          <LineAction label="Delete subtitle line only" onClick={() => deleteSubtitleLine(index)}>
            <Trash2 size={15} />
          </LineAction>
        </Flex>
      </Flex>
      <Textarea
        ref={textRef}
        rows={1}
        value={draft}
        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value.replace(/\n/g, " "))}
        onFocus={() => seekTo(sourceToEdited(editedTimeMap, utterance.startSec))}
        onBlur={commit}
        onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setDraft(utterance.text);
            event.currentTarget.blur();
          }
        }}
        aria-label={`Subtitle line ${index + 1}`}
        {...inlineEditorProps}
      />
    </Box>
  );
});

const SubtitleParagraphEditor = memo(function SubtitleParagraphEditor({
  speakerLabel,
  indices,
  utterances,
}: {
  speakerLabel: string;
  indices: number[];
  utterances: TranscriptUtterance[];
}) {
  const { updateParagraphText } = useStudio("updateParagraphText");
  const sourceText = indices.map((index) => utterances[index]?.text ?? "").join(" ").trim();
  const [draft, setDraft] = useState(sourceText);
  useEffect(() => setDraft(sourceText), [sourceText]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(sourceText);
      return;
    }
    updateParagraphText(indices, trimmed);
  }, [draft, indices, sourceText, updateParagraphText]);

  const textRef = useAutoHeight(draft);
  const [editing, setEditing] = useState(false);

  return (
    <Box px="20px" py="10px">
      <Text fontSize="12px" fontWeight="500" color="studio.fgSubtle" mb="2px">
        {speakerLabel}
      </Text>
      <Textarea
        ref={textRef}
        rows={2}
        value={draft}
        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false);
          commit();
        }}
        onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            setDraft(sourceText);
            event.currentTarget.blur();
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
        }}
        aria-label={`${speakerLabel} paragraph subtitles`}
        {...inlineEditorProps}
        lineHeight="2"
      />
      {editing ? (
        <Text mt="6px" fontSize="12px" color="studio.fgSubtle">
          ⌘ Enter saves · timing stays attached to the original lines
        </Text>
      ) : null}
    </Box>
  );
});

// ─── Selection toolbar (Vizard-parity Phase B step 11) ─────────────────────

function ToolbarBtn({
  icon,
  label,
  iconOnly = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  /** Universal actions (delete, copy) show the icon alone, named by tooltip. */
  iconOnly?: boolean;
  onClick: () => void;
}) {
  return (
    <Flex
      as="button"
      align="center"
      justify="center"
      gap="6px"
      minW="32px"
      px={iconOnly ? "0" : "10px"}
      h="32px"
      borderRadius="8px"
      bg="transparent"
      border="none"
      color="studio.fg"
      cursor="pointer"
      fontSize="13px"
      fontWeight="500"
      whiteSpace="nowrap"
      title={iconOnly ? label : undefined}
      aria-label={iconOnly ? label : undefined}
      // Pressing a toolbar button would otherwise collapse the text
      // selection (the browser's default mousedown-outside-selection
      // behavior) BEFORE the click handler ever runs, wiping the very
      // selection the button is meant to act on.
      onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
      onClick={onClick}
      _hover={{ bg: "studio.borderStrong" }}
      transition="background 120ms ease"
    >
      {icon}
      {iconOnly ? null : label}
    </Flex>
  );
}

function SelectionToolbar({
  top,
  left,
  isDeletedSelection,
  creatingClip,
  onDelete,
  onRevert,
  onCopy,
  onCreateClip,
  onInsertScene,
  canInsertScene,
}: {
  top: number;
  left: number;
  isDeletedSelection: boolean;
  creatingClip: boolean;
  onDelete: () => void;
  onRevert: () => void;
  onCopy: () => void;
  onCreateClip: () => void;
  onInsertScene: () => void;
  canInsertScene: boolean;
}) {
  return (
    <Flex
      bg="studio.raised"
      borderRadius="10px"
      boxShadow="0 8px 24px rgba(0, 0, 0, 0.45)"
      position="absolute"
      style={{
        top: `${top}px`,
        left: `${left}px`,
        transform: "translate(-50%, calc(-100% - 8px))",
      }}
      align="center"
      gap="2px"
      p="4px"
      zIndex={20}
      onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
    >
      {isDeletedSelection ? (
        <ToolbarBtn icon={<Undo2 size={15} />} label="Revert" onClick={onRevert} />
      ) : (
        <>
          <ToolbarBtn icon={<Trash2 size={16} />} label="Delete" iconOnly onClick={onDelete} />
          <ToolbarBtn icon={<Copy size={15} />} label="Copy" iconOnly onClick={onCopy} />
          {canInsertScene && <ToolbarBtn icon={<PanelsTopLeft size={15} />} label="Insert scene" onClick={onInsertScene} />}
          <ToolbarBtn
            icon={<Scissors size={15} />}
            label={creatingClip ? "Creating…" : "Create clip"}
            onClick={onCreateClip}
          />
        </>
      )}
    </Flex>
  );
}

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
    deletedRanges,
    deleteSourceRange,
    revertDeletedRange,
    clipInfo,
    setTranscriptSelectionRange,
    insertSceneBlock,
    baseEditedToComposite,
    sceneWriteCapabilities,
    sceneFonts,
  } = useStudio("utterances", "transcriptOnly", "setTranscriptOnly", "seekTo", "clipStartSec", "editedTimeMap", "playbackClock", "deletedRanges", "deleteSourceRange", "revertDeletedRange", "clipInfo", "setTranscriptSelectionRange", "insertSceneBlock", "baseEditedToComposite", "sceneWriteCapabilities", "sceneFonts");
  const router = useRouter();

  const scrollRef = useRef<HTMLDivElement>(null);
  const manualScrollRef = useRef(false);
  const manualScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeState, setActiveState] = useState(() =>
    getActiveTranscriptState(playbackClock, utterances, editedTimeMap),
  );
  const [selection, setSelection] = useState<TranscriptSelectionState | null>(null);
  const [viewMode, setViewMode] = useState<TranscriptViewMode>("word");
  const [creatingClip, setCreatingClip] = useState(false);
  const [autoCensorOpen, setAutoCensorOpen] = useState(false);
  // Synchronous re-entrancy guard for handleCreateClip: both the toolbar
  // button and the ⇧⌘C shortcut call it, and `creatingClip` state alone
  // can't prevent a second dispatch landing before the first re-render.
  const creatingClipRef = useRef(false);
  // Mirrors `selection` for the capture-phase keydown handler and the
  // delete/revert/copy callbacks below, so they always read the latest
  // value without re-subscribing their effects on every selection change.
  const selectionRef = useRef<TranscriptSelectionState | null>(null);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

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

  // ─── Selection tracking (Vizard-parity Phase B step 11) ─────────────────

  const utteranceWordSources: UtteranceWordSource[] = useMemo(
    () => utterances.map((u, i) => ({ utteranceIndex: i, words: getWordsForUtterance(u) })),
    [utterances],
  );
  const paragraphGroups = useMemo(() => subtitleParagraphGroups(utterances), [utterances]);

  const handleSelectionChange = useCallback(() => {
    const sel = window.getSelection();
    const container = scrollRef.current;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !container) {
      setSelection(null);
      setTranscriptSelectionRange(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setSelection(null);
      setTranscriptSelectionRange(null);
      return;
    }
    const anchor = resolveSelectionEndpoint(sel.anchorNode, sel.anchorOffset);
    const focus = resolveSelectionEndpoint(sel.focusNode, sel.focusOffset);
    if (!anchor || !focus) {
      setSelection(null);
      setTranscriptSelectionRange(null);
      return;
    }
    const words = collectSelectedWords(utteranceWordSources, anchor, focus);
    if (words.length === 0) {
      setSelection(null);
      setTranscriptSelectionRange(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const rawTop = rect.top - containerRect.top + container.scrollTop;
    const sourceRange = selectedWordsToSourceRange(words);
    setTranscriptSelectionRange(sourceRange);
    setSelection({
      words,
      revertRange: computeRevertCoveringRange(words, deletedRanges),
      // Finding 9a: clamp so a first-line (or near-top) selection's toolbar
      // still has room to float above it without clipping against the
      // scroll container's own top edge — see the constant's doc comment.
      top: Math.max(rawTop, container.scrollTop + SELECTION_TOOLBAR_CLEARANCE_PX),
      left: Math.max(
        SELECTION_TOOLBAR_HALF_WIDTH_PX,
        Math.min(
          container.clientWidth - SELECTION_TOOLBAR_HALF_WIDTH_PX,
          rect.left - containerRect.left + rect.width / 2,
        ),
      ),
    });
  }, [utteranceWordSources, deletedRanges, setTranscriptSelectionRange]);

  useEffect(() => {
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [handleSelectionChange]);

  // Finding 9b (Phase B closing review): the toolbar's Delete-vs-Revert mode
  // (`selection.revertRange !== null`) was only ever computed inside
  // `handleSelectionChange`, i.e. on the next DOM `selectionchange` event —
  // but `deletedRanges` can change with the DOM selection staying exactly
  // where it was (⌘Z restoring a delete, or Remove-silence/Revert dispatched
  // from elsewhere while this same range stays selected), leaving the
  // toolbar showing the stale mode for a selection that's already flipped
  // deleted/kept underneath it. Recompute against the CURRENT selection's
  // words whenever `deletedRanges` itself changes, independent of any new
  // selection event.
  useEffect(() => {
    setSelection((prev) => {
      if (!prev) return prev;
      const revertRange = computeRevertCoveringRange(prev.words, deletedRanges);
      const sameRange =
        revertRange === prev.revertRange ||
        (revertRange !== null &&
          prev.revertRange !== null &&
          revertRange.startSec === prev.revertRange.startSec &&
          revertRange.endSec === prev.revertRange.endSec);
      return sameRange ? prev : { ...prev, revertRange };
    });
  }, [deletedRanges]);

  // Click-away dismissal for cases a plain `selectionchange` doesn't cover
  // (e.g. clicking a non-text, non-focusable element elsewhere in the
  // studio that doesn't itself collapse the DOM selection).
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const container = scrollRef.current;
      if (!container || container.contains(e.target as Node)) return;
      setSelection(null);
      setTranscriptSelectionRange(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [setTranscriptSelectionRange]);

  const dismissSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    setTranscriptSelectionRange(null);
  }, [setTranscriptSelectionRange]);

  useEffect(
    () => () => {
      setTranscriptSelectionRange(null);
    },
    [setTranscriptSelectionRange],
  );

  const handleViewModeChange = useCallback(
    (mode: TranscriptViewMode) => {
      dismissSelection();
      setViewMode(mode);
    },
    [dismissSelection],
  );

  const handleDeleteSelection = useCallback(() => {
    const current = selectionRef.current;
    if (!current) return;
    const range = selectedWordsToSourceRange(current.words);
    if (!range) return;
    if (deleteSourceRange(range)) {
      dismissSelection();
    }
  }, [deleteSourceRange, dismissSelection]);

  const handleRevertSelection = useCallback(() => {
    const current = selectionRef.current;
    if (!current?.revertRange) return;
    revertDeletedRange(current.revertRange);
    dismissSelection();
  }, [revertDeletedRange, dismissSelection]);

  const handleCopySelection = useCallback(() => {
    const current = selectionRef.current;
    if (!current) return;
    const text = current.words
      .map(
        (w) =>
          utteranceWordSources.find((u) => u.utteranceIndex === w.utteranceIndex)?.words[
            w.wordIndex
          ]?.word,
      )
      .filter((w): w is string => Boolean(w))
      .join(" ");
    if (text && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }, [utteranceWordSources]);

  const handleInsertScene = useCallback(() => {
    const current = selectionRef.current;
    if (!current || !sceneWriteCapabilities.cards) return;
    const range = selectedWordsToSourceRange(current.words);
    if (!range) return;
    const anchorSec = baseEditedToComposite(sourceToEdited(editedTimeMap, range.startSec));
    insertSceneBlock({
      id: crypto.randomUUID(),
      schemaVersion: 1,
      anchorSec,
      durationSec: 3,
      content: sceneTextContent("New chapter", sceneFonts),
      motion: { entrance: "fade", exit: "fade", durationSec: 0.5 },
      templateSnapshot: null,
    });
    dismissSelection();
  }, [baseEditedToComposite, dismissSelection, editedTimeMap, insertSceneBlock, sceneFonts, sceneWriteCapabilities.cards]);

  // ─── Create clip from selection (Vizard-parity Phase B step 14) ─────────
  //
  // A NEW, from-scratch clip carved out of the current selection's absolute
  // source range — the atomic server op in clip.service.ts, deliberately NOT
  // duplicate-then-retrim (see ClipService.createClipFromSelection's doc
  // comment). No optimistic UI: the clip list isn't refetched or patched
  // locally here — the success toast's "Open" action is the only way to see
  // it immediately, exactly like the studio's own render/export flows.

  const handleCreateClip = useCallback(async () => {
    const current = selectionRef.current;
    // Same guard as the toolbar's own branching: a selection sitting
    // entirely inside deleted ranges only offers Revert, never Create clip.
    if (!current || current.revertRange !== null) return;
    const range = selectedWordsToSourceRange(current.words);
    if (!range) return;
    if (creatingClipRef.current) return;

    creatingClipRef.current = true;
    setCreatingClip(true);
    try {
      const response = await fetch(
        `/api/projects/${clipInfo.projectId}/clips/${clipInfo.id}/create-from-selection`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startSec: range.startSec, endSec: range.endSec }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        toaster.create({
          type: "error",
          title: "Could not create clip",
          description: apiErrorCopy(payload, "Please try again."),
        });
        return;
      }

      const newClip = payload as ClipSnapshot;
      dismissSelection();
      toaster.create({
        type: "success",
        title: "Clip created",
        description: "A new clip was carved out of your selection.",
        action: {
          label: "Open",
          onClick: () => {
            router.push(`/projects/${clipInfo.projectId}/clips/${newClip.id}/studio`);
          },
        },
      });
    } catch {
      toaster.create({
        type: "error",
        title: "Could not create clip",
        description: "Please try again.",
      });
    } finally {
      creatingClipRef.current = false;
      setCreatingClip(false);
    }
  }, [clipInfo.projectId, clipInfo.id, dismissSelection, router]);

  // ⌫ deletes the transcript selection, and ⇧⌘C (⇧Ctrl+C on Windows/Linux)
  // creates a clip from it, ONLY when a selection is active — otherwise
  // studio-shell's own global handler (timeline segment delete; no 'c'/'C'
  // case exists there) must keep running unobstructed. Registered on
  // `window` in the CAPTURE phase so it runs before that bubble-phase
  // listener (a text selection's target is typically document.body, not any
  // node inside this panel, so a listener attached to a descendant DOM node
  // here would never see the event at all — this has to live at the window
  // level).
  useEffect(() => {
    const onKeyDownCapture = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return; // word-correct input etc.
      const current = selectionRef.current;
      if (!current || current.words.length === 0) return;

      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        e.stopPropagation();
        handleDeleteSelection();
        return;
      }

      if (
        (e.key === "c" || e.key === "C") &&
        e.shiftKey &&
        (e.metaKey || e.ctrlKey) &&
        current.revertRange === null
      ) {
        e.preventDefault();
        e.stopPropagation();
        void handleCreateClip();
      }
    };
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, [handleDeleteSelection, handleCreateClip]);

  return (
    <Box
      w="clamp(320px, 26vw, 480px)"
      flexShrink={0}
      h="100%"
      bg="studio.canvas"
      borderRadius="12px"
      display={{ base: "none", lg: "flex" }}
      flexDirection="column"
      overflow="hidden"
    >
      {/* Header */}
      <Flex
        px="20px"
        pt="10px"
        pb="8px"
        direction="column"
        align="stretch"
        flexShrink={0}
        gap="10px"
      >
        <Flex align="center" justify="space-between" columnGap="3" rowGap="1" wrap="wrap">
          <Checkbox.Root
            checked={transcriptOnly}
            onCheckedChange={(e) => setTranscriptOnly(!!e.checked)}
            size="sm"
            colorPalette="accent"
            gap="6px"
            cursor="pointer"
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label>
              <Text fontSize="14px" color="studio.fgMuted">Transcript only</Text>
            </Checkbox.Label>
          </Checkbox.Root>
          <Flex role="group" aria-label="Transcript editing view" gap="4">
            <ViewModeButton mode="word" current={viewMode} onSelect={handleViewModeChange} />
            <ViewModeButton mode="sentence" current={viewMode} onSelect={handleViewModeChange} />
            <ViewModeButton mode="paragraph" current={viewMode} onSelect={handleViewModeChange} />
          </Flex>
        </Flex>
        <Button
          size="sm"
          variant="ghost"
          color="studio.fg"
          alignSelf="flex-start"
          px="2"
          ms="-2"
          _hover={{ bg: "studio.subtle" }}
          onClick={() => setAutoCensorOpen(true)}
        >
          <ShieldCheck size={15} /> Find sensitive words
        </Button>
      </Flex>

      {/* Scrollable transcript body */}
      <Box
        ref={scrollRef}
        flex="1"
        overflowY="auto"
        overflowX="hidden"
        position="relative"
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
        {viewMode === "sentence" &&
          utterances.map((utterance, index) => (
            <SubtitleLineEditor
              key={`line-${utterance.index}-${utterance.startSec}`}
              utterance={utterance}
              index={index}
              isLast={index === utterances.length - 1}
            />
          ))}

        {viewMode === "paragraph" &&
          paragraphGroups.map((group, index) => (
            <SubtitleParagraphEditor
              key={`${group.speakerLabel}-${group.lineIndices[0] ?? index}`}
              speakerLabel={group.speakerLabel}
              indices={group.lineIndices}
              utterances={utterances}
            />
          ))}

        {viewMode === "word" && utterances.map((utterance, i) => {
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
                fontSize="12px"
                fontWeight="500"
                color="studio.fgSubtle"
                px="20px"
                pt={i === 0 ? "4px" : "14px"}
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

        {viewMode === "word" && selection && (
          <SelectionToolbar
            top={selection.top}
            left={selection.left}
            isDeletedSelection={selection.revertRange !== null}
            creatingClip={creatingClip}
            onDelete={handleDeleteSelection}
            onRevert={handleRevertSelection}
            onCopy={handleCopySelection}
            onCreateClip={handleCreateClip}
            onInsertScene={handleInsertScene}
            canInsertScene={sceneWriteCapabilities.cards}
          />
        )}
      </Box>
      {autoCensorOpen && (
        <AutoCensorReviewDrawer onClose={() => setAutoCensorOpen(false)} />
      )}
    </Box>
  );
}
