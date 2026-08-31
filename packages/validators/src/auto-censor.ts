import type { CensorSegment } from "./timed-edits";
import {
  buildEditedTimeMap,
  sourceRangeToEdited,
  type ClipWindow,
  type SourceRange,
} from "./edit-ranges";

export const AUTO_CENSOR_DETECTOR_VERSION = 1 as const;
export const AUTO_CENSOR_POLICY_VERSION =
  "auto-censor:multilingual-2026-08-31:v2";
export const AUTO_CENSOR_DEFAULT_PADDING_SEC = 0.08;
export const AUTO_CENSOR_DEFAULT_BEEP = {
  frequencyHz: 1_000,
  levelDb: -12,
} as const;
export const CENSOR_BEEP_FADE_SEC = 0.008;

export type AutoCensorTreatment = CensorSegment["treatment"];
export type AutoCensorPolicySourceKind =
  | "built_in"
  | "brand_profile"
  | "project";
export type AutoCensorPolicyCategory =
  | "profanity"
  | "identity_slur"
  | "custom";

export interface AutoCensorTerm {
  readonly phrase: string;
  readonly treatment?: AutoCensorTreatment;
  readonly category?: AutoCensorPolicyCategory;
}

export interface AutoCensorTranscriptWord {
  readonly word: string;
  readonly startSec: number | null;
  readonly endSec: number | null;
  readonly confidence?: number | null;
}

export interface AutoCensorTranscriptUtterance {
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly words: readonly AutoCensorTranscriptWord[];
}

export interface AutoCensorScanInput {
  readonly documentRevision: number;
  readonly locale: string;
  readonly clipWindow: ClipWindow;
  readonly transcript: readonly AutoCensorTranscriptUtterance[];
  readonly paddingSec?: number;
  readonly defaultTreatment: AutoCensorTreatment;
  readonly brandTerms?: readonly AutoCensorTerm[];
  readonly projectTerms?: readonly AutoCensorTerm[];
}

export interface AutoCensorSuggestion {
  readonly fingerprint: string;
  readonly policyVersion: typeof AUTO_CENSOR_POLICY_VERSION;
  readonly policySource: {
    readonly kind: AutoCensorPolicySourceKind;
    readonly id: string;
    /** The matched category only. The policy library itself is never returned. */
    readonly category: AutoCensorPolicyCategory;
  };
  readonly sourceWordIds: readonly string[];
  /** Padded, clip-clamped source interval used by scan review. */
  readonly sourceRange: SourceRange | null;
  /** Exact word interval persisted on a Censor Segment; padding stays separate. */
  readonly wordSourceRange: SourceRange | null;
  /** A bounded utterance fallback that permits caption-only treatment when
   * the matching transcript words do not have word-level timing. */
  readonly captionSourceRange: SourceRange | null;
  readonly paddingSec: number;
  readonly proposedTreatment: AutoCensorTreatment;
  readonly confidence: number | null;
  readonly limitation: "caption_only_untimed" | null;
  readonly context: {
    readonly before: readonly string[];
    readonly match: readonly string[];
    readonly after: readonly string[];
  };
}

export interface AutoCensorScanResult {
  readonly detectorVersion: typeof AUTO_CENSOR_DETECTOR_VERSION;
  readonly policyVersion: typeof AUTO_CENSOR_POLICY_VERSION;
  readonly documentRevision: number;
  readonly suggestions: readonly AutoCensorSuggestion[];
}

const profanity = (phrase: string): AutoCensorTerm => ({
  phrase,
  category: "profanity",
});
const identitySlur = (phrase: string): AutoCensorTerm => ({
  phrase,
  category: "identity_slur",
});

/**
 * Curated, bounded first-release policies. Keep this data private to the
 * detector: the UI sees only categories for transcript matches and never a
 * browsable/exportable library. Unsupported locales deliberately have no
 * built-in matches instead of silently applying an English policy.
 */
const BUILT_IN_TERMS: Readonly<Record<string, readonly AutoCensorTerm[]>> = {
  en: [
    ...[
      "damn",
      "fuck",
      "fucking",
      "shit",
      "bullshit",
      "bitch",
      "bastard",
      "asshole",
      "dick",
      "piss",
      "crap",
      "motherfucker",
    ].map(profanity),
    ...[
      "nigger",
      "nigga",
      "faggot",
      "retard",
      "chink",
      "kike",
      "spic",
      "tranny",
    ].map(identitySlur),
  ],
  es: [
    ...["mierda", "joder", "puta", "puto", "cabrón", "coño", "gilipollas"].map(
      profanity,
    ),
    ...["maricón", "sudaca"].map(identitySlur),
  ],
  fr: [
    ...["merde", "putain", "connard", "salope", "enculé"].map(profanity),
    ...["pédé", "bougnoule"].map(identitySlur),
  ],
  de: [
    ...["scheiße", "verfickt", "arschloch", "hurensohn"].map(profanity),
    ...["schwuchtel", "kanake"].map(identitySlur),
  ],
  pt: [
    ...["merda", "porra", "caralho", "puta", "filho da puta"].map(profanity),
    ...["viado", "bicha"].map(identitySlur),
  ],
  it: [
    ...["merda", "cazzo", "stronzo", "puttana"].map(profanity),
    ...["frocio", "terrone"].map(identitySlur),
  ],
};

function stableHex(value: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds
    .map((seed) => {
      let hash = seed >>> 0;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return hash.toString(16).padStart(8, "0");
    })
    .join("");
}

function roundMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function normalizedLocale(locale: string): string {
  const language = locale.trim().replaceAll("_", "-").split("-")[0];
  return language?.toLowerCase() || "en";
}

function normalizeToken(value: string, locale: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase(locale)
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

function normalizeIdentityToken(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

export function autoCensorWordId(input: {
  utteranceIndex: number;
  wordIndex: number;
  word: AutoCensorTranscriptWord;
  locale?: string;
}): string {
  // Source-word identity must not depend on the scan locale. The locale may
  // change between review and export, while the corrected transcript word
  // itself remains the same durable fact.
  const normalized = normalizeIdentityToken(input.word.word);
  const identity = JSON.stringify([
    normalized,
    input.word.startSec,
    input.word.endSec,
  ]);
  return `word:${input.utteranceIndex}:${input.wordIndex}:${stableHex(identity)}`;
}

interface FlatWord {
  readonly id: string;
  readonly text: string;
  readonly normalized: string;
  readonly startSec: number | null;
  readonly endSec: number | null;
  readonly confidence: number | null;
  readonly utteranceIndex: number;
  readonly utteranceStartSec: number;
  readonly utteranceEndSec: number;
}

interface ResolvedTerm {
  readonly normalizedWords: readonly string[];
  readonly treatment: AutoCensorTreatment;
  readonly source: AutoCensorPolicySourceKind;
  readonly sourceId: string;
  readonly category: AutoCensorPolicyCategory;
  readonly priority: number;
}

function flattenWords(input: AutoCensorScanInput, locale: string): FlatWord[] {
  return input.transcript.flatMap((utterance) =>
    utterance.words.map((word, wordIndex) => ({
      id: autoCensorWordId({
        utteranceIndex: utterance.index,
        wordIndex,
        word,
        locale,
      }),
      text: word.word,
      normalized: normalizeToken(word.word, locale),
      startSec:
        word.startSec !== null && Number.isFinite(word.startSec)
          ? word.startSec
          : null,
      endSec:
        word.endSec !== null && Number.isFinite(word.endSec)
          ? word.endSec
          : null,
      confidence:
        typeof word.confidence === "number" && Number.isFinite(word.confidence)
          ? Math.max(0, Math.min(1, word.confidence))
          : null,
      utteranceIndex: utterance.index,
      utteranceStartSec: utterance.startSec,
      utteranceEndSec: utterance.endSec,
    })),
  );
}

function resolveTerms(input: AutoCensorScanInput, locale: string): ResolvedTerm[] {
  const sources: ReadonlyArray<{
    source: AutoCensorPolicySourceKind;
    priority: number;
    terms: readonly AutoCensorTerm[];
  }> = [
    { source: "built_in", priority: 1, terms: BUILT_IN_TERMS[locale] ?? [] },
    { source: "brand_profile", priority: 2, terms: input.brandTerms ?? [] },
    { source: "project", priority: 3, terms: input.projectTerms ?? [] },
  ];
  const byPhrase = new Map<string, ResolvedTerm>();
  for (const entry of sources) {
    for (const term of entry.terms.slice(0, 100)) {
      const normalizedWords = term.phrase
        .trim()
        .split(/\s+/u)
        .map((word) => normalizeToken(word, locale))
        .filter(Boolean)
        .slice(0, 16);
      if (normalizedWords.length === 0) continue;
      const normalizedPhrase = normalizedWords.join(" ");
      const resolved: ResolvedTerm = {
        normalizedWords,
        treatment: term.treatment ?? input.defaultTreatment,
        source: entry.source,
        sourceId:
          entry.source === "built_in"
            ? `built-in:${locale}:v2`
            : `${entry.source}:${stableHex(normalizedPhrase)}`,
        category: term.category ?? "custom",
        priority: entry.priority,
      };
      const current = byPhrase.get(normalizedPhrase);
      if (!current || current.priority <= resolved.priority) {
        byPhrase.set(normalizedPhrase, resolved);
      }
    }
  }
  return [...byPhrase.values()];
}

export function scanAutoCensor(input: AutoCensorScanInput): AutoCensorScanResult {
  const locale = normalizedLocale(input.locale);
  const words = flattenWords(input, locale);
  const terms = resolveTerms(input, locale);
  const candidates: Array<{
    start: number;
    end: number;
    term: ResolvedTerm;
  }> = [];
  for (let start = 0; start < words.length; start += 1) {
    for (const term of terms) {
      const end = start + term.normalizedWords.length;
      if (end > words.length) continue;
      if (
        term.normalizedWords.every((expected, offset) => {
          const word = words[start + offset]!;
          return word.normalized === expected &&
            word.utteranceIndex === words[start]!.utteranceIndex;
        })
      ) {
        candidates.push({ start, end, term });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      left.start - right.start ||
      (right.end - right.start) - (left.end - left.start) ||
      right.term.priority - left.term.priority ||
      left.term.sourceId.localeCompare(right.term.sourceId),
  );

  const accepted: typeof candidates = [];
  const occupied = new Set<number>();
  for (const candidate of candidates) {
    if (
      Array.from(
        { length: candidate.end - candidate.start },
        (_, offset) => candidate.start + offset,
      ).some((index) => occupied.has(index))
    ) {
      continue;
    }
    accepted.push(candidate);
    for (let index = candidate.start; index < candidate.end; index += 1) {
      occupied.add(index);
    }
  }
  accepted.sort((left, right) => left.start - right.start);

  const paddingSec = Math.max(
    0,
    Math.min(1, input.paddingSec ?? AUTO_CENSOR_DEFAULT_PADDING_SEC),
  );
  const suggestions = accepted.map(({ start, end, term }) => {
    const match = words.slice(start, end);
    const timed = match.every(
      (word) =>
        word.startSec !== null &&
        word.endSec !== null &&
        word.endSec > word.startSec,
    );
    const wordSourceRange = timed
      ? {
          startSec: match[0]!.startSec!,
          endSec: match[match.length - 1]!.endSec!,
        }
      : null;
    const sourceRange = wordSourceRange
      ? {
          startSec: roundMs(
            Math.max(input.clipWindow.startSec, wordSourceRange.startSec - paddingSec),
          ),
          endSec: roundMs(
            Math.min(input.clipWindow.endSec, wordSourceRange.endSec + paddingSec),
          ),
        }
      : null;
    const fallbackStartSec = Math.max(
      input.clipWindow.startSec,
      match[0]!.utteranceStartSec,
    );
    const fallbackEndSec = Math.min(
      input.clipWindow.endSec,
      match[match.length - 1]!.utteranceEndSec,
    );
    const captionSourceRange = wordSourceRange ?? (
      Number.isFinite(fallbackStartSec) &&
      Number.isFinite(fallbackEndSec) &&
      fallbackEndSec > fallbackStartSec
        ? { startSec: roundMs(fallbackStartSec), endSec: roundMs(fallbackEndSec) }
        : null
    );
    const treatment = timed ? term.treatment : "caption_mask";
    const sourceWordIds = match.map((word) => word.id);
    const fingerprint = stableHex(
      JSON.stringify({
        documentRevision: input.documentRevision,
        policyVersion: AUTO_CENSOR_POLICY_VERSION,
        source: term.source,
        sourceId: term.sourceId,
        sourceWordIds,
        treatment,
        paddingSec,
      }),
    );
    const confidences = match.flatMap((word) =>
      word.confidence === null ? [] : [word.confidence],
    );
    return {
      fingerprint,
      policyVersion: AUTO_CENSOR_POLICY_VERSION,
      policySource: {
        kind: term.source,
        id: term.sourceId,
        category: term.category,
      },
      sourceWordIds,
      sourceRange,
      wordSourceRange,
      captionSourceRange,
      paddingSec,
      proposedTreatment: treatment,
      confidence: confidences.length > 0 ? Math.min(...confidences) : null,
      limitation: timed ? null : "caption_only_untimed",
      context: {
        before: words.slice(Math.max(0, start - 3), start).map((word) => word.text),
        match: match.map((word) => word.text),
        after: words.slice(end, end + 3).map((word) => word.text),
      },
    } satisfies AutoCensorSuggestion;
  });

  return {
    detectorVersion: AUTO_CENSOR_DETECTOR_VERSION,
    policyVersion: AUTO_CENSOR_POLICY_VERSION,
    documentRevision: input.documentRevision,
    suggestions,
  };
}

export function autoCensorSuggestionIsCurrent(
  suggestion: AutoCensorSuggestion,
  current: AutoCensorScanInput,
): boolean {
  return scanAutoCensor(current).suggestions.some(
    (candidate) => candidate.fingerprint === suggestion.fingerprint,
  );
}

export function censorSegmentFromSuggestion(
  suggestion: AutoCensorSuggestion,
  id: string,
  treatment: AutoCensorTreatment = suggestion.proposedTreatment,
): CensorSegment | null {
  const persistedRange = treatment === "caption_mask"
    ? suggestion.wordSourceRange ?? suggestion.captionSourceRange
    : suggestion.wordSourceRange;
  if (!persistedRange) return null;
  return {
    schemaVersion: 1,
    id,
    sourceWordIds: [...suggestion.sourceWordIds],
    sourceStartSec: persistedRange.startSec,
    sourceEndSec: persistedRange.endSec,
    treatment,
    paddingSec: suggestion.paddingSec,
    beepSettings: treatment === "beep" ? { ...AUTO_CENSOR_DEFAULT_BEEP } : null,
    captionMaskPolicy:
      treatment === "caption_mask"
        ? { replacement: "asterisks", preservePunctuation: true }
        : null,
    suggestionFingerprint: suggestion.fingerprint,
    policyVersion: suggestion.policyVersion,
    enabled: true,
  };
}

/** Detects whether an auto-applied segment still references the exact current
 * corrected transcript words. Manual segments have no suggestion fingerprint
 * and therefore do not become stale through this policy. */
export function autoCensorSegmentIsCurrent(
  segment: CensorSegment,
  transcript: readonly AutoCensorTranscriptUtterance[],
): boolean {
  if (segment.suggestionFingerprint === null) return true;
  const currentWordIds = new Set(
    transcript.flatMap((utterance) =>
      utterance.words.map((word, wordIndex) =>
        autoCensorWordId({
          utteranceIndex: utterance.index,
          wordIndex,
          word,
        })),
    ),
  );
  return segment.sourceWordIds.every((wordId) => currentWordIds.has(wordId));
}

function graphemes(value: string): string[] {
  const Segmenter = Reflect.get(Intl, "Segmenter") as
    | (new (
        locale?: string,
        options?: { granularity: "grapheme" },
      ) => { segment(input: string): Iterable<{ segment: string }> })
    | undefined;
  if (!Segmenter) return Array.from(value);
  return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
    .map((part) => part.segment);
}

export function maskCaptionWord(
  value: string,
  policy: NonNullable<CensorSegment["captionMaskPolicy"]>,
): string {
  const items = graphemes(value);
  const maskable = (item: string) =>
    !policy.preservePunctuation || /[\p{L}\p{N}\p{M}]/u.test(item);
  const firstMaskable = items.findIndex(maskable);
  const replacement = policy.replacement === "full_block" ? "█" : "*";
  return items
    .map((item, index) => {
      if (!maskable(item)) return item;
      if (policy.replacement === "first_character" && index === firstMaskable) {
        return item;
      }
      return replacement;
    })
    .join("");
}

export interface CompositionCensorMuteInterval {
  readonly kind: "mute";
  readonly activeRange: SourceRange;
}

export interface CompositionCensorBeepInterval {
  readonly kind: "beep";
  readonly activeRange: SourceRange;
  readonly frequencyHz: number;
  readonly gain: number;
  readonly fades: {
    readonly fadeInSec: number;
    readonly fadeOutSec: number;
  };
}

export type CompositionCensorAudioInterval =
  | CompositionCensorMuteInterval
  | CompositionCensorBeepInterval;

interface RawCensorAudioInterval {
  readonly kind: "mute" | "beep";
  readonly activeRange: SourceRange;
  readonly sourceId: string;
  readonly frequencyHz?: number;
  readonly gain?: number;
}

function mapAroundSceneBlocks(
  range: SourceRange,
  sceneBlocks: readonly { anchorSec: number; durationSec: number }[],
): SourceRange[] {
  let insertedBeforeSec = 0;
  const anchors = [...sceneBlocks]
    .sort(
      (left, right) =>
        left.anchorSec - right.anchorSec || left.durationSec - right.durationSec,
    )
    .map((scene) => {
      const baseAnchorSec = scene.anchorSec - insertedBeforeSec;
      insertedBeforeSec += scene.durationSec;
      return { ...scene, baseAnchorSec };
    });
  const boundaries = [
    range.startSec,
    ...anchors
      .map((anchor) => anchor.baseAnchorSec)
      .filter((anchor) => anchor > range.startSec && anchor < range.endSec),
    range.endSec,
  ];
  const shiftAt = (timeSec: number) =>
    anchors
      .filter((anchor) => anchor.baseAnchorSec <= timeSec)
      .reduce((sum, anchor) => sum + anchor.durationSec, 0);
  return boundaries.slice(0, -1).map((startSec, index) => {
    const endSec = boundaries[index + 1]!;
    return {
      startSec: roundMs(startSec + shiftAt(startSec)),
      endSec: roundMs(
        endSec + shiftAt(Math.max(startSec, endSec - 0.000_001)),
      ),
    };
  });
}

function intervalKey(interval: CompositionCensorAudioInterval): string {
  return interval.kind === "mute"
    ? "mute"
    : `beep:${interval.frequencyHz}:${interval.gain}:${interval.fades.fadeInSec}:${interval.fades.fadeOutSec}`;
}

export function resolveCensorAudioIntervals(input: {
  readonly clipWindow: ClipWindow;
  readonly deletedRanges: readonly SourceRange[];
  readonly sceneBlocks: readonly { anchorSec: number; durationSec: number }[];
  readonly segments: readonly CensorSegment[];
}): CompositionCensorAudioInterval[] {
  const editedTimeMap = buildEditedTimeMap([...input.deletedRanges], input.clipWindow);
  const raw: RawCensorAudioInterval[] = [];
  for (const segment of input.segments) {
    if (!segment.enabled || segment.treatment === "caption_mask") continue;
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
    const editedRange = sourceRangeToEdited(editedTimeMap, sourceRange);
    if (!editedRange) continue;
    for (const activeRange of mapAroundSceneBlocks(editedRange, input.sceneBlocks)) {
      if (activeRange.endSec <= activeRange.startSec) continue;
      raw.push({
        kind: segment.treatment,
        activeRange,
        sourceId: segment.id,
        ...(segment.treatment === "beep"
          ? {
              frequencyHz:
                segment.beepSettings?.frequencyHz ??
                AUTO_CENSOR_DEFAULT_BEEP.frequencyHz,
              gain: 10 **
                ((segment.beepSettings?.levelDb ??
                  AUTO_CENSOR_DEFAULT_BEEP.levelDb) /
                  20),
            }
          : {}),
      });
    }
  }
  const boundaries = [...new Set(raw.flatMap((interval) => [
    interval.activeRange.startSec,
    interval.activeRange.endSec,
  ]))].sort((left, right) => left - right);
  const normalized: CompositionCensorAudioInterval[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startSec = boundaries[index]!;
    const endSec = boundaries[index + 1]!;
    if (endSec <= startSec) continue;
    const midpoint = startSec + (endSec - startSec) / 2;
    const active = raw
      .filter(
        (interval) =>
          midpoint >= interval.activeRange.startSec &&
          midpoint < interval.activeRange.endSec,
      )
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    if (active.length === 0) continue;
    const mute = active.find((interval) => interval.kind === "mute");
    const selected = mute ?? active.find((interval) => interval.kind === "beep")!;
    const durationSec = endSec - startSec;
    const next: CompositionCensorAudioInterval =
      selected.kind === "mute"
        ? { kind: "mute", activeRange: { startSec, endSec } }
        : {
            kind: "beep",
            activeRange: { startSec, endSec },
            frequencyHz: selected.frequencyHz!,
            gain: selected.gain!,
            fades: {
              fadeInSec: Math.min(CENSOR_BEEP_FADE_SEC, durationSec / 2),
              fadeOutSec: Math.min(CENSOR_BEEP_FADE_SEC, durationSec / 2),
            },
          };
    const previous = normalized[normalized.length - 1];
    if (
      previous &&
      Math.abs(previous.activeRange.endSec - next.activeRange.startSec) <
        0.000_001 &&
      intervalKey(previous) === intervalKey(next)
    ) {
      normalized[normalized.length - 1] = {
        ...previous,
        activeRange: {
          startSec: previous.activeRange.startSec,
          endSec: next.activeRange.endSec,
        },
      };
    } else {
      normalized.push(next);
    }
  }
  return normalized.map((interval) => {
    if (interval.kind === "mute") return interval;
    const durationSec = interval.activeRange.endSec - interval.activeRange.startSec;
    return {
      ...interval,
      fades: {
        fadeInSec: Math.min(CENSOR_BEEP_FADE_SEC, durationSec / 2),
        fadeOutSec: Math.min(CENSOR_BEEP_FADE_SEC, durationSec / 2),
      },
    };
  });
}

export function censorBeepEnvelopeAt(
  interval: CompositionCensorBeepInterval,
  editedTimeSec: number,
): number {
  const { startSec, endSec } = interval.activeRange;
  if (editedTimeSec <= startSec || editedTimeSec >= endSec) return 0;
  let gain = 1;
  if (interval.fades.fadeInSec > 0) {
    gain = Math.min(
      gain,
      (editedTimeSec - startSec) / interval.fades.fadeInSec,
    );
  }
  if (interval.fades.fadeOutSec > 0) {
    gain = Math.min(
      gain,
      (endSec - editedTimeSec) / interval.fades.fadeOutSec,
    );
  }
  return Math.max(0, Math.min(1, gain));
}

export function autoCensorAnalyticsSummary(
  scan: AutoCensorScanResult,
  appliedSegments: readonly CensorSegment[],
) {
  const current = new Set(scan.suggestions.map((suggestion) => suggestion.fingerprint));
  const resultCount = scan.suggestions.length;
  return {
    detectorVersion: scan.detectorVersion,
    policyVersion: scan.policyVersion,
    resultCountBucket:
      resultCount === 0
        ? "0"
        : resultCount <= 5
          ? "1-5"
          : resultCount <= 20
            ? "6-20"
            : "21+",
    applyCount: appliedSegments.length,
    treatments: {
      beep: appliedSegments.filter((segment) => segment.treatment === "beep").length,
      mute: appliedSegments.filter((segment) => segment.treatment === "mute").length,
      caption_mask: appliedSegments.filter(
        (segment) => segment.treatment === "caption_mask",
      ).length,
    },
    staleCount: appliedSegments.filter(
      (segment) =>
        segment.suggestionFingerprint !== null &&
        !current.has(segment.suggestionFingerprint),
    ).length,
  } as const;
}
