import {
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
  return lines.map((line, index) => ({ ...line, index }));
}

export function replaceSubtitleLineText(
  lines: TranscriptUtterance[],
  lineIndex: number,
  text: string,
): TranscriptUtterance[] {
  const trimmed = text.trim();
  if (!trimmed || !lines[lineIndex] || lines[lineIndex]!.text === trimmed) return lines;
  return lines.map((line, index) =>
    index === lineIndex
      ? {
          ...line,
          text: trimmed,
          words: timedWords(trimmed, line.startSec, line.endSec),
        }
      : line,
  );
}

export function deleteSubtitleLine(
  lines: TranscriptUtterance[],
  lineIndex: number,
): TranscriptUtterance[] {
  if (!lines[lineIndex]) return lines;
  return reindex(lines.filter((_, index) => index !== lineIndex));
}

/** Inserts a short editable placeholder without changing footage timing. */
export function addSubtitleLineAfter(
  lines: TranscriptUtterance[],
  lineIndex: number,
): TranscriptUtterance[] {
  const line = lines[lineIndex];
  if (!line) return lines;
  const next = lines[lineIndex + 1];
  const hasGapAfter = next && next.startSec - line.endSec >= 0.05;
  const startSec = next
    ? line.endSec
    : Math.max(line.startSec, line.endSec - 0.25);
  const endSec = hasGapAfter
    ? Math.min(next.startSec, startSec + 1)
    : next
      ? startSec + 0.25
      : line.endSec;
  const inserted: TranscriptUtterance = {
    index: lineIndex + 1,
    speaker: line.speaker,
    speakerLabel: line.speakerLabel,
    startSec,
    endSec,
    text: "Subtitle here",
    confidence: null,
    words: timedWords("Subtitle here", startSec, endSec),
  };
  return reindex([...lines.slice(0, lineIndex + 1), inserted, ...lines.slice(lineIndex + 1)]);
}

export function mergeSubtitleLineWithNext(
  lines: TranscriptUtterance[],
  lineIndex: number,
): TranscriptUtterance[] {
  const first = lines[lineIndex];
  const second = lines[lineIndex + 1];
  if (!first || !second) return lines;
  const text = joinTranscriptWords([{ word: first.text }, { word: second.text }]);
  const merged: TranscriptUtterance = {
    ...first,
    endSec: Math.max(first.endSec, second.endSec),
    text,
    confidence: null,
    words: [...first.words, ...second.words].map((word) => ({ ...word })),
  };
  return reindex([...lines.slice(0, lineIndex), merged, ...lines.slice(lineIndex + 2)]);
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

export function subtitleParagraphGroups(
  lines: TranscriptUtterance[],
): Array<{ speakerLabel: string; lineIndices: number[] }> {
  const groups: Array<{ speakerLabel: string; lineIndices: number[] }> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const previous = groups[groups.length - 1];
    if (previous?.speakerLabel === line.speakerLabel) previous.lineIndices.push(index);
    else groups.push({ speakerLabel: line.speakerLabel, lineIndices: [index] });
  }
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
