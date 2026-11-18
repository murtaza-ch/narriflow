import { CLIP_AUDIO_FADE_OUT_SEC } from "@narriflow/composition-plan";

/** Seconds of silence kept between two placed dub segments. */
export const GAP = 0.08;
/** How far after its source start a dub segment may begin. */
export const LATE_MAX = 0.6;
/** Fastest tempo a TTS clip is sped up by. */
export const TEMPO_MAX = 1.3;

export type DubPlacementInput = {
  editedDurationSec: number;
  /** Sorted by `startSec`: the source sentence start and the trimmed TTS clip length. */
  segments: { startSec: number; naturalSec: number }[];
};

export type PlacedDubSegment = { startSec: number; endSec: number; tempo: number };

export type DubPlacement =
  | { kind: "placed"; segments: PlacedDubSegment[] }
  | { kind: "unfit"; segmentIndex: number };

export function placeDubSegments(input: DubPlacementInput): DubPlacement {
  const { editedDurationSec, segments } = input;
  // Narration ends before the render's closing click-guard fade, so it never fades a syllable.
  const speechEndSec = editedDurationSec - CLIP_AUDIO_FADE_OUT_SEC;
  const placed: PlacedDubSegment[] = [];
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const [index, segment] of segments.entries()) {
    const next = segments[index + 1];
    const start = index === 0 ? segment.startSec : Math.max(segment.startSec, previousEnd + GAP);
    const deadline = Math.min(
      next ? next.startSec + LATE_MAX - GAP : speechEndSec,
      speechEndSec,
    );
    if (!(deadline > start)) return { kind: "unfit", segmentIndex: index };
    const tempo = Math.max(1, segment.naturalSec / (deadline - start));
    if (!(tempo <= TEMPO_MAX)) return { kind: "unfit", segmentIndex: index };
    const end = start + segment.naturalSec / tempo;
    placed.push({ startSec: start, endSec: end, tempo });
    previousEnd = end;
  }
  return { kind: "placed", segments: placed };
}

export type DubCaptionWord = {
  text: string;
  spaceBefore: boolean;
  startSec: number;
  endSec: number;
};

const WHITESPACE = /^\s+$/u;
const OPENING_PUNCTUATION = /^[\p{Ps}\p{Pi}¿¡]+$/u;

/**
 * Splits one dubbed sentence into caption words and spreads `[startSec, endSec]`
 * over them in proportion to grapheme count. Punctuation attaches to the preceding
 * token; opening marks (¿ ¡ ( « ...) after whitespace attach to the next word; `spaceBefore` records whether
 * whitespace preceded the token in the original text.
 */
export function dubCaptionWords(
  text: string,
  language: string,
  startSec: number,
  endSec: number,
): DubCaptionWord[] {
  const tokens: { text: string; spaceBefore: boolean }[] = [];
  let pendingSpace = false;
  let pendingPrefix = "";
  for (const part of new Intl.Segmenter(language, { granularity: "word" }).segment(text.trim())) {
    if (WHITESPACE.test(part.segment)) {
      pendingSpace = true;
      continue;
    }
    if (part.isWordLike) {
      tokens.push({ text: pendingPrefix + part.segment, spaceBefore: pendingSpace && tokens.length > 0 });
      pendingPrefix = "";
      pendingSpace = false;
      continue;
    }
    const last = tokens.at(-1);
    if (!last || (pendingSpace && OPENING_PUNCTUATION.test(part.segment))) {
      pendingPrefix += part.segment;
    } else {
      last.text += (pendingSpace ? " " : "") + part.segment;
      pendingSpace = false;
    }
  }
  if (pendingPrefix) {
    const last = tokens.at(-1);
    if (last) last.text += (pendingSpace ? " " : "") + pendingPrefix;
    else tokens.push({ text: pendingPrefix, spaceBefore: false });
  }
  if (tokens.length === 0) return [];

  const graphemes = new Intl.Segmenter(language, { granularity: "grapheme" });
  const weights = tokens.map(
    (token) => [...graphemes.segment(token.text)].filter((g) => !WHITESPACE.test(g.segment)).length || 1,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const begin = startSec;
  const finish = Math.max(startSec, endSec);
  const span = finish - begin;
  let before = 0;
  return tokens.map((token, index) => {
    const wordStart = begin + (span * before) / total;
    before += weights[index] ?? 1;
    const wordEnd = index === tokens.length - 1 ? finish : begin + (span * before) / total;
    return { text: token.text, spaceBefore: token.spaceBefore, startSec: wordStart, endSec: wordEnd };
  });
}
