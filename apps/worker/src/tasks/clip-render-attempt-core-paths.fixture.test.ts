import type { RenderGroupOutcome } from "./clip-render-attempt";
import { RenderFactCache } from "../render-fact-cache";
import {
	createClipRenderAttempt,
	type ClipRenderAttemptRuntimeOptions,
} from "./clip-render-attempt-runtime";
import { compositionOutputExpectation, type RenderOutputExpectation } from "../render-output-validation";
import { expect } from "bun:test";
import {
	copyFile,
	mkdtemp,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clipService,
	type WorkflowAttemptContext,
	WorkflowFailure,
} from "@narriflow/services";
import type { TranscriptUtterance } from "@narriflow/validators";
import { parseRenderConfig } from "../render-config";
import { productionWorkerProcessModule, WorkerProcessFailure } from "../worker-process";
import {
	compileClipCompositionCommand,
} from "../composition-ffmpeg-adapter";
import { type ClipRenderingWorkflowAttempt } from "./clip-render-attempt";

export type PendingClipRender = Awaited<
	ReturnType<typeof clipService.getPendingClipRendersForWorkSet>
>[number];

export function attemptContext(signal: AbortSignal): WorkflowAttemptContext {
	return { signal, reportProgress: async () => {} };
}

export type CoreRenderTopology =
	| "single-video"
	| "shared-multi-output"
	| "studio-per-output"
	| "audiogram";

export type VariantState =
	| "pending"
	| "rendering"
	| "completed"
	| "retryable-failure"
	| "permanent-failure"
	| "superseded";

export interface CoreVariantFixture {
	id: string;
	aspectRatio: "ratio_9_16" | "ratio_1_1" | "ratio_16_9" | "ratio_4_5";
	clipId?: string;
	clipIndex?: number;
	initialState?: VariantState;
	resolution?: "720p" | "1080p";
	exportVariant?: {
		exportId: string;
		watermark: boolean;
	} | null;
	clipSnapshot?: Record<string, unknown> | null;
}

export interface CommandProbe {
	outputVariantIds: string[];
	args: readonly string[];
}

export function clipFixture(input: {
	hasStudioEdit: boolean;
	overrides?: Record<string, unknown>;
}) {
	return {
		id: "clip-core-paths",
		index: 0,
		startSec: 2,
		endSec: 12,
		llmModel: "test",
		transcriptSlice: [],
		deletedRanges: null,
		captionPreset: null,
		studioEdits: input.hasStudioEdit
			? { sourceAudio: { volume: 100, muted: true } }
			: null,
		wholeSource: false,
		editorDocumentVersion: 1,
		sceneBlocks: [],
		censorSegments: [],
		mediaMotions: [],
		brollCues: null,
		brollUrl: null,
		category: "other",
		...input.overrides,
	};
}

export function createCoreRenderPathTracer(input: {
	topology: CoreRenderTopology;
	attemptCount?: number;
	clipWindow?: { startSec: number; endSec: number };
	variants?: CoreVariantFixture[];
	failCommandsForVariantIds?: readonly string[];
	failFirstRenderCommand?: boolean;
	commandFailureDisposition?: "retryable" | "permanent";
	failCommandsContaining?: string;
	failUploadsForVariantIds?: readonly string[];
	rejectPersistenceForVariantIds?: readonly string[];
	supersedeCompletionsForVariantIds?: readonly string[];
	pricingTier?: "free" | "creator";
	transcriptSlice?: TranscriptUtterance[];
	clipOverrides?: Record<string, unknown>;
	projectBrandSnapshot?: unknown;
	projectBrandSnapshotFailure?: Error;
	logoDownloadFailure?: Error;
	configOverrides?: Record<string, string>;
	brollProviderFailure?: Error;
	brollCutaways?: Array<{
		query: string;
		downloadUrl: string;
		startSec: number;
		endSec: number;
		attribution: {
			authorName: string;
			authorUrl: string;
			pageUrl: string;
		};
	}>;
	brollDurationSec?: number | null;
	audioAssetFailure?: Error;
	audioAssetUrl?: string;
	audioAssets?: Readonly<Record<string, { url: string; durationSec: number }>>;
	optionalMediaFiles?: Readonly<Record<string, string>>;
	optionalDownloadFailure?: Error;
	useRuntimeOptionalDownload?: boolean;
	remoteMedia?: NonNullable<
		ClipRenderAttemptRuntimeOptions["adapters"]
	>["remoteMedia"];
	optionalMediaInvalidFor?: "video" | "audio" | "image";
 optionalValidationFailure?: Error;
 renderFailure?: Error;
	backgroundDecodable?: boolean;
	faceAnalysisSamples?: Array<{ t: number; cx: number | null }> | null;
	faceAnalysisFailure?: Error;
	analysisExtractionFailure?: Error;
	analysisPersistenceFailure?: Error;
	analysisProcessOutcome?:
		| "missing"
		| "timeout"
		| "nonzero"
		| "invalid"
		| "no-face"
		| "cancel";
	analysisAbortController?: AbortController;
	multiFaceAnalysisSamples?: Array<{
		t: number;
		faces: Array<{
			cx: number;
			cy: number;
			w: number;
			h: number;
			score: number;
		}>;
	}> | null;
	pipAnalysisResult?: {
		movingPxFrac: number | null;
		insufficientSamples: boolean;
		candidates: Array<{
			x: number;
			y: number;
			w: number;
			h: number;
			areaFrac: number;
			fillFrac: number;
			cornerAdjacent: boolean;
			medianDiffMean: number;
		}>;
	} | null;
	/** Decoded-peak measurements returned in order by the fake ffmpeg (default:
	 *  a mix that fits). Real-media tests measure the real output instead. */
	mixPeaks?: Array<{ samplePeak: number; truePeak: number }>;
	/** How many render encodes report a libass missing glyph on stderr (while exiting zero). */
	captionGlyphReports?: number;
	invalidOutput?: "no-stream" | "short";
	realMedia?: {
		sourcePath: string;
		logoPath?: string;
		probeOutput(variantId: string, filePath: string): Promise<void>;
    probeCandidate?(variantId: string, filePath: string): Promise<void>;
	};
	/** Runs inside the fake object store's PUT, so a test can hold an upload open. */
	uploadGate?: (variantId: string, filePath: string, signal?: AbortSignal) => Promise<void>;
	sourceAccess?: {
		presignedUrl: string;
		failRangedProbe?: boolean;
 probeFailure?: Error;
 sourceSizeBytes?: number | null;
 diskFreeBytes?: number;
	};
	compositionAdapterFailure?: Error;
	workspaceCleanupFailure?: Error;
	resourceMeasure?: () => {
		rssBytes: number;
		scope:
			| "worker_and_command_cgroup"
			| "worker_and_command_processes"
			| "worker_only";
	};
}) {
	const attempt: ClipRenderingWorkflowAttempt = {
		workflowRunId: "10000000-0000-4000-8000-000000000701",
		projectId: "20000000-0000-4000-8000-000000000702",
		stage: "clip_rendering",
		attemptId: "30000000-0000-4000-8000-000000000703",
		attemptCount: input.attemptCount ?? 1,
	};
	const defaultVariants: CoreVariantFixture[] =
		input.topology === "single-video"
			? [{ id: "variant-9x16", aspectRatio: "ratio_9_16" }]
			: [
					{ id: "variant-9x16", aspectRatio: "ratio_9_16" },
					{ id: "variant-1x1", aspectRatio: "ratio_1_1" },
				];
	const variantFixtures = input.variants ?? defaultVariants;
	const pendingRenders = variantFixtures.map((variant) => ({
		id: variant.id,
		clipId: variant.clipId ?? "clip-core-paths",
		aspectRatio: variant.aspectRatio,
		resolution: variant.resolution ?? "1080p",
		exportVariantId: variant.exportVariant ? `export-${variant.id}` : null,
		exportVariant: variant.exportVariant
			? {
					id: `export-${variant.id}`,
					exportId: variant.exportVariant.exportId,
					watermark: variant.exportVariant.watermark,
				}
			: null,
		clipSnapshot: variant.clipSnapshot ?? null,
		clip: clipFixture({
			hasStudioEdit: input.topology === "studio-per-output",
			overrides: {
				id: variant.clipId ?? "clip-core-paths",
				index: variant.clipIndex ?? 0,
				transcriptSlice: input.transcriptSlice ?? [],
				...input.clipOverrides,
				...input.clipWindow,
			},
		}),
	})) as unknown as PendingClipRender[];
	const states = new Map(
		variantFixtures.map((variant) => [
			variant.id,
			variant.initialState ?? "pending",
		]),
	);
	const failureCodes = new Map<string, string>();
	const failureDispositions = new Map<string, "retryable" | "permanent">();
	const commands: CommandProbe[] = [];
  const outputExpectations = new Map<string, RenderOutputExpectation>();
	const uploadedVariantIds: string[] = [];
	const persistedVariantIds: string[] = [];
  const persistedFacts = new Map<string, { sizeBytes: number; durationSec: number }>();
	const mutationVariantIds: string[] = [];
	const diagnostics: Array<{
		message: string;
		context?: Record<string, unknown>;
	}> = [];
	const sourceDownloads: string[] = [];
 const brollCacheWrites: string[] = [];
	const persistedAutoLayouts: Array<unknown> = [];
	const persistedSplitLayouts: Array<unknown> = [];
	const persistedScreenLayouts: Array<unknown> = [];
	let analysisExtractionCount = 0;
	let faceDetectorCount = 0;
	let multiFaceDetectorCount = 0;
	let pipDetectorCount = 0;
	let sceneDetectorCount = 0;
	let workspaceCleanupCount = 0;
	let mixPeakMeasurements = 0;
	let captionGlyphReportsLeft = input.captionGlyphReports ?? 0;
	let settlementCalls = 0;

	const variantIdFromPath = (path: string): string | null =>
		variantFixtures.find((variant) => path.includes(variant.id))?.id ?? null;
	const outputVariantIds = (args: readonly string[]): string[] =>
		args.flatMap((arg) => {
			if (!arg.endsWith(".mp4") || !arg.includes("/clip-")) return [];
			const variantId = variantIdFromPath(arg);
			return variantId ? [variantId] : [];
		});
	const recordCommand = (args: readonly string[]): string[] => {
		const ids = outputVariantIds(args);
		if (ids.length > 0) commands.push({
			outputVariantIds: ids,
			args: [...args],
		});
		return ids;
	};

	const settle = (): RenderGroupOutcome => {
		settlementCalls += 1;
		const requested = variantFixtures.length;
		const succeeded = [...states.values()].filter(
			(state) => state === "completed",
		).length;
		const superseded = [...states.values()].filter(
			(state) => state === "superseded",
		).length;
		const retryableIds = variantFixtures.flatMap((variant) => {
			const state = states.get(variant.id);
			return state === "pending" ||
				state === "rendering" ||
				state === "retryable-failure"
				? [variant.id]
				: [];
		});
		const permanentFailed = [...states.values()].filter(
			(state) => state === "permanent-failure",
		).length;

		if (
			succeeded === 0 &&
			retryableIds.length > 0 &&
			attempt.attemptCount < 3
		) {
			for (const variantId of retryableIds) states.set(variantId, "pending");
			return {
				status: "queued",
				requested,
				succeeded,
				failed: permanentFailed,
				superseded,
			};
		}

		const failed = requested - succeeded - superseded;
		return {
			status:
				succeeded > 0 && failed > 0
					? "partial"
					: succeeded > 0 || failed === 0
						? "completed"
						: "failed",
			requested,
			succeeded,
			failed,
			superseded,
		};
	};

	const writtenFiles: Array<{ path: string; content: string }> = [];
	const renderDeadlines: number[] = [];
	const config = parseRenderConfig({
		WORKER_RENDER_SOURCE_MODE: input.sourceAccess ? "ranged" : "download",
		...input.configOverrides,
	});
	const clipRenderAttempt = createClipRenderAttempt({
		group: { workflowRunId: "", workSetGeneration: "", groupId: "", token: "", owner: "" },
		groups: {} as never,
		run: {
			id: attempt.workflowRunId,
			projectId: attempt.projectId,
			project: {
				title: "Core render paths",
				sourceStorageKey: `projects/${attempt.projectId}/source/input.${
					input.topology === "audiogram" ? "m4a" : "mp4"
				}`,
				sourceDurationSeconds: 20,
				workspaceOwnerUserId: "user-core-paths",
				workspaceId: "workspace",
			},
		},
		config,
		lifecycle: {
			startExecution: async () => {},
			beginRenderGroup: async () => ({
				variantIds: variantFixtures.map((variant) => variant.id),
			}),
			finishRenderGroup: async () => settle(),
		},
		adapters: {
			...(input.remoteMedia ? { remoteMedia: input.remoteMedia } : {}),
			facts: new RenderFactCache(),
   // Nothing was stored since the snapshot; never reach the database.
			layoutEvidence: { readCompatibleDurable: async () => null },
			state: {
				getProjectRenderStorageReferences: async () => new Set<string>(),
				getFrozenRenderingStateForWorkSet: async () => ({
					sourceStorageKey: `projects/${attempt.projectId}/source/input.${
						input.topology === "audiogram" ? "m4a" : "mp4"
					}`,
					sourceDurationSeconds: 20,
     sourceSizeBytes: input.sourceAccess?.sourceSizeBytes === undefined ? 4096 : input.sourceAccess.sourceSizeBytes,
					workspaceOwnerUserId: "user-core-paths",
					workspaceId: "workspace",
					pricingTier: input.pricingTier ?? "creator",
					brandSnapshot: input.projectBrandSnapshotFailure
						? { status: "unavailable" as const }
						: {
								status: "available" as const,
								value: input.projectBrandSnapshot ?? null,
							},
					pendingRenders: pendingRenders.filter(
						(render) => states.get(render.id) === "pending",
					),
				}),
			},
			workerProcess: {
				inspectMedia: async (request) => {
     if (input.sourceAccess?.probeFailure && request.sourcePath === input.sourceAccess.presignedUrl) throw input.sourceAccess.probeFailure;
					if (input.realMedia) {
						if (
							input.sourceAccess?.failRangedProbe &&
							request.sourcePath === input.sourceAccess.presignedUrl
						) {
							throw new WorkerProcessFailure("worker_command_failed", "retryable", "Injected ranged probe failure", "HTTP error 503 Service Unavailable");
						}
						if (outputExpectations.has(request.sourcePath)) {
              await input.realMedia.probeCandidate?.(variantIdFromPath(request.sourcePath)!, request.sourcePath);
            }
            return productionWorkerProcessModule.inspectMedia(request);
					}
          const expected = outputExpectations.get(request.sourcePath);
          if (expected) {
            const durationSec = input.invalidOutput === "short" ? expected.durationSec / 2 : expected.durationSec;
            const stream = { index: 0, codec: "h264", profile: "High", timeBase: { numerator: 1, denominator: 15360 }, startPts: 0, startTimeSec: 0, durationTs: null, durationSec, endTimeSec: durationSec, frameCount: Math.round(durationSec * expected.frameRate.numerator / expected.frameRate.denominator), bitRate: null };
            return {
              durationSec, width: expected.width, height: expected.height, fps: expected.frameRate.numerator / expected.frameRate.denominator,
              hasVideo: input.invalidOutput !== "no-stream", hasVisualStream: true, hasAudio: expected.audio !== null,
              facts: {
                format: { name: "mov,mp4,m4a,3gp,3g2,mj2", startTimeSec: 0, durationSec, sizeBytes: 4096, bitRate: null }, attachedPictureCount: 0,
                videos: input.invalidOutput === "no-stream" ? [] : [{ ...stream, width: expected.width, height: expected.height, codedWidth: expected.width, codedHeight: expected.height, displayWidth: expected.width, displayHeight: expected.height,
                  sampleAspectRatio: expected.sampleAspectRatio, displayMatrix: null, rotationDeg: 0, reflected: false, avgFrameRate: expected.frameRate, rFrameRate: expected.frameRate, pixelFormat: "yuv420p", colorRange: null, colorSpace: null, colorTransfer: null, colorPrimaries: null, chromaLocation: null, fieldOrder: null, masteringDisplay: null, contentLight: null, dolbyVision: null, ...(expected.color.mode === "asserted" ? expected.color.tags : {}) }],
                audios: expected.audio === null ? [] : [{ ...stream, index: 1, codec: "aac", profile: "LC", frameCount: null, sampleRate: expected.audio.sampleRate ?? 48000, channels: expected.audio.channels ?? 2, channelLayout: "stereo", sampleFormat: "fltp", initialPadding: 0, trailingPadding: 0 }],
              },
            };
          }
					return {
						durationSec: 20,
						width: input.topology === "audiogram" ? 0 : 1920,
						height: input.topology === "audiogram" ? 0 : 1080,
						hasVideo: input.topology !== "audiogram",
						hasAudio: true,
						hasVisualStream: input.topology !== "audiogram",
						fps: 30,
					};
				},
				execute: async (request) => {
					const { command, args } = request;
					if (command !== "ffmpeg") {
						switch (input.analysisProcessOutcome) {
							case "missing":
								throw new WorkflowFailure(
									"worker_command_missing",
									"permanent",
									"Injected missing analysis executable",
								);
							case "timeout":
								throw new WorkflowFailure(
									"worker_command_timeout",
									"retryable",
									"Injected analysis timeout",
								);
							case "nonzero":
								throw new WorkflowFailure(
									"worker_command_failed",
									"retryable",
									"Injected nonzero analysis exit",
								);
							case "invalid":
								return { exitCode: 0, stdout: Buffer.from("not-json") };
							case "no-face":
								return {
									exitCode: 0,
									stdout: Buffer.from(JSON.stringify({ samples: [] })),
								};
							case "cancel": {
								const reason = new DOMException(
									"Injected analysis cancellation",
									"AbortError",
								);
								input.analysisAbortController?.abort(reason);
								request.signal.throwIfAborted();
								throw reason;
							}
							default:
								return { exitCode: 0, stdout: Buffer.from(JSON.stringify(args[0]?.endsWith("pip_detect.py") ? { movingPxFrac: null, insufficientSamples: true, candidates: [] } : { samples: [] })) };
						}
					}
					expect(command).toBe("ffmpeg");
          if (args.includes("framecrc")) {
            if (input.realMedia) return productionWorkerProcessModule.execute(request);
            const expected = outputExpectations.get(args[args.indexOf("-i") + 1]!)!;
            const fps = expected.frameRate.numerator / expected.frameRate.denominator;
            const count = Math.round(expected.durationSec * fps * (input.invalidOutput === "short" ? 0.5 : 1));
            return { exitCode: 0, stdout: Buffer.from(
              `#tb 0: ${expected.frameRate.denominator}/${expected.frameRate.numerator}\n#media_type 0: video\n` +
              Array.from({ length: count }, (_, i) => `0, ${i}, ${i}, 1, 416, 0x0`).join("\n") +
              (expected.audio === null ? "" : `\n#tb 1: 1/48000\n#media_type 1: audio\n1, 0, 0, ${Math.round(count / fps * 48000)}, 4096, 0x0`) + "\n",
            ) };
          }

					if (args.some((arg) => arg.includes("ametadata=mode=print"))) {
						if (input.realMedia) return productionWorkerProcessModule.execute(request);
						const peak = input.mixPeaks?.[mixPeakMeasurements++] ??
							input.mixPeaks?.at(-1) ?? { samplePeak: 0.5, truePeak: 0.5 };
						return {
							exitCode: 0,
							stdout: Buffer.from(
								`lavfi.astats.Overall.Max_level=${peak.samplePeak}\nlavfi.r128.true_peak=${peak.truePeak}\n`,
							),
						};
					}
					const ids = recordCommand(args);
					if (ids.length) renderDeadlines.push(request.deadlineMs);
     if (ids.length && input.renderFailure) throw input.renderFailure;
					if (input.failFirstRenderCommand && ids.length > 0 && commands.length === 1) {
						throw new WorkflowFailure(
							"worker_command_input_invalid",
							"permanent",
							"Injected first optional-media command failure",
						);
					}
					if (ids.some((id) => input.failCommandsForVariantIds?.includes(id))) {
						throw new WorkflowFailure(
							"ffmpeg_render_failed",
							input.commandFailureDisposition ?? "retryable",
							"Injected command failure",
						);
					}
					if (
						input.failCommandsContaining &&
						args.some((arg) => arg.includes(input.failCommandsContaining!))
					) {
						throw new WorkflowFailure(
							"worker_command_input_invalid",
							"permanent",
							"Injected optional-media command failure",
						);
					}
					if (captionGlyphReportsLeft > 0 && request.stderrLinePattern) {
						captionGlyphReportsLeft -= 1;
						return {
							exitCode: 0,
							stdout: Buffer.alloc(0),
							stderrLines: ["[Parsed_ass_4 @ 0x1] fontselect: failed to find any fallback with glyph 0x2605 for font: (Montserrat Black, 400, 0)"],
						};
					}
					return input.realMedia
						? productionWorkerProcessModule.execute(request)
						: { exitCode: 0, stdout: Buffer.alloc(0) };
				},
				withScratchDirectory: async (_prefix, work, diagnose) => {
					const path = input.realMedia
						? await mkdtemp(join(tmpdir(), "narriflow-core-render-paths-"))
						: "/tmp/narriflow-core-render-paths";
					try {
						return await work(path);
					} finally {
						workspaceCleanupCount += 1;
						if (input.workspaceCleanupFailure) {
							diagnose?.({
								operation: "scratch_cleanup",
								status: "failed",
								elapsedMs: 0,
								failureCode: "worker_scratch_cleanup_failed",
							});
						} else if (input.realMedia) {
							await rm(path, { recursive: true, force: true });
						}
					}
				},
			},
      composition: {
        compileCommand: (request) => {
          if (input.compositionAdapterFailure) throw input.compositionAdapterFailure;
          outputExpectations.set(request.outputPath, compositionOutputExpectation({ plan: request.plan, targetId: request.targetId, source: request.source, audio: request.audio! }));
          return compileClipCompositionCommand(request);
        },
      },
			optionalAssets: {
				validateOptionalMedia: async (_path, kind) => {
     if (input.optionalValidationFailure) throw input.optionalValidationFailure;
     return input.optionalMediaInvalidFor !== kind;
    },
				...(input.brollProviderFailure
					? {
							resolveBrollCutaways: async () => {
								throw input.brollProviderFailure;
							},
						}
					: input.brollCutaways
						? {
								resolveBrollCutaways: async () => input.brollCutaways!,
								getCachedBrollAssetPath: async () => null,
								saveBrollAssetToCache: async (url: string) => {
									brollCacheWrites.push(url);
								},
							}
						: {}),
				...(input.useRuntimeOptionalDownload
					? {}
					: input.optionalDownloadFailure
						? {
								downloadUrlToFile: async () => {
									throw input.optionalDownloadFailure;
								},
							}
						: {
								downloadUrlToFile: async (url, filePath) => {
									const sourcePath = input.optionalMediaFiles?.[url];
									if (sourcePath) await copyFile(sourcePath, filePath);
								},
							}),
				...(input.backgroundDecodable !== undefined
					? {
							probeBackgroundImageDecodable: async () =>
								input.backgroundDecodable!,
						}
					: {}),
				...(input.brollDurationSec !== undefined
					? {
							probeMediaDurationSec: async () => input.brollDurationSec!,
						}
					: {}),
			},
			...(input.audioAssetFailure || input.audioAssetUrl || input.audioAssets
				? {
						audioAsset: {
							resolveRenderSource: async (_userId, assetId) => {
								if (input.audioAssetFailure) throw input.audioAssetFailure;
								const asset = input.audioAssets?.[assetId];
								if (asset) {
									return {
										url: asset.url,
										title: "Optional audio",
										durationSec: asset.durationSec,
									};
								}
								return input.audioAssetUrl
									? {
											url: input.audioAssetUrl,
											title: "Optional audio",
											durationSec: 0.4,
										}
									: null;
							},
						},
					}
				: {}),
			...(input.faceAnalysisSamples !== undefined ||
			input.faceAnalysisFailure ||
			input.analysisExtractionFailure ||
			input.multiFaceAnalysisSamples !== undefined ||
			input.pipAnalysisResult !== undefined
				? {
						analysis: {
							extractFaceDetectionSegment: async (params) => {
								analysisExtractionCount += 1;
								if (input.analysisExtractionFailure) {
									throw input.analysisExtractionFailure;
								}
								return {
									path: `${params.tempDir}/extracted-analysis.mp4`,
									startSec: 0,
								};
							},
							...(input.faceAnalysisSamples !== undefined ||
							input.faceAnalysisFailure
								? {
										detectFacePath: async () => {
											faceDetectorCount += 1;
											if (input.faceAnalysisFailure) {
												throw input.faceAnalysisFailure;
											}
											return input.faceAnalysisSamples
												? { samples: input.faceAnalysisSamples }
												: null;
										},
									}
								: {}),
							...(input.multiFaceAnalysisSamples !== undefined
								? {
										detectMultiFacePath: async () => {
											multiFaceDetectorCount += 1;
											return input.multiFaceAnalysisSamples
												? { samples: input.multiFaceAnalysisSamples }
												: null;
										},
										detectSceneCuts: async () => {
											sceneDetectorCount += 1;
											return [];
										},
									}
								: {}),
							...(input.pipAnalysisResult !== undefined
								? {
										detectPipPath: async () => {
											pipDetectorCount += 1;
											return input.pipAnalysisResult ?? null;
										},
									}
								: {}),
						},
					}
				: {}),
			clip: {
				completeClipAutoLayoutAnalysis: async (_attempt, _clipId, analysis) => {
					if (input.analysisPersistenceFailure) {
						throw input.analysisPersistenceFailure;
					}
					persistedAutoLayouts.push(analysis);
					return false;
				},
				completeClipSplitLayoutAnalysis: async (
					_attempt,
					_clipId,
					analysis,
				) => {
					if (input.analysisPersistenceFailure) {
						throw input.analysisPersistenceFailure;
					}
					persistedSplitLayouts.push(analysis);
					return true;
				},
				completeClipSplitLayoutFailure: async (_attempt, _clipId, failure) => {
					persistedSplitLayouts.push(failure);
					return true;
				},
				completeClipRenderVariant: async (_attempt, variantId, result) => {
          persistedFacts.set(variantId, { sizeBytes: result.sizeBytes, durationSec: result.durationSec });
					mutationVariantIds.push(variantId);
					if (input.rejectPersistenceForVariantIds?.includes(variantId)) {
						throw new Error("Injected guarded persistence rejection");
					}
					if (input.supersedeCompletionsForVariantIds?.includes(variantId)) {
						states.set(variantId, "superseded");
						return { persisted: false };
					}
					states.set(variantId, "completed");
					persistedVariantIds.push(variantId);
					return { persisted: true };
				},
				failClipRenderVariant: async (
					_attempt,
					variantId,
					code,
					disposition,
				) => {
					mutationVariantIds.push(variantId);
					states.set(
						variantId,
						disposition === "retryable"
							? "retryable-failure"
							: "permanent-failure",
					);
					failureCodes.set(variantId, code);
					failureDispositions.set(variantId, disposition);
				},
				markClipRenderVariantRendering: async (_attempt, variantId) => {
					mutationVariantIds.push(variantId);
					if (states.get(variantId) !== "pending") return false;
					states.set(variantId, "rendering");
					return true;
				},
				setClipLayoutAnalysis: async (_attempt, _clipId, analysis) => {
					if (input.analysisPersistenceFailure) {
						throw input.analysisPersistenceFailure;
					}
					persistedScreenLayouts.push(analysis);
				},
				setClipLayoutAnalysisFailure: async (_attempt, _clipId, failure) => {
					persistedScreenLayouts.push(failure);
				},
			},
			storage: {
				presignDownloadUrl: async () => input.sourceAccess?.presignedUrl ?? "",
				downloadObjectToFile: async ({ key, filePath }) => {
     sourceDownloads.push(key);
					if (input.logoDownloadFailure && key.endsWith("/logo.png")) {
						throw input.logoDownloadFailure;
					}
					if (input.realMedia) {
						await copyFile(
							key.endsWith("/logo.png") && input.realMedia.logoPath
								? input.realMedia.logoPath
								: input.realMedia.sourcePath,
							filePath,
						);
					}
				},
				putFileFromPath: async ({ filePath, key, signal }) => {
					const variantId = variantIdFromPath(filePath);
					if (!variantId) throw new Error(`Unknown output path: ${filePath}`);
					await input.uploadGate?.(variantId, filePath, signal);
					if (input.failUploadsForVariantIds?.includes(variantId)) {
						throw new WorkflowFailure(
							"render_upload_failed",
							"retryable",
							"Injected upload failure",
						);
					}
					await input.realMedia?.probeOutput(variantId, filePath);
					uploadedVariantIds.push(variantId);
					return { key };
				},
				deleteObject: async (key) => ({ key }),
			},
			workspace: {
    ...(input.sourceAccess?.diskFreeBytes === undefined ? {} : { statfs: async () => ({ bavail: input.sourceAccess!.diskFreeBytes!, bsize: 1, blocks: 20 * 1024 ** 3 }) as never }),
				stat: input.realMedia ? stat : async () => ({ size: 4096, isFile: () => true }) as never,
				writeFile: async (path, content, options) => {
					writtenFiles.push({ path: String(path), content: String(content) });
					if (input.realMedia) await writeFile(path, content, options);
				},
			},
			...(input.resourceMeasure
				? { resource: { measure: input.resourceMeasure } }
				: {}),
			diagnose: ({ message, context }) =>
				diagnostics.push({ message, context }),
		},
	});

	return {
		attempt,
		analysisCounts: () => ({
			extraction: analysisExtractionCount,
			face: faceDetectorCount,
			multiFace: multiFaceDetectorCount,
			pip: pipDetectorCount,
			scene: sceneDetectorCount,
		}),
		brollCacheWrites,
  sourceDownloads,
		clipRenderAttempt,
		config,
		renderDeadlines,
		commands,
		diagnostics,
		failureCodes,
		failureDispositions,
		mutationVariantIds,
		persistedVariantIds,
    persistedFacts,
		persistedAutoLayouts,
		persistedSplitLayouts,
		persistedScreenLayouts,
		settlementCalls: () => settlementCalls,
		workspaceCleanupCount: () => workspaceCleanupCount,
		writtenFiles,
		states,
		uploadedVariantIds,
	};
}

