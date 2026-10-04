import { describe, expect, test } from "bun:test";
import {
	createMcpOperationExecutor,
	mcpOperationFingerprint,
	McpOperationConflictError,
	type McpOperationPersistence,
	type McpOperationReceipt,
} from "./mcp-operation";

test("request fingerprints use locale-independent Unicode key order", () => {
	// UTF-8 SHA-256 of {"z":2,"ä":1}; code-point order places z before ä.
	expect(mcpOperationFingerprint({ "ä": 1, z: 2 })).toBe(
		"896b8dd27b9b539d56c30c96acce8910a2293d7bef3fc3ef87195bc2eb778073",
	);
	expect(mcpOperationFingerprint({ z: 2, "ä": 1 })).toBe(
		"896b8dd27b9b539d56c30c96acce8910a2293d7bef3fc3ef87195bc2eb778073",
	);
});

function harness(options: { loseCommitResponse?: boolean } = {}) {
	let receipts = new Map<string, McpOperationReceipt>();
	let domainWrites = 0;
	let tail = Promise.resolve();
	const key = (identity: import("./mcp-operation").McpOperationIdentity) =>
		JSON.stringify([
			identity.workspaceId,
			identity.callerId,
			identity.toolName,
			identity.clientIdempotencyKey,
		]);
	const persistence: McpOperationPersistence<{ write(): number }> = {
		read: async (identity) => receipts.get(key(identity)) ?? null,
		transaction: async (run) => {
			const previous = tail;
			let unlock!: () => void;
			tail = new Promise<void>((resolve) => {
				unlock = resolve;
			});
			await previous;
			const oldReceipts = new Map(receipts);
			const oldWrites = domainWrites;
			try {
				return await run({ write: () => ++domainWrites });
			} catch (error) {
				receipts = oldReceipts;
				domainWrites = oldWrites;
				throw error;
			} finally {
				unlock();
			}
		},
		lock: async () => {},
		readInTransaction: async (_tx, identity) =>
			receipts.get(key(identity)) ?? null,
		create: async (_tx, receipt) => {
			receipts.set(key(receipt), receipt);
		},
	};
	return {
		execute: createMcpOperationExecutor({
			...persistence,
			transaction: async (run) => {
				const accepted = await persistence.transaction(run);
				if (options.loseCommitResponse) throw new Error("Commit response lost");
				return accepted;
			},
		}).execute,
		writes: () => domainWrites,
	};
}

const identity = {
	workspaceId: "workspace-a",
	callerId: "caller-a",
	toolName: "narriflow_create_rss_rule",
	clientIdempotencyKey: "request-a",
};

describe("MCP mutation acceptance", () => {
	test("resolves an acceptance whose commit response was lost", async () => {
		const h = harness({ loseCommitResponse: true });
		const accepted = await h.execute({
			identity,
			input: {},
			authorize: async () => {},
			mutate: async (tx) => ({
				resourceType: "project",
				resourceId: "project-a",
				value: { count: tx.write() },
			}),
		});
		expect(accepted.value).toEqual({ count: 1 });
		expect(accepted.replayed).toBe(true);
		expect(h.writes()).toBe(1);
	});

	test("replays a concurrent acceptance when this request's remote preparation fails", async () => {
		const h = harness();
		let prepared!: () => void;
		let failPreparation!: () => void;
		const started = new Promise<void>((resolve) => {
			prepared = resolve;
		});
		const interrupted = new Promise<void>((resolve) => {
			failPreparation = resolve;
		});
		const failed = h.execute({
			identity,
			input: {},
			authorize: async () => {},
			prepare: async () => {
				prepared();
				await interrupted;
				throw new Error("Provider unavailable");
			},
			mutate: async () => {
				throw new Error("Must not mutate");
			},
		});
		await started;
		const first = await h.execute({
			identity,
			input: {},
			authorize: async () => {},
			mutate: async (tx) => ({
				resourceType: "project",
				resourceId: "project-a",
				value: { count: tx.write() },
			}),
		});
		failPreparation();
		const replay = await failed;
		expect(replay.operationId).toBe(first.operationId);
		expect(replay.value).toEqual(first.value);
		expect(h.writes()).toBe(1);
	});

	test("replays the accepted result before unavailable admission while checking current authority", async () => {
		const h = harness();
		let authorizations = 0;
		const first = await h.execute({
			identity,
			input: { name: "Daily", interval: 60 },
			authorize: async () => {
				authorizations++;
			},
			mutate: async (tx) => ({
				resourceType: "autopilot_rule",
				resourceId: "rule-a",
				value: { ruleId: "rule-a", number: tx.write() },
			}),
		});
		const replay = await h.execute({
			identity,
			input: { interval: 60, name: "Daily" },
			authorize: async () => {
				authorizations++;
			},
			beforeAccept: async () => {
				throw new Error("limiter unavailable");
			},
			mutate: async () => {
				throw new Error("must not mutate");
			},
		});
		expect(replay.value).toEqual({ ruleId: "rule-a", number: 1 });
		expect(replay.operationId).toBe(first.operationId);
		expect(replay.replayed).toBe(true);
		expect(h.writes()).toBe(1);
		expect(authorizations).toBe(2);
	});
	test("conflicts on changed input and never performs a second mutation", async () => {
		const h = harness();
		const request = {
			identity,
			input: { caption: "First" },
			authorize: async () => {},
			mutate: async (tx: { write(): number }) => ({
				resourceType: "social_post",
				resourceId: "post-a",
				value: { count: tx.write() },
			}),
		};
		await h.execute(request);
		await expect(
			h.execute({ ...request, input: { caption: "Changed" } }),
		).rejects.toBeInstanceOf(McpOperationConflictError);
		expect(h.writes()).toBe(1);
	});

	test("a revoked actor cannot replay previously accepted work", async () => {
		const h = harness();
		const request = {
			identity,
			input: {},
			authorize: async () => {},
			mutate: async (tx: { write(): number }) => ({
				resourceType: "project",
				resourceId: "project-a",
				value: { count: tx.write() },
			}),
		};
		await h.execute(request);
		await expect(
			h.execute({
				...request,
				authorize: async () => {
					throw new Error("Membership removed");
				},
			}),
		).rejects.toThrow("Membership removed");
		expect(h.writes()).toBe(1);
	});

	test("concurrent duplicate callers accept one durable outcome", async () => {
		const h = harness();
		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				h.execute({
					identity,
					input: { source: "https://youtube.com/watch?v=example" },
					authorize: async () => {},
					mutate: async (tx) => ({
						resourceType: "ingest_job",
						resourceId: "job-a",
						value: { projectId: "project-a", count: tx.write() },
					}),
				}),
			),
		);
		expect(h.writes()).toBe(1);
		expect(new Set(results.map((result) => result.operationId)).size).toBe(1);
		expect(results.filter((result) => !result.replayed).length).toBe(1);
	});

	test("an unavailable limiter pauses a new request without accepting its key", async () => {
		const h = harness();
		const request = {
			identity,
			input: {},
			authorize: async () => {},
			mutate: async (tx: { write(): number }) => ({
				resourceType: "project",
				resourceId: "project-a",
				value: { count: tx.write() },
			}),
		};
		await expect(
			h.execute({
				...request,
				beforeAccept: async () => {
					throw new Error("Limiter unavailable");
				},
			}),
		).rejects.toThrow("Limiter unavailable");
		expect(h.writes()).toBe(0);
		expect((await h.execute(request)).replayed).toBe(false);
	});

	test("a failed acceptance rolls back domain work and leaves the key retryable", async () => {
		const h = harness();
		await expect(
			h.execute({
				identity,
				input: {},
				authorize: async () => {},
				mutate: async (tx) => {
					tx.write();
					throw new Error("Interrupted");
				},
			}),
		).rejects.toThrow("Interrupted");
		expect(h.writes()).toBe(0);
		const accepted = await h.execute({
			identity,
			input: {},
			authorize: async () => {},
			mutate: async (tx) => ({
				resourceType: "project",
				resourceId: "project-a",
				value: { count: tx.write() },
			}),
		});
		expect(accepted.value).toEqual({ count: 1 });
		expect(accepted.replayed).toBe(false);
	});

	test("request keys remain isolated by caller and workspace", async () => {
		const h = harness();
		for (const owner of [
			identity,
			{ ...identity, callerId: "caller-b" },
			{ ...identity, workspaceId: "workspace-b" },
		])
			await h.execute({
				identity: owner,
				input: {},
				authorize: async () => {},
				mutate: async (tx) => ({
					resourceType: "project",
					resourceId: `project-${tx.write()}`,
					value: {},
				}),
			});
		expect(h.writes()).toBe(3);
	});
});
