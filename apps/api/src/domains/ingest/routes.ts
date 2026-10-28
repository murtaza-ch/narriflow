import {
  type IngestJobLifecycle,
  type UploadSessionService,
  brandProfileService,
  brandTemplateService,
  projectService,
  recipeService,
} from "@narriflow/services";
import {
  discardUploadSessionSchema,
  finalizeUploadSessionSchema,
  grantUploadPartsSchema,
  openUploadSessionSchema,
  readUploadSessionSchema,
  rssPreviewSchema,
} from "@narriflow/validators";
import {
  driveCommitRequestSchema,
  generationSetupSchema,
  linkCommitRequestSchema,
  linkMetadataQuerySchema,
  rssImportRequestSchema,
} from "@narriflow/validators/api/ingest";
import { createRouteApp, getActor } from "../../http/admission";
import { validate } from "../../http/route";
import { ingestAdmission as access } from "./admission";

/** Services the ingest routes call. `runtime.ts` supplies the production instances. */
export interface IngestRouteDeps {
  projectService: typeof projectService;
  recipeService: typeof recipeService;
  brandTemplateService: typeof brandTemplateService;
  brandProfileService: typeof brandProfileService;
  uploadSessionService: Pick<UploadSessionService, "open" | "finalize" | "grant" | "status" | "discard">;
  ingestJobLifecycle(): Pick<IngestJobLifecycle, "retry">;
}

/** Every Brand Profile the picker can offer, not the default page of 24. */
const PICKER_PROFILE_LIMIT = 100;

/**
 * Intake: link, Google Drive and RSS commits, the Configure step's draft and
 * finalize, ingest retry and resume, direct Upload Sessions, and the aggregate
 * the upload screen loads. Literal paths are registered before `:projectId`.
 */
export function createIngestRoutes(deps: IngestRouteDeps) {
  const { projectService, recipeService, brandTemplateService, brandProfileService, uploadSessionService, ingestJobLifecycle } = deps;

  return createRouteApp(access)
    .get("/ingest/configuration", async (c) => {
      const actor = getActor(c);
      const [brandTemplates, brandProfiles, defaultBrandProfileId, usageSummary, recipes] = await Promise.all([
        brandTemplateService.list(actor),
        brandProfileService.list(actor, { limit: PICKER_PROFILE_LIMIT, includeDeleted: false }),
        brandProfileService.getApplicableDefaultId(actor),
        projectService.getUsageSummary(actor),
        recipeService.list(actor),
      ]);
      return c.json(
        { brandTemplates, brandProfiles: { items: brandProfiles, defaultId: defaultBrandProfileId }, usageSummary, recipes },
        200,
      );
    })

    .get("/ingest/link/metadata", validate("query", linkMetadataQuerySchema), async (c) => {
      return c.json({ title: await projectService.fetchLinkTitle(c.req.valid("query").url) }, 200);
    })

    // Step 1 (Commit). The commit token is the intake's own idempotency identity:
    // a repeated submit returns the Project the first one created.
    .post("/ingest/link", validate("json", linkCommitRequestSchema), async (c) => {
      const input = c.req.valid("json");
      const title = input.title?.trim() || (await projectService.fetchLinkTitle(input.url)) || undefined;
      const response = await projectService.queueLinkIngest(getActor(c), { ...input, title });
      return c.json(response, 202);
    })

    // The Drive access token is request data only: it is sealed on the Ingest Job and never returned or logged.
    .post("/ingest/drive", validate("json", driveCommitRequestSchema), async (c) => {
      const input = c.req.valid("json");
      const response = await projectService.queueDriveIngest(getActor(c), {
        ...input,
        title: input.title?.trim() || undefined,
      });
      return c.json(response, 202);
    })

    .post("/ingest/rss/preview", validate("json", rssPreviewSchema), async (c) => {
      const response = await projectService.previewRssFeed(getActor(c), c.req.valid("json").rssUrl);
      return c.json(response, 200);
    })

    .post("/ingest/rss/import", validate("json", rssImportRequestSchema), async (c) => {
      const { contentPack, languageCode, ...episode } = c.req.valid("json");
      const response = await projectService.importFromRss(getActor(c), episode, { contentPack, languageCode });
      return c.json(response, 202);
    })

    .get("/ingest/:projectId", async (c) => {
      const snapshot = await projectService.getIngestSnapshot(getActor(c), c.req.param("projectId"));
      if (!snapshot) {
        return c.json({ error: "project_not_found" }, 404);
      }
      return c.json(snapshot, 200);
    })

    .get("/ingest/:projectId/resume", async (c) => {
      return c.json(await projectService.getLinkResume(getActor(c), c.req.param("projectId")), 200);
    })

    // Expected refusals (retry limit, not failed, Drive re-pick) are typed domain failures.
    .post("/ingest/:projectId/retry", async (c) => {
      const actor = getActor(c);
      const retried = await ingestJobLifecycle().retry({
        projectId: c.req.param("projectId"),
        workspaceId: actor.workspaceId,
        actorUserId: actor.actorUserId,
      });
      return c.json({ ok: true as const, ...retried }, 200);
    })

    // Draft and finalize are separate acceptances: a draft is a naturally idempotent
    // replacement, finalize claims the run once.
    .put("/projects/:id/generation/draft", validate("json", generationSetupSchema), async (c) => {
      const { contentPack, languageCode } = c.req.valid("json");
      const saved = await projectService.saveGenerationDraft(getActor(c), c.req.param("id"), contentPack, languageCode);
      return c.json({ ok: true as const, saved }, 200);
    })

    .post("/projects/:id/generation/finalize", validate("json", generationSetupSchema), async (c) => {
      const { contentPack, languageCode } = c.req.valid("json");
      const result = await projectService.finalizeGenerationSetup(getActor(c), c.req.param("id"), contentPack, languageCode);
      return c.json({ ok: true as const, ...result }, 200);
    })

    // Upload Sessions keep their native client key, multipart bounds and resume;
    // reconciliation and compensation answer 202 with Retry-After.
    .post("/upload-sessions/open", validate("json", openUploadSessionSchema), async (c) => {
      const outcome = await uploadSessionService.open(getActor(c), c.req.valid("json"));
      if (outcome.outcome === "reconciling") {
        c.header("Retry-After", String(outcome.retryAfterSeconds));
        return c.json(outcome, 202);
      }
      return c.json(outcome, 200);
    })

    .post("/upload-sessions/finalize", validate("json", finalizeUploadSessionSchema), async (c) => {
      const outcome = await uploadSessionService.finalize(getActor(c), c.req.valid("json"));
      if (outcome.outcome === "reconciling") {
        c.header("Retry-After", String(outcome.retryAfterSeconds));
        return c.json(outcome, 202);
      }
      return c.json(outcome, 200);
    })

    .post("/upload-sessions/grants", validate("json", grantUploadPartsSchema), async (c) => {
      return c.json(await uploadSessionService.grant(getActor(c), c.req.valid("json")), 200);
    })

    .post("/upload-sessions/status", validate("json", readUploadSessionSchema), async (c) => {
      const outcome = await uploadSessionService.status(getActor(c), c.req.valid("json"));
      if (outcome.outcome === "reconciling") {
        c.header("Retry-After", String(outcome.retryAfterSeconds));
        return c.json(outcome, 202);
      }
      return c.json(outcome, 200);
    })

    .post("/upload-sessions/discard", validate("json", discardUploadSessionSchema), async (c) => {
      const outcome = await uploadSessionService.discard(getActor(c), c.req.valid("json"));
      if (outcome.outcome === "compensating") {
        c.header("Retry-After", String(outcome.retryAfterSeconds));
        return c.json(outcome, 202);
      }
      return c.json(outcome, 200);
    });
}

export type IngestRoutes = ReturnType<typeof createIngestRoutes>;
