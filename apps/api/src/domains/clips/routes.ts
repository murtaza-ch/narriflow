import {
  campaignOperationService,
  clipEditorDocumentPersistence,
  clipService,
  thumbnailFramePreparationService,
} from "@narriflow/services";
import {
  applyCaptionPresetToAllSchema,
  applyMotionSelectedSchema,
  applyProjectBrandProfileSelectedSchema,
  applyStudioEditsToAllSchema,
  applyStyleSelectedSchema,
  clipDownloadQuerySchema,
  createClipFromSelectionSchema,
  previewCampaignEditorActionSchema,
  requestThumbnailFrameSchema,
  resolvePricingTier,
  triggerClipRenderSchema,
} from "@narriflow/validators";
import { createRouteApp, getActor } from "../../http/admission";
import { bodyClass } from "../../body-limits";
import {
  getIdempotencyKey,
  readCampaignRetryOf,
  requireIdempotencyKey,
} from "../../http/idempotency";
import { validate } from "../../http/route";
import { uuidParams } from "../platform/params";
import { clipsAdmission as access } from "./admission";

/** Services the clips routes call. `runtime.ts` supplies the production instances. */
export interface ClipsRouteDeps {
  clipService: typeof clipService;
  clipEditorDocumentPersistence: typeof clipEditorDocumentPersistence;
  campaignOperationService: typeof campaignOperationService;
  thumbnailFramePreparationService: typeof thumbnailFramePreparationService;
}

/**
 * Clip reads, duplicate/range/delete, rendering, thumbnail frames, campaign
 * operations and clip downloads. Literal paths (`create-from-range`, `render`,
 * `previews`, `apply-*`) are registered before parameter routes.
 */
export function createClipsRoutes(deps: ClipsRouteDeps) {
  const {
    clipService,
    clipEditorDocumentPersistence,
    campaignOperationService,
    thumbnailFramePreparationService,
  } = deps;

  return createRouteApp(access)
    .get("/projects/:id/clips", async (c) => {
      const clips = await clipService.listClips(getActor(c), c.req.param("id"));
      return c.json({ clips }, 200);
    })

    // Waveform metadata for the Studio. Proxied only as a bounded, validated
    // artifact so no bucket-wide CORS dependency is needed.
    .get(
      "/projects/:id/clips/:clipId/preview-peaks",
      async (c) => {
        const peaks = await clipService.getClipPreviewPeaks(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
        );
        if (!peaks) return c.body(null, 204);
        c.header("Cache-Control", "private, max-age=3600, immutable");
        return c.json(peaks, 200);
      },
    )

    // Alternative AI-written titles for one clip. Read-only: the caller picks
    // one and PATCHes it back as an ordinary rename. Rate limited per user
    // because each call is a real LLM completion.
    .post(
      "/projects/:id/clips/:clipId/title-suggestions",
      async (c) => {
        const titles = await clipService.suggestClipTitles(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
        );
        return c.json({ titles }, 200);
      },
    )

    // Duplicates a clip, copying its finished renders and preview proxy inside
    // R2 so the copy is immediately playable. The rate limit keeps a stuck
    // click from fanning out into dozens of R2 copies.
    .post(
      "/projects/:id/clips/:clipId/duplicate",
      async (c) => {
        const clip = await clipService.duplicateClip(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
        );
        return c.json(clip, 201);
      },
    )

    // A new, from-scratch clip carved out of a transcript selection (not a
    // duplicate-and-retrim chain, which can orphan copied assets on partial
    // failure). `clip_selection_invalid` maps to 422.
    .post(
      "/projects/:id/clips/:clipId/create-from-selection",
      validate("json", createClipFromSelectionSchema),
      async (c) => {
        const clip = await clipService.createClipFromSelection(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          c.req.valid("json"),
        );
        return c.json(clip, 201);
      },
    )

    // "Make a clip" from a library search result: a clip over a transcript
    // range with the project's best clip as its source. A project without
    // clips yet is refused with `clip_source_missing` (409).
    .post(
      "/projects/:id/clips/create-from-range",
      uuidParams("id"),
      validate("json", createClipFromSelectionSchema),
      async (c) => {
        const clip = await clipService.createClipFromRange(
          getActor(c),
          c.req.valid("param").id,
          c.req.valid("json"),
        );
        return c.json(clip, 201);
      },
    )

    // Permanently deletes one clip and its stored assets; refused with
    // `clip_has_scheduled_posts` while scheduled or publishing posts exist.
    .delete(
      "/projects/:id/clips/:clipId",
      async (c) => {
        await clipService.deleteClip(getActor(c), c.req.param("id"), c.req.param("clipId"));
        return c.json({ ok: true }, 200);
      },
    )

    .post(
      "/projects/:id/clips/render",
      requireIdempotencyKey(),
      validate("json", triggerClipRenderSchema),
      async (c) => {
        const appUser = getActor(c);
        const projectId = c.req.param("id");
        const idempotencyKey = getIdempotencyKey(c);
        const input = c.req.valid("json");
        const execute = (clipIds?: string[]) =>
          clipService.triggerClipRendering(
            appUser,
            projectId,
            idempotencyKey,
            clipIds,
            input.aspectRatios,
            input.resolution,
          );
        const result = input.clipIds
          ? await campaignOperationService.renderSelected({
              actorUserId: appUser.actorUserId,
              workspaceId: appUser.workspaceId,
              projectId,
              pricingTier: resolvePricingTier(appUser.pricingTier),
              idempotencyKey,
              clipIds: input.clipIds,
              aspectRatios: input.aspectRatios,
              resolution: input.resolution,
              execute,
            })
          : await execute();
        return c.json(result, 202);
      },
    )

    .get(
      "/projects/:id/campaign-operations",
      async (c) => {
        const appUser = getActor(c);
        return c.json(
          {
            operations: await campaignOperationService.listOperations({
              actorUserId: appUser.actorUserId,
              workspaceId: appUser.workspaceId,
              projectId: c.req.param("id"),
            }),
          },
          200,
        );
      },
    )

    .post(
      "/projects/:id/thumbnail-frames",
      uuidParams("id"),
      validate("json", requestThumbnailFrameSchema),
      async (c) => {
        const appUser = getActor(c);
        return c.json(
          await thumbnailFramePreparationService.request({
            actorUserId: appUser.actorUserId,
            workspaceId: appUser.workspaceId,
            projectId: c.req.valid("param").id,
            ...c.req.valid("json"),
          }),
          202,
        );
      },
    )

    .get(
      "/projects/:id/thumbnail-frames/:operationId",
      uuidParams("id", "operationId"),
      async (c) => {
        const { id, operationId } = c.req.valid("param");
        return c.json(
          await thumbnailFramePreparationService.get(getActor(c).workspaceId, id, operationId),
          200,
        );
      },
    )

    .post(
      "/projects/:id/thumbnail-frames/:operationId/retry",
      uuidParams("id", "operationId"),
      async (c) => {
        const { id, operationId } = c.req.valid("param");
        return c.json(
          await thumbnailFramePreparationService.retry(getActor(c).workspaceId, id, operationId),
          202,
        );
      },
    )

    .get(
      "/projects/:id/campaign-operations/editor-action-catalog",
      uuidParams("id"),
      async (c) => {
        const appUser = getActor(c);
        return c.json(
          await campaignOperationService.getEditorActionCatalog({
            actorUserId: appUser.actorUserId,
            workspaceId: appUser.workspaceId,
            workspaceOwnerUserId: appUser.workspaceOwnerUserId,
            role: appUser.role,
            status: appUser.status,
            pricingTier: appUser.pricingTier,
            isPersonalWorkspace: appUser.isPersonalWorkspace,
            projectId: c.req.valid("param").id,
          }),
          200,
        );
      },
    )

    .post(
      "/projects/:id/campaign-operations/preview-editor-action",
      uuidParams("id"),
      validate("json", previewCampaignEditorActionSchema),
      async (c) => {
        const appUser = getActor(c);
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
              projectId: c.req.valid("param").id,
            },
            c.req.valid("json"),
          ),
          200,
        );
      },
    )

    .post(
      "/projects/:id/campaign-operations/apply-brand-profile",
      bodyClass("editor"),
      uuidParams("id"),
      requireIdempotencyKey(),
      readCampaignRetryOf(),
      validate("json", applyProjectBrandProfileSelectedSchema),
      async (c) => {
        const appUser = getActor(c);
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
              projectId: c.req.valid("param").id,
              idempotencyKey: getIdempotencyKey(c),
              retryOfId: c.get("campaignRetryOf"),
            },
            c.req.valid("json"),
          ),
          200,
        );
      },
    )

    .post(
      "/projects/:id/campaign-operations/apply-style",
      bodyClass("editor"),
      uuidParams("id"),
      requireIdempotencyKey(),
      readCampaignRetryOf(),
      validate("json", applyStyleSelectedSchema),
      async (c) => {
        const appUser = getActor(c);
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
              projectId: c.req.valid("param").id,
              idempotencyKey: getIdempotencyKey(c),
              retryOfId: c.get("campaignRetryOf"),
            },
            c.req.valid("json"),
          ),
          200,
        );
      },
    )

    .post(
      "/projects/:id/campaign-operations/apply-motion",
      bodyClass("editor"),
      uuidParams("id"),
      requireIdempotencyKey(),
      readCampaignRetryOf(),
      validate("json", applyMotionSelectedSchema),
      async (c) => {
        const appUser = getActor(c);
        return c.json(
          await campaignOperationService.applyMotionSelected(
            {
              actorUserId: appUser.actorUserId,
              workspaceId: appUser.workspaceId,
              projectId: c.req.valid("param").id,
              pricingTier: resolvePricingTier(appUser.pricingTier),
              role: appUser.role,
              status: appUser.status,
              idempotencyKey: getIdempotencyKey(c),
              retryOfId: c.get("campaignRetryOf"),
            },
            c.req.valid("json"),
          ),
          200,
        );
      },
    )

    .post(
      "/projects/:id/clips/apply-caption-preset",
      validate("json", applyCaptionPresetToAllSchema),
      async (c) => {
        const appUser = getActor(c);
        const input = c.req.valid("json");
        const result = await clipEditorDocumentPersistence.mutateProjectSelection({
          actorUserId: appUser.actorUserId,
          workspaceId: appUser.workspaceId,
          projectId: c.req.param("id"),
          excludeClipId: input.excludeClipId,
          intent: { kind: "set_caption_preset", captionPreset: input.captionPreset },
        });
        return c.json(result, 200);
      },
    )

    .post(
      "/projects/:id/clips/apply-studio-edits",
      bodyClass("editor"),
      validate("json", applyStudioEditsToAllSchema),
      async (c) => {
        const appUser = getActor(c);
        const input = c.req.valid("json");
        const result = await clipEditorDocumentPersistence.mutateProjectSelection({
          actorUserId: appUser.actorUserId,
          workspaceId: appUser.workspaceId,
          projectId: c.req.param("id"),
          excludeClipId: input.excludeClipId,
          intent: { kind: "patch_studio_edits", patches: input.patches },
        });
        const firstPatch = input.patches[0]!;
        const field =
          firstPatch.transition !== undefined
            ? "transition"
            : firstPatch.background !== undefined
              ? "background"
              : "framing";
        return c.json({ ...result, field }, 200);
      },
    )

    .get(
      "/projects/:id/clips/previews",
      validate("query", clipDownloadQuerySchema),
      async (c) => {
        const result = await clipService.getProjectClipPreviewUrls(
          getActor(c),
          c.req.param("id"),
          c.req.valid("query").aspectRatio,
        );
        return c.json(result, 200);
      },
    )

    .get(
      "/projects/:id/clips/:clipId/download",
      validate("query", clipDownloadQuerySchema),
      async (c) => {
        const result = await clipService.getClipDownloadUrl(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          c.req.valid("query").aspectRatio,
        );
        return c.json(result, 200);
      },
    )

    .get(
      "/projects/:id/clips/:clipId/file",
      validate("query", clipDownloadQuerySchema),
      async (c) => {
        const result = await clipService.getClipDownloadUrl(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          c.req.valid("query").aspectRatio,
        );
        return c.redirect(result.downloadUrl, 302);
      },
    );
}

export type ClipsRoutes = ReturnType<typeof createClipsRoutes>;
