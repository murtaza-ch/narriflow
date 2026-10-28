import type { QueryClient } from "@tanstack/query-core";
import { guestKey, invalidateScoped, type WorkspaceScope } from "../core";
/** Call only after confirmed acceptance. Keep the intent key on uncertain failures. */
export async function invalidateReviewMutation(client: QueryClient, scope: WorkspaceScope, projectId: string) {
  await Promise.all([
    invalidateScoped(client, scope, "reviews", "room", projectId),
    invalidateScoped(client, scope, "projects", "detail", projectId),
    invalidateScoped(client, scope, "publishing", "project-posts", { projectId }),
    invalidateScoped(client, scope, "publishing", "publication", { projectId }),
  ]);
}
export async function invalidateGuestReviewMutation(client: QueryClient, digest: string) {
  await client.invalidateQueries({ queryKey: guestKey(digest, "room") });
}
/** Use in mutation options. Access exchange, edits and deletes also have no automatic retries. */
export const reviewMutationOptions = { retry: false } as const;
