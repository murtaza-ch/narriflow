import { z } from "zod";

function isYoutubeUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      host === "youtu.be" ||
      host.endsWith("youtube.com") ||
      host.endsWith("youtube-nocookie.com")
    );
  } catch {
    return false;
  }
}

export const youtubeIngestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  youtubeUrl: z.string().url().refine(isYoutubeUrl, {
    message: "youtubeUrl must be a valid YouTube URL",
  }),
});

export const rssPreviewSchema = z.object({
  rssUrl: z.string().url(),
});

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
  episodes: z.array(rssEpisodeSchema).min(1).max(25),
  titlePrefix: z.string().min(1).max(100).optional(),
});

export const ingestStatusSchema = z.enum([
  "pending",
  "uploading",
  "queued",
  "downloading",
  "normalizing",
  "ready",
  "failed",
]);

export type YoutubeIngestInput = z.infer<typeof youtubeIngestSchema>;
export type RssPreviewInput = z.infer<typeof rssPreviewSchema>;
export type RssEpisodeInput = z.infer<typeof rssEpisodeSchema>;
export type RssImportInput = z.infer<typeof rssImportSchema>;
export type IngestStatus = z.infer<typeof ingestStatusSchema>;
