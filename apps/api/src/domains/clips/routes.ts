import {
  campaignOperationService,
  clipEditorDocumentPersistence,
  clipService,
  clipsCommands,
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
  regenerateClipsRequestSchema,
  requestThumbnailFrameSchema,
  triggerClipRenderSchema,
} from "@narriflow/validators/api/clips";
import { resolvePricingTier } from "@narriflow/validators";
import { createRouteApp, getActor, getRecordedRateLimit } from "../../http/admission";
import { enforceRecordedRateLimit } from "../../http/limits";
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
  clipsCommands: typeof clipsCommands;
  thumbnailFramePreparationService: typeof thumbnailFramePreparationService;
}

/**
 * Clip reads, duplicate/range/delete, regeneration and rendering, thumbnail
 * frames, campaign operations and clip download grants. Literal paths (`create-from-range`, `render`,
 * `previews`, `apply-*`) are registered before parameter routes.
 */
export function createClipsRoutes(deps: ClipsRouteDeps) {
  const {
    clipService,
    clipEditorDocumentPersistence,
    campaignOperationService,
    clipsCommands,
    thumbnailFramePreparationService,
  } = deps;

  return createRouteApp(access)
    .get("/projects/:id/clips", async (c) => {
      const clips = await clipService.listClips(getActor(c), c.req.param("id"));
      return c.json({ clips }, 200);
    })

    // Waveform metadata for the Studio. Proxied only as a bounded, validated
    // artifact so no bucket-wide CORS dependency is needed. The URL does not
    // name the preview attempt, so the default `no-store` applies: a cached
    // artifact would outlive a regenerated proxy.
    .get(
      "/projects/:id/clips/:clipId/preview-peaks",
      async (c) => {
        const peaks = await clipService.getClipPreviewPeaks(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
        );
        if (!peaks) return c.body(null, 204);
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
    // R2 so the copy is immediately playable. The Idempotency-Key makes a
    // retry return the accepted copy; the limiter is enforced only for new work,
    // before any media is copied, so a stuck click cannot fan out into dozens
    // of R2 copies.
    .post(
      "/projects/:id/clips/:clipId/duplicate",
      requireIdempotencyKey(),
      async (c) => {
        const { clip, replayed } = await clipsCommands.duplicateClip(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          {
            clientIdempotencyKey: getIdempotencyKey(c),
            beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)),
          },
        );
        if (replayed) c.header("Idempotent-Replayed", "true");
        return c.json(clip, 201);
      },
    )

    // A new, from-scratch clip carved out of a transcript selection (not a
    // duplicate-and-retrim chain, which can orphan copied assets on partial
    // failure). `clip_selection_invalid` maps to 422. The Idempotency-Key makes
    // a retry after a lost response return the accepted clip.
    .post(
      "/projects/:id/clips/:clipId/create-from-selection",
      requireIdempotencyKey(),
      validate("json", createClipFromSelectionSchema),
      async (c) => {
        const { clip, replayed } = await clipsCommands.createClipFromSelection(
          getActor(c),
          c.req.param("id"),
          c.req.param("clipId"),
          c.req.valid("json"),
          {
            clientIdempotencyKey: getIdempotencyKey(c),
            beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)),
          },
        );
        if (replayed) c.header("Idempotent-Replayed", "true");
        return c.json(clip, 201);
      },
    )

    // "Make a clip" from a library search result: a clip over a transcript
    // range with the project's best clip as its source. A project without
    // clips yet is refused with `clip_source_missing` (409).
    .post(
      "/projects/:id/clips/create-from-range",
      uuidParams("id"),
      requireIdempotencyKey(),
      validate("json", createClipFromSelectionSchema),
      async (c) => {
        const { clip, replayed } = await clipsCommands.createClipFromRange(
          getActor(c),
          c.req.valid("param").id,
          c.req.valid("json"),
          {
            clientIdempotencyKey: getIdempotencyKey(c),
            beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)),
          },
        );
        if (replayed) c.header("Idempotent-Replayed", "true");
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

    // Regeneration is a Workflow Run admission: the header key is the run's own
    // admission key, so a retry returns the run it already started.
    .post(
      "/projects/:id/clips/regenerate",
      uuidParams("id"),
      requireIdempotencyKey(),
      validate("json", regenerateClipsRequestSchema),
      async (c) =>
        c.json(
          await clipService.regenerateClips(
            getActor(c),
            c.req.valid("param").id,
            getIdempotencyKey(c),
            c.req.valid("json").contentPack,
          ),
          202,
        ),
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
    );
}

export type ClipsRoutes = ReturnType<typeof createClipsRoutes>;
