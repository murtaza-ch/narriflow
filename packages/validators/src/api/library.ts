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

/** `POST /api/library/folders` and `PATCH /api/library/folders/:folderId`. The service owns the 1 to 80 character rule. */
export const folderNameRequestSchema = z.object({ name: z.string().max(500) }).strict();
export type FolderNameRequest = z.infer<typeof folderNameRequestSchema>;

/** `PATCH /api/projects/:id/folder`: the destination folder, or `null` to take the Project out of its folder. */
export const moveProjectToFolderRequestSchema = z.object({ folderId: z.string().uuid().nullable() }).strict();
export type MoveProjectToFolderRequest = z.infer<typeof moveProjectToFolderRequestSchema>;

/** `GET /api/workspace/search`: the service trims and bounds the query itself. */
export const workspaceSearchRequestSchema = z.object({ q: z.string().max(500).optional() });

/** `GET /api/broll/search`: stock-video search. The handler applies the full `brollSearchQuerySchema` after the configuration check. */
export const brollSearchRequestSchema = z.object({
  query: z.string().max(500).optional(),
  orientation: z.string().max(32).optional(),
});
