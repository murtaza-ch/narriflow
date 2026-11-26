import {
  CAPTION_MERGE_LIMIT,
  captionWordKey,
  isNoSpaceScriptChar,
  joinTranscriptWords,
  splitSpacedTokens,
  type TranscriptUtterance,
  type TranscriptWord,
} from "@narriflow/validators";

function timedWords(text: string, startSec: number, endSec: number): TranscriptWord[] {
  // Text in a no-space script stays one timed span; only real whitespace splits.
  const tokens = splitSpacedTokens(text);
  if (tokens.length === 0) return [];
  const duration = Math.max(0, endSec - startSec);
  const wordDuration = tokens.length > 0 ? duration / tokens.length : 0;
  return tokens.map(({ word, spaceBefore }, index) => ({
    word,
    ...(spaceBefore ? { spaceBefore } : {}),
    startSec: startSec + index * wordDuration,
    endSec: index === tokens.length - 1 ? endSec : startSec + (index + 1) * wordDuration,
    confidence: null,
  }));
}

type ParagraphUnit = { word: string; spaceBefore?: boolean };

/**
 * Smallest units a paragraph can be cut at when it is spread over several
 * lines: a spaced word, or one character of a no-space script (zh/ja/Thai have
 * no whitespace to split on). Joining any slice with `joinTranscriptWords`
 * reproduces the text, because a unit cut inside a token never gets a space.
 */
function paragraphUnits(text: string): ParagraphUnit[] {
  const units: ParagraphUnit[] = [];
  for (const token of splitSpacedTokens(text)) {
    let first = true;
    for (const part of tokenParts(token.word)) {
      units.push({ word: part, spaceBefore: first ? token.spaceBefore : false });
      first = false;
    }
  }
  return units;
}

function tokenParts(token: string): string[] {
  const parts: string[] = [];
  let run = "";
  for (const char of Array.from(token)) {
    if (isNoSpaceScriptChar(char)) {
      if (run) parts.push(run);
      run = "";
      parts.push(char);
    } else {
      run += char;
    }
  }
  if (run) parts.push(run);
  return parts;
}

function reindex(lines: TranscriptUtterance[]): TranscriptUtterance[] {
  return lines.map((line, index) => (line.index === index ? line : { ...line, index }));
}

// ─── Caption rows ───────────────────────────────────────────────────────────
//
// A caption row is one cue on the video (`deriveCaptionLines`): an utterance and the indices of the
// words the cue shows. An edit touches only those words, so every other word keeps its time, its
// Word Key (emojis and emphasis) and its object (censor marks, `carryCensorWordIds`).

/** A caption row's words, addressed by Word Key so an address taken before a neighbour's edit still holds. */
export interface CaptionRowAddress {
  /** Position of the row's utterance in the slice when the address was taken. */
  readonly utterance: number;
  /** Word Keys of the words the row shows, in order; empty for an untimed utterance. */
  readonly keys: readonly string[];
}

export interface CaptionRow {
  readonly utterance: number;
  readonly words: readonly number[];
}

export function captionRowAddress(lines: readonly TranscriptUtterance[], row: CaptionRow): CaptionRowAddress {
  const words = lines[row.utterance]?.words ?? [];
  return { utterance: row.utterance, keys: row.words.flatMap((at) => (words[at] ? [captionWordKey(words[at].startSec)] : [])) };
}

/** The row's words now, or null when one of them no longer exists. */
export function resolveCaptionRow(lines: readonly TranscriptUtterance[], address: CaptionRowAddress): CaptionRow | null {
  const find = (utterance: number): CaptionRow | null => {
    const words = lines[utterance]?.words;
    if (!words || (address.keys.length === 0) !== (words.length === 0)) return null;
    const indices = address.keys.map((key) => words.findIndex((word) => captionWordKey(word.startSec) === key));
    return indices.every((at) => at >= 0) ? { utterance, words: indices } : null;
  };
  const preferred = find(address.utterance);
  if (preferred || address.keys.length === 0) return preferred;
  for (let utterance = 0; utterance < lines.length; utterance++) {
    if (utterance === address.utterance) continue;
    const found = find(utterance);
    if (found) return found;
  }
  return null;
}

/** What a row edit changed beyond the slice: Word Keys of kept words that were re-timed, old to new. */
export interface CaptionRowEdit {
  readonly lines: TranscriptUtterance[];
  readonly movedKeys: ReadonlyMap<string, string>;
  /** Word Keys of the row's words after the edit, so a merged caption can follow them (`followMergedRow`). */
  readonly rowKeys: readonly string[];
}

const UNCHANGED = (lines: TranscriptUtterance[], rowKeys: readonly string[]): CaptionRowEdit => ({ lines, movedKeys: new Map(), rowKeys });

const keysOf = (words: readonly TranscriptWord[]) => words.map((word) => captionWordKey(word.startSec));

function withWords(utterance: TranscriptUtterance, words: TranscriptWord[]): TranscriptUtterance {
  return { ...utterance, words, text: joinTranscriptWords(words) };
}

function replaceAt(lines: TranscriptUtterance[], index: number, next: TranscriptUtterance[]): TranscriptUtterance[] {
  return reindex([...lines.slice(0, index), ...next, ...lines.slice(index + 1)]);
}

/**
 * The row's text as typed, cut into new words the way the old ones were cut: when the count matches
 * as spaced words or as script units the words are rewritten in place; otherwise a script whose
 * provider sent one word per character stays one word per character.
 */
function rowUnits(text: string, old: readonly TranscriptWord[]): { units: ParagraphUnit[]; sameCount: boolean } {
  const spaced = splitSpacedTokens(text);
  if (spaced.length === old.length) return { units: spaced, sameCount: true };
  const units = paragraphUnits(text);
  if (units.length === old.length) return { units, sameCount: true };
  const perCharacter = old.some((word) => Array.from(word.word).some(isNoSpaceScriptChar)) &&
    paragraphUnits(joinTranscriptWords(old)).length === old.length;
  return { units: perCharacter ? units : spaced, sameCount: false };
}

/**
 * The time a row's new words share: its words' own spans, plus the gap between two of them when no
 * other word (a cut or hidden one) sits between them. Without such words it is one span from the
 * first word's start to the last word's end, so a new word never lands inside a cut.
 */
function rowSpans(words: readonly TranscriptWord[], indices: readonly number[]): [number, number][] {
  const spans: [number, number][] = [];
  indices.forEach((at, position) => {
    const word = words[at]!;
    const last = spans.at(-1);
    const joins = position > 0 && indices[position - 1] === at - 1 && last !== undefined;
    if (joins) last[1] = Math.max(last[1], word.endSec);
    else spans.push([word.startSec, Math.max(word.startSec, word.endSec)]);
  });
  return spans;
}

/** `count` even shares of the spans' total time; a share never crosses from one span into the next. */
function evenTimes(spans: readonly [number, number][], count: number): { startSec: number; endSec: number }[] {
  const total = spans.reduce((sum, [start, end]) => sum + (end - start), 0);
  const at = (offset: number) => {
    let left = offset;
    for (const [index, [start, end]] of spans.entries()) {
      if (left <= end - start || index === spans.length - 1) return { span: index, sec: start + Math.min(left, end - start) };
      left -= end - start;
    }
    return { span: 0, sec: spans[0]![0] };
  };
  return Array.from({ length: count }, (_, index) => {
    const start = at((total * index) / count);
    const end = index === count - 1 ? { span: spans.length - 1, sec: spans.at(-1)![1] } : at((total * (index + 1)) / count);
    return { startSec: start.sec, endSec: end.span === start.span ? end.sec : spans[start.span]![1] };
  });
}

/** Old word positions matched to new ones with the same text, longest common run first. */
function matchByText(old: readonly string[], next: readonly string[]): [number, number][] {
  const table = Array.from({ length: old.length + 1 }, () => new Array<number>(next.length + 1).fill(0));
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      table[i]![j] = old[i] === next[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let [i, j] = [0, 0];
  while (i < old.length && j < next.length) {
    if (old[i] === next[j]) pairs.push([i++, j++]);
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/**
 * Rewrites one caption row. The same number of words rewrites each word's text in place (times,
 * Word Keys and untouched word objects stay). A different number re-times only the row's words
 * evenly over the row's own time; a word whose text is unchanged reports its key move. An empty
 * text deletes the row's words. One call is one undo step.
 */
export function replaceCaptionRowText(lines: TranscriptUtterance[], row: CaptionRow, text: string): CaptionRowEdit {
  const utterance = lines[row.utterance];
  if (!utterance) return UNCHANGED(lines, []);
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return UNCHANGED(deleteCaptionRow(lines, row), []);
  if (row.words.length === 0) {
    return utterance.words.length === 0 && utterance.text !== trimmed
      ? UNCHANGED(lines.map((line, index) => (index === row.utterance ? { ...line, text: trimmed } : line)), [])
      : UNCHANGED(lines, []);
  }
  const old = row.words.map((at) => utterance.words[at]!);
  if (joinTranscriptWords(old) === trimmed) return UNCHANGED(lines, keysOf(old));
  const { units, sameCount } = rowUnits(trimmed, old);
  if (sameCount) {
    const replaced = new Map(row.words.map((at, position) => [at, units[position]!.word]));
    const words = utterance.words.map((word, at) => {
      const next = replaced.get(at);
      return next === undefined || next === word.word ? word : { ...word, word: next };
    });
    return UNCHANGED(lines.map((line, index) => (index === row.utterance ? withWords(line, words) : line)), keysOf(old));
  }
  const times = evenTimes(rowSpans(utterance.words, row.words), units.length);
  const created: TranscriptWord[] = units.map((unit, position) => {
    const spaceBefore = position === 0 ? old[0]!.spaceBefore : unit.spaceBefore;
    return { word: unit.word, ...(spaceBefore === undefined ? {} : { spaceBefore }), ...times[position]!, confidence: null };
  });
  const movedKeys = new Map<string, string>();
  for (const [from, to] of matchByText(old.map((word) => word.word), created.map((word) => word.word))) {
    const [oldKey, newKey] = [captionWordKey(old[from]!.startSec), captionWordKey(created[to]!.startSec)];
    if (oldKey !== newKey) movedKeys.set(oldKey, newKey);
  }
  const first = row.words[0]!;
  const last = row.words.at(-1)!;
  const rowSet = new Set(row.words);
  const between = utterance.words.slice(first, last + 1).filter((_, offset) => !rowSet.has(first + offset));
  const words = [
    ...utterance.words.slice(0, first),
    ...[...between, ...created].sort((left, right) => left.startSec - right.startSec),
    ...utterance.words.slice(last + 1),
  ];
  return { lines: lines.map((line, index) => (index === row.utterance ? withWords(line, words) : line)), movedKeys, rowKeys: keysOf(created) };
}

/** Deletes a row's words from the subtitles (footage is not cut); an utterance left without words goes. */
export function deleteCaptionRow(lines: TranscriptUtterance[], row: CaptionRow): TranscriptUtterance[] {
  const utterance = lines[row.utterance];
  if (!utterance) return lines;
  const removed = new Set(row.words);
  const words = utterance.words.filter((_, at) => !removed.has(at));
  if (row.words.length === 0 || words.length === 0) return reindex(lines.filter((_, index) => index !== row.utterance));
  return lines.map((line, index) =>
    index === row.utterance
      ? { ...withWords(line, words), startSec: words[0]!.startSec, endSec: Math.max(...words.map((word) => word.endSec)) }
      : line,
  );
}

const PLACEHOLDER = "Subtitle here";
/** A placeholder fills the gap after its row, up to this long. */
const PLACEHOLDER_MAX_SEC = 1;
/** Shortest gap a placeholder fills; with less, it takes the end of its row's last word. */
const PLACEHOLDER_MIN_GAP_SEC = 0.1;
const PLACEHOLDER_TAKE_SEC = 0.25;

/**
 * Adds a placeholder caption after a row without changing footage. When the row is not its
 * utterance's last caption, the utterance splits after the row's last word, so the placeholder
 * shows between them; every word keeps its time.
 */
export function addCaptionRowAfter(lines: TranscriptUtterance[], row: CaptionRow): TranscriptUtterance[] {
  const utterance = lines[row.utterance];
  if (!utterance) return lines;
  const lastAt = row.words.at(-1);
  const lastWord = lastAt === undefined ? null : utterance.words[lastAt]!;
  const rest = lastAt === undefined ? [] : utterance.words.slice(lastAt + 1);
  const kept = lastAt === undefined ? utterance.words : utterance.words.slice(0, lastAt + 1);
  const rowEnd = lastWord?.endSec ?? utterance.endSec;
  const nextStart = rest[0]?.startSec ?? lines[row.utterance + 1]?.startSec ?? Number.POSITIVE_INFINITY;
  const gap = nextStart - rowEnd;
  const startSec = gap >= PLACEHOLDER_MIN_GAP_SEC
    ? rowEnd
    : Math.max(rowEnd - PLACEHOLDER_TAKE_SEC, lastWord ? (lastWord.startSec + rowEnd) / 2 : utterance.startSec);
  const endSec = gap >= PLACEHOLDER_MIN_GAP_SEC ? Math.min(nextStart, rowEnd + PLACEHOLDER_MAX_SEC) : rowEnd;
  const placeholder: TranscriptUtterance = {
    index: row.utterance + 1,
    speaker: utterance.speaker,
    speakerLabel: utterance.speakerLabel,
    startSec,
    endSec,
    text: PLACEHOLDER,
    confidence: null,
    words: timedWords(PLACEHOLDER, startSec, endSec),
  };
  if (rest.length === 0) return reindex([...lines.slice(0, row.utterance + 1), placeholder, ...lines.slice(row.utterance + 1)]);
  const head = { ...withWords(utterance, kept), endSec: rowEnd };
  const tail = { ...withWords(utterance, rest), startSec: rest[0]!.startSec };
  return replaceAt(lines, row.utterance, [head, placeholder, tail]);
}

/** Joins an utterance with the next one, keeping every word (the same objects) and its time. */
export function mergeSubtitleLineWithNext(lines: TranscriptUtterance[], lineIndex: number): TranscriptUtterance[] {
  const first = lines[lineIndex];
  const second = lines[lineIndex + 1];
  if (!first || !second) return lines;
  const words = [...first.words, ...second.words];
  const merged: TranscriptUtterance = {
    ...first,
    endSec: Math.max(first.endSec, second.endSec),
    text: words.length > 0 ? joinTranscriptWords(words) : joinTranscriptWords([{ word: first.text }, { word: second.text }]),
    confidence: null,
    words,
  };
  return reindex([...lines.slice(0, lineIndex), merged, ...lines.slice(lineIndex + 2)]);
}

/** Captions merged by hand (`StudioEdits.captionMerges`): first word's key to last word's key. */
export type CaptionMerges = Readonly<Record<string, string>>;

/**
 * Merges a caption row with the next caption into one, without moving any word: rows in two
 * utterances join them (`mergeSubtitleLineWithNext`), and the merged words are stored as one
 * caption, which the shared cue grouping keeps together on the video and in the list. Entries
 * whose first word is gone are dropped. Null when the rows cannot be one caption: not neighbours,
 * one timed and one not, or the clip already holds `CAPTION_MERGE_LIMIT` merges.
 */
export function mergeCaptionRowWithNext(
  lines: TranscriptUtterance[],
  row: CaptionRow,
  next: CaptionRow,
  merges: CaptionMerges | undefined,
): { lines: TranscriptUtterance[]; merges: CaptionMerges | undefined } | null {
  const first = lines[row.utterance];
  const second = lines[next.utterance];
  if (!first || !second || (row.words.length === 0) !== (next.words.length === 0)) return null;
  const sameUtterance = next.utterance === row.utterance;
  if (sameUtterance ? next.words[0]! <= row.words.at(-1)! : next.utterance !== row.utterance + 1) return null;
  const joined = sameUtterance ? lines : mergeSubtitleLineWithNext(lines, row.utterance);
  // An untimed utterance shows as one caption: joining is the whole merge.
  if (row.words.length === 0) return { lines: joined, merges };
  const firstKey = captionWordKey(first.words[row.words[0]!]!.startSec);
  const live = new Set(joined.flatMap((line) => keysOf(line.words)));
  const kept: Record<string, string> = {};
  for (const [key, last] of Object.entries(merges ?? {})) {
    if (live.has(key)) kept[key] = last;
  }
  delete kept[captionWordKey(second.words[next.words[0]!]!.startSec)];
  kept[firstKey] = captionWordKey(second.words[next.words.at(-1)!]!.startSec);
  return Object.keys(kept).length > CAPTION_MERGE_LIMIT ? null : { lines: joined, merges: kept };
}

/** A merged caption's entry moved to its words' Word Keys after a row edit; the same object when it was not merged. */
export function followMergedRow(merges: CaptionMerges | undefined, before: readonly string[], after: readonly string[]): CaptionMerges | undefined {
  const [from, to] = [before[0], before.at(-1)];
  if (!merges || from === undefined || merges[from] !== to) return merges;
  if (after[0] === from && after.at(-1) === to) return merges;
  const { [from]: _moved, ...rest } = merges;
  return after.length > 1 ? { ...rest, [after[0]!]: after.at(-1)! } : rest;
}

/** Rewrites a multi-line paragraph in one undoable document action. */
export function replaceSubtitleParagraphText(
  lines: TranscriptUtterance[],
  lineIndices: number[],
  text: string,
): TranscriptUtterance[] {
  const tokens = paragraphUnits(text);
  const validIndices = lineIndices.filter((index) => lines[index]);
  if (
    tokens.length === 0 ||
    validIndices.length === 0 ||
    tokens.length < validIndices.length
  ) return lines;

  const weights = validIndices.map((index) => Math.max(1, lines[index]!.words.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;

  return lines.map((line, index) => {
    const groupPosition = validIndices.indexOf(index);
    if (groupPosition === -1) return line;
    const remainingLines = validIndices.length - groupPosition;
    const remainingTokens = tokens.length - cursor;
    const isLast = groupPosition === validIndices.length - 1;
    const proportional = Math.round((tokens.length * weights[groupPosition]!) / totalWeight);
    const take = isLast
      ? remainingTokens
      : Math.max(1, Math.min(proportional, remainingTokens - (remainingLines - 1)));
    const nextText = joinTranscriptWords(tokens.slice(cursor, cursor + take));
    cursor += take;
    return {
      ...line,
      text: nextText,
      words: timedWords(nextText, line.startSec, line.endSec),
    };
  });
}

/** A pause between utterances this long starts a new paragraph (measured on the real clips, see ticket 22). */
export const PARAGRAPH_PAUSE_SEC = 0.7;
/** A paragraph closes before an utterance that would take it past this many words. */
export const PARAGRAPH_MAX_WORDS = 50;

/**
 * Paragraphs of whole utterances: a new one starts at a speaker change, after a pause that reads as
 * a new thought, or before the paragraph would grow too long to scan.
 */
export function subtitleParagraphGroups(lines: readonly TranscriptUtterance[]): number[][] {
  const groups: number[][] = [];
  let words = 0;
  lines.forEach((line, index) => {
    const count = Math.max(1, line.words.length);
    const previous = lines[index - 1];
    const current = groups.at(-1);
    const breaks = !current || !previous ||
      previous.speaker !== line.speaker ||
      previous.speakerLabel !== line.speakerLabel ||
      line.startSec - previous.endSec >= PARAGRAPH_PAUSE_SEC ||
      words + count > PARAGRAPH_MAX_WORDS;
    if (breaks) {
      groups.push([index]);
      words = count;
    } else {
      current.push(index);
      words += count;
    }
  });
  return groups;
}

/**
 * Timeline labels are derived from timed words at render time so a word
 * correction or manual split cannot leave both halves carrying stale text.
 */
export function labelForTimelineSegment(
  lines: TranscriptUtterance[],
  clipStartSec: number,
  startSec: number,
  endSec: number,
  fallback: string,
): string {
  const absoluteStart = clipStartSec + startSec;
  const absoluteEnd = clipStartSec + endSec;
  const words = lines
    .flatMap((line) => line.words)
    .filter((word) => {
      const midpoint = (word.startSec + word.endSec) / 2;
      return midpoint >= absoluteStart && midpoint < absoluteEnd;
    })
    .map(({ word, spaceBefore }) => ({ word, spaceBefore }));
  if (words.length > 0) return joinTranscriptWords(words);
  if (absoluteEnd - absoluteStart < 0.15) {
    return `${startSec.toFixed(2)}–${endSec.toFixed(2)}s`;
  }
  return fallback;
}
