import { recipeService, recipesCommands } from "@narriflow/services";
import type { ApiConfig } from "../../config";
import type { RecipesRouteDeps } from "./routes";

/** Production wiring of the recipes routes. */
export function createRecipesRouteDeps(_config: ApiConfig): RecipesRouteDeps {
  return { recipeService, recipesCommands };
}
