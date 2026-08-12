import { Hono } from "hono";
import type { Context, Next } from "hono";
import { handle } from "hono/vercel";
import { after } from "next/server";
import { getCurrentWorkspaceAppUser as getCurrentAppUser } from "@/lib/workspace";
import {
  applyCaptionPresetToAllSchema,
  applyStudioEditsToAllSchema,
  audioAssetIdParamSchema,
  brandTemplateInputSchema,
  brandTemplateUpdateSchema,
  completeMultipartUploadSchema,
  createClipExportSchema,
  createClipShareLinkSchema,
  clipDownloadQuerySchema,
  checkoutRequestSchema,
  contentPackSchema,
  autopilotRuleInputSchema,
  autopilotRuleUpdateSchema,
  duplicateBrandTemplateSchema,
  dubDownloadQuerySchema,
  finalizeAudioUploadSchema,
  generateContentSuiteRequestSchema,
  generateProjectRequestSchema,
  linkIngestSchema,
  listAudioAssetsQuerySchema,
  presignAudioUploadSchema,
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
  createClipFromSelectionSchema,
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
  audioAssetService,
  AudioAssetNotFoundError,
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
  clipExportService,
  ClipExportError,
  ClipExportRevisionConflictError,
  ClipActionError,
  ClipEditorRevisionConflictError,
  contentSuiteService,
  ContentSuiteError,
  dubbingService,
  DubbingTierError,
  isUniqueConstraintError,
  projectService,
  QuotaExceededError,
  RssFeedError,
  RemoteFetchError,
  socialOAuthService,
  SocialOAuthError,
  socialService,
  UnsafeUrlError,
  UploadCompletionReconciliationRequiredError,
  UploadSessionUnavailableError,
  UploadTooLongError,
  workspaceLibraryService,
  workspaceService,
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

// One lifecycle gate for every project API surface. Individual handlers keep
// their ownership checks for explicit errors, but this middleware guarantees
// that a newly-added clip/export/social route cannot accidentally expose an
// expired project by forgetting the retention predicate.
const requireActiveProject = async (c: Context, next: Next) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const projectId = c.req.param("id");
  if (!projectId) return c.json({ error: "Project not found" }, 404);
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }
  if (access === "forbidden") return c.json({ error: "Forbidden" }, 403);
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    try {
      await workspaceService.requireActor(
        appUser.actorUserId,
        appUser.workspaceId,
        "content.edit",
      );
    } catch (error) {
      return c.json(
        { error: "Forbidden", message: errorMessage(error) },
        403,
      );
    }
  }
  await next();
};

app.use("/projects/:id", requireActiveProject);
app.use("/projects/:id/*", requireActiveProject);

// --- Autopilot rules ---

app.get("/autopilot/rules", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  try {
    const rules = await autopilotService.listRules(appUser.id, appUser.workspaceId);
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

  const rl = await checkRateLimit(`autopilot-create:${appUser.workspaceId}`, 5, 60 * 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const payload = await c.req.json().catch(() => ({}));
  const parsed = autopilotRuleInputSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "content.edit");
    const rule = await autopilotService.createRule(appUser.id, parsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
    return c.json(rule, 201);
  } catch (error) {
    const code = errorMessage(error);
    return c.json(
      {
        error: "autopilot_rule_create_failed",
        message: userErrorMessage(code) ?? code,
      },
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
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "content.edit");
    const rule = await autopilotService.updateRule(
      appUser.id,
      c.req.param("ruleId"),
      parsed.data,
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
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
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "content.edit");
    await autopilotService.deleteRule(appUser.id, c.req.param("ruleId"), { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
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

  const rl = await checkRateLimit(`autopilot-run:${appUser.workspaceId}`, 10, 60 * 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  try {
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "content.edit");
    const rule = await autopilotService.triggerRuleNow(
      appUser.id,
      c.req.param("ruleId"),
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
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
  const folderId = c.req.query("folder") || undefined;

  try {
    const page = await projectService.listProjectsWithStatsPage(appUser.actorUserId, {
      limit,
      cursor,
      workspaceId: appUser.workspaceId,
      folderId,
    });
    return c.json(page, 200);
  } catch (error) {
    return c.json(
      { error: "project_list_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.get("/workspace/search", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  try {
    const results = await workspaceLibraryService.search(
      appUser.actorUserId,
      appUser.workspaceId,
      c.req.query("q") ?? "",
    );
    return c.json({ results }, 200);
  } catch (error) {
    return c.json({ error: "workspace_search_failed", message: errorMessage(error) }, 400);
  }
});

app.get("/workspace/exports/:exportId/download", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const exported = await clipExportService.getWorkspaceOwned(
    appUser.workspaceId,
    c.req.param("exportId"),
  );
  if (!exported) return c.json({ error: "Export not found" }, 404);
  const requestedVariantId = c.req.query("variant");
  const variant = requestedVariantId
    ? exported.variants.find(
        (candidate) =>
          candidate.id === requestedVariantId && candidate.downloadUrl,
      )
    : exported.variants.find((candidate) => candidate.downloadUrl);
  if (!variant?.downloadUrl) {
    return c.json({ error: "Export file is not ready" }, 409);
  }
  return c.redirect(variant.downloadUrl, 302);
});

app.post("/workspace/avatar/presign", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const payload = await c.req.json().catch(() => ({}));
  try {
    const result = await workspaceService.presignAvatarUpload(
      appUser.actorUserId,
      appUser.workspaceId,
      {
        contentType: String(payload.contentType ?? ""),
        sizeBytes: Number(payload.sizeBytes),
      },
    );
    return c.json(result, 200);
  } catch (error) {
    return c.json(
      { error: "workspace_avatar_presign_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.patch("/workspace/avatar", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const payload = await c.req.json().catch(() => ({}));
  const storageKey = payload.storageKey === null ? null : String(payload.storageKey ?? "");
  try {
    await workspaceService.setAvatar(
      appUser.actorUserId,
      appUser.workspaceId,
      storageKey || null,
    );
    return c.json({ ok: true }, 200);
  } catch (error) {
    return c.json(
      { error: "workspace_avatar_update_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/projects/:id/generate", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    await workspaceService.requireActor(
      appUser.actorUserId,
      appUser.workspaceId,
      "processing.consume",
    );
  } catch (error) {
    return c.json({ error: "Forbidden", message: errorMessage(error) }, 403);
  }

  const rl = await checkRateLimit(`gen:${appUser.id}`, 20, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
      {
        workspaceContext: {
          workspaceId: appUser.workspaceId,
          actorUserId: appUser.actorUserId,
        },
      },
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
      appUser.actorUserId,
      parsed.data,
      appUser.workspaceId,
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
      appUser.actorUserId,
      parsed.data,
      appUser.workspaceId,
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
      appUser.actorUserId,
      parsed.data,
      appUser.workspaceId,
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

  const rl = await checkRateLimit(`rss-preview:${appUser.workspaceId}`, 20, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
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
          : error instanceof RssFeedError
            ? error.code
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

  const rl = await checkRateLimit(`rss-import:${appUser.workspaceId}`, 5, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
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
      appUser.actorUserId,
      parsed.data,
      appUser.workspaceId,
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
        message:
          userErrorMessage(errorMessage(error)) ?? errorMessage(error),
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const clips = await clipService.listClips(appUser.id, projectId);
  return c.json({ clips }, 200);
});

/** Small same-origin bridge for private-R2 waveform metadata. Video elements
 * can play presigned media without CORS, but browser `fetch()` of JSON cannot;
 * proxying only this bounded, validated artifact avoids a bucket-wide CORS
 * dependency without putting video bytes through the web service. */
app.get("/projects/:id/clips/:clipId/preview-peaks", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const peaks = await clipService.getClipPreviewPeaks(
    appUser.id,
    c.req.param("id"),
    c.req.param("clipId"),
  );
  if (!peaks) return c.body(null, 204);
  c.header("Cache-Control", "private, max-age=3600, immutable");
  return c.json(peaks, 200);
});

app.patch("/projects/:id/clips/:clipId", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
 * Create clip from selection (docs/plans/vizard-parity.md Phase B step 14):
 * a NEW, from-scratch clip carved out of an arbitrary [startSec, endSec)
 * transcript-panel.tsx selection — the selection toolbar's "Create clip"
 * action. Deliberately not a duplicate+retrim chain (see
 * ClipService.createClipFromSelection's doc comment for why that chain can
 * orphan copied render/proxy assets on partial failure); this clip starts
 * with no renders and no preview proxy, and the worker's preview-backfill
 * poll picks it up for a proxy the same way every other proxy-less clip
 * does. `clip_selection_invalid` (the selection sits too close to the edge
 * of the transcript to reach the minimum clip duration) maps to 422; every
 * other failure mode mirrors the duplicate route above.
 */
app.post("/projects/:id/clips/:clipId/create-from-selection", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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

  const parsed = createClipFromSelectionSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }

  try {
    const clip = await clipService.createClipFromSelection(
      appUser.id,
      projectId,
      c.req.param("clipId"),
      parsed.data,
    );
    return c.json(clip, 201);
  } catch (error) {
    logClipActionFailure("clip_create_from_selection_failed", error, {
      projectId,
      clipId: c.req.param("clipId"),
    });
    if (error instanceof ClipActionError) {
      return c.json(
        { error: error.code, message: error.message },
        error.code === "clip_selection_invalid"
          ? 422
          : error.code === "clip_not_found"
            ? 404
            : 400,
      );
    }
    return c.json(
      { error: "clip_create_from_selection_failed", message: errorMessage(error) },
      400,
    );
  }
});

/**
 * Studio editor document (docs/plans/vizard-parity.md Phase A/B): GET returns
 * {revision, document, original}; PUT is the atomic revision-guarded save
 * replacing the legacy per-field PATCHes — including boundary changes since
 * Phase B step 13 (in-studio trim). 409 carries the current revision so the
 * client can refetch and rebase; 422 rejects an invalid boundary change
 * (min-duration/out-of-source-range) or a delete that would leave nothing
 * renderable.
 */
app.get("/projects/:id/clips/:clipId/editor", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
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
      {
        scheduleCleanup: (cleanup) => after(cleanup),
      },
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
      (error.code === "editor_boundaries_invalid" ||
        // Phase B hardening: the client's own isEmpty guard
        // (deleteSelectedSegment/buildStudioCutPlan in studio-shell.tsx)
        // should make this unreachable in practice — this is the
        // server-side backstop for a save whose deletedRanges leave
        // nothing renderable (e.g. two tabs racing each other's edits).
        error.code === "editor_document_empty_timeline")
    ) {
      // Phase B step 13 (in-studio trim): editor_boundaries_invalid is the
      // server-side backstop for min-duration/out-of-source-range trims —
      // the trim handles' own drag guard should make this unreachable in
      // practice too, same rule as the empty-timeline case above.
      return c.json({ error: error.code }, 422);
    }
    // Fix 14: a non-public brollUrl (localhost, a private IP, etc.) used to
    // rethrow as an unhandled 500 here and wedge autosave — the client
    // pre-validates now (broll-panel.tsx), but this stays as the
    // server-side backstop (e.g. a URL that resolves to a private address,
    // which only the DNS-aware half of assertPublicHttpUrl can catch).
    if (error instanceof UnsafeUrlError) {
      return c.json({ error: "unsafe_broll_url" }, 422);
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
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
    // Fix 14: same UnsafeUrlError -> 422 mapping as the PUT above, in case
    // the restored original document's brollUrl is no longer considered
    // public (e.g. it now resolves to a private address).
    if (error instanceof UnsafeUrlError) {
      return c.json({ error: "unsafe_broll_url" }, 422);
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
      {
        workspaceId: appUser.workspaceId,
        actorUserId: appUser.actorUserId,
      },
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
      parsed.data.resolution,
      {
        workspaceId: appUser.workspaceId,
        actorUserId: appUser.actorUserId,
      },
    );
    return c.json(result, 202);
  } catch (error) {
    return c.json(
      { error: "clip_render_failed", message: errorMessage(error) },
      400,
    );
  }
});

// --- Versioned clip exports ---

app.post("/projects/:id/clips/:clipId/exports", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const rl = await checkRateLimit(`clip-export:${appUser.id}`, 20, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const idempotencyKey = c.req.header("idempotency-key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return c.json({ error: "Invalid idempotency-key header" }, 400);
  }
  const payload = await c.req.json().catch(() => ({}));
  const parsed = createClipExportSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  try {
    const result = await clipExportService.create(
      appUser.id,
      c.req.param("id"),
      c.req.param("clipId"),
      parsed.data,
      idempotencyKey,
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
    );
    return c.json(result, result.reused && result.export.status === "ready" ? 200 : 202);
  } catch (error) {
    if (error instanceof ClipExportRevisionConflictError) {
      return c.json(
        { error: error.code, currentRevision: error.currentRevision },
        409,
      );
    }
    if (error instanceof ClipExportError) {
      return c.json({ error: error.code, message: error.message }, 404);
    }
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "clip_export_create_failed",
        projectId: c.req.param("id"),
        clipId: c.req.param("clipId"),
        error: errorMessage(error),
      }),
    );
    return c.json({ error: "clip_export_failed", message: "Could not start export" }, 500);
  }
});

app.get("/projects/:id/clips/:clipId/exports/:exportId", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const result = await clipExportService.getOwned(
    appUser.id,
    c.req.param("id"),
    c.req.param("clipId"),
    c.req.param("exportId"),
    appUser.workspaceId,
  );
  if (!result) return c.json({ error: "Export not found" }, 404);
  return c.json(result, 200, { "Cache-Control": "private, no-store" });
});

app.post("/projects/:id/clips/:clipId/exports/:exportId/retry", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  try {
    await workspaceService.requireActor(
      appUser.actorUserId,
      appUser.workspaceId,
      "processing.consume",
    );
  } catch (error) {
    return c.json({ error: "Forbidden", message: errorMessage(error) }, 403);
  }
  const rl = await checkRateLimit(`clip-export-retry:${appUser.id}`, 12, 60);
  if (!rl.allowed) return c.json({ error: "rate_limited" }, 429);
  try {
    const result = await clipExportService.retryFailed(
      appUser.id,
      c.req.param("id"),
      c.req.param("clipId"),
      c.req.param("exportId"),
      appUser.workspaceId,
    );
    return c.json(result, 202);
  } catch (error) {
    const code = error instanceof ClipExportError ? error.code : "clip_export_retry_failed";
    return c.json({ error: code, message: "Could not retry export" }, 400);
  }
});

app.post("/projects/:id/clips/:clipId/exports/:exportId/share-links", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const rl = await checkRateLimit(`clip-share:${appUser.id}`, 10, 60);
  if (!rl.allowed) return c.json({ error: "rate_limited" }, 429);
  const parsed = createClipShareLinkSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }
  try {
    const result = await clipExportService.createShareLink(
      appUser.id,
      c.req.param("id"),
      c.req.param("clipId"),
      c.req.param("exportId"),
      parsed.data.expiresInDays,
      appUser.workspaceId,
    );
    return c.json(result, 201, { "Cache-Control": "private, no-store" });
  } catch (error) {
    const code = error instanceof ClipExportError ? error.code : "clip_share_failed";
    return c.json({ error: code, message: "Could not create share link" }, 400);
  }
});

app.delete("/projects/:id/clips/:clipId/exports/:exportId/share-links", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  try {
    const result = await clipExportService.revokeShareLinks(
      appUser.id,
      c.req.param("id"),
      c.req.param("clipId"),
      c.req.param("exportId"),
      appUser.workspaceId,
    );
    return c.json(result, 200);
  } catch (error) {
    const code = error instanceof ClipExportError ? error.code : "clip_share_revoke_failed";
    return c.json({ error: code, message: "Could not revoke share links" }, 400);
  }
});

app.post("/projects/:id/clips/apply-caption-preset", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const payload = await c.req.json().catch(() => ({}));
  const parsed = applyCaptionPresetToAllSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const result = await clipService.applyCaptionPresetToAllClips(
      appUser.id,
      projectId,
      parsed.data.captionPreset,
      { excludeClipId: parsed.data.excludeClipId },
    );
    return c.json(result, 200);
  } catch (error) {
    return c.json(
      { error: "apply_caption_preset_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/projects/:id/clips/apply-studio-edits", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const projectId = c.req.param("id");
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

  if (access === "missing") {
    return c.json({ error: "Project not found" }, 404);
  }

  if (access === "forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const payload = await c.req.json().catch(() => ({}));
  const parsed = applyStudioEditsToAllSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const result = await clipService.applyStudioEditsPatchToAllClips(
      appUser.id,
      projectId,
      parsed.data.patch,
      { excludeClipId: parsed.data.excludeClipId },
    );
    return c.json(result, 200);
  } catch (error) {
    return c.json(
      { error: "apply_studio_edits_failed", message: errorMessage(error) },
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
      appUser.actorUserId,
      appUser.workspaceId,
      parsed.data.tier,
      parsed.data.interval,
      {
        successUrl: `${origin}/home?upgraded=1&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/settings/subscription`,
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

app.post("/billing/confirm", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const payload = await c.req.json().catch(() => ({}));
  const sessionId =
    typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
  if (!sessionId) {
    return c.json({ error: "Missing checkout session" }, 400);
  }
  try {
    return c.json(
      await billingService.confirmCheckoutSession(
        appUser.actorUserId,
        appUser.workspaceId,
        sessionId,
      ),
      200,
    );
  } catch (error) {
    if (error instanceof BillingError) {
      return c.json({ error: error.code, message: error.message }, 400);
    }
    return c.json(
      { error: "checkout_confirmation_failed", message: errorMessage(error) },
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
      appUser.actorUserId,
      appUser.workspaceId,
      `${origin}/settings/subscription`,
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
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
    const accounts = await socialOAuthService.listAccounts(appUser.id, appUser.workspaceId);
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
  try {
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "social.manage");
  } catch {
    return c.json({ error: "Forbidden" }, 403);
  }

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
      workspaceId: appUser.workspaceId,
      actorUserId: appUser.actorUserId,
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
  const redirect = new URL("/settings/social-accounts", origin);
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
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "social.manage");
  } catch {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    await socialOAuthService.disconnectAccount(
      appUser.id,
      c.req.param("accountId"),
      appUser.workspaceId,
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
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
      {
        workspaceId: appUser.workspaceId,
        actorUserId: appUser.actorUserId,
      },
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
  if (access === "missing") return c.json({ error: "Project not found" }, 404);
  if (access === "forbidden") return c.json({ error: "Forbidden" }, 403);

  try {
    const post = await socialService.cancelPost(
      appUser.id,
      projectId,
      c.req.param("postId"),
      {
        workspaceId: appUser.workspaceId,
        actorUserId: appUser.actorUserId,
      },
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );
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
  const access = await projectService.getProjectAccess(
    appUser.actorUserId,
    projectId,
    appUser.workspaceId,
  );

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
  const result = await brandTemplateService.list(appUser.id, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  return c.json(result, 200);
});

app.get("/brand-templates/:id", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  try {
    const template = await brandTemplateService.get(appUser.id, c.req.param("id"), { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
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
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "brand.manage");
    const template = await brandTemplateService.create(appUser.id, parsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
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
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "brand.manage");
    const template = await brandTemplateService.update(
      appUser.id,
      c.req.param("id"),
      parsed.data,
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
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
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "brand.manage");
    await brandTemplateService.softDelete(appUser.id, c.req.param("id"), { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
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
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "workspace.manage");
    await brandTemplateService.setDefault(appUser.id, c.req.param("id"), { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
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
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "brand.manage");
    const template = await brandTemplateService.duplicate(
      appUser.id,
      c.req.param("id"),
      parsed.data.name,
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
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
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "brand.manage");
    const result = await brandTemplateService.presignLogoUpload(appUser.id, parsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
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
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
    );
    if (!url) return c.json({ error: "brand_template_logo_missing" }, 404);
    return c.json({ url }, 200);
  } catch (error) {
    const { status, body } = brandTemplateErrorResponse(error);
    return c.json(body, status);
  }
});

// Music/SFX library (docs/plans/vizard-parity.md "Music/SFX library").
// Mirrors the brand-templates logo presign/finalize shape immediately above:
// presign against R2, verify ownership on finalize, serve playback through a
// short-lived presigned download URL.
app.get("/audio-assets", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const parsed = listAudioAssetsQuerySchema.safeParse({
    kind: c.req.query("kind"),
    mood: c.req.query("mood") ?? undefined,
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }
  try {
    const result = await audioAssetService.listAssets(appUser.id, parsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
    return c.json(result, 200);
  } catch (error) {
    return c.json(
      { error: "audio_assets_list_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/audio-assets/presign-upload", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const rl = await checkRateLimit(`audio-asset-presign:${appUser.id}`, 30, 60);
  if (!rl.allowed) {
    return c.json(
      { error: "rate_limited", message: userErrorMessage("rate_limited") },
      429,
    );
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = presignAudioUploadSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }
  try {
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "brand.manage");
    const result = await audioAssetService.presignUpload(appUser.id, parsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
    return c.json(result, 200);
  } catch (error) {
    return c.json(
      { error: "audio_asset_presign_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/audio-assets", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);

  const payload = await c.req.json().catch(() => null);
  const parsed = finalizeAudioUploadSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }
  try {
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "brand.manage");
    const asset = await audioAssetService.finalizeUpload(appUser.id, parsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
    return c.json(asset, 201);
  } catch (error) {
    // L3: a double-click (or a retried finalize) racing the same presigned
    // key finalizes twice — the second hits the `storageKey` unique
    // constraint (P2002). That's a conflict with an existing row, not a
    // generic 400 — surface it as such with a friendly message instead of
    // the raw Prisma error.
    if (isUniqueConstraintError(error)) {
      return c.json(
        {
          error: "audio_asset_duplicate",
          message: "This upload has already been added to your library.",
        },
        409,
      );
    }
    return c.json(
      { error: "audio_asset_finalize_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.get("/audio-assets/:id/playback-url", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  // L3: validate the path param is a UUID before it ever reaches Prisma — a
  // malformed id would otherwise throw a raw PrismaClientValidationError,
  // surfaced through the generic 400 branch below with an ugly internal
  // message instead of a clean, expected one.
  const idParsed = audioAssetIdParamSchema.safeParse(c.req.param("id"));
  if (!idParsed.success) {
    return c.json({ error: "Invalid audio asset id" }, 400);
  }
  try {
    const url = await audioAssetService.getPlaybackUrl(appUser.id, idParsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
    if (!url) return c.json({ error: "audio_asset_not_found" }, 404);
    return c.json({ url }, 200);
  } catch (error) {
    return c.json(
      { error: "audio_asset_playback_url_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.put("/audio-assets/:id/favorite", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const idParsed = audioAssetIdParamSchema.safeParse(c.req.param("id"));
  if (!idParsed.success) return c.json({ error: "Invalid audio asset id" }, 400);
  try {
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "brand.manage");
    return c.json(
      await audioAssetService.setFavorite(appUser.id, idParsed.data, true, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId }),
      200,
    );
  } catch (error) {
    if (error instanceof AudioAssetNotFoundError) {
      return c.json({ error: "audio_asset_not_found" }, 404);
    }
    return c.json(
      { error: "audio_asset_favorite_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.delete("/audio-assets/:id/favorite", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const idParsed = audioAssetIdParamSchema.safeParse(c.req.param("id"));
  if (!idParsed.success) return c.json({ error: "Invalid audio asset id" }, 400);
  try {
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "brand.manage");
    return c.json(
      await audioAssetService.setFavorite(appUser.id, idParsed.data, false, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId }),
      200,
    );
  } catch (error) {
    if (error instanceof AudioAssetNotFoundError) {
      return c.json({ error: "audio_asset_not_found" }, 404);
    }
    return c.json(
      { error: "audio_asset_unfavorite_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.delete("/audio-assets/:id", async (c) => {
  const appUser = await getCurrentAppUser();
  if (!appUser) return c.json({ error: "Unauthorized" }, 401);
  const idParsed = audioAssetIdParamSchema.safeParse(c.req.param("id"));
  if (!idParsed.success) {
    return c.json({ error: "Invalid audio asset id" }, 400);
  }
  try {
    await workspaceService.requireActor(appUser.actorUserId, appUser.workspaceId, "brand.manage");
    await audioAssetService.deleteUserAsset(appUser.id, idParsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
    return c.json({ ok: true }, 200);
  } catch (error) {
    if (error instanceof AudioAssetNotFoundError) {
      return c.json({ error: "audio_asset_not_found" }, 404);
    }
    return c.json(
      { error: "audio_asset_delete_failed", message: errorMessage(error) },
      400,
    );
  }
});

const honoHandler = handle(app);

export const GET = honoHandler;
export const POST = honoHandler;
export const PUT = honoHandler;
export const PATCH = honoHandler;
export const DELETE = honoHandler;
export const OPTIONS = honoHandler;
