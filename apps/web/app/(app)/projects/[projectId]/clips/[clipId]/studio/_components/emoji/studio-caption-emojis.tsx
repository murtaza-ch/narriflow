"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { clipCommands, createClipsClient } from "@narriflow/api-client/clips";
import { type CaptionEmojiDensity, type EditedTimeMap, type EditorDocument } from "@narriflow/validators";
import { useStudio } from "../studio-shell";
import { apiFailureBody, requireStudioApi } from "../studio-api";
import { useStudioApi } from "../use-studio-api";
import { createCaptionEmojiLines, type CaptionEmojiLines } from "./caption-emoji-lines";
import { captionEmojiWords, heroWordKeys, typedEmojiCueRanges, type CaptionEmojiSpan, type CaptionEmojiWords } from "./caption-emoji-words";
import { ParagraphEmojiAdd, ParagraphEmojiChips, RowEmojiButtons } from "./row-emoji-buttons";
import { useCaptionEmojiEditor, type CaptionEmojiEditor, type CaptionEmojiSource } from "./use-caption-emojis";

// The Studio's wiring of the emoji controls: the editing session's document, dispatch and save, and
// the suggest route. The transcript's line chips read one panel-level editor through
// `StudioCaptionEmojiLines`; the Captions panel's section mounts from `studio-emojis-section.tsx`,
// so the section's code stays in the panel's lazy chunk. The controls themselves take plain props
// (the prototype page mounts them with local state).

/** The suggest route tags the saved document: unsaved edits are saved first, waiting at most this long. */
const SAVE_BEFORE_SUGGEST_MS = 6000;

// The word model changes only with the transcript, cuts or censor masks; one entry serves every surface.
let modelCache: { slice: unknown; censor: unknown; map: EditedTimeMap; model: CaptionEmojiWords } | null = null;

function studioEmojiWords(document: EditorDocument, editedTimeMap: EditedTimeMap): CaptionEmojiWords {
  if (modelCache?.slice !== document.transcriptSlice || modelCache.censor !== document.censorSegments || modelCache.map !== editedTimeMap) {
    modelCache = { slice: document.transcriptSlice, censor: document.censorSegments, map: editedTimeMap, model: captionEmojiWords(document, editedTimeMap) };
  }
  return modelCache.model;
}

const heroKeysByLayers = new WeakMap<readonly CompositionCaptionVisualLayer[], Set<string>>();

function heroKeysOf(layers: readonly CompositionCaptionVisualLayer[]): Set<string> {
  let keys = heroKeysByLayers.get(layers);
  if (!keys) {
    keys = heroWordKeys(layers);
    heroKeysByLayers.set(layers, keys);
  }
  return keys;
}

export function useStudioCaptionEmojiEditor(): CaptionEmojiEditor {
  const { clipInfo, captionPreset, studioEdits, editorDocument, editedTimeMap, editingElsewhere, setCaptionPreset, setCaptionEmojis, replaceCaptionEmojis, checkpointCloud } = useStudio(
    "clipInfo",
    "captionPreset",
    "studioEdits",
    "editorDocument",
    "editedTimeMap",
    "editingElsewhere",
    "setCaptionPreset",
    "setCaptionEmojis",
    "replaceCaptionEmojis",
    "checkpointCloud",
  );
  const studioApi = useStudioApi();
  // The route tags the saved document, so its Word Keys must match the words on screen: a save that
  // cannot finish in time stops the run (the section says so and offers a retry).
  const save = useCallback(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), SAVE_BEFORE_SUGGEST_MS);
    });
    try {
      return await Promise.race([checkpointCloud(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }, [checkpointCloud]);
  const suggest = useCallback(
    async (density: CaptionEmojiDensity) => {
      const api = requireStudioApi(studioApi);
      const result: { emojis: Awaited<ReturnType<typeof clipCommands.suggestEmojis>>["emojis"]; complete?: boolean } = await clipCommands.suggestEmojis(
        createClipsClient(api.runtime.transport.scoped(api.scope)),
        clipInfo.projectId,
        clipInfo.id,
        { density },
      );
      return { emojis: result.emojis, complete: result.complete !== false };
    },
    [studioApi, clipInfo.projectId, clipInfo.id],
  );
  const source: CaptionEmojiSource = {
    clipId: clipInfo.id,
    preset: captionPreset,
    entries: studioEdits.captionEmojis,
    model: studioEmojiWords(editorDocument, editedTimeMap),
    readOnly: editingElsewhere,
    updatePreset: (patch) => setCaptionPreset((previous) => ({ ...previous, ...patch })),
    setEmojis: setCaptionEmojis,
    replaceEmojis: replaceCaptionEmojis,
    save,
    suggest,
    failureCode: (error) => apiFailureBody(error).error ?? null,
  };
  return useCaptionEmojiEditor(source);
}

const typedCuesByLayers = new WeakMap<readonly CompositionCaptionVisualLayer[], ReturnType<typeof typedEmojiCueRanges>>();

const LinesContext = createContext<CaptionEmojiLines | null>(null);

/**
 * Mount once around the transcript rows: one editor resolves the emoji anchors per document change
 * and publishes to the rows, each of which re-renders only when its own chips change.
 */
export function StudioCaptionEmojiLines({ children }: { children: ReactNode }) {
  const editor = useStudioCaptionEmojiEditor();
  const { playbackClock, captionLayers, compositeToBaseEdited, baseEditedToComposite, seekTo } = useStudio(
    "playbackClock",
    "captionLayers",
    "compositeToBaseEdited",
    "baseEditedToComposite",
    "seekTo",
  );
  const [store] = useState(createCaptionEmojiLines);
  const addContext = useCallback(
    () => ({ playheadSec: compositeToBaseEdited(playbackClock.getSnapshot()), heroKeys: heroKeysOf(captionLayers) }),
    [compositeToBaseEdited, playbackClock, captionLayers],
  );
  const seek = useCallback((editedSec: number) => seekTo(baseEditedToComposite(editedSec)), [seekTo, baseEditedToComposite]);
  const typedEmojiCues = useMemo(() => {
    let ranges = typedCuesByLayers.get(captionLayers);
    if (!ranges) {
      ranges = typedEmojiCueRanges(captionLayers, compositeToBaseEdited);
      typedCuesByLayers.set(captionLayers, ranges);
    }
    return ranges;
  }, [captionLayers, compositeToBaseEdited]);
  // Rows rendered in this pass read the new state; rows that did not re-render hear of it before paint.
  store.set({ editor, addContext, seek, typedEmojiCues });
  useLayoutEffect(() => store.notify());
  return <LinesContext.Provider value={store}>{children}</LinesContext.Provider>;
}

/** A paragraph's emoji chips (each names its word), or its add button at the right edge. */
export function StudioParagraphEmojis({ spans, direction, part }: { spans: readonly CaptionEmojiSpan[]; direction: "ltr" | "rtl"; part: "chips" | "add" }) {
  const store = useContext(LinesContext);
  if (!store) return null;
  return part === "chips" ? <ParagraphEmojiChips store={store} spans={spans} direction={direction} /> : <ParagraphEmojiAdd store={store} spans={spans} direction={direction} />;
}

/** A caption row's emoji buttons at its right edge. */
export function StudioRowEmojiButtons({ spans, direction }: { spans: readonly CaptionEmojiSpan[]; direction: "ltr" | "rtl" }) {
  const store = useContext(LinesContext);
  if (!store) return null;
  return <RowEmojiButtons store={store} spans={spans} direction={direction} />;
}
