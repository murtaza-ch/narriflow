import { z } from "zod";
import { linkIngestSchema } from "./link-providers";

/** Reaches only the files a person picks; a non-sensitive scope, so no CASA assessment. */
export const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** Drive file IDs use this alphabet; keeping to it means an ID can't change the API path. */
const GOOGLE_DRIVE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;

/** A file chosen in the Google Drive Picker. Settings match link intake; the
 *  server reads name, size, type and duration from Drive, never from the browser. */
export const driveIngestSchema = linkIngestSchema
  .omit({ url: true })
  .extend({
    fileId: z.string().regex(GOOGLE_DRIVE_FILE_ID_PATTERN),
    accessToken: z.string().min(1).max(4096),
  })
  .strict();

export type DriveIngestInput = z.infer<typeof driveIngestSchema>;

/** A Picker file's source reference on its Project. It is not a fetchable link. */
export function googleDriveFileViewUrl(fileId: string) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

export const rssPreviewSchema = z.object({
  rssUrl: z.string().url(),
}).strict();

export const rssEpisodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  enclosureUrl: z.string().url(),
  publishedAt: z.string().datetime().nullable().optional(),
  durationSeconds: z.number().int().positive().max(24 * 60 * 60).nullable().optional(),
  mimeType: z.string().min(1).nullable().optional(),
});

export const rssImportSchema = z.object({
  rssUrl: z.string().url(),
  // Feed data is authoritative on the server. Clients select stable IDs from
  // preview rather than submitting enclosure URLs, titles, or durations.
  episodeIds: z.array(z.string().min(1).max(128)).min(1).max(1),
  commitToken: z.string().uuid().optional(),
  titlePrefix: z.string().min(1).max(100).optional(),
  brandProfileId: z.string().uuid().nullable().optional(),
}).strict();

export const ingestStatusSchema = z.enum([
  "pending",
  "uploading",
  "queued",
  "downloading",
  "normalizing",
  "ready",
  "failed",
]);

export type RssPreviewInput = z.infer<typeof rssPreviewSchema>;
export type RssEpisodeInput = z.infer<typeof rssEpisodeSchema>;
export type RssImportInput = z.infer<typeof rssImportSchema>;
export type IngestStatus = z.infer<typeof ingestStatusSchema>;

/**
 * How many ingest attempts a Project gets before Retry is refused. The ingest
 * lifecycle enforces it; the Project page reads it to say so up front.
 */
export const MAX_INGEST_RETRY_ATTEMPTS = 5;

/**
 * Processing-panel state for a Project whose speech-to-text admission was
 * refused by Processing Usage: the typed refusal persisted on the Project is
 * the only input, so web, MCP, and REST render the same recovery copy.
 */
export function isQuotaBlockedMidFlight(input: {
  ingestErrorCode: string | null | undefined;
}): boolean {
  return (
    input.ingestErrorCode === "credits_exhausted" ||
    input.ingestErrorCode === "upload_too_long"
  );
}
