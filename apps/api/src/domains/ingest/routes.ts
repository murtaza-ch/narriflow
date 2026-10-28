import { projectService } from "@narriflow/services";
import { linkIngestSchema, rssImportSchema, rssPreviewSchema } from "@narriflow/validators";
import { Hono } from "hono";
import { admit, getActor } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import { validate } from "../../http/route";
import { ingestAdmission as access } from "./admission";

/** Services the ingest routes call. `runtime.ts` supplies the production instance. */
export interface IngestRouteDeps {
  projectService: typeof projectService;
}

/** Link and RSS intake plus the intake snapshot. Upload Sessions are added by the intake owner. */
export function createIngestRoutes(deps: IngestRouteDeps) {
  const { projectService } = deps;

  return new Hono<ApiEnv>()
    .post(
      "/ingest/link",
      admit(access["POST /ingest/link"]),
      validate("json", linkIngestSchema),
      async (c) => {
        const response = await projectService.queueLinkIngest(getActor(c), c.req.valid("json"));
        return c.json(response, 202);
      },
    )

    .post(
      "/ingest/rss/preview",
      admit(access["POST /ingest/rss/preview"]),
      validate("json", rssPreviewSchema),
      async (c) => {
        const response = await projectService.previewRssFeed(
          getActor(c),
          c.req.valid("json").rssUrl,
        );
        return c.json(response, 200);
      },
    )

    .post(
      "/ingest/rss/import",
      admit(access["POST /ingest/rss/import"]),
      validate("json", rssImportSchema),
      async (c) => {
        const response = await projectService.importFromRss(getActor(c), c.req.valid("json"));
        return c.json(response, 202);
      },
    )

    .get("/ingest/:projectId", admit(access["GET /ingest/:projectId"]), async (c) => {
      const snapshot = await projectService.getIngestSnapshot(getActor(c), c.req.param("projectId"));
      if (!snapshot) {
        return c.json({ error: "project_not_found" }, 404);
      }
      return c.json(snapshot, 200);
    });
}

export type IngestRoutes = ReturnType<typeof createIngestRoutes>;
