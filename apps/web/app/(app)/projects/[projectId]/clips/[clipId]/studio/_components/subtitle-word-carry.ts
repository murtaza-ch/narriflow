import {
  autoCensorWordId,
  type CensorSegment,
  type EditorAction,
  type EditorDocument,
  type StudioEdits,
  type TranscriptUtterance,
  type TranscriptWord,
} from "@narriflow/validators";

// What a transcript edit must carry for the words it did not touch. Censor Segments name words by
// `autoCensorWordId`, which includes the word's utterance and word positions, so removing, adding or
// splitting words renames every later word; emojis, emphasis and merged captions name words by
// Word Key, which a re-timed word changes. Subtitle edits keep untouched words as the same objects,
// which is how a word is recognised here.

function wordIds(lines: readonly TranscriptUtterance[]): Map<TranscriptWord, string> {
  const ids = new Map<TranscriptWord, string>();
  for (const utterance of lines) {
    utterance.words.forEach((word, wordIndex) => {
      ids.set(word, autoCensorWordId({ utteranceIndex: utterance.index, wordIndex, word }));
    });
  }
  return ids;
}

/**
 * Censor Segments renamed for words that moved. A word the edit rewrote or removed keeps its old id,
 * which no longer names a word: its mark goes, as a rewritten word's does. The same array when no
 * id changed.
 */
export function carryCensorWordIds(
  before: readonly TranscriptUtterance[],
  after: readonly TranscriptUtterance[],
  segments: readonly CensorSegment[],
): readonly CensorSegment[] {
  if (segments.length === 0 || before === after) return segments;
  const next = wordIds(after);
  const renamed = new Map<string, string>();
  for (const [word, id] of wordIds(before)) {
    const moved = next.get(word);
    if (moved !== undefined && moved !== id) renamed.set(id, moved);
  }
  if (renamed.size === 0) return segments;
  let changed = false;
  const carried = segments.map((segment) => {
    if (!segment.sourceWordIds.some((id) => renamed.has(id))) return segment;
    changed = true;
    return { ...segment, sourceWordIds: segment.sourceWordIds.map((id) => renamed.get(id) ?? id) };
  });
  return changed ? carried : segments;
}

function moveKeys<T>(record: Readonly<Record<string, T>> | undefined, moved: ReadonlyMap<string, string>): Record<string, T> | undefined {
  if (!record || !Object.keys(record).some((key) => moved.has(key))) return undefined;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!moved.has(key)) next[key] = value;
  }
  for (const [from, to] of moved) {
    const value = record[from];
    if (value !== undefined && next[to] === undefined) next[to] = value;
  }
  return next;
}

/** Merged captions whose first or last word moved, renamed on both ends. */
function moveMerges(merges: Readonly<Record<string, string>> | undefined, moved: ReadonlyMap<string, string>): Record<string, string> | undefined {
  if (!merges || !Object.entries(merges).some(([first, last]) => moved.has(first) || moved.has(last))) return undefined;
  return Object.fromEntries(Object.entries(merges).map(([first, last]) => [moved.get(first) ?? first, moved.get(last) ?? last]));
}

/** Emojis, emphasis overrides and merged captions moved to their words' new Word Keys. The same object when none moved. */
export function moveWordKeyedEdits(edits: StudioEdits, moved: ReadonlyMap<string, string>): StudioEdits {
  if (moved.size === 0) return edits;
  const captionEmojis = moveKeys(edits.captionEmojis, moved);
  const captionEmphasis = moveKeys(edits.captionEmphasis, moved);
  const captionMerges = moveMerges(edits.captionMerges, moved);
  if (!captionEmojis && !captionEmphasis && !captionMerges) return edits;
  return {
    ...edits,
    ...(captionEmojis ? { captionEmojis } : {}),
    ...(captionEmphasis ? { captionEmphasis } : {}),
    ...(captionMerges ? { captionMerges } : {}),
  };
}

export type TranscriptEditAction = Extract<EditorAction, { type: "setTranscriptSlice" | "setCensorSegments" | "setStudioEdits" }>;

/**
 * The document actions of one transcript edit: the new slice, then the censor marks and Word-Keyed
 * edits that follow its untouched and re-timed words. `studioEdits` is the edit's own change to
 * them, if any (a merge). Dispatched under one coalesce key, they are one undo step. Empty when
 * nothing changed.
 */
export function transcriptEditActions(
  before: Pick<EditorDocument, "transcriptSlice" | "censorSegments" | "studioEdits">,
  transcriptSlice: TranscriptUtterance[],
  movedKeys: ReadonlyMap<string, string>,
  edited: StudioEdits = before.studioEdits,
): TranscriptEditAction[] {
  const actions: TranscriptEditAction[] = [];
  if (transcriptSlice !== before.transcriptSlice) {
    actions.push({ type: "setTranscriptSlice", transcriptSlice });
    const segments = carryCensorWordIds(before.transcriptSlice, transcriptSlice, before.censorSegments);
    if (segments !== before.censorSegments) actions.push({ type: "setCensorSegments", segments: [...segments] });
  }
  const studioEdits = moveWordKeyedEdits(edited, movedKeys);
  if (studioEdits !== before.studioEdits) actions.push({ type: "setStudioEdits", studioEdits });
  return actions;
}
