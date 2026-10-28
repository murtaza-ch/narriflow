import {
  isPexelsConfigured,
  librarySearchService,
  searchBrollVideos,
  workspaceLibraryService,
} from "@narriflow/services";
import { brollSearchQuerySchema } from "@narriflow/validators";
import { librarySearchRequestSchema } from "@narriflow/validators/api/library";
import { Hono } from "hono";
import { admit, getActor } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import { validate } from "../../http/route";
import { libraryAdmission as access } from "./admission";

/** Services the library routes call. `runtime.ts` supplies the production instances. */
export interface LibraryRouteDeps {
  workspaceLibraryService: typeof workspaceLibraryService;
  librarySearchService: typeof librarySearchService;
  searchBrollVideos: typeof searchBrollVideos;
  isPexelsConfigured: typeof isPexelsConfigured;
}

/** Workspace title search, semantic library search and stock B-roll search. */
export function createLibraryRoutes(deps: LibraryRouteDeps) {
  const { workspaceLibraryService, librarySearchService, searchBrollVideos, isPexelsConfigured } = deps;

  return new Hono<ApiEnv>()
    .get("/workspace/search", admit(access["GET /workspace/search"]), async (c) => {
      const results = await workspaceLibraryService.search(getActor(c), c.req.query("q") ?? "");
      return c.json({ results }, 200);
    })

    .get(
      "/library/search",
      admit(access["GET /library/search"]),
      validate("query", librarySearchRequestSchema),
      async (c) => {
        const { q, limit, projectId } = c.req.valid("query");
        const results = await librarySearchService.search(getActor(c), {
          query: q,
          limit,
          projectIds: projectId ? [projectId] : undefined,
        });
        return c.json({ results }, 200);
      },
    )

    // Stock B-roll search (Pexels).
    .get("/broll/search", admit(access["GET /broll/search"]), async (c) => {
      if (!isPexelsConfigured()) {
        return c.json({ configured: false, results: [] }, 200);
      }
      const parsed = brollSearchQuerySchema.safeParse({
        query: c.req.query("query") ?? "",
        orientation: c.req.query("orientation") ?? "portrait",
      });
      if (!parsed.success) {
        return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
      }
      const results = await searchBrollVideos(parsed.data.query, parsed.data.orientation);
      return c.json({ configured: true, results }, 200);
    });
}

export type LibraryRoutes = ReturnType<typeof createLibraryRoutes>;
