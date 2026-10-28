import {
  analyticsService,
  contentSuiteService,
  dubbingService,
  projectService,
  workspaceLibraryService,
  type ProjectListSort,
  type ProjectListSourceFilter,
  type ProjectListStatusFilter,
} from "@narriflow/services";
import {
  dubDownloadQuerySchema,
  generateContentSuiteRequestSchema,
  generateProjectRequestSchema,
  requestClipDubSchema,
  transcriptExportFormatSchema,
} from "@narriflow/validators";
import { Hono } from "hono";
import { admit, getActor } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import { getIdempotencyKey, requireIdempotencyKey } from "../../http/idempotency";
import { validate } from "../../http/route";
import { projectsAdmission as access } from "./admission";

/** Services the projects routes call. `runtime.ts` supplies the production instances. */
export interface ProjectsRouteDeps {
  projectService: typeof projectService;
  workspaceLibraryService: typeof workspaceLibraryService;
  contentSuiteService: typeof contentSuiteService;
  analyticsService: typeof analyticsService;
  dubbingService: typeof dubbingService;
}

const STATUS_FILTERS = ["all", "ready", "processing", "queued", "failed"];
const SOURCE_FILTERS = ["all", "youtube", "link", "upload", "rss"];
const SORTS = ["newest", "oldest", "title", "clips"];

/** Project list and snapshot reads, generation, transcripts, content suite, analytics and dubbing. */
export function createProjectsRoutes(deps: ProjectsRouteDeps) {
  const { projectService, workspaceLibraryService, contentSuiteService, analyticsService, dubbingService } = deps;

  return new Hono<ApiEnv>()
    .get("/projects", admit(access["GET /projects"]), async (c) => {
      const appUser = getActor(c);
      const limitRaw = c.req.query("limit");
      const limit = limitRaw ? Number(limitRaw) : undefined;
      const cursor = c.req.query("cursor") ?? null;
      const folderId = c.req.query("folder") || undefined;
      const query = c.req.query("q") ?? "";
      const statusRaw = c.req.query("status");
      const sourceRaw = c.req.query("source");
      const sortRaw = c.req.query("sort");
      const status = STATUS_FILTERS.includes(statusRaw ?? "all")
        ? (statusRaw as ProjectListStatusFilter | undefined)
        : undefined;
      const source = SOURCE_FILTERS.includes(sourceRaw ?? "all")
        ? (sourceRaw as ProjectListSourceFilter | undefined)
        : undefined;
      const sort = SORTS.includes(sortRaw ?? "newest")
        ? (sortRaw as ProjectListSort | undefined)
        : undefined;

      const page = await workspaceLibraryService.listProjects(appUser, {
        limit,
        cursor,
        folderId,
        query,
        status,
        source,
        sort,
      });
      return c.json(page, 200);
    })

    .post(
      "/projects/:id/generate",
      admit(access["POST /projects/:id/generate"]),
      requireIdempotencyKey(),
      validate("json", generateProjectRequestSchema),
      async (c) => {
        const result = await projectService.triggerGeneration(
          getActor(c),
          c.req.param("id"),
          c.req.valid("json"),
          getIdempotencyKey(c),
        );
        return c.json(result, 202);
      },
    )

    .get("/projects/:id", admit(access["GET /projects/:id"]), async (c) => {
      const snapshot = await projectService.getProjectSnapshot(getActor(c), c.req.param("id"));
      if (!snapshot.project) {
        return c.json({ error: "project_not_found" }, 404);
      }
      return c.json(snapshot, 200);
    })

    .get(
      "/projects/:id/runs/:workflowRunId",
      admit(access["GET /projects/:id/runs/:workflowRunId"]),
      async (c) => {
        const snapshot = await projectService.getWorkflowRun(
          getActor(c),
          c.req.param("id"),
          c.req.param("workflowRunId"),
        );
        if (!snapshot.run) {
          return c.json(
            { error: "workflow_run_not_found", message: "Workflow run not found" },
            404,
          );
        }
        return c.json(snapshot, 200);
      },
    )

    .get("/projects/:id/transcript", admit(access["GET /projects/:id/transcript"]), async (c) => {
      const transcript = await projectService.getTranscriptSnapshot(getActor(c), c.req.param("id"));
      if (!transcript) {
        return c.json({ error: "transcript_not_found", message: "Transcript not found" }, 404);
      }
      return c.json(transcript, 200);
    })

    // Lean word-level transcript for the Trim/Extend editor: raw utterances
    // only, no snapshot re-validation (see getTranscriptUtterancesRaw). Not
    // browser-cached: React Query deduplicates it and the default is no-store.
    .get(
      "/projects/:id/transcript/utterances",
      admit(access["GET /projects/:id/transcript/utterances"]),
      async (c) => {
        const utterances = await projectService.getTranscriptUtterancesRaw(
          getActor(c),
          c.req.param("id"),
        );
        if (utterances === null) {
          return c.json({ error: "transcript_not_found", message: "Transcript not found" }, 404);
        }
        return c.json({ utterances }, 200);
      },
    )

    .get(
      "/projects/:id/transcript/export",
      admit(access["GET /projects/:id/transcript/export"]),
      async (c) => {
        const format = transcriptExportFormatSchema.safeParse(c.req.query("format") ?? "txt");
        if (!format.success) {
          return c.json(
            {
              error: "invalid_transcript_export_format",
              message: "Invalid transcript export format",
            },
            400,
          );
        }
        const exported = await projectService.getTranscriptExport(
          getActor(c),
          c.req.param("id"),
          format.data,
        );
        c.header("Content-Type", exported.contentType);
        c.header("Content-Disposition", `attachment; filename="${exported.fileName}"`);
        return c.body(exported.body, 200);
      },
    )

    .get(
      "/projects/:id/content-suite",
      admit(access["GET /projects/:id/content-suite"]),
      async (c) => {
        const assets = await contentSuiteService.list(getActor(c), c.req.param("id"));
        return c.json({ assets }, 200);
      },
    )

    .post(
      "/projects/:id/content-suite",
      admit(access["POST /projects/:id/content-suite"]),
      validate("json", generateContentSuiteRequestSchema),
      async (c) => {
        const assets = await contentSuiteService.generate(
          getActor(c),
          c.req.param("id"),
          c.req.valid("json").types,
        );
        return c.json({ assets }, 200);
      },
    )

    .get("/projects/:id/analytics", admit(access["GET /projects/:id/analytics"]), async (c) => {
      const analytics = await analyticsService.getProjectAnalytics(getActor(c), c.req.param("id"));
      return c.json(analytics, 200);
    })

    .get("/projects/:id/dubs", admit(access["GET /projects/:id/dubs"]), async (c) => {
      const dubs = await dubbingService.listProjectDubs(getActor(c), c.req.param("id"));
      return c.json({ dubs }, 200);
    })

    .post(
      "/projects/:id/dubs",
      admit(access["POST /projects/:id/dubs"]),
      requireIdempotencyKey(),
      validate("json", requestClipDubSchema),
      async (c) => {
        const result = await dubbingService.requestClipDub(
          getActor(c),
          c.req.param("id"),
          getIdempotencyKey(c),
          c.req.valid("json"),
        );
        return c.json(result, 202);
      },
    )

    .get(
      "/projects/:id/dubs/:dubId/download",
      admit(access["GET /projects/:id/dubs/:dubId/download"]),
      validate("query", dubDownloadQuerySchema),
      async (c) => {
        const result = await dubbingService.getDubDownloadUrl(
          getActor(c),
          c.req.param("id"),
          c.req.param("dubId"),
          c.req.valid("query").asset,
        );
        return c.json(result, 200);
      },
    );
}

export type ProjectsRoutes = ReturnType<typeof createProjectsRoutes>;
