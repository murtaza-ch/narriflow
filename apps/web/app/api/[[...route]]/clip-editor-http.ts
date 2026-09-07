import { Hono, type Context } from "hono";
import {
  resetEditorDocumentSchema,
  saveEditorDocumentSchema,
  updateClipBoundariesSchema,
  updateClipBrollSchema,
  updateClipCaptionPresetSchema,
  updateClipStudioEditsSchema,
  updateClipTitleSchema,
  updateClipTranscriptSliceSchema,
} from "@narriflow/validators";
import {
  analyzeSceneDocumentMutation,
  type BrandActorScope,
  type BrandFontService,
  type ClipService,
  type SceneDocumentMutationAnalysis,
  type VisualAssetService,
  clipEditorDocumentPersistence,
} from "@narriflow/services";
import { censorDocumentMutationError } from "@/lib/censor-document-mutation";
import { motionDocumentMutationError } from "@/lib/motion-document-mutation";

export interface ClipEditorHttpDependencies {
  getActor(context: Context): BrandActorScope;
  clip: Pick<
    ClipService,
    "getClipEditorDocument" | "getClipSnapshot" | "updateClipTitle"
  >;
  persistence: Pick<typeof clipEditorDocumentPersistence, "mutateDocument">;
  analyzeSceneMutation: typeof analyzeSceneDocumentMutation;
  visualAssets: Pick<
    VisualAssetService,
    | "assertSceneReferencesWithPolicy"
    | "assertSceneReferences"
    | "assertVisualBrollReferences"
    | "recordGeneratedInsertionsBestEffort"
  >;
  brandFonts: Pick<BrandFontService, "assertSceneReferences">;
}

async function updatedClip(
  dependencies: ClipEditorHttpDependencies,
  actor: BrandActorScope,
  projectId: string,
  clipId: string,
) {
  return dependencies.clip.getClipSnapshot(
    actor.workspaceOwnerUserId,
    projectId,
    clipId,
  );
}

async function validateSceneReferences(
  dependencies: ClipEditorHttpDependencies,
  actor: BrandActorScope,
  projectId: string,
  document: Parameters<typeof analyzeSceneDocumentMutation>[1],
  analysis: SceneDocumentMutationAnalysis,
) {
  await Promise.all([
    dependencies.visualAssets.assertSceneReferencesWithPolicy(
      actor,
      analysis.changedSceneBlocks,
      true,
    ),
    dependencies.visualAssets.assertSceneReferences(
      actor,
      analysis.introducedSceneReferences,
    ),
    dependencies.visualAssets.assertVisualBrollReferences(
      actor,
      document.studioEdits.visualBroll,
    ),
    dependencies.brandFonts.assertSceneReferences(
      actor,
      projectId,
      analysis.changedSceneBlocks,
      { allowDeleted: true, requireActiveProfile: false },
    ),
    dependencies.brandFonts.assertSceneReferences(
      actor,
      projectId,
      analysis.introducedSceneReferences,
      { allowDeleted: false, requireActiveProfile: true },
    ),
  ]);
}

export function createClipEditorHttpRoutes(
  dependencies: ClipEditorHttpDependencies,
) {
  const routes = new Hono();

  routes.patch("/projects/:id/clips/:clipId", async (c) => {
    const actor = dependencies.getActor(c);
    const projectId = c.req.param("id");
    const clipId = c.req.param("clipId");
    const payload = await c.req.json().catch(() => null);

    if (!payload || typeof payload !== "object") {
      return c.json({ error: "invalid_input" }, 400);
    }

    const titleParsed = updateClipTitleSchema.safeParse(payload);
    if (titleParsed.success) {
      return c.json(
        await dependencies.clip.updateClipTitle(
          actor.workspaceOwnerUserId,
          projectId,
          clipId,
          titleParsed.data.title,
        ),
        200,
      );
    }

    const boundariesParsed = updateClipBoundariesSchema.safeParse(payload);
    if (boundariesParsed.success) {
      await dependencies.persistence.mutateDocument({
        actorUserId: actor.actorUserId,
        workspaceId: actor.workspaceId,
        workspaceOwnerUserId: actor.workspaceOwnerUserId,
        projectId,
        clipId,
        intent: { kind: "set_boundaries", ...boundariesParsed.data },
      });
      return c.json(
        await updatedClip(dependencies, actor, projectId, clipId),
        200,
      );
    }

    const captionPresetParsed = updateClipCaptionPresetSchema.safeParse(payload);
    if (captionPresetParsed.success) {
      await dependencies.persistence.mutateDocument({
        actorUserId: actor.actorUserId,
        workspaceId: actor.workspaceId,
        workspaceOwnerUserId: actor.workspaceOwnerUserId,
        projectId,
        clipId,
        intent: {
          kind: "set_caption_preset",
          captionPreset: captionPresetParsed.data.captionPreset,
        },
      });
      return c.json(
        await updatedClip(dependencies, actor, projectId, clipId),
        200,
      );
    }

    const transcriptParsed = updateClipTranscriptSliceSchema.safeParse(payload);
    if (transcriptParsed.success) {
      await dependencies.persistence.mutateDocument({
        actorUserId: actor.actorUserId,
        workspaceId: actor.workspaceId,
        workspaceOwnerUserId: actor.workspaceOwnerUserId,
        projectId,
        clipId,
        intent: {
          kind: "set_transcript",
          transcriptSlice: transcriptParsed.data.transcriptSlice,
        },
      });
      return c.json(
        await updatedClip(dependencies, actor, projectId, clipId),
        200,
      );
    }

    const brollParsed = updateClipBrollSchema.safeParse(payload);
    if (brollParsed.success) {
      await dependencies.persistence.mutateDocument({
        actorUserId: actor.actorUserId,
        workspaceId: actor.workspaceId,
        workspaceOwnerUserId: actor.workspaceOwnerUserId,
        projectId,
        clipId,
        intent: { kind: "set_broll_url", brollUrl: brollParsed.data.brollUrl },
      });
      return c.json(
        await updatedClip(dependencies, actor, projectId, clipId),
        200,
      );
    }

    const studioEditsParsed =
      "studioEdits" in payload
        ? updateClipStudioEditsSchema.safeParse(payload)
        : null;
    if (studioEditsParsed?.success) {
      await dependencies.persistence.mutateDocument({
        actorUserId: actor.actorUserId,
        workspaceId: actor.workspaceId,
        workspaceOwnerUserId: actor.workspaceOwnerUserId,
        projectId,
        clipId,
        intent: {
          kind: "set_studio_edits",
          studioEdits: studioEditsParsed.data.studioEdits,
        },
      });
      return c.json(
        await updatedClip(dependencies, actor, projectId, clipId),
        200,
      );
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

  routes.get("/projects/:id/clips/:clipId/editor", async (c) => {
    const actor = dependencies.getActor(c);
    return c.json(
      await dependencies.clip.getClipEditorDocument(
        actor,
        c.req.param("id"),
        c.req.param("clipId"),
      ),
      200,
    );
  });

  routes.put("/projects/:id/clips/:clipId/editor", async (c) => {
    const actor = dependencies.getActor(c);
    const projectId = c.req.param("id");
    const clipId = c.req.param("clipId");
    const payload = await c.req.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return c.json({ error: "invalid_input" }, 400);
    }

    const parsed = saveEditorDocumentSchema.safeParse(payload);
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    const current = await dependencies.clip.getClipEditorDocument(
      actor,
      projectId,
      clipId,
    );
    const sceneAnalysis = dependencies.analyzeSceneMutation(
      current.document,
      parsed.data.document,
      actor.pricingTier,
    );
    const motionError = motionDocumentMutationError(
      actor.pricingTier,
      current.document,
      parsed.data.document,
    );
    if (motionError) throw motionError;
    const censorError = censorDocumentMutationError(
      actor.pricingTier,
      current.document,
      parsed.data.document,
    );
    if (censorError) throw censorError;

    await validateSceneReferences(
      dependencies,
      actor,
      projectId,
      parsed.data.document,
      sceneAnalysis,
    );
    const mutation = await dependencies.persistence.mutateDocument({
      actorUserId: actor.actorUserId,
      workspaceId: actor.workspaceId,
      workspaceOwnerUserId: actor.workspaceOwnerUserId,
      projectId,
      clipId,
      intent: {
        kind: "replace",
        baseRevision: parsed.data.baseRevision,
        document: parsed.data.document,
      },
    });
    await dependencies.visualAssets.recordGeneratedInsertionsBestEffort(
      actor,
      projectId,
      sceneAnalysis.introducedVisualAssetIds,
    );
    const clip = await updatedClip(dependencies, actor, projectId, clipId);
    return c.json(
      { revision: mutation.revision, document: mutation.document, clip },
      200,
    );
  });

  routes.post("/projects/:id/clips/:clipId/editor/reset", async (c) => {
    const actor = dependencies.getActor(c);
    const projectId = c.req.param("id");
    const clipId = c.req.param("clipId");
    const payload = await c.req.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return c.json({ error: "invalid_input" }, 400);
    }

    const parsed = resetEditorDocumentSchema.safeParse(payload);
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    const current = await dependencies.clip.getClipEditorDocument(
      actor,
      projectId,
      clipId,
    );
    dependencies.analyzeSceneMutation(
      current.document,
      current.original,
      actor.pricingTier,
    );
    const mutation = await dependencies.persistence.mutateDocument({
      actorUserId: actor.actorUserId,
      workspaceId: actor.workspaceId,
      workspaceOwnerUserId: actor.workspaceOwnerUserId,
      projectId,
      clipId,
      intent: { kind: "reset", baseRevision: parsed.data.baseRevision },
    });
    const clip = await updatedClip(dependencies, actor, projectId, clipId);
    return c.json(
      { revision: mutation.revision, document: mutation.document, clip },
      200,
    );
  });

  return routes;
}
