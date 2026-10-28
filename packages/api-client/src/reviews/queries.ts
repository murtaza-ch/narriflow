import { guestKey, scopedKey, shareKey, STALE_TIME, type WorkspaceScope } from "../core";
import type { ReviewsClient } from "./index";

export const reviewQueries = {
  room(client: ReviewsClient, scope: WorkspaceScope, projectId: string) {
    return { queryKey: scopedKey(scope, "reviews", "room", projectId), staleTime: STALE_TIME.default,
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await client.projects[":id"]["review-rounds"].$get({ param: { id: projectId } }, { init: { signal } })).json() };
  },
  guestRoom(client: ReviewsClient, token: string, digest: string) {
    return { queryKey: guestKey(digest, "room"), staleTime: STALE_TIME.live,
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await client.review[":token"].$get({ param: { token } }, { init: { signal } })).json() };
  },
  share(client: ReviewsClient, token: string, digest: string) {
    return { queryKey: shareKey(digest, "export"), staleTime: STALE_TIME.live,
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await client.share[":token"].$get({ param: { token } }, { init: { signal } })).json() };
  },
  media(client: ReviewsClient, token: string, digest: string, itemId: string, variantId: string, download = false) {
    return { queryKey: guestKey(digest, download ? "download" : "media", { itemId, variantId }), staleTime: STALE_TIME.live,
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await (download ? client.review[":token"].download : client.review[":token"].media)[":itemId"][":variantId"].$get({ param: { token, itemId, variantId } }, { init: { signal } })).json() };
  },
  optOut(client: ReviewsClient, token: string, digest: string) {
    return { queryKey: guestKey(digest, "opt-out"), staleTime: STALE_TIME.live,
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await client.review["opt-out"].$get({ query: { token } }, { init: { signal } })).json() };
  },
};
