import { type RecipesCommands, recipeService } from "@narriflow/services";
import { recipeInputSchema, recipeUpdateSchema } from "@narriflow/validators";
import { createRouteApp, getActor, getRecordedRateLimit } from "../../http/admission";
import { getIdempotencyKey, requireIdempotencyKey } from "../../http/idempotency";
import { enforceRecordedRateLimit } from "../../http/limits";
import { validate } from "../../http/route";
import { recipesAdmission as access } from "./admission";

/** Services the recipes routes call. `runtime.ts` supplies the production instances. */
export interface RecipesRouteDeps {
  recipeService: typeof recipeService;
  recipesCommands: Pick<RecipesCommands, "create" | "duplicate">;
}

/** Saved Recipes: list, create, update, duplicate and delete. Create and duplicate are receipt-backed. */
export function createRecipesRoutes(deps: RecipesRouteDeps) {
  const { recipeService, recipesCommands } = deps;

  return createRouteApp(access)
    .get("/recipes", async (c) => {
      const recipes = await recipeService.list(getActor(c));
      return c.json({ recipes }, 200);
    })

    // A retried create with the same Idempotency-Key replays the Recipe the first attempt saved. An
    // exhausted or unavailable limiter refuses only new work, after that replay lookup.
    .post("/recipes", requireIdempotencyKey(), validate("json", recipeInputSchema), async (c) => {
      const { recipe, replayed } = await recipesCommands.create(getActor(c), c.req.valid("json"), {
        clientIdempotencyKey: getIdempotencyKey(c),
        beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)),
      });
      if (replayed) c.header("Idempotent-Replayed", "true");
      return c.json(recipe, 201);
    })

    .patch("/recipes/:recipeId", validate("json", recipeUpdateSchema), async (c) => {
      // The saved Recipe, with any warnings the save raised (they never block it).
      const recipe = await recipeService.update(getActor(c), c.req.param("recipeId"), c.req.valid("json"));
      return c.json(recipe, 200);
    })

    .post("/recipes/:recipeId/duplicate", requireIdempotencyKey(), async (c) => {
      const { recipe, replayed } = await recipesCommands.duplicate(getActor(c), c.req.param("recipeId"), {
        clientIdempotencyKey: getIdempotencyKey(c),
        beforeAccept: async () => enforceRecordedRateLimit(getRecordedRateLimit(c)),
      });
      if (replayed) c.header("Idempotent-Replayed", "true");
      return c.json(recipe, 201);
    })

    .delete("/recipes/:recipeId", async (c) => {
      await recipeService.delete(getActor(c), c.req.param("recipeId"));
      return c.json({ ok: true }, 200);
    });
}

export type RecipesRoutes = ReturnType<typeof createRecipesRoutes>;
