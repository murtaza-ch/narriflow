import {
  audioAssetService,
  brandTemplateService,
  campaignOperationService,
} from "@narriflow/services";
import {
  applySceneTemplateSchema,
  audioAssetIdParamSchema,
  brandTemplateInputSchema,
  brandTemplateUpdateSchema,
  duplicateBrandTemplateSchema,
  finalizeAudioUploadSchema,
  listAudioAssetsQuerySchema,
  presignAudioUploadSchema,
  presignBrandLogoSchema,
} from "@narriflow/validators";
import { Hono } from "hono";
import type { Context } from "hono";
import { admit, getActor } from "../../http/admission";
import type { ApiEnv } from "../../http/env";
import {
  getIdempotencyKey,
  readCampaignRetryOf,
  requireIdempotencyKey,
} from "../../http/idempotency";
import { validate } from "../../http/route";
import { uuidParams } from "../platform/params";
import { brandAdmission as access } from "./admission";

/** Services the brand routes call. `runtime.ts` supplies the production instances. */
export interface BrandRouteDeps {
  audioAssetService: typeof audioAssetService;
  brandTemplateService: typeof brandTemplateService;
  campaignOperationService: typeof campaignOperationService;
}

const INVALID_AUDIO_ASSET_ID = {
  error: "invalid_audio_asset_id",
  message: "Invalid audio asset id",
} as const;

/** Brand templates, the Music/SFX library and applying a scene template to a Project's clips. */
export function createBrandRoutes(deps: BrandRouteDeps) {
  const { audioAssetService, brandTemplateService, campaignOperationService } = deps;

  function audioScope(c: Context<ApiEnv>) {
    const appUser = getActor(c);
    return {
      ownerUserId: appUser.workspaceOwnerUserId,
      actor: { workspaceId: appUser.workspaceId, actorUserId: appUser.actorUserId },
    };
  }

  return new Hono<ApiEnv>()
    .post(
      "/projects/:id/brand-profiles/:profileId/scene-templates/:templateId/apply",
      admit(access["POST /projects/:id/brand-profiles/:profileId/scene-templates/:templateId/apply"]),
      uuidParams("id", "profileId", "templateId"),
      requireIdempotencyKey(),
      readCampaignRetryOf(),
      validate("json", applySceneTemplateSchema),
      async (c) => {
        const appUser = getActor(c);
        const { id, profileId, templateId } = c.req.valid("param");
        const result = await campaignOperationService.applySceneTemplate(
          {
            actorUserId: appUser.actorUserId,
            workspaceId: appUser.workspaceId,
            workspaceOwnerUserId: appUser.workspaceOwnerUserId,
            role: appUser.role,
            status: appUser.status,
            pricingTier: appUser.pricingTier,
            isPersonalWorkspace: appUser.isPersonalWorkspace,
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

    .get("/brand-templates", admit(access["GET /brand-templates"]), async (c) => {
      return c.json(await brandTemplateService.list(getActor(c)), 200);
    })

    .get("/brand-templates/:id", admit(access["GET /brand-templates/:id"]), async (c) => {
      return c.json(await brandTemplateService.get(getActor(c), c.req.param("id")), 200);
    })

    .post(
      "/brand-templates",
      admit(access["POST /brand-templates"]),
      validate("json", brandTemplateInputSchema),
      async (c) => {
        const template = await brandTemplateService.create(getActor(c), c.req.valid("json"));
        return c.json(template, 201);
      },
    )

    .patch(
      "/brand-templates/:id",
      admit(access["PATCH /brand-templates/:id"]),
      validate("json", brandTemplateUpdateSchema),
      async (c) => {
        const template = await brandTemplateService.update(
          getActor(c),
          c.req.param("id"),
          c.req.valid("json"),
        );
        return c.json(template, 200);
      },
    )

    .delete("/brand-templates/:id", admit(access["DELETE /brand-templates/:id"]), async (c) => {
      await brandTemplateService.softDelete(getActor(c), c.req.param("id"));
      return c.json({ ok: true }, 200);
    })

    .post(
      "/brand-templates/:id/set-default",
      admit(access["POST /brand-templates/:id/set-default"]),
      async (c) => {
        await brandTemplateService.setDefault(getActor(c), c.req.param("id"));
        return c.json({ ok: true }, 200);
      },
    )

    .post(
      "/brand-templates/:id/duplicate",
      admit(access["POST /brand-templates/:id/duplicate"]),
      validate("json", duplicateBrandTemplateSchema),
      async (c) => {
        const template = await brandTemplateService.duplicate(
          getActor(c),
          c.req.param("id"),
          c.req.valid("json").name,
        );
        return c.json(template, 201);
      },
    )

    .post(
      "/brand-templates/logo/presign",
      admit(access["POST /brand-templates/logo/presign"]),
      validate("json", presignBrandLogoSchema),
      async (c) => {
        const result = await brandTemplateService.presignLogoUpload(getActor(c), c.req.valid("json"));
        return c.json(result, 200);
      },
    )

    .get(
      "/brand-templates/:id/logo-url",
      admit(access["GET /brand-templates/:id/logo-url"]),
      async (c) => {
        const url = await brandTemplateService.getLogoDownloadUrl(getActor(c), c.req.param("id"));
        if (!url) return c.json({ error: "brand_template_logo_missing" }, 404);
        return c.json({ url }, 200);
      },
    )

    // Music/SFX library: paginated metadata; uploads are verified before
    // finalizing and playback is signed on demand.
    .get(
      "/audio-assets",
      admit(access["GET /audio-assets"]),
      validate("query", listAudioAssetsQuerySchema),
      async (c) => {
        const { ownerUserId, actor } = audioScope(c);
        return c.json(await audioAssetService.listAssets(ownerUserId, c.req.valid("query"), actor), 200);
      },
    )

    .post(
      "/audio-assets/presign-upload",
      admit(access["POST /audio-assets/presign-upload"]),
      validate("json", presignAudioUploadSchema),
      async (c) => {
        const { ownerUserId, actor } = audioScope(c);
        return c.json(await audioAssetService.presignUpload(ownerUserId, c.req.valid("json"), actor), 200);
      },
    )

    .post(
      "/audio-assets",
      admit(access["POST /audio-assets"]),
      validate("json", finalizeAudioUploadSchema),
      async (c) => {
        const { ownerUserId, actor } = audioScope(c);
        return c.json(await audioAssetService.finalizeUpload(ownerUserId, c.req.valid("json"), actor), 201);
      },
    )

    .get(
      "/audio-assets/:id/playback-url",
      admit(access["GET /audio-assets/:id/playback-url"]),
      async (c) => {
        // Validate the path param is a UUID before it reaches Prisma, so a
        // malformed id is a clean expected refusal and not a raw driver error.
        const id = audioAssetIdParamSchema.safeParse(c.req.param("id"));
        if (!id.success) return c.json(INVALID_AUDIO_ASSET_ID, 400);
        const { ownerUserId, actor } = audioScope(c);
        const source = await audioAssetService.getPlaybackSource(ownerUserId, id.data, actor);
        if (!source) return c.json({ error: "audio_asset_not_found" }, 404);
        return c.json(source, 200);
      },
    )

    .put(
      "/audio-assets/:id/favorite",
      admit(access["PUT /audio-assets/:id/favorite"]),
      async (c) => {
        const id = audioAssetIdParamSchema.safeParse(c.req.param("id"));
        if (!id.success) return c.json(INVALID_AUDIO_ASSET_ID, 400);
        const { ownerUserId, actor } = audioScope(c);
        return c.json(await audioAssetService.setFavorite(ownerUserId, id.data, true, actor), 200);
      },
    )

    .delete(
      "/audio-assets/:id/favorite",
      admit(access["DELETE /audio-assets/:id/favorite"]),
      async (c) => {
        const id = audioAssetIdParamSchema.safeParse(c.req.param("id"));
        if (!id.success) return c.json(INVALID_AUDIO_ASSET_ID, 400);
        const { ownerUserId, actor } = audioScope(c);
        return c.json(await audioAssetService.setFavorite(ownerUserId, id.data, false, actor), 200);
      },
    )

    .delete("/audio-assets/:id", admit(access["DELETE /audio-assets/:id"]), async (c) => {
      const id = audioAssetIdParamSchema.safeParse(c.req.param("id"));
      if (!id.success) return c.json(INVALID_AUDIO_ASSET_ID, 400);
      const { ownerUserId, actor } = audioScope(c);
      await audioAssetService.deleteUserAsset(ownerUserId, id.data, actor);
      return c.json({ ok: true }, 200);
    });
}

export type BrandRoutes = ReturnType<typeof createBrandRoutes>;
