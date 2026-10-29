import { z } from "zod";
import { type ContentPack, contentPackSchema } from "../content-pack";
import { driveIngestSchema, rssImportSchema } from "../ingest";
import { sourceLanguageInputSchema } from "../language";
import { detectLinkProvider, linkIngestSchema } from "../link-providers";

// Commit token: the browser mints one per import before its first attempt. It is the
// intake's native idempotency identity (a repeated submit collapses on the Project),
// so the first-party routes require it instead of accepting an unprotected create.

/** `POST /api/ingest/link`: Step 1 (Commit) of a pasted link. */
export const linkCommitRequestSchema = linkIngestSchema.required({ commitToken: true });
export type LinkCommitRequest = z.infer<typeof linkCommitRequestSchema>;

/** `POST /api/ingest/drive`: Step 1 (Commit) of a Google Drive Picker file. The access token is request data only. */
export const driveCommitRequestSchema = driveIngestSchema.required({ commitToken: true });
export type DriveCommitRequest = z.infer<typeof driveCommitRequestSchema>;

/** `GET /api/ingest/link/metadata`: the link whose title the Commit step shows. */
export const linkMetadataQuerySchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => detectLinkProvider(value) !== null, {
        message: "That link is not from a supported provider.",
      }),
  })
  .strict();
export type LinkMetadataQuery = z.infer<typeof linkMetadataQuerySchema>;

/** The Step 2 (Configure) settings, sent to save a draft or to finalize. The Project is the path. */
export const generationSetupSchema = z
  .object({
    contentPack: contentPackSchema,
    languageCode: sourceLanguageInputSchema,
  })
  .strict();
export type GenerationSetupInput = z.infer<typeof generationSetupSchema>;

/** `POST /api/ingest/rss/import`: the feed episode plus the generation settings chosen with it. */
export const rssImportRequestSchema = rssImportSchema
  .required({ commitToken: true })
  .extend({
    contentPack: contentPackSchema,
    languageCode: sourceLanguageInputSchema,
  })
  .strict();
export type RssImportRequest = z.infer<typeof rssImportRequestSchema>;

/** Ingest states the Configure step can resume in; any other state resumes as `queued`. */
export const RESUMABLE_INGEST_STATUSES = [
  "queued",
  "downloading",
  "normalizing",
  "ready",
  "failed",
] as const;
export type ResumableIngestStatus = (typeof RESUMABLE_INGEST_STATUSES)[number];

/** The draft a returning person's Configure step (Step 2) rehydrates. */
export interface LinkResumeData {
  projectId: string;
  title: string;
  sourceProvider: string | null;
  sourceMediaUrl: string;
  /** The link as pasted; a stored media URL doesn't always say which video it is. */
  sourceInput: string | null;
  languageCode: string | null;
  ingestStatus: ResumableIngestStatus;
  ingestErrorCode: string | null;
  /** The ingest is a Google Drive Picker import, which can't be retried. */
  ingestFromDrivePicker: boolean;
  contentPack: ContentPack;
}

/**
 * `GET /api/ingest/:projectId/resume`. `resume` carries the draft;
 * `open_project` means Configure already finished; `restart` means there is
 * nothing to resume and the person starts a fresh import.
 */
export type LinkResumeResult =
  | { outcome: "resume"; data: LinkResumeData }
  | { outcome: "open_project" }
  | { outcome: "restart" };
