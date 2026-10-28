import { recipeService } from "@narriflow/services";
import { recipeInputSchema, recipeUpdateSchema } from "@narriflow/validators";
import { createRouteApp, getActor } from "../../http/admission";
import { validate } from "../../http/route";
import { recipesAdmission as access } from "./admission";

/** Services the recipes routes call. `runtime.ts` supplies the production instance. */
export interface RecipesRouteDeps {
  recipeService: typeof recipeService;
}

/** Saved Recipes: list, create, update, duplicate and delete. */
export function createRecipesRoutes(deps: RecipesRouteDeps) {
  const { recipeService } = deps;

  return createRouteApp(access)
    .get("/recipes", async (c) => {
      const recipes = await recipeService.list(getActor(c));
      return c.json({ recipes }, 200);
    })

    .post(
      "/recipes",
      validate("json", recipeInputSchema),
      async (c) => {
        const recipe = await recipeService.create(getActor(c), c.req.valid("json"));
        return c.json(recipe, 201);
      },
    )

    .patch(
      "/recipes/:recipeId",
      validate("json", recipeUpdateSchema),
      async (c) => {
        // The saved Recipe, with any warnings the save raised (they never block it).
        const recipe = await recipeService.update(
          getActor(c),
          c.req.param("recipeId"),
          c.req.valid("json"),
        );
        return c.json(recipe, 200);
      },
    )

    .post(
      "/recipes/:recipeId/duplicate",
      async (c) => {
        const recipe = await recipeService.duplicate(getActor(c), c.req.param("recipeId"));
        return c.json(recipe, 201);
      },
    )

    .delete("/recipes/:recipeId", async (c) => {
      await recipeService.delete(getActor(c), c.req.param("recipeId"));
      return c.json({ ok: true }, 200);
    });
}

export type RecipesRoutes = ReturnType<typeof createRecipesRoutes>;
