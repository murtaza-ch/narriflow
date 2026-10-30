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
	listObjectPageByPrefix,
	guardedFetch as productionGuardedFetch,
	getLayoutEvidenceLifecycle,
	presignDownloadUrl as productionPresignDownloadUrl,
	putFileFromPath as productionPutFileFromPath,
	rethrowWorkflowAttemptLost,
	RemoteFetchError,
	UnsafeUrlError,
	WorkflowFailure,
	workflowHttpFailureDisposition,
	type MotionRenderAnalyticsMetadata,
	type RenderGroupAttemptRef,
	type WorkflowAttemptRef,
	type RenderGroupLifecycle,
} from "@narriflow/services";
import { asAttemptLost } from "../render-group-executor";
import type { RenderConfig } from "../render-config";
import {
	productionWorkerProcessModule,
	WorkerProcessFailure,
	executorProcessFailure,
	type WorkerProcessDiagnostic,
} from "../worker-process";
import { productionRenderDiagnosticAdapter } from "../render-diagnostic-adapter";
import {
	productionRenderClockAdapter,
	productionRenderWorkspaceAdapter,
} from "../render-runtime-adapters";
import { createLayoutEvidenceDetectors } from "../layout-evidence-runtime";
import { processRenderFactCache, validateMediaOnce } from "../render-fact-cache";
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
	normalizeRenderProcessFailure,
	type ClipRenderAttemptDependencies,
	type ClipRenderAttemptAdapters,
	type ClipRenderAttemptAdapterOverrides,
	type CompositionResourceMeasurement,
} from "./clip-render-attempt";

export interface ClipRenderAttemptRuntimeOptions
	extends Omit<ClipRenderAttemptDependencies, "adapters"> {
	/** The leased group this attempt renders; every durable write carries it. */
	group: RenderGroupAttemptRef;
	groups: Pick<
		RenderGroupLifecycle,
		| "markClipRenderVariantRendering"
		| "completeClipRenderVariant"
		| "failClipRenderVariant"
		| "writeLayoutEvidence"
	>;
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
				input.group,
				input.groups,
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
	group: RenderGroupAttemptRef,
	groups: ClipRenderAttemptRuntimeOptions["groups"],
	overrides?: ClipRenderAttemptRuntimeOptions["adapters"],
): ClipRenderAttemptAdapters {
	const writeDiagnostic = overrides?.diagnose ?? productionRenderDiagnosticAdapter.diagnose;
  const baseDiagnose: ClipRenderAttemptAdapters["diagnose"] = (event) => writeDiagnostic({ ...event, context: { ...event.context, groupId: group.groupId, groupToken: group.token, groupOwner: group.owner, workSetGeneration: group.workSetGeneration } });
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
		const failure = normalizeRenderProcessFailure(error);
		if (executorProcessFailure(failure)) throw failure;
		if (
			failure instanceof WorkerProcessFailure &&
			failure.code !== "worker_command_input_invalid"
		)
			throw failure;
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
	// The engine's attempt id is the group token; every write below is fenced by
	// the group, and a lost group surfaces as the engine's ownership loss.
	const owned = <T,>(attempt: WorkflowAttemptRef, write: () => Promise<T>) =>
		asAttemptLost(attempt, write);
	const productionClipMutationAdapter: ClipRenderAttemptAdapters["clip"] = {
		markClipRenderVariantRendering: (attempt, clipRenderId) =>
			owned(attempt, () =>
				groups.markClipRenderVariantRendering(group, clipRenderId),
			),
		completeClipRenderVariant: async (attempt, clipRenderId, input) => {
			const persisted = await owned(attempt, () =>
				groups.completeClipRenderVariant(group, clipRenderId, input),
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
			const persisted = await owned(attempt, () =>
				groups.failClipRenderVariant(group, clipRenderId, errorCode, disposition),
			);
			if (persisted) {
				await recordRenderAnalytics(clipRenderId, "failed", motionAnalytics);
			}
		},
		completeClipAutoLayoutAnalysis: (attempt, clipId, analysis, expected) =>
			owned(attempt, () =>
				groups.writeLayoutEvidence(group, {
					clipId,
					field: "automatic",
					evidence: analysis as never,
					...expected,
				}),
			),
		completeClipSplitLayoutAnalysis: (attempt, clipId, analysis, expected) =>
			owned(attempt, () =>
				groups.writeLayoutEvidence(group, {
					clipId,
					field: "split",
					evidence: analysis as never,
					...expected,
				}),
			),
		completeClipSplitLayoutFailure: (attempt, clipId, failure, expected) =>
			owned(attempt, () =>
				groups.writeLayoutEvidence(group, {
					clipId,
					field: "split",
					evidence: failure as never,
					...expected,
				}),
			),
		setClipLayoutAnalysis: async (attempt, clipId, analysis, expected) => {
			await owned(attempt, () =>
				groups.writeLayoutEvidence(group, {
					clipId,
					field: "screen",
					evidence: analysis as never,
					...expected,
				}),
			);
		},
		setClipLayoutAnalysisFailure: async (
			attempt,
			clipId,
			failure,
			expected,
		) => {
			await owned(attempt, () =>
				groups.writeLayoutEvidence(group, {
					clipId,
					field: "screen",
					evidence: failure as never,
					...expected,
				}),
			);
		},
	};

	async function recordRenderAnalytics(
		clipRenderId: string,
		outcome: "completed" | "failed",
		motionAnalytics?: MotionRenderAnalyticsMetadata,
	) {
		try {
			const prisma = getPrismaClient();
			if (!prisma) return;
			const render = await prisma.clipRender.findUnique({
				where: { id: clipRenderId },
				select: {
					aspectRatio: true,
 createdAt: true,
 startedAt: true,
 completedAt: true,
					clipId: true,
					clip: { select: { projectId: true } },
				},
			});
			if (!render) return;
      if (outcome === "completed" && render.completedAt) diagnose({ level: "info", message: "clip_render_delivery_latency", context: { clipRenderId, clipId: render.clipId, projectId: render.clip.projectId, requestToReadyMs: render.completedAt.getTime() - render.createdAt.getTime(), queueAgeMs: render.startedAt ? render.startedAt.getTime() - render.createdAt.getTime() : null } });
			const events: Array<() => Promise<unknown>> = [];
			if (outcome === "completed") {
				events.push(() =>
					analyticsService.recordProjectEvent({
						projectId: render.clip.projectId,
						clipId: render.clipId,
						type: "render_completed",
						metadata: { aspectRatio: render.aspectRatio },
					}),
				);
			}
			if (motionAnalytics && motionAnalytics.targetCount > 0) {
				events.push(() =>
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
			await Promise.all(events.map(async (record) => record()));
		} catch {
			// Lookup, enqueue and diagnostics are all outside durable settlement.
			log("error", "render_analytics_record_failed", {
				clipRenderId,
				phase: "diagnostics",
				operation: "record_render_analytics",
				outcome,
			});
		}
	}

	const defaults: ClipRenderAttemptAdapters & {
		remoteMedia: RemoteMediaAdapter;
	} = {
		workerProcess: workerProcess,
		state: productionClipService,
		layoutEvidence: {
			readCompatibleDurable: (clipId, frozen) =>
				getLayoutEvidenceLifecycle().readCompatibleDurable(clipId, frozen),
		},
		facts: processRenderFactCache,
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
			sourceSizeBytes: async (key, signal) => {
				const page = await listObjectPageByPrefix(key, 1, undefined, { signal });
				const object = page.objects.find((object) => object.key === key);
				if (!object) {
					throw new WorkflowFailure("source_object_missing", "permanent", "Required source object is missing");
				}
				return object.sizeBytes;
			},
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
			if (!isInvalidBinding(error)) throw error;
			return false;
		}
	}

	/**
	 * Probes a local media file's container duration. Used to size the B-roll
	 * cutaway window against the *real* footage instead of a guess — required for
	 * studio-picked B-roll, which (unlike the Pexels auto-search path) has no
	 * API-reported duration up front. Returns null only for proven invalid media; infrastructure failures
	 * propagate so requested cutaways survive retries.
	 */
	async function probeMediaDurationSec(filePath: string): Promise<number | null> {
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
			if (!isInvalidBinding(error)) throw error;
			return null;
		}
	}

	function isInvalidBinding(error: unknown): boolean {
		return (
			(error instanceof WorkerProcessFailure &&
				error.code === "worker_command_input_invalid") ||
			(error instanceof WorkflowFailure && error.code === "source_media_invalid")
		);
	}

	type OptionalMediaKind = "video" | "audio" | "image";

	/** Decodes optional media once per distinct content: identical bytes decode
	 *  identically under this process's toolchain, so only a pass is remembered. */
	function validateOptionalMedia(
		filePath: string,
		kind: OptionalMediaKind,
		window?: { startSec: number; durationSec: number },
	): Promise<boolean> {
		return validateMediaOnce({
			cache: adapters.facts,
			filePath,
			kind: `${kind}:${window?.startSec ?? 0}:${window?.durationSec ?? "full"}:selected-v1`,
			signal,
			rethrowControl: rethrowRenderControlFlow,
			decode: () => decodeOptionalMedia(filePath, kind, window),
		});
	}

	async function decodeOptionalMedia(
		filePath: string,
		kind: OptionalMediaKind,
		window?: { startSec: number; durationSec: number },
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
			const args = compileOptionalMediaValidationCommand(filePath, kind);
			args.unshift("-xerror");
			if (window) {
				args.splice(args.indexOf("-i"), 0, "-ss", String(window.startSec));
				args.splice(args.indexOf("-f"), 0, "-t", String(window.durationSec));
			} else if (kind === "image")
				args.splice(args.indexOf("-f"), 0, "-frames:v", "1");
			await execCommand("ffmpeg", args, {
				timeoutMs: Math.min(
					config.probeCommandTimeoutMs,
					Math.max(
						30_000,
						2_000 * (window?.durationSec ?? probe.durationSec ?? 120),
					),
				),
			});
			return true;
		} catch (error) {
			rethrowRenderControlFlow(error);
			if (!isInvalidBinding(error)) throw error;
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
	 * for a local/non-HTTP source (no extraction needed, unless `orientedSource`
	 * says the display matrix must be baked in by FFmpeg first), and preserves typed extraction failures for the analysis retry owner.
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
		orientedSource?: boolean;
	}): Promise<{ path: string; startSec: number } | null> {
		if (!isHttpSource(params.sourcePath) && !params.orientedSource) {
			return { path: params.sourcePath, startSec: params.clipStartSec };
		}
		const segmentPath = join(
			params.tempDir,
			`face-seg-${params.clipId}${params.suffix ?? ""}.mp4`,
		);
  await execCommand(
    "ffmpeg",
    compileLayoutEvidenceSegmentCommand({ sourcePath: params.sourcePath, outputPath: segmentPath, startSec: params.clipStartSec, durationSec: params.durationSec }),
  );
  return { path: segmentPath, startSec: 0 };
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
		select: { personalOwnerUserId: true },
	});
	if (!workspace)
		throw new RenderIOFailure(
			"scene_asset_workspace_unavailable",
			"Scene asset ownership could not be loaded",
		);
	// Branding ownership follows the Workspace kind, never its plan.
	const ownerWhere = workspace.personalOwnerUserId
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
