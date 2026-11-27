import { useSyncExternalStore } from "react";
import {
  CAPTION_EMOJI_LIMIT,
  DEFAULT_CAPTION_EMOJI_DENSITY,
  resolveCaptionEmojiAnchors,
  type CaptionEmojiDensity,
  type CaptionEmojiRef,
} from "@narriflow/validators";
import { captionEmojiWordShows, placeCaptionEmojis, type CaptionEmojiWords } from "./caption-emoji-words";

// Per-clip state of the emoji AI run, outside React. A run outlives the panel that started it, so it
// never reads through the editor that started it: every mounted emoji editor of a clip registers a
// live source here (its current emojis, words and dispatcher), and the answer is merged against
// whichever of them is mounted when it arrives. With none mounted for the clip, the answer is dropped.

type Emojis = Readonly<Record<string, CaptionEmojiRef>>;

export type CaptionEmojiRunFailure =
  /** The unsaved edits could not be saved, so the model was not called (it tags the saved document). */
  | { readonly reason: "save" }
  /** The suggest request failed; the route's typed error code, or null without one (offline). */
  | { readonly reason: "request"; readonly code: string | null }
  /** Another tab took the write lease while the request was out. */
  | { readonly reason: "read_only" }
  /** Part of the transcript could not be tagged and the clip had emojis: they are left as they were. */
  | { readonly reason: "incomplete" }
  /** No editor for the clip was open when the answer arrived (the clip was closed or switched). */
  | { readonly reason: "closed" };

export type CaptionEmojiRun =
  | { readonly status: "idle" }
  | { readonly status: "saving"; readonly density: CaptionEmojiDensity }
  | { readonly status: "running"; readonly density: CaptionEmojiDensity }
  /** `added` picks were committed; `leftOut` did not fit under the cap; `partial` when part of the transcript went untagged. */
  | { readonly status: "done"; readonly added: number; readonly leftOut: number; readonly partial: boolean }
  | { readonly status: "failed"; readonly failure: CaptionEmojiRunFailure };

export type CaptionEmojiRunEvent =
  | { readonly type: "start"; readonly density: CaptionEmojiDensity }
  | { readonly type: "saved" }
  | { readonly type: "done"; readonly added: number; readonly leftOut: number; readonly partial: boolean }
  | { readonly type: "failed"; readonly failure: CaptionEmojiRunFailure }
  | { readonly type: "dismiss" };

export function captionEmojiRunBusy(run: CaptionEmojiRun): boolean {
  return run.status === "saving" || run.status === "running";
}

/** The run's transitions. Applying the answer is one synchronous dispatch, so it is part of `done`, not a state. */
export function captionEmojiRunTransition(run: CaptionEmojiRun, event: CaptionEmojiRunEvent): CaptionEmojiRun {
  switch (event.type) {
    case "start":
      return captionEmojiRunBusy(run) ? run : { status: "saving", density: event.density };
    case "saved":
      return run.status === "saving" ? { status: "running", density: run.density } : run;
    case "done":
      return run.status === "running" ? { status: "done", added: event.added, leftOut: event.leftOut, partial: event.partial } : run;
    case "failed":
      return captionEmojiRunBusy(run) ? { status: "failed", failure: event.failure } : run;
    case "dismiss":
      return captionEmojiRunBusy(run) ? run : { status: "idle" };
  }
}

// ─── Pure steps ────────────────────────────────────────────────────────────

/** Word Keys more than one word of the model starts at (overlapping speakers, a line added at the same time). */
function sharedKeys(model: CaptionEmojiWords): Set<string> {
  const shared = new Set<string>();
  model.words.forEach((word, index) => {
    if (model.byKey.get(word.key) !== index) shared.add(word.key);
  });
  return shared;
}

/**
 * What was tagged: the Word Key and text of every word that showed when the request went out. A key
 * two words share is left out: the answer's pick on it could mean either word.
 */
export function captionEmojiFingerprint(model: CaptionEmojiWords): ReadonlyMap<string, string> {
  const fingerprint = new Map<string, string>();
  const shared = sharedKeys(model);
  for (const [key, index] of model.byKey) {
    const word = model.words[index]!;
    if (!shared.has(key) && captionEmojiWordShows(word)) fingerprint.set(key, word.text);
  }
  return fingerprint;
}

/** The route's answer. `complete` is false when part of the transcript could not be tagged; absent means complete. */
export interface CaptionEmojiAnswer {
  readonly emojis: Emojis;
  readonly complete?: boolean;
}

export type CaptionEmojiAnswerPlan =
  /** The answer changes nothing (no pick still fits the clip): the emojis stay as they are. */
  | { readonly kind: "empty" }
  /** Part of the clip went untagged and replacing would lose emojis the clip has. */
  | { readonly kind: "incomplete" }
  | {
      readonly kind: "replace";
      /** Every emoji after the run, at most the cap. */
      readonly value: Record<string, CaptionEmojiRef>;
      /** The AI picks inside `value`. */
      readonly picks: Record<string, CaptionEmojiRef>;
      readonly leftOut: number;
      readonly partial: boolean;
    };

const sameRef = (left: CaptionEmojiRef | undefined, right: CaptionEmojiRef | undefined) => left?.id === right?.id && left?.tone === right?.tone && left?.word === right?.word;

/**
 * Merges an answer into the emojis as they are now. A pick is the model's for one word: it survives
 * only when the word with exactly its key still shows, is the only word at that key, and has the
 * text it had when tagged. No nearest-time resolution: a deleted or re-timed word drops its pick
 * instead of handing it to a neighbour.
 *
 * Entries added, changed or removed while the request was out keep the user's version, and a pick
 * never lands on a word one of the kept entries is on. Regenerate (`replace`, the default) drops
 * every other entry; Add with AI keeps every entry. The result is trimmed to the cap: kept entries
 * first, then the earliest picks. An incomplete answer never replaces existing emojis.
 */
export function planCaptionEmojiAnswer(input: {
  readonly start: Emojis | undefined;
  readonly current: Emojis | undefined;
  readonly answer: CaptionEmojiAnswer;
  readonly fingerprint: ReadonlyMap<string, string>;
  readonly model: CaptionEmojiWords;
  /** Regenerate replaces the emojis; Add with AI (false) only adds to them. */
  readonly replace?: boolean;
  readonly limit?: number;
}): CaptionEmojiAnswerPlan {
  const { start, current, answer, fingerprint, model } = input;
  const replace = input.replace ?? true;
  const limit = input.limit ?? CAPTION_EMOJI_LIMIT;
  const partial = answer.complete === false;
  const hadEmojis = Object.keys(start ?? {}).length > 0 || Object.keys(current ?? {}).length > 0;
  if (partial && replace && hadEmojis) return { kind: "incomplete" };

  const shared = sharedKeys(model);
  const fresh = Object.keys(answer.emojis).flatMap((key) => {
    const index = model.byKey.get(key);
    if (index === undefined || shared.has(key)) return [];
    const word = model.words[index]!;
    return captionEmojiWordShows(word) && fingerprint.get(key) === word.text ? [{ key, word: index }] : [];
  });
  if (fresh.length === 0) return partial ? { kind: "incomplete" } : { kind: "empty" };

  const touched = new Set<string>();
  const value: Record<string, CaptionEmojiRef> = {};
  for (const key of new Set([...Object.keys(start ?? {}), ...Object.keys(current ?? {})])) {
    if (sameRef(start?.[key], current?.[key])) continue;
    touched.add(key);
    if (current?.[key]) value[key] = current[key]!;
  }
  if (!replace) for (const [key, ref] of Object.entries(current ?? {})) value[key] ??= ref;
  // The words the kept entries draw on, by the plan's anchor rule.
  const owned = new Set(resolveCaptionEmojiAnchors(value, model.anchors).values());
  const picks: Record<string, CaptionEmojiRef> = {};
  let room = limit - Object.keys(value).length;
  let leftOut = 0;
  const free = fresh.filter((pick) => !touched.has(pick.key) && !owned.has(pick.word)).map((pick) => pick.key);
  for (const key of free.sort((left, right) => Number(left) - Number(right))) {
    if (room <= 0) {
      leftOut += 1;
      continue;
    }
    value[key] = answer.emojis[key]!;
    picks[key] = answer.emojis[key]!;
    room -= 1;
  }
  return { kind: "replace", value, picks, leftOut, partial };
}

/** What was committed: the picks the document holds after the write. */
function committedPicks(picks: Emojis, committed: Emojis | undefined): Record<string, CaptionEmojiRef> {
  return Object.fromEntries(Object.entries(picks).filter(([key, ref]) => committed?.[key] !== undefined && sameRef(ref, committed[key])));
}

export function countCommittedPicks(picks: Emojis, committed: Emojis | undefined): number {
  return Object.keys(committedPicks(picks, committed)).length;
}

export function sameCaptionEmojis(left: Emojis | undefined, right: Emojis | undefined): boolean {
  const leftKeys = Object.keys(left ?? {});
  if (leftKeys.length !== Object.keys(right ?? {}).length) return false;
  return leftKeys.every((key) => right?.[key] !== undefined && sameRef(left![key], right[key]));
}

// ─── Per-clip store ────────────────────────────────────────────────────────

/** A mounted editor's view of the clip, read when the run needs it. */
export interface CaptionEmojiLiveSource {
  readonly entries: Emojis | undefined;
  readonly model: CaptionEmojiWords;
  readonly readOnly: boolean;
  /** Replaces every emoji in one undo step; returns the emojis the document holds afterwards. */
  readonly replace: (value: Record<string, CaptionEmojiRef>) => Emojis | undefined;
}

export interface CaptionEmojiSession {
  readonly run: CaptionEmojiRun;
  readonly density: CaptionEmojiDensity;
}

interface ClipState {
  session: CaptionEmojiSession;
  /** The AI picks the last run in this session committed; never a hand edit, kept or not. */
  baseline: Emojis | undefined;
  readonly sources: Map<object, () => CaptionEmojiLiveSource>;
  readonly listeners: Set<() => void>;
}

const IDLE: CaptionEmojiSession = { run: { status: "idle" }, density: DEFAULT_CAPTION_EMOJI_DENSITY };
const clips = new Map<string, ClipState>();

function clip(clipId: string): ClipState {
  let state = clips.get(clipId);
  if (!state) {
    state = { session: IDLE, baseline: undefined, sources: new Map(), listeners: new Set() };
    clips.set(clipId, state);
  }
  return state;
}

function update(clipId: string, patch: Partial<CaptionEmojiSession>): void {
  const state = clip(clipId);
  state.session = { ...state.session, ...patch };
  for (const listener of [...state.listeners]) listener();
}

function dispatch(clipId: string, event: CaptionEmojiRunEvent): void {
  const run = clip(clipId).session.run;
  const next = captionEmojiRunTransition(run, event);
  if (next !== run) update(clipId, { run: next });
}

/** Every mounted emoji editor registers while mounted; the run reads and writes through the latest one. */
export function registerCaptionEmojiSource(clipId: string, read: () => CaptionEmojiLiveSource): () => void {
  const token = {};
  clip(clipId).sources.set(token, read);
  return () => {
    clip(clipId).sources.delete(token);
  };
}

function liveSource(clipId: string): CaptionEmojiLiveSource | null {
  const read = [...clip(clipId).sources.values()].at(-1);
  return read ? read() : null;
}

export function captionEmojiSession(clipId: string): CaptionEmojiSession {
  return clip(clipId).session;
}

export function useCaptionEmojiSession(clipId: string): CaptionEmojiSession {
  const state = clip(clipId);
  return useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    () => state.session,
    () => state.session,
  );
}

export function setCaptionEmojiDensity(clipId: string, density: CaptionEmojiDensity): void {
  update(clipId, { density });
}

/** Clears a finished run's message. A run in progress is left alone. */
export function dismissCaptionEmojiRun(clipId: string): void {
  dispatch(clipId, { type: "dismiss" });
}

/**
 * Regenerate asks first when the clip has emojis this session's AI did not produce as they are now:
 * placed or changed by hand, or from before a reload (their provenance is unknown).
 */
export function captionEmojisNeedConfirm(clipId: string, current: Emojis | undefined): boolean {
  return Object.keys(current ?? {}).length > 0 && !sameCaptionEmojis(clip(clipId).baseline, current);
}

/** The longest an AI run waits for its answer's art before committing without it, ms. */
export const CAPTION_EMOJI_ART_WAIT_MS = 6000;

export interface CaptionEmojiRunRequest {
  /** Saves pending edits; false when the save could not finish (the route tags the saved document). */
  readonly save: () => Promise<boolean>;
  readonly suggest: (density: CaptionEmojiDensity) => Promise<CaptionEmojiAnswer>;
  /** The typed error code of a failed request, or null when it had none (offline, aborted). */
  readonly failureCode: (error: unknown) => string | null;
  /** Loads the art of these emoji ids (`preloadCaptionEmojiArt`), so the answer shows drawn, never as empty boxes. */
  readonly loadArt: (ids: readonly string[]) => Promise<void>;
}

/**
 * One AI run: save, ask, load the answer's art, merge against the live source, replace every emoji in
 * one undo step. A failed art load still commits (the edit must not be lost); its glyphs draw once
 * their art arrives. A start while one runs is ignored.
 */
export async function runCaptionEmojiSuggestion(clipId: string, density: CaptionEmojiDensity, request: CaptionEmojiRunRequest): Promise<void> {
  const state = clip(clipId);
  if (captionEmojiRunBusy(state.session.run)) return;
  const first = liveSource(clipId);
  if (!first || first.readOnly) return;
  // The button the user pressed: Regenerate while emojis show, else Add with AI (which keeps hidden ones).
  const replace = placeCaptionEmojis(first.entries, first.model).shown > 0;
  update(clipId, { density });
  dispatch(clipId, { type: "start", density });

  const saved = await request.save().catch(() => false);
  if (!saved) return dispatch(clipId, { type: "failed", failure: { reason: "save" } });
  const tagged = liveSource(clipId);
  if (!tagged) return dispatch(clipId, { type: "failed", failure: { reason: "closed" } });
  // Taken after the save: the route tags exactly what was saved.
  const start = tagged.entries;
  const fingerprint = captionEmojiFingerprint(tagged.model);
  dispatch(clipId, { type: "saved" });

  let answer: CaptionEmojiAnswer;
  try {
    answer = await request.suggest(density);
  } catch (error) {
    return dispatch(clipId, { type: "failed", failure: { reason: "request", code: request.failureCode(error) } });
  }
  let waited: ReturnType<typeof setTimeout> | undefined;
  try {
    // A stalled shard must not hold the run: after CAPTION_EMOJI_ART_WAIT_MS it commits anyway.
    await Promise.race([
      request.loadArt([...new Set(Object.values(answer.emojis).map((ref) => ref.id))]),
      new Promise<void>((resolve) => {
        waited = setTimeout(resolve, CAPTION_EMOJI_ART_WAIT_MS);
      }),
    ]);
  } catch {
    // Committed without art: each glyph keeps its empty box until its shard loads.
  } finally {
    clearTimeout(waited);
  }

  const now = liveSource(clipId);
  if (!now) return dispatch(clipId, { type: "failed", failure: { reason: "closed" } });
  if (now.readOnly) return dispatch(clipId, { type: "failed", failure: { reason: "read_only" } });
  const plan = planCaptionEmojiAnswer({ start, current: now.entries, answer, fingerprint, model: now.model, replace });
  if (plan.kind === "incomplete") return dispatch(clipId, { type: "failed", failure: { reason: "incomplete" } });
  if (plan.kind === "empty") return dispatch(clipId, { type: "done", added: 0, leftOut: 0, partial: false });
  const committed = committedPicks(plan.picks, now.replace(plan.value));
  state.baseline = committed;
  dispatch(clipId, { type: "done", added: Object.keys(committed).length, leftOut: plan.leftOut, partial: plan.partial });
}

/** Test seam: forget every clip's state. */
export function resetCaptionEmojiSessions(): void {
  clips.clear();
}
