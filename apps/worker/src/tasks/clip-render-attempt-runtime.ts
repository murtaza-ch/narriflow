import {
	createWriteStream as productionCreateWriteStream,
	readFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline as productionPipeline } from "node:stream/promises";
import { getPrismaClient } from "@narriflow/db/client";
import {
	assertResponseContentLength,
	analyticsService,
	audioAssetService as productionAudioAssetService,
	clipService as productionClipService,
	createByteLimitTransform,
	deleteObject as productionDeleteObject,
	downloadObjectToFile as productionDownloadObjectToFile,
	guardedFetch as productionGuardedFetch,
	getWorkflowRunLifecycle,
	presignDownloadUrl as productionPresignDownloadUrl,
	putFileFromPath as productionPutFileFromPath,
	rethrowWorkflowAttemptLost,
	RemoteFetchError,
	UnsafeUrlError,
	WorkflowFailure,
	workflowHttpFailureDisposition,
	type MotionRenderAnalyticsMetadata,
} from "@narriflow/services";
import type { RenderConfig } from "../render-config";
import {
	productionWorkerProcessModule,
	type WorkerProcessDiagnostic,
} from "../worker-process";
import { productionRenderDiagnosticAdapter } from "../render-diagnostic-adapter";
import {
	productionRenderClockAdapter,
	productionRenderWorkspaceAdapter,
} from "../render-runtime-adapters";
import { createLayoutEvidenceDetectors } from "../layout-evidence-runtime";
import {
	compileClipCompositionCommand,
	compileLayoutEvidenceSegmentCommand,
	compileOptionalMediaValidationCommand,
} from "../composition-ffmpeg-adapter";
import {
	getCachedBrollAssetPath,
	saveBrollAssetToCache,
	resolveBrollCutaways,
} from "./broll";
import {
	ClipRenderAttempt,
	type ClipRenderAttemptDependencies,
	type ClipRenderAttemptAdapters,
	type ClipRenderAttemptAdapterOverrides,
	type CompositionResourceMeasurement,
} from "./clip-render-attempt";

export interface ClipRenderAttemptRuntimeOptions
	extends Omit<ClipRenderAttemptDependencies, "adapters"> {
	adapters?: ClipRenderAttemptAdapterOverrides & {
		remoteMedia?: Partial<RemoteMediaAdapter>;
	};
}

export function createClipRenderAttempt(
	input: ClipRenderAttemptRuntimeOptions,
): ClipRenderAttempt {
	return new ClipRenderAttempt({
		...input,
		adapters: (signal, withAttemptDiagnosticContext) =>
			createRuntimeAdapters(
				input.config,
				signal,
				withAttemptDiagnosticContext,
				input.adapters,
			),
	});
}

function createRuntimeAdapters(
	config: Readonly<RenderConfig>,
	signal: AbortSignal,
	withAttemptDiagnosticContext: Parameters<
		ClipRenderAttemptDependencies["adapters"]
	>[1],
	overrides?: ClipRenderAttemptRuntimeOptions["adapters"],
): ClipRenderAttemptAdapters {
	const baseDiagnose =
		overrides?.diagnose ?? productionRenderDiagnosticAdapter.diagnose;
	const diagnose = withAttemptDiagnosticContext(baseDiagnose);
	const workerProcess = {
		execute:
			overrides?.workerProcess?.execute?.bind(overrides.workerProcess) ??
			productionWorkerProcessModule.execute.bind(productionWorkerProcessModule),
		inspectMedia:
			overrides?.workerProcess?.inspectMedia?.bind(overrides.workerProcess) ??
			productionWorkerProcessModule.inspectMedia.bind(
				productionWorkerProcessModule,
			),
		withScratchDirectory:
			overrides?.workerProcess?.withScratchDirectory?.bind(
				overrides.workerProcess,
			) ??
			productionWorkerProcessModule.withScratchDirectory.bind(
				productionWorkerProcessModule,
			),
	};
	const rethrowRenderControlFlow = (error: unknown): void => {
		rethrowWorkflowAttemptLost(error);
		signal.throwIfAborted();
	};
	const rethrowRenderCancellation = (_error: unknown): void => {
		signal.throwIfAborted();
	};
	const detectors = createLayoutEvidenceDetectors({
		workerProcess,
		config,
		signal,
		rethrowControl: rethrowRenderControlFlow,
	});
	function log(
		level: "info" | "error",
		message: string,
		context?: Record<string, unknown>,
	) {
		try {
			diagnose({ level, message, context });
		} catch {
			/* Diagnostics cannot change settlement. */
		}
	}
	function diagnoseRenderProcessOperation(event: WorkerProcessDiagnostic) {
		log(
			event.status === "failed" ? "error" : "info",
			"clip_render_command_operation",
			{ phase: "command_execution", ...event },
		);
	}
	async function execCommand(
		command: string,
		args: string[],
		options?: { timeoutMs?: number },
	) {
		await workerProcess.execute({
			command,
			args,
			signal,
			deadlineMs: options?.timeoutMs ?? config.renderCommandTimeoutMs,
			diagnose: diagnoseRenderProcessOperation,
		});
	}
	// Bind service prototype methods before merging runtime adapter overrides.
	const productionClipMutationAdapter: ClipRenderAttemptAdapters["clip"] = {
		markClipRenderVariantRendering: (attempt, clipRenderId) =>
			getWorkflowRunLifecycle().markClipRenderVariantRendering(
				attempt,
				clipRenderId,
			),
		completeClipRenderVariant: async (attempt, clipRenderId, input) => {
			const persisted =
				await getWorkflowRunLifecycle().completeClipRenderVariant(
					attempt,
					clipRenderId,
					input,
				);
			if (persisted) {
				await recordRenderAnalytics(
					clipRenderId,
					"completed",
					input.motionAnalytics,
				);
			}
			return { persisted };
		},
		failClipRenderVariant: async (
			attempt,
			clipRenderId,
			errorCode,
			disposition = "retryable",
			motionAnalytics,
		) => {
			const persisted = await getWorkflowRunLifecycle().failClipRenderVariant(
				attempt,
				clipRenderId,
				errorCode,
				disposition,
			);
			if (persisted) {
				await recordRenderAnalytics(clipRenderId, "failed", motionAnalytics);
			}
		},
		completeClipAutoLayoutAnalysis: (attempt, clipId, analysis, expected) =>
			getWorkflowRunLifecycle().completeClipAutoLayoutAnalysis(attempt, {
				clipId,
				analysis: analysis as never,
				...expected,
			}),
		completeClipSplitLayoutAnalysis: (attempt, clipId, analysis, expected) =>
			getWorkflowRunLifecycle().completeClipSplitLayoutAnalysis(attempt, {
				clipId,
				analysis: analysis as never,
				...expected,
			}),
		completeClipSplitLayoutFailure: (attempt, clipId, failure, expected) =>
			getWorkflowRunLifecycle().completeClipSplitLayoutFailure(attempt, {
				clipId,
				failure: failure as never,
				...expected,
			}),
		setClipLayoutAnalysis: async (attempt, clipId, analysis, expected) => {
			await getWorkflowRunLifecycle().setClipLayoutAnalysis(attempt, {
				clipId,
				analysis: analysis as never,
				...expected,
			});
		},
		setClipLayoutAnalysisFailure: async (
			attempt,
			clipId,
			failure,
			expected,
		) => {
			await getWorkflowRunLifecycle().setClipLayoutAnalysisFailure(attempt, {
				clipId,
				failure: failure as never,
				...expected,
			});
		},
	};

	async function recordRenderAnalytics(
		clipRenderId: string,
		outcome: "completed" | "failed",
		motionAnalytics?: MotionRenderAnalyticsMetadata,
	) {
		const prisma = getPrismaClient();
		if (!prisma) return;
		const render = await prisma.clipRender.findUnique({
			where: { id: clipRenderId },
			select: {
				aspectRatio: true,
				clipId: true,
				clip: { select: { projectId: true } },
			},
		});
		if (!render) return;
		const events = [];
		if (outcome === "completed") {
			events.push(
				analyticsService.recordProjectEvent({
					projectId: render.clip.projectId,
					clipId: render.clipId,
					type: "render_completed",
					metadata: { aspectRatio: render.aspectRatio },
				}),
			);
		}
		if (motionAnalytics && motionAnalytics.targetCount > 0) {
			events.push(
				analyticsService.recordProjectEvent({
					projectId: render.clip.projectId,
					clipId: render.clipId,
					type: "motion_render_outcome",
					metadata: {
						aspectRatio: render.aspectRatio,
						...motionAnalytics,
						renderOutcome: outcome,
					},
				}),
			);
		}
		await Promise.all(events).catch((error) => {
			console.warn(
				JSON.stringify({
					level: "warn",
					message: "render_analytics_record_failed",
					projectId: render.clip.projectId,
					clipId: render.clipId,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		});
	}

	const defaults: ClipRenderAttemptAdapters & {
		remoteMedia: RemoteMediaAdapter;
	} = {
		workerProcess: workerProcess,
		state: productionClipService,
		project: {
			reportProgress: (attempt, progress) =>
				getWorkflowRunLifecycle().reportProgress(attempt, progress),
		},
		clip: productionClipMutationAdapter,
		audioAsset: productionAudioAssetService,
		assets: { loadSceneSources },
		optionalAssets: {
			downloadUrlToFile,
			validateOptionalMedia,
			resolveBrollCutaways,
			getCachedBrollAssetPath,
			saveBrollAssetToCache,
			probeMediaDurationSec,
			probeBackgroundImageDecodable,
		},
		analysis: {
			extractFaceDetectionSegment,
			detectFacePath: (input) => detectors.detectFacePath(input),
			detectMultiFacePath: (input) => detectors.detectMultiFacePath(input),
			detectSceneCuts: (input) => detectors.detectSceneCuts(input),
			detectPipPath: (input) => detectors.detectPipPath(input),
		},
		remoteMedia: {
			createWriteStream: productionCreateWriteStream,
			guardedFetch: productionGuardedFetch,
			pipeline: productionPipeline,
		},
		storage: {
			deleteObject: productionDeleteObject,
			downloadObjectToFile: productionDownloadObjectToFile,
			presignDownloadUrl: productionPresignDownloadUrl,
			putFileFromPath: productionPutFileFromPath,
		},
		workspace: {
			...productionRenderWorkspaceAdapter,
		},
		clock: productionRenderClockAdapter,
		resource: {
			measure: measureCompositionResource,
		},
		composition: {
			compileCommand: compileClipCompositionCommand,
		},
		diagnose: baseDiagnose,
	};

	const adapters: ClipRenderAttemptAdapters & {
		remoteMedia: RemoteMediaAdapter;
	} = {
		...defaults,
		...overrides,
		workerProcess,
		remoteMedia: { ...defaults.remoteMedia, ...overrides?.remoteMedia },
		analysis: { ...defaults.analysis, ...overrides?.analysis },
		clip: { ...defaults.clip, ...overrides?.clip },
		optionalAssets: {
			...defaults.optionalAssets,
			...overrides?.optionalAssets,
		},
		storage: { ...defaults.storage, ...overrides?.storage },
		workspace: { ...defaults.workspace, ...overrides?.workspace },
		clock: { ...defaults.clock, ...overrides?.clock },
		resource: { ...defaults.resource, ...overrides?.resource },
		composition: { ...defaults.composition, ...overrides?.composition },
	};
	return adapters;
	async function probeBackgroundImageDecodable(
		filePath: string,
	): Promise<boolean> {
		try {
			return (
				await adapters.workerProcess.inspectMedia({
					sourcePath: filePath,
					signal: signal,
					deadlineMs: config.probeCommandTimeoutMs,
					diagnose: diagnoseRenderProcessOperation,
				})
			).hasVisualStream;
		} catch (error) {
			rethrowRenderControlFlow(error);
			return false;
		}
	}

	/**
	 * Probes a local media file's container duration. Used to size the B-roll
	 * cutaway window against the *real* footage instead of a guess — required for
	 * studio-picked B-roll, which (unlike the Pexels auto-search path) has no
	 * API-reported duration up front. Returns null on any failure so callers can
	 * treat it exactly like "no usable B-roll" and skip the cutaway.
	 */
	async function probeMediaDurationSec(
		filePath: string,
	): Promise<number | null> {
		try {
			return (
				await adapters.workerProcess.inspectMedia({
					sourcePath: filePath,
					signal: signal,
					deadlineMs: config.probeCommandTimeoutMs,
					diagnose: diagnoseRenderProcessOperation,
				})
			).durationSec;
		} catch (error) {
			rethrowRenderControlFlow(error);
			return null;
		}
	}

	type OptionalMediaKind = "video" | "audio" | "image";

	async function validateOptionalMedia(
		filePath: string,
		kind: OptionalMediaKind,
	): Promise<boolean> {
		try {
			const probe = await adapters.workerProcess.inspectMedia({
				sourcePath: filePath,
				signal,
				deadlineMs: config.probeCommandTimeoutMs,
				diagnose: diagnoseRenderProcessOperation,
			});
			const expectedStream =
				kind === "audio"
					? probe.hasAudio
					: kind === "image"
						? probe.hasVisualStream
						: probe.hasVideo;
			if (!expectedStream) return false;
			await execCommand(
				"ffmpeg",
				compileOptionalMediaValidationCommand(filePath, kind),
				{ timeoutMs: config.probeCommandTimeoutMs },
			);
			return true;
		} catch (error) {
			rethrowRenderControlFlow(error);
			return false;
		}
	}

	/**
	 * Extracts a low-res local segment for face detection when the source is an
	 * HTTP(S) presigned URL (the YuNet detector needs a frame-accurate local
	 * file) — shared by both the single-face auto-reframe path and the
	 * multi-face split-detection path (split packet B), which previously
	 * duplicated this exact extraction. Re-encodes (never `-c copy`: a stream
	 * copy snaps to the previous keyframe and would shift every face sample by
	 * up to a GOP). Returns the ORIGINAL `sourcePath`/`clipStartSec` unchanged
	 * for a local/non-HTTP source (no extraction needed), or null on any
	 * extraction failure — callers already fall back to a static/center crop.
	 * `suffix` keeps the two call sites' temp files from colliding when both run
	 * for the same clip (split falling back to auto-reframe within one render).
	 */
	async function extractFaceDetectionSegment(params: {
		sourcePath: string;
		tempDir: string;
		clipId: string;
		workflowRunId: string;
		clipStartSec: number;
		durationSec: number;
		suffix?: string;
	}): Promise<{ path: string; startSec: number } | null> {
		if (!isHttpSource(params.sourcePath)) {
			return { path: params.sourcePath, startSec: params.clipStartSec };
		}
		const segmentPath = join(
			params.tempDir,
			`face-seg-${params.clipId}${params.suffix ?? ""}.mp4`,
		);
		try {
			await execCommand(
				"ffmpeg",
				compileLayoutEvidenceSegmentCommand({
					sourcePath: params.sourcePath,
					outputPath: segmentPath,
					startSec: params.clipStartSec,
					durationSec: params.durationSec,
				}),
			);
			return { path: segmentPath, startSec: 0 };
		} catch (segmentError) {
			rethrowRenderControlFlow(segmentError);
			log("error", "clip_reframe_segment_extract_failed", {
				workflowRunId: params.workflowRunId,
				clipId: params.clipId,
				phase: "media_analysis",
				analysisMode: "segment_extraction",
				fallbackMode: "center_crop",
				failureCode: "analysis_input_unavailable",
				disposition: "degraded",
				durationMs: 0,
			});
			return null;
		}
	}

	type DownloadUrlToFileOverrides = Parameters<
		ClipRenderAttemptAdapters["optionalAssets"]["downloadUrlToFile"]
	>[3];

	/** Download optional media with the product's byte limit and configured deadline. */
	async function downloadUrlToFile(
		url: string,
		filePath: string,
		errorCode = "remote_media_download_failed",
		overrides?: DownloadUrlToFileOverrides,
	): Promise<void> {
		const maxBytes = overrides?.maxBytes ?? REMOTE_MEDIA_MAX_BYTES;
		const timeoutMs = config.remoteMediaTimeoutMs;
		let response: Response;
		try {
			response = await adapters.remoteMedia.guardedFetch(url, {
				timeoutMs,
			});
		} catch (error) {
			throw new RenderIOFailure(
				errorCode,
				`Remote media fetch failed: ${describeRemoteFetchError(error)}`,
			);
		}

		try {
			if (!response.ok || !response.body) {
				throw new RenderIOFailure(
					errorCode,
					`Remote media download failed with status ${response.status}`,
					workflowHttpFailureDisposition(response.status),
				);
			}

			try {
				assertResponseContentLength(response, maxBytes);
			} catch {
				throw new RenderIOFailure(
					errorCode,
					`Remote media declared size exceeds the ${maxBytes}-byte limit`,
					"permanent",
				);
			}

			await adapters.remoteMedia.pipeline(
				Readable.fromWeb(
					response.body as unknown as import("node:stream/web").ReadableStream,
				),
				createByteLimitTransform(maxBytes),
				adapters.remoteMedia.createWriteStream(filePath),
			);
		} catch (error) {
			rethrowWorkflowAttemptLost(error);
			rethrowRenderCancellation(error);
			if (error instanceof WorkflowFailure) {
				throw error;
			}
			throw new RenderIOFailure(
				errorCode,
				`Remote media download failed: ${describeRemoteFetchError(error)}`,
				error instanceof RemoteFetchError &&
					error.code === "remote_response_too_large"
					? "permanent"
					: "retryable",
			);
		} finally {
			if (response.body && !response.body.locked) {
				await response.body.cancel().catch(() => undefined);
			}
		}
	}

	function describeRemoteFetchError(error: unknown): string {
		if (error instanceof RemoteFetchError) return error.code;
		if (error instanceof UnsafeUrlError) return error.message;
		if (error instanceof Error) return error.message;
		return "unknown";
	}
}
function measureCompositionResource(): CompositionResourceMeasurement {
	if (process.platform === "linux") {
		try {
			const cgroupBytes = Number(
				readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim(),
			);
			if (Number.isFinite(cgroupBytes) && cgroupBytes > 0) {
				return {
					rssBytes: cgroupBytes,
					scope: "worker_and_command_cgroup",
				};
			}
		} catch {
			// Non-cgroup hosts are measured as the worker plus active command.
		}
	}
	return {
		rssBytes: process.memoryUsage().rss,
		scope:
			process.platform === "win32"
				? "worker_only"
				: "worker_and_command_processes",
	};
}

function isHttpSource(input: string): boolean {
	return /^https?:\/\//i.test(input);
}

class RenderIOFailure extends WorkflowFailure {
	constructor(
		code: string,
		message: string,
		disposition: "retryable" | "permanent" = "retryable",
	) {
		super(code, disposition, message);
	}
}
const REMOTE_MEDIA_MAX_BYTES = 250 * 1024 * 1024;

async function loadSceneSources(input: {
	workspaceId: string;
	visualIds: readonly string[];
	fontIds: readonly string[];
}) {
	const prisma = getPrismaClient();
	if (!prisma)
		throw new RenderIOFailure(
			"scene_asset_database_unavailable",
			"Scene assets cannot be resolved",
		);
	const workspace = await prisma.workspace.findUnique({
		where: { id: input.workspaceId },
		select: { personalOwnerUserId: true, pricingTier: true },
	});
	if (!workspace)
		throw new RenderIOFailure(
			"scene_asset_workspace_unavailable",
			"Scene asset ownership could not be loaded",
		);
	const ownerWhere =
		workspace.personalOwnerUserId && workspace.pricingTier !== "business"
			? { userId: workspace.personalOwnerUserId, workspaceId: null }
			: { workspaceId: input.workspaceId };
	const [visuals, fonts] = await Promise.all([
		input.visualIds.length
			? prisma.visualAsset.findMany({
					where: { id: { in: [...input.visualIds] }, ...ownerWhere },
					select: { id: true, kind: true, fingerprint: true, storageKey: true },
				})
			: [],
		input.fontIds.length
			? prisma.brandFont.findMany({
					where: { id: { in: [...input.fontIds] }, ...ownerWhere },
					select: {
						id: true,
						family: true,
						fingerprint: true,
						storageKey: true,
						format: true,
					},
				})
			: [],
	]);
	return { visuals, fonts };
}

interface RemoteMediaAdapter {
	createWriteStream: typeof productionCreateWriteStream;
	guardedFetch: typeof productionGuardedFetch;
	pipeline: typeof productionPipeline;
}
