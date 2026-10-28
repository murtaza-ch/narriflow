import { createRecipesCommands } from "./recipes-commands";
import { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import { recipeService } from "./recipe.service";
import { workspaceService } from "./workspace.service";

/** Production wiring of the recipes commands. */
export const recipesCommands = createRecipesCommands({
  recipes: recipeService,
  receipts: getOperationReceiptExecutor,
  authorize: async (actor) => {
    await workspaceService.requireActor(actor.actorUserId, actor.workspaceId, "content.edit");
  },
});
