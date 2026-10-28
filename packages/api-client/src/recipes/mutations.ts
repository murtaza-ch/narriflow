import type { RecipeInput, RecipeUpdate } from "@narriflow/validators/api/recipes";
import type { ApiTransport, WorkspaceScope } from "../core";
import { createRecipesClient } from "./client";

const KEY_HEADER = "Idempotency-Key";

/**
 * Recipe commands, bound to one identity and Workspace. Create and duplicate are
 * retryable acceptances: mint one key per intent (`runtime.createIntent()`) before
 * the first attempt and pass it on every retry, so a lost response replays the saved
 * Recipe instead of saving a second. Update is guarded by `expectedRevision` and delete
 * is naturally idempotent, so neither takes a key.
 */
export function createRecipesActions(transport: ApiTransport, scope: WorkspaceScope) {
  const client = createRecipesClient(transport.scoped(scope));

  return {
    create: async (input: RecipeInput, idempotencyKey: string, signal?: AbortSignal) =>
      (await client.recipes.$post({ json: input }, { headers: { [KEY_HEADER]: idempotencyKey }, init: { signal } })).json(),
    duplicate: async (recipeId: string, idempotencyKey: string, signal?: AbortSignal) =>
      (await client.recipes[":recipeId"].duplicate.$post({ param: { recipeId } }, { headers: { [KEY_HEADER]: idempotencyKey }, init: { signal } })).json(),
    update: async (recipeId: string, input: RecipeUpdate, signal?: AbortSignal) =>
      (await client.recipes[":recipeId"].$patch({ param: { recipeId }, json: input }, { init: { signal } })).json(),
    remove: async (recipeId: string, signal?: AbortSignal) =>
      (await client.recipes[":recipeId"].$delete({ param: { recipeId } }, { init: { signal } })).json(),
  };
}

export type RecipesActions = ReturnType<typeof createRecipesActions>;
