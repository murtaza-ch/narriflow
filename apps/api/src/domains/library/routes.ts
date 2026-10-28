import {
  isPexelsConfigured,
  librarySearchService,
  projectsCommands,
  searchBrollVideos,
  workspaceLibraryService,
} from "@narriflow/services";
import { brollSearchQuerySchema } from "@narriflow/validators";
import {
  brollSearchRequestSchema,
  folderNameRequestSchema,
  librarySearchRequestSchema,
  workspaceSearchRequestSchema,
} from "@narriflow/validators/api/library";
import { createRouteApp, getActor, getRecordedRateLimit } from "../../http/admission";
import { getIdempotencyKey, requireIdempotencyKey } from "../../http/idempotency";
import { enforceRecordedRateLimit } from "../../http/limits";
import { validate } from "../../http/route";
import { uuidParams } from "../platform/params";
import { libraryAdmission as access } from "./admission";
import { toFolderView } from "./folders";

/** Services the library routes call. `runtime.ts` supplies the production instances. */
export interface LibraryRouteDeps {
  workspaceLibraryService: typeof workspaceLibraryService;
  librarySearchService: typeof librarySearchService;
  searchBrollVideos: typeof searchBrollVideos;
  isPexelsConfigured: typeof isPexelsConfigured;
  projectsCommands: typeof projectsCommands;
}

/** Workspace title search, semantic library search, stock B-roll search and folders. */
export function createLibraryRoutes(deps: LibraryRouteDeps) {
  const { workspaceLibraryService, librarySearchService, searchBrollVideos, isPexelsConfigured, projectsCommands } = deps;

  return createRouteApp(access)
    .get("/workspace/search", validate("query", workspaceSearchRequestSchema), async (c) => {
      const results = await workspaceLibraryService.search(getActor(c), c.req.valid("query").q ?? "");
      return c.json({ results }, 200);
    })

    .get(
      "/library/search",
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
    .get("/broll/search", validate("query", brollSearchRequestSchema), async (c) => {
      if (!isPexelsConfigured()) {
        return c.json({ configured: false, results: [] }, 200);
      }
      const { query, orientation } = c.req.valid("query");
      const parsed = brollSearchQuerySchema.safeParse({
        query: query ?? "",
        orientation: orientation ?? "portrait",
      });
      if (!parsed.success) {
        return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
      }
      const results = await searchBrollVideos(parsed.data.query, parsed.data.orientation);
      return c.json({ configured: true, results }, 200);
    })

    .get("/workspace/folders", async (c) => {
      const folders = await workspaceLibraryService.listFolders(getActor(c));
      return c.json({ folders: folders.map(toFolderView) }, 200);
    })

    // A retryable create: one folder per Idempotency-Key, replayed with the original result.
    .post(
      "/library/folders",
      requireIdempotencyKey(),
      validate("json", folderNameRequestSchema),
      async (c) => {
        const { folder, replayed } = await projectsCommands.createFolder(getActor(c), c.req.valid("json").name, {
          clientIdempotencyKey: getIdempotencyKey(c),
          beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)),
        });
        if (replayed) c.header("Idempotent-Replayed", "true");
        return c.json({ folder }, replayed ? 200 : 201);
      },
    )

    .patch(
      "/library/folders/:folderId",
      uuidParams("folderId"),
      validate("json", folderNameRequestSchema),
      async (c) => {
        await workspaceLibraryService.renameFolder(getActor(c), c.req.param("folderId"), c.req.valid("json").name);
        return c.json({ ok: true as const }, 200);
      },
    )

    .delete("/library/folders/:folderId", uuidParams("folderId"), async (c) => {
      await workspaceLibraryService.deleteFolder(getActor(c), c.req.param("folderId"));
      return c.json({ ok: true as const }, 200);
    });
}

export type LibraryRoutes = ReturnType<typeof createLibraryRoutes>;
