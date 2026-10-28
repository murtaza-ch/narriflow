import type { RecipeInput, RecipeSnapshot } from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import type { IntegrationMutation } from "./operation-receipt";
import type { getOperationReceiptExecutor } from "./operation-receipt-runtime";
import type { PlannedRecipe, RecipeService } from "./recipe.service";
import { RECIPES_RECEIPT_COMMANDS } from "./recipes-receipt-commands";

/** Dependencies of the recipes receipt-backed commands. */
export interface RecipesCommandDependencies {
	recipes: Pick<RecipeService, "planCreate" | "planDuplicate" | "insertPlanned">;
	receipts(): ReturnType<typeof getOperationReceiptExecutor>;
	/** Refuses an actor who may not edit Recipes; runs before any replay is answered. */
	authorize(actor: ActorScope): Promise<void>;
}

/** The transport facts a Recipe create or duplicate needs: the caller's key and the new-work limiter. */
export type RecipeMutation = Pick<IntegrationMutation, "clientIdempotencyKey" | "beforeAccept">;

/**
 * Receipt-backed retryable commands of the recipes domain. A retry with the
 * same key replays the Recipe the first attempt saved, even if the source
 * Recipe or the Workspace default Brand Profile changed since; the request is
 * checked and resolved only for genuinely new work. Only names registered in
 * `RECIPES_RECEIPT_COMMANDS` may be recorded.
 */
export function createRecipesCommands(dependencies: RecipesCommandDependencies) {
	const { recipes, receipts, authorize } = dependencies;

	async function accept(
		actor: ActorScope,
		command: (typeof RECIPES_RECEIPT_COMMANDS)[number],
		input: unknown,
		mutation: RecipeMutation,
		plan: () => Promise<PlannedRecipe>,
	) {
		let planned: PlannedRecipe | undefined;
		const accepted = await receipts().execute<RecipeSnapshot>({
			identity: {
				workspaceId: actor.workspaceId,
				actorUserId: actor.actorUserId,
				command,
				clientIdempotencyKey: mutation.clientIdempotencyKey,
			},
			input,
			authorize: () => authorize(actor),
			beforeAccept: mutation.beforeAccept,
			prepare: async () => {
				planned = await plan();
			},
			mutate: async (tx) => {
				if (!planned) throw new Error("A Recipe is planned before it is inserted");
				const recipe = await recipes.insertPlanned(tx, actor, planned);
				return { resourceType: "recipe", resourceId: recipe.id, value: recipe };
			},
		});
		return { recipe: accepted.value, replayed: accepted.replayed };
	}

	return {
		receiptCommands: RECIPES_RECEIPT_COMMANDS,
		create: (actor: ActorScope, input: RecipeInput, mutation: RecipeMutation) =>
			accept(actor, "create_recipe", input, mutation, () => recipes.planCreate(actor, input)),
		duplicate: (actor: ActorScope, recipeId: string, mutation: RecipeMutation) =>
			accept(actor, "duplicate_recipe", { recipeId }, mutation, () => recipes.planDuplicate(actor, recipeId)),
	};
}

export type RecipesCommands = ReturnType<typeof createRecipesCommands>;
