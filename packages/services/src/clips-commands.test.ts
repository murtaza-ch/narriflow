import { describe, expect, test } from "bun:test";
import type { Prisma } from "@prisma/client";
import type { ActorScope } from "./actor-scope";
import type { ClipSnapshot } from "@narriflow/validators";
import type { ClipCreationAcceptance } from "./clip.service";
import { createClipsCommands } from "./clips-commands";
import { CLIPS_RECEIPT_COMMANDS } from "./clips-receipt-commands";
import {
	OperationIdempotencyConflictError,
	RECEIPT_COMMANDS,
	type OperationReceipt,
	type OperationReceiptIdentity,
	type OperationReceiptPersistence,
} from "./operation-receipt";

const actor = {
	actorUserId: "user-a",
	workspaceId: "workspace-a",
} as ActorScope;
const PROJECT = "project-1";

/** In-memory receipts whose transaction rolls its receipts and clip rows back together. */
function harness() {
	let receipts = new Map<string, OperationReceipt>();
	let clipRows: string[] = [];
	let tail = Promise.resolve();
	const key = (identity: OperationReceiptIdentity) =>
		JSON.stringify([identity.workspaceId, identity.actorUserId, identity.command, identity.clientIdempotencyKey]);
	const persistence: OperationReceiptPersistence<Prisma.TransactionClient> = {
		read: async (identity) => receipts.get(key(identity)) ?? null,
		transaction: async (run) => {
			const previous = tail;
			let unlock!: () => void;
			tail = new Promise<void>((resolve) => {
				unlock = resolve;
			});
			await previous;
			const savedReceipts = new Map(receipts);
			const savedRows = [...clipRows];
			try {
				return await run({ insertClip: (id: string) => void clipRows.push(id) } as never);
			} catch (error) {
				receipts = savedReceipts;
				clipRows = savedRows;
				throw error;
			} finally {
				unlock();
			}
		},
		lock: async () => {},
		readInTransaction: async (_tx, identity) => receipts.get(key(identity)) ?? null,
		create: async (_tx, receipt) => {
			receipts.set(key(receipt), receipt);
		},
	};
	return { persistence, clipRows: () => clipRows, receipts: () => receipts.size };
}

function snapshot(id: string): ClipSnapshot {
	return { id, projectId: PROJECT, title: "Copy" } as ClipSnapshot;
}

/** Stands in for ClipService: counts external work, writes through the acceptance. */
function fakeClips(options: { beforeAccept?: Promise<void>; failWrite?: boolean } = {}) {
	const state = { prepared: 0, created: 0 };
	let next = 0;
	const create = async (acceptance: ClipCreationAcceptance) => {
		state.prepared += 1; // media copies in the real service
		await options.beforeAccept;
		return acceptance.accept(async (tx) => {
			(tx as unknown as { insertClip(id: string): void }).insertClip(`clip-${++next}`);
			if (options.failWrite) throw new Error("insert failed");
			state.created += 1;
			return snapshot(`clip-${next}`);
		});
	};
	return {
		state,
		service: {
			duplicateClip: (_actor: ActorScope, _p: string, _c: string, acceptance?: ClipCreationAcceptance) =>
				create(acceptance as ClipCreationAcceptance),
			createClipFromRange: (_actor: ActorScope, _p: string, _r: unknown, acceptance?: ClipCreationAcceptance) =>
				create(acceptance as ClipCreationAcceptance),
			createClipFromSelection: (
				_actor: ActorScope,
				_p: string,
				_c: string,
				_r: unknown,
				acceptance?: ClipCreationAcceptance,
			) => create(acceptance as ClipCreationAcceptance),
		},
	};
}

function build(fake = fakeClips(), receipts = harness()) {
	const authorizations: string[] = [];
	const commands = createClipsCommands({
		persistence: receipts.persistence,
		clips: fake.service as never,
		requireEditor: async (actorUserId, workspaceId) => {
			authorizations.push(`${actorUserId}@${workspaceId}`);
		},
	});
	return { commands, receipts, fake, authorizations };
}

describe("clip creation receipts", () => {
	test("the command names are registered in the closed receipt union", () => {
		expect(CLIPS_RECEIPT_COMMANDS).toContain("duplicate_clip");
		expect(CLIPS_RECEIPT_COMMANDS).toContain("create_clip_from_range");
		expect(RECEIPT_COMMANDS).toContain("duplicate_clip");
	});

	test("a new duplicate commits the clip row and its receipt together", async () => {
		const { commands, receipts, fake } = build();
		const outcome = await commands.duplicateClip(actor, PROJECT, "clip-0", { clientIdempotencyKey: "k1" });
		expect(outcome).toMatchObject({ replayed: false, clip: { id: "clip-1" } });
		expect(receipts.clipRows()).toEqual(["clip-1"]);
		expect(receipts.receipts()).toBe(1);
		expect(fake.state.prepared).toBe(1);
	});

	test("a retry returns the accepted clip without copying media or consulting the limiter", async () => {
		const { commands, receipts, fake } = build();
		await commands.duplicateClip(actor, PROJECT, "clip-0", { clientIdempotencyKey: "k1" });
		let limiterCalls = 0;
		const retry = await commands.duplicateClip(actor, PROJECT, "clip-0", {
			clientIdempotencyKey: "k1",
			beforeAccept: async () => {
				limiterCalls += 1;
				throw new Error("limiter is exhausted");
			},
		});
		expect(retry).toMatchObject({ replayed: true, clip: { id: "clip-1" } });
		expect(fake.state.prepared).toBe(1);
		expect(limiterCalls).toBe(0);
		expect(receipts.clipRows()).toEqual(["clip-1"]);
	});

	test("a replay is authorized against current access first", async () => {
		const { commands, authorizations } = build();
		await commands.createClipFromRange(actor, PROJECT, { startSec: 1, endSec: 9 }, { clientIdempotencyKey: "k1" });
		authorizations.length = 0;
		await commands.createClipFromRange(actor, PROJECT, { startSec: 1, endSec: 9 }, { clientIdempotencyKey: "k1" });
		expect(authorizations).toEqual(["user-a@workspace-a"]);
	});

	test("the same key with different input conflicts and creates nothing", async () => {
		const { commands, receipts, fake } = build();
		await commands.createClipFromRange(actor, PROJECT, { startSec: 1, endSec: 9 }, { clientIdempotencyKey: "k1" });
		await expect(
			commands.createClipFromRange(actor, PROJECT, { startSec: 2, endSec: 9 }, { clientIdempotencyKey: "k1" }),
		).rejects.toBeInstanceOf(OperationIdempotencyConflictError);
		expect(fake.state.prepared).toBe(1);
		expect(receipts.clipRows()).toEqual(["clip-1"]);
	});

	test("a duplicate and a range create with one key are different commands", async () => {
		const { commands, receipts } = build();
		await commands.duplicateClip(actor, PROJECT, "clip-0", { clientIdempotencyKey: "k1" });
		const range = await commands.createClipFromRange(actor, PROJECT, { startSec: 1, endSec: 9 }, { clientIdempotencyKey: "k1" });
		expect(range.replayed).toBe(false);
		expect(receipts.receipts()).toBe(2);
	});

	test("a selection create retried after a lost response returns the accepted clip, never a second", async () => {
		const { commands, receipts, fake } = build();
		const range = { startSec: 1, endSec: 9 };
		const first = await commands.createClipFromSelection(actor, PROJECT, "clip-0", range, { clientIdempotencyKey: "k1" });
		const retry = await commands.createClipFromSelection(actor, PROJECT, "clip-0", range, { clientIdempotencyKey: "k1" });
		expect(first.replayed).toBe(false);
		expect(retry).toMatchObject({ replayed: true, clip: { id: "clip-1" } });
		expect(fake.state.created).toBe(1);
		expect(receipts.clipRows()).toEqual(["clip-1"]);
		// The source clip is part of the durable input.
		await expect(
			commands.createClipFromSelection(actor, PROJECT, "clip-9", range, { clientIdempotencyKey: "k1" }),
		).rejects.toBeInstanceOf(OperationIdempotencyConflictError);
	});

	test("an exhausted limiter refuses new work before any media is copied", async () => {
		const { commands, receipts, fake } = build();
		await expect(
			commands.duplicateClip(actor, PROJECT, "clip-0", {
				clientIdempotencyKey: "k1",
				beforeAccept: async () => {
					throw new Error("rate_limited");
				},
			}),
		).rejects.toThrow("rate_limited");
		expect(fake.state.prepared).toBe(0);
		expect(receipts.receipts()).toBe(0);
	});

	// Sol wave-B B03: the early limiter refusal must not hide a receipt a concurrent request just committed.
	describe.each([
		["exhausted", "rate_limited"],
		["unavailable", "mutations_unavailable"],
	])("a %s limiter that refuses while the same key is being accepted", (_outcome, refusal) => {
		test("returns the accepted clip instead of the refusal", async () => {
			const { commands, receipts, fake } = build();
			const winner = build(fake, receipts);
			const outcome = await commands.duplicateClip(actor, PROJECT, "clip-0", {
				clientIdempotencyKey: "k1",
				beforeAccept: async () => {
					// A concurrent request commits between our replay read and the limiter's refusal.
					await winner.commands.duplicateClip(actor, PROJECT, "clip-0", { clientIdempotencyKey: "k1" });
					throw new Error(refusal);
				},
			});
			expect(outcome).toMatchObject({ replayed: true, clip: { id: "clip-1" } });
			expect(fake.state.prepared).toBe(1);
			expect(receipts.clipRows()).toEqual(["clip-1"]);
		});

		test("a concurrent acceptance of different input is still a conflict, not the refusal", async () => {
			const { commands, receipts, fake } = build();
			const winner = build(fake, receipts);
			await expect(
				commands.createClipFromRange(actor, PROJECT, { startSec: 2, endSec: 9 }, {
					clientIdempotencyKey: "k1",
					beforeAccept: async () => {
						await winner.commands.createClipFromRange(actor, PROJECT, { startSec: 1, endSec: 9 }, { clientIdempotencyKey: "k1" });
						throw new Error(refusal);
					},
				}),
			).rejects.toBeInstanceOf(OperationIdempotencyConflictError);
		});
	});

	test("a failed insert leaves neither a receipt nor a half-created clip", async () => {
		const { commands, receipts } = build(fakeClips({ failWrite: true }));
		await expect(
			commands.duplicateClip(actor, PROJECT, "clip-0", { clientIdempotencyKey: "k1" }),
		).rejects.toThrow("insert failed");
		expect(receipts.receipts()).toBe(0);
		expect(receipts.clipRows()).toEqual([]);
	});

	test("two simultaneous requests with one key accept a single clip", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { commands, receipts } = build(fakeClips({ beforeAccept: gate }));
		const first = commands.duplicateClip(actor, PROJECT, "clip-0", { clientIdempotencyKey: "k1" });
		const second = commands.duplicateClip(actor, PROJECT, "clip-0", { clientIdempotencyKey: "k1" });
		// Both pass the replay lookup and prepare; only one can accept.
		await Bun.sleep(5);
		release();
		const outcomes = await Promise.all([first, second]);
		expect(outcomes.map((outcome) => outcome.replayed).sort()).toEqual([false, true]);
		expect(outcomes[0].clip.id).toBe(outcomes[1].clip.id);
		expect(receipts.clipRows()).toEqual(["clip-1"]);
		expect(receipts.receipts()).toBe(1);
	});

	test("a lost commit response resolves to the accepted clip", async () => {
		const receipts = harness();
		const persistence = {
			...receipts.persistence,
			transaction: async <T,>(run: (tx: Prisma.TransactionClient) => Promise<T>) => {
				await receipts.persistence.transaction(run);
				throw new Error("commit response lost");
			},
		};
		const commands = createClipsCommands({
			persistence,
			clips: fakeClips().service as never,
			requireEditor: async () => {},
		});
		const outcome = await commands.duplicateClip(actor, PROJECT, "clip-0", { clientIdempotencyKey: "k1" });
		expect(outcome).toMatchObject({ replayed: true, clip: { id: "clip-1" } });
		expect(receipts.clipRows()).toEqual(["clip-1"]);
	});
});
