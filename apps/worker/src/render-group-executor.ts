/**
 * Render Group execution on a replica.
 *
 * A Clip Render run is one parent Workflow Run. Its coordinator attempt admits
 * the frozen partition and waits for settlement; it never encodes. Each replica
 * claims whole Render Groups (one clip and export configuration) through
 * fenced leases, renders one group at a time on its single CPU lane, and
 * persists with that group's token. Several replicas therefore finish
 * different groups of the same project concurrently.
 */
import {
	RenderGroupAttemptLost,
	WorkflowAttemptLost,
	workflowFailureFromUnknown,
	type ClaimedRenderGroupAttempt,
	type RenderGroupLifecycle,
	type RenderGroupSettlement,
	type WorkflowAttemptContext,
	type WorkflowAttemptRef,
	type clipService,
	type getWorkflowRunLifecycle,
} from "@narriflow/services";
import { productionRenderDiagnosticAdapter } from "./render-diagnostic-adapter";
import { RenderResourceDeferral } from "./render-resource-budget";
import { executorProcessFailure, type WorkerProcessFailure } from "./worker-process";
import type {
	ClipRenderAttemptLifecycle,
	ClipRenderingWorkflowAttempt,
	RenderGroupOutcome,
} from "./tasks/clip-render-attempt";

type GroupLifecycle = Pick<
	RenderGroupLifecycle,
	"claim" | "heartbeat" | "start" | "finish" | "release" | "leaseDurationMs"
>;

function log(level: "info" | "warn" | "error", message: string, context: Record<string, unknown>): void {
	productionRenderDiagnosticAdapter.diagnose({ level: level === "info" ? "info" : "error", message, context });
}

function groupLogContext(group: ClaimedRenderGroupAttempt): Record<string, unknown> {
	return {
		workflowRunId: group.workflowRunId,
		projectId: group.projectId,
		groupId: group.groupId,
		groupToken: group.token,
		owner: group.owner,
		clipId: group.clipId,
	};
}

/** What the engine sees of a claimed group: the group token is its attempt id. */
export function renderGroupExecutionAttempt(group: ClaimedRenderGroupAttempt): ClipRenderingWorkflowAttempt {
	return {
		workflowRunId: group.workflowRunId,
		projectId: group.projectId,
		stage: "clip_rendering",
		attemptId: group.token,
		attemptCount: group.chargedAttemptCount,
	};
}

/** The engine's ownership-loss control flow is `WorkflowAttemptLost`. */
export function asAttemptLost<T>(attempt: WorkflowAttemptRef, operation: () => Promise<T>): Promise<T> {
	return operation().catch((error: unknown) => {
		throw error instanceof RenderGroupAttemptLost ? new WorkflowAttemptLost(attempt) : error;
	});
}

/** Facts one group execution shares between its lifecycle adapter and executor. */
export interface RenderGroupLedger {
	startPromise: Promise<void> | null;
	/** True once the durable start committed (the execution is charged). */
	started: boolean;
	/** Set while `finish` is in flight so a late heartbeat loss cannot hide it. */
	settlement: Promise<unknown> | undefined;
	finished: boolean;
}

export function newRenderGroupLedger(): RenderGroupLedger {
	return { startPromise: null, started: false, settlement: undefined, finished: false };
}

/** Bridges the engine's lifecycle port to the fenced group protocol. */
export function renderGroupAttemptLifecycle(input: {
	groups: Pick<RenderGroupLifecycle, "start" | "finish">;
	group: ClaimedRenderGroupAttempt;
	toolchainFingerprint: string;
	ledger: RenderGroupLedger;
}): ClipRenderAttemptLifecycle {
	const { groups, group, toolchainFingerprint, ledger } = input;
	const ref = {
		workflowRunId: group.workflowRunId,
		workSetGeneration: group.workSetGeneration,
		groupId: group.groupId,
		token: group.token,
		owner: group.owner,
	};
	const attempt = renderGroupExecutionAttempt(group);
	return {
		beginRenderGroup: async () => ({ variantIds: group.memberIds }),
		startExecution: (_attempt, facts) => {
			ledger.startPromise ??= asAttemptLost(attempt, () =>
				groups.start({
					...ref,
					sourceFingerprint: facts.sourceFingerprint,
					analysisFingerprint: null,
					toolchainFingerprint,
				}),
			).then(() => {
				ledger.started = true;
			});
			return ledger.startPromise;
		},
		finishRenderGroup: async (): Promise<RenderGroupOutcome> => {
			const settling = asAttemptLost(attempt, () =>
				groups.finish({ ...ref, result: "completed", errorCode: null, failureDisposition: null }),
			);
			ledger.settlement = settling;
			const decision: RenderGroupSettlement | null = await settling;
			ledger.finished = true;
			if (!decision) {
				// A replay after the group already settled; its decision is durable.
				return { status: "completed", requested: group.memberIds.length, succeeded: 0, failed: 0, superseded: 0 };
			}
			return {
				status: decision.status,
				requested: decision.requested,
				succeeded: decision.succeeded,
				failed: decision.failed,
				superseded: decision.superseded,
			};
		},
	};
}

interface GroupLeaseHandle {
	context: WorkflowAttemptContext;
}

/** Heartbeats a group lease while `work` runs; aborts it on lease loss. */
async function withGroupLease<T>(input: {
	groups: GroupLifecycle;
	group: ClaimedRenderGroupAttempt;
	ledger: RenderGroupLedger;
	signal?: AbortSignal;
	heartbeatIntervalMs: number;
	work: (handle: GroupLeaseHandle) => Promise<T>;
}): Promise<T> {
	const { groups, group, ledger } = input;
	const attempt = renderGroupExecutionAttempt(group);
	const controller = new AbortController();
	const stopForWorker = () => controller.abort(input.signal?.reason);
	if (input.signal?.aborted) stopForWorker();
	input.signal?.addEventListener("abort", stopForWorker, { once: true });
	let lost: WorkflowAttemptLost | null = null;
	let lastBeatAt = performance.now();
	let inFlight = false;
	let checkingLoss = false;
	const confirmLoss = async () => {
		if (checkingLoss || ledger.finished || lost) return;
		checkingLoss = true;
		try {
			// A finishing transaction clears the token itself; its outcome decides.
			await ledger.settlement?.catch(() => undefined);
			if (ledger.finished || lost) return;
			lost = new WorkflowAttemptLost(attempt);
			controller.abort(lost);
		} finally {
			checkingLoss = false;
		}
	};
	const timer = setInterval(() => {
		if (controller.signal.aborted || lost || ledger.finished) return;
		if (performance.now() - lastBeatAt >= groups.leaseDurationMs) {
			void confirmLoss();
			return;
		}
		if (inFlight) return;
		inFlight = true;
		const startedAt = performance.now();
		void groups
			.heartbeat(group)
			.then(() => {
				lastBeatAt = startedAt;
			})
			.catch(async (error: unknown) => {
				if (ledger.finished) return;
				if (error instanceof RenderGroupAttemptLost) {
					await confirmLoss();
					return;
				}
				// A connection error is not evidence of lost ownership; durable
				// writes stay fenced and the lease deadline above still bounds it.
				log("warn", "render_group_heartbeat_failed", groupLogContext(group));
			})
			.finally(() => {
				inFlight = false;
			});
	}, input.heartbeatIntervalMs);
	try {
		const result = await input.work({
			context: { signal: controller.signal, reportProgress: async () => {} },
		});
		if (lost) throw lost;
		return result;
	} catch (error) {
		if (lost) throw lost;
		throw error;
	} finally {
		clearInterval(timer);
		input.signal?.removeEventListener("abort", stopForWorker);
	}
}

/**
 * Claims and renders at most one group. Returns 1 when a group was claimed.
 * `render` runs the engine against the group; it settles the group itself
 * (`finishRenderGroup`). This function only handles interruptions: lost
 * leases belong to the reaper, and shutdown, unready executors and resource
 * deferrals release the group (never charging work that did not run).
 */
export async function executeNextRenderGroup(input: {
	groups: GroupLifecycle;
	toolchainFingerprint: string;
	render(execution: {
		group: ClaimedRenderGroupAttempt;
		attempt: ClipRenderingWorkflowAttempt;
		lifecycle: ClipRenderAttemptLifecycle;
		context: WorkflowAttemptContext;
	}): Promise<unknown>;
	/** Worker lifetime cancellation. */
	signal?: AbortSignal;
	canStart?: () => boolean;
	onExecutorFailure?: (failure: WorkerProcessFailure) => void;
	holdingLease?: <T>(work: () => Promise<T>) => Promise<T>;
	heartbeatIntervalMs?: number;
}): Promise<0 | 1> {
	if (input.signal?.aborted || input.canStart?.() === false) return 0;
	const group = await input.groups.claim();
	if (!group) return 0;
	const release = async (reason: "pre_start_rejection" | "shutdown") => {
		try {
			await input.groups.release({ ...group, reason });
		} catch (error) {
			if (error instanceof RenderGroupAttemptLost) return;
			log("error", "render_group_release_failed", { ...groupLogContext(group), reason });
		}
	};
	if (input.signal?.aborted || input.canStart?.() === false) {
		await release(input.signal?.aborted ? "shutdown" : "pre_start_rejection");
		return 0;
	}
	const ledger = newRenderGroupLedger();
	const lifecycle = renderGroupAttemptLifecycle({
		groups: input.groups,
		group,
		toolchainFingerprint: input.toolchainFingerprint,
		ledger,
	});
	const attempt = renderGroupExecutionAttempt(group);
	const startedAtMs = Date.now();
	log("info", "render_group_claimed", {
		...groupLogContext(group),
		chargedAttemptCount: group.chargedAttemptCount,
		memberCount: group.memberIds.length,
	});
	const execute = () =>
		withGroupLease({
			groups: input.groups,
			group,
			ledger,
			signal: input.signal,
			heartbeatIntervalMs: input.heartbeatIntervalMs ?? 30_000,
			work: ({ context }) => input.render({ group, attempt, lifecycle, context }),
		});
	try {
		await (input.holdingLease ? input.holdingLease(execute) : execute());
		log("info", "render_group_settled", { ...groupLogContext(group), elapsedMs: Date.now() - startedAtMs, replicaBusyMs: Date.now() - startedAtMs, memberCount: group.memberIds.length });
		return 1;
	} catch (error) {
		if (error instanceof WorkflowAttemptLost || error instanceof RenderGroupAttemptLost) {
			// The reaper (or a newer claim) owns the group now; nothing is written here.
			log("warn", "render_group_lost", { ...groupLogContext(group), elapsedMs: Date.now() - startedAtMs });
			return 1;
		}
		// An in-flight start decides whether the interrupted execution was charged.
		await ledger.startPromise?.catch(() => undefined);
		const healthFailure = executorProcessFailure(error);
		const deferral = error instanceof RenderResourceDeferral;
		if (healthFailure || deferral || input.signal?.aborted) {
			if (healthFailure) input.onExecutorFailure?.(healthFailure);
			await release(ledger.started || input.signal?.aborted ? "shutdown" : "pre_start_rejection");
			log("warn", "render_group_released", {
				...groupLogContext(group),
				reason: healthFailure?.code ?? (deferral ? error.code : "worker_shutdown"),
				started: ledger.started,
 counts: { executor: healthFailure ? 1 : 0, deferral: deferral ? 1 : 0 },
 disposition: healthFailure ? "executor" : deferral ? "deferral" : "control",
				elapsedMs: Date.now() - startedAtMs,
			});
			return 0;
		}
		if (!ledger.finished) {
			// Unexpected failure outside the engine's own handling: settle the group
			// as a retryable failure so its lease is not left to expire.
			const failure = workflowFailureFromUnknown(error);
			try {
				await lifecycle.startExecution(attempt, { sourceFingerprint: "unresolved" });
				await input.groups.finish({
					workflowRunId: group.workflowRunId,
					workSetGeneration: group.workSetGeneration,
					groupId: group.groupId,
					token: group.token,
					owner: group.owner,
					result: "failed",
					errorCode: failure.code,
					failureDisposition: failure.disposition,
				});
			} catch {
				/* The lease expires and the reaper settles it. */
			}
		}
		throw error;
	}
}

/**
 * Coordinator attempt for a clip_rendering run: freeze and admit the group
 * partition, then keep the parent lease alive while replicas render groups.
 * Returns the parent's terminal settlement. It performs no media work.
 */
export async function coordinateRenderWorkSet(input: {
	attempt: WorkflowAttemptRef;
	context: WorkflowAttemptContext;
	lifecycle: Pick<
		ReturnType<typeof getWorkflowRunLifecycle>,
		"beginRenderWorkSet" | "admitRenderGroups" | "settleRenderWorkSet"
	>;
	state: Pick<typeof clipService, "planRenderGroups">;
	pollIntervalMs: number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
	const { attempt, context, lifecycle } = input;
	const sleep = input.sleep ?? sleepUnlessAborted;
	context.signal.throwIfAborted();
	await lifecycle.beginRenderWorkSet(attempt);
	const groups = await input.state.planRenderGroups(attempt.projectId, attempt.workflowRunId);
	if (groups) await lifecycle.admitRenderGroups(attempt, groups);
	for (;;) {
		context.signal.throwIfAborted();
		const outcome = await lifecycle.settleRenderWorkSet(attempt);
		if (outcome.status !== "pending") return outcome;
		await sleep(input.pollIntervalMs, context.signal);
	}
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
