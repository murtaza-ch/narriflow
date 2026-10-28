import type { QueryClient } from "@tanstack/query-core";
import type { InferRequestType } from "hono/client";
import type { CreateClipFromSelection, RegenerateClipsRequest } from "@narriflow/validators/api/clips";
import {
  CAMPAIGN_RETRY_OF_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  invalidateScoped,
  type WorkspaceScope,
} from "../core";
import { invalidateProject } from "../projects";
import type { ClipsClient } from "./index";
import { CLIP_RESOURCES } from "./queries";

/** The JSON body an endpoint accepts, inferred from the route chain (and so from its shared schema). */
type JsonBody<Endpoint extends (...args: never[]) => Promise<unknown>> =
  InferRequestType<Endpoint> extends { json: infer Body } ? Body : never;

type Campaign = ClipsClient["projects"][":id"]["campaign-operations"];

const withKey = (idempotencyKey: string, retryOfId?: string) => ({
  headers: {
    [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
    ...(retryOfId ? { [CAMPAIGN_RETRY_OF_HEADER]: retryOfId } : {}),
  },
});

/**
 * Clip, campaign and thumbnail commands. Retryable acceptance takes the
 * intent's Idempotency-Key (`runtime.createIntent()`) and keeps it through
 * timeouts and token refreshes; a changed payload is a new intent. Campaign
 * commands pass `retryOfId` to retry one earlier operation. Deleting is
 * naturally idempotent and carries no key.
 */
export const clipCommands = {
  /** Copies the clip and its media. A replay with the same key returns the accepted copy. */
  duplicate(client: ClipsClient, projectId: string, clipId: string, idempotencyKey: string) {
    return client.projects[":id"].clips[":clipId"].duplicate
      .$post({ param: { id: projectId, clipId } }, withKey(idempotencyKey))
      .then((response) => response.json());
  },

  /** A clip over a transcript range of the Project (library search "make a clip"). */
  createFromRange(client: ClipsClient, projectId: string, range: CreateClipFromSelection, idempotencyKey: string) {
    return client.projects[":id"].clips["create-from-range"]
      .$post({ param: { id: projectId }, json: range }, withKey(idempotencyKey))
      .then((response) => response.json());
  },

  createFromSelection(client: ClipsClient, projectId: string, clipId: string, range: CreateClipFromSelection) {
    return client.projects[":id"].clips[":clipId"]["create-from-selection"]
      .$post({ param: { id: projectId, clipId }, json: range })
      .then((response) => response.json());
  },

  /** Permanent. Refused with `clip_has_scheduled_posts` while posts are scheduled or publishing. */
  remove(client: ClipsClient, projectId: string, clipId: string) {
    return client.projects[":id"].clips[":clipId"].$delete({ param: { id: projectId, clipId } }).then((response) => response.json());
  },

  suggestTitles(client: ClipsClient, projectId: string, clipId: string) {
    return client.projects[":id"].clips[":clipId"]["title-suggestions"]
      .$post({ param: { id: projectId, clipId } })
      .then((response) => response.json());
  },

  regenerate(client: ClipsClient, projectId: string, input: RegenerateClipsRequest, idempotencyKey: string) {
    return client.projects[":id"].clips.regenerate
      .$post({ param: { id: projectId }, json: input }, withKey(idempotencyKey))
      .then((response) => response.json());
  },

  render(client: ClipsClient, projectId: string, input: JsonBody<ClipsClient["projects"][":id"]["clips"]["render"]["$post"]>, idempotencyKey: string) {
    return client.projects[":id"].clips.render
      .$post({ param: { id: projectId }, json: input }, withKey(idempotencyKey))
      .then((response) => response.json());
  },

  requestThumbnailFrame(client: ClipsClient, projectId: string, input: JsonBody<ClipsClient["projects"][":id"]["thumbnail-frames"]["$post"]>) {
    return client.projects[":id"]["thumbnail-frames"]
      .$post({ param: { id: projectId }, json: input })
      .then((response) => response.json());
  },

  retryThumbnailFrame(client: ClipsClient, projectId: string, operationId: string) {
    return client.projects[":id"]["thumbnail-frames"][":operationId"].retry
      .$post({ param: { id: projectId, operationId } })
      .then((response) => response.json());
  },

  previewEditorAction(client: ClipsClient, projectId: string, input: JsonBody<Campaign["preview-editor-action"]["$post"]>) {
    return client.projects[":id"]["campaign-operations"]["preview-editor-action"]
      .$post({ param: { id: projectId }, json: input })
      .then((response) => response.json());
  },

  applyBrandProfile(
    client: ClipsClient,
    projectId: string,
    input: JsonBody<Campaign["apply-brand-profile"]["$post"]>,
    idempotencyKey: string,
    retryOfId?: string,
  ) {
    return client.projects[":id"]["campaign-operations"]["apply-brand-profile"]
      .$post({ param: { id: projectId }, json: input }, withKey(idempotencyKey, retryOfId))
      .then((response) => response.json());
  },

  applyStyle(
    client: ClipsClient,
    projectId: string,
    input: JsonBody<Campaign["apply-style"]["$post"]>,
    idempotencyKey: string,
    retryOfId?: string,
  ) {
    return client.projects[":id"]["campaign-operations"]["apply-style"]
      .$post({ param: { id: projectId }, json: input }, withKey(idempotencyKey, retryOfId))
      .then((response) => response.json());
  },

  applyMotion(
    client: ClipsClient,
    projectId: string,
    input: JsonBody<Campaign["apply-motion"]["$post"]>,
    idempotencyKey: string,
    retryOfId?: string,
  ) {
    return client.projects[":id"]["campaign-operations"]["apply-motion"]
      .$post({ param: { id: projectId }, json: input }, withKey(idempotencyKey, retryOfId))
      .then((response) => response.json());
  },
};

/** Mutations never retry on their own; spread into `useMutation` options. */
export const clipMutationOptions = { retry: false } as const;

/** Clip rows changed: the Project's clip list, grants, operations and its screen. */
export async function invalidateProjectClips(queryClient: QueryClient, scope: WorkspaceScope, projectId: string) {
  await Promise.all([
    invalidateScoped(queryClient, scope, "clips", CLIP_RESOURCES.list, projectId),
    invalidateScoped(queryClient, scope, "clips", CLIP_RESOURCES.previews, { id: projectId }),
    invalidateScoped(queryClient, scope, "clips", CLIP_RESOURCES.campaignOperations, projectId),
    invalidateProject(queryClient, scope, projectId),
  ]);
}

/**
 * After a clip was created, copied or deleted, or an operation was accepted:
 * the clip reads above, project counts and Workspace usage (render and
 * generation spend credits on acceptance).
 */
export async function invalidateAfterClipChange(queryClient: QueryClient, scope: WorkspaceScope, projectId: string) {
  await Promise.all([
    invalidateProjectClips(queryClient, scope, projectId),
    invalidateScoped(queryClient, scope, "projects", "list"),
    invalidateScoped(queryClient, scope, "workspace", "usage"),
  ]);
}

/** After a thumbnail frame request or retry: its operation poll. */
export function invalidateAfterThumbnailFrame(queryClient: QueryClient, scope: WorkspaceScope, projectId: string) {
  return invalidateScoped(queryClient, scope, "clips", CLIP_RESOURCES.thumbnailFrame, { id: projectId });
}
