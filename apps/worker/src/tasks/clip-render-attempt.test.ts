import { RenderFactCache } from "../render-fact-cache";
import { RenderObjectReconciler } from "../render-object-reconciler";
import { createRenderOutputFixture } from "../render-output-validation.test-fixture";
import { createClipRenderAttempt } from "./clip-render-attempt-runtime";
import { expect, mock, spyOn, test } from "bun:test";
import * as database from "@narriflow/db/client";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clipService,
	analyticsService,
	type MotionRenderAnalyticsMetadata,
	type WorkflowAttemptContext,
	WorkflowAttemptLost,
	WorkflowFailure,
} from "@narriflow/services";
import { parseRenderConfig } from "../render-config";
import {
	productionWorkerProcessModule,
 WorkerProcessFailure,
	type WorkerProcessModule,
} from "../worker-process";
import {
	ClipRenderAttempt,
	type RenderGroupOutcome,
	type ClipRenderAttemptAdapters,
	type ClipRenderingWorkflowAttempt,
} from "./clip-render-attempt";
import {
	productionRenderClockAdapter,
	productionRenderWorkspaceAdapter,
} from "../render-runtime-adapters";

type PendingClipRender = Awaited<
	ReturnType<typeof clipService.getPendingClipRendersForWorkSet>
>[number];

function attemptContext(signal: AbortSignal): WorkflowAttemptContext {
	return { signal, reportProgress: async () => {} };
}

function frozenRenderingState(
	pendingRenders: PendingClipRender[],
	overrides: Partial<{
		sourceStorageKey: string | null;
		pricingTier: "free" | "creator";
	}> = {},
) {
	return {
		sourceStorageKey:
			overrides.sourceStorageKey === undefined
				? "projects/project/source/input.mp4"
				: overrides.sourceStorageKey,
		sourceDurationSeconds: 10,
 sourceSizeBytes: 4096,
		workspaceOwnerUserId: "user",
		workspaceId: "workspace",
		pricingTier: overrides.pricingTier ?? "creator",
		brandSnapshot: { status: "available" as const, value: null },
		pendingRenders,
	};
}

type OrdinaryTracerFailure =
	| "begin"
	| "state_load"
	| "presign"
	| "ranged_probe"
	| "download"
	| "local_probe"
	| "command"
	| "command_missing"
	| "command_timeout_before_output"
	| "command_timeout_after_output"
	| "command_nonzero_exit"
	| "upload"
	| "guarded_completion"
	| "guarded_completion_rejected"
	| "object_cleanup"
	| "settlement"
	| "cleanup";

type SourceFailure = Extract<
	OrdinaryTracerFailure,
	"presign" | "ranged_probe" | "download" | "local_probe"
>;

function createOrdinaryTracer(input: {
	attemptId: string;
	diagnoseThrows?: boolean;
	failure?: OrdinaryTracerFailure;
	failureMessage?: string;
	commandDiagnosticContext?: Record<string, unknown>;
	initialVariantState?: "pending" | "completed";
	outcome: RenderGroupOutcome;
	failureWriteRejects?: boolean;
	productionCompletion?: boolean;
	commitAcknowledgementLost?: boolean;
	completionControlFlow?: "cancellation" | "ownership_loss";
	cancelAfterUpload?: boolean;
	cleanupStalls?: boolean;
	referenceRead?: "rejected" | "stalled" | "referenced";
	waitForCommandAbort?: boolean;
	sourceFailures?: readonly SourceFailure[];
    sourceHealthFailure?: Error;
    commandHealthFailure?: Error;
	sourceInterruption?: {
		operation: SourceFailure;
		reason: "cancellation" | "ownership_loss";
	};
	presignNeverResolves?: boolean;
	presignedUrl?: string;
	productionMedia?: Pick<WorkerProcessModule, "inspectMedia">;
	sourceMode?: "ranged" | "download";
	superseded?: boolean;
	exportBound?: boolean;
	workspaceDirectory?: string;
	downloadFixturePath?: string;
	motionTransition?: boolean;
	groups?: unknown;
}) {
	const attempt: ClipRenderingWorkflowAttempt = {
		workflowRunId: "10000000-0000-0000-0000-000000000051",
		projectId: "20000000-0000-0000-0000-000000000052",
		stage: "clip_rendering",
		attemptId: input.attemptId,
		attemptCount: 1,
	};
	const pendingRender = {
		id: "variant-ordinary",
		clipId: "clip-ordinary",
		aspectRatio: "ratio_9_16",
		resolution: "1080p",
		exportVariantId: input.exportBound ? "export-variant-ordinary" : null,
		exportVariant: input.exportBound
			? {
					id: "export-variant-ordinary",
					exportId: "export-ordinary",
					watermark: false,
				}
			: null,
		clipSnapshot: null,
		clip: {
			id: "clip-ordinary",
			index: 0,
			startSec: 0,
			endSec: 10,
			llmModel: "test",
			transcriptSlice: [],
			deletedRanges: null,
			captionPreset: null,
			studioEdits: input.motionTransition
				? { transition: { type: "slide-left", durationSec: 0.35 } }
				: null,
			wholeSource: false,
			editorDocumentVersion: 1,
			sceneBlocks: [],
			censorSegments: [],
			mediaMotions: [],
			brollCues: null,
			brollUrl: null,
			category: "other",
		},
	} as unknown as PendingClipRender;
	const injectedError = new Error(`injected ${input.failure ?? "none"}`);
	const actions: string[] = [];
	const uploadedKeys: string[] = [];
	const objectReferences: string[] = [];
	const deletedKeys: string[] = [];
	const uploads: Array<{
		key: string;
		contentType: string | undefined;
		metadata: Record<string, string> | undefined;
	}> = [];
	const diagnostics: Array<{
		message: string;
		context?: Record<string, unknown>;
	}> = [];
	const failureMotionAnalytics: MotionRenderAnalyticsMetadata[] = [];
	let variantState:
		| "pending"
		| "rendering"
		| "completed"
		| "failed"
		| "superseded" = input.initialVariantState ?? "pending";
	let beginCalls = 0;
	let settlementCalls = 0;
	let clockNowMs = 1_000;
	let nextTimerId = 1;
	const scheduledTimers = new Map<
		number,
		{ callback: () => void; deadlineAtMs: number }
	>();
	const advanceClock = (elapsedMs: number): void => {
		clockNowMs += elapsedMs;
		const due = [...scheduledTimers.entries()]
			.filter(([, timer]) => timer.deadlineAtMs <= clockNowMs)
			.sort((left, right) => left[1].deadlineAtMs - right[1].deadlineAtMs);
		for (const [id, timer] of due) {
			scheduledTimers.delete(id);
			timer.callback();
		}
	};
	const sourceController = new AbortController();
	const completionControlError = input.completionControlFlow === "ownership_loss"
		? new WorkflowAttemptLost(attempt) : new DOMException("cancelled", "AbortError");
	const cleanupSignals: AbortSignal[] = [];
	let finishReferenceRead: ((keys: Set<string>) => void) | undefined;
	const shouldFail = (failure: SourceFailure) =>
		input.failure === failure || input.sourceFailures?.includes(failure);
	const interruptSource = (operation: SourceFailure): void => {
		if (input.sourceInterruption?.operation !== operation) return;
		const reason =
			input.sourceInterruption.reason === "ownership_loss"
				? new WorkflowAttemptLost(attempt)
				: new DOMException("cancelled", "AbortError");
		sourceController.abort(reason);
		throw reason;
	};

	const renderOutput = createRenderOutputFixture();
	const clipRenderAttempt = createClipRenderAttempt({
		group: { workflowRunId: "", workSetGeneration: "", groupId: "", token: "", owner: "" },
		groups: (input.groups ?? {}) as never,
		run: {
			id: attempt.workflowRunId,
			projectId: attempt.projectId,
			project: {
				title: "Ordinary tracer",
				sourceStorageKey: `projects/${attempt.projectId}/source/input.mp3`,
				sourceDurationSeconds: 10,
 sourceSizeBytes: 4096,
				workspaceOwnerUserId: "user",
				workspaceId: "workspace",
			},
		},
		config: parseRenderConfig({
			WORKER_RENDER_SOURCE_MODE: input.sourceMode ?? "download",
			...(input.presignNeverResolves ? { WORKER_STORAGE_TIMEOUT_MS: "5" } : {}),
			}),
		lifecycle: {
			startExecution: async () => {},
			beginRenderGroup: async () => {
				beginCalls += 1;
				actions.push("begin");
				if (input.failure === "begin") throw injectedError;
				return { variantIds: [pendingRender.id] };
			},
			finishRenderGroup: async () => {
				settlementCalls += 1;
				actions.push("settle");
				if (input.failure === "settlement") throw injectedError;
				if (input.outcome.status === "queued" && variantState === "failed") {
					variantState = "pending";
				}
				return input.outcome;
			},
		},
		adapters: {
   facts: new RenderFactCache(),
      composition: { compileCommand: renderOutput.compileCommand },
			state: {
				getProjectRenderStorageReferences: async (projectId) => {
					expect(projectId).toBe(attempt.projectId);
					actions.push("reference_read");
					if (input.referenceRead === "rejected") throw injectedError;
					if (input.referenceRead === "stalled") {
						advanceClock(5_000);
						return new Promise<Set<string>>((resolve) => {
							finishReferenceRead = resolve;
						});
					}
					return new Set(
						input.referenceRead === "referenced" ? uploadedKeys : objectReferences,
					);
				},
				getFrozenRenderingStateForWorkSet: async () => {
					actions.push("state_load");
					if (input.failure === "state_load") throw injectedError;
					return {
						sourceStorageKey: `projects/${attempt.projectId}/source/input.mp3`,
						sourceDurationSeconds: 10,
 sourceSizeBytes: 4096,
						workspaceOwnerUserId: "user",
						workspaceId: "workspace",
						pricingTier: "creator" as const,
						brandSnapshot: { status: "available" as const, value: null },
						pendingRenders:
							variantState === "pending" || variantState === "rendering"
								? [pendingRender]
								: [],
					};
				},
			},
			workerProcess: {
				inspectMedia: async (request) => {
            const output = renderOutput.inspect(request.sourcePath);
            if (output) return output;
            if (input.productionMedia) return input.productionMedia.inspectMedia(request);
            if (input.sourceHealthFailure) throw input.sourceHealthFailure;
            const { sourcePath, signal, deadlineMs } = request;
						const mode = sourcePath.startsWith("https://") ? "ranged" : "local";
						if (
							input.sourceMode === "ranged" ||
							input.sourceInterruption?.operation === `${mode}_probe`
						) {
							actions.push(`probe:${mode}`);
						}
						expect(signal).toBeInstanceOf(AbortSignal);
						expect(deadlineMs).toBeGreaterThan(0);
						interruptSource(`${mode}_probe`);
						if (shouldFail(`${mode}_probe`)) {
							throw new WorkerProcessFailure(
								mode === "ranged"
									? "worker_command_failed"
									: "worker_command_input_invalid",
								mode === "ranged" ? "retryable" : "permanent",
								`injected ${mode} probe failure`,
        mode === "ranged" ? "HTTP error 503 Service Unavailable" : "moov atom not found",
							);
						}
						return {
							durationSec: 10,
							width: 0,
							height: 0,
							hasVideo: false,
							hasAudio: true,
							hasVisualStream: false,
							fps: 30,
						};
					},
				execute: async ({ command, args, deadlineMs, diagnose, signal }) => {
            const decoded = renderOutput.decode(args); if (decoded) return decoded;
					if (input.commandHealthFailure) { diagnose?.({ operation: "spawn", status: "completed", elapsedMs: 0 }); throw input.commandHealthFailure; }
                    if (command === "ffprobe") {
						throw new Error("source probes must use inspectMedia");
					}
					expect(signal).toBeInstanceOf(AbortSignal);
					expect(deadlineMs).toBeGreaterThan(0);
					actions.push("command");
					if (input.waitForCommandAbort) {
						actions.push("command_started");
						return new Promise<never>((_resolve, reject) => {
							const abort = () => {
								actions.push("command_terminated");
								reject(
									signal.reason instanceof Error
										? signal.reason
										: new DOMException("cancelled", "AbortError"),
								);
							};
							signal.addEventListener("abort", abort, { once: true });
							if (signal.aborted) abort();
						});
					}
					if (input.failure === "command_timeout_after_output") {
						actions.push("output_created");
					}
					const commandFailure =
						input.failure === "command"
							? new WorkflowFailure(
									"ffmpeg_temporarily_unavailable",
									"retryable",
									input.failureMessage ??
										"The encoder is temporarily unavailable",
								)
							: input.failure === "command_missing"
								? new WorkflowFailure(
										"worker_command_missing",
										"permanent",
										"Required render executable is unavailable",
									)
								: input.failure === "command_nonzero_exit"
									? new WorkflowFailure(
											"worker_command_failed",
											"retryable",
											"Render command exited nonzero",
										)
									: input.failure === "command_timeout_before_output" ||
											input.failure === "command_timeout_after_output"
										? new WorkflowFailure(
												"worker_command_timeout",
												"retryable",
												"Render command timed out",
											)
										: null;
					if (commandFailure) {
						diagnose?.({
							...input.commandDiagnosticContext,
							operation: commandFailure.code.includes("timeout")
								? "timeout"
								: commandFailure.code.includes("missing")
									? "spawn"
									: "exit",
							status: "failed",
							elapsedMs: 25,
							failureCode: commandFailure.code,
							disposition: commandFailure.disposition,
						});
						throw commandFailure;
					}
					return { exitCode: 0, stdout: Buffer.alloc(0) };
				},
				withScratchDirectory: async (_prefix, work, diagnose) => {
					const directory =
						input.workspaceDirectory ?? "/tmp/narriflow-render-ordinary-tracer";
					try {
						return await work(directory);
					} finally {
						actions.push("workspace_cleanup");
						if (input.failure === "cleanup") {
							diagnose?.({
								operation: "scratch_cleanup",
								status: "failed",
								elapsedMs: 0,
								failureCode: "worker_scratch_cleanup_failed",
							});
						}
					}
				},
			},
			clip: {
				completeClipAutoLayoutAnalysis: async () => false,
				...(input.productionCompletion
					? {}
					: {
							completeClipRenderVariant: async (
								_attempt: ClipRenderingWorkflowAttempt,
								_variantId: string,
								completion: { storageKey: string },
							) => {
								actions.push("guarded_completion");
								if (input.failure === "guarded_completion") {
									throw new WorkflowAttemptLost(attempt);
								}
								if (input.failure === "guarded_completion_rejected") {
									throw injectedError;
								}
								if (input.superseded) {
									variantState = "superseded";
									return { persisted: false };
								}
								variantState = "completed";
								objectReferences.push(completion.storageKey);
								if (input.completionControlFlow) {
									sourceController.abort(completionControlError);
									throw completionControlError;
								}
								if (input.commitAcknowledgementLost) throw injectedError;
								return { persisted: true };
							},
						}),
				failClipRenderVariant: async (
					_attempt,
					_variantId,
					code,
					disposition,
					motionAnalytics,
				) => {
					actions.push(`variant_failure:${code}:${disposition}`);
					if (motionAnalytics) failureMotionAnalytics.push(motionAnalytics);
					if (input.failureWriteRejects) throw injectedError;
					if (variantState === "rendering") variantState = "failed";
				},
				markClipRenderVariantRendering: async () => {
					actions.push("guarded_claim");
					variantState = "rendering";
					return true;
				},
				setClipLayoutAnalysis: async () => {},
			},
			storage: {
				presignDownloadUrl: async () => {
					actions.push("presign");
					interruptSource("presign");
					if (input.presignNeverResolves) {
						return new Promise<string>(() => {});
					}
					if (shouldFail("presign")) throw injectedError;
					return (
						input.presignedUrl ??
						"https://media.example/source.mp3?signature=secret"
					);
				},
				downloadObjectToFile: async ({ filePath }) => {
					if (input.sourceMode === "ranged" || shouldFail("download")) {
						actions.push("download");
					}
					interruptSource("download");
					if (shouldFail("download")) throw injectedError;
					if (input.downloadFixturePath) {
						await copyFile(input.downloadFixturePath, filePath);
					}
				},
				putFileFromPath: async ({ key, contentType, metadata }) => {
					actions.push("upload");
					if (input.failure === "upload") {
						throw new WorkflowFailure(
							"render_upload_failed",
							"retryable",
							"The object store is temporarily unavailable",
						);
					}
					uploads.push({ key, contentType, metadata });
					uploadedKeys.push(key);
					if (input.cancelAfterUpload) sourceController.abort(completionControlError);
					return { key };
				},
				deleteObject: async (key, options) => {
					actions.push("object_cleanup");
					if (options?.signal) cleanupSignals.push(options.signal);
					if (input.cleanupStalls) {
						expect(options?.signal?.aborted).toBe(false);
						advanceClock(4_999);
						expect(options?.signal?.aborted).toBe(false);
						advanceClock(1);
						return new Promise<never>(() => {});
					}
					if (input.failure === "object_cleanup") throw injectedError;
					deletedKeys.push(key);
					return { key };
				},
			},
			workspace: {
    statfs: async () => ({ bavail: 10 * 1024 ** 3, bsize: 1, blocks: 20 * 1024 ** 3 }) as never,
				stat: async () => ({ size: 4096, isFile: () => true }) as never,
			},
			clock: {
				nowMs: () => clockNowMs,
				setTimeout: (callback, delayMs) => {
					const id = nextTimerId++;
					scheduledTimers.set(id, {
						callback,
						deadlineAtMs: clockNowMs + delayMs,
					});
					return id as unknown as ReturnType<typeof setTimeout>;
				},
				clearTimeout: (handle) => {
					scheduledTimers.delete(handle as unknown as number);
				},
			},
			diagnose: ({ message, context }) => {
				if (input.diagnoseThrows)
					throw new Error("diagnostic sink unavailable");
				diagnostics.push({ message, context });
			},
		},
	});

	return {
		actions,
		advanceClock,
		attempt,
		beginCalls: () => beginCalls,
		clipRenderAttempt,
		deletedKeys,
		diagnostics,
		failureMotionAnalytics,
		cleanupSignals,
		completionControlError,
		finishReferenceRead: () => finishReferenceRead?.(new Set()),
		injectedError,
		objectReferences,
		settlementCalls: () => settlementCalls,
		sourceSignal: sourceController.signal,
		uploads,
		uploadedKeys,
		variantState: () => variantState,
	};
}

function createUploadQueueTracer(input: {
	attemptId: string;
	configuredConcurrency?: number;
	variantCount: number;
}) {
	const attempt: ClipRenderingWorkflowAttempt = {
		workflowRunId: "10000000-0000-0000-0000-000000000071",
		projectId: "20000000-0000-0000-0000-000000000072",
		stage: "clip_rendering",
		attemptId: input.attemptId,
		attemptCount: 1,
	};
	const pendingRenders = Array.from(
		{ length: input.variantCount },
		(_, index) => ({
			id: `variant-${index}`,
			clipId: `clip-${index}`,
			aspectRatio: "ratio_9_16",
			resolution: "1080p",
			exportVariantId: null,
			exportVariant: null,
			clipSnapshot: null,
			clip: {
				id: `clip-${index}`,
				index,
				startSec: 0,
				endSec: 10,
				llmModel: "test",
				transcriptSlice: [],
				deletedRanges: null,
				captionPreset: null,
				studioEdits: null,
				wholeSource: false,
				editorDocumentVersion: 1,
				sceneBlocks: [],
				censorSegments: [],
				mediaMotions: [],
				brollCues: null,
				brollUrl: null,
				category: "other",
			},
		}),
	) as unknown as PendingClipRender[];
	const states = new Map(
		pendingRenders.map((render) => [render.id, "pending"]),
	);
	const actions: string[] = [];
	const objectReferences: string[] = [];
	const uploadStartedKeys: string[] = [];
	const uploadAbortedKeys: string[] = [];
	let activeUploads = 0;
	let maxActiveUploads = 0;
	let settlementCalls = 0;
	let cleanupActiveUploads: number | null = null;
	let releaseUploads = () => {};
	const uploadGate = new Promise<void>((resolve) => {
		releaseUploads = resolve;
	});

	const renderOutput = createRenderOutputFixture();
	const clipRenderAttempt = createClipRenderAttempt({
		group: { workflowRunId: "", workSetGeneration: "", groupId: "", token: "", owner: "" },
		groups: {} as never,
		run: {
			id: attempt.workflowRunId,
			projectId: attempt.projectId,
			project: {
				title: "Upload queue tracer",
				sourceStorageKey: `projects/${attempt.projectId}/source/input.mp3`,
				sourceDurationSeconds: 10,
 sourceSizeBytes: 4096,
				workspaceOwnerUserId: "user",
				workspaceId: "workspace",
			},
		},
		config: parseRenderConfig({
			WORKER_RENDER_SOURCE_MODE: "download",
			...(input.configuredConcurrency === undefined
				? {}
				: { WORKER_UPLOAD_CONCURRENCY: String(input.configuredConcurrency) }),
			}),
		lifecycle: {
			startExecution: async () => {},
			beginRenderGroup: async () => ({
				variantIds: pendingRenders.map((render) => render.id),
			}),
			finishRenderGroup: async () => {
				settlementCalls += 1;
				actions.push("settle");
				return {
					status: "completed",
					requested: input.variantCount,
					succeeded: input.variantCount,
					failed: 0,
					superseded: 0,
				};
			},
		},
		adapters: {
      composition: { compileCommand: renderOutput.compileCommand },
			state: {
				getProjectRenderStorageReferences: async () => new Set<string>(),
				getFrozenRenderingStateForWorkSet: async () =>
					frozenRenderingState(
						pendingRenders.filter((render) => {
							const state = states.get(render.id);
							return state === "pending" || state === "rendering";
						}),
					),
			},
			workerProcess: {
				inspectMedia: async ({ sourcePath }) => renderOutput.inspect(sourcePath) ?? ({
					durationSec: 10,
					width: 0,
					height: 0,
					hasVideo: false,
					hasAudio: true,
					hasVisualStream: false,
					fps: 30,
				}),
				execute: async ({ args }) => renderOutput.decode(args) ?? ({ exitCode: 0, stdout: Buffer.alloc(0) }),
				withScratchDirectory: async (_prefix, work) => {
					try {
						return await work("/tmp/narriflow-render-upload-queue-tracer");
					} finally {
						cleanupActiveUploads = activeUploads;
						actions.push("workspace_cleanup");
					}
				},
			},
			clip: {
				completeClipAutoLayoutAnalysis: async () => false,
				completeClipRenderVariant: async (_attempt, variantId, completion) => {
					states.set(variantId, "completed");
					objectReferences.push(completion.storageKey);
					return { persisted: true };
				},
				failClipRenderVariant: async (variantId) => {
					states.set(variantId, "failed");
				},
				markClipRenderVariantRendering: async (_attempt, variantId) => {
					states.set(variantId, "rendering");
					return true;
				},
				setClipLayoutAnalysis: async () => {},
			},
			storage: {
				downloadObjectToFile: async () => {},
				putFileFromPath: async ({ key, signal }) => {
					uploadStartedKeys.push(key);
					activeUploads += 1;
					maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
					actions.push(`upload_started:${key}`);
					try {
						await new Promise<void>((resolve, reject) => {
							let finished = false;
							const finish = (operation: () => void) => {
								if (finished) return;
								finished = true;
								signal?.removeEventListener("abort", onAbort);
								operation();
							};
							const onAbort = () =>
								finish(() => {
									uploadAbortedKeys.push(key);
									reject(
										signal?.reason instanceof Error
											? signal.reason
											: new DOMException("cancelled", "AbortError"),
									);
								});
							signal?.addEventListener("abort", onAbort, { once: true });
							if (signal?.aborted) onAbort();
							else uploadGate.then(() => finish(resolve));
						});
						return { key };
					} finally {
						activeUploads -= 1;
						actions.push(`upload_stopped:${key}`);
					}
				},
				deleteObject: async (key) => ({ key }),
			},
			workspace: {
				statfs: async () => ({ bavail: 10 * 1024 ** 3, bsize: 1, blocks: 20 * 1024 ** 3 }) as never,
				stat: async () => ({ size: 4096, isFile: () => true }) as never,
			},
			diagnose: () => {},
		},
	});

	return {
		actions,
		attempt,
		cleanupActiveUploads: () => cleanupActiveUploads,
		clipRenderAttempt,
		maxActiveUploads: () => maxActiveUploads,
		objectReferences,
		releaseUploads,
		settlementCalls: () => settlementCalls,
		uploadAbortedKeys,
		uploadStartedKeys,
	};
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let index = 0; index < 500; index += 1) {
		if (condition()) return;
		await Promise.resolve();
	}
	throw new Error("Timed out waiting for deterministic tracer state");
}

function createInterfaceGuardTracer(input: {
	runId?: string;
}) {
	const attempt: ClipRenderingWorkflowAttempt = {
		workflowRunId: "10000000-0000-0000-0000-000000000031",
		projectId: "20000000-0000-0000-0000-000000000032",
		stage: "clip_rendering",
		attemptId: "30000000-0000-4000-8000-000000000033",
		attemptCount: 1,
	};
	let beginCalls = 0;
	const clipRenderAttempt = createClipRenderAttempt({
		group: { workflowRunId: "", workSetGeneration: "", groupId: "", token: "", owner: "" },
		groups: {} as never,
		run: {
			id: input.runId ?? attempt.workflowRunId,
			projectId: attempt.projectId,
			project: {
				title: "Interface guard",
				sourceStorageKey: null,
				sourceDurationSeconds: null,
				workspaceOwnerUserId: "user",
				workspaceId: "workspace",
			},
		},
		config: parseRenderConfig({}),
		lifecycle: {
			startExecution: async () => {},
			beginRenderGroup: async () => {
				beginCalls += 1;
				return { variantIds: [] };
			},
			finishRenderGroup: async () => ({
				status: "completed",
				requested: 0,
				succeeded: 0,
				failed: 0,
				superseded: 0,
			}),
		},
	});

	return { attempt, beginCalls: () => beginCalls, clipRenderAttempt };
}

test("ClipRenderAttempt discards an uploaded object when cancellation wins before persistence", async () => {
	const controller = new AbortController();
	const actions: string[] = [];
	const attempt: ClipRenderingWorkflowAttempt = {
		workflowRunId: "10000000-0000-0000-0000-000000000001",
		projectId: "20000000-0000-0000-0000-000000000002",
		stage: "clip_rendering",
		attemptId: "30000000-0000-4000-8000-000000000003",
		attemptCount: 1,
	};
	const pendingRender = {
		id: "variant-1",
		clipId: "clip-1",
		aspectRatio: "ratio_9_16",
		resolution: "1080p",
		exportVariantId: null,
		exportVariant: null,
		clipSnapshot: null,
		clip: {
			id: "clip-1",
			index: 0,
			startSec: 0,
			endSec: 10,
			llmModel: "test",
			transcriptSlice: [],
			deletedRanges: null,
			captionPreset: null,
			studioEdits: null,
			wholeSource: false,
			editorDocumentVersion: 1,
			sceneBlocks: [],
			censorSegments: [],
			mediaMotions: [],
			brollCues: null,
			brollUrl: null,
			category: "other",
		},
	} as unknown as PendingClipRender;
	const renderOutput = createRenderOutputFixture();
	const clipRenderAttempt = createClipRenderAttempt({
		group: { workflowRunId: "", workSetGeneration: "", groupId: "", token: "", owner: "" },
		groups: {} as never,
		run: {
			id: attempt.workflowRunId,
			projectId: attempt.projectId,
			project: {
				title: "Post-upload cancellation",
				sourceStorageKey: `projects/${attempt.projectId}/source/input.mp3`,
				sourceDurationSeconds: 10,
 sourceSizeBytes: 4096,
				workspaceOwnerUserId: "user",
				workspaceId: "workspace",
			},
		},
		config: parseRenderConfig({
			WORKER_RENDER_SOURCE_MODE: "download",
			}),
		lifecycle: {
			startExecution: async () => {},
			beginRenderGroup: async () => ({ variantIds: [pendingRender.id] }),
			finishRenderGroup: async () => {
				actions.push("settle");
				throw new Error("settlement must not run after cancellation");
			},
		},
		adapters: {
      composition: { compileCommand: renderOutput.compileCommand },
			state: {
				getProjectRenderStorageReferences: async () => new Set<string>(),
				getFrozenRenderingStateForWorkSet: async () =>
					frozenRenderingState([pendingRender]),
			},
			workerProcess: {
				inspectMedia: async ({ sourcePath }) => renderOutput.inspect(sourcePath) ?? ({
					durationSec: 10,
					width: 0,
					height: 0,
					hasVideo: false,
					hasAudio: true,
					hasVisualStream: false,
					fps: 30,
				}),
				execute: async ({ args }) => {
            const decoded = renderOutput.decode(args); if (decoded) return decoded;
					actions.push("encode");
					return { exitCode: 0, stdout: Buffer.alloc(0) };
				},
				withScratchDirectory: async (_prefix, work) => {
					try {
						return await work("/tmp/narriflow-render-post-upload-cancel");
					} finally {
						actions.push("cleanup");
					}
				},
			},
			clip: {
				completeClipAutoLayoutAnalysis: async () => false,
				completeClipRenderVariant: async () => {
					actions.push("persist");
					return { persisted: true };
				},
				failClipRenderVariant: async () => {
					actions.push("fail");
				},
				markClipRenderVariantRendering: async () => true,
				setClipLayoutAnalysis: async () => {},
			},
			storage: {
				downloadObjectToFile: async () => {},
				putFileFromPath: async ({ key }) => {
					actions.push("upload");
					controller.abort(new DOMException("cancelled", "AbortError"));
					return { key };
				},
				deleteObject: async (key) => {
					actions.push("discard");
					return { key };
				},
			},
			workspace: {
				statfs: async () => ({ bavail: 10 * 1024 ** 3, bsize: 1, blocks: 20 * 1024 ** 3 }) as never,
				stat: async () => ({ size: 4096, isFile: () => true }) as never,
			},
			diagnose: () => {},
		},
	});

	await expect(
		clipRenderAttempt.execute(attempt, attemptContext(controller.signal)),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(actions).toContain("upload");
	expect(actions).toContain("discard");
	expect(actions).toContain("cleanup");
	expect(actions).not.toContain("persist");
	expect(actions).not.toContain("settle");
	expect(actions).not.toContain("fail");
});

test("ClipRenderAttempt settles an empty frozen work set through execute", async () => {
	const attempt: ClipRenderingWorkflowAttempt = {
		workflowRunId: "10000000-0000-0000-0000-000000000001",
		projectId: "20000000-0000-0000-0000-000000000002",
		stage: "clip_rendering",
		attemptId: "30000000-0000-0000-0000-000000000003",
		attemptCount: 1,
	};
	const expected: RenderGroupOutcome = {
		status: "completed",
		requested: 0,
		succeeded: 0,
		failed: 0,
		superseded: 0,
	};
	const lifecycle = {
		startExecution: async () => {},
		beginRenderGroup: async () => ({ variantIds: [] }),
		finishRenderGroup: async () => expected,
	};
	const clipRenderAttempt = createClipRenderAttempt({
		group: { workflowRunId: "", workSetGeneration: "", groupId: "", token: "", owner: "" },
		groups: {} as never,
		run: {
			id: attempt.workflowRunId,
			projectId: attempt.projectId,
			project: {
				title: "Empty work set",
				sourceStorageKey: null,
				sourceDurationSeconds: null,
				workspaceOwnerUserId: "user",
				workspaceId: "workspace",
			},
		},
		config: parseRenderConfig({}),
		lifecycle,
		adapters: { diagnose: () => {} },
	});

	await expect(
		clipRenderAttempt.execute(
			attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
});

test("ClipRenderAttempt can reuse frozen injected adapters without retaining another attempt's diagnostic identity", async () => {
	const diagnostics: Array<
		Parameters<ClipRenderAttemptAdapters["diagnose"]>[0]
	> = [];
	const diagnose: ClipRenderAttemptAdapters["diagnose"] = (event) =>
		diagnostics.push(event);
	const unexpectedOperation = async (): Promise<never> => {
		throw new Error("Empty work sets must not read or render media");
	};
	const sharedAdapters: ClipRenderAttemptAdapters = Object.freeze({
		workerProcess: {
			execute: unexpectedOperation,
			inspectMedia: unexpectedOperation,
			withScratchDirectory: unexpectedOperation,
		},
		state: { getProjectRenderStorageReferences: async () => new Set<string>(), getFrozenRenderingStateForWorkSet: unexpectedOperation },
		clip: {
			markClipRenderVariantRendering: unexpectedOperation,
			completeClipRenderVariant: unexpectedOperation,
			failClipRenderVariant: unexpectedOperation,
			completeClipAutoLayoutAnalysis: unexpectedOperation,
			completeClipSplitLayoutAnalysis: unexpectedOperation,
			completeClipSplitLayoutFailure: unexpectedOperation,
			setClipLayoutAnalysis: unexpectedOperation,
			setClipLayoutAnalysisFailure: unexpectedOperation,
		},
		audioAsset: { resolveRenderSource: unexpectedOperation },
		assets: { loadSceneSources: unexpectedOperation },
		optionalAssets: {
			downloadUrlToFile: unexpectedOperation,
			validateOptionalMedia: unexpectedOperation,
			resolveBrollCutaways: unexpectedOperation,
			getCachedBrollAssetPath: unexpectedOperation,
			saveBrollAssetToCache: unexpectedOperation,
			probeMediaDurationSec: unexpectedOperation,
			probeBackgroundImageDecodable: unexpectedOperation,
		},
		analysis: {
			extractFaceDetectionSegment: unexpectedOperation,
			detectFacePath: unexpectedOperation,
			detectMultiFacePath: unexpectedOperation,
			detectSceneCuts: unexpectedOperation,
			detectPipPath: unexpectedOperation,
		},
		storage: {
			deleteObject: unexpectedOperation,
   sourceSizeBytes: unexpectedOperation,
			downloadObjectToFile: unexpectedOperation,
			presignDownloadUrl: unexpectedOperation,
			putFileFromPath: unexpectedOperation,
		},
		workspace: productionRenderWorkspaceAdapter,
		clock: productionRenderClockAdapter,
		resource: {
			measure: () => {
				throw new Error("Empty work sets must not measure render resources");
			},
		},
		composition: {
			compileCommand: () => {
				throw new Error("Empty work sets must not compile media");
			},
		},
		diagnose,
	});
	const expected: RenderGroupOutcome = {
		status: "completed",
		requested: 0,
		succeeded: 0,
		failed: 0,
		superseded: 0,
	};
	for (const id of ["run-a", "run-b"]) {
		const attempt: ClipRenderingWorkflowAttempt = {
			workflowRunId: id,
			projectId: `project-${id}`,
			stage: "clip_rendering",
			attemptId: `attempt-${id}`,
			attemptCount: 1,
		};
		const clipRenderAttempt = new ClipRenderAttempt({
			run: {
				id,
				projectId: attempt.projectId,
				project: {
					title: id,
					sourceStorageKey: null,
					sourceDurationSeconds: null,
				},
			},
			config: parseRenderConfig({}),
			lifecycle: {
				startExecution: async () => {},
				beginRenderGroup: async () => ({ variantIds: [] }),
				finishRenderGroup: async () => expected,
			},
			adapters: () => sharedAdapters,
		});
		expect(
			await clipRenderAttempt.execute(
				attempt,
				attemptContext(new AbortController().signal),
			),
		).toEqual(expected);
		expect(sharedAdapters.diagnose).toBe(diagnose);
	}
	expect(diagnostics).toHaveLength(2);
	expect(
		diagnostics.map((event) => [
			event.message,
			event.context?.workflowRunId,
			event.context?.workflowAttemptId,
			event.context?.projectId,
		]),
	).toEqual([
		["clip_render_attempt_settled", "run-a", "attempt-run-a", "project-run-a"],
		["clip_render_attempt_settled", "run-b", "attempt-run-b", "project-run-b"],
	]);
});

test("ClipRenderAttempt rechecks cancellation after freezing an empty work set", async () => {
	const controller = new AbortController();
	const attempt: ClipRenderingWorkflowAttempt = {
		workflowRunId: "10000000-0000-0000-0000-000000000001",
		projectId: "20000000-0000-0000-0000-000000000002",
		stage: "clip_rendering",
		attemptId: "30000000-0000-0000-0000-000000000003",
		attemptCount: 1,
	};
	let settlementCalls = 0;
	const clipRenderAttempt = createClipRenderAttempt({
		group: { workflowRunId: "", workSetGeneration: "", groupId: "", token: "", owner: "" },
		groups: {} as never,
		run: {
			id: attempt.workflowRunId,
			projectId: attempt.projectId,
			project: {
				title: "Cancelled frozen set",
				sourceStorageKey: null,
				sourceDurationSeconds: null,
				workspaceOwnerUserId: "user",
				workspaceId: "workspace",
			},
		},
		config: parseRenderConfig({}),
		lifecycle: {
			startExecution: async () => {},
			beginRenderGroup: async () => {
				controller.abort(new DOMException("cancelled", "AbortError"));
				return { variantIds: [] };
			},
			finishRenderGroup: async () => {
				settlementCalls += 1;
				throw new Error("settlement must not run after cancellation");
			},
		},
	});

	await expect(
		clipRenderAttempt.execute(attempt, attemptContext(controller.signal)),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(settlementCalls).toBe(0);
});

test("ClipRenderAttempt drives failure and cleanup through construction adapters", async () => {
	const attempt: ClipRenderingWorkflowAttempt = {
		workflowRunId: "10000000-0000-0000-0000-000000000001",
		projectId: "20000000-0000-0000-0000-000000000002",
		stage: "clip_rendering",
		attemptId: "30000000-0000-0000-0000-000000000003",
		attemptCount: 1,
	};
	const expected: RenderGroupOutcome = {
		status: "failed",
		requested: 1,
		succeeded: 0,
		failed: 1,
		superseded: 0,
	};
	const mutations: string[] = [];
	const diagnostics: string[] = [];
	const clipRenderAttempt = createClipRenderAttempt({
		group: { workflowRunId: "", workSetGeneration: "", groupId: "", token: "", owner: "" },
		groups: {} as never,
		run: {
			id: attempt.workflowRunId,
			projectId: attempt.projectId,
			project: {
				title: "Missing source",
				sourceStorageKey: null,
				sourceDurationSeconds: null,
				workspaceOwnerUserId: "user",
				workspaceId: "workspace",
			},
		},
		config: parseRenderConfig({}),
		lifecycle: {
			startExecution: async () => {},
			beginRenderGroup: async () => ({ variantIds: ["variant-1"] }),
			finishRenderGroup: async () => {
				mutations.push("settle:start");
				await Promise.resolve();
				mutations.push("settle:complete");
				return expected;
			},
		},
		adapters: {
			state: {
				getProjectRenderStorageReferences: async () => new Set<string>(),
				getFrozenRenderingStateForWorkSet: async () =>
					frozenRenderingState([{ id: "variant-1" } as PendingClipRender], {
						sourceStorageKey: null,
						pricingTier: "free",
					}),
			},
			clip: {
				completeClipAutoLayoutAnalysis: async () => false,
				completeClipRenderVariant: async () => ({ persisted: true }),
				failClipRenderVariant: async (_attempt, _id, code, disposition) => {
					mutations.push(`fail:${code}:${disposition}`);
				},
				markClipRenderVariantRendering: async (_attempt, id) => {
					mutations.push(`mark:${id}`);
				},
				setClipLayoutAnalysis: async () => {},
			},
			workerProcess: {
				withScratchDirectory: async (_prefix, work) => {
					try {
						return await work("/tmp/narriflow-render-test");
					} finally {
						mutations.push("cleanup");
					}
				},
			},
			clock: { nowMs: () => 1_000 },
			diagnose: ({ message }) => diagnostics.push(message),
		},
	});

	await expect(
		clipRenderAttempt.execute(
			attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
	expect(mutations).toEqual([
		"mark:variant-1",
		"fail:source_storage_key_missing:permanent",
		"settle:start",
		"settle:complete",
		"cleanup",
	]);
	expect(diagnostics).toContain("clip_rendering_run_failed");
});

test("ClipRenderAttempt cancellation drains to cleanup without persisting outcomes", async () => {
	const controller = new AbortController();
	const attempt: ClipRenderingWorkflowAttempt = {
		workflowRunId: "10000000-0000-0000-0000-000000000001",
		projectId: "20000000-0000-0000-0000-000000000002",
		stage: "clip_rendering",
		attemptId: "30000000-0000-0000-0000-000000000003",
		attemptCount: 1,
	};
	const mutations: string[] = [];
	let settlementCalls = 0;
	const clipRenderAttempt = createClipRenderAttempt({
		group: { workflowRunId: "", workSetGeneration: "", groupId: "", token: "", owner: "" },
		groups: {} as never,
		run: {
			id: attempt.workflowRunId,
			projectId: attempt.projectId,
			project: {
				title: "Cancelled render",
				sourceStorageKey: `projects/${attempt.projectId}/source/input.mp4`,
				sourceDurationSeconds: 10,
 sourceSizeBytes: 4096,
				workspaceOwnerUserId: "user",
				workspaceId: "workspace",
			},
		},
		config: parseRenderConfig({
			WORKER_RENDER_SOURCE_MODE: "download",
		}),
		lifecycle: {
			startExecution: async () => {},
			beginRenderGroup: async () => ({ variantIds: ["variant-1"] }),
			finishRenderGroup: async () => {
				settlementCalls += 1;
				throw new Error("settlement must not run after cancellation");
			},
		},
		adapters: {
			state: {
				getProjectRenderStorageReferences: async () => new Set<string>(),
				getFrozenRenderingStateForWorkSet: async () =>
					frozenRenderingState([{ id: "variant-1" } as PendingClipRender], {
						sourceStorageKey: `projects/${attempt.projectId}/source/input.mp4`,
						pricingTier: "free",
					}),
			},
			clip: {
				completeClipAutoLayoutAnalysis: async () => false,
				completeClipRenderVariant: async () => ({ persisted: true }),
				failClipRenderVariant: async () => {
					mutations.push("fail");
				},
				markClipRenderVariantRendering: async () => {
					mutations.push("mark");
				},
				setClipLayoutAnalysis: async () => {},
			},
			storage: {
				downloadObjectToFile: async () => {
					controller.abort(new DOMException("cancelled", "AbortError"));
					throw controller.signal.reason;
				},
			},
			workerProcess: {
				withScratchDirectory: async (_prefix, work) => {
					try {
						return await work("/tmp/narriflow-render-cancelled");
					} finally {
						mutations.push("cleanup");
					}
				},
			},
			diagnose: () => {},
		},
	});

	await expect(
		clipRenderAttempt.execute(attempt, attemptContext(controller.signal)),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(mutations).toEqual(["cleanup"]);
	expect(settlementCalls).toBe(0);
});

test("ClipRenderAttempt permanently rejects a stored document with an empty timeline", async () => {
	const attempt: ClipRenderingWorkflowAttempt = {
		workflowRunId: "10000000-0000-0000-0000-000000000011",
		projectId: "20000000-0000-0000-0000-000000000012",
		stage: "clip_rendering",
		attemptId: "30000000-0000-0000-0000-000000000013",
		attemptCount: 1,
	};
	const pendingRender = {
		id: "variant-empty-cut",
		clipId: "clip-empty-cut",
		aspectRatio: "ratio_9_16",
		resolution: "1080p",
		exportVariantId: null,
		exportVariant: null,
		clipSnapshot: null,
		clip: {
			id: "clip-empty-cut",
			index: 0,
			startSec: 0,
			endSec: 10,
			llmModel: "test",
			transcriptSlice: [],
			deletedRanges: [{ startSec: 0, endSec: 10 }],
			captionPreset: null,
			studioEdits: null,
			wholeSource: false,
			editorDocumentVersion: 1,
			sceneBlocks: [],
			censorSegments: [],
			mediaMotions: [],
			brollCues: null,
			brollUrl: null,
			category: "other",
		},
	} as unknown as PendingClipRender;
	const mutations: string[] = [];
	const expected: RenderGroupOutcome = {
		status: "failed",
		requested: 1,
		succeeded: 0,
		failed: 1,
		superseded: 0,
	};
	const clipRenderAttempt = createClipRenderAttempt({
		group: { workflowRunId: "", workSetGeneration: "", groupId: "", token: "", owner: "" },
		groups: {} as never,
		run: {
			id: attempt.workflowRunId,
			projectId: attempt.projectId,
			project: {
				title: "Fully deleted clip",
				sourceStorageKey: `projects/${attempt.projectId}/source/input.mp4`,
				sourceDurationSeconds: 10,
 sourceSizeBytes: 4096,
				workspaceOwnerUserId: "user",
				workspaceId: "workspace",
			},
		},
		config: parseRenderConfig({
			WORKER_RENDER_SOURCE_MODE: "download",
			}),
		lifecycle: {
			startExecution: async () => {},
			beginRenderGroup: async () => ({ variantIds: [pendingRender.id] }),
			finishRenderGroup: async () => {
				mutations.push("settle");
				return expected;
			},
		},
		adapters: {
			state: {
				getProjectRenderStorageReferences: async () => new Set<string>(),
				getFrozenRenderingStateForWorkSet: async () =>
					frozenRenderingState([pendingRender]),
			},
			workerProcess: {
				inspectMedia: async () => ({
					durationSec: 10,
					width: 1920,
					height: 1080,
					hasVideo: true,
					hasAudio: true,
					hasVisualStream: true,
					fps: 30,
				}),
				execute: async () => ({ exitCode: 0, stdout: Buffer.alloc(0) }),
				withScratchDirectory: async (_prefix, work) => {
					try {
						return await work("/tmp/narriflow-render-empty-cut");
					} finally {
						mutations.push("cleanup");
					}
				},
			},
			clip: {
				completeClipAutoLayoutAnalysis: async () => false,
				completeClipRenderVariant: async () => ({ persisted: true }),
				failClipRenderVariant: async (_attempt, _id, code, disposition) => {
					mutations.push(`fail:${code}:${disposition}`);
				},
				markClipRenderVariantRendering: async (_attempt, id) => {
					mutations.push(`mark:${id}`);
					return true;
				},
				setClipLayoutAnalysis: async () => {},
			},
			storage: { downloadObjectToFile: async () => {} },
			workspace: {},
			diagnose: () => {},
		},
	});

	await expect(
		clipRenderAttempt.execute(
			attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
	expect(mutations).toEqual([
		"mark:variant-empty-cut",
		"fail:editor_document_empty_timeline:permanent",
		"settle",
		"cleanup",
	]);
});

test("ClipRenderAttempt leaves an unpersistable settlement for reaper recovery", async () => {
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000053",
		failure: "settlement",
		outcome: {
			status: "completed",
			requested: 1,
			succeeded: 1,
			failed: 0,
			superseded: 0,
		},
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).rejects.toBe(harness.injectedError);
	expect(harness.settlementCalls()).toBe(1);
	expect(harness.variantState()).toBe("completed");
	expect(harness.actions).not.toContainEqual(
		expect.stringMatching(/^variant_failure:/),
	);
	expect(harness.actions.at(-1)).toBe("workspace_cleanup");
});

test("ClipRenderAttempt leaves replay settlement failure for reaper recovery", async () => {
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000054",
		failure: "settlement",
		initialVariantState: "completed",
		outcome: {
			status: "completed",
			requested: 1,
			succeeded: 1,
			failed: 0,
			superseded: 0,
		},
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).rejects.toBe(harness.injectedError);
	expect(harness.actions).toEqual(["begin", "state_load", "settle"]);
});


test("ClipRenderAttempt rejects a stale attempt through its asynchronous interface", async () => {
	const harness = createInterfaceGuardTracer({
		runId: "a-different-workflow-run",
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).rejects.toBeInstanceOf(WorkflowAttemptLost);
	expect(harness.beginCalls()).toBe(0);
});

test("ClipRenderAttempt renders and settles one ordinary variant through execute", async () => {
	const expected: RenderGroupOutcome = {
		status: "completed",
		requested: 1,
		succeeded: 1,
		failed: 0,
		superseded: 0,
	};
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000053",
		outcome: expected,
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
	expect(harness.variantState()).toBe("completed");
	expect(harness.uploadedKeys).toHaveLength(1);
	expect(harness.objectReferences).toEqual(harness.uploadedKeys);
	expect(harness.uploadedKeys[0]).toContain(harness.attempt.attemptId);
	expect(harness.uploads).toEqual([
		{
			key: harness.uploadedKeys[0],
			contentType: "video/mp4",
			metadata: {
				project_id: harness.attempt.projectId,
				clip_id: "clip-ordinary",
				workflow_run_id: harness.attempt.workflowRunId,
				format: "9:16",
			},
		},
	]);
	expect(harness.actions).toEqual([
		"begin",
		"state_load",
		"guarded_claim",
		"command",
		"upload",
		"guarded_completion",
		"settle",
		"workspace_cleanup",
	]);
	expect(harness.diagnostics).toContainEqual({
		message: "clip_render_attempt_settled",
		context: expect.objectContaining({
			workflowRunId: harness.attempt.workflowRunId,
			workflowAttemptId: harness.attempt.attemptId,
			projectId: harness.attempt.projectId,
			stage: "clip_rendering",
			attemptCount: harness.attempt.attemptCount,
			phase: "settlement",
			operation: "finish_render_group",
			disposition: "completed",
			requested: 1,
			succeeded: 1,
			failed: 0,
			superseded: 0,
			retryState: "terminal",
		}),
	});
});

test("ClipRenderAttempt persists an attempt-unique export key with unchanged delivery metadata", async () => {
	const expected: RenderGroupOutcome = {
		status: "completed",
		requested: 1,
		succeeded: 1,
		failed: 0,
		superseded: 0,
	};
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000064",
		exportBound: true,
		outcome: expected,
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
	expect(harness.uploadedKeys).toHaveLength(1);
	expect(harness.uploadedKeys[0]).toContain(
		`/exports/export-ordinary/export-variant-ordinary-9x16-${harness.attempt.attemptId}.mp4`,
	);
	expect(harness.objectReferences).toEqual(harness.uploadedKeys);
	expect(harness.uploads[0]).toEqual({
		key: harness.uploadedKeys[0],
		contentType: "video/mp4",
		metadata: {
			project_id: harness.attempt.projectId,
			clip_id: "clip-ordinary",
			workflow_run_id: harness.attempt.workflowRunId,
			format: "9:16",
		},
	});
});

for (const concurrencyCase of [
	{ label: "defaults upload concurrency", configured: undefined, expected: 2 },
	{ label: "caps upload concurrency", configured: 9, expected: 4 },
] as const) {
	test(`ClipRenderAttempt ${concurrencyCase.label} and drains every scheduled upload`, async () => {
		const harness = createUploadQueueTracer({
			attemptId:
				concurrencyCase.expected === 2
					? "30000000-0000-4000-8000-000000000065"
					: "30000000-0000-4000-8000-000000000066",
			configuredConcurrency: concurrencyCase.configured,
			variantCount: 6,
		});
		const execution = harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		);

		await waitFor(
			() => harness.uploadStartedKeys.length === concurrencyCase.expected,
		);
		expect(harness.maxActiveUploads()).toBe(concurrencyCase.expected);
		expect(harness.settlementCalls()).toBe(0);
		harness.releaseUploads();

		await expect(execution).resolves.toMatchObject({
			status: "completed",
			requested: 6,
			succeeded: 6,
		});
		expect(harness.uploadStartedKeys).toHaveLength(6);
		expect(harness.objectReferences).toEqual(harness.uploadStartedKeys);
		expect(harness.settlementCalls()).toBe(1);
		expect(harness.cleanupActiveUploads()).toBe(0);
	});
}

test("ClipRenderAttempt aborts active uploads and leaves queued uploads unstarted after ownership loss", async () => {
	const harness = createUploadQueueTracer({
		attemptId: "30000000-0000-4000-8000-000000000067",
		variantCount: 5,
	});
	const controller = new AbortController();
	const execution = harness.clipRenderAttempt.execute(
		harness.attempt,
		attemptContext(controller.signal),
	);

	await waitFor(() => harness.uploadStartedKeys.length === 2);
	const ownershipLoss = new WorkflowAttemptLost(harness.attempt);
	controller.abort(ownershipLoss);

	await expect(execution).rejects.toBe(ownershipLoss);
	expect(harness.uploadStartedKeys).toHaveLength(2);
	expect(harness.uploadAbortedKeys).toEqual(harness.uploadStartedKeys);
	expect(harness.objectReferences).toEqual([]);
	expect(harness.settlementCalls()).toBe(0);
	expect(harness.cleanupActiveUploads()).toBe(0);
	expect(harness.actions.at(-1)).toBe("workspace_cleanup");
});

test("ClipRenderAttempt resolves a ranged source through its media adapter", async () => {
	const expected: RenderGroupOutcome = {
		status: "completed",
		requested: 1,
		succeeded: 1,
		failed: 0,
		superseded: 0,
	};
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000062",
		outcome: expected,
		sourceMode: "ranged",
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
	expect(harness.actions).toContain("presign");
	expect(harness.actions).toContain("probe:ranged");
	expect(harness.actions).not.toContain("probe:local");
});

test("ClipRenderAttempt falls back from a ranged probe to a downloaded local probe", async () => {
	const expected: RenderGroupOutcome = {
		status: "completed",
		requested: 1,
		succeeded: 1,
		failed: 0,
		superseded: 0,
	};
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000063",
		failure: "ranged_probe",
		outcome: expected,
		sourceMode: "ranged",
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
	expect(harness.actions).toEqual(
		expect.arrayContaining([
			"presign",
			"probe:ranged",
			"download",
			"probe:local",
			"command",
		]),
	);
	expect(harness.diagnostics).toContainEqual({
		message: "clip_render_source_operation_failed",
		context: expect.objectContaining({
			phase: "source_resolution",
			operation: "ranged_probe",
			failureCode: "worker_command_failed",
			disposition: "retryable",
		}),
	});
});

const FFMPEG_AVAILABLE =
	spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const FFPROBE_AVAILABLE =
	spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

test.skipIf(!FFMPEG_AVAILABLE || !FFPROBE_AVAILABLE)(
	"ClipRenderAttempt production media contract falls back from ranged access to a downloaded fixture",
	async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "narriflow-source-fallback-contract-"),
		);
		const fixturePath = join(directory, "fixture.mp3");
		const workspaceDirectory = join(directory, "workspace");
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("Service unavailable", { status: 503 }),
		});
		await mkdir(workspaceDirectory);
		try {
			const generated = spawnSync("ffmpeg", [
				"-y",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:duration=0.2",
				"-c:a",
				"libmp3lame",
				fixturePath,
			]);
			expect(generated.status).toBe(0);

			const harness = createOrdinaryTracer({
				attemptId: "30000000-0000-4000-8000-000000000068",
				downloadFixturePath: fixturePath,
				outcome: {
					status: "completed",
					requested: 1,
					succeeded: 1,
					failed: 0,
					superseded: 0,
				},
				presignedUrl: `http://127.0.0.1:${server.port}/unavailable.mp3`,
				productionMedia: productionWorkerProcessModule,
				sourceMode: "ranged",
				workspaceDirectory,
			});

			await expect(
				harness.clipRenderAttempt.execute(
					harness.attempt,
					attemptContext(new AbortController().signal),
				),
			).resolves.toMatchObject({ status: "completed" });
			expect(harness.actions).toEqual(
				expect.arrayContaining(["presign", "download", "command"]),
			);
			expect(harness.diagnostics).toContainEqual({
				message: "clip_render_source_operation_failed",
				context: expect.objectContaining({
					operation: "ranged_probe",
					failureCode: "worker_command_failed",
					disposition: "retryable",
				}),
			});
			expect(harness.diagnostics).toContainEqual({
				message: "clip_render_source_operation_completed",
				context: expect.objectContaining({ operation: "local_probe" }),
			});
		} finally {
			await server.stop(true);
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("ClipRenderAttempt retries presigning failures without a full download", async () => {
	const expected: RenderGroupOutcome = {
		status: "queued",
		requested: 1,
		succeeded: 0,
		failed: 0,
		superseded: 0,
	};
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000064",
		failure: "presign",
		outcome: expected,
		sourceMode: "ranged",
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
	expect(harness.actions).not.toContain("download");
	expect(harness.actions).not.toContain("probe:local");
	expect(harness.actions).not.toContain("probe:ranged");
	expect(harness.diagnostics).toContainEqual({
		message: "clip_render_source_operation_failed",
		context: expect.objectContaining({
			operation: "source_presign",
			failureCode: "source_presign_failed",
			disposition: "retryable",
		}),
	});
});

test("ClipRenderAttempt bounds presigning without selecting an unproven source fallback", async () => {
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000067",
		outcome: {
			status: "queued",
			requested: 1,
			succeeded: 0,
			failed: 0,
			superseded: 0,
		},
		presignNeverResolves: true,
		sourceMode: "ranged",
	});

	const executing = harness.clipRenderAttempt.execute(
		harness.attempt,
		attemptContext(harness.sourceSignal),
	);
	while (!harness.actions.includes("presign")) await Promise.resolve();
	harness.advanceClock(5);
	await expect(executing).resolves.toMatchObject({ status: "queued" });
	expect(harness.actions).not.toContain("download");
	expect(harness.actions).not.toContain("probe:local");
	expect(harness.actions).not.toContain("probe:ranged");
	expect(harness.diagnostics).toContainEqual({
		message: "clip_render_source_operation_failed",
		context: expect.objectContaining({
			operation: "source_presign",
			failureCode: "source_presign_timeout",
			disposition: "retryable",
		}),
	});
});

for (const reason of ["cancellation", "ownership_loss"] as const) {
	for (const operation of [
		"presign",
		"ranged_probe",
		"download",
		"local_probe",
	] as const) {
		test(`ClipRenderAttempt stops source resolution after ${reason} during ${operation}`, async () => {
			const harness = createOrdinaryTracer({
				attemptId: `30000000-0000-4000-8000-00000000009${operation.length}`,
				outcome: {
					status: "failed",
					requested: 1,
					succeeded: 0,
					failed: 1,
					superseded: 0,
				},
				sourceInterruption: { operation, reason },
				...(operation === "download"
					? { sourceFailures: ["ranged_probe"] as const }
					: {}),
				sourceMode: operation === "local_probe" ? "download" : "ranged",
			});

			const executing = harness.clipRenderAttempt.execute(
				harness.attempt,
				attemptContext(harness.sourceSignal),
			);
			await expect(executing).rejects.toMatchObject(
				reason === "ownership_loss"
					? { name: "WorkflowAttemptLost" }
					: { name: "AbortError" },
			);

			const operationIndex = harness.actions.indexOf(
				operation.endsWith("probe")
					? `probe:${operation.split("_")[0]}`
					: operation,
			);
			expect(operationIndex).toBeGreaterThanOrEqual(0);
			const forbidden =
				operation === "presign"
					? ["probe:ranged", "download", "probe:local", "command"]
					: operation === "ranged_probe"
						? ["download", "probe:local", "command"]
						: operation === "download"
							? ["probe:local", "command"]
							: ["command"];
			for (const dependent of forbidden) {
				expect(harness.actions).not.toContain(dependent);
			}
			expect(
				harness.actions.some((action) => action.startsWith("variant_failure:")),
			).toBe(false);
			expect(harness.settlementCalls()).toBe(0);
			expect(harness.actions).toContain("workspace_cleanup");
		});
	}
}

test("ClipRenderAttempt records a retryable failure when ranged probing and download both fail", async () => {
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000065",
		outcome: {
			status: "queued",
			requested: 1,
			succeeded: 0,
			failed: 1,
			superseded: 0,
		},
		sourceFailures: ["ranged_probe", "download"],
		sourceMode: "ranged",
		motionTransition: true,
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toMatchObject({ status: "queued" });
	expect(harness.actions).toContain(
		"variant_failure:source_download_failed:retryable",
	);
	expect(harness.actions).not.toContain("command");
	expect(harness.actions).not.toContain("upload");
	expect(harness.failureMotionAnalytics).toEqual([
		expect.objectContaining({
			motionFamily: ["transition:slide-left"],
			targetCount: 1,
			renderOutcome: "failed",
		}),
	]);
	expect(harness.diagnostics).toContainEqual({
		message: "clip_render_source_operation_failed",
		context: expect.objectContaining({
			operation: "source_download",
			failureCode: "source_download_failed",
			disposition: "retryable",
		}),
	});
});

test("ClipRenderAttempt classifies corrupt downloaded source media as permanent", async () => {
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000066",
		failure: "local_probe",
		outcome: {
			status: "failed",
			requested: 1,
			succeeded: 0,
			failed: 1,
			superseded: 0,
		},
		sourceMode: "download",
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toMatchObject({ status: "failed" });
	expect(harness.actions).toContain(
		"variant_failure:source_media_invalid:permanent",
	);
	expect(harness.actions).not.toContain("command");
	expect(harness.actions).not.toContain("upload");
});

for (const failure of [
	{
		name: "missing executable",
		injected: "command_missing",
		code: "worker_command_missing",
		disposition: "permanent",
		status: "failed",
	},
	{
		name: "timeout before output creation",
		injected: "command_timeout_before_output",
		code: "worker_command_timeout",
		disposition: "retryable",
		status: "queued",
	},
	{
		name: "timeout after output creation",
		injected: "command_timeout_after_output",
		code: "worker_command_timeout",
		disposition: "retryable",
		status: "queued",
	},
	{
		name: "nonzero exit",
		injected: "command_nonzero_exit",
		code: "worker_command_failed",
		disposition: "retryable",
		status: "queued",
	},
] as const) {
	test(`ClipRenderAttempt classifies a ${failure.name} and skips dependent operations`, async () => {
		const harness = createOrdinaryTracer({
			attemptId: `30000000-0000-4000-8000-00000000007${failure.injected.length}`,
			failure: failure.injected,
			outcome: {
				status: failure.status,
				requested: 1,
				succeeded: 0,
				failed: 1,
				superseded: 0,
			},
		});

		await expect(
			harness.clipRenderAttempt.execute(
				harness.attempt,
				attemptContext(new AbortController().signal),
			),
		).resolves.toMatchObject({ status: failure.status });
		expect(harness.actions).toContain(
			`variant_failure:${failure.code}:${failure.disposition}`,
		);
		if (failure.injected === "command_timeout_after_output") {
			expect(harness.actions).toContain("output_created");
		}
		expect(harness.actions).not.toContain("upload");
		expect(harness.actions).not.toContain("guarded_completion");
	});
}

for (const interruption of ["cancellation", "ownership loss"] as const) {
	test(`ClipRenderAttempt waits for active command termination after ${interruption}`, async () => {
		const controller = new AbortController();
		const harness = createOrdinaryTracer({
			attemptId:
				interruption === "cancellation"
					? "30000000-0000-4000-8000-000000000081"
					: "30000000-0000-4000-8000-000000000082",
			outcome: {
				status: "failed",
				requested: 1,
				succeeded: 0,
				failed: 1,
				superseded: 0,
			},
			waitForCommandAbort: true,
		});
		const executing = harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(controller.signal),
		);
		while (!harness.actions.includes("command_started"))
			await Promise.resolve();
		const reason =
			interruption === "cancellation"
				? new DOMException("cancelled", "AbortError")
				: new WorkflowAttemptLost(harness.attempt);
		controller.abort(reason);

		await expect(executing).rejects.toBe(reason);
		expect(harness.actions.indexOf("command_terminated")).toBeLessThan(
			harness.actions.indexOf("workspace_cleanup"),
		);
		expect(harness.actions).not.toContain("upload");
		expect(harness.actions).not.toContain("guarded_completion");
		expect(
			harness.actions.some((action) => action.startsWith("variant_failure:")),
		).toBe(false);
		expect(harness.settlementCalls()).toBe(0);
	});
}

for (const failure of ["command", "upload"] as const) {
	test(`ClipRenderAttempt requeues a retryable ${failure} failure`, async () => {
		const expected: RenderGroupOutcome = {
			status: "queued",
			requested: 1,
			succeeded: 0,
			failed: 1,
			superseded: 0,
		};
		const harness = createOrdinaryTracer({
			attemptId: `30000000-0000-4000-8000-00000000005${
				failure === "command" ? "4" : "5"
			}`,
			failure,
			outcome: expected,
		});

		await expect(
			harness.clipRenderAttempt.execute(
				harness.attempt,
				attemptContext(new AbortController().signal),
			),
		).resolves.toEqual(expected);
		expect(harness.variantState()).toBe("pending");
		expect(harness.actions).toContain(
			`variant_failure:${
				failure === "command"
					? "ffmpeg_temporarily_unavailable"
					: "render_upload_failed"
			}:retryable`,
		);
		expect(harness.settlementCalls()).toBe(1);
		expect(harness.diagnostics).toContainEqual({
			message: "clip_render_attempt_settled",
			context: expect.objectContaining({
				workflowRunId: harness.attempt.workflowRunId,
				workflowAttemptId: harness.attempt.attemptId,
				projectId: harness.attempt.projectId,
				phase: "settlement",
				operation: "finish_render_group",
				disposition: expected.status,
				retryState:
					expected.status === "queued" ? "retry_scheduled" : "terminal",
				requested: expected.requested,
				succeeded: expected.succeeded,
				failed: expected.failed,
				superseded: expected.superseded,
			}),
		});
		if (failure === "command") {
			expect(harness.diagnostics).toContainEqual({
				message: "clip_render_command_operation",
				context: expect.objectContaining({
					phase: "command_execution",
					operation: "exit",
					status: "failed",
					failureCode: "ffmpeg_temporarily_unavailable",
					disposition: "retryable",
					elapsedMs: 25,
				}),
			});
		}
	});
}

test("ClipRenderAttempt redacts signed access queries from diagnostics", async () => {
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000083",
		failure: "command",
		failureMessage:
			"Encoder rejected https://media.example/source.mp4?X-Amz-Signature=top-secret&token=private",
		outcome: {
			status: "queued",
			requested: 1,
			succeeded: 0,
			failed: 1,
			superseded: 0,
		},
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toMatchObject({ status: "queued" });

	const diagnostics = JSON.stringify(harness.diagnostics);
	expect(diagnostics).toContain("https://media.example/source.mp4?[redacted]");
	expect(diagnostics).not.toContain("top-secret");
	expect(diagnostics).not.toContain("token=private");
});

test("ClipRenderAttempt does not let a diagnostic sink failure reverse settlement", async () => {
	const expected: RenderGroupOutcome = {
		status: "completed",
		requested: 1,
		succeeded: 1,
		failed: 0,
		superseded: 0,
	};
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000084",
		diagnoseThrows: true,
		outcome: expected,
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
	expect(harness.variantState()).toBe("completed");
	expect(harness.objectReferences).toEqual(harness.uploadedKeys);
	expect(harness.settlementCalls()).toBe(1);
});

test("ClipRenderAttempt observes a rejected background upload task before settlement", async () => {
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000063",
		failure: "upload",
		failureWriteRejects: true,
		outcome: {
			status: "queued",
			requested: 1,
			succeeded: 0,
			failed: 1,
			superseded: 0,
		},
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).rejects.toBe(harness.injectedError);
	expect(harness.settlementCalls()).toBe(0);
	expect(
		harness.actions.indexOf("variant_failure:render_upload_failed:retryable"),
	).toBeLessThan(harness.actions.indexOf("workspace_cleanup"));
});

test("ClipRenderAttempt reports an owned deletion as superseded", async () => {
	const expected: RenderGroupOutcome = {
		status: "completed",
		requested: 1,
		succeeded: 0,
		failed: 0,
		superseded: 1,
	};
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000056",
		outcome: expected,
		superseded: true,
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
	expect(harness.variantState()).toBe("superseded");
	expect(harness.deletedKeys).toEqual(harness.uploadedKeys);
	expect(harness.objectReferences).toEqual([]);
	expect(harness.diagnostics).toContainEqual({
		message: "clip_render_variant_completion_stale_discarded",
		context: expect.objectContaining({
			workflowAttemptId: harness.attempt.attemptId,
			clipRenderId: "variant-ordinary",
			phase: "persistence",
			operation: "complete_clip_render_variant",
			failureCode: "variant_superseded",
			disposition: "superseded",
			objectKeyClass: "attempt_unique_render",
			cleanupResult: "deleted",
		}),
	});
});

test("ClipRenderAttempt diagnostics keep the owned attempt identity authoritative", async () => {
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000085",
		failure: "command",
		commandDiagnosticContext: {
			workflowRunId: "spoofed-run",
			workflowAttemptId: "spoofed-attempt",
			projectId: "spoofed-project",
			stage: "spoofed-stage",
			attemptCount: 99,
		},
		outcome: {
			status: "queued",
			requested: 1,
			succeeded: 0,
			failed: 1,
			superseded: 0,
		},
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toMatchObject({ status: "queued", failed: 1 });
	expect(harness.diagnostics).toContainEqual({
		message: "clip_render_command_operation",
		context: expect.objectContaining({
			workflowRunId: harness.attempt.workflowRunId,
			workflowAttemptId: harness.attempt.attemptId,
			projectId: harness.attempt.projectId,
			stage: harness.attempt.stage,
			attemptCount: harness.attempt.attemptCount,
		}),
	});
});

test("ClipRenderAttempt diagnoses provisional deletion failure without reversing supersession", async () => {
	const expected: RenderGroupOutcome = {
		status: "completed",
		requested: 1,
		succeeded: 0,
		failed: 0,
		superseded: 1,
	};
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000068",
		failure: "object_cleanup",
		outcome: expected,
		superseded: true,
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
	expect(harness.variantState()).toBe("superseded");
	expect(harness.objectReferences).toEqual([]);
	expect(harness.diagnostics).toContainEqual({
		message: "clip_render_provisional_cleanup_failed",
		context: expect.objectContaining({
			attemptId: harness.attempt.attemptId,
			phase: "cleanup",
			operation: "storage_delete",
			objectKey: harness.uploadedKeys[0],
			reason: "variant_superseded",
			failureCode: "provisional_object_delete_failed",
			disposition: "orphan_candidate",
		}),
	});
});

test("ClipRenderAttempt replays the same frozen work set idempotently", async () => {
	const expected: RenderGroupOutcome = {
		status: "completed",
		requested: 1,
		succeeded: 1,
		failed: 0,
		superseded: 0,
	};
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000057",
		outcome: expected,
	});
	const signal = new AbortController().signal;

	await expect(
		harness.clipRenderAttempt.execute(harness.attempt, attemptContext(signal)),
	).resolves.toEqual(expected);
	await expect(
		harness.clipRenderAttempt.execute(harness.attempt, attemptContext(signal)),
	).resolves.toEqual(expected);
	expect(harness.beginCalls()).toBe(2);
	expect(harness.settlementCalls()).toBe(2);
	expect(harness.uploadedKeys).toHaveLength(1);
	expect(harness.objectReferences).toEqual(harness.uploadedKeys);
});

for (const failure of ["begin", "state_load"] as const) {
	test(`ClipRenderAttempt leaves a ${failure} infrastructure failure for recovery`, async () => {
		const harness = createOrdinaryTracer({
			attemptId: `30000000-0000-4000-8000-00000000005${
				failure === "begin" ? "8" : "9"
			}`,
			failure,
			outcome: {
				status: "failed",
				requested: 1,
				succeeded: 0,
				failed: 1,
				superseded: 0,
			},
		});

		await expect(
			harness.clipRenderAttempt.execute(
				harness.attempt,
				attemptContext(new AbortController().signal),
			),
		).rejects.toBe(harness.injectedError);
		expect(harness.settlementCalls()).toBe(0);
		expect(harness.uploadedKeys).toEqual([]);
	});
}

test("ClipRenderAttempt retains a provisional object when completion loses ownership", async () => {
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000060",
		failure: "guarded_completion",
		outcome: {
			status: "failed",
			requested: 1,
			succeeded: 0,
			failed: 1,
			superseded: 0,
		},
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).rejects.toBeInstanceOf(WorkflowAttemptLost);
	expect(harness.deletedKeys).toEqual([]);
	expect(harness.objectReferences).toEqual([]);
	expect(harness.settlementCalls()).toBe(0);
	expect(
		harness.actions.some((action) => action.startsWith("variant_failure:")),
	).toBe(false);
	expect(harness.diagnostics).toContainEqual({
		message: "clip_render_attempt_interrupted",
		context: expect.objectContaining({
			workflowRunId: harness.attempt.workflowRunId,
			workflowAttemptId: harness.attempt.attemptId,
			projectId: harness.attempt.projectId,
			phase: "ownership",
			operation: "execute",
			failureCode: "workflow_attempt_lost",
			disposition: "control",
			retryState: "reaper_owned",
		}),
	});
});

test("ClipRenderAttempt retains a provisional object when guarded completion is uncertain", async () => {
	const expected: RenderGroupOutcome = {
		status: "queued",
		requested: 1,
		succeeded: 0,
		failed: 1,
		superseded: 0,
	};
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000062",
		failure: "guarded_completion_rejected",
		outcome: expected,
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
	expect(harness.deletedKeys).toEqual([]);
	expect(harness.objectReferences).toEqual([]);
	expect(harness.actions).toContain(
		"variant_failure:render_persistence_failed:retryable",
	);
	expect(harness.diagnostics).toContainEqual({
		message: "clip_render_variant_failed",
		context: expect.objectContaining({
			attemptId: harness.attempt.attemptId,
			phase: "persistence",
			operation: "complete_clip_render_variant",
			failureCode: "render_persistence_failed",
			disposition: "retryable",
			cleanupResult: "orphan_candidate",
		}),
	});
});

test("ClipRenderAttempt diagnoses cleanup failure without reversing settlement", async () => {
	const expected: RenderGroupOutcome = {
		status: "completed",
		requested: 1,
		succeeded: 1,
		failed: 0,
		superseded: 0,
	};
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000061",
		failure: "cleanup",
		outcome: expected,
	});

	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(expected);
	expect(harness.variantState()).toBe("completed");
	expect(harness.diagnostics).toContainEqual({
		message: "clip_render_workspace_cleanup_failed",
		context: expect.objectContaining({
			phase: "cleanup",
			operation: "scratch_cleanup",
		}),
	});
});

for (const phase of ["lookup", "enqueue", "synchronous_enqueue"] as const) {
	test(`ClipRenderAttempt keeps committed bytes when analytics ${phase} fails`, async () => {
		const outcome: RenderGroupOutcome = {
			status: "completed",
			requested: 1,
			succeeded: 1,
			failed: 0,
			superseded: 0,
		};
		const references = new Set<string>();
		const completion = mock<
			ClipRenderAttemptAdapters["clip"]["completeClipRenderVariant"]
		>(async (_attempt, _id, result) => {
			references.add(result.storageKey);
			return { persisted: true };
		});
		const harness = createOrdinaryTracer({
			attemptId: "30000000-0000-4000-8000-000000000070",
			outcome,
			productionCompletion: true,
			diagnoseThrows: true,
			groups: {
				completeClipRenderVariant: async (
					...args: Parameters<typeof completion>
				) => (await completion(...args)).persisted,
			},
		});
		const lookup = async () => {
			if (phase === "lookup") throw new Error("analytics read unavailable");
			return {
				aspectRatio: "ratio_9_16",
				clipId: "clip-ordinary",
				clip: { projectId: harness.attempt.projectId },
			};
		};
		const prisma = spyOn(database, "getPrismaClient").mockReturnValue({
			clipRender: { findUnique: lookup },
		} as never);
		const analytics = spyOn(
			analyticsService,
			"recordProjectEvent",
		).mockImplementation(() => {
			if (phase === "synchronous_enqueue")
				throw new Error("analytics enqueue unavailable");
			return Promise.reject(new Error("analytics enqueue unavailable"));
		});
		try {
			await expect(
				harness.clipRenderAttempt.execute(
					harness.attempt,
					attemptContext(new AbortController().signal),
				),
			).resolves.toEqual(outcome);
			expect(completion).toHaveBeenCalledTimes(1);
			expect([...references]).toEqual(harness.uploadedKeys);
			expect(references.size).toBe(1);
			expect(harness.deletedKeys).toEqual([]);
			expect(
				harness.actions.some((action) => action.startsWith("variant_failure:")),
			).toBe(false);
		} finally {
			analytics.mockRestore();
			prisma.mockRestore();
		}
	});
}

test("ClipRenderAttempt preserves a completed object's bytes after lost commit acknowledgement", async () => {
	const outcome: RenderGroupOutcome = {
		status: "completed",
		requested: 1,
		succeeded: 1,
		failed: 0,
		superseded: 0,
	};
	const harness = createOrdinaryTracer({
		attemptId: "30000000-0000-4000-8000-000000000071",
		outcome,
		commitAcknowledgementLost: true,
	});
	await expect(
		harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(new AbortController().signal),
		),
	).resolves.toEqual(outcome);
	expect(harness.variantState()).toBe("completed");
	expect(harness.objectReferences).toEqual(harness.uploadedKeys);
	expect(harness.objectReferences).toHaveLength(1);
	expect(harness.deletedKeys).toEqual([]);
	expect(harness.diagnostics).toContainEqual({
		message: "clip_render_variant_failed",
		context: expect.objectContaining({
			failureCode: "render_persistence_failed",
			cleanupResult: "orphan_candidate",
		}),
	});
	let referenceReads = 0;
	const recoveredDeletes: string[] = [];
	const reconciler = new RenderObjectReconciler({
		now: () => new Date("2026-10-29T12:00:00Z"),
		storage: {
			listPage: async (prefix) => ({
				objects: harness.uploadedKeys
					.filter((key) => key.startsWith(prefix))
					.map((key) => ({
						key,
						lastModified: new Date("2026-10-27T12:00:00Z"),
					})),
				nextContinuationToken: null,
			}),
			delete: async (key) => {
				recoveredDeletes.push(key);
			},
		},
		persistence: {
			listReferencedKeys: async () =>
				++referenceReads === 1
					? new Set<string>()
					: new Set(harness.objectReferences),
		},
	});
	await expect(
		reconciler.execute({ projectId: harness.attempt.projectId, delete: true }),
	).resolves.toMatchObject({ referenced: 1, orphaned: 0, deleted: 0 });
	expect(referenceReads).toBe(2);
	expect(recoveredDeletes).toEqual([]);
});

for (const referenceRead of ["rejected", "stalled", "referenced"] as const) {
	test(`ClipRenderAttempt retains a stale upload when its reference read is ${referenceRead}`, async () => {
		const outcome: RenderGroupOutcome = {
			status: "completed",
			requested: 1,
			succeeded: 0,
			failed: 0,
			superseded: 1,
		};
		const harness = createOrdinaryTracer({
			attemptId: "30000000-0000-4000-8000-000000000072",
			outcome,
			superseded: true,
			referenceRead,
		});
		await expect(
			harness.clipRenderAttempt.execute(
				harness.attempt,
				attemptContext(harness.sourceSignal),
			),
		).resolves.toEqual(outcome);
		harness.finishReferenceRead();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(harness.actions).toContain("reference_read");
		expect(harness.actions).not.toContain("object_cleanup");
		expect(harness.deletedKeys).toEqual([]);
		expect(harness.diagnostics).toContainEqual({
			message: "clip_render_variant_completion_stale_discarded",
			context: expect.objectContaining({
				cleanupResult:
					referenceRead === "referenced" ? "referenced" : "orphan_candidate",
			}),
		});
	});
}

for (const cancelAfterUpload of [false, true]) {
	test(`ClipRenderAttempt bounds a stalled cleanup ${cancelAfterUpload ? "after cancellation" : "after supersession"}`, async () => {
		const outcome: RenderGroupOutcome = {
			status: "completed",
			requested: 1,
			succeeded: 0,
			failed: 0,
			superseded: 1,
		};
		const harness = createOrdinaryTracer({
			attemptId: "30000000-0000-4000-8000-000000000073",
			outcome,
			superseded: true,
			cancelAfterUpload,
			cleanupStalls: true,
		});
		const execution = harness.clipRenderAttempt.execute(
			harness.attempt,
			attemptContext(harness.sourceSignal),
		);
		if (cancelAfterUpload)
			await expect(execution).rejects.toBe(harness.completionControlError);
		else await expect(execution).resolves.toEqual(outcome);
		expect(harness.cleanupSignals).toHaveLength(1);
		expect(harness.cleanupSignals[0]?.aborted).toBe(true);
		expect(harness.deletedKeys).toEqual([]);
		expect(harness.actions.at(-1)).toBe("workspace_cleanup");
		expect(harness.diagnostics).toContainEqual({
			message: "clip_render_provisional_cleanup_failed",
			context: expect.objectContaining({
				cleanupResult: "orphan_candidate",
				errorCode: "TimeoutError",
			}),
		});
		if (cancelAfterUpload)
			expect(harness.actions).not.toContain("guarded_completion");
	});
}

for (const completionControlFlow of [
	"cancellation",
	"ownership_loss",
] as const) {
	test(`ClipRenderAttempt preserves committed bytes and original ${completionControlFlow} during completion`, async () => {
		const outcome: RenderGroupOutcome = {
			status: "completed",
			requested: 1,
			succeeded: 1,
			failed: 0,
			superseded: 0,
		};
		const harness = createOrdinaryTracer({
			attemptId: "30000000-0000-4000-8000-000000000074",
			outcome,
			completionControlFlow,
		});
		await expect(
			harness.clipRenderAttempt.execute(
				harness.attempt,
				attemptContext(harness.sourceSignal),
			),
		).rejects.toBe(harness.completionControlError);
		expect(harness.variantState()).toBe("completed");
		expect(harness.objectReferences).toEqual(harness.uploadedKeys);
		expect(harness.objectReferences).toHaveLength(1);
		expect(harness.actions).not.toContain("reference_read");
		expect(harness.actions).not.toContain("object_cleanup");
		expect(harness.deletedKeys).toEqual([]);
		expect(
			harness.actions.some((action) => action.startsWith("variant_failure:")),
		).toBe(false);
	});
}

for (const phase of ["source", "encode"] as const) {
  test(`ClipRenderAttempt propagates ${phase} executor failure without variant fan-out or settlement`, async () => {
    const failure = new WorkerProcessFailure("worker_command_spawn_failed", "retryable", "spawn EBADF", "", null,
      { failureScope: "executor", errno: "EBADF", executableClass: phase === "source" ? "ffprobe" : "ffmpeg" });
    const harness = createOrdinaryTracer({ attemptId: "30000000-0000-4000-8000-000000000099",
      ...(phase === "source" ? { sourceHealthFailure: failure } : { commandHealthFailure: failure }),
      outcome: { status: "failed", requested: 1, succeeded: 0, failed: 1, superseded: 0 } });
    await expect(harness.clipRenderAttempt.execute(harness.attempt, attemptContext(new AbortController().signal))).rejects.toBe(failure);
    expect(harness.settlementCalls()).toBe(0);
    expect(harness.uploadedKeys).toEqual([]);
    expect(harness.actions.some((action) => action.startsWith("variant_failure:"))).toBe(false);
  });
}
