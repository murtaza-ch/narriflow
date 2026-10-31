import { createWriteStream as productionCreateWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPublicHttpUrl } from "@narriflow/services/url-policy";
import { Readable } from "node:stream";
import { pipeline as productionPipeline } from "node:stream/promises";
import { assertResponseContentLength, createByteLimitTransform, guardedFetch as productionGuardedFetch, RemoteFetchError, UnsafeUrlError } from "./outbound-transport";
import { rethrowWorkflowAttemptLost, WorkflowFailure, workflowHttpFailureDisposition } from "@narriflow/services/workflow-attempt-contract";
import type { RenderConfig } from "./render-config";
import { productionWorkerProcessModule, WorkerProcessFailure, executorProcessFailure, type WorkerProcessDiagnostic } from "./worker-process";
import { productionRenderClockAdapter, productionRenderWorkspaceAdapter } from "./render-runtime-adapters";
import { createLayoutEvidenceDetectors } from "./layout-evidence-runtime";
import { processRenderFactCache, validateMediaOnce } from "./render-fact-cache";
import { compileClipCompositionCommand, compileLayoutEvidenceSegmentCommand, compileOptionalMediaValidationCommand } from "./composition-ffmpeg-adapter";
import { getCachedBrollAssetPath, saveBrollAssetToCache, type ResolveBrollCutaways } from "./tasks/broll";
import { normalizeRenderProcessFailure, type ClipRenderAttemptAdapters, type ClipRenderAttemptAdapterOverrides, type CompositionResourceMeasurement } from "./tasks/clip-render-attempt";

export interface RemoteMediaAdapter {
 createWriteStream: typeof productionCreateWriteStream;
 guardedFetch: typeof productionGuardedFetch;
 pipeline: typeof productionPipeline;
}
export type NativeRenderAdapters = Pick<ClipRenderAttemptAdapters, "workerProcess" | "facts" | "optionalAssets" | "analysis" | "workspace" | "clock" | "resource" | "composition" | "diagnose"> & { remoteMedia: RemoteMediaAdapter };
export type NativeRenderAdapterOverrides = ClipRenderAttemptAdapterOverrides & { remoteMedia?: Partial<RemoteMediaAdapter> };
/** Native defaults own processes and files. Domain reads, writes and storage credentials are required ports. */
export function createNativeRenderAdapters(input: {
 config: Readonly<RenderConfig>;
 signal: AbortSignal;
 diagnose: ClipRenderAttemptAdapters["diagnose"];
 resolveBrollCutaways: ResolveBrollCutaways;
 overrides?: NativeRenderAdapterOverrides;
}): NativeRenderAdapters {
 const { config, signal, diagnose, resolveBrollCutaways, overrides } = input;
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

 const defaults: NativeRenderAdapters = {
 workerProcess, facts: processRenderFactCache,
 optionalAssets: { assertUrlAllowed: assertPublicHttpUrl, downloadUrlToFile, validateOptionalMedia, resolveBrollCutaways, getCachedBrollAssetPath, saveBrollAssetToCache, probeMediaDurationSec, probeBackgroundImageDecodable },
 analysis: { extractFaceDetectionSegment, detectFacePath: (input) => detectors.detectFacePath(input), detectMultiFacePath: (input) => detectors.detectMultiFacePath(input), detectSceneCuts: (input) => detectors.detectSceneCuts(input), detectPipPath: (input) => detectors.detectPipPath(input) },
 remoteMedia: { createWriteStream: productionCreateWriteStream, guardedFetch: productionGuardedFetch, pipeline: productionPipeline },
 workspace: productionRenderWorkspaceAdapter, clock: productionRenderClockAdapter,
 resource: { measure: measureCompositionResource }, composition: { compileCommand: compileClipCompositionCommand }, diagnose,
 };
 const adapters: NativeRenderAdapters = { ...defaults, ...overrides, workerProcess,
 remoteMedia: { ...defaults.remoteMedia, ...overrides?.remoteMedia }, analysis: { ...defaults.analysis, ...overrides?.analysis },
 optionalAssets: { ...defaults.optionalAssets, ...overrides?.optionalAssets }, workspace: { ...defaults.workspace, ...overrides?.workspace }, clock: { ...defaults.clock, ...overrides?.clock }, resource: { ...defaults.resource, ...overrides?.resource }, composition: { ...defaults.composition, ...overrides?.composition },
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

