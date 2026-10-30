import type {
  SourceLanguageCodeValue,
  TranscriptExportFormat,
  TranscriptSnapshot,
  TranscriptUtterance,
  TranscriptWord,
} from "@narriflow/validators";
import {
  joinTranscriptWords,
  languageScript,
  normalizeProviderLanguageCode,
  SCRIBE_MODEL_ID,
  splitUtterancesIntoSentences,
  transcriptSnapshotSchema,
} from "@narriflow/validators";

interface ScribeToken {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  type?: unknown;
  speaker_id?: unknown;
  logprob?: unknown;
}

/** The `speech-to-text` transcript object, as the GET returns it and as the
 * webhook carries it under `data.transcription`. */
interface ScribePayload {
  language_code?: unknown;
  language_probability?: unknown;
  text?: unknown;
  words?: unknown;
  transcription_id?: unknown;
}

export interface NormalizedTranscript {
  provider: "elevenlabs";
  providerModel: string;
  providerJobId: string | null;
  providerRequestId: string | null;
  languageCode: string | null;
  languageConfidence: number | null;
  text: string;
  utterances: TranscriptUtterance[];
  speakerCount: number;
  durationSeconds: number | null;
  rawPayload: unknown;
}

export interface NormalizeScribeOptions {
  /** A caption-only generation can finish with no speech. */
  allowEmpty: boolean;
  providerJobId: string | null;
  providerRequestId: string | null;
  /** The source's probed duration; the last word only stands in when unknown. */
  durationSeconds: number | null;
}

/** A malformed provider result. Never retried: polling again returns the same bytes. */
export class TranscriptNormalizationError extends Error {
  code: string;
  readonly retryable = false;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TranscriptNormalizationError";
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new TranscriptNormalizationError("elevenlabs_result_invalid", message);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function formatSpeakerLabel(speaker: number | null) {
  if (speaker === null) {
    return "Speaker";
  }

  return `Speaker ${speaker + 1}`;
}

function formatCueTimestamp(totalSeconds: number, decimalSeparator: "." | ",") {
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.round(
    (safeSeconds - Math.floor(safeSeconds)) * 1000,
  );

  return (
    [
      String(hours).padStart(2, "0"),
      String(minutes).padStart(2, "0"),
      String(seconds).padStart(2, "0"),
    ].join(":") + `${decimalSeparator}${String(milliseconds).padStart(3, "0")}`
  );
}

function formatReadableTimestamp(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const UNKNOWN_SPEAKER = null;

function emptyScribeTranscript(
  payload: ScribePayload,
  options: NormalizeScribeOptions,
  rawPayload: unknown,
): NormalizedTranscript {
  return {
    provider: "elevenlabs",
    providerModel: SCRIBE_MODEL_ID,
    providerJobId: options.providerJobId,
    providerRequestId: options.providerRequestId,
    languageCode: scribeLanguageCode(payload),
    languageConfidence: scribeLanguageConfidence(payload),
    text: "",
    utterances: [],
    speakerCount: 0,
    durationSeconds: options.durationSeconds === null ? null : Math.round(options.durationSeconds),
    rawPayload,
  };
}

function scribeLanguageCode(payload: ScribePayload) {
  return typeof payload.language_code === "string"
    ? normalizeProviderLanguageCode(payload.language_code)
    : null;
}

function scribeLanguageConfidence(payload: ScribePayload) {
  const probability = payload.language_probability;
  return typeof probability === "number" && Number.isFinite(probability)
    ? Math.min(1, Math.max(0, probability))
    : null;
}

/** Scribe's per-word `logprob` is the log of the word's probability, so its
 * exponent is a genuine 0–1 confidence; anything else is no confidence. */
function wordConfidence(logprob: unknown): number | null {
  if (typeof logprob !== "number" || !Number.isFinite(logprob) || logprob > 0) return null;
  return Math.round(Math.exp(logprob) * 10_000) / 10_000;
}

function meanConfidence(words: readonly TranscriptWord[]): number | null {
  const known = words.flatMap((word) => (word.confidence === null ? [] : [word.confidence]));
  if (known.length === 0) return null;
  return Math.round((known.reduce((sum, value) => sum + value, 0) / known.length) * 10_000) / 10_000;
}

interface ScribeWord {
  speaker: number;
  word: TranscriptWord;
}

/** Scribe's word tokens, with `spaceBefore` read from its spacing tokens
 * (zh/ja arrive per character with none) and speakers numbered densely in
 * first-seen order. Spacing and audio events are not words. */
// Scripts that end sentences with the danda (।, ॥). Scribe occasionally emits a
// danda inside a transcript in another script (seen in Urdu); there it becomes
// that language's own full stop so captions stay in one script.
const DANDA_SCRIPTS: ReadonlySet<string> = new Set(["Devanagari", "Bengali", "Gurmukhi", "Oriya", "Gujarati"]);

function foreignDandaReplacement(language: SourceLanguageCodeValue | null): string | null {
  if (!language) return null;
  const script = languageScript(language);
  if (!script || DANDA_SCRIPTS.has(script)) return null;
  return language === "ur" ? "۔" : ".";
}

function scribeWords(tokens: unknown[], language: SourceLanguageCodeValue | null = null): ScribeWord[] {
  const danda = foreignDandaReplacement(language);
  const speakers = new Map<string | typeof UNKNOWN_SPEAKER, number>();
  const words: ScribeWord[] = [];
  let spaceSeen = false;
  for (const entry of tokens) {
    const token = asObject(entry) as ScribeToken | null;
    if (!token) invalid("Scribe returned a malformed word token");
    if (token.type === "spacing") {
      spaceSeen = true;
      continue;
    }
    if (token.type !== "word") continue;
    if (typeof token.text !== "string") invalid("Scribe returned a word without text");
    const trimmed = token.text.trim();
    const text = danda ? trimmed.replace(/[।॥]/gu, danda) : trimmed;
    if (!text) continue;
    const { start, end } = token;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start
    ) {
      invalid("Scribe returned a word with invalid timestamps");
    }
    const rawSpeaker = typeof token.speaker_id === "string" ? token.speaker_id.trim() : "";
    const speakerKey = rawSpeaker || UNKNOWN_SPEAKER;
    let speaker = speakers.get(speakerKey);
    if (speaker === undefined) {
      speaker = speakers.size;
      speakers.set(speakerKey, speaker);
    }
    const previous = words.at(-1);
    const spaced = spaceSeen || /^\s/.test(token.text);
    words.push({
      speaker,
      word: {
        word: text,
        startSec: start,
        endSec: end,
        confidence: wordConfidence(token.logprob),
        ...(previous ? { spaceBefore: spaced } : {}),
      },
    });
    // A trailing space inside the token spaces the next word.
    spaceSeen = /\s$/.test(token.text);
  }
  return words;
}

/** Normalizes a Scribe transcript into speaker turns split at sentence ends.
 * Any malformed content throws a permanent `TranscriptNormalizationError`. */
export function normalizeElevenLabsTranscript(
  rawPayload: unknown,
  options: NormalizeScribeOptions,
): NormalizedTranscript {
  const payload = asObject(rawPayload) as ScribePayload | null;
  if (!payload) invalid("Scribe returned a result that is not an object");
  if (payload.words !== undefined && !Array.isArray(payload.words)) {
    invalid("Scribe returned words that are not a list");
  }
  const words = scribeWords(payload.words ?? [], scribeLanguageCode(payload));

  if (words.length === 0) {
    if (options.allowEmpty) return emptyScribeTranscript(payload, options, rawPayload);
    invalid("Scribe transcript did not include any words");
  }

  const turns: TranscriptUtterance[] = [];
  let run: ScribeWord[] = [];
  const flush = () => {
    const first = run[0];
    if (!first) return;
    const turnWords = run.map((entry) => entry.word);
    turns.push({
      index: turns.length,
      speaker: first.speaker,
      speakerLabel: formatSpeakerLabel(first.speaker),
      startSec: turnWords[0]!.startSec,
      endSec: turnWords.reduce((end, word) => Math.max(end, word.endSec), 0),
      text: joinTranscriptWords(turnWords),
      confidence: meanConfidence(turnWords),
      words: turnWords,
    });
    run = [];
  };
  for (const entry of words) {
    if (run.length > 0 && run[0]!.speaker !== entry.speaker) flush();
    run.push(entry);
  }
  flush();

  // Sentence splitting copies the turn's fields; each sentence's confidence is
  // the mean of its own words.
  const utterances = splitUtterancesIntoSentences(turns).map((utterance) => ({
    ...utterance,
    confidence: meanConfidence(utterance.words),
  }));
  const durationSeconds =
    options.durationSeconds ??
    utterances.reduce((end, utterance) => Math.max(end, utterance.endSec), 0);

  return {
    provider: "elevenlabs",
    providerModel: SCRIBE_MODEL_ID,
    providerJobId: options.providerJobId,
    providerRequestId: options.providerRequestId,
    languageCode: scribeLanguageCode(payload),
    languageConfidence: scribeLanguageConfidence(payload),
    text: utterances.map((utterance) => utterance.text).join("\n\n"),
    utterances,
    speakerCount: new Set(utterances.map((utterance) => utterance.speaker)).size,
    durationSeconds: Math.round(durationSeconds),
    rawPayload,
  };
}

export function buildTranscriptSnapshot(input: {
  projectId: string;
  status: string;
  provider: string | null;
  providerModel: string | null;
  providerJobId: string | null;
  languageCode: string | null;
  languageConfidence: number | null;
  text: string | null;
  utterancesJson: unknown;
  speakerCount: number | null;
  durationSeconds: number | null;
  errorCode: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}): TranscriptSnapshot {
  const utterances = Array.isArray(input.utterancesJson)
    ? input.utterancesJson
    : asObject(input.utterancesJson)?.utterances;

  return transcriptSnapshotSchema.parse({
    projectId: input.projectId,
    status: input.status,
    provider: input.provider,
    providerModel: input.providerModel,
    providerJobId: input.providerJobId,
    languageCode: input.languageCode,
    languageConfidence: input.languageConfidence,
    text: input.text,
    utterances: Array.isArray(utterances) ? utterances : [],
    speakerCount: input.speakerCount,
    durationSeconds: input.durationSeconds,
    errorCode: input.errorCode,
    completedAt: input.completedAt,
    updatedAt: input.updatedAt,
  });
}

/** Words give the exact spacing the provider reported (none between Chinese
 * or Japanese characters); the stored text is the fallback for hand-built
 * utterances without words. */
function utteranceExportText(utterance: TranscriptSnapshot["utterances"][number]) {
  return utterance.words.length > 0
    ? joinTranscriptWords(utterance.words) || utterance.text
    : utterance.text;
}

export function exportTranscript(
  snapshot: TranscriptSnapshot,
  format: TranscriptExportFormat,
) {
  if (format === "txt") {
    if (snapshot.utterances.length === 0) {
      return snapshot.text ?? "";
    }

    return snapshot.utterances
      .map(
        (utterance) =>
          `[${formatReadableTimestamp(utterance.startSec)}] ${utterance.speakerLabel}: ${utteranceExportText(utterance)}`,
      )
      .join("\n");
  }

  const cues = snapshot.utterances.map((utterance, index) => {
    const start = formatCueTimestamp(
      utterance.startSec,
      format === "srt" ? "," : ".",
    );
    const end = formatCueTimestamp(
      utterance.endSec,
      format === "srt" ? "," : ".",
    );
    const body = `${utterance.speakerLabel}: ${utteranceExportText(utterance)}`;

    if (format === "srt") {
      return `${index + 1}\n${start} --> ${end}\n${body}`;
    }

    return `${start} --> ${end}\n${body}`;
  });

  if (format === "vtt") {
    return ["WEBVTT", "", ...cues].join("\n\n");
  }

  return cues.join("\n\n");
}
