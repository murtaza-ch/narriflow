import { Hono, type Context } from "hono";
import {
  brandFontFinalizeSchema,
  brandFontUploadSchema,
  brandProfileCreateSchema,
  brandProfileMembershipSchema,
  brandProfileSoftDeleteSchema,
  brandProfileUpdateSchema,
  reusableAssetSoftDeleteSchema,
  visualAssetFinalizeSchema,
  visualAssetUploadSchema,
} from "@narriflow/validators";
import {
  assertProgramWriteEnabled,
  brandFontService,
  brandProfileService,
  BrandProfileConflictError,
  BrandProfileNotFoundError,
  ProgramWriteDisabledError,
  visualAssetService,
  type BrandActorScope,
} from "@narriflow/services";

interface BrandProfileRouteDependencies {
  getActor(context: Context): BrandActorScope;
}

function uuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function failure(error: unknown, fallback: string) {
  if (error instanceof BrandProfileNotFoundError) return { status: 404 as const, body: { error: error.code } };
  if (error instanceof BrandProfileConflictError) return { status: 409 as const, body: { error: error.code, message: error.message } };
  if (error instanceof ProgramWriteDisabledError) return { status: 503 as const, body: { error: error.code, message: error.message } };
  const code = typeof error === "object" && error && "code" in error && typeof error.code === "string" ? error.code : fallback;
  return { status: 400 as const, body: { error: code, message: "The brand library request could not be completed." } };
}

export function createBrandProfileRoutes(dependencies: BrandProfileRouteDependencies) {
  const app = new Hono();

  app.get("/brand-profiles", async (c) => {
    try {
      return c.json({ profiles: await brandProfileService.list(dependencies.getActor(c), {
        limit: Number(c.req.query("limit") ?? 24),
        query: c.req.query("query") || undefined,
        includeDeleted: false,
      }) }, 200);
    } catch (error) {
      const result = failure(error, "brand_profile_list_failed");
      return c.json(result.body, result.status);
    }
  });

  app.get("/brand-profiles/:id", async (c) => {
    if (!uuid(c.req.param("id"))) return c.json({ error: "invalid_brand_profile_id" }, 400);
    try {
      return c.json(await brandProfileService.get(dependencies.getActor(c), c.req.param("id")), 200);
    } catch (error) {
      const result = failure(error, "brand_profile_read_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/brand-profiles", async (c) => {
    const parsed = brandProfileCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
    try {
      assertProgramWriteEnabled("brand_profiles");
      return c.json(await brandProfileService.create(dependencies.getActor(c), parsed.data), 201);
    } catch (error) {
      const result = failure(error, "brand_profile_create_failed");
      return c.json(result.body, result.status);
    }
  });

  app.patch("/brand-profiles/:id", async (c) => {
    const parsed = brandProfileUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!uuid(c.req.param("id")) || !parsed.success) return c.json({ error: "invalid_input", issues: parsed.success ? [] : parsed.error.issues }, 400);
    try {
      assertProgramWriteEnabled("brand_profiles");
      return c.json(await brandProfileService.update(dependencies.getActor(c), c.req.param("id"), parsed.data), 200);
    } catch (error) {
      const result = failure(error, "brand_profile_update_failed");
      return c.json(result.body, result.status);
    }
  });

  app.put("/brand-profiles/:id/membership", async (c) => {
    const parsed = brandProfileMembershipSchema.safeParse(await c.req.json().catch(() => null));
    if (!uuid(c.req.param("id")) || !parsed.success) return c.json({ error: "invalid_input", issues: parsed.success ? [] : parsed.error.issues }, 400);
    try {
      assertProgramWriteEnabled(parsed.data.kind === "font" ? "brand_fonts" : "brand_profiles");
      return c.json(await brandProfileService.setMembership(dependencies.getActor(c), c.req.param("id"), parsed.data), 200);
    } catch (error) {
      const result = failure(error, "brand_profile_membership_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/brand-profiles/:id/set-default", async (c) => {
    if (!uuid(c.req.param("id"))) return c.json({ error: "invalid_brand_profile_id" }, 400);
    try {
      assertProgramWriteEnabled("brand_profiles");
      await brandProfileService.setDefault(dependencies.getActor(c), c.req.param("id"));
      return c.json({ ok: true }, 200);
    } catch (error) {
      const result = failure(error, "brand_profile_default_failed");
      return c.json(result.body, result.status);
    }
  });

  app.delete("/brand-profiles/:id", async (c) => {
    const parsed = brandProfileSoftDeleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!uuid(c.req.param("id")) || !parsed.success) return c.json({ error: "invalid_input", issues: parsed.success ? [] : parsed.error.issues }, 400);
    try {
      assertProgramWriteEnabled("brand_profiles");
      await brandProfileService.softDelete(dependencies.getActor(c), c.req.param("id"), parsed.data);
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
    const parsed = visualAssetUploadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
    try {
      assertProgramWriteEnabled("visual_assets");
      return c.json(await visualAssetService.presignUpload(dependencies.getActor(c), parsed.data), 200);
    } catch (error) {
      const result = failure(error, "visual_asset_presign_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/visual-assets", async (c) => {
    const parsed = visualAssetFinalizeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
    try {
      assertProgramWriteEnabled("visual_assets");
      return c.json(await visualAssetService.finalizeUpload(dependencies.getActor(c), parsed.data), 201);
    } catch (error) {
      const result = failure(error, "visual_asset_finalize_failed");
      return c.json(result.body, result.status);
    }
  });

  app.delete("/visual-assets/:id", async (c) => {
    const parsed = reusableAssetSoftDeleteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!uuid(c.req.param("id")) || !parsed.success) return c.json({ error: "invalid_input" }, 400);
    try {
      assertProgramWriteEnabled("visual_assets");
      await visualAssetService.softDelete(dependencies.getActor(c), c.req.param("id"), parsed.data);
      return c.json({ ok: true }, 200);
    } catch (error) {
      const result = failure(error, "visual_asset_delete_failed");
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
    const parsed = brandFontUploadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
    try {
      assertProgramWriteEnabled("brand_fonts");
      return c.json(await brandFontService.presignUpload(dependencies.getActor(c), parsed.data), 200);
    } catch (error) {
      const result = failure(error, "brand_font_presign_failed");
      return c.json(result.body, result.status);
    }
  });

  app.post("/brand-fonts", async (c) => {
    const parsed = brandFontFinalizeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_input", issues: parsed.error.issues }, 400);
    try {
      assertProgramWriteEnabled("brand_fonts");
      return c.json(await brandFontService.finalizeUpload(dependencies.getActor(c), parsed.data), 201);
    } catch (error) {
      const result = failure(error, "brand_font_finalize_failed");
      return c.json(result.body, result.status);
    }
  });

  app.delete("/brand-fonts/:id", async (c) => {
    const parsed = reusableAssetSoftDeleteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!uuid(c.req.param("id")) || !parsed.success) return c.json({ error: "invalid_input" }, 400);
    try {
      assertProgramWriteEnabled("brand_fonts");
      await brandFontService.softDelete(dependencies.getActor(c), c.req.param("id"), parsed.data);
      return c.json({ ok: true }, 200);
    } catch (error) {
      const result = failure(error, "brand_font_delete_failed");
      return c.json(result.body, result.status);
    }
  });

  return app;
}
