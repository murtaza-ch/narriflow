import { parseResponse, type InferRequestType } from "hono/client";
import { type BrandApi, brandClientFor } from "./queries";
import type { BrandClient } from "./client";

type JsonOf<Endpoint extends (...args: never[]) => unknown> = InferRequestType<Endpoint> extends {
  json: infer Body;
}
  ? Body
  : never;

/** Retryable creates carry the browser's per-intent key. Mint it once per intent (`runtime.createIntent`) and keep it through retries. */
const keyed = (idempotencyKey: string) => ({ headers: { "Idempotency-Key": idempotencyKey } });

export type CreateBrandProfileInput = JsonOf<BrandClient["brand-profiles"]["$post"]>;
export type UpdateBrandProfileInput = JsonOf<BrandClient["brand-profiles"][":id"]["$patch"]>;
export type BrandProfileMembership = JsonOf<BrandClient["brand-profiles"][":id"]["membership"]["$put"]>;
export type DeleteBrandProfileInput = JsonOf<BrandClient["brand-profiles"][":id"]["$delete"]>;
export type CreateSceneTemplateInput = JsonOf<
  BrandClient["brand-profiles"][":id"]["scene-templates"]["$post"]
>;
export type UpdateSceneTemplateInput = JsonOf<
  BrandClient["brand-profiles"][":id"]["scene-templates"][":templateId"]["$patch"]
>;
export type DeleteSceneTemplateInput = JsonOf<
  BrandClient["brand-profiles"][":id"]["scene-templates"][":templateId"]["$delete"]
>;
export type CreateBrandTemplateInput = JsonOf<BrandClient["brand-templates"]["$post"]>;
export type UpdateBrandTemplateInput = JsonOf<BrandClient["brand-templates"][":id"]["$patch"]>;
export type CreateGeneratedImageRequest = JsonOf<
  BrandClient["projects"][":projectId"]["generated-media"]["jobs"]["$post"]
>;

/**
 * Brand Kit commands. Each returns the confirmed body; callers then run
 * `invalidateBrand` (or set returned canonical state first). Creates take the
 * per-intent idempotency key; naturally idempotent replacements and deletes
 * (set default, membership, favorites, soft deletes) and revision-guarded
 * edits keep their native guards and are never retried automatically.
 */
export function brandMutations(api: BrandApi) {
  const client = () => brandClientFor(api);

  return {
    // --- Brand Profiles ------------------------------------------------
    createProfile: (input: CreateBrandProfileInput, idempotencyKey: string) =>
      parseResponse(client()["brand-profiles"].$post({ json: input }, keyed(idempotencyKey))),

    /** Revision-guarded: a stale `revision` is a 409 `brand_profile_conflict`; refetch the profile. */
    updateProfile: (profileId: string, input: UpdateBrandProfileInput) =>
      parseResponse(
        client()["brand-profiles"][":id"].$patch({ param: { id: profileId }, json: input }),
      ),

    setProfileMembership: (profileId: string, input: BrandProfileMembership) =>
      parseResponse(
        client()["brand-profiles"][":id"].membership.$put({ param: { id: profileId }, json: input }),
      ),

    setDefaultProfile: (profileId: string) =>
      parseResponse(
        client()["brand-profiles"][":id"]["set-default"].$post({ param: { id: profileId } }),
      ),

    /** Moves the default and Recipes to `replacementProfileId` (or to none) in the same step. */
    deleteProfile: (profileId: string, input: DeleteBrandProfileInput) =>
      parseResponse(
        client()["brand-profiles"][":id"].$delete({ param: { id: profileId }, json: input }),
      ),

    // --- Scenes --------------------------------------------------------
    createScene: (profileId: string, input: CreateSceneTemplateInput, idempotencyKey: string) =>
      parseResponse(
        client()["brand-profiles"][":id"]["scene-templates"].$post(
          { param: { id: profileId }, json: input },
          keyed(idempotencyKey),
        ),
      ),

    updateScene: (profileId: string, templateId: string, input: UpdateSceneTemplateInput) =>
      parseResponse(
        client()["brand-profiles"][":id"]["scene-templates"][":templateId"].$patch({
          param: { id: profileId, templateId },
          json: input,
        }),
      ),

    deleteScene: (profileId: string, templateId: string, input: DeleteSceneTemplateInput) =>
      parseResponse(
        client()["brand-profiles"][":id"]["scene-templates"][":templateId"].$delete({
          param: { id: profileId, templateId },
          json: input,
        }),
      ),

    // --- Caption styles ------------------------------------------------
    createTemplate: (input: CreateBrandTemplateInput, idempotencyKey: string) =>
      parseResponse(client()["brand-templates"].$post({ json: input }, keyed(idempotencyKey))),

    updateTemplate: (templateId: string, input: UpdateBrandTemplateInput) =>
      parseResponse(
        client()["brand-templates"][":id"].$patch({ param: { id: templateId }, json: input }),
      ),

    deleteTemplate: (templateId: string) =>
      parseResponse(client()["brand-templates"][":id"].$delete({ param: { id: templateId } })),

    setDefaultTemplate: (templateId: string) =>
      parseResponse(
        client()["brand-templates"][":id"]["set-default"].$post({ param: { id: templateId } }),
      ),

    /** Returns the new style; navigate to it with `id`. */
    duplicateTemplate: (templateId: string, input: { name?: string }, idempotencyKey: string) =>
      parseResponse(
        client()["brand-templates"][":id"].duplicate.$post(
          { param: { id: templateId }, json: input },
          keyed(idempotencyKey),
        ),
      ),

    /** Presigned: the browser uploads the logo straight to storage, without Clerk credentials. */
    presignLogoUpload: (input: JsonOf<BrandClient["brand-templates"]["logo"]["presign"]["$post"]>) =>
      parseResponse(client()["brand-templates"].logo.presign.$post({ json: input })),

    // --- Visual assets and fonts (direct-to-storage uploads) -----------
    presignVisualUpload: (input: JsonOf<BrandClient["visual-assets"]["presign-upload"]["$post"]>) =>
      parseResponse(client()["visual-assets"]["presign-upload"].$post({ json: input })),

    finalizeVisualUpload: (input: JsonOf<BrandClient["visual-assets"]["$post"]>) =>
      parseResponse(client()["visual-assets"].$post({ json: input })),

    deleteVisualAsset: (assetId: string, input: JsonOf<BrandClient["visual-assets"][":id"]["$delete"]> = {}) =>
      parseResponse(client()["visual-assets"][":id"].$delete({ param: { id: assetId }, json: input })),

    presignFontUpload: (input: JsonOf<BrandClient["brand-fonts"]["presign-upload"]["$post"]>) =>
      parseResponse(client()["brand-fonts"]["presign-upload"].$post({ json: input })),

    finalizeFontUpload: (input: JsonOf<BrandClient["brand-fonts"]["$post"]>) =>
      parseResponse(client()["brand-fonts"].$post({ json: input })),

    deleteFont: (fontId: string, input: JsonOf<BrandClient["brand-fonts"][":id"]["$delete"]> = {}) =>
      parseResponse(client()["brand-fonts"][":id"].$delete({ param: { id: fontId }, json: input })),

    // --- Music/SFX -----------------------------------------------------
    presignAudioUpload: (input: JsonOf<BrandClient["audio-assets"]["presign-upload"]["$post"]>) =>
      parseResponse(client()["audio-assets"]["presign-upload"].$post({ json: input })),

    finalizeAudioUpload: (input: JsonOf<BrandClient["audio-assets"]["$post"]>) =>
      parseResponse(client()["audio-assets"].$post({ json: input })),

    favoriteAudio: (assetId: string) =>
      parseResponse(client()["audio-assets"][":id"].favorite.$put({ param: { id: assetId } })),

    unfavoriteAudio: (assetId: string) =>
      parseResponse(client()["audio-assets"][":id"].favorite.$delete({ param: { id: assetId } })),

    deleteAudio: (assetId: string) =>
      parseResponse(client()["audio-assets"][":id"].$delete({ param: { id: assetId } })),

    // --- Generated media -----------------------------------------------
    /** Acceptance is the job's own `idempotencyKey` in the body; the same key replays the same job. */
    createGeneratedImage: (projectId: string, input: CreateGeneratedImageRequest) =>
      parseResponse(
        client().projects[":projectId"]["generated-media"].jobs.$post({ param: { projectId }, json: input }),
      ),

    cancelGeneratedJob: (projectId: string, jobId: string) =>
      parseResponse(
        client().projects[":projectId"]["generated-media"].jobs[":id"].cancel.$post({
          param: { projectId, id: jobId },
        }),
      ),

    deleteGeneratedResult: (projectId: string, jobId: string) =>
      parseResponse(
        client().projects[":projectId"]["generated-media"].jobs[":id"].result.$delete({
          param: { projectId, id: jobId },
        }),
      ),

    // --- Applying a scene to a Project's clips -------------------------
    /** Campaign command: `idempotencyKey` per intent; `retryOfId` names the operation a retry continues. */
    applySceneTemplate: (
      target: { projectId: string; profileId: string; templateId: string },
      input: JsonOf<
        BrandClient["projects"][":id"]["brand-profiles"][":profileId"]["scene-templates"][":templateId"]["apply"]["$post"]
      >,
      options: { idempotencyKey: string; retryOfId?: string },
    ) =>
      parseResponse(
        client().projects[":id"]["brand-profiles"][":profileId"]["scene-templates"][":templateId"].apply.$post(
          {
            param: { id: target.projectId, profileId: target.profileId, templateId: target.templateId },
            json: input,
          },
          {
            headers: {
              "Idempotency-Key": options.idempotencyKey,
              ...(options.retryOfId ? { "Campaign-Retry-Of": options.retryOfId } : {}),
            },
          },
        ),
      ),
  };
}

export type BrandMutations = ReturnType<typeof brandMutations>;
