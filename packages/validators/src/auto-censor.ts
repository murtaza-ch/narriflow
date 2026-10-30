import {
  buildClipCutPlan,
  sourceWordToEdited,
  type ClipWindow,
  type EditedTimeMap,
  type SourceRange,
} from "./edit-ranges";
import { formatCaptionWord } from "./caption-preset";
import { isNoSpaceScriptChar, joinTranscriptWords } from "./text-script";
import { censorWildcardStem, censorWordCategory, CENSOR_STEM_MIN_LENGTH } from "./censor-words";
import type { CensorSegment, SceneBlock } from "./timed-edits";
import { z } from "zod";

export const AUTO_CENSOR_POLICY_VERSION = "auto-censor-v2";

export const autoCensorAnalyticsInputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("auto_censor_scan_started") }),
  z.strictObject({
    type: z.literal("auto_censor_scan_completed"),
    resultCountBucket: z.enum(["zero", "one_to_five", "six_to_twenty", "over_twenty"]),
  }),
  z.strictObject({
    type: z.literal("auto_censor_applied"),
    selectedCount: z.number().int().min(0).max(256),
    captionMaskCount: z.number().int().min(0).max(256),
    muteCount: z.number().int().min(0).max(256),
    beepCount: z.number().int().min(0).max(256),
    staleCount: z.number().int().min(0).max(256),
  }),
  z.strictObject({
    type: z.literal("auto_censor_export_notice"),
    staleCount: z.number().int().min(1).max(256),
  }),
]);

export type AutoCensorAnalyticsInput = z.infer<typeof autoCensorAnalyticsInputSchema>;

export type AutoCensorTreatment = "beep" | "mute" | "caption_mask";
export type AutoCensorPolicySource = "workspace" | "brand_profile" | "project";

export interface AutoCensorTranscriptWord {
  readonly word: string;
  readonly startSec: number | null;
  readonly endSec: number | null;
  readonly confidence: number | null;
  readonly spaceBefore?: boolean;
  readonly id?: string;
}

export interface AutoCensorTranscriptUtterance {
  readonly index: number;
  readonly speakerLabel: string;
  readonly startSec: number | null;
  readonly endSec: number | null;
  readonly text: string;
  readonly confidence: number | null;
  readonly words: readonly AutoCensorTranscriptWord[];
}

export interface AutoCensorSuggestion {
  readonly fingerprint: string;
  readonly policyVersion: typeof AUTO_CENSOR_POLICY_VERSION;
  readonly policySource: AutoCensorPolicySource;
  readonly policyCategory: "profanity" | "slur" | "custom";
  readonly matchedText: string;
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly sourceWordIds: readonly string[];
  readonly sourceStartSec: number | null;
  readonly sourceEndSec: number | null;
  readonly audioStartSec: number | null;
  readonly audioEndSec: number | null;
  readonly confidence: number | null;
  readonly timingLimitation: "caption_only" | null;
}

export interface DetectAutoCensorSuggestionsInput {
  readonly documentRevision: number;
  readonly locale: string;
  readonly clipWindow: { readonly startSec: number; readonly endSec: number };
  readonly deletedRanges?: readonly SourceRange[];
  readonly transcript: readonly AutoCensorTranscriptUtterance[];
  /** The Workspace's censored-word list (see censor-words.ts). */
  readonly workspaceTerms: readonly string[];
  readonly brandTerms: readonly string[];
  readonly projectTerms: readonly string[];
  readonly paddingSec: number;
}

export interface CaptionMaskPolicy {
  readonly replacement: "asterisks" | "first_last" | "first_character" | "full_block";
  readonly preservePunctuation: boolean;
}

export type CensorAudioInterval =
  | {
      readonly startSec: number;
      readonly endSec: number;
      readonly treatment: "mute";
    }
  | {
      readonly startSec: number;
      readonly endSec: number;
      readonly treatment: "beep";
      readonly frequencyHz: number;
      readonly gain: number;
      readonly fadeInSec: number;
      readonly fadeOutSec: number;
    };

export interface NormalizeCensorAudioScheduleInput {
  readonly clipWindow: ClipWindow;
  readonly deletedRanges: readonly SourceRange[];
  readonly segments: readonly CensorSegment[];
  readonly sceneBlocks?: readonly SceneBlock[];
}

interface AutoCensorPolicyTerm {
  readonly value: string;
  readonly source: AutoCensorPolicySource;
  readonly category: AutoCensorSuggestion["policyCategory"];
}

/** One word of a term: a literal, or the stem of a trailing-`*` wildcard. */
interface CompiledTermToken {
  readonly text: string;
  readonly wildcard: boolean;
}

function hash64(value: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds
    .map((seed, seedIndex) => {
      let hash = seed;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index) + seedIndex * 31;
        hash = Math.imul(hash, seedIndex % 2 === 0 ? 0x01000193 : 0x85ebca6b);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    })
    .join("")
    .repeat(2);
}

function normalizeToken(value: string, locale: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase(locale)
    // Combining marks stay: stripping a trailing vowel sign or virama would
    // turn a Thai, Indic or Arabic word into a different one.
    .replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, "");
}

/** "shit's" and "fuck'd" are the censored word plus a contraction: match on the word. */
function withoutContraction(token: string): string {
  return token.replace(/['\u2019](?:s|d|ll|re|ve|m)$/u, "");
}

function normalizeLocaleTag(locale: string): string {
  const candidate = locale.trim().replaceAll("_", "-");
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? "und";
  } catch {
    return "und";
  }
}

function roundMillis(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function roundSix(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Audio envelopes retain microsecond-scale intervals. The shared visual
 * mapper intentionally rounds to milliseconds, which can collapse a very
 * short beep; this mapper keeps the same cut semantics without that display-
 * oriented rounding. */
function sourceRangeToEditedForAudio(
  map: EditedTimeMap,
  range: SourceRange,
): SourceRange | null {
  const mapPoint = (sourceSec: number) => {
    if (map.segments.length === 0) return 0;
    for (const segment of map.segments) {
      if (sourceSec < segment.sourceStartSec) return segment.editedStartSec;
      if (sourceSec <= segment.sourceEndSec) {
        return segment.editedStartSec + (sourceSec - segment.sourceStartSec);
      }
    }
    return map.editedDurationSec;
  };
  const startSec = mapPoint(range.startSec);
  const endSec = mapPoint(range.endSec);
  return endSec > startSec ? { startSec, endSec } : null;
}

interface CensorMatchWord {
  readonly utterance: AutoCensorTranscriptUtterance;
  readonly word: AutoCensorTranscriptUtterance["words"][number];
  readonly normalized: string;
  readonly base: string;
}

function tokenMatchesWord(token: CompiledTermToken, candidate: CensorMatchWord): boolean {
  return token.wildcard
    ? candidate.normalized.startsWith(token.text)
    : candidate.normalized === token.text || candidate.base === token.text;
}

/**
 * How many adjacent transcript words one term token spans when it is written
 * in a no-space script. Scribe returns Chinese and Japanese as one token per
 * character, so the user's `笨蛋` must match `笨`,`蛋`. The words must sit in
 * one utterance, each carry text in a no-space script, and touch: a word the
 * provider marked `spaceBefore: true` starts a new phrase.
 */
function joinedRunLength(
  words: readonly CensorMatchWord[],
  start: number,
  token: CompiledTermToken,
): number | null {
  if (!Array.from(token.text).some(isNoSpaceScriptChar)) return null;
  const first = words[start]!;
  let joined = "";
  for (let index = start; index < words.length; index += 1) {
    const candidate = words[index]!;
    if (
      candidate.utterance.index !== first.utterance.index ||
      (index > start && candidate.word.spaceBefore === true) ||
      !Array.from(candidate.normalized).some(isNoSpaceScriptChar)
    ) {
      return null;
    }
    joined += candidate.normalized;
    if (token.wildcard ? joined.startsWith(token.text) : joined === token.text) {
      return index - start + 1;
    }
    if (!token.text.startsWith(joined)) return null;
  }
  return null;
}

/** Words a term covers from `start`, or null. Each token matches one word, or a
 * run of touching no-space-script words that spell it. */
function matchTermLength(
  words: readonly CensorMatchWord[],
  start: number,
  tokens: readonly CompiledTermToken[],
): number | null {
  let cursor = start;
  for (const token of tokens) {
    const candidate = words[cursor];
    if (!candidate) return null;
    if (tokenMatchesWord(token, candidate)) {
      cursor += 1;
      continue;
    }
    const run = joinedRunLength(words, cursor, token);
    if (run === null) return null;
    cursor += run;
  }
  return cursor - start;
}

function segmentGraphemes(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(value)]
      .map((entry) => entry.segment);
  }
  return Array.from(value);
}

export function maskCensoredCaptionWord(
  value: string,
  policy: CaptionMaskPolicy,
): string {
  const graphemes = segmentGraphemes(value.normalize("NFC"));
  const isMaskable = (grapheme: string) => policy.preservePunctuation
    ? /[\p{L}\p{N}\p{M}]/u.test(grapheme)
    : !/^\s+$/u.test(grapheme);
  const maskableIndexes = graphemes.flatMap((grapheme, index) => isMaskable(grapheme) ? [index] : []);
  const kept = new Set<number>();
  if (policy.replacement === "first_character") {
    kept.add(maskableIndexes[0] ?? -1);
  } else if (policy.replacement === "first_last" && maskableIndexes.length >= 3) {
    // "F**k". A word shorter than three letters would show itself, so it is masked whole.
    kept.add(maskableIndexes[0]!);
    kept.add(maskableIndexes[maskableIndexes.length - 1]!);
  }
  const replacement = policy.replacement === "full_block" ? "█" : "*";
  return graphemes
    .map((grapheme, index) =>
      !isMaskable(grapheme) || kept.has(index) ? grapheme : replacement)
    .join("");
}

/**
 * A word as a caption shows it: edge punctuation is dropped first (when
 * captions hide it), then the censor mask is applied, so the mask's own `*`
 * can never be stripped as punctuation. Callers apply the text transform last.
 * The composition plan's cues (burn-in, SRT/VTT, preview) and the transcript
 * panel all use this one function.
 */
export function censoredCaptionWordText(
  word: string,
  maskPolicy: CaptionMaskPolicy | null,
  options: { readonly punctuation: boolean },
): string {
  const visible = formatCaptionWord(word, options);
  return maskPolicy && visible ? maskCensoredCaptionWord(visible, maskPolicy) : visible;
}

/** A list entry as shown in the word-list editor: each word masked, e.g. "f**k*". */
export function maskCensorTermForDisplay(term: string): string {
  return term
    .split(/\s+/)
    .map((word) => maskCensoredCaptionWord(word, { replacement: "first_last", preservePunctuation: true }))
    .join(" ");
}

function retimeCensorIntervalForScenes(
  range: SourceRange,
  sceneBlocks: readonly SceneBlock[],
): SourceRange[] {
  if (sceneBlocks.length === 0) return [range];
  let insertedBeforeSec = 0;
  const anchors = [...sceneBlocks]
    .sort((left, right) => left.anchorSec - right.anchorSec || left.id.localeCompare(right.id))
    .map((block) => {
      const baseAnchorSec = block.anchorSec - insertedBeforeSec;
      insertedBeforeSec += block.durationSec;
      return { block, baseAnchorSec };
    });
  const shiftAt = (timeSec: number) => anchors
    .filter(({ baseAnchorSec }) => baseAnchorSec <= timeSec)
    .reduce((total, { block }) => total + block.durationSec, 0);
  const boundaries = [
    range.startSec,
    ...anchors
      .map(({ baseAnchorSec }) => baseAnchorSec)
      .filter((anchor) => anchor > range.startSec && anchor < range.endSec),
    range.endSec,
  ];
  return boundaries.slice(0, -1).map((startSec, index) => {
    const endSec = boundaries[index + 1]!;
    return {
      startSec: roundSix(startSec + shiftAt(startSec)),
      endSec: roundSix(
        endSec + shiftAt(Math.max(startSec, endSec - 0.000_001)),
      ),
    };
  });
}

function sameCensorIntervalPolicy(
  left: Omit<CensorAudioInterval, "startSec" | "endSec" | "fadeInSec" | "fadeOutSec">,
  right: Omit<CensorAudioInterval, "startSec" | "endSec" | "fadeInSec" | "fadeOutSec">,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function normalizeCensorAudioSchedule(
  input: NormalizeCensorAudioScheduleInput,
): CensorAudioInterval[] {
  const editedTimeMap = buildClipCutPlan([...input.deletedRanges], input.clipWindow).map;
  const prepared = input.segments.flatMap((segment) => {
    if (!segment.enabled || segment.treatment === "caption_mask") return [];
    const sourceRange = {
      startSec: Math.max(
        input.clipWindow.startSec,
        segment.sourceStartSec - segment.paddingSec,
      ),
      endSec: Math.min(
        input.clipWindow.endSec,
        segment.sourceEndSec + segment.paddingSec,
      ),
    };
    const editedRange = sourceRangeToEditedForAudio(editedTimeMap, sourceRange);
    if (!editedRange) return [];
    const policy = segment.treatment === "mute"
      ? ({ treatment: "mute" as const })
      : segment.beepSettings
        ? ({
            treatment: "beep" as const,
            frequencyHz: segment.beepSettings.frequencyHz,
            gain: roundSix(Math.min(0.95, 10 ** (segment.beepSettings.levelDb / 20))),
          })
        : null;
    if (!policy) return [];
    return retimeCensorIntervalForScenes(
      editedRange,
      input.sceneBlocks ?? [],
    ).map((range) => ({ ...range, id: segment.id, policy }));
  });
  const boundaries = [...new Set(prepared.flatMap((entry) => [entry.startSec, entry.endSec]))]
    .sort((left, right) => left - right);
  const atomic: Array<{
    startSec: number;
    endSec: number;
    policy: (typeof prepared)[number]["policy"];
  }> = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startSec = boundaries[index]!;
    const endSec = boundaries[index + 1]!;
    if (endSec <= startSec) continue;
    const active = prepared
      .filter((entry) => entry.startSec < endSec && entry.endSec > startSec)
      .sort((left, right) => left.id.localeCompare(right.id));
    const winner = active.find((entry) => entry.policy.treatment === "mute") ?? active[0];
    if (!winner) continue;
    const previous = atomic[atomic.length - 1];
    if (
      previous &&
      previous.endSec === startSec &&
      sameCensorIntervalPolicy(previous.policy, winner.policy)
    ) {
      previous.endSec = endSec;
    } else {
      atomic.push({ startSec, endSec, policy: winner.policy });
    }
  }
  return atomic.map(({ startSec, endSec, policy }) => {
    if (policy.treatment === "mute") {
      return { startSec: roundSix(startSec), endSec: roundSix(endSec), treatment: "mute" };
    }
    const durationSec = endSec - startSec;
    const fadeSec = roundSix(Math.min(0.015, durationSec / 2));
    return {
      startSec: roundSix(startSec),
      endSec: roundSix(endSec),
      treatment: "beep",
      frequencyHz: policy.frequencyHz,
      gain: policy.gain,
      fadeInSec: fadeSec,
      fadeOutSec: fadeSec,
    };
  });
}

export function autoCensorWordId(input: {
  utteranceIndex: number;
  wordIndex: number;
  word: AutoCensorTranscriptWord;
  locale?: string;
}): string {
  if (input.word.id) return input.word.id;
  return `word:${input.utteranceIndex}:${input.wordIndex}:${hash64(
    JSON.stringify({
      // Word identities must survive a locale setting change. The selected
      // locale chooses policy terms, but it cannot change which stored word
      // an already-applied Censor Segment references.
      text: normalizeToken(input.word.word, "und"),
      startSec: input.word.startSec,
      endSec: input.word.endSec,
    }),
  ).slice(0, 32)}`;
}

export function isCensorSegmentStale(
  segment: CensorSegment,
  transcript: readonly AutoCensorTranscriptUtterance[],
): boolean {
  const currentWordIds = new Set(
    transcript.flatMap((utterance) =>
      utterance.words.map((word, wordIndex) =>
        autoCensorWordId({
          utteranceIndex: utterance.index,
          wordIndex,
          word,
        }),
      ),
    ),
  );
  return segment.sourceWordIds.some(
    (sourceWordId) => !currentWordIds.has(sourceWordId),
  );
}

export function detectAutoCensorSuggestions(
  input: DetectAutoCensorSuggestionsInput,
): AutoCensorSuggestion[] {
  const locale = normalizeLocaleTag(input.locale);
  const editedTimeMap = buildClipCutPlan([...(input.deletedRanges ?? [])], input.clipWindow).map;
  const words = input.transcript.flatMap((utterance) =>
    utterance.words.flatMap((word, wordIndex) => {
      const removed = word.startSec !== null && word.endSec !== null &&
        sourceWordToEdited(editedTimeMap, {
          startSec: word.startSec,
          endSec: word.endSec,
        }) === null;
      return removed ? [] : [{
        utterance,
        word,
        wordIndex,
        normalized: normalizeToken(word.word, locale),
        base: withoutContraction(normalizeToken(word.word, locale)),
      }];
    }),
  );
  const policyTerms: AutoCensorPolicyTerm[] = [
    ...input.workspaceTerms.map((value) => ({
      value,
      source: "workspace" as const,
      category: censorWordCategory(value),
    })),
    ...input.brandTerms.map((value) => ({
      value,
      source: "brand_profile" as const,
      category: "custom" as const,
    })),
    ...input.projectTerms.map((value) => ({
      value,
      source: "project" as const,
      category: "custom" as const,
    })),
  ];
  const compiledTerms = policyTerms.flatMap((term) => {
    const tokens = term.value
      .trim()
      .split(/\s+/)
      .map((raw): CompiledTermToken => {
        const stem = censorWildcardStem(raw);
        return { text: normalizeToken(stem ?? raw, locale), wildcard: stem !== null };
      })
      .filter((token) => token.text);
    // A stem that short would match half the transcript; skip the whole term.
    const tooBroad = tokens.some(
      (token) => token.wildcard && [...token.text].length < CENSOR_STEM_MIN_LENGTH,
    );
    return tokens.length > 0 && !tooBroad ? [{ ...term, tokens }] : [];
  });
  const candidates = words.flatMap((entry, flatIndex) =>
    compiledTerms.flatMap((term) => {
      const length = matchTermLength(words, flatIndex, term.tokens);
      if (length === null) return [];
      const span = words.slice(flatIndex, flatIndex + length);
      if (span.some((candidate) => candidate.utterance.index !== entry.utterance.index)) {
        return [];
      }
      return [{ flatIndex, span, term }];
    }),
  );
  const sourcePriority: Record<AutoCensorPolicySource, number> = {
    workspace: 1,
    brand_profile: 2,
    project: 3,
  };
  candidates.sort(
    (left, right) =>
      left.flatIndex - right.flatIndex ||
      right.span.length - left.span.length ||
      sourcePriority[right.term.source] - sourcePriority[left.term.source] ||
      left.term.value.localeCompare(right.term.value),
  );
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    const candidateEnd = candidate.flatIndex + candidate.span.length;
    const overlaps = selected.some((earlier) => {
      const earlierEnd = earlier.flatIndex + earlier.span.length;
      return candidate.flatIndex < earlierEnd && candidateEnd > earlier.flatIndex;
    });
    if (!overlaps) selected.push(candidate);
  }

  return selected.map(({ flatIndex, span, term }) => {
    const first = span[0]!;
    const last = span[span.length - 1]!;
    // Every word must carry times, but only the span as a whole needs length:
    // providers time some CJK characters and punctuation at zero duration, and
    // one such token must not leave a whole match unbleepable.
    const timed =
      span.every(({ word }) => word.startSec !== null && word.endSec !== null) &&
      last.word.endSec! > first.word.startSec!;
    const sourceWordIds = span.map(({ utterance, wordIndex, word }) =>
      autoCensorWordId({
        utteranceIndex: utterance.index,
        wordIndex,
        word,
        locale: input.locale,
      }),
    );
    const sourceStartSec = timed ? first.word.startSec : null;
    const sourceEndSec = timed ? last.word.endSec : null;
    const audioStartSec = timed
      ? roundMillis(
          Math.max(input.clipWindow.startSec, sourceStartSec! - input.paddingSec),
        )
      : null;
    const audioEndSec = timed
      ? roundMillis(
          Math.min(input.clipWindow.endSec, sourceEndSec! + input.paddingSec),
        )
      : null;
    const fingerprint = hash64(
      JSON.stringify({
        documentRevision: input.documentRevision,
        policyVersion: AUTO_CENSOR_POLICY_VERSION,
        policySource: term.source,
        policyTerm: term.tokens,
        sourceWordIds,
        paddingSec: input.paddingSec,
      }),
    );
    const confidences = span
      .map(({ word }) => word.confidence)
      .filter((value): value is number => value !== null);
    return {
        fingerprint,
        policyVersion: AUTO_CENSOR_POLICY_VERSION,
        policySource: term.source,
        policyCategory: term.category,
        matchedText: joinTranscriptWords(span.map(({ word }) => word)),
        contextBefore: joinTranscriptWords(
          words
            .slice(Math.max(0, flatIndex - 3), flatIndex)
            .map((entry) => entry.word),
        ),
        contextAfter: joinTranscriptWords(
          words
            .slice(flatIndex + span.length, flatIndex + span.length + 3)
            .map((entry) => entry.word),
        ),
        sourceWordIds,
        sourceStartSec,
        sourceEndSec,
        audioStartSec,
        audioEndSec,
        confidence: confidences.length > 0 ? Math.min(...confidences) : null,
        timingLimitation: timed ? null : ("caption_only" as const),
      };
  });
}
