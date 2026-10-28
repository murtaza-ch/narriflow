import {
  audioAssetService,
  brandFontService,
  brandProfileService,
  brandTemplateService,
  campaignOperationService,
  generatedMediaService,
  GeneratedMediaJobError,
  sceneTemplateService,
  visualAssetService,
  type BrandActorScope,
} from "@narriflow/services";
import {
  brandProfileDetailQuerySchema,
  brandProfilesPageQuerySchema,
  defaultBrandProfileQuerySchema,
  generatedMediaJobsQuerySchema,
} from "@narriflow/validators/api/brand";
import {
  applySceneTemplateSchema,
  audioAssetIdParamSchema,
  brandFontFinalizeSchema,
  brandFontUploadSchema,
  brandProfileCreateSchema,
  brandProfileMembershipSchema,
  brandProfileSoftDeleteSchema,
  brandProfileUpdateSchema,
  brandTemplateInputSchema,
  brandTemplateUpdateSchema,
  createGeneratedImageSchema,
  duplicateBrandTemplateSchema,
  finalizeAudioUploadSchema,
  listAudioAssetsQuerySchema,
  presignAudioUploadSchema,
  presignBrandLogoSchema,
  reusableAssetSoftDeleteSchema,
  sceneTemplateCreateSchema,
  sceneTemplateDeleteSchema,
  sceneTemplateUpdateSchema,
  visualAssetFinalizeSchema,
  visualAssetUploadSchema,
} from "@narriflow/validators";
import type { Context } from "hono";
import { createRouteApp, getActor, getRecordedRateLimit } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import {
  getIdempotencyKey,
  readCampaignRetryOf,
  requireIdempotencyKey,
} from "../../http/idempotency";
import { enforceRecordedRateLimit } from "../../http/limits";
import { validate } from "../../http/route";
import { uuidParams } from "../platform/params";
import { brandAdmission as access } from "./admission";
import {
  readBrandKit,
  readBrandProfileDetail,
  readBrandProfileUsage,
  readBrandTemplateEditorAssets,
  readBrandTemplateProfile,
  readDefaultBrandProfile,
  type BrandAggregateServices,
} from "./aggregates";

/** Services the brand routes call. `runtime.ts` supplies the production instances. */
export interface BrandRouteDeps extends BrandAggregateServices {
  audioAssets: typeof audioAssetService;
  templates: typeof brandTemplateService;
  profiles: typeof brandProfileService;
  fonts: typeof brandFontService;
  scenes: typeof sceneTemplateService;
  visualAssets: typeof visualAssetService;
  generatedMedia: typeof generatedMediaService;
  campaignOperations: typeof campaignOperationService;
}

const INVALID_AUDIO_ASSET_ID = {
  error: "invalid_audio_asset_id",
  message: "Invalid audio asset id",
} as const;

/** The service-facing slice of the admitted actor; the rest of the App User never reaches a service. */
function brandScope(c: Context<ApiEnv>): BrandActorScope {
  const actor = getActor(c);
  return {
    actorUserId: actor.actorUserId,
    workspaceId: actor.workspaceId,
    workspaceOwnerUserId: actor.workspaceOwnerUserId,
    role: actor.role,
    status: actor.status,
    pricingTier: actor.pricingTier,
    isPersonalWorkspace: actor.isPersonalWorkspace,
  };
}

/**
 * Receipt facts of a retryable create: the browser's per-intent key, and the
 * limiter outcome recorded at admission, enforced only after the receipt's
 * locked replay check so an exhausted or unavailable limiter never hides a
 * create that was already accepted.
 */
function receiptOf(c: Context<ApiEnv>) {
  return {
    clientIdempotencyKey: getIdempotencyKey(c),
    beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)),
  };
}

/** The Music/SFX library resolves ownership from the Workspace the actor is in. */
function audioScope(c: Context<ApiEnv>) {
  const actor = getActor(c);
  return {
    ownerUserId: actor.workspaceOwnerUserId,
    actor: { workspaceId: actor.workspaceId, actorUserId: actor.actorUserId },
  };
}

/**
 * Brand Kit: profiles, caption styles, fonts, scenes, visual assets, Music/SFX,
 * generated media and applying a scene template to a Project's clips.
 * Literal paths (`/brand-profiles/default`, `/brand-templates/logo/presign`)
 * are registered before the parameter routes that could swallow them.
 */
export function createBrandRoutes(deps: BrandRouteDeps) {
  return (
    createRouteApp(access)
      // --- Aggregates -------------------------------------------------------
      .get("/brand-kit", async (c) => c.json(await readBrandKit(deps, brandScope(c)), 200))

      // --- Brand Profiles ---------------------------------------------------
      .get("/brand-profiles", validate("query", brandProfilesPageQuerySchema), async (c) => {
        const { limit, query, cursor } = c.req.valid("query");
        const profiles = await deps.profiles.list(brandScope(c), {
          limit: limit ?? 24,
          query,
          cursor,
          includeDeleted: false,
        });
        return c.json({ profiles }, 200);
      })

      .get("/brand-profiles/default", validate("query", defaultBrandProfileQuerySchema), async (c) =>
        c.json(
          await readDefaultBrandProfile(deps, brandScope(c), c.req.valid("query").applicable === "1"),
          200,
        ),
      )

      .get("/brand-profiles/:id", uuidParams("id"), async (c) =>
        c.json(await deps.profiles.get(brandScope(c), c.req.valid("param").id), 200),
      )

      .get(
        "/brand-profiles/:id/detail",
        uuidParams("id"),
        validate("query", brandProfileDetailQuerySchema),
        async (c) =>
          c.json(
            await readBrandProfileDetail(
              deps,
              brandScope(c),
              c.req.valid("param").id,
              c.req.valid("query").section ?? "identity",
            ),
            200,
          ),
      )

      .get("/brand-profiles/:id/usage", uuidParams("id"), async (c) =>
        c.json(await readBrandProfileUsage(deps, brandScope(c), c.req.valid("param").id), 200),
      )

      .post(
        "/brand-profiles",
        requireIdempotencyKey(),
        validate("json", brandProfileCreateSchema),
        async (c) =>
          c.json(await deps.profiles.create(brandScope(c), c.req.valid("json"), receiptOf(c)), 201),
      )

      .patch(
        "/brand-profiles/:id",
        uuidParams("id"),
        validate("json", brandProfileUpdateSchema),
        async (c) =>
          c.json(
            await deps.profiles.update(brandScope(c), c.req.valid("param").id, c.req.valid("json")),
            200,
          ),
      )

      .put(
        "/brand-profiles/:id/membership",
        uuidParams("id"),
        validate("json", brandProfileMembershipSchema),
        async (c) =>
          c.json(
            await deps.profiles.setMembership(
              brandScope(c),
              c.req.valid("param").id,
              c.req.valid("json"),
            ),
            200,
          ),
      )

      .post("/brand-profiles/:id/set-default", uuidParams("id"), async (c) => {
        await deps.profiles.setDefault(brandScope(c), c.req.valid("param").id);
        return c.json({ ok: true }, 200);
      })

      .delete(
        "/brand-profiles/:id",
        uuidParams("id"),
        validate("json", brandProfileSoftDeleteSchema),
        async (c) => {
          await deps.profiles.softDelete(brandScope(c), c.req.valid("param").id, c.req.valid("json"));
          return c.json({ ok: true }, 200);
        },
      )

      // --- Scene templates --------------------------------------------------
      .get("/brand-profiles/:id/scene-templates", uuidParams("id"), async (c) =>
        c.json({ scenes: await deps.scenes.list(brandScope(c), c.req.valid("param").id) }, 200),
      )

      .post(
        "/brand-profiles/:id/scene-templates",
        uuidParams("id"),
        requireIdempotencyKey(),
        validate("json", sceneTemplateCreateSchema),
        async (c) =>
          c.json(
            await deps.scenes.create(
              brandScope(c),
              c.req.valid("param").id,
              c.req.valid("json"),
              receiptOf(c),
            ),
            201,
          ),
      )

      .patch(
        "/brand-profiles/:id/scene-templates/:templateId",
        uuidParams("id", "templateId"),
        validate("json", sceneTemplateUpdateSchema),
        async (c) => {
          const { id, templateId } = c.req.valid("param");
          return c.json(await deps.scenes.update(brandScope(c), id, templateId, c.req.valid("json")), 200);
        },
      )

      .delete(
        "/brand-profiles/:id/scene-templates/:templateId",
        uuidParams("id", "templateId"),
        validate("json", sceneTemplateDeleteSchema),
        async (c) => {
          const { id, templateId } = c.req.valid("param");
          return c.json(await deps.scenes.softDelete(brandScope(c), id, templateId, c.req.valid("json")), 200);
        },
      )

      .post(
        "/projects/:id/brand-profiles/:profileId/scene-templates/:templateId/apply",
        uuidParams("id", "profileId", "templateId"),
        requireIdempotencyKey(),
        readCampaignRetryOf(),
        validate("json", applySceneTemplateSchema),
        async (c) => {
          const appUser = brandScope(c);
          const { id, profileId, templateId } = c.req.valid("param");
          const result = await deps.campaignOperations.applySceneTemplate(
            {
              ...appUser,
              projectId: id,
              idempotencyKey: getIdempotencyKey(c),
              retryOfId: c.get("campaignRetryOf"),
            },
            profileId,
            templateId,
            c.req.valid("json"),
          );
          return c.json(result, 200);
        },
      )

      // --- Caption styles (brand templates) ---------------------------------
      .get("/brand-templates", async (c) => c.json(await deps.templates.list(brandScope(c)), 200))

      .post(
        "/brand-templates/logo/presign",
        validate("json", presignBrandLogoSchema),
        async (c) =>
          c.json(await deps.templates.presignLogoUpload(brandScope(c), c.req.valid("json")), 200),
      )

      .get("/brand-templates/:id", uuidParams("id"), async (c) =>
        c.json(await deps.templates.get(brandScope(c), c.req.valid("param").id), 200),
      )

      .get("/brand-templates/:id/profile", uuidParams("id"), async (c) =>
        c.json(await readBrandTemplateProfile(deps, brandScope(c), c.req.valid("param").id), 200),
      )

      .get("/brand-templates/:id/editor-assets", uuidParams("id"), async (c) =>
        c.json(
          await readBrandTemplateEditorAssets(deps, brandScope(c), c.req.valid("param").id),
          200,
        ),
      )

      .get("/brand-templates/:id/logo-url", uuidParams("id"), async (c) => {
        const url = await deps.templates.getLogoDownloadUrl(brandScope(c), c.req.valid("param").id);
        if (!url) return c.json({ error: "brand_template_logo_missing" }, 404);
        return c.json({ url }, 200);
      })

      .post(
        "/brand-templates",
        requireIdempotencyKey(),
        validate("json", brandTemplateInputSchema),
        async (c) =>
          c.json(await deps.templates.create(brandScope(c), c.req.valid("json"), receiptOf(c)), 201),
      )

      .patch(
        "/brand-templates/:id",
        uuidParams("id"),
        validate("json", brandTemplateUpdateSchema),
        async (c) =>
          c.json(
            await deps.templates.update(brandScope(c), c.req.valid("param").id, c.req.valid("json")),
            200,
          ),
      )

      .delete("/brand-templates/:id", uuidParams("id"), async (c) => {
        await deps.templates.softDelete(brandScope(c), c.req.valid("param").id);
        return c.json({ ok: true }, 200);
      })

      .post("/brand-templates/:id/set-default", uuidParams("id"), async (c) => {
        await deps.templates.setDefault(brandScope(c), c.req.valid("param").id);
        return c.json({ ok: true }, 200);
      })

      .post(
        "/brand-templates/:id/duplicate",
        uuidParams("id"),
        requireIdempotencyKey(),
        validate("json", duplicateBrandTemplateSchema),
        async (c) =>
          c.json(
            await deps.templates.duplicate(
              brandScope(c),
              c.req.valid("param").id,
              c.req.valid("json").name,
              receiptOf(c),
            ),
            201,
          ),
      )

      // --- Visual assets (direct-to-storage uploads) ------------------------
      .get("/visual-assets", async (c) =>
        c.json({ assets: await deps.visualAssets.list(brandScope(c)) }, 200),
      )

      .post(
        "/visual-assets/presign-upload",
        validate("json", visualAssetUploadSchema),
        async (c) =>
          c.json(await deps.visualAssets.presignUpload(brandScope(c), c.req.valid("json")), 200),
      )

      .post("/visual-assets", validate("json", visualAssetFinalizeSchema), async (c) =>
        c.json(await deps.visualAssets.finalizeUpload(brandScope(c), c.req.valid("json")), 201),
      )

      .delete(
        "/visual-assets/:id",
        uuidParams("id"),
        validate("json", reusableAssetSoftDeleteSchema),
        async (c) => {
          await deps.visualAssets.softDelete(brandScope(c), c.req.valid("param").id, c.req.valid("json"));
          return c.json({ ok: true }, 200);
        },
      )

      // --- Fonts ------------------------------------------------------------
      .get("/brand-fonts", async (c) => c.json({ fonts: await deps.fonts.list(brandScope(c)) }, 200))

      .post("/brand-fonts/presign-upload", validate("json", brandFontUploadSchema), async (c) =>
        c.json(await deps.fonts.presignUpload(brandScope(c), c.req.valid("json")), 200),
      )

      .post("/brand-fonts", validate("json", brandFontFinalizeSchema), async (c) =>
        c.json(await deps.fonts.finalizeUpload(brandScope(c), c.req.valid("json")), 201),
      )

      .delete(
        "/brand-fonts/:id",
        uuidParams("id"),
        validate("json", reusableAssetSoftDeleteSchema),
        async (c) => {
          await deps.fonts.softDelete(brandScope(c), c.req.valid("param").id, c.req.valid("json"));
          return c.json({ ok: true }, 200);
        },
      )

      // --- Music/SFX library: paginated metadata; uploads are verified before
      // finalizing and playback is signed on demand. ------------------------
      .get("/audio-assets", validate("query", listAudioAssetsQuerySchema), async (c) => {
        const { ownerUserId, actor } = audioScope(c);
        return c.json(await deps.audioAssets.listAssets(ownerUserId, c.req.valid("query"), actor), 200);
      })

      .post("/audio-assets/presign-upload", validate("json", presignAudioUploadSchema), async (c) => {
        const { ownerUserId, actor } = audioScope(c);
        return c.json(await deps.audioAssets.presignUpload(ownerUserId, c.req.valid("json"), actor), 200);
      })

      .post("/audio-assets", validate("json", finalizeAudioUploadSchema), async (c) => {
        const { ownerUserId, actor } = audioScope(c);
        return c.json(await deps.audioAssets.finalizeUpload(ownerUserId, c.req.valid("json"), actor), 201);
      })

      .get("/audio-assets/:id/playback-url", async (c) => {
        // The id must be a UUID before it reaches Prisma, so a malformed one is a
        // clean expected refusal and not a raw driver error.
        const id = audioAssetIdParamSchema.safeParse(c.req.param("id"));
        if (!id.success) return c.json(INVALID_AUDIO_ASSET_ID, 400);
        const { ownerUserId, actor } = audioScope(c);
        const source = await deps.audioAssets.getPlaybackSource(ownerUserId, id.data, actor);
        if (!source) return c.json({ error: "audio_asset_not_found" }, 404);
        return c.json(source, 200);
      })

      .put("/audio-assets/:id/favorite", async (c) => {
        const id = audioAssetIdParamSchema.safeParse(c.req.param("id"));
        if (!id.success) return c.json(INVALID_AUDIO_ASSET_ID, 400);
        const { ownerUserId, actor } = audioScope(c);
        return c.json(await deps.audioAssets.setFavorite(ownerUserId, id.data, true, actor), 200);
      })

      .delete("/audio-assets/:id/favorite", async (c) => {
        const id = audioAssetIdParamSchema.safeParse(c.req.param("id"));
        if (!id.success) return c.json(INVALID_AUDIO_ASSET_ID, 400);
        const { ownerUserId, actor } = audioScope(c);
        return c.json(await deps.audioAssets.setFavorite(ownerUserId, id.data, false, actor), 200);
      })

      .delete("/audio-assets/:id", async (c) => {
        const id = audioAssetIdParamSchema.safeParse(c.req.param("id"));
        if (!id.success) return c.json(INVALID_AUDIO_ASSET_ID, 400);
        const { ownerUserId, actor } = audioScope(c);
        await deps.audioAssets.deleteUserAsset(ownerUserId, id.data, actor);
        return c.json({ ok: true }, 200);
      })

      // --- Generated media: acceptance is the service's own idempotent job
      // (the body's `idempotencyKey`); the route adds no second layer. -------
      .get(
        "/projects/:projectId/generated-media/jobs",
        uuidParams("projectId"),
        validate("query", generatedMediaJobsQuerySchema),
        async (c) => {
          const { projectId } = c.req.valid("param");
          const scope = brandScope(c);
          const [jobs, usage] = await Promise.all([
            deps.generatedMedia.list(scope, projectId, c.req.valid("query").clipId),
            deps.generatedMedia.usageSummary(scope),
          ]);
          return c.json({ jobs, usage }, 200);
        },
      )

      .post(
        "/projects/:projectId/generated-media/jobs",
        uuidParams("projectId"),
        validate("json", createGeneratedImageSchema),
        async (c) => {
          const input = c.req.valid("json");
          if (input.projectId !== c.req.valid("param").projectId) {
            throw new GeneratedMediaJobError("generated_media_origin_not_found");
          }
          return c.json(await deps.generatedMedia.create(brandScope(c), input), 202);
        },
      )

      .get(
        "/projects/:projectId/generated-media/jobs/:id",
        uuidParams("projectId", "id"),
        async (c) => {
          const { projectId, id } = c.req.valid("param");
          return c.json(await deps.generatedMedia.get(brandScope(c), id, projectId), 200);
        },
      )

      .post(
        "/projects/:projectId/generated-media/jobs/:id/cancel",
        uuidParams("projectId", "id"),
        async (c) => {
          const { projectId, id } = c.req.valid("param");
          return c.json(await deps.generatedMedia.cancel(brandScope(c), id, projectId), 200);
        },
      )

      .delete(
        "/projects/:projectId/generated-media/jobs/:id/result",
        uuidParams("projectId", "id"),
        async (c) => {
          const { projectId, id } = c.req.valid("param");
          await deps.generatedMedia.deleteResult(brandScope(c), id, projectId);
          return c.json({ ok: true }, 200);
        },
      )
  );
}

export type BrandRoutes = ReturnType<typeof createBrandRoutes>;
