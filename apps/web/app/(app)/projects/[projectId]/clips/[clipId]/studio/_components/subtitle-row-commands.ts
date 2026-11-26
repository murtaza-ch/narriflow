import type { EditorDocument, TranscriptUtterance } from "@narriflow/validators";
import {
  addCaptionRowAfter,
  deleteCaptionRow,
  followMergedRow,
  mergeCaptionRowWithNext,
  replaceCaptionRowText,
  resolveCaptionRow,
  type CaptionRowAddress,
} from "./subtitle-lines";
import { transcriptEditActions, type TranscriptEditAction } from "./subtitle-word-carry";

// The Sentence view's row commands as document actions. The Studio and the prototype dispatch
// them the same way: under one coalesce key, so each command is one undo step.

export type CaptionRowCommand =
  | { readonly type: "edit"; readonly row: CaptionRowAddress; readonly text: string }
  | { readonly type: "add-after"; readonly row: CaptionRowAddress }
  | { readonly type: "delete"; readonly row: CaptionRowAddress }
  | { readonly type: "merge-next"; readonly row: CaptionRowAddress; readonly next: CaptionRowAddress };

type RowsDocument = Pick<EditorDocument, "transcriptSlice" | "censorSegments" | "studioEdits">;

/** The actions of one row command; empty when its rows are gone or nothing changes. */
export function captionRowCommandActions(document: RowsDocument, command: CaptionRowCommand): TranscriptEditAction[] {
  const slice = document.transcriptSlice;
  const row = resolveCaptionRow(slice, command.row);
  if (!row) return [];
  switch (command.type) {
    case "edit": {
      const edit = replaceCaptionRowText(slice, row, command.text);
      // The address names the row's words by Word Key, as the merge entry does.
      const captionMerges = followMergedRow(document.studioEdits.captionMerges, command.row.keys, edit.rowKeys);
      const studioEdits = captionMerges === document.studioEdits.captionMerges ? document.studioEdits : withMerges(document.studioEdits, captionMerges);
      return transcriptEditActions(document, edit.lines, edit.movedKeys, studioEdits);
    }
    case "add-after":
      return transcriptEditActions(document, addCaptionRowAfter(slice, row), new Map());
    case "delete":
      return transcriptEditActions(document, deleteCaptionRow(slice, row), new Map());
    case "merge-next": {
      const next = resolveCaptionRow(slice, command.next);
      const merged = next && mergeCaptionRowWithNext(slice, row, next, document.studioEdits.captionMerges);
      if (!merged) return [];
      const studioEdits = merged.merges === document.studioEdits.captionMerges ? document.studioEdits : withMerges(document.studioEdits, merged.merges);
      return transcriptEditActions(document, merged.lines, new Map(), studioEdits);
    }
  }
}

/**
 * A manual scene split (a timeline segment whose id has `-b`, at clip-relative seconds) between a
 * row and the next one: a merge across it is refused, as it always was.
 */
export function mergeCrossesSceneSplit(
  slice: readonly TranscriptUtterance[],
  row: CaptionRowAddress,
  next: CaptionRowAddress,
  segments: readonly { readonly id: string; readonly startSec: number }[],
  clipStartSec: number,
): boolean {
  const first = resolveCaptionRow(slice, row);
  const second = resolveCaptionRow(slice, next);
  if (!first || !second) return false;
  const firstLine = slice[first.utterance]!;
  const secondLine = slice[second.utterance]!;
  const seamStart = (firstLine.words[first.words.at(-1) ?? -1]?.endSec ?? firstLine.endSec) - clipStartSec;
  const seamEnd = (secondLine.words[second.words[0] ?? -1]?.startSec ?? secondLine.startSec) - clipStartSec;
  return segments.some((segment) => segment.id.includes("-b") && segment.startSec >= seamStart - 0.02 && segment.startSec <= seamEnd + 0.02);
}

function withMerges(edits: EditorDocument["studioEdits"], captionMerges: Readonly<Record<string, string>> | undefined): EditorDocument["studioEdits"] {
  if (captionMerges && Object.keys(captionMerges).length > 0) return { ...edits, captionMerges: { ...captionMerges } };
  const { captionMerges: _cleared, ...rest } = edits;
  return rest;
}
