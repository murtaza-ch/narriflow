import { z } from "zod";
import { LIBRARY_SEARCH_MAX_LIMIT, librarySearchQuerySchema } from "../library-search";

/** `GET /api/library/search` query: the words to find, a bounded result count and an optional single-Project scope. */
export const librarySearchRequestSchema = z
  .object({
    q: librarySearchQuerySchema,
    limit: z.coerce.number().int().min(1).max(LIBRARY_SEARCH_MAX_LIMIT).optional(),
    projectId: z.string().uuid().optional(),
  })
  .strict();

export type LibrarySearchRequest = z.infer<typeof librarySearchRequestSchema>;
