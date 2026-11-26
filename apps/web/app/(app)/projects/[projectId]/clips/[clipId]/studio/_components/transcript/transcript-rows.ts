import { deriveCaptionLines } from "@narriflow/composition-plan";
import { joinTranscriptWords, type EditorDocument } from "@narriflow/validators";
import { captionEmojiSpanKey, type CaptionEmojiSpan } from "../emoji/caption-emoji-words";
import { captionRowAddress, subtitleParagraphGroups, type CaptionRowAddress } from "../subtitle-lines";

// The Sentence and Paragraph views' rows, derived from the document. A caption row is one cue on the
// video (`deriveCaptionLines`), so the list regroups with the caption style as the video does.

export interface CaptionRowModel {
  /**
   * Stable while the caption keeps its first word (React key, scroll target, active row): an edit
   * that adds or removes a caption leaves the other rows' identity, so they do not re-render.
   */
  readonly id: string;
  readonly address: CaptionRowAddress;
  /** The next caption on the video, for "Merge with next"; null on the last row. */
  readonly next: CaptionRowAddress | null;
  /** The next caption can join this one (both timed, or both untimed). */
  readonly mergeable: boolean;
  /** The row's transcript words as typed (punctuation kept, no censor mask or case transform). */
  readonly text: string;
  /** Composition seconds, as on the video. */
  readonly startSec: number;
  readonly endSec: number;
  /** The words whose emojis the row owns: from its first word to the next caption's first word. */
  readonly spans: readonly CaptionEmojiSpan[];
}

export interface ParagraphRowModel {
  readonly id: string;
  /** Slice positions of the paragraph's utterances. */
  readonly lines: readonly number[];
  readonly text: string;
  /** Composition seconds of its first caption; the paragraph lasts until the next one starts. */
  readonly startSec: number;
  readonly endSec: number;
  readonly spans: readonly CaptionEmojiSpan[];
}

type RowsDocument = EditorDocument;

const sameAddress = (left: CaptionRowAddress | null, right: CaptionRowAddress | null) =>
  left === right || (left !== null && right !== null && left.utterance === right.utterance && left.keys.join(",") === right.keys.join(","));

function sameRow(left: CaptionRowModel, right: CaptionRowModel): boolean {
  return (
    left.id === right.id &&
    left.text === right.text &&
    left.startSec === right.startSec &&
    left.endSec === right.endSec &&
    left.mergeable === right.mergeable &&
    sameAddress(left.address, right.address) &&
    sameAddress(left.next, right.next) &&
    captionEmojiSpanKey(left.spans) === captionEmojiSpanKey(right.spans)
  );
}

/**
 * One row per caption on the video. A row equal to the previous list's row with the same id is
 * that same object, so an edit re-renders only the rows it changed.
 */
export function captionRows(document: RowsDocument, language: string | null, previous: readonly CaptionRowModel[] = []): CaptionRowModel[] {
  const lines = deriveCaptionLines(document, { language });
  const slice = document.transcriptSlice;
  const addresses = lines.map((line) => captionRowAddress(slice, { utterance: line.utterance, words: line.words }));
  const before = new Map(previous.map((row) => [row.id, row]));
  const seen = new Set<string>();
  return lines.map((line, index) => {
    const utterance = slice[line.utterance]!;
    const next = lines[index + 1];
    const first = lines[index - 1]?.utterance !== line.utterance;
    const spans: CaptionEmojiSpan[] = line.words.length === 0
      ? [line.utterance]
      : [{
          line: line.utterance,
          from: first ? 0 : line.words[0]!,
          to: next?.utterance === line.utterance && next.words.length > 0 ? next.words[0]! : utterance.words.length,
        }];
    const address = addresses[index]!;
    // Word Keys are unique within a clip; an untimed caption is named by its utterance.
    let id = address.keys[0] ?? `u${line.utterance}`;
    while (seen.has(id)) id += "'";
    seen.add(id);
    const row: CaptionRowModel = {
      id,
      address,
      next: addresses[index + 1] ?? null,
      mergeable: next !== undefined && (next.words.length === 0) === (line.words.length === 0),
      text: line.words.length === 0 ? utterance.text : joinTranscriptWords(line.words.map((at) => utterance.words[at]!)),
      startSec: line.startSec,
      endSec: line.endSec,
      spans,
    };
    const kept = before.get(id);
    return kept && sameRow(kept, row) ? kept : row;
  });
}

/** Paragraphs of whole utterances (`subtitleParagraphGroups`), timed by their captions on the video. */
export function paragraphRows(
  document: RowsDocument,
  captions: readonly CaptionRowModel[],
  totalSec: number,
  previous: readonly ParagraphRowModel[] = [],
): ParagraphRowModel[] {
  const slice = document.transcriptSlice;
  const startOf = new Map<number, number>();
  for (const row of captions) {
    for (const span of row.spans) {
      const line = typeof span === "number" ? span : span.line;
      if (!startOf.has(line)) startOf.set(line, row.startSec);
    }
  }
  const groups = subtitleParagraphGroups(slice).flatMap((lines) => {
    const startSec = lines.map((line) => startOf.get(line)).find((sec) => sec !== undefined);
    return startSec === undefined ? [] : [{ lines, startSec }];
  });
  return groups.map((group, index) => {
    const row: ParagraphRowModel = {
      id: `p${index}`,
      lines: group.lines,
      text: joinTranscriptWords(group.lines.map((line) => ({ word: slice[line]!.text }))),
      startSec: group.startSec,
      endSec: groups[index + 1]?.startSec ?? totalSec,
      spans: group.lines,
    };
    const before = previous[index];
    return before &&
      before.text === row.text &&
      before.startSec === row.startSec &&
      before.endSec === row.endSec &&
      before.lines.join(",") === row.lines.join(",")
      ? before
      : row;
  });
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/** `mm:ss.cc`, as Vizard's subtitle list shows a caption's times. */
export function formatCaptionTime(sec: number): string {
  const hundredths = Math.max(0, Math.round(sec * 100));
  return `${pad(Math.floor(hundredths / 6000))}:${pad(Math.floor(hundredths / 100) % 60)}.${pad(hundredths % 100)}`;
}

/** `mm:ss`, a paragraph's start. */
export function formatParagraphTime(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`;
}
