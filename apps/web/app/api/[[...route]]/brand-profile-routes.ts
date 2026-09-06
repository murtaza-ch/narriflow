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
  visualAssetService,
  sceneTemplateService,
  type BrandActorScope,
  generatedMediaService,
  GeneratedMediaJobError,
} from "@narriflow/services";
import { authenticatedHonoInput } from "@/lib/authenticated-request-hono";

interface BrandProfileRouteDependencies {
  getActor(context: Context): BrandActorScope;
}

export function createBrandProfileRoutes(dependencies: BrandProfileRouteDependencies) {
  const app = new Hono();

  app.get("/brand-profiles", async (c) => {
    const input = authenticatedHonoInput<{ limit?: number; query?: string }>(c);
      return c.json({ profiles: await brandProfileService.list(dependencies.getActor(c), {
        limit: input.limit ?? 24,
        query: input.query,
        includeDeleted: false,
      }) }, 200);
  });

  app.get("/brand-profiles/:id", async (c) => {
    const { id } = authenticatedHonoInput<{ id: string }>(c);
      return c.json(await brandProfileService.get(dependencies.getActor(c), id), 200);
  });

  app.post("/brand-profiles", async (c) => {
    const { body } = authenticatedHonoInput<{ body: BrandProfileCreateInput }>(c);
      assertProgramWriteEnabled("brand_profiles");
      return c.json(await brandProfileService.create(dependencies.getActor(c), body), 201);
  });

  app.patch("/brand-profiles/:id", async (c) => {
    const { id, body } = authenticatedHonoInput<{ id: string; body: BrandProfileUpdateInput }>(c);
      assertProgramWriteEnabled("brand_profiles");
      return c.json(await brandProfileService.update(dependencies.getActor(c), id, body), 200);
  });

  app.put("/brand-profiles/:id/membership", async (c) => {
    const { id, body } = authenticatedHonoInput<{ id: string; body: BrandProfileMembershipInput }>(c);
      assertProgramWriteEnabled(body.kind === "font" ? "brand_fonts" : "brand_profiles");
      return c.json(await brandProfileService.setMembership(dependencies.getActor(c), id, body), 200);
  });

  app.post("/brand-profiles/:id/set-default", async (c) => {
    const { id } = authenticatedHonoInput<{ id: string }>(c);
      assertProgramWriteEnabled("brand_profiles");
      await brandProfileService.setDefault(dependencies.getActor(c), id);
      return c.json({ ok: true }, 200);
  });

  app.delete("/brand-profiles/:id", async (c) => {
    const { id, body } = authenticatedHonoInput<{ id: string; body: BrandProfileSoftDeleteInput }>(c);
      assertProgramWriteEnabled("brand_profiles");
      await brandProfileService.softDelete(dependencies.getActor(c), id, body);
      return c.json({ ok: true }, 200);
  });

  app.get("/visual-assets", async (c) => {
      return c.json({ assets: await visualAssetService.list(dependencies.getActor(c)) }, 200);
  });

  app.post("/visual-assets/presign-upload", async (c) => {
    const { body } = authenticatedHonoInput<{ body: VisualAssetUploadInput }>(c);
      assertProgramWriteEnabled("visual_assets");
      return c.json(await visualAssetService.presignUpload(dependencies.getActor(c), body), 200);
  });

  app.post("/visual-assets", async (c) => {
    const { body } = authenticatedHonoInput<{ body: VisualAssetFinalizeInput }>(c);
      assertProgramWriteEnabled("visual_assets");
      return c.json(await visualAssetService.finalizeUpload(dependencies.getActor(c), body), 201);
  });

  app.delete("/visual-assets/:id", async (c) => {
    const { id, body } = authenticatedHonoInput<{ id: string; body: ReusableAssetSoftDeleteInput }>(c);
      assertProgramWriteEnabled("visual_assets");
      await visualAssetService.softDelete(dependencies.getActor(c), id, body);
      return c.json({ ok: true }, 200);
  });

  app.get("/projects/:projectId/generated-media/jobs", async (c) => {
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
  });

  app.post("/projects/:projectId/generated-media/jobs", async (c) => {
    const { projectId, body } = authenticatedHonoInput<{ projectId: string; body: unknown }>(c);
      assertProgramWriteEnabled("generated_media");
      const input = createGeneratedImageSchema.parse(body);
      if (input.projectId !== projectId) throw new GeneratedMediaJobError("generated_media_origin_not_found");
      return c.json(await generatedMediaService.create(dependencies.getActor(c), input), 202);
  });

  app.get("/projects/:projectId/generated-media/jobs/:id", async (c) => {
    const { projectId, id } = authenticatedHonoInput<{ projectId: string; id: string }>(c);
      return c.json(await generatedMediaService.get(dependencies.getActor(c), generatedMediaJobIdSchema.parse(id), projectId), 200);
  });

  app.post("/projects/:projectId/generated-media/jobs/:id/cancel", async (c) => {
    const { projectId, id } = authenticatedHonoInput<{ projectId: string; id: string }>(c);
      return c.json(await generatedMediaService.cancel(dependencies.getActor(c), generatedMediaJobIdSchema.parse(id), projectId), 200);
  });

  app.delete("/projects/:projectId/generated-media/jobs/:id/result", async (c) => {
    const { projectId, id } = authenticatedHonoInput<{ projectId: string; id: string }>(c);
      await generatedMediaService.deleteResult(dependencies.getActor(c), generatedMediaJobIdSchema.parse(id), projectId);
      return c.json({ ok: true }, 200);
  });

  app.get("/brand-profiles/:id/scene-templates", async (c) => {
    const { id } = authenticatedHonoInput<{ id: string }>(c);
      return c.json({ scenes: await sceneTemplateService.list(dependencies.getActor(c), id) }, 200);
  });

  app.post("/brand-profiles/:id/scene-templates", async (c) => {
    const { id, body } = authenticatedHonoInput<{ id: string; body: SceneTemplateCreateInput }>(c);
      assertProgramWriteEnabled("brand_profiles");
      return c.json(await sceneTemplateService.create(dependencies.getActor(c), id, body), 201);
  });

  app.patch("/brand-profiles/:id/scene-templates/:templateId", async (c) => {
    const { id, templateId, body } = authenticatedHonoInput<{ id: string; templateId: string; body: SceneTemplateUpdateInput }>(c);
      assertProgramWriteEnabled("brand_profiles");
      return c.json(await sceneTemplateService.update(dependencies.getActor(c), id, templateId, body), 200);
  });

  app.delete("/brand-profiles/:id/scene-templates/:templateId", async (c) => {
    const { id, templateId, body } = authenticatedHonoInput<{ id: string; templateId: string; body: SceneTemplateDeleteInput }>(c);
      assertProgramWriteEnabled("brand_profiles");
      return c.json(await sceneTemplateService.softDelete(dependencies.getActor(c), id, templateId, body), 200);
  });

  app.get("/brand-fonts", async (c) => {
      return c.json({ fonts: await brandFontService.list(dependencies.getActor(c)) }, 200);
  });

  app.post("/brand-fonts/presign-upload", async (c) => {
    const { body } = authenticatedHonoInput<{ body: BrandFontUploadInput }>(c);
      assertProgramWriteEnabled("brand_fonts");
      return c.json(await brandFontService.presignUpload(dependencies.getActor(c), body), 200);
  });

  app.post("/brand-fonts", async (c) => {
    const { body } = authenticatedHonoInput<{ body: BrandFontFinalizeInput }>(c);
      assertProgramWriteEnabled("brand_fonts");
      return c.json(await brandFontService.finalizeUpload(dependencies.getActor(c), body), 201);
  });

  app.delete("/brand-fonts/:id", async (c) => {
    const { id, body } = authenticatedHonoInput<{ id: string; body: ReusableAssetSoftDeleteInput }>(c);
      assertProgramWriteEnabled("brand_fonts");
      await brandFontService.softDelete(dependencies.getActor(c), id, body);
      return c.json({ ok: true }, 200);
  });

  return app;
}
