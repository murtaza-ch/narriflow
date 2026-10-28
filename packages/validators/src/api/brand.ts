import { z } from "zod";

// Shared request schemas of the brand routes. The input and the server's
// refusal of it come from one schema; response shapes are inferred from the
// route handlers, so the client never restates them.

/** The Brand Profile detail sections, in tab order. */
export const BRAND_PROFILE_SECTIONS = [
  "identity",
  "styles",
  "assets",
  "scenes",
  "audio",
  "voice",
] as const;
export const brandProfileSectionSchema = z.enum(BRAND_PROFILE_SECTIONS);
export type BrandProfileSection = z.infer<typeof brandProfileSectionSchema>;

/** `GET /api/brand-profiles`: one ordinary page. Aggregates use the brand-kit read, which never truncates. */
export const brandProfilesPageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    query: z.string().trim().max(100).optional(),
    cursor: z.string().uuid().optional(),
  })
  .strict();
export type BrandProfilesPageQuery = z.infer<typeof brandProfilesPageQuerySchema>;

/** `GET /api/brand-profiles/default`: `applicable=1` is the default intake applies (none when the plan no longer allows profiles). */
export const defaultBrandProfileQuerySchema = z
  .object({ applicable: z.enum(["1"]).optional() })
  .strict();
export type DefaultBrandProfileQuery = z.infer<typeof defaultBrandProfileQuerySchema>;

/** `GET /api/brand-profiles/:id/detail`: the section whose data rides with the profile. */
export const brandProfileDetailQuerySchema = z
  .object({ section: brandProfileSectionSchema.optional() })
  .strict();
export type BrandProfileDetailQuery = z.infer<typeof brandProfileDetailQuerySchema>;

/** `GET /api/projects/:projectId/generated-media/jobs`: the Project comes from the path, the clip narrows the list. */
export const generatedMediaJobsQuerySchema = z
  .object({ clipId: z.string().uuid().optional() })
  .strict();
export type GeneratedMediaJobsQuery = z.infer<typeof generatedMediaJobsQuerySchema>;
