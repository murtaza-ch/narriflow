import { Hono, type Context } from "hono";
import type {
  BrandFontFinalizeInput,
  BrandFontUploadInput,
  BrandProfileCreateInput,
  BrandProfileMembershipInput,
  BrandProfileSoftDeleteInput,
  BrandProfileUpdateInput,
  ReusableAssetSoftDeleteInput,
  VisualAssetFinalizeInput,
  VisualAssetUploadInput,
  SceneTemplateCreateInput,
  SceneTemplateDeleteInput,
  SceneTemplateUpdateInput,
} from "@narriflow/validators";
import {
  createGeneratedImageSchema,
  generatedMediaJobIdSchema,
  listGeneratedMediaJobsSchema,
} from "@narriflow/validators";
import {
  assertProgramWriteEnabled,
  brandFontService,
  brandProfileService,
  BrandProfileConflictError,
  BrandProfileNotFoundError,
  ProgramWriteDisabledError,
  visualAssetService,
  VisualAssetReferenceError,
  sceneTemplateService,
  SceneTemplateError,
  type BrandActorScope,
  generatedMediaService,
  GeneratedMediaJobError,
  GeneratedMediaProviderError,
} from "@narriflow/services";
import { authenticatedHonoInput } from "@/lib/authenticated-request-hono";

interface BrandProfileRouteDependencies {
  getActor(context: Context): BrandActorScope;
}

function failure(error: unknown, fallback: string) {
  if (error instanceof GeneratedMediaJobError) {
    const status = error.code === "generated_media_job_not_found"
      ? 404 as const
      : error.code === "generated_media_idempotency_conflict"
        ? 409 as const
        : error.code === "generated_media_entitlement_required" || error.code === "generated_media_forbidden"
          ? 403 as const
          : error.code === "generated_media_daily_limit_reached" || error.code === "generated_media_trial_limit_reached" || error.code === "generated_media_concurrency_limit_reached"
            ? 429 as const
            : 400 as const;
    return { status, body: { error: error.code, message: error.message } };
  }
  if (error instanceof GeneratedMediaProviderError) {
    return { status: 503 as const, body: { error: error.code, message: "Image generation is temporarily unavailable." } };
  }
  if (error instanceof VisualAssetReferenceError) {
    return { status: 409 as const, body: { error: error.code, message: error.message } };
  }
  if (error instanceof BrandProfileNotFoundError) return { status: 404 as const, body: { error: error.code } };
  if (error instanceof BrandProfileConflictError) return { status: 409 as const, body: { error: error.code, message: error.message } };
  if (error instanceof ProgramWriteDisabledError) return { status: 503 as const, body: { error: error.code, message: error.message } };
  if (error instanceof SceneTemplateError) {
    const status = error.code === "scene_template_revision_conflict"
      ? 409 as const
      : error.code === "scene_template_not_found" || error.code === "scene_template_profile_not_found" || error.code === "brand_profile_not_found"
        ? 404 as const
        : 400 as const;
    return { status, body: { error: error.code, message: error.message } };
  }
  const code = typeof error === "object" && error && "code" in error && typeof error.code === "string" ? error.code : fallback;
  return { status: 400 as const, body: { error: code, message: "The brand library request could not be completed." } };
}

export function createBrandProfileRoutes(dependencies: BrandProfileRouteDependencies) {
  const app = new Hono();

  app.get("/brand-profiles", async (c) => {
    const input = authenticatedHonoInput<{ limit?: number; query?: string }>(c);
    try {
      return c.json({ profiles: await brandProfileService.list(dependencies.getActor(c), {
        limit: input.limit ?? 24,
        query: input.query,
        includeDeleted: false,
      }) }, 200);
    } catch (error) {
      const result = failure(error, "brand_profile_list_failed");
      return c.json(result.body, result.status);
    }
  });

  app.get("/brand-profiles/:id", async (c) => {
    const { id } = authenticatedHonoInput<{ id: string }>(c);
    try {
      return c.json(await brandProfileService.get(dependencies.getActor(c), id), 200);
    } catch (error) {
      const result = failure(error, "brand_profile_read_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/brand-profiles", async (c) => {
    const { body } = authenticatedHonoInput<{ body: BrandProfileCreateInput }>(c);
    try {
      assertProgramWriteEnabled("brand_profiles");
      return c.json(await brandProfileService.create(dependencies.getActor(c), body), 201);
    } catch (error) {
      const result = failure(error, "brand_profile_create_failed");
      return c.json(result.body, result.status);
    }
  });

  app.patch("/brand-profiles/:id", async (c) => {
    const { id, body } = authenticatedHonoInput<{ id: string; body: BrandProfileUpdateInput }>(c);
    try {
      assertProgramWriteEnabled("brand_profiles");
      return c.json(await brandProfileService.update(dependencies.getActor(c), id, body), 200);
    } catch (error) {
      const result = failure(error, "brand_profile_update_failed");
      return c.json(result.body, result.status);
    }
  });

  app.put("/brand-profiles/:id/membership", async (c) => {
    const { id, body } = authenticatedHonoInput<{ id: string; body: BrandProfileMembershipInput }>(c);
    try {
      assertProgramWriteEnabled(body.kind === "font" ? "brand_fonts" : "brand_profiles");
      return c.json(await brandProfileService.setMembership(dependencies.getActor(c), id, body), 200);
    } catch (error) {
      const result = failure(error, "brand_profile_membership_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/brand-profiles/:id/set-default", async (c) => {
    const { id } = authenticatedHonoInput<{ id: string }>(c);
    try {
      assertProgramWriteEnabled("brand_profiles");
      await brandProfileService.setDefault(dependencies.getActor(c), id);
      return c.json({ ok: true }, 200);
    } catch (error) {
      const result = failure(error, "brand_profile_default_failed");
      return c.json(result.body, result.status);
    }
  });

  app.delete("/brand-profiles/:id", async (c) => {
    const { id, body } = authenticatedHonoInput<{ id: string; body: BrandProfileSoftDeleteInput }>(c);
    try {
      assertProgramWriteEnabled("brand_profiles");
      await brandProfileService.softDelete(dependencies.getActor(c), id, body);
      return c.json({ ok: true }, 200);
    } catch (error) {
      const result = failure(error, "brand_profile_delete_failed");
      return c.json(result.body, result.status);
    }
  });

  app.get("/visual-assets", async (c) => {
    try {
      return c.json({ assets: await visualAssetService.list(dependencies.getActor(c)) }, 200);
    } catch (error) {
      const result = failure(error, "visual_asset_list_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/visual-assets/presign-upload", async (c) => {
    const { body } = authenticatedHonoInput<{ body: VisualAssetUploadInput }>(c);
    try {
      assertProgramWriteEnabled("visual_assets");
      return c.json(await visualAssetService.presignUpload(dependencies.getActor(c), body), 200);
    } catch (error) {
      const result = failure(error, "visual_asset_presign_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/visual-assets", async (c) => {
    const { body } = authenticatedHonoInput<{ body: VisualAssetFinalizeInput }>(c);
    try {
      assertProgramWriteEnabled("visual_assets");
      return c.json(await visualAssetService.finalizeUpload(dependencies.getActor(c), body), 201);
    } catch (error) {
      const result = failure(error, "visual_asset_finalize_failed");
      return c.json(result.body, result.status);
    }
  });

  app.delete("/visual-assets/:id", async (c) => {
    const { id, body } = authenticatedHonoInput<{ id: string; body: ReusableAssetSoftDeleteInput }>(c);
    try {
      assertProgramWriteEnabled("visual_assets");
      await visualAssetService.softDelete(dependencies.getActor(c), id, body);
      return c.json({ ok: true }, 200);
    } catch (error) {
      const result = failure(error, "visual_asset_delete_failed");
      return c.json(result.body, result.status);
    }
  });

  app.get("/projects/:projectId/generated-media/jobs", async (c) => {
    try {
      const input = authenticatedHonoInput<{
        projectId: string;
        clipId?: string;
      }>(c);
      const query = listGeneratedMediaJobsSchema.parse(input);
      const actor = dependencies.getActor(c);
      const [jobs, usage] = await Promise.all([
        generatedMediaService.list(actor, input.projectId, query.clipId),
        generatedMediaService.usageSummary(actor),
      ]);
      return c.json({ jobs, usage }, 200);
    } catch (error) {
      const result = failure(error, "generated_media_list_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/projects/:projectId/generated-media/jobs", async (c) => {
    const { projectId, body } = authenticatedHonoInput<{ projectId: string; body: unknown }>(c);
    try {
      assertProgramWriteEnabled("generated_media");
      const input = createGeneratedImageSchema.parse(body);
      if (input.projectId !== projectId) throw new GeneratedMediaJobError("generated_media_origin_not_found");
      return c.json(await generatedMediaService.create(dependencies.getActor(c), input), 202);
    } catch (error) {
      const result = failure(error, "generated_media_create_failed");
      return c.json(result.body, result.status);
    }
  });

  app.get("/projects/:projectId/generated-media/jobs/:id", async (c) => {
    const { projectId, id } = authenticatedHonoInput<{ projectId: string; id: string }>(c);
    try {
      return c.json(await generatedMediaService.get(dependencies.getActor(c), generatedMediaJobIdSchema.parse(id), projectId), 200);
    } catch (error) {
      const result = failure(error, "generated_media_read_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/projects/:projectId/generated-media/jobs/:id/cancel", async (c) => {
    const { projectId, id } = authenticatedHonoInput<{ projectId: string; id: string }>(c);
    try {
      return c.json(await generatedMediaService.cancel(dependencies.getActor(c), generatedMediaJobIdSchema.parse(id), projectId), 200);
    } catch (error) {
      const result = failure(error, "generated_media_cancel_failed");
      return c.json(result.body, result.status);
    }
  });

  app.delete("/projects/:projectId/generated-media/jobs/:id/result", async (c) => {
    const { projectId, id } = authenticatedHonoInput<{ projectId: string; id: string }>(c);
    try {
      await generatedMediaService.deleteResult(dependencies.getActor(c), generatedMediaJobIdSchema.parse(id), projectId);
      return c.json({ ok: true }, 200);
    } catch (error) {
      const result = failure(error, "generated_media_delete_failed");
      return c.json(result.body, result.status);
    }
  });

  app.get("/brand-profiles/:id/scene-templates", async (c) => {
    const { id } = authenticatedHonoInput<{ id: string }>(c);
    try {
      return c.json({ scenes: await sceneTemplateService.list(dependencies.getActor(c), id) }, 200);
    } catch (error) {
      const result = failure(error, "scene_template_list_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/brand-profiles/:id/scene-templates", async (c) => {
    const { id, body } = authenticatedHonoInput<{ id: string; body: SceneTemplateCreateInput }>(c);
    try {
      assertProgramWriteEnabled("brand_profiles");
      return c.json(await sceneTemplateService.create(dependencies.getActor(c), id, body), 201);
    } catch (error) {
      const result = failure(error, "scene_template_create_failed");
      return c.json(result.body, result.status);
    }
  });

  app.patch("/brand-profiles/:id/scene-templates/:templateId", async (c) => {
    const { id, templateId, body } = authenticatedHonoInput<{ id: string; templateId: string; body: SceneTemplateUpdateInput }>(c);
    try {
      assertProgramWriteEnabled("brand_profiles");
      return c.json(await sceneTemplateService.update(dependencies.getActor(c), id, templateId, body), 200);
    } catch (error) {
      const result = failure(error, "scene_template_update_failed");
      return c.json(result.body, result.status);
    }
  });

  app.delete("/brand-profiles/:id/scene-templates/:templateId", async (c) => {
    const { id, templateId, body } = authenticatedHonoInput<{ id: string; templateId: string; body: SceneTemplateDeleteInput }>(c);
    try {
      assertProgramWriteEnabled("brand_profiles");
      return c.json(await sceneTemplateService.softDelete(dependencies.getActor(c), id, templateId, body), 200);
    } catch (error) {
      const result = failure(error, "scene_template_delete_failed");
      return c.json(result.body, result.status);
    }
  });

  app.get("/brand-fonts", async (c) => {
    try {
      return c.json({ fonts: await brandFontService.list(dependencies.getActor(c)) }, 200);
    } catch (error) {
      const result = failure(error, "brand_font_list_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/brand-fonts/presign-upload", async (c) => {
    const { body } = authenticatedHonoInput<{ body: BrandFontUploadInput }>(c);
    try {
      assertProgramWriteEnabled("brand_fonts");
      return c.json(await brandFontService.presignUpload(dependencies.getActor(c), body), 200);
    } catch (error) {
      const result = failure(error, "brand_font_presign_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/brand-fonts", async (c) => {
    const { body } = authenticatedHonoInput<{ body: BrandFontFinalizeInput }>(c);
    try {
      assertProgramWriteEnabled("brand_fonts");
      return c.json(await brandFontService.finalizeUpload(dependencies.getActor(c), body), 201);
    } catch (error) {
      const result = failure(error, "brand_font_finalize_failed");
      return c.json(result.body, result.status);
    }
  });

  app.delete("/brand-fonts/:id", async (c) => {
    const { id, body } = authenticatedHonoInput<{ id: string; body: ReusableAssetSoftDeleteInput }>(c);
    try {
      assertProgramWriteEnabled("brand_fonts");
      await brandFontService.softDelete(dependencies.getActor(c), id, body);
      return c.json({ ok: true }, 200);
    } catch (error) {
      const result = failure(error, "brand_font_delete_failed");
      return c.json(result.body, result.status);
    }
  });

  return app;
}
