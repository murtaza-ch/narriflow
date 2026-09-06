import { Hono } from "hono";
import { handle } from "hono/vercel";
import {
  authenticatedHonoActor,
  authenticatedHonoInput,
  authenticatedRequestHonoErrorHandler,
  authenticatedRequestHonoMiddleware,
} from "@/lib/authenticated-request-hono";
import {
  applyCaptionPresetToAllSchema,
  type BulkSocialScheduleRequest,
  type ConfirmAssistedCopyRequest,
  type GenerateAssistedCopyRequest,
  type RequestThumbnailFrameInput,
  applyStudioEditsToAllSchema,
  audioAssetIdParamSchema,
  brandTemplateInputSchema,
  brandTemplateUpdateSchema,
  createClipExportSchema,
  createClipShareLinkSchema,
  clipDownloadQuerySchema,
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
  recheckSocialPublicationSchema,
  confirmSocialPublicationSchema,
  republishSocialPublicationSchema,
  socialPlatformSchema,
  socialPostMetricsSchema,
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
  resolvePricingTier,
  isCensorSegmentStale,
  workspaceAllowsCapability,
  type CreateExportBundleInput,
  type CreateReviewRoundInput,
  type InviteReviewersInput,
  type InternalReviewCommentInput,
  type RetryReviewNotificationInput,
  type ApplySceneTemplateInput,
  type ApplyMotionSelectedInput,
  type ApplyProjectBrandProfileSelectedInput,
  type ApplyStyleSelectedInput,
  type PreviewCampaignEditorActionInput,
  type EditorDocument,
  type SceneBlock,
  type CensorSegment,
} from "@narriflow/validators";
import {
  audioAssetService,
  assistedSocialCopyService,
  billingService,
  analyticsService,
  autopilotService,
  searchBrollVideos,
  isPexelsConfigured,
  brandTemplateService,
  clipService,
  ClipActionError,
  clipEditorDocumentPersistence,
  clipExportService,
  ClipExportError,
  contentSuiteService,
  dubbingService,
  projectService,
  socialOAuthService,
  SocialOAuthError,
  socialService,
  acceptTikTokPublicationWebhook,
  TikTokPublicationWebhookError,
  uploadSessionService,
  workspaceLibraryService,
  workspaceService,
  type ProjectListSort,
  type ProjectListSourceFilter,
  type ProjectListStatusFilter,
  campaignOperationService,
  bulkSocialSchedulingService,
  reviewService,
  reviewNotificationService,
  visualAssetService,
  brandFontService,
  hasFeature,
  isProgramWriteEnabled,
  ProgramWriteDisabledError,
  type ProgramReleaseGroup,
  autoCensorService,
  thumbnailFramePreparationService,
} from "@narriflow/services";
import {
  resolveCanonicalAppOrigin,
  safeSocialRedirectPath,
} from "@/lib/safe-redirect";
import { censorDocumentMutationError } from "@/lib/censor-document-mutation";
import {
  motionDocumentExportError,
  motionDocumentMutationError,
} from "@/lib/motion-document-mutation";
import { createUploadSessionHttpRoutes } from "./upload-session-http";
import { createStripeWebhookHttpRoutes } from "./stripe-webhook-http";
import { createWorkspaceBillingHttpRoutes } from "./workspace-billing-routes";
import { createBrandProfileRoutes } from "./brand-profile-routes";

export const runtime = "nodejs";
// Content-suite generation makes a synchronous LLM call that can take ~30s.
export const maxDuration = 60;

const app = new Hono().basePath("/api");
app.onError(authenticatedRequestHonoErrorHandler);

function sceneDocumentMutationError(pricingTier: string, current: EditorDocument, next: EditorDocument) {
  const currentById = new Map(current.sceneBlocks.map((scene) => [scene.id, scene]));
  const nextById = new Map(next.sceneBlocks.map((scene) => [scene.id, scene]));
  const changed = new Set([...currentById.keys(), ...nextById.keys()].filter((id) =>
    JSON.stringify(currentById.get(id)) !== JSON.stringify(nextById.get(id)),
  ));
  if (changed.size === 0) return null;
  if (!hasFeature(pricingTier, "brand.scenes")) {
    return new ClipActionError(
      "scene_feature_unavailable",
    );
  }
  const disabledGroup = [...changed]
    .flatMap((id) => [currentById.get(id), nextById.get(id)])
    .filter((scene): scene is SceneBlock => Boolean(scene))
    .map(sceneProgramReleaseGroup)
    .find((group) => group && !isProgramWriteEnabled(group));
  return disabledGroup ? new ProgramWriteDisabledError(disabledGroup) : null;
}

function sceneProgramReleaseGroup(
  scene: SceneBlock,
): ProgramReleaseGroup | null {
  if (scene.templateSnapshot) return "scene_templates";
  if (scene.content.kind === "text" || scene.content.kind === "color") {
    return "scene_cards";
  }
  if (scene.content.kind === "image") return "scene_images";
  if (scene.content.kind === "video") return "scene_videos";
  return null;
}

function changedSceneBlocks(current: EditorDocument, next: EditorDocument): SceneBlock[] {
  const currentById = new Map(current.sceneBlocks.map((scene) => [scene.id, scene]));
  return next.sceneBlocks.filter((scene) =>
    JSON.stringify(currentById.get(scene.id)) !== JSON.stringify(scene),
  );
}

function introducedSceneReferences(current: EditorDocument, next: EditorDocument): SceneBlock[] {
  const currentById = new Map(current.sceneBlocks.map((scene) => [scene.id, scene]));
  return next.sceneBlocks.filter((scene) => {
    const previous = currentById.get(scene.id);
    if (!previous || previous.content.kind !== scene.content.kind) return true;
    const previousAsset = previous.content.kind === "image" || previous.content.kind === "video"
      ? previous.content.asset
      : previous.content.kind === "text"
        ? previous.content.fontAsset
        : null;
    const nextAsset = scene.content.kind === "image" || scene.content.kind === "video"
      ? scene.content.asset
      : scene.content.kind === "text"
        ? scene.content.fontAsset
        : null;
    return JSON.stringify(previousAsset) !== JSON.stringify(nextAsset);
  });
}

function introducedVisualAssetIds(current: EditorDocument, next: EditorDocument): string[] {
  const ids = (document: EditorDocument) => [
    ...document.sceneBlocks.flatMap((scene) =>
      scene.content.kind === "image" || scene.content.kind === "video"
        ? [scene.content.asset.id]
        : [],
    ),
    ...document.studioEdits.visualBroll.map((placement) => placement.asset.id),
  ];
  const currentIds = new Set(ids(current));
  return [...new Set(ids(next).filter((id) => !currentIds.has(id)))];
}
app.use("*", authenticatedRequestHonoMiddleware);
billingService.validateConfiguration({ surface: "web" });

app.route(
  "/",
  createStripeWebhookHttpRoutes({
    acceptDelivery: (rawBody, signature) =>
      billingService.handleWebhook(rawBody, signature),
  }),
);

app.post("/webhooks/tiktok/publication", async (c) => {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) {
    return c.json({ error: "tiktok_webhook_not_configured" }, 503);
  }
  const rawBody = await c.req.text();
  try {
    const result = await acceptTikTokPublicationWebhook({
      rawBody,
      signature: c.req.header("TikTok-Signature") ?? null,
      clientKey,
      clientSecret,
    });
    console.warn(JSON.stringify({
      level: "info",
      message: "social_publication_tiktok_webhook_accepted",
      outcome: result.kind,
    }),
    );
    return c.json(result, 200);
  } catch (error) {
    if (error instanceof TikTokPublicationWebhookError) {
      const status = error.code === "tiktok_webhook_payload_invalid" ? 400 : 401;
      return c.json({ error: error.code }, status);
    }
    console.warn(JSON.stringify({
      level: "error",
      message: "social_publication_tiktok_webhook_failed",
      errorCode: "tiktok_webhook_persistence_failed",
    }),
    );
    return c.json({ error: "tiktok_webhook_persistence_failed" }, 500);
  }
});

app.route(
  "/billing",
  createWorkspaceBillingHttpRoutes({
    getActor: async (c) => authenticatedHonoActor(c),
    resolveAppOrigin: getOAuthOrigin,
    startCheckout: (input) => billingService.startCheckout(input),
    observeCheckoutReturn: (input) => billingService.observeCheckoutReturn(input),
    openPortal: (input) => billingService.openPortal(input),
    readBillingState: (workspaceId) => billingService.readBillingState(workspaceId),
    reconcileCurrentState: (workspaceId) =>
      billingService.reconcileCurrentState(workspaceId),
  }),
);

app.route(
  "/",
  createBrandProfileRoutes({
    getActor: (context) => authenticatedHonoActor(context),
  }),
);

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
  const appUser = authenticatedHonoActor(c);

  const rules = await autopilotService.listRules(appUser.workspaceOwnerUserId, appUser.workspaceId);
  return c.json({ rules }, 200);
});

app.post("/autopilot/rules", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const payload = await c.req.json().catch(() => ({}));
  const parsed = autopilotRuleInputSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_input", issues: parsed.error.issues },
      400);
  }

  const rule = await autopilotService.createRule(appUser.workspaceOwnerUserId, parsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  return c.json(rule, 201);
});

app.patch("/autopilot/rules/:ruleId", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const payload = await c.req.json().catch(() => ({}));
  const parsed = autopilotRuleUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json(
      { error: "invalid_input", issues: parsed.error.issues },
      400);
  }

  const rule = await autopilotService.updateRule(
      appUser.workspaceOwnerUserId,
      c.req.param("ruleId"),
      parsed.data,
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
  );
  return c.json(rule, 200);
});

app.delete("/autopilot/rules/:ruleId", async (c) => {
  const appUser = authenticatedHonoActor(c);

  await autopilotService.deleteRule(appUser.workspaceOwnerUserId, c.req.param("ruleId"), { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  return c.json({ ok: true }, 200);
});

app.post("/autopilot/rules/:ruleId/run-now", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const rule = await autopilotService.triggerRuleNow(
      appUser.workspaceOwnerUserId,
      c.req.param("ruleId"),
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
  );
  return c.json(rule, 200);
});

app.get("/projects", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const cursor = c.req.query("cursor") ?? null;
  const folderId = c.req.query("folder") || undefined;
  const query = c.req.query("q") ?? "";
  const statusRaw = c.req.query("status");
  const sourceRaw = c.req.query("source");
  const sortRaw = c.req.query("sort");
  const status = ["all", "ready", "processing", "queued", "failed"].includes(
    statusRaw ?? "all",
  )
    ? (statusRaw as ProjectListStatusFilter | undefined)
    : undefined;
  const source = ["all", "youtube", "link", "upload", "rss"].includes(
    sourceRaw ?? "all",
  )
    ? (sourceRaw as ProjectListSourceFilter | undefined)
    : undefined;
  const sort = ["newest", "oldest", "title", "clips"].includes(sortRaw ?? "newest",
  )
    ? (sortRaw as ProjectListSort | undefined)
    : undefined;

  const page = await projectService.listProjectsWithStatsPage(appUser.actorUserId, {
      limit,
      cursor,
      workspaceId: appUser.workspaceId,
      folderId,
      query,
      status,
      source,
      sort,
    },
  );
  return c.json(page, 200);
});

app.get("/workspace/search", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const results = await workspaceLibraryService.search(
      appUser.actorUserId,
      appUser.workspaceId,
      c.req.query("q") ?? "",
  );
  return c.json({ results }, 200);
});

app.get("/workspace/exports/:exportId/download", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const exported = await clipExportService.getWorkspaceOwned(
    appUser.workspaceId,
    c.req.param("exportId"),
  );
  if (!exported) return c.json({ error: "export_not_found" }, 404);
  const requestedVariantId = c.req.query("variant");
  const variant = requestedVariantId
    ? exported.variants.find(
        (candidate) =>
          candidate.id === requestedVariantId && candidate.downloadUrl,
      )
    : exported.variants.find((candidate) => candidate.downloadUrl);
  if (!variant?.downloadUrl) {
    return c.json({ error: "export_file_not_ready", message: "Export file is not ready" }, 409);
  }
  return c.redirect(variant.downloadUrl, 302);
});

app.post("/workspace/avatar/presign", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const payload = await c.req.json().catch(() => ({}));
  const result = await workspaceService.presignAvatarUpload(
      appUser.actorUserId,
      appUser.workspaceId,
      {
        contentType: String(payload.contentType ?? ""),
        sizeBytes: Number(payload.sizeBytes),
      },
  );
  return c.json(result, 200);
});

app.patch("/workspace/avatar", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const payload = await c.req.json().catch(() => ({}));
  const storageKey = payload.storageKey === null ? null : String(payload.storageKey ?? "");
  await workspaceService.setAvatar(
      appUser.actorUserId,
      appUser.workspaceId,
      storageKey || null,
  );
  return c.json({ ok: true }, 200);
});

app.post("/projects/:id/generate", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");

  const idempotencyKey = c.req.header("idempotency-key") ?? "";

  if (!idempotencyKey) {
    return c.json({ error: "invalid_input", message: "Missing idempotency-key header" }, 400);
  }

  const payload = await c.req.json().catch(() => null);
  const parsed = generateProjectRequestSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "invalid_input", issues: parsed.error.issues },
      400);
  }

  const result = await projectService.triggerGeneration(
      appUser.workspaceOwnerUserId,
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
});

app.get("/projects/:id", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");
  const snapshot = await projectService.getProjectSnapshot(
    appUser.workspaceOwnerUserId,
    projectId,
  );

  if (!snapshot.project) {
    return c.json({ error: "project_not_found" }, 404);
  }

  return c.json(snapshot, 200);
});

app.get("/projects/:id/runs/:workflowRunId", async (c) => {
  const projectId = c.req.param("id");

  const workflowRunId = c.req.param("workflowRunId");
  const snapshot = await projectService.getWorkflowRun(
    projectId,
    workflowRunId,
  );

  if (!snapshot.run) {
    return c.json({ error: "workflow_run_not_found", message: "Workflow run not found" }, 404);
  }

  return c.json(snapshot, 200);
});

app.get("/projects/:id/transcript", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");
  const transcript = await projectService.getTranscriptSnapshot(
    appUser.workspaceOwnerUserId,
    projectId,
  );

  if (!transcript) {
    return c.json({ error: "transcript_not_found", message: "Transcript not found" }, 404);
  }

  return c.json(transcript, 200);
});

// Lean word-level transcript for the Trim/Extend editor: raw utterances
// only, no snapshot re-validation (see getTranscriptUtterancesRaw). Browser-
// cacheable briefly — the client also keeps a session-level parsed cache.
app.get("/projects/:id/transcript/utterances", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");
  const utterances = await projectService.getTranscriptUtterancesRaw(
    appUser.workspaceOwnerUserId,
    projectId,
  );

  if (utterances === null) {
    return c.json({ error: "transcript_not_found", message: "Transcript not found" }, 404);
  }

  c.header("Cache-Control", "private, max-age=120");
  return c.json({ utterances }, 200);
});

app.get("/projects/:id/transcript/export", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");

  const format = transcriptExportFormatSchema.safeParse(
    c.req.query("format") ?? "txt",
  );

  if (!format.success) {
    return c.json({ error: "invalid_transcript_export_format", message: "Invalid transcript export format" }, 400);
  }

  const exported = await projectService.getTranscriptExport(
      appUser.workspaceOwnerUserId,
      projectId,
      format.data,
  );
  c.header("Content-Type", exported.contentType);
  c.header(
      "Content-Disposition",
      `attachment; filename="${exported.fileName}"`,
  );
  return c.body(exported.body, 200);
});

app.route(
  "/",
  createUploadSessionHttpRoutes({
    getActor: async (c) => authenticatedHonoActor(c),
    service: uploadSessionService,
  }),
);

app.post("/ingest/link", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const payload = await c.req.json().catch(() => null);
  const parsed = linkIngestSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "invalid_input", issues: parsed.error.issues },
      400);
  }

  const response = await projectService.queueLinkIngest(
      appUser.actorUserId,
      parsed.data,
      appUser.workspaceId,
  );
  return c.json(response, 202);
});

app.post("/ingest/rss/preview", async (c) => {
  const payload = await c.req.json().catch(() => null);
  const parsed = rssPreviewSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "invalid_input", issues: parsed.error.issues },
      400);
  }

  const response = await projectService.previewRssFeed(parsed.data.rssUrl);
  return c.json(response, 200);
});

app.post("/ingest/rss/import", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const payload = await c.req.json().catch(() => null);
  const parsed = rssImportSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "invalid_input", issues: parsed.error.issues },
      400);
  }

  const response = await projectService.importFromRss(
      appUser.actorUserId,
      parsed.data,
      appUser.workspaceId,
  );
  return c.json(response, 202);
});

app.get("/ingest/:projectId", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("projectId");
  const snapshot = await projectService.getIngestSnapshot(
    appUser.workspaceOwnerUserId,
    projectId,
  );

  if (!snapshot) {
    return c.json({ error: "project_not_found" }, 404);
  }

  return c.json(snapshot, 200);
});

// --- Clips routes ---

app.get("/projects/:id/clips", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");
  const clips = await clipService.listClips(appUser.workspaceOwnerUserId, projectId,
  );
  return c.json({ clips }, 200);
});

/** Small same-origin bridge for private-R2 waveform metadata. Video elements
 * can play presigned media without CORS, but browser `fetch()` of JSON cannot;
 * proxying only this bounded, validated artifact avoids a bucket-wide CORS
 * dependency without putting video bytes through the web service. */
app.get("/projects/:id/clips/:clipId/preview-peaks", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const peaks = await clipService.getClipPreviewPeaks(
    appUser.workspaceOwnerUserId,
    c.req.param("id"),
    c.req.param("clipId"),
  );
  if (!peaks) return c.body(null, 204);
  c.header("Cache-Control", "private, max-age=3600, immutable");
  return c.json(peaks, 200);
});

app.patch("/projects/:id/clips/:clipId", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");

  const clipId = c.req.param("clipId");
  const payload = await c.req.json().catch(() => null);

  if (!payload || typeof payload !== "object") {
    return c.json({ error: "invalid_input" }, 400);
  }

  const titleParsed = updateClipTitleSchema.safeParse(payload);
    if (titleParsed.success) {
      const clip = await clipService.updateClipTitle(
        appUser.workspaceOwnerUserId,
        projectId,
        clipId,
        titleParsed.data.title,
      );
      return c.json(clip, 200);
    }

    const boundariesParsed = updateClipBoundariesSchema.safeParse(payload);
    if (boundariesParsed.success) {
      await clipEditorDocumentPersistence.mutateDocument({
        actorUserId: appUser.actorUserId,
        workspaceId: appUser.workspaceId,
        workspaceOwnerUserId: appUser.workspaceOwnerUserId,
        projectId,
        clipId,
        intent: { kind: "set_boundaries", ...boundariesParsed.data },
      });
      const clip = await clipService.getClipSnapshot(appUser.workspaceOwnerUserId, projectId, clipId,
      );
      return c.json(clip, 200);
    }

    const captionPresetParsed = updateClipCaptionPresetSchema.safeParse(payload);
    if (captionPresetParsed.success) {
      await clipEditorDocumentPersistence.mutateDocument({
        actorUserId: appUser.actorUserId,
        workspaceId: appUser.workspaceId,
        workspaceOwnerUserId: appUser.workspaceOwnerUserId,
        projectId,
        clipId,
        intent: {
          kind: "set_caption_preset",
          captionPreset: captionPresetParsed.data.captionPreset,
        },
      });
      const clip = await clipService.getClipSnapshot(appUser.workspaceOwnerUserId, projectId, clipId,
      );
      return c.json(clip, 200);
    }

    const transcriptParsed = updateClipTranscriptSliceSchema.safeParse(payload);
    if (transcriptParsed.success) {
      await clipEditorDocumentPersistence.mutateDocument({
        actorUserId: appUser.actorUserId,
        workspaceId: appUser.workspaceId,
        workspaceOwnerUserId: appUser.workspaceOwnerUserId,
        projectId,
        clipId,
        intent: {
          kind: "set_transcript",
          transcriptSlice: transcriptParsed.data.transcriptSlice,
        },
      });
      const clip = await clipService.getClipSnapshot(appUser.workspaceOwnerUserId, projectId, clipId,
      );
      return c.json(clip, 200);
    }

    const brollParsed = updateClipBrollSchema.safeParse(payload);
    if (brollParsed.success) {
      await clipEditorDocumentPersistence.mutateDocument({
        actorUserId: appUser.actorUserId,
        workspaceId: appUser.workspaceId,
        workspaceOwnerUserId: appUser.workspaceOwnerUserId,
        projectId,
        clipId,
        intent: { kind: "set_broll_url", brollUrl: brollParsed.data.brollUrl },
      });
      const clip = await clipService.getClipSnapshot(appUser.workspaceOwnerUserId, projectId, clipId,
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
      await clipEditorDocumentPersistence.mutateDocument({
        actorUserId: appUser.actorUserId,
        workspaceId: appUser.workspaceId,
        workspaceOwnerUserId: appUser.workspaceOwnerUserId,
        projectId,
        clipId,
        intent: {
          kind: "set_studio_edits",
          studioEdits: studioEditsParsed.data.studioEdits,
        },
      });
      const clip = await clipService.getClipSnapshot(appUser.workspaceOwnerUserId, projectId, clipId,
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
});

/**
 * Alternative AI-written titles for one clip. Read-only — the caller picks one
 * and PATCHes it back as an ordinary `{ title }` rename, so nothing is
 * overwritten without an explicit choice.
 *
 * Rate limited per user because each call is a real LLM completion and the
 * trigger is a single menu click that's cheap to hammer.
 */
app.post("/projects/:id/clips/:clipId/title-suggestions", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");

  const titles = await clipService.suggestClipTitles(
      appUser.workspaceOwnerUserId,
      projectId,
      c.req.param("clipId"),
  );
  return c.json({ titles }, 200);
});

/**
 * Duplicates a clip, copying its finished renders and preview proxy inside R2
 * so the copy is immediately playable without a re-render. Returns the new
 * clip's snapshot.
 */
app.post("/projects/:id/clips/:clipId/duplicate", async (c) => {
  const appUser = authenticatedHonoActor(c);

  // Each duplicate copies real objects in R2; a rate limit keeps a stuck click
  // from fanning out into dozens of copies.
  const projectId = c.req.param("id");

  const clip = await clipService.duplicateClip(
      appUser.workspaceOwnerUserId,
      projectId,
      c.req.param("clipId"),
  );
  return c.json(clip, 201);
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
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");

  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "invalid_input" }, 400);
  }

  const parsed = createClipFromSelectionSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid_input" }, 400);
  }

  const clip = await clipService.createClipFromSelection(
      appUser.workspaceOwnerUserId,
      projectId,
      c.req.param("clipId"),
      parsed.data,
  );
  return c.json(clip, 201);
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
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");

  const result = await clipService.getClipEditorDocument(
      appUser,
      projectId,
      c.req.param("clipId"),
  );
  return c.json(result, 200);
});

app.put("/projects/:id/clips/:clipId/editor", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");

  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "invalid_input" }, 400);
  }

  const parsed = saveEditorDocumentSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid_input" }, 400);
  }
    const current = await clipService.getClipEditorDocument(
      appUser,
      projectId,
      c.req.param("clipId"),
    );
    const sceneError = sceneDocumentMutationError(appUser.pricingTier, current.document, parsed.data.document);
    if (sceneError) throw sceneError;
    const motionError = motionDocumentMutationError(appUser.pricingTier, current.document, parsed.data.document);
    if (motionError) throw motionError;
    const censorError = censorDocumentMutationError(appUser.pricingTier, current.document, parsed.data.document);
    if (censorError) throw censorError;
    const changedScenes = changedSceneBlocks(current.document, parsed.data.document);
    const introducedScenes = introducedSceneReferences(current.document, parsed.data.document);
    const introducedAssetIds = introducedVisualAssetIds(current.document, parsed.data.document);
    await Promise.all([
      visualAssetService.assertSceneReferencesWithPolicy(appUser, changedScenes, true),
      visualAssetService.assertSceneReferences(appUser, introducedScenes),
      visualAssetService.assertVisualBrollReferences(appUser, parsed.data.document.studioEdits.visualBroll),
      brandFontService.assertSceneReferences(appUser, projectId, changedScenes, { allowDeleted: true, requireActiveProfile: false }),
      brandFontService.assertSceneReferences(appUser, projectId, introducedScenes, { allowDeleted: false, requireActiveProfile: true }),
    ]);
    const mutation = await clipEditorDocumentPersistence.mutateDocument({
      actorUserId: appUser.actorUserId,
      workspaceId: appUser.workspaceId,
      workspaceOwnerUserId: appUser.workspaceOwnerUserId,
      projectId,
      clipId: c.req.param("clipId"),
      intent: {
        kind: "replace",
        baseRevision: parsed.data.baseRevision,
        document: parsed.data.document,
      },
    });
    await visualAssetService.recordGeneratedInsertionsBestEffort(
      appUser,
      projectId,
      introducedAssetIds,
    );
    const clip = await clipService.getClipSnapshot(
      appUser.workspaceOwnerUserId,
      projectId,
      c.req.param("clipId"),
    );
    return c.json(
      { revision: mutation.revision, document: mutation.document, clip },
      200,
    );
});

/**
 * Reset-to-original (docs/plans/vizard-parity.md Phase A step 4): restores
 * the editor document — including clip boundaries — from the immutable
 * revision-zero snapshot. Same revision-guard/error mapping as the PUT above.
 */
app.post("/projects/:id/clips/:clipId/editor/reset", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");

  const payload = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "invalid_input" }, 400);
  }

  const parsed = resetEditorDocumentSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid_input" }, 400);
  }

  const current = await clipService.getClipEditorDocument(appUser, projectId, c.req.param("clipId"));
    const sceneError = sceneDocumentMutationError(appUser.pricingTier, current.document, current.original);
    if (sceneError) throw sceneError;
    const mutation = await clipEditorDocumentPersistence.mutateDocument({
      actorUserId: appUser.actorUserId,
      workspaceId: appUser.workspaceId,
      workspaceOwnerUserId: appUser.workspaceOwnerUserId,
      projectId,
      clipId: c.req.param("clipId"),
      intent: { kind: "reset", baseRevision: parsed.data.baseRevision },
    });
    const clip = await clipService.getClipSnapshot(
      appUser.workspaceOwnerUserId,
      projectId,
      c.req.param("clipId"),
    );
  return c.json(
      { revision: mutation.revision, document: mutation.document, clip },
      200,
  );
});

/**
 * Permanently deletes one clip and its stored assets. Refused with
 * `clip_has_scheduled_posts` while the clip has scheduled or publishing social
 * posts — see ClipService.deleteClip for why cancelling those first is the only
 * safe order.
 */
app.delete("/projects/:id/clips/:clipId", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");

  await clipService.deleteClip(
      appUser.workspaceOwnerUserId,
      projectId,
      c.req.param("clipId"),
  );
  return c.json({ ok: true }, 200);
});

app.post("/projects/:id/clips/regenerate", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");

  const idempotencyKey = c.req.header("idempotency-key") ?? "";

  if (!idempotencyKey) {
    return c.json({ error: "invalid_input", message: "Missing idempotency-key header" }, 400);
  }

  const payload = await c.req.json().catch(() => ({}));
    const contentPackParsed = contentPackSchema.safeParse(
      payload?.contentPack);
    const contentPack = contentPackParsed.success
      ? contentPackParsed.data
      : undefined;
    const result = await clipService.regenerateClips(
      projectId,
      idempotencyKey,
      contentPack,
      {
        workspaceId: appUser.workspaceId,
        actorUserId: appUser.actorUserId,
      },
    );
  return c.json(result, 202);
});

// --- Clip rendering routes ---

app.post("/projects/:id/clips/render", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");

  const idempotencyKey = c.req.header("idempotency-key") ?? "";

  if (!idempotencyKey) {
    return c.json({ error: "invalid_input", message: "Missing idempotency-key header" }, 400);
  }

  const payload = await c.req.json().catch(() => ({}));
  const parsed = triggerClipRenderSchema.safeParse(payload);

  if (!parsed.success) {
    return c.json(
      { error: "invalid_input", issues: parsed.error.issues },
      400);
  }

  const execute = (clipIds?: string[]) => clipService.triggerClipRendering(
      projectId, idempotencyKey,
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
      clipIds, parsed.data.aspectRatios, parsed.data.resolution,
    );
    const result = parsed.data.clipIds
      ? await campaignOperationService.renderSelected({
          actorUserId: appUser.actorUserId,
          workspaceId: appUser.workspaceId,
          projectId,
          pricingTier: resolvePricingTier(appUser.pricingTier),
          idempotencyKey,
          clipIds: parsed.data.clipIds,
          aspectRatios: parsed.data.aspectRatios,
          resolution: parsed.data.resolution,
          execute,
        })
      : await execute();
  return c.json(result, 202);
});

app.post("/projects/:id/export-bundles", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id, body, idempotencyKey } = authenticatedHonoInput<{
    id: string;
    body: CreateExportBundleInput;
    idempotencyKey: string;
  }>(c);
  return c.json(await campaignOperationService.createExportBundle({ actorUserId: appUser.actorUserId, workspaceId: appUser.workspaceId, projectId: id, pricingTier: resolvePricingTier(appUser.pricingTier), role: appUser.role, status: appUser.status, idempotencyKey }, body), 202);
});

app.post("/projects/:id/export-bundles/preview", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id, body } = authenticatedHonoInput<{
    id: string;
    body: CreateExportBundleInput;
  }>(c);
  return c.json(await campaignOperationService.previewExportBundle({
    workspaceId: appUser.workspaceId,
    projectId: id,
    pricingTier: resolvePricingTier(appUser.pricingTier),
    role: appUser.role,
    status: appUser.status,
  }, body), 200);
});

app.get("/projects/:id/export-bundles", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const projectId = c.req.param("id");
  return c.json({ bundles: await campaignOperationService.listExportBundles({ workspaceId: appUser.workspaceId, projectId }) }, 200);
});

app.get("/projects/:id/campaign-operations", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const projectId = c.req.param("id");
  return c.json({ operations: await campaignOperationService.listOperations({ workspaceId: appUser.workspaceId, projectId }) }, 200);
});

app.post("/projects/:id/assisted-copy/generations", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, body } = authenticatedHonoInput<{
    id: string;
    body: GenerateAssistedCopyRequest;
  }>(c);
  return c.json(await assistedSocialCopyService.generate({
    actorUserId: appUser.actorUserId,
    workspaceId: appUser.workspaceId,
    projectId,
    ...body,
  }), 201);
});

app.post("/projects/:id/assisted-copy/variants/:variantId/confirm", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, variantId, body } = authenticatedHonoInput<{
    id: string;
    variantId: string;
    body: ConfirmAssistedCopyRequest;
  }>(c);
  return c.json(await assistedSocialCopyService.confirm({
    actorUserId: appUser.actorUserId,
    workspaceId: appUser.workspaceId,
    projectId,
    variantId,
    ...body,
  }), 200);
});

app.post("/projects/:id/thumbnail-frames", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, body } = authenticatedHonoInput<{
    id: string;
    body: RequestThumbnailFrameInput;
  }>(c);
  return c.json(await thumbnailFramePreparationService.request({
    actorUserId: appUser.actorUserId,
    workspaceId: appUser.workspaceId,
    projectId,
    ...body,
  }), 202);
});

app.get("/projects/:id/thumbnail-frames/:operationId", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, operationId } = authenticatedHonoInput<{
    id: string;
    operationId: string;
  }>(c);
  return c.json(await thumbnailFramePreparationService.get(
    appUser.workspaceId,
    projectId,
    operationId,
  ), 200);
});

app.post("/projects/:id/thumbnail-frames/:operationId/retry", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, operationId } = authenticatedHonoInput<{
    id: string;
    operationId: string;
  }>(c);
  return c.json(await thumbnailFramePreparationService.retry(
    appUser.workspaceId,
    projectId,
    operationId,
  ), 202);
});

app.post("/projects/:id/campaign-operations/schedule", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, body } = authenticatedHonoInput<{
    id: string;
    body: BulkSocialScheduleRequest;
  }>(c);
  return c.json(await bulkSocialSchedulingService.schedule({
    actorUserId: appUser.actorUserId,
    workspaceId: appUser.workspaceId,
    projectId,
    value: body,
  }), 201);
});

app.get("/projects/:id/campaign-operations/editor-action-catalog", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const projectId = c.req.param("id");
  return c.json(
      await campaignOperationService.getEditorActionCatalog({
        actorUserId: appUser.actorUserId,
        workspaceId: appUser.workspaceId,
        workspaceOwnerUserId: appUser.workspaceOwnerUserId,
        role: appUser.role,
        status: appUser.status,
        pricingTier: appUser.pricingTier,
        isPersonalWorkspace: appUser.isPersonalWorkspace,
        projectId,
      }),
    200,
  );
});

app.post("/projects/:id/campaign-operations/preview-editor-action", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, body } = authenticatedHonoInput<{
    id: string;
    body: PreviewCampaignEditorActionInput;
  }>(c);
  return c.json(
    await campaignOperationService.previewEditorAction(
      {
        actorUserId: appUser.actorUserId,
        workspaceId: appUser.workspaceId,
        workspaceOwnerUserId: appUser.workspaceOwnerUserId,
        role: appUser.role,
        status: appUser.status,
        pricingTier: appUser.pricingTier,
        isPersonalWorkspace: appUser.isPersonalWorkspace,
        projectId,
      },
      body,
    ),
    200,
  );
});

app.post("/projects/:id/campaign-operations/apply-brand-profile", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, body, idempotencyKey, retryOfId } = authenticatedHonoInput<{
    id: string;
    body: ApplyProjectBrandProfileSelectedInput;
    idempotencyKey: string;
    retryOfId?: string;
  }>(c);
  return c.json(
    await campaignOperationService.applyProjectBrandProfileSelected(
        {
          actorUserId: appUser.actorUserId,
          workspaceId: appUser.workspaceId,
          workspaceOwnerUserId: appUser.workspaceOwnerUserId,
          role: appUser.role,
          status: appUser.status,
          pricingTier: appUser.pricingTier,
          isPersonalWorkspace: appUser.isPersonalWorkspace,
          projectId,
          idempotencyKey,
          retryOfId,
        },
        body,
      ),
    200,
  );
});

app.post("/projects/:id/campaign-operations/apply-style", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, body, idempotencyKey, retryOfId } = authenticatedHonoInput<{
    id: string;
    body: ApplyStyleSelectedInput;
    idempotencyKey: string;
    retryOfId?: string;
  }>(c);
  return c.json(
    await campaignOperationService.applyStyleSelected(
        {
          actorUserId: appUser.actorUserId,
          workspaceId: appUser.workspaceId,
          workspaceOwnerUserId: appUser.workspaceOwnerUserId,
          role: appUser.role,
          status: appUser.status,
          pricingTier: appUser.pricingTier,
          isPersonalWorkspace: appUser.isPersonalWorkspace,
          projectId,
          idempotencyKey,
          retryOfId,
        },
        body,
      ),
    200,
  );
});

app.post("/projects/:id/campaign-operations/apply-motion", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, body, idempotencyKey, retryOfId } = authenticatedHonoInput<{
    id: string;
    body: ApplyMotionSelectedInput;
    idempotencyKey: string;
    retryOfId?: string;
  }>(c);
  return c.json(
    await campaignOperationService.applyMotionSelected(
        {
          actorUserId: appUser.actorUserId,
          workspaceId: appUser.workspaceId,
          workspaceOwnerUserId: appUser.workspaceOwnerUserId,
          projectId,
          pricingTier: resolvePricingTier(appUser.pricingTier),
          role: appUser.role,
          status: appUser.status,
          idempotencyKey,
          retryOfId,
        },
        body,
      ),
    200,
  );
});

app.get("/projects/:id/export-bundles/:bundleId", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, bundleId } = authenticatedHonoInput<{ id: string; bundleId: string }>(c);
  return c.json(await campaignOperationService.getExportBundle({ workspaceId: appUser.workspaceId, projectId }, bundleId), 200);
});

app.post("/projects/:id/export-bundles/:bundleId/retry", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, bundleId, idempotencyKey } = authenticatedHonoInput<{ id: string; bundleId: string; idempotencyKey: string }>(c);
  return c.json(await campaignOperationService.retryExportBundle({ actorUserId: appUser.actorUserId, workspaceId: appUser.workspaceId, projectId, pricingTier: resolvePricingTier(appUser.pricingTier), role: appUser.role, status: appUser.status, idempotencyKey }, bundleId), 202);
});

app.post("/projects/:id/campaign-operations/:operationId/retry-export-bundle", async (c) => {
	const appUser = authenticatedHonoActor(c);
	const { id: projectId, operationId, idempotencyKey } = authenticatedHonoInput<{ id: string; operationId: string; idempotencyKey: string }>(c);
	return c.json(await campaignOperationService.retryExportBundleOperation({ actorUserId: appUser.actorUserId, workspaceId: appUser.workspaceId, projectId, pricingTier: resolvePricingTier(appUser.pricingTier), role: appUser.role, status: appUser.status, idempotencyKey }, operationId), 202);
});

app.get("/projects/:id/export-bundles/:bundleId/download", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id: projectId, bundleId } = authenticatedHonoInput<{ id: string; bundleId: string }>(c);
  const url = await campaignOperationService.getExportBundleDownload({ workspaceId: appUser.workspaceId, projectId, role: appUser.role, status: appUser.status }, bundleId);
  return c.redirect(url, 307);
});

app.post("/projects/:id/brand-profiles/:profileId/scene-templates/:templateId/apply", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id, profileId, templateId, body, idempotencyKey, retryOfId } = authenticatedHonoInput<{
    id: string;
    profileId: string;
    templateId: string;
    body: ApplySceneTemplateInput;
    idempotencyKey: string;
    retryOfId?: string;
  }>(c);
  const result = await campaignOperationService.applySceneTemplate({
      actorUserId: appUser.actorUserId,
      workspaceId: appUser.workspaceId,
      workspaceOwnerUserId: appUser.workspaceOwnerUserId,
      role: appUser.role,
      status: appUser.status,
      pricingTier: appUser.pricingTier,
      isPersonalWorkspace: appUser.isPersonalWorkspace,
      projectId: id,
      idempotencyKey,
      retryOfId,
    }, profileId, templateId, body);
  return c.json(result, 200);
});

app.post("/projects/:id/review-rounds", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id, body } = authenticatedHonoInput<{ id: string; body: CreateReviewRoundInput }>(c);
  return c.json(await reviewService.createRound({ actorUserId: appUser.actorUserId, workspaceId: appUser.workspaceId, projectId: id, pricingTier: resolvePricingTier(appUser.pricingTier) }, body), 201);
});

app.get("/projects/:id/review-rounds", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id } = authenticatedHonoInput<{ id: string }>(c);
  const access = workspaceAllowsCapability(
    { role: appUser.role, status: appUser.status },
    "review.manage",
  ) ? "manage" : "view";
  return c.json(await reviewService.internalRoom(appUser.workspaceId, id, access), 200);
});

app.post("/projects/:id/review-rounds/:roundId/invite", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id, roundId, body } = authenticatedHonoInput<{
    id: string;
    roundId: string;
    body: InviteReviewersInput;
  }>(c);
  return c.json(await reviewService.inviteReviewers({
      actorUserId: appUser.actorUserId,
      workspaceId: appUser.workspaceId,
      projectId: id,
      pricingTier: resolvePricingTier(appUser.pricingTier),
  }, roundId, body), 200);
});

app.post("/projects/:id/review-rounds/:roundId/comments", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id, roundId, body } = authenticatedHonoInput<{ id: string; roundId: string; body: InternalReviewCommentInput }>(c);
  return c.json(await reviewService.addInternalComment({
      actorUserId: appUser.actorUserId,
      workspaceId: appUser.workspaceId,
      projectId: id,
  }, roundId, body), 201);
});

app.post("/projects/:id/review-rounds/:roundId/comments/:commentId/resolve", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id, roundId, commentId } = authenticatedHonoInput<{ id: string; roundId: string; commentId: string }>(c);
  return c.json(await reviewService.resolveComment({
      actorUserId: appUser.actorUserId,
      workspaceId: appUser.workspaceId,
      projectId: id,
  }, roundId, commentId, true), 200);
});

app.post("/projects/:id/review-rounds/:roundId/comments/:commentId/reopen", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id, roundId, commentId } = authenticatedHonoInput<{ id: string; roundId: string; commentId: string }>(c);
  return c.json(await reviewService.resolveComment({
      actorUserId: appUser.actorUserId,
      workspaceId: appUser.workspaceId,
      projectId: id,
  }, roundId, commentId, false), 200);
});

app.post("/projects/:id/review-rounds/:roundId/notifications/retry", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id, roundId, body } = authenticatedHonoInput<{ id: string; roundId: string; body: RetryReviewNotificationInput }>(c);
  const result = await reviewNotificationService.retry(
      { workspaceId: appUser.workspaceId, projectId: id },
      roundId,
      body.ledgerId,
  );
  return result.retrying
    ? c.json(result, 200)
    : c.json({ error: "review_notification_not_found", message: "Failed notification was not found" }, 404);
});

app.post("/projects/:id/review-rounds/:roundId/revoke", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const { id, roundId } = authenticatedHonoInput<{ id: string; roundId: string }>(c);
  return c.json(await reviewService.revokeRound({ actorUserId: appUser.actorUserId, workspaceId: appUser.workspaceId, projectId: id }, roundId), 200);
});

// --- Versioned clip exports ---

app.post("/projects/:id/clips/:clipId/exports", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const idempotencyKey = c.req.header("idempotency-key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return c.json({ error: "invalid_input", message: "Invalid idempotency-key header" }, 400);
  }
  const payload = await c.req.json().catch(() => ({}));
  const parsed = createClipExportSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }

  const editor = await clipService.getClipEditorDocument(
      appUser,
      c.req.param("id"),
      c.req.param("clipId"),
    );
    const staleCount = editor.document.censorSegments.filter(
      (segment: CensorSegment) =>
        segment.enabled && isCensorSegmentStale(segment, editor.document.transcriptSlice),
    ).length;
    const motionError = motionDocumentExportError(
      appUser.pricingTier,
      editor.document,
    );
    if (motionError) throw motionError;
    if (staleCount > 0) {
      await autoCensorService.recordEvent(
        appUser,
        c.req.param("id"),
        c.req.param("clipId"),
        { type: "auto_censor_export_notice", staleCount },
      ).catch(() => undefined);
      throw new ClipExportError(
        "censor_segments_stale",
        "Review stale Auto Censor segments before exporting",
        { staleCount },
      );
    }
    const result = await clipExportService.create(
      c.req.param("id"),
      c.req.param("clipId"),
      parsed.data,
      idempotencyKey,
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
    );
  return c.json(result, result.reused && result.export.status === "ready" ? 200 : 202);
});

app.get("/projects/:id/exports/current", async (c) => {
  const appUser = authenticatedHonoActor(c);
  return c.json({
    exports: await clipExportService.listCurrentProjectExports(
      appUser.workspaceId,
      c.req.param("id"),
    ),
  }, 200, { "Cache-Control": "private, no-store" });
});

app.get("/projects/:id/clips/:clipId/exports/:exportId", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const result = await clipExportService.getOwned(
    appUser.workspaceOwnerUserId,
    c.req.param("id"),
    c.req.param("clipId"),
    c.req.param("exportId"),
    appUser.workspaceId,
  );
  if (!result) return c.json({ error: "export_not_found" }, 404);
  return c.json(result, 200, { "Cache-Control": "private, no-store" });
});

app.post("/projects/:id/clips/:clipId/exports/:exportId/retry", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const result = await clipExportService.retryFailed(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
      c.req.param("clipId"),
      c.req.param("exportId"),
      appUser.workspaceId,
  );
  return c.json(result, 202);
});

app.post("/projects/:id/clips/:clipId/exports/:exportId/share-links", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const parsed = createClipShareLinkSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const result = await clipExportService.createShareLink(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
      c.req.param("clipId"),
      c.req.param("exportId"),
      parsed.data.expiresInDays,
      appUser.workspaceId,
  );
  return c.json(result, 201, { "Cache-Control": "private, no-store" });
});

app.delete("/projects/:id/clips/:clipId/exports/:exportId/share-links", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const result = await clipExportService.revokeShareLinks(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
      c.req.param("clipId"),
      c.req.param("exportId"),
      appUser.workspaceId,
  );
  return c.json(result, 200);
});

app.post("/projects/:id/clips/apply-caption-preset", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const projectId = c.req.param("id");
  const parsed = applyCaptionPresetToAllSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const result = await clipEditorDocumentPersistence.mutateProjectSelection({
      actorUserId: appUser.actorUserId,
      workspaceId: appUser.workspaceId,
      workspaceOwnerUserId: appUser.workspaceOwnerUserId,
      projectId,
      excludeClipId: parsed.data.excludeClipId,
      intent: {
        kind: "set_caption_preset",
        captionPreset: parsed.data.captionPreset,
      },
  });
  return c.json(result, 200);
});

app.post("/projects/:id/clips/apply-studio-edits", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const projectId = c.req.param("id");
  const parsed = applyStudioEditsToAllSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const result = await clipEditorDocumentPersistence.mutateProjectSelection({
      actorUserId: appUser.actorUserId,
      workspaceId: appUser.workspaceId,
      workspaceOwnerUserId: appUser.workspaceOwnerUserId,
      projectId,
      excludeClipId: parsed.data.excludeClipId,
      intent: { kind: "patch_studio_edits", patches: parsed.data.patches },
  });
  const firstPatch = parsed.data.patches[0]!;
    const field =
      firstPatch.transition !== undefined
        ? "transition"
        : firstPatch.background !== undefined
          ? "background"
          : "framing";
  return c.json({ ...result, field }, 200);
});

// --- Stock B-roll search (Pexels) ---

app.get("/broll/search", async (c) => {
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
  const results = await searchBrollVideos(
    parsed.data.query,
    parsed.data.orientation,
  );
  return c.json({ configured: true, results }, 200);
});

// --- Content suite (repurposed text outputs) ---

app.get("/projects/:id/content-suite", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const projectId = c.req.param("id");
  const assets = await contentSuiteService.list(
      appUser.workspaceOwnerUserId,
      projectId,
  );
  return c.json({ assets }, 200);
});

app.post("/projects/:id/content-suite", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const projectId = c.req.param("id");
  const parsed = generateContentSuiteRequestSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const assets = await contentSuiteService.generate(
      appUser.actorUserId,
      appUser.workspaceId,
      projectId,
      parsed.data.types,
  );
  return c.json({ assets }, 200);
});

// --- First-party analytics ---

app.get("/projects/:id/analytics", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const analytics = await analyticsService.getProjectAnalytics(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
  );
  return c.json(analytics, 200);
});

// --- Native social accounts ---

app.get("/social/accounts", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const accounts = await socialOAuthService.listAccounts(
      appUser.workspaceOwnerUserId,
      appUser.workspaceId,
  );
  return c.json({ accounts }, 200);
});

app.get("/social/oauth/start/:platform", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const parsedPlatform = socialPlatformSchema.safeParse(c.req.param("platform"));
  if (!parsedPlatform.success) {
    return c.json({ error: "invalid_input", message: "Unsupported social platform" }, 400);
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

  const redirectPath = safeSocialRedirectPath(c.req.query("redirect"));
  try {
    const url = await socialOAuthService.createAuthorizationUrl({
      userId: appUser.workspaceOwnerUserId,
      workspaceId: appUser.workspaceId,
      actorUserId: appUser.actorUserId,
      platform: parsedPlatform.data,
      origin,
      redirectPath,
    });
    return c.redirect(url, 302);
  } catch (error) {
    if (!(error instanceof SocialOAuthError)) throw error;
    const code = error.code;
    const redirect = new URL(redirectPath, origin);
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
    const result = await socialOAuthService.handleCallback({ state, code, origin });
    const successRedirect = new URL(
      safeSocialRedirectPath(result.redirectPath),
      origin,
    );
    if (result.facebookSelectionToken) successRedirect.searchParams.set("facebook_selection", result.facebookSelectionToken);
    else successRedirect.searchParams.set("connected", String(result.accounts.length));
    return c.redirect(successRedirect.toString(), 302);
  } catch (error) {
    redirect.searchParams.set(
      "error",
      error instanceof SocialOAuthError
        ? error.code
        : "social_oauth_callback_failed",
    );
    return c.redirect(redirect.toString(), 302);
  }
});

app.get("/social/oauth/facebook-selection/:token", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const token = c.req.param("token");
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return c.json({ error: "social_facebook_selection_invalid" }, 400);
  try {
    return c.json({ pages: await socialOAuthService.getFacebookPageSelection(appUser.workspaceOwnerUserId, appUser.workspaceId, token) }, 200);
  } catch (error) {
    const code = error instanceof SocialOAuthError ? error.code : "social_facebook_selection_failed";
    return c.json({ error: code, message: error instanceof SocialOAuthError ? error.message : "Facebook Pages could not be loaded" }, 400);
  }
});

app.post("/social/oauth/facebook-selection/:token", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const token = c.req.param("token");
  const payload = await c.req.json().catch(() => null) as { pageId?: unknown } | null;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token) || typeof payload?.pageId !== "string" || payload.pageId.length > 200) {
    return c.json({ error: "invalid_input" }, 400);
  }
  try {
    const account = await socialOAuthService.completeFacebookPageSelection(appUser.workspaceOwnerUserId, appUser.workspaceId, token, payload.pageId);
    return c.json({ account }, 201);
  } catch (error) {
    const code = error instanceof SocialOAuthError ? error.code : "social_facebook_selection_failed";
    return c.json({ error: code, message: error instanceof SocialOAuthError ? error.message : "Facebook Page could not be connected" }, 400);
  }
});

app.delete("/social/accounts/:accountId", async (c) => {
  const appUser = authenticatedHonoActor(c);
  await socialOAuthService.disconnectAccount(
      appUser.workspaceOwnerUserId,
      c.req.param("accountId"),
      appUser.workspaceId,
  );
  return c.json({ ok: true }, 200);
});

// --- Social scheduling metadata ---

app.get("/projects/:id/social-posts", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const posts = await socialService.listProjectPosts(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
  );
  return c.json({ posts }, 200);
});

app.post("/projects/:id/social-posts", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const projectId = c.req.param("id");
  const parsed = scheduleSocialPostSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const post = await socialService.schedulePost(
      appUser.workspaceOwnerUserId,
      projectId,
      parsed.data,
      {
        workspaceId: appUser.workspaceId,
        actorUserId: appUser.actorUserId,
      },
  );
  return c.json(post, 201);
});

app.delete("/projects/:id/social-posts/:postId", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const post = await socialService.cancelPost(
      c.req.param("id"),
      c.req.param("postId"),
      {
        workspaceId: appUser.workspaceId,
        actorUserId: appUser.actorUserId,
      },
  );
  return c.json(post, 200);
});

app.get("/projects/:id/social-posts/:postId/publication", async (c) => {
  const appUser = authenticatedHonoActor(c);
  return c.json(
      await socialService.inspectPublication(
        appUser.workspaceId,
        c.req.param("postId"),
        c.req.param("id"),
      ),
    200,
  );
});

app.post("/projects/:id/social-posts/:postId/recheck", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const parsed = recheckSocialPublicationSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  return c.json(
      await socialService.recheckPublication(
        appUser.workspaceId,
        appUser.actorUserId,
        c.req.param("postId"),
        parsed.data,
        c.req.param("id"),
      ),
    200,
  );
});

app.post("/projects/:id/social-posts/:postId/confirm", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const parsed = confirmSocialPublicationSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  return c.json(
      await socialService.confirmPublication(
        appUser.workspaceId,
        appUser.actorUserId,
        c.req.param("postId"),
        parsed.data,
        c.req.param("id"),
      ),
    200,
  );
});

app.post("/projects/:id/social-posts/:postId/publish-again", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const parsed = republishSocialPublicationSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  return c.json(
      await socialService.republishPublication(
        appUser.workspaceId,
        appUser.actorUserId,
        c.req.param("postId"),
        parsed.data,
        c.req.param("id"),
      ),
    201,
  );
});

app.post("/projects/:id/social-posts/:postId/metrics", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const parsed = socialPostMetricsSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const post = await socialService.recordPostMetrics(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
      c.req.param("postId"),
      parsed.data,
  );
  return c.json(post, 201);
});

// --- Voiceover dubbing ---

app.get("/projects/:id/dubs", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const dubs = await dubbingService.listProjectDubs(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
  );
  return c.json({ dubs }, 200);
});

app.post("/projects/:id/dubs", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const idempotencyKey = c.req.header("idempotency-key") ?? "";
  if (!idempotencyKey) {
    return c.json({ error: "invalid_input", message: "Missing idempotency-key header" }, 400);
  }
  const parsed = requestClipDubSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const result = await dubbingService.requestClipDub(
      appUser.actorUserId,
      appUser.workspaceId,
      c.req.param("id"),
      idempotencyKey,
      parsed.data,
  );
  return c.json(result, 202);
});

app.get("/projects/:id/dubs/:dubId/download", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const parsed = dubDownloadQuerySchema.safeParse({
    asset: c.req.query("asset") ?? undefined,
  });
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const result = await dubbingService.getDubDownloadUrl(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
      c.req.param("dubId"),
      parsed.data.asset,
  );
  return c.json(result, 200);
});

app.get("/projects/:id/clips/previews", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const parsed = clipDownloadQuerySchema.safeParse({
    aspectRatio: new URL(c.req.url).searchParams.get("aspectRatio") ?? undefined,
  });
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const result = await clipService.getProjectClipPreviewUrls(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
      parsed.data.aspectRatio,
  );
  return c.json(result, 200);
});

app.get("/projects/:id/clips/:clipId/download", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const parsed = clipDownloadQuerySchema.safeParse({
    aspectRatio: new URL(c.req.url).searchParams.get("aspectRatio") ?? undefined,
  });
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const result = await clipService.getClipDownloadUrl(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
      c.req.param("clipId"),
      parsed.data.aspectRatio,
  );
  return c.json(result, 200);
});

app.get("/projects/:id/clips/:clipId/file", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const projectId = c.req.param("id");

  const parsedQuery = clipDownloadQuerySchema.safeParse({
    aspectRatio:
      new URL(c.req.url).searchParams.get("aspectRatio") ?? undefined,
  });
  if (!parsedQuery.success) {
    return c.json(
      { error: "invalid_input", issues: parsedQuery.error.issues },
      400,
    );
  }

  const result = await clipService.getClipDownloadUrl(
      appUser.workspaceOwnerUserId,
      projectId,
      c.req.param("clipId"),
      parsedQuery.data.aspectRatio,
  );
  return c.redirect(result.downloadUrl, 302);
});

app.get("/brand-templates", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const result = await brandTemplateService.list(appUser.workspaceOwnerUserId, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId,
  });
  return c.json(result, 200);
});

app.get("/brand-templates/:id", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const template = await brandTemplateService.get(appUser.workspaceOwnerUserId, c.req.param("id"), { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  return c.json(template, 200);
});

app.post("/brand-templates", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const payload = await c.req.json().catch(() => null);
  const parsed = brandTemplateInputSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const template = await brandTemplateService.create(appUser.workspaceOwnerUserId, parsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  return c.json(template, 201);
});

app.patch("/brand-templates/:id", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const payload = await c.req.json().catch(() => null);
  const parsed = brandTemplateUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const template = await brandTemplateService.update(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
      parsed.data,
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
  );
  return c.json(template, 200);
});

app.delete("/brand-templates/:id", async (c) => {
  const appUser = authenticatedHonoActor(c);
  await brandTemplateService.softDelete(appUser.workspaceOwnerUserId, c.req.param("id"), { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  return c.json({ ok: true }, 200);
});

app.post("/brand-templates/:id/set-default", async (c) => {
  const appUser = authenticatedHonoActor(c);
  await brandTemplateService.setDefault(appUser.workspaceOwnerUserId, c.req.param("id"), { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  return c.json({ ok: true }, 200);
});

app.post("/brand-templates/:id/duplicate", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const payload = await c.req.json().catch(() => ({}));
  const parsed = duplicateBrandTemplateSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const template = await brandTemplateService.duplicate(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
      parsed.data.name,
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
  );
  return c.json(template, 201);
});

app.post("/brand-templates/logo/presign", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const payload = await c.req.json().catch(() => null);
  const parsed = presignBrandLogoSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const result = await brandTemplateService.presignLogoUpload(appUser.workspaceOwnerUserId, parsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  return c.json(result, 200);
});

app.get("/brand-templates/:id/logo-url", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const url = await brandTemplateService.getLogoDownloadUrl(
      appUser.workspaceOwnerUserId,
      c.req.param("id"),
      { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
  );
  if (!url) return c.json({ error: "brand_template_logo_missing" }, 404);
  return c.json({ url }, 200);
});

// Music/SFX library (docs/plans/vizard-parity.md "Music/SFX library").
// Mirrors the brand-templates logo presign/finalize shape immediately above:
// presign against R2, verify ownership on finalize, serve playback through a
// short-lived presigned download URL.
app.get("/audio-assets", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const parsed = listAudioAssetsQuerySchema.safeParse({
    kind: c.req.query("kind"),
    mood: c.req.query("mood") ?? undefined,
  });
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const result = await audioAssetService.listAssets(appUser.workspaceOwnerUserId, parsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  return c.json(result, 200);
});

app.post("/audio-assets/presign-upload", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const payload = await c.req.json().catch(() => null);
  const parsed = presignAudioUploadSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const result = await audioAssetService.presignUpload(appUser.workspaceOwnerUserId, parsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  return c.json(result, 200);
});

app.post("/audio-assets", async (c) => {
  const appUser = authenticatedHonoActor(c);

  const payload = await c.req.json().catch(() => null);
  const parsed = finalizeAudioUploadSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
  }
  const asset = await audioAssetService.finalizeUpload(appUser.workspaceOwnerUserId, parsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  return c.json(asset, 201);
});

app.get("/audio-assets/:id/playback-url", async (c) => {
  const appUser = authenticatedHonoActor(c);
  // L3: validate the path param is a UUID before it ever reaches Prisma — a
  // malformed id would otherwise throw a raw PrismaClientValidationError,
  // surfaced through the generic 400 branch below with an ugly internal
  // message instead of a clean, expected one.
  const idParsed = audioAssetIdParamSchema.safeParse(c.req.param("id"));
  if (!idParsed.success) {
    return c.json({ error: "invalid_audio_asset_id", message: "Invalid audio asset id" }, 400);
  }
  const source = await audioAssetService.getPlaybackSource(appUser.workspaceOwnerUserId, idParsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  if (!source) return c.json({ error: "audio_asset_not_found" }, 404);
  return c.json(source, 200);
});

app.put("/audio-assets/:id/favorite", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const idParsed = audioAssetIdParamSchema.safeParse(c.req.param("id"));
  if (!idParsed.success) return c.json({ error: "invalid_audio_asset_id", message: "Invalid audio asset id" }, 400);
  return c.json(
      await audioAssetService.setFavorite(appUser.workspaceOwnerUserId, idParsed.data, true, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
      ),
      200,
  );
});

app.delete("/audio-assets/:id/favorite", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const idParsed = audioAssetIdParamSchema.safeParse(c.req.param("id"));
  if (!idParsed.success) return c.json({ error: "invalid_audio_asset_id", message: "Invalid audio asset id" }, 400);
  return c.json(
      await audioAssetService.setFavorite(appUser.workspaceOwnerUserId, idParsed.data, false, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
      ),
      200,
  );
});

app.delete("/audio-assets/:id", async (c) => {
  const appUser = authenticatedHonoActor(c);
  const idParsed = audioAssetIdParamSchema.safeParse(c.req.param("id"));
  if (!idParsed.success) {
    return c.json({ error: "invalid_audio_asset_id", message: "Invalid audio asset id" }, 400);
  }
  await audioAssetService.deleteUserAsset(appUser.workspaceOwnerUserId, idParsed.data, { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId });
  return c.json({ ok: true }, 200);
});

const honoHandler = handle(app);

export const GET = honoHandler;
export const POST = honoHandler;
export const PUT = honoHandler;
export const PATCH = honoHandler;
export const DELETE = honoHandler;
export const OPTIONS = honoHandler;
