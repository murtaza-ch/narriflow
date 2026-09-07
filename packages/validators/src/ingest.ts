import { z } from "zod";

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
  brandTemplateId: z.string().uuid().nullable().optional(),
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
