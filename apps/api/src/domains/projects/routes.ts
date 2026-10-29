import {
  analyticsService,
  autopilotService,
  brandProfileService,
  clipService,
  contentSuiteService,
  dubbingService,
  getProcessingUsage,
  getProjectFinishing,
  presignDownloadUrl,
  projectService,
  reviewService,
  socialOAuthService,
  socialService,
  workspaceLibraryService,
  workspaceService,
} from "@narriflow/services";
import {
  dubDownloadQuerySchema,
  generateContentSuiteRequestSchema,
  generateProjectRequestSchema,
  requestClipDubSchema,
} from "@narriflow/validators";
import { moveProjectToFolderRequestSchema } from "@narriflow/validators/api/library";
import {
  applyProjectBrandProfileRequestSchema,
  notifyPreferenceRequestSchema,
  projectDetailQuerySchema,
  projectListQuerySchema,
  transcriptExportQuerySchema,
  transcriptViewQuerySchema,
} from "@narriflow/validators/api/projects";
import { createRouteApp, getActor } from "../../http/admission";
import { getIdempotencyKey, requireIdempotencyKey } from "../../http/idempotency";
import { validate } from "../../http/route";
import { projectsAdmission as access } from "./admission";
import {
  readExplorer,
  readHome,
  readProjectDetail,
  readSourceGrant,
  type ProjectReadDeps,
} from "./read-models";

/** Services the projects routes call. `runtime.ts` supplies the production instances. */
export interface ProjectsRouteDeps extends ProjectReadDeps {
  projectService: typeof projectService;
  workspaceLibraryService: typeof workspaceLibraryService;
  contentSuiteService: typeof contentSuiteService;
  analyticsService: typeof analyticsService;
  dubbingService: typeof dubbingService;
  clipService: typeof clipService;
  socialService: typeof socialService;
  socialOAuthService: typeof socialOAuthService;
  brandProfileService: typeof brandProfileService;
  reviewService: typeof reviewService;
  workspaceService: typeof workspaceService;
  autopilotService: typeof autopilotService;
  getProjectFinishing: typeof getProjectFinishing;
  getProcessingUsage: typeof getProcessingUsage;
  presignDownloadUrl: typeof presignDownloadUrl;
}

/** A Project another request deleted first: the end state a delete wants already holds. */
function alreadyDeleted(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === "project_not_found";
}

const notFound = (code: string, message: string) => ({ error: code, message });

/**
 * Project screens and commands: the home and explorer aggregates, the detail
 * aggregate with its constituent reads, generation, transcripts, content suite,
 * analytics, dubbing and the Project's own controls. Literal paths
 * (`/projects/explorer`) are registered before `/projects/:id`.
 */
export function createProjectsRoutes(deps: ProjectsRouteDeps) {
  const {
    projectService,
    workspaceLibraryService,
    contentSuiteService,
    analyticsService,
    dubbingService,
    brandProfileService,
  } = deps;

  return createRouteApp(access)
    .get("/home", async (c) => c.json(await readHome(deps, getActor(c)), 200))

    .get("/projects", validate("query", projectListQuerySchema), async (c) => {
      const { q, folder, ...rest } = c.req.valid("query");
      const page = await workspaceLibraryService.listProjects(getActor(c), {
        ...rest,
        query: q,
        folderId: folder,
      });
      return c.json(page, 200);
    })

    .get("/projects/explorer", validate("query", projectListQuerySchema), async (c) =>
      c.json(await readExplorer(deps, getActor(c), c.req.valid("query")), 200),
    )

    .post(
      "/projects/:id/generate",
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

    .get("/projects/:id", async (c) => {
      const snapshot = await projectService.getProjectSnapshot(getActor(c), c.req.param("id"));
      if (!snapshot.project) {
        return c.json({ error: "project_not_found" }, 404);
      }
      return c.json(snapshot, 200);
    })

    // Permanently deletes the Project and its media. Naturally idempotent: a
    // Project that is already gone is the success the caller asked for.
    .delete("/projects/:id", async (c) => {
      try {
        await projectService.deleteProject(getActor(c), c.req.param("id"));
      } catch (error) {
        if (!alreadyDeleted(error)) throw error;
      }
      return c.json({ ok: true as const }, 200);
    })

    .get("/projects/:id/detail", validate("query", projectDetailQuerySchema), async (c) => {
      const detail = await readProjectDetail(deps, getActor(c), c.req.param("id"), c.req.valid("query").tab);
      if (!detail) return c.json(notFound("project_not_found", "Project not found."), 404);
      return c.json(detail, 200);
    })

    .get("/projects/:id/content-pack", async (c) => {
      const contentPack = await projectService.getLatestContentPack(getActor(c), c.req.param("id"));
      return c.json({ contentPack }, 200);
    })

    .get("/projects/:id/workflow-history", async (c) => {
      const workflowHistory = await projectService.getWorkflowHistory(getActor(c), c.req.param("id"));
      return c.json({ workflowHistory }, 200);
    })

    .get("/projects/:id/finishing", async (c) => {
      const finishing = await deps.getProjectFinishing({
        workspaceId: getActor(c).workspaceId,
        projectId: c.req.param("id"),
      });
      return c.json({ finishing }, 200);
    })

    .get("/projects/:id/credit-usage", async (c) => {
      const creditUsage = await deps.getProcessingUsage().projectCreditUsage(c.req.param("id"));
      return c.json({ creditUsage }, 200);
    })

    // A short-lived grant for the source video; both fields are null once the source was reclaimed.
    .get("/projects/:id/source-url", async (c) => {
      const snapshot = await projectService.getProjectSnapshot(getActor(c), c.req.param("id"));
      if (!snapshot.project) {
        return c.json(notFound("project_not_found", "Project not found."), 404);
      }
      const grant = await readSourceGrant(deps, snapshot.project.sourceStorageKey);
      return c.json({ url: grant?.url ?? null, expiresAt: grant?.expiresAt ?? null }, 200);
    })

    .patch(
      "/projects/:id/folder",
      validate("json", moveProjectToFolderRequestSchema),
      async (c) => {
        await workspaceLibraryService.moveProject(
          getActor(c),
          c.req.param("id"),
          c.req.valid("json").folderId,
        );
        return c.json({ ok: true as const }, 200);
      },
    )

    .post(
      "/projects/:id/brand-profile",
      validate("json", applyProjectBrandProfileRequestSchema),
      async (c) => {
        const { profileId, templateId } = c.req.valid("json");
        await brandProfileService.applyToProject(getActor(c), c.req.param("id"), { profileId, templateId });
        return c.json({ ok: true as const }, 200);
      },
    )

    .put(
      "/projects/:id/notify-preference",
      validate("json", notifyPreferenceRequestSchema),
      async (c) => {
        await projectService.setProjectNotifyPreference(
          getActor(c),
          c.req.param("id"),
          c.req.valid("json").notifyOnComplete,
        );
        return c.json({ ok: true as const }, 200);
      },
    )

    .get(
      "/projects/:id/runs/:workflowRunId",
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

    // `?view=status` is the shell's cheap read: the transcript's status only.
    .get("/projects/:id/transcript", validate("query", transcriptViewQuerySchema), async (c) => {
      if (c.req.valid("query").view === "status") {
        const transcript = await projectService.getTranscriptStatusSnapshot(getActor(c), c.req.param("id"));
        return c.json({ view: "status" as const, transcript }, 200);
      }
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
      validate("query", transcriptExportQuerySchema),
      async (c) => {
        const exported = await projectService.getTranscriptExport(
          getActor(c),
          c.req.param("id"),
          c.req.valid("query").format,
        );
        c.header("Content-Type", exported.contentType);
        c.header("Content-Disposition", `attachment; filename="${exported.fileName}"`);
        return c.body(exported.body, 200);
      },
    )

    .get(
      "/projects/:id/content-suite",
      async (c) => {
        const assets = await contentSuiteService.list(getActor(c), c.req.param("id"));
        return c.json({ assets }, 200);
      },
    )

    .post(
      "/projects/:id/content-suite",
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

    .get("/projects/:id/analytics", async (c) => {
      const analytics = await analyticsService.getProjectAnalytics(getActor(c), c.req.param("id"));
      return c.json(analytics, 200);
    })

    .get("/projects/:id/dubs", async (c) => {
      const dubs = await dubbingService.listProjectDubs(getActor(c), c.req.param("id"));
      return c.json({ dubs }, 200);
    })

    .get("/projects/:id/dubs/allowance", async (c) => {
      const allowance = await dubbingService.getDubbingAllowance(getActor(c));
      return c.json({ allowance }, 200);
    })

    .post(
      "/projects/:id/dubs",
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
