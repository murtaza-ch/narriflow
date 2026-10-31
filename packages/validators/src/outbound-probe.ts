import { z } from "zod";
import { rssEpisodeSchema } from "./ingest";

export const MAX_RSS_RESULT_BYTES = 4 * 1024 * 1024;
export const outboundRssInputSchema = z.object({
  kind: z.literal("rss_feed"), url: z.string().url().max(8192),
  etag: z.string().max(2048).nullable(), lastModified: z.string().max(256).nullable(),
}).strict();
export const rssFeedSnapshotSchema = z.object({
  title: z.string().max(65536).nullable(), episodes: z.array(rssEpisodeSchema).max(500),
  etag: z.string().max(2048).nullable(), lastModified: z.string().max(256).nullable(),
  finalUrl: z.string().url().max(8192), notModified: z.boolean(),
}).strict();
export type OutboundRssInput = z.infer<typeof outboundRssInputSchema>;
export type RssFeedSnapshot = z.infer<typeof rssFeedSnapshotSchema>;
