import { captionEmojiTarget, captionEmojiWordShows, type CaptionEmojiPlacement, type CaptionEmojiTarget, type CaptionEmojiWords } from "./caption-emoji-words";

// The Emojis panel's "In this clip" list: every emoji the video draws, in time order. An emoji on a
// cut or censored word draws nothing, so it is left out, as the panel's count leaves it out.

export interface CaptionEmojiListRow {
  /** What change and remove act on; `current` is always set. */
  readonly target: CaptionEmojiTarget & { readonly current: NonNullable<CaptionEmojiTarget["current"]> };
  /** Base edited seconds of the word the emoji sits on. */
  readonly startSec: number;
  readonly endSec: number;
}

/** The clip's shown emojis, earliest word first. */
export function captionEmojiListRows(model: CaptionEmojiWords, placement: CaptionEmojiPlacement): CaptionEmojiListRow[] {
  const rows: CaptionEmojiListRow[] = [];
  for (const word of placement.byWord.keys()) {
    const shown = model.words[word];
    if (!shown || !captionEmojiWordShows(shown)) continue;
    const target = captionEmojiTarget(model, placement, word);
    if (!target.current) continue;
    const startSec = shown.editedStartSec!;
    rows.push({ target: { ...target, current: target.current }, startSec, endSec: shown.editedEndSec ?? startSec });
  }
  return rows.sort((left, right) => left.startSec - right.startSec || left.target.word - right.target.word);
}

/**
 * A seek lands on the word's start after a round trip through composite time, which can come back a
 * hair early; this much slack keeps the row just clicked current.
 */
const START_SLACK_SEC = 0.001;

/** The row whose word the playhead (base edited seconds) is on, or -1. */
export function currentCaptionEmojiRow(rows: readonly CaptionEmojiListRow[], playheadSec: number): number {
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    const row = rows[at]!;
    if (row.startSec - START_SLACK_SEC <= playheadSec) return playheadSec < Math.max(row.endSec, row.startSec + START_SLACK_SEC) ? at : -1;
  }
  return -1;
}
