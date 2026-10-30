import {
  type analyzeSceneDocumentMutation,
  type brandFontService,
  type clipEditorDocumentPersistence,
  type SceneDocumentMutationAnalysis,
  type visualAssetService,
  type BrandActorScope,
  type autoCensorService,
  type brandProfileService,
  type clipService,
  type generatedImageCapability,
  type presignDownloadUrl,
  type projectService,
  type sceneTemplateService,
} from "@narriflow/services";
import {
  patchClipRequestSchema,
  recordCensorEventRequestSchema,
  replaceProjectCensorTermsRequestSchema,
  resetEditorDocumentSchema,
  saveEditorDocumentSchema,
} from "@narriflow/validators/api/studio";
import { bodyClass } from "../../body-limits";
import { createRouteApp, getActor } from "../../http/admission";
import { validate } from "../../http/route";
import { uuidParams } from "../platform/params";
import { studioAdmission as access } from "./admission";
import {
  loadBrandSnapshot,
  loadEditorAssets,
  loadStudioBootstrap,
} from "./bootstrap";

/** Services the studio routes call. `runtime.ts` supplies the production instances. */
export interface StudioRouteDeps {
  clipService: Pick<
    typeof clipService,
    | "getClipSnapshot"
    | "getClipPreviewSource"
    | "getClipEditorDocument"
    | "getClipAutoLayoutAnalysis"
    | "getClipSplitLayoutOutcome"
    | "getClipLayoutAnalysisOutcome"
    | "updateClipTitle"
  >;
  clipEditorDocumentPersistence: Pick<typeof clipEditorDocumentPersistence, "mutateDocument">;
  analyzeSceneDocumentMutation: typeof analyzeSceneDocumentMutation;
  projectService: Pick<
    typeof projectService,
    "getProjectSnapshot" | "getProjectBrandSnapshot" | "getProjectBrandAudio" | "getCaptionLanguage"
  >;
  autoCensorService: Pick<
    typeof autoCensorService,
    "getPolicy" | "replaceProjectTerms" | "recordEvent"
  >;
  visualAssetService: Pick<
    typeof visualAssetService,
    | "list"
    | "resolveSceneReferences"
    | "resolveVisualBrollReferences"
    | "assertSceneReferencesWithPolicy"
    | "assertSceneReferences"
    | "assertVisualBrollReferences"
    | "recordGeneratedInsertionsBestEffort"
  >;
  sceneTemplateService: Pick<typeof sceneTemplateService, "list">;
  brandFontService: Pick<
    typeof brandFontService,
    "list" | "resolveReferences" | "resolveSceneReferences" | "assertSceneReferences"
  >;
  brandProfileService: Pick<typeof brandProfileService, "get">;
  presignDownloadUrl: typeof presignDownloadUrl;
  generatedImageCapability: typeof generatedImageCapability;
}

/**
 * The Scene references an editor-document replacement introduces or keeps must
 * still resolve: changed Scenes may point at deleted assets (they were already
 * there), newly introduced ones must be active.
 */
async function validateSceneReferences(
  deps: StudioRouteDeps,
  actor: BrandActorScope,
  projectId: string,
  document: Parameters<typeof analyzeSceneDocumentMutation>[1],
  analysis: SceneDocumentMutationAnalysis,
) {
  await Promise.all([
    deps.visualAssetService.assertSceneReferencesWithPolicy(actor, analysis.changedSceneBlocks, true),
    deps.visualAssetService.assertSceneReferences(actor, analysis.introducedSceneReferences),
    deps.visualAssetService.assertVisualBrollReferences(actor, document.studioEdits.visualBroll),
    deps.brandFontService.assertSceneReferences(actor, projectId, analysis.changedSceneBlocks, {
      allowDeleted: true,
      requireActiveProfile: false,
    }),
    deps.brandFontService.assertSceneReferences(actor, projectId, analysis.introducedSceneReferences, {
      allowDeleted: false,
      requireActiveProfile: true,
    }),
  ]);
}

/**
 * Studio bootstrap and polls, project censor terms and the Clip Editor
 * Document persistence routes. Revision guards, reset barriers and plan rules
 * stay in `clipEditorDocumentPersistence`; these handlers only admit, validate
 * and serialize.
 */
export function createStudioRoutes(deps: StudioRouteDeps) {
  const { clipService, clipEditorDocumentPersistence, autoCensorService } = deps;

  const updatedClip = (actor: BrandActorScope, projectId: string, clipId: string) =>
    clipService.getClipSnapshot(actor, projectId, clipId);

  return createRouteApp(access)
    // One aggregate for the Studio's first paint (replaces the page's reads).
    .get(
      "/projects/:id/clips/:clipId/studio",
      uuidParams("id", "clipId"),
      async (c) => {
        const { id, clipId } = c.req.valid("param");
        return c.json(await loadStudioBootstrap(deps, getActor(c), id, clipId), 200);
      },
    )

    // Preview proxy readiness, polled until the proxy lands.
    .get(
      "/projects/:id/clips/:clipId/preview-source",
      uuidParams("id", "clipId"),
      async (c) => {
        const { id, clipId } = c.req.valid("param");
        return c.json(await clipService.getClipPreviewSource(getActor(c), id, clipId), 200);
      },
    )

    // Worker-derived layout evidence, each a lightweight single-column read.
    .get(
      "/projects/:id/clips/:clipId/layout/auto",
      uuidParams("id", "clipId"),
      async (c) => {
        const { id, clipId } = c.req.valid("param");
        return c.json(
          { analysis: await clipService.getClipAutoLayoutAnalysis(getActor(c), id, clipId) },
          200,
        );
      },
    )
    .get(
      "/projects/:id/clips/:clipId/layout/split",
      uuidParams("id", "clipId"),
      async (c) => {
        const { id, clipId } = c.req.valid("param");
        return c.json(
          { outcome: await clipService.getClipSplitLayoutOutcome(getActor(c), id, clipId) },
          200,
        );
      },
    )
    .get(
      "/projects/:id/clips/:clipId/layout/screen",
      uuidParams("id", "clipId"),
      async (c) => {
        const { id, clipId } = c.req.valid("param");
        return c.json(
          { outcome: await clipService.getClipLayoutAnalysisOutcome(getActor(c), id, clipId) },
          200,
        );
      },
    )

    // Retained and active asset facts for the clip's current document.
    .get(
      "/projects/:id/clips/:clipId/editor-assets",
      uuidParams("id", "clipId"),
      async (c) => {
        const { id, clipId } = c.req.valid("param");
        return c.json(await loadEditorAssets(deps, getActor(c), id, clipId), 200);
      },
    )

    .put(
      "/projects/:id/censor-terms",
      uuidParams("id"),
      validate("json", replaceProjectCensorTermsRequestSchema),
      async (c) => {
        const terms = await autoCensorService.replaceProjectTerms(
          getActor(c),
          c.req.valid("param").id,
          c.req.valid("json").terms,
        );
        return c.json({ terms }, 200);
      },
    )

    // Best-effort analytics: the client swallows failures.
    .post(
      "/projects/:id/clips/:clipId/censor-events",
      uuidParams("id", "clipId"),
      validate("json", recordCensorEventRequestSchema),
      async (c) => {
        const { id, clipId } = c.req.valid("param");
        await autoCensorService.recordEvent(getActor(c), id, clipId, c.req.valid("json"));
        return c.json({ recorded: true as const }, 200);
      },
    )

    .get("/projects/:id/auto-censor", uuidParams("id"), async (c) =>
      c.json(await autoCensorService.getPolicy(getActor(c), c.req.valid("param").id), 200),
    )

    .get("/projects/:id/brand-snapshot", uuidParams("id"), async (c) =>
      c.json(await loadBrandSnapshot(deps, getActor(c), c.req.valid("param").id), 200),
    )

    .get("/generated-images/capability", (c) =>
      c.json(deps.generatedImageCapability(getActor(c)), 200),
    )

    // One clip update: rename, boundaries, caption preset, transcript slice,
    // B-roll URL or studio edits. Everything but the rename goes through
    // Clip Editor Document Persistence.
    .patch(
      "/projects/:id/clips/:clipId",
      bodyClass("editor"),
      uuidParams("id", "clipId"),
      validate("json", patchClipRequestSchema),
      async (c) => {
        const actor = getActor(c);
        const { id, clipId } = c.req.valid("param");
        const update = c.req.valid("json");
        if (update.kind === "rename") {
          return c.json(await clipService.updateClipTitle(actor, id, clipId, update.title), 200);
        }
        await clipEditorDocumentPersistence.mutateDocument({
          actorUserId: actor.actorUserId,
          workspaceId: actor.workspaceId,
          projectId: id,
          clipId,
          intent: update,
        });
        return c.json(await updatedClip(actor, id, clipId), 200);
      },
    )

    .get(
      "/projects/:id/clips/:clipId/editor",
      uuidParams("id", "clipId"),
      async (c) => {
        const { id, clipId } = c.req.valid("param");
        return c.json(await clipService.getClipEditorDocument(getActor(c), id, clipId), 200);
      },
    )

    // Revision-guarded replacement. Plan rules for the change are enforced by
    // document persistence; this adapter validates the Scene references the
    // change introduces.
    .put(
      "/projects/:id/clips/:clipId/editor",
      bodyClass("editor"),
      uuidParams("id", "clipId"),
      validate("json", saveEditorDocumentSchema),
      async (c) => {
        const actor = getActor(c);
        const { id, clipId } = c.req.valid("param");
        const { baseRevision, document } = c.req.valid("json");
        const current = await clipService.getClipEditorDocument(actor, id, clipId);
        const sceneAnalysis = deps.analyzeSceneDocumentMutation(current.document, document);
        await validateSceneReferences(deps, actor, id, document, sceneAnalysis);
        const mutation = await clipEditorDocumentPersistence.mutateDocument({
          actorUserId: actor.actorUserId,
          workspaceId: actor.workspaceId,
          projectId: id,
          clipId,
          intent: { kind: "replace", baseRevision, document },
        });
        await deps.visualAssetService.recordGeneratedInsertionsBestEffort(
          actor,
          id,
          sceneAnalysis.introducedVisualAssetIds,
        );
        const clip = await updatedClip(actor, id, clipId);
        return c.json({ revision: mutation.revision, document: mutation.document, clip }, 200);
      },
    )

    .post(
      "/projects/:id/clips/:clipId/editor/reset",
      uuidParams("id", "clipId"),
      validate("json", resetEditorDocumentSchema),
      async (c) => {
        const actor = getActor(c);
        const { id, clipId } = c.req.valid("param");
        const mutation = await clipEditorDocumentPersistence.mutateDocument({
          actorUserId: actor.actorUserId,
          workspaceId: actor.workspaceId,
          projectId: id,
          clipId,
          intent: { kind: "reset", baseRevision: c.req.valid("json").baseRevision },
        });
        const clip = await updatedClip(actor, id, clipId);
        return c.json({ revision: mutation.revision, document: mutation.document, clip }, 200);
      },
    );
}

export type StudioRoutes = ReturnType<typeof createStudioRoutes>;
