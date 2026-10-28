import { describe, expect, test } from "bun:test";
import type { RecipeInput, RecipeSnapshot } from "@narriflow/validators";
import type { ActorScope } from "./actor-scope";
import {
	createOperationReceiptExecutor,
	OperationIdempotencyConflictError,
	type OperationReceipt,
	type OperationReceiptIdentity,
	type OperationReceiptPersistence,
} from "./operation-receipt";
import type { PlannedRecipe } from "./recipe.service";
import { createRecipesCommands, type RecipesCommandDependencies } from "./recipes-commands";

const actor = { actorUserId: "user-a", workspaceId: "workspace-a" } as ActorScope;
const input = { name: "Weekly", contentPack: {} } as unknown as RecipeInput;

/** In-memory receipts plus a Recipe table, so a replay is visible as "no second insert". */
function harness(options: { sourceName?: () => string } = {}) {
	const receipts = new Map<string, OperationReceipt>();
	const inserted: PlannedRecipe[] = [];
	let planned = 0;
	const key = (identity: OperationReceiptIdentity) => JSON.stringify([identity.workspaceId, identity.actorUserId, identity.command, identity.clientIdempotencyKey]);
	const persistence: OperationReceiptPersistence<object> = {
		read: async (identity) => receipts.get(key(identity)) ?? null,
		transaction: async (run) => run({}),
		lock: async () => {},
		readInTransaction: async (_tx, identity) => receipts.get(key(identity)) ?? null,
		create: async (_tx, receipt) => {
			receipts.set(key(receipt), receipt);
		},
	};
	const executor = createOperationReceiptExecutor(persistence);
	const commands = createRecipesCommands({
		recipes: {
			planCreate: async (_scope, recipe) => {
				planned += 1;
				return { name: recipe.name, brandProfileId: null, languageCode: null, contentPack: recipe.contentPack, finishing: null } as PlannedRecipe;
			},
			planDuplicate: async () => {
				planned += 1;
				return { name: `${options.sourceName?.() ?? "Weekly"} (copy)`, brandProfileId: null, languageCode: null, contentPack: {}, finishing: null } as PlannedRecipe;
			},
			insertPlanned: async (_tx, _scope, plan) => {
				inserted.push(plan);
				return { id: `recipe-${inserted.length}`, name: plan.name } as RecipeSnapshot;
			},
		} as unknown as RecipesCommandDependencies["recipes"],
		receipts: (() => executor) as unknown as RecipesCommandDependencies["receipts"],
		authorize: async () => {},
	});
	return { commands, inserted, planned: () => planned };
}

describe("receipt-backed Recipe create and duplicate", () => {
	test("a retried create with the same key replays the first Recipe and plans and inserts nothing more", async () => {
		const { commands, inserted, planned } = harness();
		const first = await commands.create(actor, input, { clientIdempotencyKey: "k-1" });
		const retry = await commands.create(actor, input, { clientIdempotencyKey: "k-1" });
		expect(first.replayed).toBe(false);
		expect(retry).toEqual({ recipe: first.recipe, replayed: true });
		expect(inserted).toHaveLength(1);
		expect(planned()).toBe(1);
	});

	test("the same key with different input is a conflict, not a second Recipe", async () => {
		const { commands, inserted } = harness();
		await commands.create(actor, input, { clientIdempotencyKey: "k-1" });
		await expect(commands.create(actor, { ...input, name: "Other" }, { clientIdempotencyKey: "k-1" })).rejects.toBeInstanceOf(OperationIdempotencyConflictError);
		expect(inserted).toHaveLength(1);
	});

	test("a replay answers before the new-work limiter, and new work is refused by it", async () => {
		const { commands, inserted } = harness();
		const refuse = async () => {
			throw new Error("limiter refused");
		};
		await commands.create(actor, input, { clientIdempotencyKey: "k-1" });
		const replay = await commands.create(actor, input, { clientIdempotencyKey: "k-1", beforeAccept: refuse });
		expect(replay.replayed).toBe(true);
		await expect(commands.create(actor, input, { clientIdempotencyKey: "k-2", beforeAccept: refuse })).rejects.toThrow("limiter refused");
		expect(inserted).toHaveLength(1);
	});

	test("duplicate keeps the copy the first attempt made, even when the source was renamed since", async () => {
		let name = "Weekly";
		const { commands, inserted } = harness({ sourceName: () => name });
		const first = await commands.duplicate(actor, "recipe-source", { clientIdempotencyKey: "k-1" });
		name = "Renamed";
		const retry = await commands.duplicate(actor, "recipe-source", { clientIdempotencyKey: "k-1" });
		expect(first.recipe.name).toBe("Weekly (copy)");
		expect(retry).toEqual({ recipe: first.recipe, replayed: true });
		expect(inserted).toHaveLength(1);
	});

	test("create and duplicate with one key are separate commands", async () => {
		const { commands, inserted } = harness();
		await commands.create(actor, input, { clientIdempotencyKey: "k-1" });
		const duplicate = await commands.duplicate(actor, "recipe-1", { clientIdempotencyKey: "k-1" });
		expect(duplicate.replayed).toBe(false);
		expect(inserted).toHaveLength(2);
	});
});
