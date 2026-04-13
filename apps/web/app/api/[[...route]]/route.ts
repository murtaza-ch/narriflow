import { Hono } from "hono";
import { handle } from "hono/vercel";
import { getCurrentAppUser } from "@narriflow/auth";
import {
  completeMultipartUploadSchema,
  clipDownloadQuerySchema,
  generateProjectRequestSchema,
  rssImportSchema,
  rssPreviewSchema,
  presignUploadSchema,
  transcriptExportFormatSchema,
  triggerClipRenderSchema,
  updateClipBoundariesSchema,
  updateClipCaptionPresetSchema,
  updateClipStatusSchema,
  updateClipTranscriptSliceSchema,
  youtubeIngestSchema,
} from "@narriflow/validators";
import { clipService, projectService } from "@narriflow/services";

export const runtime = "nodejs";

const app = new Hono().basePath("/api");

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected server error";
}

app.get("/health", (c) => c.json({ ok: true, service: "narriflow-web-api" }));

app.post("/projects/:id/generate", async (c) => {
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

  const result = await projectService.triggerGeneration(
    appUser.id,
    projectId,
    parsed.data,
    idempotencyKey,
  );
  return c.json(result, 202);
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
    return c.json(
      {
        error: "upload_presign_failed",
        message: errorMessage(error),
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
  } catch (error) {
    return c.json(
      {
        error: "upload_complete_failed",
        message: errorMessage(error),
      },
      400,
    );
  }
});

app.post("/ingest/youtube", async (c) => {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = youtubeIngestSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const response = await projectService.queueYoutubeIngest(
      appUser.id,
      parsed.data,
    );
    return c.json(response, 202);
  } catch (error) {
    return c.json(
      {
        error: "youtube_ingest_failed",
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
    return c.json(
      {
        error: "rss_preview_failed",
        message: errorMessage(error),
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
    // Check if this is a status update or boundary update
    const statusParsed = updateClipStatusSchema.safeParse(payload);
    if (statusParsed.success) {
      const clip = await clipService.updateClipStatus(
        appUser.id,
        projectId,
        clipId,
        statusParsed.data.status,
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

    return c.json(
      {
        error: "Invalid payload",
        issues: boundariesParsed.error.issues,
      },
      400,
    );
  } catch (error) {
    return c.json(
      { error: "clip_update_failed", message: errorMessage(error) },
      400,
    );
  }
});

app.post("/projects/:id/clips/regenerate", async (c) => {
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

  const idempotencyKey = c.req.header("idempotency-key") ?? "";

  if (!idempotencyKey) {
    return c.json({ error: "Missing idempotency-key header" }, 400);
  }

  try {
    const result = await clipService.regenerateClips(
      appUser.id,
      projectId,
      idempotencyKey,
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

const honoHandler = handle(app);

export const GET = honoHandler;
export const POST = honoHandler;
export const PUT = honoHandler;
export const PATCH = honoHandler;
export const DELETE = honoHandler;
export const OPTIONS = honoHandler;
