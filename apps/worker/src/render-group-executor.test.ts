import { expect, test } from "bun:test";
import {
	RenderGroupAttemptLost,
	WorkflowAttemptLost,
	type ClaimedRenderGroupAttempt,
} from "@narriflow/services";
import {
	coordinateRenderWorkSet,
	executeNextRenderGroup,
} from "./render-group-executor";
import { RenderResourceDeferral } from "./render-resource-budget";
import { WorkerProcessFailure } from "./worker-process";

const group: ClaimedRenderGroupAttempt = {
	workflowRunId: "run",
	workSetGeneration: "generation",
	groupId: "group",
	token: "token",
	owner: "owner",
	projectId: "project",
	clipId: "clip",
	exportIdentity: "identity",
	chargedAttemptCount: 0,
	leaseExpiresAt: new Date(Date.now() + 120_000),
	memberIds: ["variant"],
};

function fakeGroups(options: { claims?: number } = {}) {
	const calls: string[] = [];
	let remaining = options.claims ?? 1;
	const settlement = {
		status: "completed" as const,
		requested: 1,
		succeeded: 1,
		failed: 0,
		superseded: 0,
		retryVariantIds: [],
		nextAttemptAt: null,
	};
	return {
		calls,
		releases: [] as string[],
		finishes: [] as Array<{ errorCode: string | null; failureDisposition: string | null }>,
		starts: [] as Array<{ sourceFingerprint: string; toolchainFingerprint: string }>,
		heartbeat: async () => {
			calls.push("heartbeat");
		},
		leaseDurationMs: 120_000,
		claim: async () => (remaining-- > 0 ? group : null),
		start: async function (this: { starts: unknown[] }, input: never) {
			calls.push("start");
			this.starts.push(input);
		},
		finish: async function (this: { finishes: unknown[] }, input: never) {
			calls.push("finish");
			this.finishes.push(input);
			return settlement;
		},
		release: async function (this: { releases: string[] }, input: { reason: string }) {
			calls.push(`release:${input.reason}`);
			this.releases.push(input.reason);
			return true;
		},
	};
}

type Groups = ReturnType<typeof fakeGroups>;
const asLifecycle = (groups: Groups) =>
	({
		...groups,
		start: groups.start.bind(groups),
		finish: groups.finish.bind(groups),
		release: groups.release.bind(groups),
	}) as never;

const spawnFailure = new WorkerProcessFailure(
	"worker_command_spawn_failed",
	"retryable",
	"spawn EBADF",
	"",
	null,
	{ failureScope: "executor", errno: "EBADF", executableClass: "ffmpeg" },
);

test("no queued group is a quiet tick", async () => {
	const groups = fakeGroups({ claims: 0 });
	const processed = await executeNextRenderGroup({
		groups: asLifecycle(groups),
		toolchainFingerprint: "tool",
		render: async () => {
			throw new Error("must not render");
		},
	});
	expect(processed).toBe(0);
});

test("a claimed group is rendered with its token as the attempt id and settled by the engine", async () => {
	const groups = fakeGroups();
	let seen: unknown;
	const processed = await executeNextRenderGroup({
		groups: asLifecycle(groups),
		toolchainFingerprint: "tool",
		render: async ({ attempt, lifecycle }) => {
			seen = attempt;
			expect(await lifecycle.beginRenderGroup(attempt)).toEqual({ variantIds: ["variant"] });
			await lifecycle.startExecution(attempt, { sourceFingerprint: "src#1" });
			await lifecycle.startExecution(attempt, { sourceFingerprint: "src#1" });
			return lifecycle.finishRenderGroup(attempt);
		},
	});
	expect(processed).toBe(1);
	expect(seen).toMatchObject({ attemptId: "token", workflowRunId: "run", projectId: "project" });
	// Start is recorded once, with the replica's verified toolchain.
	expect(groups.starts).toEqual([
		expect.objectContaining({ sourceFingerprint: "src#1", toolchainFingerprint: "tool" }),
	]);
	expect(groups.releases).toEqual([]);
});

test("repeated pre-start executor failures release uncharged and the quarantined executor stops claiming", async () => {
	const groups = fakeGroups({ claims: 8 });
	let ready = true;
	let failures = 0;
	for (let tick = 0; tick < 8; tick++) {
		await executeNextRenderGroup({
			groups: asLifecycle(groups),
			toolchainFingerprint: "tool",
			canStart: () => ready,
			onExecutorFailure: () => {
				failures += 1;
				ready = false;
			},
			render: async () => {
				throw spawnFailure;
			},
		});
	}
	expect(failures).toBe(1);
	expect(groups.releases).toEqual(["pre_start_rejection"]);
	expect(groups.calls.filter((call) => call === "start")).toEqual([]);
});

test("a resource deferral before any media releases without a charge", async () => {
	const groups = fakeGroups();
	await executeNextRenderGroup({
		groups: asLifecycle(groups),
		toolchainFingerprint: "tool",
		render: async () => {
			throw new RenderResourceDeferral("render_scratch_disk_low", "disk pressure", 30);
		},
	});
	expect(groups.releases).toEqual(["pre_start_rejection"]);
	expect(groups.finishes).toEqual([]);
});

test("an executor failure after the durable start releases as a refunded interruption", async () => {
	const groups = fakeGroups();
	await executeNextRenderGroup({
		groups: asLifecycle(groups),
		toolchainFingerprint: "tool",
		render: async ({ attempt, lifecycle }) => {
			await lifecycle.startExecution(attempt, { sourceFingerprint: "src" });
			throw spawnFailure;
		},
	});
	expect(groups.releases).toEqual(["shutdown"]);
});

test("worker shutdown aborts the render and releases the group", async () => {
	const groups = fakeGroups();
	const shutdown = new AbortController();
	let seenAbort = false;
	await executeNextRenderGroup({
		groups: asLifecycle(groups),
		toolchainFingerprint: "tool",
		signal: shutdown.signal,
		render: async ({ context }) => {
			shutdown.abort(new DOMException("shutdown", "AbortError"));
			seenAbort = context.signal.aborted;
			context.signal.throwIfAborted();
		},
	});
	expect(seenAbort).toBe(true);
	expect(groups.releases).toEqual(["shutdown"]);
});

test("shutdown during the claim releases the claimed group without rendering it", async () => {
	const groups = fakeGroups();
	const shutdown = new AbortController();
	const claim = groups.claim;
	groups.claim = async () => {
		const claimed = await claim();
		shutdown.abort();
		return claimed;
	};
	const processed = await executeNextRenderGroup({
		groups: asLifecycle(groups),
		toolchainFingerprint: "tool",
		signal: shutdown.signal,
		render: async () => {
			throw new Error("must not render");
		},
	});
	expect(processed).toBe(0);
	expect(groups.releases).toEqual(["shutdown"]);
});

test("a lost group lease aborts the render and writes nothing", async () => {
	const groups = fakeGroups();
	groups.heartbeat = async () => {
		throw new RenderGroupAttemptLost(group);
	};
	let aborted = false;
	const processed = await executeNextRenderGroup({
		groups: asLifecycle(groups),
		toolchainFingerprint: "tool",
		heartbeatIntervalMs: 5,
		render: ({ context }) =>
			new Promise((_resolve, reject) => {
				context.signal.addEventListener("abort", () => {
					aborted = true;
					reject(context.signal.reason);
				});
			}),
	});
	expect(processed).toBe(1);
	expect(aborted).toBe(true);
	expect(groups.releases).toEqual([]);
	expect(groups.finishes).toEqual([]);
});

test("a heartbeat loss reported after the group settled is ignored", async () => {
	const groups = fakeGroups();
	groups.heartbeat = async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
		throw new RenderGroupAttemptLost(group);
	};
	const processed = await executeNextRenderGroup({
		groups: asLifecycle(groups),
		toolchainFingerprint: "tool",
		heartbeatIntervalMs: 5,
		render: async ({ attempt, lifecycle }) => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			const outcome = await lifecycle.finishRenderGroup(attempt);
			await new Promise((resolve) => setTimeout(resolve, 40));
			return outcome;
		},
	});
	expect(processed).toBe(1);
	expect(groups.releases).toEqual([]);
});

test("an unexpected failure settles the group as a charged retryable failure and surfaces", async () => {
	const groups = fakeGroups();
	await expect(
		executeNextRenderGroup({
			groups: asLifecycle(groups),
			toolchainFingerprint: "tool",
			render: async () => {
				throw new Error("database unavailable");
			},
		}),
	).rejects.toThrow("database unavailable");
	expect(groups.calls).toEqual(["start", "finish"]);
	expect(groups.finishes).toEqual([
		expect.objectContaining({ failureDisposition: "retryable" }),
	]);
});

function coordinator(statuses: Array<"pending" | "completed">, admitted = false) {
	const calls: string[] = [];
	return {
		calls,
		lifecycle: {
			beginRenderWorkSet: async () => {
				calls.push("begin");
				return { workflowRunId: "run", frozenAt: new Date(), variantIds: ["variant"] };
			},
			admitRenderGroups: async (_attempt: unknown, groups: readonly unknown[]) => {
				calls.push(`admit:${groups.length}`);
				return [];
			},
			settleRenderWorkSet: async () => {
				calls.push("settle");
				const status = statuses.shift() ?? "completed";
				return { status, requested: 1, succeeded: 0, failed: 0, superseded: 0, followUpWorkflowRunId: null };
			},
		} as never,
		state: {
			planRenderGroups: async () => (admitted ? null : [{ configuration: {}, variantIds: ["variant"] }]),
		} as never,
	};
}

const attempt = { workflowRunId: "run", projectId: "project", stage: "clip_rendering", attemptId: "a", attemptCount: 1 } as const;
const context = () => ({ signal: new AbortController().signal, reportProgress: async () => {} });

test("the coordinator admits the partition once and waits until the parent settles", async () => {
	const harness = coordinator(["pending", "pending", "completed"]);
	const outcome = await coordinateRenderWorkSet({
		attempt,
		context: context(),
		lifecycle: harness.lifecycle,
		state: harness.state,
		pollIntervalMs: 1,
		sleep: async () => {},
	});
	expect(outcome.status).toBe("completed");
	expect(harness.calls).toEqual(["begin", "admit:1", "settle", "settle", "settle"]);
});

test("a reclaiming coordinator keeps the stored membership and only waits", async () => {
	const harness = coordinator(["completed"], true);
	await coordinateRenderWorkSet({
		attempt,
		context: context(),
		lifecycle: harness.lifecycle,
		state: harness.state,
		pollIntervalMs: 1,
		sleep: async () => {},
	});
	expect(harness.calls).toEqual(["begin", "settle"]);
});

test("the coordinator stops waiting when its attempt is cancelled", async () => {
	const harness = coordinator(["pending", "pending", "pending"]);
	const controller = new AbortController();
	await expect(
		coordinateRenderWorkSet({
			attempt,
			context: { signal: controller.signal, reportProgress: async () => {} },
			lifecycle: harness.lifecycle,
			state: harness.state,
			pollIntervalMs: 1,
			sleep: async () => {
				controller.abort(new WorkflowAttemptLost(attempt));
			},
		}),
	).rejects.toBeInstanceOf(WorkflowAttemptLost);
	expect(harness.calls.filter((call) => call === "settle")).toHaveLength(1);
});
