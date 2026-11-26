"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  captionEmojiDrawnTone,
  captionEmojiRefOnWord,
  captionEmojiTemplateColours,
  resolveCaptionEmojiPalette,
  type CaptionEmojiDensity,
  type CaptionEmojiRef,
  type CaptionPreset,
} from "@narriflow/validators";
import {
  captionEmojisNeedConfirm,
  dismissCaptionEmojiRun,
  registerCaptionEmojiSource,
  runCaptionEmojiSuggestion,
  setCaptionEmojiDensity,
  useCaptionEmojiSession,
  type CaptionEmojiAnswer,
  type CaptionEmojiRun,
} from "./caption-emoji-runs";
import { placeCaptionEmojis, type CaptionEmojiPlacement, type CaptionEmojiTarget, type CaptionEmojiWords } from "./caption-emoji-words";
import type { CaptionEmojiLook } from "./emoji-glyph";

type Emojis = Readonly<Record<string, CaptionEmojiRef>>;

/** What the emoji controls read and write; the Studio wires it to its editing session, the tests to local state. */
export interface CaptionEmojiSource {
  readonly clipId: string;
  readonly preset: CaptionPreset;
  /** `studioEdits.captionEmojis`. */
  readonly entries: Emojis | undefined;
  readonly model: CaptionEmojiWords;
  /** Another tab holds the write lease. */
  readonly readOnly: boolean;
  /** Writes preset fields through the caption preset path (undo, autosave, Apply to all, brand templates). */
  readonly updatePreset: (patch: Partial<CaptionPreset>) => void;
  /** `setCaptionEmojis`: one undo step; a null entry removes that emoji. */
  readonly setEmojis: (entries: Record<string, CaptionEmojiRef | null>) => void;
  /** `replaceCaptionEmojis`: one undo step; returns the emojis the document holds afterwards. */
  readonly replaceEmojis: (value: Record<string, CaptionEmojiRef>) => Emojis | undefined;
  /** Saves pending edits before an AI run; false when the save could not finish. */
  readonly save: () => Promise<boolean>;
  /** AI emojis by Word Key for the clip as saved; rejects with the route's typed error. */
  readonly suggest: (density: CaptionEmojiDensity) => Promise<CaptionEmojiAnswer>;
  readonly failureCode: (error: unknown) => string | null;
}

export interface CaptionEmojiEditor {
  readonly enabled: boolean;
  /** The clip's emoji palette with its Skin tone, for every chip and the picker. */
  readonly palette: CaptionEmojiLook;
  readonly model: CaptionEmojiWords;
  readonly placement: CaptionEmojiPlacement;
  readonly readOnly: boolean;
  readonly run: CaptionEmojiRun;
  readonly density: CaptionEmojiDensity;
  /** Regenerate asks first: the clip has emojis this session's AI run did not produce as they are. */
  readonly confirmRegenerate: boolean;
  readonly preset: CaptionPreset;
  readonly setEnabled: (on: boolean) => void;
  readonly setDensity: (density: CaptionEmojiDensity) => void;
  readonly updatePreset: (patch: Partial<CaptionPreset>) => void;
  /** A hand edit of one word: a ref places or replaces its emoji, null removes it. */
  readonly place: (target: CaptionEmojiTarget, ref: CaptionEmojiRef | null) => void;
  /** Moves a target's emoji to another word, in one undo step. */
  readonly move: (target: CaptionEmojiTarget, word: number) => void;
  readonly removeAll: () => void;
  /** Starts an AI run (replaces every emoji in one undo step when it answers). */
  readonly generate: (density: CaptionEmojiDensity) => void;
  readonly dismissRun: () => void;
}

/** The one hook the Emojis section, the word chips and the transcript chips share. */
export function useCaptionEmojiEditor(source: CaptionEmojiSource): CaptionEmojiEditor {
  const latest = useRef(source);
  latest.current = source;
  const { clipId, preset, entries, model, readOnly } = source;
  // The AI run reads and writes through whichever editor of the clip is mounted when it answers.
  useEffect(
    () =>
      registerCaptionEmojiSource(clipId, () => ({
        entries: latest.current.entries,
        model: latest.current.model,
        readOnly: latest.current.readOnly,
        replace: latest.current.replaceEmojis,
      })),
    [clipId],
  );
  const session = useCaptionEmojiSession(clipId);
  const placement = useMemo(() => placeCaptionEmojis(entries, model), [entries, model]);
  // The look is a function of these preset fields only: a font-size drag keeps the same object.
  const { emojiPalette, emojiTone, scene, dynamic, primaryColor, highlightColor, accentColor, shadowColor } = preset;
  const palette = useMemo(
    () => ({
      ...resolveCaptionEmojiPalette({ emojiPalette }, captionEmojiTemplateColours({ scene, dynamic, primaryColor, highlightColor, accentColor, shadowColor })),
      tone: captionEmojiDrawnTone({}, { emojiTone }),
    }),
    [emojiPalette, emojiTone, scene, dynamic, primaryColor, highlightColor, accentColor, shadowColor],
  );

  const place = useCallback((target: CaptionEmojiTarget, ref: CaptionEmojiRef | null) => {
    const current = latest.current;
    if (current.readOnly) return;
    current.setEmojis({ [target.key]: ref && captionEmojiRefOnWord(ref, target.text) });
  }, []);

  const move = useCallback((target: CaptionEmojiTarget, word: number) => {
    const current = latest.current;
    const to = current.model.words[word];
    if (current.readOnly || !target.current || to === undefined || to.key === target.key) return;
    current.setEmojis({ [target.key]: null, [to.key]: captionEmojiRefOnWord(target.current, to.text) });
  }, []);

  const removeAll = useCallback(() => {
    const current = latest.current;
    if (current.readOnly) return;
    current.replaceEmojis({});
    dismissCaptionEmojiRun(current.clipId);
  }, []);

  const generate = useCallback((density: CaptionEmojiDensity) => {
    const current = latest.current;
    if (current.readOnly) return;
    void runCaptionEmojiSuggestion(current.clipId, density, { save: current.save, suggest: current.suggest, failureCode: current.failureCode });
  }, []);

  const dismissRun = useCallback(() => dismissCaptionEmojiRun(clipId), [clipId]);

  return {
    enabled: preset.emojis === true,
    palette,
    model,
    placement,
    readOnly,
    run: session.run,
    density: session.density,
    confirmRegenerate: captionEmojisNeedConfirm(clipId, entries),
    preset,
    setEnabled: (on) => latest.current.updatePreset({ emojis: on }),
    setDensity: (density) => setCaptionEmojiDensity(clipId, density),
    updatePreset: (patch) => latest.current.updatePreset(patch),
    place,
    move,
    removeAll,
    generate,
    dismissRun,
  };
}
