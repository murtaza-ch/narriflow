import { z } from "zod";

/** Library search: a query over every transcript in a Workspace. The same
 * limits apply to the browser, REST, and MCP surfaces. */
export const LIBRARY_SEARCH_QUERY_MIN_LENGTH = 2;
export const LIBRARY_SEARCH_QUERY_MAX_LENGTH = 300;
export const LIBRARY_SEARCH_DEFAULT_LIMIT = 10;
export const LIBRARY_SEARCH_MAX_LIMIT = 25;

export const librarySearchQuerySchema = z
  .string()
  .trim()
  .min(LIBRARY_SEARCH_QUERY_MIN_LENGTH)
  .max(LIBRARY_SEARCH_QUERY_MAX_LENGTH)
  .describe("Words or a question; matches by meaning and by exact words");

export const librarySearchLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(LIBRARY_SEARCH_MAX_LIMIT);

export const libraryPassageSchema = z.strictObject({
  projectId: z.string().uuid(),
  projectTitle: z.string().max(500),
  startMs: z.number().int().nonnegative().describe("Start of the passage in the source video"),
  endMs: z.number().int().nonnegative(),
  text: z.string().describe("The transcript text of the passage"),
  score: z.number().describe("Relative rank value; higher is a better match. Compare only within one response"),
});

export const librarySearchResultSchema = z.strictObject({
  results: z.array(libraryPassageSchema),
});

export type LibraryPassage = z.infer<typeof libraryPassageSchema>;
