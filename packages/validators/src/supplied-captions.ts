import type { TranscriptUtterance, TranscriptWord } from "./transcript";

/** Caller-supplied captions (SRT or WebVTT) normalized into the one utterance
 * and word model every caption surface reads: preview, burn-in, and subtitle
 * files all derive their cues from these words. */

export const SUPPLIED_CAPTIONS_MAX_BYTES = 64 * 1024;
export const SUPPLIED_CAPTIONS_MAX_CUES = 1_000;

export type SuppliedCaptionsErrorCode =
  | "supplied_captions_empty"
  | "supplied_captions_too_large"
  | "supplied_captions_too_many_cues"
  | "supplied_captions_malformed";

/** A typed refusal of supplied captions. `cue` is the 1-based position of the
 * offending block when one is to blame. */
export class SuppliedCaptionsError extends Error {
  constructor(readonly code: SuppliedCaptionsErrorCode, message: string, readonly cue: number | null = null) {
    super(message);
    this.name = "SuppliedCaptionsError";
  }
}

const TIMESTAMP = "(?:(\\d{1,3}):)?(\\d{1,2}):(\\d{2})[.,](\\d{1,3})";
const TIMING_LINE = new RegExp(`^\\s*${TIMESTAMP}\\s*-->\\s*${TIMESTAMP}(?:\\s+.*)?$`);
/** Two cues starting this close together are one caption shown in two pieces. */
const MERGE_WINDOW_SEC = 0.2;
const MIN_WORD_SEC = 0.001;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&lrm;": "", "&rlm;": "" };

function seconds(hours: string | undefined, minutes: string, secs: string, fraction: string) {
  return Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(secs) + Number(fraction.padEnd(3, "0")) / 1_000;
}

/** WebVTT's cue markup: b, i, u, c, v, lang, ruby, and rt tags (with classes
 * and annotations), the legacy font tag, and in-cue timestamps. Anything else
 * between angle brackets is the speaker's text, such as "<3" or "a < b > c". */
const KNOWN_VTT_TAGS = /<\/?(?:b|i|u|c|v|lang|ruby|rt|font)(?:[.\s][^<>]*)?>|<\d{1,3}:\d{2}(?::\d{2})?[.,]\d{1,3}>/gi;

function cueText(lines: string[]) {
  return lines
    .join(" ")
    .replace(KNOWN_VTT_TAGS, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|lrm|rlm|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
}

interface Cue { startSec: number; endSec: number; text: string }

function parseBlocks(source: string): Cue[] {
  const blocks = source.split(/\n{2,}/);
  const cues: Cue[] = [];
  blocks.forEach((block, blockIndex) => {
    const lines = block.split("\n");
    const timingAt = lines.findIndex((line) => line.includes("-->"));
    if (timingAt < 0) {
      // WebVTT carries a header and note, style, and region blocks; SRT has none.
      const first = lines[0]?.trim() ?? "";
      if (blockIndex === 0 && first.startsWith("WEBVTT")) return;
      if (/^(NOTE|STYLE|REGION)(\s|$)/.test(first)) return;
      throw new SuppliedCaptionsError("supplied_captions_malformed", `Cue ${cues.length + 1} has no timing line (expected "00:00:01,000 --> 00:00:03,000")`, cues.length + 1);
    }
    if (timingAt > 1) throw new SuppliedCaptionsError("supplied_captions_malformed", `Cue ${cues.length + 1} has unexpected text before its timing line`, cues.length + 1);
    const match = TIMING_LINE.exec(lines[timingAt]!);
    if (!match) throw new SuppliedCaptionsError("supplied_captions_malformed", `Cue ${cues.length + 1} has an unreadable timing line`, cues.length + 1);
    // A clock has no minute or second 60 or above; such a cue is a typo, not a long cue.
    if ([match[2], match[3], match[6], match[7]].some((part) => Number(part) >= 60)) {
      throw new SuppliedCaptionsError("supplied_captions_malformed", `Cue ${cues.length + 1} has a timestamp with minutes or seconds of 60 or more`, cues.length + 1);
    }
    const startSec = seconds(match[1], match[2]!, match[3]!, match[4]!);
    const endSec = seconds(match[5], match[6]!, match[7]!, match[8]!);
    if (!(endSec > startSec)) throw new SuppliedCaptionsError("supplied_captions_malformed", `Cue ${cues.length + 1} must end after it starts`, cues.length + 1);
    const text = cueText(lines.slice(timingAt + 1));
    if (text.length > 0) cues.push({ startSec, endSec, text });
    if (cues.length > SUPPLIED_CAPTIONS_MAX_CUES) throw new SuppliedCaptionsError("supplied_captions_too_many_cues", `Supplied captions are limited to ${SUPPLIED_CAPTIONS_MAX_CUES} cues`);
  });
  return cues;
}

/** Orders cues by start (cues that start together keep their file order),
 * joins near-simultaneous ones, and trims each cue's end back to the next
 * cue's start, so captions never overlap. */
function settleCues(cues: Cue[]): Cue[] {
  const sorted = [...cues].sort((left, right) => left.startSec - right.startSec);
  const settled: Cue[] = [];
  for (const cue of sorted) {
    const previous = settled[settled.length - 1];
    if (previous && cue.startSec < previous.endSec) {
      if (cue.startSec - previous.startSec < MERGE_WINDOW_SEC) {
        previous.text = `${previous.text} ${cue.text}`;
        previous.endSec = Math.max(previous.endSec, cue.endSec);
        continue;
      }
      previous.endSec = cue.startSec;
    }
    settled.push({ ...cue });
  }
  return settled;
}

const round = (value: number) => Math.round(value * 1_000) / 1_000;

/** Spreads a cue's time over its words by length: SRT and WebVTT time cues,
 * not words, and the cue model needs word times. */
function timedWords(cue: Cue): TranscriptWord[] {
  const tokens = cue.text.split(" ").filter(Boolean);
  const weights = tokens.map((token) => token.length + 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const duration = cue.endSec - cue.startSec;
  let elapsed = 0;
  const cueEndSec = round(cue.endSec);
  return tokens.map((word, index) => {
    // A cue shorter than its words' minimum lengths packs them at its end, never past it.
    const startSec = Math.min(round(cue.startSec + (duration * elapsed) / total), round(cueEndSec - MIN_WORD_SEC));
    elapsed += weights[index]!;
    const endSec = index === tokens.length - 1 ? cueEndSec : round(cue.startSec + (duration * elapsed) / total);
    return { word, startSec, endSec: Math.min(Math.max(endSec, round(startSec + MIN_WORD_SEC)), cueEndSec), confidence: null };
  });
}

/** Parses SRT or WebVTT text into utterances, one per cue. Malformed, empty,
 * or oversized input throws a SuppliedCaptionsError. */
export function parseSuppliedCaptions(text: string): TranscriptUtterance[] {
  if (new TextEncoder().encode(text).byteLength > SUPPLIED_CAPTIONS_MAX_BYTES) {
    throw new SuppliedCaptionsError("supplied_captions_too_large", `Supplied captions are limited to ${SUPPLIED_CAPTIONS_MAX_BYTES / 1024} KiB`);
  }
  if (text.includes("\u0000")) throw new SuppliedCaptionsError("supplied_captions_malformed", "Supplied captions must be text");
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/^[ \t]+$/gm, "").trim();
  if (source.length === 0) throw new SuppliedCaptionsError("supplied_captions_empty", "Supplied captions contain no cues");
  const cues = settleCues(parseBlocks(source));
  if (cues.length === 0) throw new SuppliedCaptionsError("supplied_captions_empty", "Supplied captions contain no cues");
  return cues.map((cue, index) => ({
    index,
    speaker: null,
    speakerLabel: "Speaker",
    startSec: round(cue.startSec),
    endSec: round(cue.endSec),
    text: cue.text,
    confidence: null,
    words: timedWords(cue),
  }));
}

/** Fits supplied utterances to a source of known length: cues that begin after
 * the end are dropped, and the last visible cue ends with the source. */
export function fitSuppliedUtterances(utterances: readonly TranscriptUtterance[], durationSec: number): TranscriptUtterance[] {
  return utterances
    .filter((utterance) => utterance.startSec < durationSec)
    .map((utterance, index) => {
      if (utterance.endSec <= durationSec) return { ...utterance, index };
      const words = utterance.words.filter((word) => word.startSec < durationSec).map((word) => ({ ...word, endSec: Math.min(word.endSec, durationSec) }));
      return { ...utterance, index, endSec: durationSec, words, text: words.map((word) => word.word).join(" ") };
    })
    .filter((utterance) => utterance.words.length > 0);
}
