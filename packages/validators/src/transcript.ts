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
  languageCode: z.string().nullable(),
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
