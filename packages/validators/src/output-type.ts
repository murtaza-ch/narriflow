import { z } from "zod";

export const outputTypes = [
  "short_clip",
  "audiogram",
  "linkedin_carousel",
  "x_thread",
  "newsletter_excerpt",
  "blog_post",
  "show_notes",
  "quote_cards",
  "thumbnail_set",
] as const;

export const outputTypeSchema = z.enum(outputTypes);

export type OutputType = z.infer<typeof outputTypeSchema>;
