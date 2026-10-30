import { describe, expect, test } from "bun:test";
import type { Prisma } from "@prisma/client";
import {
	createOperationReceiptExecutor,
	OperationIdempotencyConflictError,
	type OperationReceipt,
	type OperationReceiptIdentity,
} from "./operation-receipt";
import { createProjectsCommands } from "./projects-commands";
import { WorkspaceLibraryError } from "./workspace-library.service";

function harness() {
	const receipts = new Map<string, OperationReceipt>();
	const folders: { id: string; name: string; createdAt: Date; normalizedName: string }[] = [];
	let tail = Promise.resolve();
	const key = (identity: OperationReceiptIdentity) =>
		JSON.stringify([identity.workspaceId, identity.actorUserId, identity.command, identity.clientIdempotencyKey]);
	const tx = {
		workspaceFolder: {
			create: async ({ data }: { data: { name: string; normalizedName: string } }) => {
				if (folders.some((folder) => folder.normalizedName === data.normalizedName)) {
					throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
				}
				const folder = {
					id: `folder-${folders.length + 1}`,
					name: data.name,
					normalizedName: data.normalizedName,
					createdAt: new Date("2026-10-29T10:00:00.000Z"),
				};
				folders.push(folder);
				return folder;
			},
		},
	} as unknown as Prisma.TransactionClient;
	const executor = createOperationReceiptExecutor<Prisma.TransactionClient>({
		read: async (identity) => receipts.get(key(identity)) ?? null,
		transaction: async (run) => {
			const previous = tail;
			let unlock!: () => void;
			tail = new Promise<void>((resolve) => {
				unlock = resolve;
			});
			await previous;
			try {
				return await run(tx);
			} finally {
				unlock();
			}
		},
		lock: async () => {},
		readInTransaction: async (_tx, identity) => receipts.get(key(identity)) ?? null,
		create: async (_tx, receipt) => {
			receipts.set(key(receipt), receipt);
		},
	});
	const authorized: string[] = [];
	const commands = createProjectsCommands({
		receipts: () => executor,
		requireActor: async (_scope, capability) => {
			authorized.push(capability);
		},
	});
	return { commands, folders, authorized, receipts };
}

const scope = { actorUserId: "user-a", workspaceId: "workspace-a" };

describe("receipt-backed folder creation", () => {
	test("creates one folder per key and replays the original result", async () => {
		const h = harness();
		const first = await h.commands.createFolder(scope, "  Launch ", { clientIdempotencyKey: "key-1" });
		const replay = await h.commands.createFolder(scope, "Launch", { clientIdempotencyKey: "key-1" });
		expect(first).toEqual({
			folder: { id: "folder-1", name: "Launch", createdAt: "2026-10-29T10:00:00.000Z" },
			replayed: false,
		});
		expect(replay).toEqual({ folder: first.folder, replayed: true });
		expect(h.folders).toHaveLength(1);
		expect(h.authorized).toEqual(["content.edit", "content.edit"]);
	});

	test("a changed name under the same key conflicts and creates nothing", async () => {
		const h = harness();
		await h.commands.createFolder(scope, "Launch", { clientIdempotencyKey: "key-1" });
		await expect(
			h.commands.createFolder(scope, "Other", { clientIdempotencyKey: "key-1" }),
		).rejects.toBeInstanceOf(OperationIdempotencyConflictError);
		expect(h.folders).toHaveLength(1);
	});

	test("a new key creates a second folder, and another actor's key is independent", async () => {
		const h = harness();
		await h.commands.createFolder(scope, "A", { clientIdempotencyKey: "key-1" });
		await h.commands.createFolder(scope, "B", { clientIdempotencyKey: "key-2" });
		const other = await h.commands.createFolder(
			{ actorUserId: "user-b", workspaceId: "workspace-a" },
			"C",
			{ clientIdempotencyKey: "key-1" },
		);
		expect(other.replayed).toBe(false);
		expect(h.folders).toHaveLength(3);
	});

	test("concurrent requests with one key accept exactly once", async () => {
		const h = harness();
		const results = await Promise.all([
			h.commands.createFolder(scope, "Race", { clientIdempotencyKey: "key-1" }),
			h.commands.createFolder(scope, "Race", { clientIdempotencyKey: "key-1" }),
		]);
		expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
		expect(h.folders).toHaveLength(1);
	});

	test("enforces the recorded limiter only for new work, after replay lookup", async () => {
		const h = harness();
		const refuse = () => {
			throw new Error("limited");
		};
		await expect(
			h.commands.createFolder(scope, "Launch", { clientIdempotencyKey: "key-1", beforeAccept: refuse }),
		).rejects.toThrow("limited");
		expect(h.folders).toHaveLength(0);
		await h.commands.createFolder(scope, "Launch", { clientIdempotencyKey: "key-1" });
		const replay = await h.commands.createFolder(scope, "Launch", {
			clientIdempotencyKey: "key-1",
			beforeAccept: refuse,
		});
		expect(replay.replayed).toBe(true);
	});

	test("rejects an invalid name before recording anything", async () => {
		const h = harness();
		await expect(
			h.commands.createFolder(scope, "   ", { clientIdempotencyKey: "key-1" }),
		).rejects.toBeInstanceOf(WorkspaceLibraryError);
		expect(h.receipts.size).toBe(0);
	});

	test("a taken name is a typed conflict that records nothing, while the original key still replays", async () => {
		const h = harness();
		const first = await h.commands.createFolder(scope, "Launch", { clientIdempotencyKey: "key-1" });
		const clash = await h.commands
			.createFolder(scope, " launch ", { clientIdempotencyKey: "key-2" })
			.catch((error) => error);
		expect(clash).toBeInstanceOf(WorkspaceLibraryError);
		expect(clash).toMatchObject({ code: "workspace_folder_name_taken", kind: "conflict" });
		expect(h.folders).toHaveLength(1);
		expect(h.receipts.size).toBe(1);
		const replay = await h.commands.createFolder(scope, "Launch", { clientIdempotencyKey: "key-1" });
		expect(replay).toEqual({ folder: first.folder, replayed: true });
	});
});
