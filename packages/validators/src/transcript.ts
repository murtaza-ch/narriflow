import { z } from "zod";

export const transcriptStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
]);

export const transcriptExportFormatSchema = z.enum(["txt", "srt", "vtt"]);

export const transcriptWordSchema = z.object({
  word: z.string().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).nullable(),
});

export const transcriptUtteranceSchema = z.object({
  index: z.number().int().nonnegative(),
  speaker: z.number().int().nonnegative().nullable(),
  speakerLabel: z.string().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
  words: z.array(transcriptWordSchema).default([]),
});

export const transcriptSnapshotSchema = z.object({
  projectId: z.string().uuid(),
  status: transcriptStatusSchema,
  provider: z.string().nullable(),
  providerModel: z.string().nullable(),
  providerJobId: z.string().nullable(),
  languageCode: z.string().nullable(),
  languageConfidence: z.number().min(0).max(1).nullable(),
  text: z.string().nullable(),
  utterances: z.array(transcriptUtteranceSchema),
  speakerCount: z.number().int().nullable(),
  durationSeconds: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  completedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
});

export type TranscriptWord = z.infer<typeof transcriptWordSchema>;
export type TranscriptStatus = z.infer<typeof transcriptStatusSchema>;
export type TranscriptExportFormat = z.infer<
  typeof transcriptExportFormatSchema
>;
export type TranscriptUtterance = z.infer<typeof transcriptUtteranceSchema>;
export type TranscriptSnapshot = z.infer<typeof transcriptSnapshotSchema>;

function transcriptWordsEqual(
  left: TranscriptWord,
  right: TranscriptWord,
): boolean {
  return (
    left === right ||
    (left.word === right.word &&
      left.startSec === right.startSec &&
      left.endSec === right.endSec &&
      left.confidence === right.confidence)
  );
}

function transcriptUtterancesEqual(
  left: TranscriptUtterance,
  right: TranscriptUtterance,
): boolean {
  if (left === right) return true;
  if (
    left.index !== right.index ||
    left.speaker !== right.speaker ||
    left.speakerLabel !== right.speakerLabel ||
    left.startSec !== right.startSec ||
    left.endSec !== right.endSec ||
    left.text !== right.text ||
    left.confidence !== right.confidence ||
    left.words.length !== right.words.length
  ) {
    return false;
  }
  return left.words.every((word, index) =>
    transcriptWordsEqual(word, right.words[index]!),
  );
}

/** Order-sensitive equality for canonical transcript slices. */
export function transcriptSlicesEqual(
  left: readonly TranscriptUtterance[],
  right: readonly TranscriptUtterance[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((utterance, index) =>
    transcriptUtterancesEqual(utterance, right[index]!),
  );
}
