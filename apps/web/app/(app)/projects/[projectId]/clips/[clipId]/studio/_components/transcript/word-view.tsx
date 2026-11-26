"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { toaster } from "@narriflow/ui/components/toaster";
import { editedToSource, joinTranscriptWords, sourceToEdited, userErrorMessage } from "@narriflow/validators";
import type { ClipSnapshot, EditedTimeMap, SourceRange, TranscriptUtterance } from "@narriflow/validators";
import { ApiError } from "@narriflow/api-client/core";
import { invalidateAfterClipChange } from "@narriflow/api-client/clips";
import { useUpgrade } from "@/app/(app)/_components/upgrade";
import { useStudio } from "../studio-shell";
import {
  collectSelectedWords,
  computeRevertCoveringRange,
  selectedWordsToSourceRange,
  type SelectableWord,
  type SelectionEndpoint,
  type UtteranceWordSource,
} from "../transcript-selection";
import { sceneTextContent } from "../scene-fonts";
import { censorMarkersByWordId } from "../auto-censor-review-model";
import { transcriptHighlight } from "../transcript-highlight";
import { apiFailureBody, createClipFromStudioSelection, requireStudioApi, type StudioSelectionClipInput } from "../studio-api";
import { useStudioApi } from "../use-studio-api";
import { SelectionToolbar } from "./selection-toolbar";
import { activeRowAt, useFollowActiveRow } from "./use-active-row";
import { EditableUtterance, getWordsForUtterance, PAUSE_THRESHOLD } from "./word-utterance";

// The Word view: the transcript as running text. Select words to cut, restore, copy, insert a
// scene or create a clip; ⌫ and ⇧⌘C act on the selection.

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

// ─── Selection → word mapping (DOM glue around transcript-selection.ts) ────
//
// Each per-utterance word container carries `data-word-container` (see
// EditableUtterance below), scoping a `Range`-based char-offset lookup to
// exactly that utterance's own rendered word text — which is kept
// byte-for-byte equal to `joinTranscriptWords(words)` by always
// emitting the joining space (none between Chinese/Japanese characters) after every word token (pause indicators render
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

/** The utterance and word under the playhead (composite seconds), found by binary search. */
function activeWordAt(
  playheadSec: number,
  utterances: readonly TranscriptUtterance[],
  wordSources: readonly UtteranceWordSource[],
  editedTimeMap: EditedTimeMap,
  compositeToBaseEdited: (sec: number) => number,
) {
  // Utterances and their words keep SOURCE seconds.
  const sourceSec = editedToSource(editedTimeMap, compositeToBaseEdited(playheadSec));
  const utteranceIndex = activeRowAt(utterances, sourceSec);
  if (utteranceIndex === -1) return { utteranceIndex: -1, wordIndex: -1 };
  const words = wordSources[utteranceIndex]!.words;
  return { utteranceIndex, wordIndex: activeRowAt(words, sourceSec) };
}

export function WordView({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const {
    utterances,
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
    compositeToBaseEdited,
    sceneWriteCapabilities,
    sceneFonts,
    upgradePrompts,
    captionPreset,
    editorDocument,
    leaveStudio,
  } = useStudio("utterances", "seekTo", "clipStartSec", "editedTimeMap", "playbackClock", "deletedRanges", "deleteSourceRange", "revertDeletedRange", "clipInfo", "setTranscriptSelectionRange", "insertSceneBlock", "baseEditedToComposite", "compositeToBaseEdited", "sceneWriteCapabilities", "sceneFonts", "upgradePrompts", "captionPreset", "editorDocument", "leaveStudio");
  // The spoken word follows the clip's caption style, so it reads like the captions on the video.
  const highlight = useMemo(() => transcriptHighlight(captionPreset), [captionPreset]);
  const { openUpgrade } = useUpgrade();
  const studioApi = useStudioApi();
  const studioRuntime = studioApi?.runtime;
  // One intent for "Create clip": pressing it again over the same selection after a lost response reuses its key.
  const selectionClipIntent = useMemo(
    () => studioRuntime?.createIntent<StudioSelectionClipInput>() ?? null,
    [studioRuntime],
  );
  const [selection, setSelection] = useState<TranscriptSelectionState | null>(null);
  const [creatingClip, setCreatingClip] = useState(false);
  const censorMarkers = useMemo(
    () => censorMarkersByWordId(editorDocument.censorSegments),
    [editorDocument.censorSegments],
  );
  // A word seeks on the composite clock: source seconds to base edited, then past inserted scenes.
  const seekToSource = useCallback(
    (editedSec: number) => seekTo(baseEditedToComposite(editedSec)),
    [seekTo, baseEditedToComposite],
  );
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

  const utteranceWordSources: UtteranceWordSource[] = useMemo(
    () => utterances.map((u, i) => ({ utteranceIndex: i, words: getWordsForUtterance(u) })),
    [utterances],
  );
  const [activeState, setActiveState] = useState(() =>
    activeWordAt(playbackClock.getSnapshot(), utterances, utteranceWordSources, editedTimeMap, compositeToBaseEdited),
  );
  useEffect(() => {
    const update = () => {
      const next = activeWordAt(playbackClock.getSnapshot(), utterances, utteranceWordSources, editedTimeMap, compositeToBaseEdited);
      setActiveState((prev) =>
        prev.utteranceIndex === next.utteranceIndex && prev.wordIndex === next.wordIndex ? prev : next,
      );
    };
    update();
    return playbackClock.subscribe(update);
  }, [editedTimeMap, playbackClock, utterances, utteranceWordSources, compositeToBaseEdited]);
  useFollowActiveRow(scrollRef, activeState.utteranceIndex < 0 ? null : String(activeState.utteranceIndex));

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
  }, [scrollRef, utteranceWordSources, deletedRanges, setTranscriptSelectionRange]);

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
  }, [scrollRef, setTranscriptSelectionRange]);

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
    const text = joinTranscriptWords(
      current.words.flatMap((w) => {
        const word = utteranceWordSources.find((u) => u.utteranceIndex === w.utteranceIndex)?.words[
          w.wordIndex
        ];
        return word?.word ? [word] : [];
      }),
    );
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
      const api = requireStudioApi(studioApi);
      if (!selectionClipIntent) throw new Error("Select a Workspace to continue.");
      let payload: unknown;
      try {
        payload = await createClipFromStudioSelection(api, selectionClipIntent, {
          projectId: clipInfo.projectId,
          clipId: clipInfo.id,
          startSec: range.startSec,
          endSec: range.endSec,
        });
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status === 0) throw failure;
        toaster.create({
          type: "error",
          title: "Could not create clip",
          description: apiErrorCopy(apiFailureBody(failure), "Please try again."),
        });
        return;
      }
      void invalidateAfterClipChange(api.runtime.queryClient, api.scope, clipInfo.projectId);

      const newClip = payload as ClipSnapshot;
      dismissSelection();
      toaster.create({
        type: "success",
        title: "Clip created",
        description: "A new clip was carved out of your selection.",
        action: {
          label: "Open",
          onClick: () => {
            leaveStudio(`/projects/${clipInfo.projectId}/clips/${newClip.id}/studio`);
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
  }, [clipInfo.projectId, clipInfo.id, dismissSelection, leaveStudio, studioApi, selectionClipIntent]);

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
    <Box>
      {utterances.map((utterance, i) => {
        const isActive = activeState.utteranceIndex === i;
        const pauseAfter = utterancePauses.get(i);
        return (
          <Box
            key={`u-${utterance.index ?? i}`}
            data-timestamp={utterance.startSec - clipStartSec}
            data-utterance-index={i}
            data-row-key={i}
            pt={i === 0 ? "4px" : "6px"}
          >
            <EditableUtterance
              utterance={utterance}
              utteranceIndex={i}
              isActive={isActive}
              activeWordIndex={isActive ? activeState.wordIndex : -1}
              highlight={highlight}
              censorMarkers={censorMarkers}
              onSeek={seekToSource}
            />
            {/* Pause between utterances */}
            {pauseAfter !== undefined && (
              <Flex px="16px" py="4px" align="center" gap="6px">
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
      {selection && (
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
          insertSceneLock={upgradePrompts.scenes}
          onUpgrade={(prompt) => {
            dismissSelection();
            openUpgrade(prompt);
          }}
        />
      )}
    </Box>
  );
}
