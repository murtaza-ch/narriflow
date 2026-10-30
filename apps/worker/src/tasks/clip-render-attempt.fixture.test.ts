import { RenderFactCache } from "../render-fact-cache";
import { createRenderOutputFixture } from "../render-output-validation.test-fixture";
import { createClipRenderAttempt } from "./clip-render-attempt-runtime";
import { expect } from "bun:test";
import { copyFile } from "node:fs/promises";
import {
	clipService,
	type MotionRenderAnalyticsMetadata,
	type WorkflowAttemptContext,
	WorkflowAttemptLost,
	WorkflowFailure,
} from "@narriflow/services";
import { parseRenderConfig } from "../render-config";
import {
 WorkerProcessFailure,
	type WorkerProcessModule,
} from "../worker-process";
import {
	type RenderGroupOutcome,
	type ClipRenderingWorkflowAttempt,
} from "./clip-render-attempt";

export type PendingClipRender = Awaited<
	ReturnType<typeof clipService.getPendingClipRendersForWorkSet>
>[number];

export function attemptContext(signal: AbortSignal): WorkflowAttemptContext {
	return { signal, reportProgress: async () => {} };
}

export function frozenRenderingState(
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

export type OrdinaryTracerFailure =
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

export type SourceFailure = Extract<
	OrdinaryTracerFailure,
	"presign" | "ranged_probe" | "download" | "local_probe"
>;

export function createOrdinaryTracer(input: {
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

