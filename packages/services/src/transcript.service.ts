import type {
  TranscriptExportFormat,
  TranscriptSnapshot,
  TranscriptUtterance,
} from "@narriflow/validators";
import { transcriptSnapshotSchema } from "@narriflow/validators";

interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  confidence?: number;
}

interface DeepgramUtterance {
  start?: number;
  end?: number;
  transcript?: string;
  confidence?: number;
  speaker?: number;
  words?: DeepgramWord[];
}

interface DeepgramAlternative {
  transcript?: string;
  languages?: string[];
}

interface DeepgramPayload {
  metadata?: {
    duration?: number;
    model_info?: Record<string, { name?: string }>;
    models?: string[];
  };
  results?: {
    utterances?: DeepgramUtterance[];
    channels?: Array<{
      alternatives?: DeepgramAlternative[];
    }>;
  };
}

export interface NormalizedTranscript {
  provider: "deepgram";
  providerModel: string;
  languageCode: string | null;
  text: string;
  utterances: TranscriptUtterance[];
  speakerCount: number;
  durationSeconds: number | null;
  rawPayload: unknown;
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

function coerceUtteranceText(utterance: DeepgramUtterance) {
  const direct = utterance.transcript?.trim();

  if (direct) {
    return direct;
  }

  const fromWords = (utterance.words ?? [])
    .map((word) => word.punctuated_word ?? word.word ?? "")
    .join(" ")
    .trim();

  return fromWords;
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

export function normalizeDeepgramTranscript(
  rawPayload: unknown,
): NormalizedTranscript {
  const payload = rawPayload as DeepgramPayload;
  const alternative = payload.results?.channels?.[0]?.alternatives?.[0];
  const fallbackText = alternative?.transcript?.trim() ?? "";
  const languageCode = alternative?.languages?.[0] ?? null;
  const modelEntry = payload.metadata?.model_info
    ? Object.values(payload.metadata.model_info)[0]
    : null;
  const providerModel =
    modelEntry?.name ?? payload.metadata?.models?.[0] ?? "nova-3";

  const normalizedUtterances = (payload.results?.utterances ?? [])
    .map((utterance, index) => {
      const text = coerceUtteranceText(utterance);
      const startSec =
        typeof utterance.start === "number" ? utterance.start : 0;
      const endSec =
        typeof utterance.end === "number" ? utterance.end : startSec;

      if (!text) {
        return null;
      }

      return {
        index,
        speaker:
          typeof utterance.speaker === "number" ? utterance.speaker : null,
        speakerLabel: formatSpeakerLabel(
          typeof utterance.speaker === "number" ? utterance.speaker : null,
        ),
        startSec,
        endSec: Math.max(endSec, startSec),
        text,
        confidence:
          typeof utterance.confidence === "number"
            ? utterance.confidence
            : null,
        words: (utterance.words ?? [])
          .filter(
            (w) =>
              (w.word || w.punctuated_word) &&
              typeof w.start === "number" &&
              typeof w.end === "number",
          )
          .map((w) => ({
            word: w.punctuated_word ?? w.word ?? "",
            startSec: w.start!,
            endSec: w.end!,
            confidence:
              typeof w.confidence === "number" ? w.confidence : null,
          })),
      } satisfies TranscriptUtterance;
    })
    .filter(
      (utterance): utterance is TranscriptUtterance => utterance !== null,
    );

  const text =
    normalizedUtterances.length > 0
      ? normalizedUtterances.map((utterance) => utterance.text).join("\n\n")
      : fallbackText;

  const speakers = new Set(
    normalizedUtterances
      .map((utterance) => utterance.speaker)
      .filter((speaker): speaker is number => speaker !== null),
  );

  const durationSeconds =
    typeof payload.metadata?.duration === "number"
      ? Math.round(payload.metadata.duration)
      : normalizedUtterances.length > 0
        ? Math.round(
            Math.max(
              ...normalizedUtterances.map((utterance) => utterance.endSec),
            ),
          )
        : null;

  return {
    provider: "deepgram",
    providerModel,
    languageCode,
    text,
    utterances: normalizedUtterances,
    speakerCount:
      speakers.size > 0
        ? speakers.size
        : normalizedUtterances.length > 0
          ? 1
          : 0,
    durationSeconds,
    rawPayload,
  };
}

export function buildTranscriptSnapshot(input: {
  projectId: string;
  status: string;
  provider: string | null;
  providerModel: string | null;
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
