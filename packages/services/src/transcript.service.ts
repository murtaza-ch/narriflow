import type {
  TranscriptExportFormat,
  TranscriptSnapshot,
  TranscriptUtterance,
} from "@narriflow/validators";
import { transcriptSnapshotSchema } from "@narriflow/validators";

interface AssemblyAiWord {
  start?: number;
  end?: number;
  text?: string;
  confidence?: number;
  speaker?: string | null;
}

interface AssemblyAiUtterance {
  confidence?: number;
  end?: number;
  speaker?: string | null;
  start?: number;
  text?: string;
  words?: AssemblyAiWord[];
}

interface AssemblyAiPayload {
  id?: string;
  text?: string;
  language_code?: string;
  speech_model?: string;
  speech_model_used?: string;
  speech_models?: string[];
  audio_duration?: number;
  utterances?: AssemblyAiUtterance[];
}

export interface NormalizedTranscript {
  provider: "assemblyai";
  providerModel: string | null;
  providerJobId: string | null;
  languageCode: string | null;
  text: string;
  utterances: TranscriptUtterance[];
  speakerCount: number;
  durationSeconds: number | null;
  rawPayload: unknown;
}

export class TranscriptNormalizationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TranscriptNormalizationError";
    this.code = code;
  }
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

function coerceUtteranceText(utterance: AssemblyAiUtterance) {
  const direct = utterance.text?.trim();

  if (direct) {
    return direct;
  }

  const fromWords = (utterance.words ?? [])
    .map((word) => word.text ?? "")
    .join(" ")
    .trim();

  return fromWords;
}

function millisecondsToSeconds(value: number) {
  return Math.round((value / 1000) * 1000) / 1000;
}

function getAssemblyAiProviderModel(payload: AssemblyAiPayload) {
  return payload.speech_model_used ?? payload.speech_model ?? null;
}

function getSpeakerIndex(
  speakerLabel: string,
  speakerMap: Map<string, number>,
) {
  const existing = speakerMap.get(speakerLabel);

  if (existing !== undefined) {
    return existing;
  }

  const next = speakerMap.size;
  speakerMap.set(speakerLabel, next);
  return next;
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

export function normalizeAssemblyAiTranscript(
  rawPayload: unknown,
): NormalizedTranscript {
  const payload = rawPayload as AssemblyAiPayload;
  const utterances = payload.utterances ?? [];

  if (utterances.length === 0) {
    throw new TranscriptNormalizationError(
      "assemblyai_utterances_missing",
      "AssemblyAI transcript did not include diarized utterances",
    );
  }

  const speakerMap = new Map<string, number>();
  const normalizedUtterances = utterances
    .map((utterance, index): TranscriptUtterance | null => {
      const text = coerceUtteranceText(utterance);
      const startSec = millisecondsToSeconds(
        typeof utterance.start === "number" ? utterance.start : 0,
      );
      const endSec = millisecondsToSeconds(
        typeof utterance.end === "number" ? utterance.end : utterance.start ?? 0,
      );
      const rawSpeaker =
        typeof utterance.speaker === "string" ? utterance.speaker.trim() : "";

      if (!text) {
        return null;
      }

      if (!rawSpeaker) {
        throw new TranscriptNormalizationError(
          "assemblyai_speaker_labels_missing",
          "AssemblyAI utterance was missing a speaker label",
        );
      }

      const speaker = getSpeakerIndex(rawSpeaker, speakerMap);
      const words = (utterance.words ?? []).map((word) => {
        const wordText = word.text?.trim() ?? "";

        if (!wordText) {
          return null;
        }

        if (typeof word.start !== "number" || typeof word.end !== "number") {
          throw new TranscriptNormalizationError(
            "assemblyai_word_timestamps_missing",
            "AssemblyAI word was missing start or end timestamp",
          );
        }

        return {
          word: wordText,
          startSec: millisecondsToSeconds(word.start),
          endSec: Math.max(
            millisecondsToSeconds(word.end),
            millisecondsToSeconds(word.start),
          ),
          confidence:
            typeof word.confidence === "number" ? word.confidence : null,
        };
      });

      const normalizedWords = words.filter(
        (word): word is TranscriptUtterance["words"][number] => word !== null,
      );

      if (normalizedWords.length === 0) {
        throw new TranscriptNormalizationError(
          "assemblyai_word_timestamps_missing",
          "AssemblyAI utterance did not include timed words",
        );
      }

      return {
        index,
        speaker,
        speakerLabel: formatSpeakerLabel(speaker),
        startSec,
        endSec: Math.max(endSec, startSec),
        text,
        confidence:
          typeof utterance.confidence === "number"
            ? utterance.confidence
            : null,
        words: normalizedWords,
      } satisfies TranscriptUtterance;
    })
    .filter(
      (utterance): utterance is TranscriptUtterance => utterance !== null,
    );

  if (normalizedUtterances.length === 0) {
    throw new TranscriptNormalizationError(
      "assemblyai_utterances_missing",
      "AssemblyAI transcript did not include usable utterances",
    );
  }

  const directText = payload.text?.trim();
  const text =
    directText ||
    normalizedUtterances.map((utterance) => utterance.text).join("\n\n");

  const speakers = new Set(
    normalizedUtterances.map((utterance) => utterance.speaker),
  );

  const durationSeconds =
    typeof payload.audio_duration === "number"
      ? Math.round(payload.audio_duration)
      : normalizedUtterances.length > 0
        ? Math.round(
            Math.max(
              ...normalizedUtterances.map((utterance) => utterance.endSec),
            ),
          )
        : null;

  return {
    provider: "assemblyai",
    providerModel: getAssemblyAiProviderModel(payload),
    providerJobId: payload.id ?? null,
    languageCode: payload.language_code ?? null,
    text,
    utterances: normalizedUtterances,
    speakerCount: speakers.size,
    durationSeconds,
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
    text: input.text,
    utterances: Array.isArray(utterances) ? utterances : [],
    speakerCount: input.speakerCount,
    durationSeconds: input.durationSeconds,
    errorCode: input.errorCode,
    completedAt: input.completedAt,
    updatedAt: input.updatedAt,
  });
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
          `[${formatReadableTimestamp(utterance.startSec)}] ${utterance.speakerLabel}: ${utterance.text}`,
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
    const body = `${utterance.speakerLabel}: ${utterance.text}`;

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
