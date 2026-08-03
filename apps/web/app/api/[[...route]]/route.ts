import { Hono } from "hono";
import { handle } from "hono/vercel";
import { getCurrentAppUser } from "@narriflow/auth";
import {
  brandTemplateInputSchema,
  brandTemplateUpdateSchema,
  completeMultipartUploadSchema,
  clipDownloadQuerySchema,
  checkoutRequestSchema,
  contentPackSchema,
  autopilotRuleInputSchema,
  autopilotRuleUpdateSchema,
  duplicateBrandTemplateSchema,
  dubDownloadQuerySchema,
  generateContentSuiteRequestSchema,
  generateProjectRequestSchema,
  linkIngestSchema,
  presignBrandLogoSchema,
  requestClipDubSchema,
  rssImportSchema,
  rssPreviewSchema,
  scheduleSocialPostSchema,
  socialPlatformSchema,
  socialPostMetricsSchema,
  presignUploadSchema,
  transcriptExportFormatSchema,
  triggerClipRenderSchema,
  brollSearchQuerySchema,
  resetEditorDocumentSchema,
  saveEditorDocumentSchema,
  updateClipBoundariesSchema,
  updateClipBrollSchema,
  updateClipCaptionPresetSchema,
  updateClipStudioEditsSchema,
  updateClipTitleSchema,
  updateClipTranscriptSliceSchema,
  userErrorMessage,
} from "@narriflow/validators";
import {
  billingService,
  BillingError,
  checkRateLimit,
  analyticsService,
  autopilotService,
  searchBrollVideos,
  isPexelsConfigured,
  brandTemplateService,
  BrandTemplateForbiddenError,
  BrandTemplateNotFoundError,
  clipService,
  ClipActionError,
  ClipEditorRevisionConflictError,
  contentSuiteService,
  ContentSuiteError,
  dubbingService,
  DubbingTierError,
  projectService,
  QuotaExceededError,
  RemoteFetchError,
  socialOAuthService,
  SocialOAuthError,
  socialService,
  UnsafeUrlError,
  UploadCompletionReconciliationRequiredError,
  UploadSessionUnavailableError,
  UploadTooLongError,
} from "@narriflow/services";
import {
  resolveCanonicalAppOrigin,
  safeSocialRedirectPath,
} from "@/lib/safe-redirect";

export const runtime = "nodejs";
// Content-suite generation makes a synchronous LLM call that can take ~30s.
export const maxDuration = 60;

const app = new Hono().basePath("/api");

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected server error";
}

function getOAuthOrigin(requestUrl: string) {
  return resolveCanonicalAppOrigin({
    configuredOrigin: process.env.NEXT_PUBLIC_APP_URL,
    environment: process.env.NODE_ENV,
    requestUrl,
  });
}

app.get("/health", (c) => c.json({ ok: true, service: "narriflow-web-api" }));

// --- Autopilot rules ---

app.get("/autopilot/rules", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  try {
    const rules = await autopilotService.listRules(appUser.id);
    return c.json({ rules }, 200);
  } catch (error) {
    return c.json(
      { error: "autopilot_rules_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/autopilot/rules", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const payload = await c.req.json().catch(() => ({}));
  const parsed = autopilotRuleInputSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const rule = await autopilotService.createRule(appUser.id, parsed.data);
    return c.json(rule, 201);
  } catch (error) {
    return c.json(
      { error: "autopilot_rule_create_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.patch("/autopilot/rules/:ruleId", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const payload = await c.req.json().catch(() => ({}));
  const parsed = autopilotRuleUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const rule = await autopilotService.updateRule(
      appUser.id,
      c.req.param("ruleId"),
      parsed.data,
    );
    return c.json(rule, 200);
  } catch (error) {
    return c.json(
      { error: "autopilot_rule_update_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.delete("/autopilot/rules/:ruleId", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  try {
    await autopilotService.deleteRule(appUser.id, c.req.param("ruleId"));
    return c.json({ ok: true }, 200);
  } catch (error) {
    return c.json(
      { error: "autopilot_rule_delete_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/autopilot/rules/:ruleId/run-now", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  try {
    const rule = await autopilotService.triggerRuleNow(
      appUser.id,
      c.req.param("ruleId"),
    );
    return c.json(rule, 200);
  } catch (error) {
    return c.json(
      { error: "autopilot_rule_run_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.get("/projects", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const cursor = c.req.query("cursor") ?? null;

  try {
    const page = await projectService.listProjectsWithStatsPage(appUser.id, {
      limit,
      cursor,
    });
    return c.json(page, 200);
  } catch (error) {
    return c.json(
      { error: "project_list_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/projects/:id/generate", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const rl = await checkRateLimit(`gen:${appUser.id}`, 20, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const idempotencyKey = c.req.header("idempotency-key") ?? "";

  if (!idempotencyKey) {
    return c.json({ error: "Missing idempotency-key header" }, 400);
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = generateProjectRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const result = await projectService.triggerGeneration(
      appUser.id,
      projectId,
      parsed.data,
      idempotencyKey,
    );
    return c.json(result, 202);
  } catch (error) {
    if (
      error instanceof QuotaExceededError ||
      error instanceof UploadTooLongError
    ) {
      return c.json(
        { error: error.code, message: error.message, details: error.details },
        402,
      );
    }
    return c.json(
      { error: "generation_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.get("/projects/:id", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const snapshot = await projectService.getProjectSnapshot(
    appUser.id,
    projectId,
  );

  if (!snapshot.project) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json(snapshot, 200);
});

app.get("/projects/:id/runs/:workflowRunId", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const workflowRunId = c.req.param("workflowRunId");
  const snapshot = await projectService.getWorkflowRun(
    projectId,
    workflowRunId,
  );

  if (!snapshot.run) {
    return c.json({ error: "Workflow run not found" }, 404);
  }

  return c.json(snapshot, 200);
});

app.get("/projects/:id/transcript", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const transcript = await projectService.getTranscriptSnapshot(
    appUser.id,
    projectId,
  );

  if (!transcript) {
    return c.json({ error: "Transcript not found" }, 404);
  }

  return c.json(transcript, 200);
});

// Lean word-level transcript for the Trim/Extend editor: raw utterances
// only, no snapshot re-validation (see getTranscriptUtterancesRaw). Browser-
// cacheable briefly — the client also keeps a session-level parsed cache.
app.get("/projects/:id/transcript/utterances", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const utterances = await projectService.getTranscriptUtterancesRaw(
    appUser.id,
    projectId,
  );

  if (utterances === null) {
    return c.json({ error: "Transcript not found" }, 404);
  }

  c.header("Cache-Control", "private, max-age=120");
  return c.json({ utterances }, 200);
});

app.get("/projects/:id/transcript/export", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const format = transcriptExportFormatSchema.safeParse(
    c.req.query("format") ?? "txt",
  );

  if (!format.success) {
    return c.json({ error: "Invalid transcript export format" }, 400);
  }

  try {
    const exported = await projectService.getTranscriptExport(
      appUser.id,
      projectId,
      format.data,
    );
    c.header("Content-Type", exported.contentType);
    c.header(
      "Content-Disposition",
      `attachment; filename="${exported.fileName}"`,
    );
    return c.body(exported.body, 200);
  } catch (error) {
    return c.json(
      {
        error: "transcript_export_failed",
        message: errorMessage(error),
      },
      400,
    );
  }
});

app.post("/uploads/presign", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const rl = await checkRateLimit(`presign:${appUser.id}`, 60, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = presignUploadSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const response = await projectService.presignMultipartUpload(
      appUser.id,
      parsed.data,
    );
    return c.json(response, 200);
  } catch (error) {
    if (
      error instanceof UploadSessionUnavailableError ||
      error instanceof UploadCompletionReconciliationRequiredError
    ) {
      return c.json(
        {
          error: error.code,
          message: userErrorMessage(error.code) ?? error.message,
        },
        409,
      );
    }
    if (
      error instanceof QuotaExceededError ||
      error instanceof UploadTooLongError
    ) {
      return c.json(
        { error: error.code, message: error.message, details: error.details },
        402,
      );
    }
    return c.json(
      {
        error: "upload_presign_failed",
        message: userErrorMessage("upload_presign_failed"),
      },
      400,
    );
  }
});

app.post("/uploads/complete", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = completeMultipartUploadSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const response = await projectService.completeMultipartUpload(
      appUser.id,
      parsed.data,
    );
    return c.json(response, 200);
  } catch {
    return c.json(
      {
        error: "upload_complete_failed",
        message: userErrorMessage("upload_complete_failed"),
      },
      400,
    );
  }
});

app.post("/ingest/link", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = linkIngestSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const response = await projectService.queueLinkIngest(
      appUser.id,
      parsed.data,
    );
    return c.json(response, 202);
  } catch (error) {
    if (
      error instanceof QuotaExceededError ||
      error instanceof UploadTooLongError
    ) {
      return c.json(
        { error: error.code, message: error.message, details: error.details },
        402,
      );
    }
    return c.json(
      {
        error: "link_ingest_failed",
        message: errorMessage(error),
      },
      400,
    );
  }
});

app.post("/ingest/rss/preview", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = rssPreviewSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const response = await projectService.previewRssFeed(parsed.data.rssUrl);
    return c.json(response, 200);
  } catch (error) {
    const errorCode =
      error instanceof UnsafeUrlError
        ? "remote_url_unsafe"
        : error instanceof RemoteFetchError
          ? error.code === "remote_fetch_timeout"
            ? "remote_fetch_timeout"
            : error.code === "remote_response_too_large"
              ? "rss_feed_too_large"
              : "rss_download_failed"
          : "rss_download_failed";
    return c.json(
      {
        error: "rss_preview_failed",
        message: userErrorMessage(errorCode),
      },
      400,
    );
  }
});

app.post("/ingest/rss/import", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = rssImportSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const response = await projectService.importFromRss(
      appUser.id,
      parsed.data,
    );
    return c.json(response, 202);
  } catch (error) {
    if (
      error instanceof QuotaExceededError ||
      error instanceof UploadTooLongError
    ) {
      return c.json(
        { error: error.code, message: error.message, details: error.details },
        402,
      );
    }
    return c.json(
      {
        error: "rss_import_failed",
        message: errorMessage(error),
      },
      400,
    );
  }
});

app.get("/ingest/:projectId", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("projectId");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const snapshot = await projectService.getIngestSnapshot(
    appUser.id,
    projectId,
  );

  if (!snapshot) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json(snapshot, 200);
});

// --- Clips routes ---

app.get("/projects/:id/clips", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const clips = await clipService.listClips(appUser.id, projectId);
  return c.json({ clips }, 200);
});

app.patch("/projects/:id/clips/:clipId", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const clipId = c.req.param("clipId");
  const payload = await c.req.json().catch(() => null);

  if (!payload || typeof payload !== "object") {
    return c.json({ error: "Invalid payload" }, 400);
  }

  try {
    const titleParsed = updateClipTitleSchema.safeParse(payload);
    if (titleParsed.success) {
      const clip = await clipService.updateClipTitle(
        appUser.id,
        projectId,
        clipId,
        titleParsed.data.title,
      );
      return c.json(clip, 200);
    }

    const boundariesParsed = updateClipBoundariesSchema.safeParse(payload);
    if (boundariesParsed.success) {
      const clip = await clipService.updateClipBoundaries(
        appUser.id,
        projectId,
        clipId,
        boundariesParsed.data,
      );
      return c.json(clip, 200);
    }

    const captionPresetParsed = updateClipCaptionPresetSchema.safeParse(payload);
    if (captionPresetParsed.success) {
      const clip = await clipService.updateClipCaptionPreset(
        appUser.id,
        projectId,
        clipId,
        captionPresetParsed.data.captionPreset,
      );
      return c.json(clip, 200);
    }

    const transcriptParsed = updateClipTranscriptSliceSchema.safeParse(payload);
    if (transcriptParsed.success) {
      const clip = await clipService.updateClipTranscriptSlice(
        appUser.id,
        projectId,
        clipId,
        transcriptParsed.data.transcriptSlice,
      );
      return c.json(clip, 200);
    }

    const brollParsed = updateClipBrollSchema.safeParse(payload);
    if (brollParsed.success) {
      const clip = await clipService.updateClipBroll(
        appUser.id,
        projectId,
        clipId,
        brollParsed.data.brollUrl,
      );
      return c.json(clip, 200);
    }

    // studioEditsSchema carries its own top-level `.default()` (so a bare
    // `{studioEdits: {...}}` update can omit unset sub-fields), which means
    // safeParse(payload) would happily succeed — and silently wipe
    // textLayers/transition/music back to defaults — for ANY object that
    // simply lacks a `studioEdits` key. Only attempt this branch when the
    // body actually claims to be a studio-edits update.
    const studioEditsParsed =
      "studioEdits" in payload
        ? updateClipStudioEditsSchema.safeParse(payload)
        : null;
    if (studioEditsParsed?.success) {
      const clip = await clipService.updateClipStudioEdits(
        appUser.id,
        projectId,
        clipId,
        studioEditsParsed.data.studioEdits,
      );
      return c.json(clip, 200);
    }

    return c.json(
      {
        error: "unrecognized_clip_update",
        message:
          "Body didn't match any supported clip update (status, title, boundaries, captionPreset, transcriptSlice, brollUrl, or studioEdits).",
      },
      400,
    );
  } catch (error) {
    if (error instanceof ClipActionError) {
      return c.json(
        { error: error.code, message: error.message },
        error.code === "clip_not_found" ? 404 : 400,
      );
    }
    return c.json(
      { error: "clip_update_failed", message: errorMessage(error) },
      400,
    );
  }
});

/**
 * Structured server-side log for a failed clip action. These routes previously
 * put the only explanation in the response body, which meant a config problem
 * and a genuine provider fault were indistinguishable in the server log.
 * `code` is included so the mapped user-facing copy can be traced back.
 */
function logClipActionFailure(
  message: string,
  error: unknown,
  context: Record<string, string>,
) {
  console.warn(
    JSON.stringify({
      level: "warn",
      message,
      ...context,
      code: error instanceof ClipActionError ? error.code : "unhandled",
      error: errorMessage(error),
    }),
  );
}

/**
 * Alternative AI-written titles for one clip. Read-only — the caller picks one
 * and PATCHes it back as an ordinary `{ title }` rename, so nothing is
 * overwritten without an explicit choice.
 *
 * Rate limited per user because each call is a real LLM completion and the
 * trigger is a single menu click that's cheap to hammer.
 */
app.post("/projects/:id/clips/:clipId/title-suggestions", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const rl = await checkRateLimit(`clip-title-suggest:${appUser.id}`, 30, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    const titles = await clipService.suggestClipTitles(
      appUser.id,
      projectId,
      c.req.param("clipId"),
    );
    return c.json({ titles }, 200);
  } catch (error) {
    // Log server-side too. Without this the only trace of *why* a 400 happened
    // was the response body, so a misconfigured key looked identical in the
    // server log to a model that returned junk.
    logClipActionFailure("clip_title_suggestions_failed", error, {
      projectId,
      clipId: c.req.param("clipId"),
    });
    if (error instanceof ClipActionError) {
      return c.json(
        { error: error.code, message: error.message },
        error.code === "clip_not_found" ? 404 : 400,
      );
    }
    return c.json(
      { error: "clip_title_suggestion_failed", message: errorMessage(error) },
      400,
    );
  }
});

/**
 * Duplicates a clip, copying its finished renders and preview proxy inside R2
 * so the copy is immediately playable without a re-render. Returns the new
 * clip's snapshot.
 */
app.post("/projects/:id/clips/:clipId/duplicate", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Each duplicate copies real objects in R2; a rate limit keeps a stuck click
  // from fanning out into dozens of copies.
  const rl = await checkRateLimit(`clip-duplicate:${appUser.id}`, 30, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    const clip = await clipService.duplicateClip(
      appUser.id,
      projectId,
      c.req.param("clipId"),
    );
    return c.json(clip, 201);
  } catch (error) {
    logClipActionFailure("clip_duplicate_failed", error, {
      projectId,
      clipId: c.req.param("clipId"),
    });
    if (error instanceof ClipActionError) {
      return c.json(
        { error: error.code, message: error.message },
        error.code === "clip_not_found" ? 404 : 400,
      );
    }
    return c.json(
      { error: "clip_duplicate_failed", message: errorMessage(error) },
      400,
    );
  }
});

/**
 * Studio editor document (docs/plans/vizard-parity.md Phase A): GET returns
 * {revision, document, original}; PUT is the atomic revision-guarded save
 * replacing the legacy per-field PATCHes. 409 carries the current revision so
 * the client can refetch and rebase; 422 rejects boundary changes until
 * in-studio trim lands.
 */
app.get("/projects/:id/clips/:clipId/editor", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }
  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    const result = await clipService.getClipEditorDocument(
      appUser.id,
      projectId,
      c.req.param("clipId"),
    );
    return c.json(result, 200);
  } catch (error) {
    if (error instanceof Error && error.message === "clip not found") {
      return c.json({ error: "Clip not found" }, 404);
    }
    throw error;
  }
});

app.put("/projects/:id/clips/:clipId/editor", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }
  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const parsed = saveEditorDocumentSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  try {
    const result = await clipService.saveClipEditorDocument(
      appUser.id,
      projectId,
      c.req.param("clipId"),
      parsed.data,
    );
    return c.json(result, 200);
  } catch (error) {
    if (error instanceof ClipEditorRevisionConflictError) {
      return c.json(
        {
          error: "editor_revision_conflict",
          currentRevision: error.currentRevision,
        },
        409,
      );
    }
    if (
      error instanceof ClipActionError &&
      error.code === "editor_boundaries_immutable"
    ) {
      return c.json({ error: error.code }, 422);
    }
    if (error instanceof Error && error.message === "clip not found") {
      return c.json({ error: "Clip not found" }, 404);
    }
    throw error;
  }
});

/**
 * Reset-to-original (docs/plans/vizard-parity.md Phase A step 4): restores
 * the editor document — including clip boundaries — from the immutable
 * revision-zero snapshot. Same revision-guard/error mapping as the PUT above.
 */
app.post("/projects/:id/clips/:clipId/editor/reset", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }
  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const parsed = resetEditorDocumentSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  try {
    const result = await clipService.resetClipEditorToOriginal(
      appUser.id,
      projectId,
      c.req.param("clipId"),
      parsed.data.baseRevision,
    );
    return c.json(result, 200);
  } catch (error) {
    if (error instanceof ClipEditorRevisionConflictError) {
      return c.json(
        {
          error: "editor_revision_conflict",
          currentRevision: error.currentRevision,
        },
        409,
      );
    }
    if (error instanceof Error && error.message === "clip not found") {
      return c.json({ error: "Clip not found" }, 404);
    }
    throw error;
  }
});

/**
 * Permanently deletes one clip and its stored assets. Refused with
 * `clip_has_scheduled_posts` while the clip has scheduled or publishing social
 * posts — see ClipService.deleteClip for why cancelling those first is the only
 * safe order.
 */
app.delete("/projects/:id/clips/:clipId", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    await clipService.deleteClip(appUser.id, projectId, c.req.param("clipId"));
    return c.json({ ok: true }, 200);
  } catch (error) {
    logClipActionFailure("clip_delete_failed", error, {
      projectId,
      clipId: c.req.param("clipId"),
    });
    if (error instanceof ClipActionError) {
      return c.json(
        { error: error.code, message: error.message },
        error.code === "clip_not_found"
          ? 404
          : error.code === "clip_has_scheduled_posts"
            ? 409
            : 400,
      );
    }
    return c.json(
      { error: "clip_delete_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/projects/:id/clips/regenerate", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const rl = await checkRateLimit(`regenerate:${appUser.id}`, 20, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const idempotencyKey = c.req.header("idempotency-key") ?? "";

  if (!idempotencyKey) {
    return c.json({ error: "Missing idempotency-key header" }, 400);
  }

  try {
    const payload = await c.req.json().catch(() => ({}));
    const contentPackParsed = contentPackSchema.safeParse(
      payload?.contentPack,
    );
    const contentPack = contentPackParsed.success
      ? contentPackParsed.data
      : undefined;
    const result = await clipService.regenerateClips(
      appUser.id,
      projectId,
      idempotencyKey,
      contentPack,
    );
    return c.json(result, 202);
  } catch (error) {
    return c.json(
      { error: "clip_regeneration_failed", message: errorMessage(error) },
      400,
    );
  }
});

// --- Clip rendering routes ---

app.post("/projects/:id/clips/render", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const rl = await checkRateLimit(`render:${appUser.id}`, 20, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const idempotencyKey = c.req.header("idempotency-key") ?? "";

  if (!idempotencyKey) {
    return c.json({ error: "Missing idempotency-key header" }, 400);
  }

  const payload = await c.req.json().catch(() => ({}));
  const parsed = triggerClipRenderSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const result = await clipService.triggerClipRendering(
      appUser.id,
      projectId,
      idempotencyKey,
      parsed.data.clipIds,
      parsed.data.aspectRatios,
    );
    return c.json(result, 202);
  } catch (error) {
    return c.json(
      { error: "clip_render_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/projects/:id/clips/apply-caption-preset", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const payload = await c.req.json().catch(() => ({}));
  const parsed = updateClipCaptionPresetSchema.safeParse(payload);

  if (!parsed.success || parsed.data.captionPreset === null) {
    return c.json(
      {
        error: "Invalid payload",
        issues: parsed.success ? [] : parsed.error.issues,
      },
      400,
    );
  }

  try {
    const result = await clipService.applyCaptionPresetToAllClips(
      appUser.id,
      projectId,
      parsed.data.captionPreset,
    );
    return c.json(result, 200);
  } catch (error) {
    return c.json(
      { error: "apply_caption_preset_failed", message: errorMessage(error) },
      400,
    );
  }
});

// --- Billing (Stripe) ---

app.post("/billing/checkout", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const payload = await c.req.json().catch(() => ({}));
  const parsed = checkoutRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const origin = new URL(c.req.url).origin;
  try {
    const result = await billingService.createCheckoutSession(
      appUser.id,
      parsed.data.tier,
      parsed.data.interval,
      {
        successUrl: `${origin}/dashboard?upgraded=1`,
        cancelUrl: `${origin}/settings/billing`,
      },
    );
    return c.json(result, 200);
  } catch (error) {
    if (error instanceof BillingError) {
      return c.json({ error: error.code, message: error.message }, 400);
    }
    return c.json(
      { error: "checkout_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/billing/portal", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const origin = new URL(c.req.url).origin;
  try {
    const result = await billingService.createBillingPortalSession(
      appUser.id,
      `${origin}/settings/billing`,
    );
    return c.json(result, 200);
  } catch (error) {
    if (error instanceof BillingError) {
      return c.json({ error: error.code, message: error.message }, 400);
    }
    return c.json({ error: "portal_failed", message: errorMessage(error) }, 400);
  }
});

// --- Stock B-roll search (Pexels) ---

app.get("/broll/search", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const rl = await checkRateLimit(`broll-search:${appUser.id}`, 60, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  if (!isPexelsConfigured()) {
    return c.json({ configured: false, results: [] }, 200);
  }

  const parsed = brollSearchQuerySchema.safeParse({
    query: c.req.query("query") ?? "",
    orientation: c.req.query("orientation") ?? "portrait",
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }

  const results = await searchBrollVideos(
    parsed.data.query,
    parsed.data.orientation,
  );
  return c.json({ configured: true, results }, 200);
});

// --- Content suite (repurposed text outputs) ---

app.get("/projects/:id/content-suite", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") return c.json({ error: "Project not found" }, 404);
  if (access === "forbidden") return c.json({ error: "Forbidden" }, 403);

  try {
    const assets = await contentSuiteService.list(appUser.id, projectId);
    return c.json({ assets }, 200);
  } catch (error) {
    if (error instanceof ContentSuiteError) {
      return c.json({ error: error.code, message: error.message }, 400);
    }
    return c.json(
      { error: "content_suite_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/projects/:id/content-suite", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const rl = await checkRateLimit(`content-suite:${appUser.id}`, 30, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") return c.json({ error: "Project not found" }, 404);
  if (access === "forbidden") return c.json({ error: "Forbidden" }, 403);

  const payload = await c.req.json().catch(() => ({}));
  const parsed = generateContentSuiteRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const assets = await contentSuiteService.generate(
      appUser.id,
      projectId,
      parsed.data.types,
    );
    return c.json({ assets }, 200);
  } catch (error) {
    if (error instanceof ContentSuiteError) {
      if (error.code === "requires_creator_plan") {
        return c.json(
          { error: error.code, message: userErrorMessage(error.code) },
          402,
        );
      }
      const status = error.code === "transcript_not_ready" ? 409 : 400;
      return c.json({ error: error.code, message: error.message }, status);
    }
    return c.json(
      { error: "content_suite_failed", message: errorMessage(error) },
      400,
    );
  }
});

// --- First-party analytics ---

app.get("/projects/:id/analytics", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") return c.json({ error: "Project not found" }, 404);
  if (access === "forbidden") return c.json({ error: "Forbidden" }, 403);

  try {
    const analytics = await analyticsService.getProjectAnalytics(
      appUser.id,
      projectId,
    );
    return c.json(analytics, 200);
  } catch (error) {
    return c.json(
      { error: "analytics_failed", message: errorMessage(error) },
      400,
    );
  }
});

// --- Native social accounts ---

app.get("/social/accounts", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  try {
    const accounts = await socialOAuthService.listAccounts(appUser.id);
    return c.json({ accounts }, 200);
  } catch (error) {
    return c.json(
      { error: "social_accounts_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.get("/social/oauth/start/:platform", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const parsedPlatform = socialPlatformSchema.safeParse(c.req.param("platform"));
  if (!parsedPlatform.success) {
    return c.json({ error: "Unsupported social platform" }, 400);
  }

  let origin: string;
  try {
    origin = getOAuthOrigin(c.req.url);
  } catch {
    return c.json(
      {
        error: "social_oauth_origin_invalid",
        message: userErrorMessage("social_oauth_origin_invalid"),
      },
      503,
    );
  }

  try {
    const url = await socialOAuthService.createAuthorizationUrl({
      userId: appUser.id,
      platform: parsedPlatform.data,
      origin,
      redirectPath: safeSocialRedirectPath(c.req.query("redirect")),
    });
    return c.redirect(url, 302);
  } catch (error) {
    const code =
      error instanceof SocialOAuthError
        ? error.code
        : "social_oauth_start_failed";
    const redirect = new URL(
      safeSocialRedirectPath(c.req.query("redirect")),
      origin,
    );
    redirect.searchParams.set("error", code);
    return c.redirect(redirect.toString(), 302);
  }
});

app.get("/social/oauth/callback", async (c) => {
  let origin: string;
  try {
    origin = getOAuthOrigin(c.req.url);
  } catch {
    return c.json(
      {
        error: "social_oauth_origin_invalid",
        message: userErrorMessage("social_oauth_origin_invalid"),
      },
      503,
    );
  }
  const redirect = new URL("/settings/social", origin);
  const code = c.req.query("code");
  const state = c.req.query("state");
  const providerError = c.req.query("error");

  if (providerError) {
    redirect.searchParams.set("error", providerError);
    return c.redirect(redirect.toString(), 302);
  }

  if (!code || !state) {
    redirect.searchParams.set("error", "social_oauth_callback_missing");
    return c.redirect(redirect.toString(), 302);
  }

  try {
    const result = await socialOAuthService.handleCallback({
      state,
      code,
      origin,
    });
    const successRedirect = new URL(
      safeSocialRedirectPath(result.redirectPath),
      origin,
    );
    successRedirect.searchParams.set("connected", String(result.accounts.length));
    return c.redirect(successRedirect.toString(), 302);
  } catch (error) {
    redirect.searchParams.set(
      "error",
      error instanceof SocialOAuthError ? error.code : "social_oauth_callback_failed",
    );
    return c.redirect(redirect.toString(), 302);
  }
});

app.delete("/social/accounts/:accountId", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  try {
    await socialOAuthService.disconnectAccount(
      appUser.id,
      c.req.param("accountId"),
    );
    return c.json({ ok: true }, 200);
  } catch (error) {
    return c.json(
      { error: "social_account_disconnect_failed", message: errorMessage(error) },
      400,
    );
  }
});

// --- Social scheduling metadata ---

app.get("/projects/:id/social-posts", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") return c.json({ error: "Project not found" }, 404);
  if (access === "forbidden") return c.json({ error: "Forbidden" }, 403);

  try {
    const posts = await socialService.listProjectPosts(appUser.id, projectId);
    return c.json({ posts }, 200);
  } catch (error) {
    return c.json(
      { error: "social_posts_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/projects/:id/social-posts", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const rl = await checkRateLimit(`social-posts:${appUser.id}`, 30, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") return c.json({ error: "Project not found" }, 404);
  if (access === "forbidden") return c.json({ error: "Forbidden" }, 403);

  const payload = await c.req.json().catch(() => ({}));
  const parsed = scheduleSocialPostSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const post = await socialService.schedulePost(
      appUser.id,
      projectId,
      parsed.data,
    );
    return c.json(post, 201);
  } catch (error) {
    return c.json(
      { error: "social_post_schedule_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.delete("/projects/:id/social-posts/:postId", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") return c.json({ error: "Project not found" }, 404);
  if (access === "forbidden") return c.json({ error: "Forbidden" }, 403);

  try {
    const post = await socialService.cancelPost(
      appUser.id,
      projectId,
      c.req.param("postId"),
    );
    return c.json(post, 200);
  } catch (error) {
    return c.json(
      { error: "social_post_cancel_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/projects/:id/social-posts/:postId/metrics", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") return c.json({ error: "Project not found" }, 404);
  if (access === "forbidden") return c.json({ error: "Forbidden" }, 403);

  const payload = await c.req.json().catch(() => ({}));
  const parsed = socialPostMetricsSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const post = await socialService.recordPostMetrics(
      appUser.id,
      projectId,
      c.req.param("postId"),
      parsed.data,
    );
    return c.json(post, 201);
  } catch (error) {
    return c.json(
      { error: "social_post_metrics_failed", message: errorMessage(error) },
      400,
    );
  }
});

// --- Voiceover dubbing ---

app.get("/projects/:id/dubs", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") return c.json({ error: "Project not found" }, 404);
  if (access === "forbidden") return c.json({ error: "Forbidden" }, 403);

  try {
    const dubs = await dubbingService.listProjectDubs(appUser.id, projectId);
    return c.json({ dubs }, 200);
  } catch (error) {
    return c.json(
      { error: "dubs_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/projects/:id/dubs", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const rl = await checkRateLimit(`dubs:${appUser.id}`, 20, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") return c.json({ error: "Project not found" }, 404);
  if (access === "forbidden") return c.json({ error: "Forbidden" }, 403);

  const idempotencyKey = c.req.header("idempotency-key") ?? "";
  if (!idempotencyKey) {
    return c.json({ error: "Missing idempotency-key header" }, 400);
  }

  const payload = await c.req.json().catch(() => ({}));
  const parsed = requestClipDubSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const result = await dubbingService.requestClipDub(
      appUser.id,
      projectId,
      idempotencyKey,
      parsed.data,
    );
    return c.json(result, 202);
  } catch (error) {
    if (error instanceof DubbingTierError) {
      return c.json(
        { error: "requires_pro_plan", message: userErrorMessage("requires_pro_plan") },
        402,
      );
    }
    return c.json(
      { error: "dub_request_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.get("/projects/:id/dubs/:dubId/download", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);
  if (access === "missing") return c.json({ error: "Project not found" }, 404);
  if (access === "forbidden") return c.json({ error: "Forbidden" }, 403);

  const parsed = dubDownloadQuerySchema.safeParse({
    asset: c.req.query("asset") ?? undefined,
  });
  if (!parsed.success) {
    return c.json(
      { error: "Invalid query", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const result = await dubbingService.getDubDownloadUrl(
      appUser.id,
      projectId,
      c.req.param("dubId"),
      parsed.data.asset,
    );
    return c.json(result, 200);
  } catch (error) {
    return c.json(
      { error: "dub_download_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.get("/projects/:id/clips/:clipId/download", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(appUser.id, projectId);

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const clipId = c.req.param("clipId");
  const parsedQuery = clipDownloadQuerySchema.safeParse({
    aspectRatio:
      new URL(c.req.url).searchParams.get("aspectRatio") ?? undefined,
  });

  if (!parsedQuery.success) {
    return c.json(
      { error: "Invalid query", issues: parsedQuery.error.issues },
      400,
    );
  }

  try {
    const result = await clipService.getClipDownloadUrl(
      appUser.id,
      projectId,
      clipId,
      parsedQuery.data.aspectRatio,
    );
    return c.json(result, 200);
  } catch (error) {
    return c.json(
      { error: "clip_download_failed", message: errorMessage(error) },
      400,
    );
  }
});

function brandTemplateErrorResponse(error: unknown) {
  if (error instanceof BrandTemplateNotFoundError) {
    return { status: 404 as const, body: { error: "brand_template_not_found" } };
  }
  if (error instanceof BrandTemplateForbiddenError) {
    return { status: 403 as const, body: { error: "brand_template_forbidden" } };
  }
  return {
    status: 400 as const,
    body: { error: "brand_template_failed", message: errorMessage(error) },
  };
}

app.get("/brand-templates", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const result = await brandTemplateService.list(appUser.id);
  return c.json(result, 200);
});

app.get("/brand-templates/:id", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  try {
    const template = await brandTemplateService.get(appUser.id, c.req.param("id"));
    return c.json(template, 200);
  } catch (error) {
    const { status, body } = brandTemplateErrorResponse(error);
    return c.json(body, status);
  }
});

app.post("/brand-templates", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const payload = await c.req.json().catch(() => null);
  const parsed = brandTemplateInputSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }
  try {
    const template = await brandTemplateService.create(appUser.id, parsed.data);
    return c.json(template, 201);
  } catch (error) {
    const { status, body } = brandTemplateErrorResponse(error);
    return c.json(body, status);
  }
});

app.patch("/brand-templates/:id", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const payload = await c.req.json().catch(() => null);
  const parsed = brandTemplateUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }
  try {
    const template = await brandTemplateService.update(
      appUser.id,
      c.req.param("id"),
      parsed.data,
    );
    return c.json(template, 200);
  } catch (error) {
    const { status, body } = brandTemplateErrorResponse(error);
    return c.json(body, status);
  }
});

app.delete("/brand-templates/:id", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  try {
    await brandTemplateService.softDelete(appUser.id, c.req.param("id"));
    return c.json({ ok: true }, 200);
  } catch (error) {
    const { status, body } = brandTemplateErrorResponse(error);
    return c.json(body, status);
  }
});

app.post("/brand-templates/:id/set-default", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  try {
    await brandTemplateService.setDefault(appUser.id, c.req.param("id"));
    return c.json({ ok: true }, 200);
  } catch (error) {
    const { status, body } = brandTemplateErrorResponse(error);
    return c.json(body, status);
  }
});

app.post("/brand-templates/:id/duplicate", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const payload = await c.req.json().catch(() => ({}));
  const parsed = duplicateBrandTemplateSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }
  try {
    const template = await brandTemplateService.duplicate(
      appUser.id,
      c.req.param("id"),
      parsed.data.name,
    );
    return c.json(template, 201);
  } catch (error) {
    const { status, body } = brandTemplateErrorResponse(error);
    return c.json(body, status);
  }
});

app.post("/brand-templates/logo/presign", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const rl = await checkRateLimit(`logo-presign:${appUser.id}`, 30, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = presignBrandLogoSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }
  try {
    const result = await brandTemplateService.presignLogoUpload(appUser.id, parsed.data);
    return c.json(result, 200);
  } catch (error) {
    return c.json(
      { error: "brand_template_logo_presign_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.get("/brand-templates/:id/logo-url", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  try {
    const url = await brandTemplateService.getLogoDownloadUrl(
      appUser.id,
      c.req.param("id"),
    );
    if (!url) return c.json({ error: "brand_template_logo_missing" }, 404);
    return c.json({ url }, 200);
  } catch (error) {
    const { status, body } = brandTemplateErrorResponse(error);
    return c.json(body, status);
  }
});

const honoHandler = handle(app);

export const GET = honoHandler;
export const POST = honoHandler;
export const PUT = honoHandler;
export const PATCH = honoHandler;
export const DELETE = honoHandler;
export const OPTIONS = honoHandler;
