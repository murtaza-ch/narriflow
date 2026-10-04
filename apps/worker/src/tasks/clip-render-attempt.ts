import { AsyncLocalStorage } from "node:async_hooks";
import { extname, join } from "node:path";
import {
	automaticLayoutInputFingerprint,
	compositionAssetRef,
	planClipComposition,
	sceneLayoutPresetShowsBackground,
	type ClipCompositionPlan,
	type CompositionMode,
} from "@narriflow/composition-plan";
import {
	assertPublicHttpUrl,
	type audioAssetService as productionAudioAssetService,
	type clipService as productionClipService,
	decodeClipEditorDocumentFromStorage,
	type deleteObject as productionDeleteObject,
	type downloadObjectToFile as productionDownloadObjectToFile,
	hasFeature,
	motionRenderAnalyticsMetadata,
	type presignDownloadUrl as productionPresignDownloadUrl,
	type putFileFromPath as productionPutFileFromPath,
	rethrowWorkflowAttemptLost,
	WorkflowAttemptLost,
	WorkflowFailure,
	workflowFailureFromUnknown,
	type MotionRenderAnalyticsMetadata,
	type RenderWorkSetOutcome,
	type WorkflowAttemptContext,
	type WorkflowAttemptRef,
} from "@narriflow/services";
import {
	AUDIO_UPLOAD_MAX_BYTES,
	CLIP_AUTO_LAYOUT_ENGINE,
	brandTemplateSnapshotSchema,
	brollCuesArraySchema,
	CATEGORY_BROLL_FALLBACK_QUERY,
	clipAspectRatioDbSchema,
	clipAspectRatioFromDb,
	clipAspectRatioOptions,
	clipRenderResolutionSchema,
	getEffectiveClipTiming,
	normalizeTranscriptSliceForClip,
	resolveEffectiveFramingMode,
	resolveEffectiveLogoSettings,
	SCREEN_LAYOUT_ENGINE_VERSION,
} from "@narriflow/validators";
import type {
	BrandTemplateSnapshot,
	ClipAspectRatio,
	ClipCategory,
	ClipRenderResolution,
	EditorDocument,
	StudioEdits,
	TranscriptUtterance,
} from "@narriflow/validators";
import { buildClipCutPlan } from "./cut-plan";
import {
	LayoutEvidence,
	type LayoutEvidenceDetectors,
} from "../layout-evidence";
import {
	brollQueryForClip,
	dominantPexelsOrientation,
	getCachedBrollAssetPath,
	planBrollWindow,
	remapBrollCuesForCutPlan,
	resolveBrollCutaways,
	saveBrollAssetToCache,
	type BrollCueInput,
} from "./broll";
import { type RenderConfig } from "../render-config";
import {
	clipExportAttemptStorageKey,
	clipRenderAttemptStorageKey,
} from "../render-object-key";
import {
	type WorkerMediaInspection,
	type WorkerProcessDiagnostic,
	type WorkerProcessModule,
} from "../worker-process";
import {
	compileClipCompositionCommand,
	compileCompositionPlanCaptions,
	bindCompositionPlanAudioInputs,
	compileCompositionPlanAudioSchedule,
	type BoundCompositionAudioRenderRequest,
} from "../composition-ffmpeg-adapter";
import { classifyRenderObjectKey } from "../render-object-key";
import {
	type RenderClockAdapter,
	type RenderWorkspaceAdapter,
} from "../render-runtime-adapters";

interface BrollCutaway {
	ref: string;
	path: string;
	window: { startSec: number; endSec: number };
}

interface BrollPlan {
	cutaways: BrollCutaway[];
	/** Compact per-cutaway attribution, attached to the render as object metadata and logs. */
	credits: Array<{
		query: string;
		startSec: number;
		endSec: number;
		authorName: string | null;
		authorUrl: string | null;
		pageUrl: string | null;
	}>;
}

interface ResolvedMusicAsset {
	path: string;
	ref: string;
	durationSec?: number;
}

/**
 * One resolved, downloaded SFX asset binding. Composition policy such as
 * edited-time placement and gain remains exclusively in the plan.
 */
interface ResolvedSfxAsset {
	path: string;
	id: string;
	ref: string;
	durationSec: number;
}

/**
 * Resolved per-clip canvas background (vizard-parity.md Phase C item 2) —
 * built once per clip render (see the main flow below, mirroring how
 * `ResolvedMusicAsset` is resolved from `studioEdits.music`) and threaded into
 * whichever per-output builder actually runs. `color` is always populated
 * (falls back to black) so it doubles as the mode="image" fallback when the
 * image URL was invalid or its download failed upstream. `imagePath` is the
 * local downloaded file, set only when mode="image" AND the download
 * actually succeeded. The composition plan compiler falls back to the solid
 * color whenever it's null, so a bad image URL degrades gracefully.
 */
interface BackgroundPlan {
	mode: "color" | "image";
	color: string;
	imagePath: string | null;
}

interface LogoOverlay {
	filePath: string;
	ref: string;
	position: BrandTemplateSnapshot["logoPosition"];
	opacity: number;
	scalePct: number;
}

/**
 * Merge a clip's `studioEdits.logo` override over the base logo overlay
 * (built once per project from the frozen brand snapshot + downloaded logo
 * file, see `brandLogo` below) via the shared `resolveEffectiveLogoSettings`
 * helper — the same one the studio preview overlay uses, so burn-in and
 * preview can't fork (vizard-parity.md Phase A step 6). `base: null` (no
 * logo asset at all, e.g. no snapshot/no logoStorageKey)
 * always yields `null` — there's nothing to override. `enabled: false`
 * yields `null` too, skipping the overlay filter entirely for this clip.
 */
function resolveClipLogoOverlay(
	base: LogoOverlay | null,
	overrides: StudioEdits["logo"] | null | undefined,
): LogoOverlay | null {
	if (!base) return null;
	const effective = resolveEffectiveLogoSettings(
		{ position: base.position, opacity: base.opacity, scalePct: base.scalePct },
		overrides,
	);
	if (!effective.enabled) return null;
	return {
		filePath: base.filePath,
		ref: base.ref,
		position: effective.position,
		opacity: effective.opacity,
		scalePct: effective.scalePct,
	};
}

interface WorkflowRunJob {
	id: string;
	projectId: string;
	project: {
		title: string;
		sourceStorageKey: string | null;
		sourceDurationSeconds: number | null;
		workspaceId: string;
	};
}

export type ClipRenderingWorkflowAttempt = Omit<WorkflowAttemptRef, "stage"> & {
	stage: "clip_rendering";
};

interface ClipRenderAttemptLifecycle {
	beginRenderWorkSet(attempt: WorkflowAttemptRef): Promise<{
		variantIds: readonly string[];
	}>;
	settleRenderWorkSet(
		attempt: WorkflowAttemptRef,
	): Promise<RenderWorkSetOutcome>;
}

type CompositionPeakRssScope =
	| "worker_and_command_cgroup"
	| "worker_and_command_processes"
	| "worker_only";

export interface CompositionResourceMeasurement {
	rssBytes: number;
	scope: CompositionPeakRssScope;
}

export interface ClipRenderAttemptAdapters {
	workerProcess: WorkerProcessModule;
	state: Pick<
		typeof productionClipService,
		"getFrozenRenderingStateForWorkSet"
	>;
	project: {
		reportProgress(
			attempt: WorkflowAttemptRef,
			progress: number,
		): Promise<void>;
	};
	clip: {
		markClipRenderVariantRendering(
			attempt: WorkflowAttemptRef,
			clipRenderId: string,
		): Promise<boolean>;
		completeClipRenderVariant(
			attempt: WorkflowAttemptRef,
			clipRenderId: string,
			input: {
				storageKey: string;
				sizeBytes: number;
				durationSec: number;
				motionAnalytics?: MotionRenderAnalyticsMetadata;
			},
		): Promise<{ persisted: boolean }>;
		failClipRenderVariant(
			attempt: WorkflowAttemptRef,
			clipRenderId: string,
			errorCode: string,
			disposition?: "retryable" | "permanent",
			motionAnalytics?: MotionRenderAnalyticsMetadata,
		): Promise<void>;
		completeClipAutoLayoutAnalysis(
			attempt: WorkflowAttemptRef,
			clipId: string,
			analysis: unknown,
			expected: { editorRevision: number; previewStorageKey: string },
		): Promise<boolean>;
		completeClipSplitLayoutAnalysis(
			attempt: WorkflowAttemptRef,
			clipId: string,
			analysis: unknown,
			expected: { editorRevision: number; previewStorageKey: string },
		): Promise<boolean>;
		completeClipSplitLayoutFailure(
			attempt: WorkflowAttemptRef,
			clipId: string,
			failure: unknown,
			expected: { editorRevision: number; previewStorageKey: string },
		): Promise<boolean>;
		setClipLayoutAnalysis(
			attempt: WorkflowAttemptRef,
			clipId: string,
			analysis: unknown,
			expected: { editorRevision: number; previewStorageKey: string },
		): Promise<void>;
		setClipLayoutAnalysisFailure(
			attempt: WorkflowAttemptRef,
			clipId: string,
			failure: unknown,
			expected: { editorRevision: number; previewStorageKey: string },
		): Promise<void>;
	};
	audioAsset: Pick<typeof productionAudioAssetService, "resolveRenderSource">;
	assets: {
		loadSceneSources(input: {
			workspaceId: string;
			visualIds: readonly string[];
			fontIds: readonly string[];
		}): Promise<{
			visuals: Array<{
				id: string;
				kind: "image" | "video";
				fingerprint: string;
				storageKey: string;
			}>;
			fonts: Array<{
				id: string;
				family: string;
				fingerprint: string;
				storageKey: string;
				format: string;
			}>;
		}>;
	};
	optionalAssets: {
		downloadUrlToFile(
			url: string,
			path: string,
			errorCode?: string,
			options?: { maxBytes?: number },
		): Promise<void>;
		validateOptionalMedia(
			path: string,
			kind: "video" | "audio" | "image",
		): Promise<boolean>;
		resolveBrollCutaways: typeof resolveBrollCutaways;
		getCachedBrollAssetPath: typeof getCachedBrollAssetPath;
		saveBrollAssetToCache: typeof saveBrollAssetToCache;
		probeMediaDurationSec(path: string): Promise<number | null>;
		probeBackgroundImageDecodable(path: string): Promise<boolean>;
	};
	analysis: LayoutEvidenceDetectors & {
		extractFaceDetectionSegment(params: {
			sourcePath: string;
			tempDir: string;
			clipId: string;
			workflowRunId: string;
			clipStartSec: number;
			durationSec: number;
			suffix?: string;
		}): Promise<{ path: string; startSec: number } | null>;
	};
	storage: {
		deleteObject: typeof productionDeleteObject;
		downloadObjectToFile: typeof productionDownloadObjectToFile;
		presignDownloadUrl: typeof productionPresignDownloadUrl;
		putFileFromPath: typeof productionPutFileFromPath;
	};
	workspace: RenderWorkspaceAdapter;
	clock: RenderClockAdapter;
	resource: {
		measure(): CompositionResourceMeasurement;
	};
	composition: { compileCommand: typeof compileClipCompositionCommand };
	diagnose(input: {
		level: "info" | "error";
		message: string;
		context?: Record<string, unknown>;
	}): void;
}

export type ClipRenderAttemptAdapterOverrides = Partial<
	Omit<
		ClipRenderAttemptAdapters,
		| "analysis"
		| "clip"
		| "composition"
		| "optionalAssets"
		| "storage"
		| "workspace"
		| "clock"
		| "resource"
		| "workerProcess"
	>
> & {
	analysis?: Partial<ClipRenderAttemptAdapters["analysis"]>;
	clip?: Partial<ClipRenderAttemptAdapters["clip"]>;
	optionalAssets?: Partial<ClipRenderAttemptAdapters["optionalAssets"]>;
	storage?: Partial<ClipRenderAttemptAdapters["storage"]>;
	workspace?: Partial<ClipRenderAttemptAdapters["workspace"]>;
	clock?: Partial<ClipRenderAttemptAdapters["clock"]>;
	resource?: Partial<ClipRenderAttemptAdapters["resource"]>;
	composition?: Partial<ClipRenderAttemptAdapters["composition"]>;
	workerProcess?: Partial<WorkerProcessModule>;
};

export interface ClipRenderAttemptDependencies {
	run: WorkflowRunJob;
	config: Readonly<RenderConfig>;
	lifecycle: ClipRenderAttemptLifecycle;
	adapters(
		signal: AbortSignal,
		withAttemptDiagnosticContext: (
			diagnose: ClipRenderAttemptAdapters["diagnose"],
		) => ClipRenderAttemptAdapters["diagnose"],
	): ClipRenderAttemptAdapters;
}

function resolveRenderTimingForClip(input: {
	llmModel: string | null;
	startSec: number;
	endSec: number;
	utterances: TranscriptUtterance[];
}) {
	if (input.llmModel === "caption-only") {
		const startSec = Math.max(0, input.startSec);
		const endSec = Math.max(startSec + 0.01, input.endSec);
		return {
			startSec,
			endSec,
			durationSec: endSec - startSec,
			transcriptSlice: normalizeTranscriptSliceForClip(
				input.utterances,
				startSec,
				endSec,
			),
		};
	}

	// tailPadSec 0: the clip's stored bounds were already pad- and collision-
	// normalized against the full transcript at detection/edit time, and the
	// slice passed here can't see the word that follows the clip — re-padding
	// from slice-only data used to push the rendered end ~0.25s past the
	// stored end, straight into the next sentence.
	return getEffectiveClipTiming({
		utterances: input.utterances,
		startSec: input.startSec,
		endSec: input.endSec,
		tailPadSec: 0,
	});
}

type SourceProbe = WorkerMediaInspection;

interface PendingRenderOutput {
	clipRenderId: string;
	clipId: string;
	clipIndex: number;
	aspectRatio: ClipAspectRatio;
	outputPath: string;
	storageKey: string;
	subtitlePath?: string | null;
	/** Target resolution for this specific render row (vizard-parity Phase C
	 *  export options) — read off the ClipRender row, already entitlement-
	 *  clamped by clip.service's triggerClipRendering/autoQueueDefaultRenders.
	 *  Drives the per-output 2/3 downscale; independent of the watermark,
	 *  which is a run-level entitlement (see `applyWatermark` below). */
	resolution: ClipRenderResolution;
	watermark: boolean;
}

interface RenderExecutionContext {
	config: Readonly<RenderConfig>;
	signal: AbortSignal;
	adapters: ClipRenderAttemptAdapters;
}

const renderExecutionStorage = new AsyncLocalStorage<RenderExecutionContext>();
function requireExecutionContext(): RenderExecutionContext {
	const context = renderExecutionStorage.getStore();
	if (!context) throw new Error("clip_render_execution_context_missing");
	return context;
}

function currentRenderConfig(): Readonly<RenderConfig> {
	return requireExecutionContext().config;
}

function currentRenderSignal(): AbortSignal | undefined {
	return renderExecutionStorage.getStore()?.signal;
}

function rethrowRenderCancellation(error: unknown): void {
	const signal = currentRenderSignal();
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	if (error instanceof Error) throw error;
	throw new DOMException("Clip render cancelled", "AbortError");
}

function rethrowRenderControlFlow(error: unknown): void {
	rethrowWorkflowAttemptLost(error);
	rethrowRenderCancellation(error);
}

async function withRenderOperationDeadline<T>(input: {
	operation: () => Promise<T>;
	deadlineMs: number;
	timeoutFailure: () => WorkflowFailure;
}): Promise<T> {
	const signal = currentRenderSignal();
	const clock = currentRenderAdapters().clock;
	signal?.throwIfAborted();

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timeout = clock.setTimeout(() => {
			finish(() => reject(input.timeoutFailure()));
		}, input.deadlineMs);
		const cleanup = () => {
			clock.clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (settle: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			settle();
		};
		const onAbort = () => {
			finish(() => {
				if (signal?.reason instanceof Error) reject(signal.reason);
				else reject(new DOMException("Clip render cancelled", "AbortError"));
			});
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
			return;
		}
		Promise.resolve()
			.then(input.operation)
			.then(
				(value) => {
					if (signal?.aborted) onAbort();
					else finish(() => resolve(value));
				},
				(error: unknown) => finish(() => reject(error)),
			);
	});
}

function currentRenderAdapters(): ClipRenderAttemptAdapters {
	return requireExecutionContext().adapters;
}

function currentTimeMs(): number {
	return currentRenderAdapters().clock.nowMs();
}

function renderStorageSignal(includeAttemptSignal = true): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(
		currentRenderConfig().storageOperationTimeoutMs,
	);
	const attemptSignal = includeAttemptSignal
		? currentRenderSignal()
		: undefined;
	return attemptSignal
		? AbortSignal.any([attemptSignal, timeoutSignal])
		: timeoutSignal;
}

/**
 * Attempt-unique render storage key — mirrors `clipPreviewAttemptStorageKey`
 * from clip-preview.ts (see its comment for the full race it closes; the
 * short version below is render-specific).
 *
 * The key used to be a pure function of `(projectId, clipId, aspectRatio)`,
 * so two overlapping encodes for the same clip+aspect (e.g. an in-flight
 * render R1, an editor save that deletes R1's ClipRender row, then a
 * freshly-queued R2 that completes first) uploaded to the *same* object.
 * `completeClipRenderVariant`'s DB claim happens strictly after the upload,
 * so R1 — arriving late, its own row already gone — would still overwrite
 * R2's just-uploaded bytes at that shared key before its own row-update
 * failed, leaving downloads serving stale video with no error anywhere to
 * explain it.
 *
 * Each encode attempt now gets its own key. `completeClipRenderVariant`
 * persists this attempt's key as-is; nothing else re-derives a render's
 * storage key from `(projectId, clipId, aspectRatio)` — every reader (the
 * download endpoint, the project/clip storage deletion planner) reads the
 * persisted `ClipRender.storageKey` column verbatim.
 */
class WorkflowWorkerError extends WorkflowFailure {
	constructor(
		code: string,
		message: string,
		disposition: "retryable" | "permanent" = "retryable",
	) {
		super(code, disposition, message);
	}
}

function compositionContractFailure(
	error: unknown,
): WorkflowWorkerError | null {
	if (!(error instanceof Error)) return null;
	if (
		!error.message.startsWith("invalid_clip_composition_") &&
		!error.message.startsWith("clip_composition_") &&
		error.message !== "unsupported_clip_composition_plan_version"
	) {
		return null;
	}
	return new WorkflowWorkerError(
		"invalid_clip_composition_plan",
		`Clip Composition Plan adapter rejected ${error.message}`,
		"permanent",
	);
}

class RenderPersistenceFailure extends WorkflowWorkerError {
	readonly cleanupResult: "deleted" | "orphan_candidate";

	constructor(cause: unknown, cleanupResult: "deleted" | "orphan_candidate") {
		super(
			"render_persistence_failed",
			cause instanceof Error
				? `Guarded render persistence failed: ${cause.message}`
				: "Guarded render persistence failed",
			"retryable",
		);
		this.name = "RenderPersistenceFailure";
		this.cleanupResult = cleanupResult;
	}
}

const aspectRatioConfig = new Map(
	clipAspectRatioOptions.map((option) => [option.value, option]),
);

const RENDER_DIAGNOSTIC_SECRET_KEY =
	/(?:authorization|credential|password|secret|signature|token)/i;

function sanitizeRenderDiagnosticValue(value: unknown): unknown {
	if (typeof value === "string") {
		return value.replace(/\bhttps?:\/\/[^\s"'?]+\?[^\s"']+/gi, (url) =>
			url.replace(/\?.*$/, "?[redacted]"),
		);
	}
	if (Array.isArray(value)) {
		return value.map(sanitizeRenderDiagnosticValue);
	}
	if (
		value &&
		typeof value === "object" &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	) {
		return Object.fromEntries(
			Object.entries(value).map(([key, nestedValue]) => [
				key,
				RENDER_DIAGNOSTIC_SECRET_KEY.test(key)
					? "[redacted]"
					: sanitizeRenderDiagnosticValue(nestedValue),
			]),
		);
	}
	return value;
}

function log(
	level: "info" | "error",
	message: string,
	context?: Record<string, unknown>,
) {
	try {
		currentRenderAdapters().diagnose({
			level,
			message,
			context: sanitizeRenderDiagnosticValue(context) as
				| Record<string, unknown>
				| undefined,
		});
	} catch {
		// Diagnostic delivery must never change Clip Render Attempt settlement.
	}
}

type OptionalAssetClass =
	| "logo"
	| "broll"
	| "music"
	| "sound_effect"
	| "background";

function diagnoseOptionalAssetFallback(input: {
	assetClass: OptionalAssetClass;
	phase:
		| "lookup"
		| "parse"
		| "presign"
		| "download"
		| "probe"
		| "decode"
		| "command"
		| "cleanup";
	failureCode: string;
	context: Record<string, unknown>;
}): void {
	log("error", "clip_render_optional_asset_fallback", {
		...input.context,
		phase: input.phase,
		assetClass: input.assetClass,
		failureCode: input.failureCode,
		disposition: "degraded",
	});
}

function optionalAccessFailure(
	error: unknown,
	assetClass: "music" | "sound_effect",
) {
	const code =
		error instanceof Error && "code" in error && typeof error.code === "string"
			? error.code
			: "";
	const presignFailure =
		code.includes("presign") || code.includes("access_url");
	return {
		phase: presignFailure ? ("presign" as const) : ("lookup" as const),
		failureCode: presignFailure
			? `${assetClass}_presign_failed`
			: `${assetClass}_asset_unavailable`,
	};
}

function commandSizeBytes(command: string, args: readonly string[]): number {
	const encoder = new TextEncoder();
	return [command, ...args].reduce(
		(total, value) => total + encoder.encode(value).byteLength + 1,
		0,
	);
}

function assertCompositionCommandWithinBudget(
	args: readonly string[],
	context: Record<string, unknown>,
): void {
	const measuredBytes = commandSizeBytes("ffmpeg", args);
	const maximumBytes = currentRenderConfig().compositionCommandMaxBytes;
	if (measuredBytes <= maximumBytes) return;
	log("error", "clip_composition_budget_rejected", {
		...context,
		phase: "composition_command",
		failureCode: "composition_command_budget_exceeded",
		disposition: "permanent",
		budget: "command_bytes",
		measured: measuredBytes,
		maximum: maximumBytes,
		commandGrouping: "independent",
	});
	throw new WorkflowWorkerError(
		"composition_command_budget_exceeded",
		"Clip Composition Plan command exceeds the configured byte budget",
		"permanent",
	);
}

function startCompositionResourceSampling(
	record?: (rssBytes: number) => void,
): () => void {
	if (!record) return () => {};
	const clock = currentRenderAdapters().clock;
	let active = true;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const sample = () => {
		if (!active) return;
		const measurement = measureCompositionResourceSafely();
		if (measurement) {
			recordCompositionResourceSampleSafely(record, measurement.rssBytes);
		}
		timer = clock.setTimeout(sample, 100);
	};
	sample();
	return () => {
		active = false;
		if (timer) clock.clearTimeout(timer);
		const measurement = measureCompositionResourceSafely();
		if (measurement) {
			recordCompositionResourceSampleSafely(record, measurement.rssBytes);
		}
	};
}

const resourceMeasurementFallback: CompositionResourceMeasurement = {
	rssBytes: 0,
	scope: "worker_only",
};

function diagnoseCompositionResourceFailure(
	failureCode: "resource_probe_failed" | "resource_record_failed",
): void {
	log(
		"error",
		failureCode === "resource_probe_failed"
			? "clip_composition_resource_probe_failed"
			: "clip_composition_resource_record_failed",
		{
			phase: "diagnostics",
			failureCode,
			disposition: "degraded",
		},
	);
}

function measureCompositionResourceSafely(): CompositionResourceMeasurement | null {
	try {
		const measurement = currentRenderAdapters().resource.measure();
		if (!Number.isFinite(measurement.rssBytes) || measurement.rssBytes < 0) {
			throw new Error("invalid resource measurement");
		}
		return measurement;
	} catch {
		diagnoseCompositionResourceFailure("resource_probe_failed");
		return null;
	}
}

function recordCompositionResourceSampleSafely(
	record: ((rssBytes: number) => void) | undefined,
	rssBytes: number,
): void {
	if (!record) return;
	try {
		record(rssBytes);
	} catch {
		diagnoseCompositionResourceFailure("resource_record_failed");
	}
}

async function executeRenderCommandWithOptionalFallback(input: {
	primaryArgs: string[];
	fallbackArgs?: () => string[];
	optionalAssets: Array<{
		assetClass: OptionalAssetClass;
		failureCode: string;
	}>;
	context: Record<string, unknown>;
	recordCommand?: (args: readonly string[]) => void;
	recordSourceDecodeCompleted?: () => void;
	recordResourceSample?: (rssBytes: number) => void;
}): Promise<"primary" | "fallback"> {
	const execute = async (args: string[]): Promise<void> => {
		assertCompositionCommandWithinBudget(args, input.context);
		input.recordCommand?.(args);
		const safeRecordResourceSample = input.recordResourceSample
			? (rssBytes: number): void =>
					recordCompositionResourceSampleSafely(
						input.recordResourceSample,
						rssBytes,
					)
			: undefined;
		const stopSampling = startCompositionResourceSampling(
			safeRecordResourceSample,
		);
		try {
			await execCommand("ffmpeg", args, {
				recordResourceSample: safeRecordResourceSample,
			});
			input.recordSourceDecodeCompleted?.();
		} finally {
			stopSampling();
		}
	};
	try {
		await execute(input.primaryArgs);
		return "primary";
	} catch (error) {
		rethrowRenderControlFlow(error);
		if (!input.fallbackArgs || input.optionalAssets.length === 0) throw error;
		const fallbackArgs = input.fallbackArgs();
		await execute(fallbackArgs);
		for (const asset of input.optionalAssets) {
			diagnoseOptionalAssetFallback({
				assetClass: asset.assetClass,
				phase: "command",
				failureCode: asset.failureCode,
				context: input.context,
			});
		}
		return "fallback";
	}
}

// Encoding is the dominant cost of a render. veryfast/CRF21 measured
// quality-neutral against the previous medium/CRF23 on this codebase's own
// footage while cutting 34-47s per 60-minute source. Overridable per-env so
// it can be retuned without a deploy.
const DEFAULT_X264_PRESET = "veryfast";
const DEFAULT_X264_CRF = "21";

function x264Preset(): string {
	return currentRenderConfig().x264Preset || DEFAULT_X264_PRESET;
}

function x264Crf(): string {
	return currentRenderConfig().x264Crf || DEFAULT_X264_CRF;
}

function runCommand(
	command: string,
	args: string[],
	options: {
		timeoutMs: number;
		captureStdout: boolean;
		recordResourceSample?: (rssBytes: number) => void;
	},
): Promise<string> {
	return currentRenderAdapters()
		.workerProcess.execute({
			command,
			args,
			signal: currentRenderSignal() ?? new AbortController().signal,
			deadlineMs: options.timeoutMs,
			captureStdout: options.captureStdout,
			recordResourceSample: options.recordResourceSample,
			diagnose: diagnoseRenderProcessOperation,
		})
		.then((result) => result.stdout.toString("utf8"));
}

function diagnoseRenderProcessOperation(event: WorkerProcessDiagnostic): void {
	log(
		event.status === "failed" ? "error" : "info",
		"clip_render_command_operation",
		{
			phase: "command_execution",
			...event,
		},
	);
}

async function execCommand(
	command: string,
	args: string[],
	options?: {
		timeoutMs?: number;
		recordResourceSample?: (rssBytes: number) => void;
	},
) {
	await runCommand(command, args, {
		timeoutMs:
			options?.timeoutMs ?? currentRenderConfig().renderCommandTimeoutMs,
		captureStdout: false,
		recordResourceSample: options?.recordResourceSample,
	});
}

/** Ranged source reads (default): every builder already puts `-ss` before
 *  `-i`, so handing ffmpeg a presigned HTTPS URL makes it range-request only
 *  the clip windows instead of the whole object — clip-preview.ts measured
 *  11.72s wall for a 38s cut off a 531MB 4K source with this exact pattern.
 *  For a 2h podcast, 6-10 clips read ~5-8% of the source bytes vs 100% for
 *  the old full-file download. `WORKER_RENDER_SOURCE_MODE=download` restores
 *  the old behavior; any presign/probe failure falls back to it per run. */
const RENDER_SOURCE_URL_TTL_SEC = 12 * 60 * 60;

function isHttpSource(input: string): boolean {
	return /^https?:\/\//i.test(input);
}

async function probeSource(sourcePath: string): Promise<SourceProbe> {
	const config = currentRenderConfig();
	return currentRenderAdapters().workerProcess.inspectMedia({
		sourcePath,
		signal: currentRenderSignal() ?? new AbortController().signal,
		deadlineMs: config.probeCommandTimeoutMs,
		diagnose: diagnoseRenderProcessOperation,
	});
}

type RequiredSourceOperation =
	| "source_presign"
	| "ranged_probe"
	| "source_download"
	| "local_probe";

function diagnoseRequiredSourceOperation(input: {
	attempt: ClipRenderingWorkflowAttempt;
	operation: RequiredSourceOperation;
	startedAtMs: number;
	failure?: WorkflowFailure;
}): void {
	log(
		input.failure ? "error" : "info",
		input.failure
			? "clip_render_source_operation_failed"
			: "clip_render_source_operation_completed",
		{
			workflowRunId: input.attempt.workflowRunId,
			projectId: input.attempt.projectId,
			workflowAttemptId: input.attempt.attemptId,
			phase: "source_resolution",
			operation: input.operation,
			...(input.failure
				? {
						failureCode: input.failure.code,
						disposition: input.failure.disposition,
					}
				: {}),
			elapsedMs: currentTimeMs() - input.startedAtMs,
		},
	);
}

async function resolveRequiredSource(input: {
	sourceStorageKey: string | null;
	tempDir: string;
	attempt: ClipRenderingWorkflowAttempt;
}): Promise<{ sourcePath: string; probe: SourceProbe }> {
	const sourceStorageKey = input.sourceStorageKey;
	if (!sourceStorageKey) {
		throw new WorkflowFailure(
			"source_storage_key_missing",
			"permanent",
			"The project source file is unavailable",
		);
	}

	const sourceExt = extname(sourceStorageKey) || ".bin";
	const localSourcePath = join(input.tempDir, `source${sourceExt}`);
	currentRenderSignal()?.throwIfAborted();
	if (currentRenderConfig().sourceMode !== "download") {
		let presignedUrl: string | null = null;
		const presignStartedAtMs = currentTimeMs();
		try {
			presignedUrl = await withRenderOperationDeadline({
				operation: () =>
					currentRenderAdapters().storage.presignDownloadUrl({
						key: sourceStorageKey,
						expiresIn: RENDER_SOURCE_URL_TTL_SEC,
					}),
				deadlineMs: currentRenderConfig().storageOperationTimeoutMs,
				timeoutFailure: () =>
					new WorkflowFailure(
						"source_presign_timeout",
						"retryable",
						"Required source presigning timed out",
					),
			});
			currentRenderSignal()?.throwIfAborted();
			diagnoseRequiredSourceOperation({
				attempt: input.attempt,
				operation: "source_presign",
				startedAtMs: presignStartedAtMs,
			});
		} catch (error) {
			rethrowRenderControlFlow(error);
			const failure =
				error instanceof WorkflowFailure &&
				error.code === "source_presign_timeout"
					? error
					: new WorkflowFailure(
							"source_presign_failed",
							"retryable",
							"Required source could not be presigned",
						);
			diagnoseRequiredSourceOperation({
				attempt: input.attempt,
				operation: "source_presign",
				startedAtMs: presignStartedAtMs,
				failure,
			});
		}

		if (presignedUrl) {
			currentRenderSignal()?.throwIfAborted();
			const probeStartedAtMs = currentTimeMs();
			try {
				const probe = await probeSource(presignedUrl);
				currentRenderSignal()?.throwIfAborted();
				diagnoseRequiredSourceOperation({
					attempt: input.attempt,
					operation: "ranged_probe",
					startedAtMs: probeStartedAtMs,
				});
				return { sourcePath: presignedUrl, probe };
			} catch (error) {
				rethrowRenderControlFlow(error);
				diagnoseRequiredSourceOperation({
					attempt: input.attempt,
					operation: "ranged_probe",
					startedAtMs: probeStartedAtMs,
					failure: workflowFailureFromUnknown(error),
				});
			}
		}
	}

	currentRenderSignal()?.throwIfAborted();
	const downloadStartedAtMs = currentTimeMs();
	try {
		await currentRenderAdapters().storage.downloadObjectToFile({
			key: sourceStorageKey,
			filePath: localSourcePath,
			signal: renderStorageSignal(),
		});
		currentRenderSignal()?.throwIfAborted();
		diagnoseRequiredSourceOperation({
			attempt: input.attempt,
			operation: "source_download",
			startedAtMs: downloadStartedAtMs,
		});
	} catch (error) {
		rethrowRenderControlFlow(error);
		const failure = new WorkflowFailure(
			"source_download_failed",
			"retryable",
			"Failed to download required source",
		);
		diagnoseRequiredSourceOperation({
			attempt: input.attempt,
			operation: "source_download",
			startedAtMs: downloadStartedAtMs,
			failure,
		});
		throw failure;
	}

	currentRenderSignal()?.throwIfAborted();
	const probeStartedAtMs = currentTimeMs();
	try {
		const probe = await probeSource(localSourcePath);
		currentRenderSignal()?.throwIfAborted();
		diagnoseRequiredSourceOperation({
			attempt: input.attempt,
			operation: "local_probe",
			startedAtMs: probeStartedAtMs,
		});
		return { sourcePath: localSourcePath, probe };
	} catch (error) {
		rethrowRenderControlFlow(error);
		const originalFailure = workflowFailureFromUnknown(error);
		const failure =
			originalFailure.code === "worker_command_input_invalid"
				? new WorkflowFailure(
						"source_media_invalid",
						"permanent",
						"Required source media could not be read",
						error instanceof Error ? { cause: error } : undefined,
					)
				: originalFailure;
		diagnoseRequiredSourceOperation({
			attempt: input.attempt,
			operation: "local_probe",
			startedAtMs: probeStartedAtMs,
			failure,
		});
		throw failure;
	}
}

/**
 * Decides whether a downloaded canvas-background image should be used as-is
 * or degraded to the solid-color fallback, given whether ffprobe found a
 * decodable video/image stream in it. Kept as a pure function, separate from
 * the ffprobe I/O in `probeBackgroundImageDecodable` below, specifically so
 * the degrade decision is unit-testable without shelling out to ffprobe —
 * tests can stub `decodable` directly.
 */
function resolveBackgroundPlanForDownloadedImage(params: {
	decodable: boolean;
	color: string;
	imagePath: string;
}): BackgroundPlan {
	if (!params.decodable) {
		return { mode: "color", color: params.color, imagePath: null };
	}
	return { mode: "image", color: params.color, imagePath: params.imagePath };
}

/**
 * Probes a downloaded canvas-background file for a decodable video/image
 * stream. `downloadUrlToFile` only validates HTTP status/size/SSRF — a URL
 * that 200s with an HTML page (e.g. the user pasted a page URL instead of a
 * direct image URL) downloads "successfully" but isn't actually decodable,
 * and feeding it to ffmpeg as `-i` fails every render variant. Mirrors
 * `probeSource`'s ffprobe invocation; returns false (never throws) on any
 * probe failure or parse error so the caller can degrade to the color
 * fallback exactly like a download failure.
 */
/**
 * Bounded background task queue for overlapping R2 uploads with the next
 * clip's detection/encode (measured: upload is ~50-60% of per-clip wall time
 * on a residential uplink and is pure network wait while ffmpeg sits idle).
 *
 * Semantics callers rely on:
 *  - At most `limit` tasks run concurrently; excess tasks queue FIFO.
 *  - `schedule` never throws. Task rejection is recorded immediately, every
 *    later task still gets its turn, and `drain()` rethrows the first error
 *    only after the complete scheduled set has settled.
 *  - Attempt cancellation rejects queued tasks without starting them. Active
 *    tasks receive the same signal through their storage adapter.
 *  - `drain()` resolves only when every scheduled task (including ones
 *    scheduled after a previous drain) has settled. Idempotent; safe to call
 *    from both the success path and `finally`.
 */
function createBoundedTaskQueue(
	limit: number,
	signal?: AbortSignal,
): {
	schedule: (task: () => Promise<void>) => void;
	drain: () => Promise<void>;
	/** Number of tasks scheduled over the queue's lifetime (for logging). */
	scheduledCount: () => number;
} {
	const concurrency = Math.min(4, Math.max(1, Math.floor(limit)));
	let active = 0;
	let scheduled = 0;
	let settled = 0;
	let firstError: unknown = null;
	const waiting: Array<() => Promise<void>> = [];
	const inFlight = new Set<Promise<void>>();

	const cancellationReason = () =>
		signal?.reason instanceof Error
			? signal.reason
			: new DOMException("Clip render cancelled", "AbortError");

	const recordError = (error: unknown) => {
		if (firstError === null) firstError = error;
	};

	signal?.addEventListener(
		"abort",
		() => {
			const rejectedCount = waiting.splice(0, waiting.length).length;
			settled += rejectedCount;
			if (rejectedCount > 0) recordError(cancellationReason());
		},
		{ once: true },
	);

	const pump = () => {
		while (active < concurrency && waiting.length > 0) {
			const task = waiting.shift()!;
			active += 1;
			const p = Promise.resolve()
				.then(task)
				.catch(recordError)
				.finally(() => {
					active -= 1;
					settled += 1;
					inFlight.delete(p);
					pump();
				});
			inFlight.add(p);
		}
	};

	return {
		schedule: (task) => {
			scheduled += 1;
			if (signal?.aborted) {
				settled += 1;
				recordError(cancellationReason());
				return;
			}
			waiting.push(task);
			pump();
		},
		drain: async () => {
			// New tasks can be scheduled while draining (not expected today, but
			// cheap to be correct about): loop until truly quiet.
			while (inFlight.size > 0 || waiting.length > 0) {
				await Promise.all([...inFlight]);
			}
			if (settled !== scheduled) {
				throw new Error(
					"Upload queue drained before every scheduled task settled",
				);
			}
			if (firstError !== null) throw firstError;
		},
		scheduledCount: () => scheduled,
	};
}

/** Upload concurrency for the Clip Render Attempt's bounded queue —
 *  2 keeps one upload streaming while a burst finishes, without letting a
 *  slow uplink stack every clip's file into concurrent connections. */
function uploadConcurrency(): number {
	return currentRenderConfig().uploadConcurrency;
}

async function commitProvisionalRenderUpload<T>(input: {
	signal?: AbortSignal;
	complete: () => Promise<T>;
	discard: (reason: string) => Promise<"deleted" | "orphan_candidate">;
}): Promise<T> {
	try {
		input.signal?.throwIfAborted();
		return await input.complete();
	} catch (error) {
		const reason = input.signal?.aborted
			? "attempt_cancelled_after_upload"
			: error instanceof WorkflowAttemptLost
				? "ownership_lost"
				: "persistence_rejected";
		const cleanupResult = await input.discard(reason);
		if (input.signal?.aborted || error instanceof WorkflowAttemptLost) {
			throw error;
		}
		throw new RenderPersistenceFailure(error, cleanupResult);
	}
}

async function uploadRenderedOutput(params: {
	attempt: WorkflowAttemptRef;
	workflowRunId: string;
	projectId: string;
	output: PendingRenderOutput;
	clipDurationSec: number;
	/** Compact JSON-encoded Pexels attribution for any B-roll used in this
	 *  render, so crediting is possible after the fact. There's no dedicated
	 *  DB column reachable without a migration or editing clip.service.ts (out
	 *  of scope here) — object storage metadata is the persistence mechanism
	 *  this task owns end-to-end. See the B-roll upgrade report for the exact
	 *  `Clip.brollAttribution Json?` follow-up if durable, per-clip-queryable
	 *  attribution is wanted later. */
	brollCredits?: string | null;
	/** Wall-clock of the ffmpeg encode that produced this output. For the
	 *  shared multi-output encode the same value is reported for every output
	 *  it covered. */
	encodeMs?: number;
	motionAnalytics: MotionRenderAnalyticsMetadata;
}): Promise<boolean> {
	const deleteProvisionalObject = async (reason: string) => {
		try {
			await currentRenderAdapters().storage.deleteObject(
				params.output.storageKey,
				{
					signal: renderStorageSignal(false),
				},
			);
			return "deleted" as const;
		} catch (error) {
			log("error", "clip_render_provisional_cleanup_failed", {
				workflowRunId: params.workflowRunId,
				attemptId: params.attempt.attemptId,
				projectId: params.projectId,
				clipId: params.output.clipId,
				clipRenderId: params.output.clipRenderId,
				phase: "cleanup",
				operation: "storage_delete",
				reason,
				objectKey: params.output.storageKey,
				objectKeyClass: params.output.storageKey.includes("/exports/")
					? "export_attempt"
					: "ordinary_attempt",
				failureCode: "provisional_object_delete_failed",
				disposition: "orphan_candidate",
				cleanupResult: "orphan_candidate",
				errorCode:
					error instanceof Error ? error.name : "storage_delete_failed",
			});
			return "orphan_candidate" as const;
		}
	};
	if (params.output.resolution === "720p") {
		// Output treatment is already encoded from the composition plan. Probe
		// the resulting canvas; failures follow the ordinary variant policy.
		const treatedProbe = await probeSource(params.output.outputPath);
		log("info", "resolution_export_treatment", {
			workflowRunId: params.workflowRunId,
			clipId: params.output.clipId,
			resolution: params.output.resolution,
			width: treatedProbe.width,
			height: treatedProbe.height,
		});
	}

	const outputStat = await currentRenderAdapters().workspace.stat(
		params.output.outputPath,
	);

	const uploadStartedAtMs = currentTimeMs();
	await currentRenderAdapters().storage.putFileFromPath({
		key: params.output.storageKey,
		filePath: params.output.outputPath,
		contentType: "video/mp4",
		metadata: {
			project_id: params.projectId,
			clip_id: params.output.clipId,
			workflow_run_id: params.workflowRunId,
			format: params.output.aspectRatio,
			...(params.brollCredits ? { broll_credits: params.brollCredits } : {}),
		},
		signal: renderStorageSignal(),
	});
	const uploadMs = currentTimeMs() - uploadStartedAtMs;

	const { persisted } = await commitProvisionalRenderUpload({
		signal: currentRenderSignal(),
		complete: () =>
			currentRenderAdapters().clip.completeClipRenderVariant(
				params.attempt,
				params.output.clipRenderId,
				{
					storageKey: params.output.storageKey,
					sizeBytes: Number(outputStat.size),
					durationSec: params.clipDurationSec,
					motionAnalytics: params.motionAnalytics,
				},
			),
		discard: deleteProvisionalObject,
	});

	if (!persisted) {
		// The ClipRender row this attempt was rendering for is gone — an editor
		// save/reset invalidated it (deleted the row) while this encode was in
		// flight. The storage key is attempt-unique (clipRenderAttemptStorageKey),
		// so this object can never be the one any other row points at; deleting
		// it is always safe and never touches another attempt's bytes.
		const cleanupResult = await deleteProvisionalObject("variant_superseded");
		log("info", "clip_render_variant_completion_stale_discarded", {
			workflowRunId: params.workflowRunId,
			clipId: params.output.clipId,
			clipRenderId: params.output.clipRenderId,
			aspectRatio: params.output.aspectRatio,
			phase: "persistence",
			operation: "complete_clip_render_variant",
			failureCode: "variant_superseded",
			disposition: "superseded",
			objectKeyClass: classifyRenderObjectKey(params.output.storageKey),
			cleanupResult,
		});
		return false;
	}

	log("info", "clip_render_variant_completed", {
		workflowRunId: params.workflowRunId,
		clipId: params.output.clipId,
		clipRenderId: params.output.clipRenderId,
		clipIndex: params.output.clipIndex,
		aspectRatio: params.output.aspectRatio,
		sizeBytes: Number(outputStat.size),
		uploadMs,
		...(params.encodeMs !== undefined ? { encodeMs: params.encodeMs } : {}),
	});
	return true;
}

export class ClipRenderAttempt {
	readonly #run: WorkflowRunJob;
	readonly #config: Readonly<RenderConfig>;
	readonly #lifecycle: ClipRenderAttemptLifecycle;
	readonly #makeAdapters: ClipRenderAttemptDependencies["adapters"];

	constructor(dependencies: ClipRenderAttemptDependencies) {
		this.#run = dependencies.run;
		this.#config = dependencies.config;
		this.#lifecycle = dependencies.lifecycle;
		this.#makeAdapters = dependencies.adapters;
	}

	async execute(
		attempt: ClipRenderingWorkflowAttempt,
		context: WorkflowAttemptContext,
	): Promise<RenderWorkSetOutcome> {
		if (
			attempt.workflowRunId !== this.#run.id ||
			attempt.projectId !== this.#run.projectId
		) {
			throw new WorkflowAttemptLost(attempt);
		}
		const ownershipController = new AbortController();
		const signal = AbortSignal.any([
			context.signal,
			ownershipController.signal,
		]);
		const withAttemptDiagnosticContext =
			(
				diagnose: ClipRenderAttemptAdapters["diagnose"],
			): ClipRenderAttemptAdapters["diagnose"] =>
			(event) =>
				diagnose({
					...event,
					context: sanitizeRenderDiagnosticValue({
						...event.context,
						workflowRunId: attempt.workflowRunId,
						workflowAttemptId: attempt.attemptId,
						projectId: attempt.projectId,
						stage: attempt.stage,
						attemptCount: attempt.attemptCount,
					}) as Record<string, unknown>,
				});
		const providedAdapters = this.#makeAdapters(
			signal,
			withAttemptDiagnosticContext,
		);
		const adapters = {
			...providedAdapters,
			diagnose: withAttemptDiagnosticContext(providedAdapters.diagnose),
		};
		return renderExecutionStorage.run(
			{
				config: this.#config,
				signal,
				adapters,
			},
			async () => {
				const attemptStartedAtMs = currentTimeMs();
				try {
					signal.throwIfAborted();
					const workSet = await this.#lifecycle.beginRenderWorkSet(attempt);
					signal.throwIfAborted();
					const outcome =
						workSet.variantIds.length === 0
							? await this.#lifecycle.settleRenderWorkSet(attempt)
							: await executeClipRenderAttempt(
									this.#run,
									signal,
									attempt,
									this.#lifecycle,
									workSet.variantIds,
									(error) => ownershipController.abort(error),
								);
					log("info", "clip_render_attempt_settled", {
						phase: "settlement",
						operation: "settle_render_work_set",
						disposition: outcome.status,
						retryState:
							outcome.status === "requeued" ? "retry_scheduled" : "terminal",
						requested: outcome.requested,
						succeeded: outcome.succeeded,
						failed: outcome.failed,
						superseded: outcome.superseded,
						followUpWorkflowRunId: outcome.followUpWorkflowRunId,
						elapsedMs: currentTimeMs() - attemptStartedAtMs,
					});
					return outcome;
				} catch (error) {
					if (error instanceof WorkflowAttemptLost) {
						log("error", "clip_render_attempt_interrupted", {
							phase: "ownership",
							operation: "execute",
							failureCode: error.code,
							disposition: "control",
							retryState: "reaper_owned",
							elapsedMs: currentTimeMs() - attemptStartedAtMs,
						});
					}
					throw error;
				}
			},
		);
	}
}

type FrozenRenderingState = NonNullable<
	Awaited<
		ReturnType<
			ClipRenderAttemptAdapters["state"]["getFrozenRenderingStateForWorkSet"]
		>
	>
>;

async function executeClipRenderAttempt(
	run: WorkflowRunJob,
	signal: AbortSignal,
	attempt: ClipRenderingWorkflowAttempt,
	lifecycle: ClipRenderAttemptLifecycle,
	workSetVariantIds: readonly string[],
	abortAttempt: (error: WorkflowAttemptLost) => void,
): Promise<RenderWorkSetOutcome> {
	signal.throwIfAborted();
	const frozenState =
		await currentRenderAdapters().state.getFrozenRenderingStateForWorkSet(
			run.projectId,
			run.id,
		);
	signal.throwIfAborted();

	const pendingRenders = (frozenState?.pendingRenders ?? []).filter((render) =>
		workSetVariantIds.includes(render.id),
	);
	if (!frozenState || pendingRenders.length === 0) {
		return lifecycle.settleRenderWorkSet(attempt);
	}

	// Watermark presence is a run-level entitlement (vizard-parity Phase C
	// export options) — looked up once per run, same as before, but now
	// through the shared hasFeature helper instead of a bare tier check so
	// this is the only place billing.service's PLAN_FEATURES matrix needs to
	// be consulted for it. Resolution, by contrast, is per-row (see
	// `PendingRenderOutput.resolution`, already entitlement-clamped when the
	// row was created by clip.service's triggerClipRendering/
	// autoQueueDefaultRenders) — a single run can, in principle, cover rows at
	// different resolutions.
	const pricingTier = frozenState.pricingTier;
	const applyWatermark = !hasFeature(pricingTier, "export.noWatermark");

	const runStartedAtMs = currentTimeMs();
	log("info", "clip_rendering_run_started", {
		workflowRunId: run.id,
		projectId: run.projectId,
		pricingTier,
	});

	const touchedOptionalAssetClasses = new Set<OptionalAssetClass>();
	return currentRenderAdapters().workerProcess.withScratchDirectory(
		"narriflow-render-",
		(tempDir) =>
			executeClipRenderAttemptInScratch({
				run,
				signal,
				attempt,
				lifecycle,
				workSetVariantIds,
				abortAttempt,
				frozenState,
				pendingRenders,
				applyWatermark,
				runStartedAtMs,
				tempDir,
				touchedOptionalAssetClasses,
			}),
		(event) => {
			for (const assetClass of touchedOptionalAssetClasses) {
				diagnoseOptionalAssetFallback({
					assetClass,
					phase: "cleanup",
					failureCode: "optional_asset_cleanup_failed",
					context: { workflowRunId: run.id, projectId: run.projectId },
				});
			}
			log("error", "clip_render_workspace_cleanup_failed", {
				workflowRunId: run.id,
				projectId: run.projectId,
				phase: "cleanup",
				...event,
			});
		},
	);
}

async function resolveClipAudioAssets(input: {
	run: WorkflowRunJob;
	clip: { id: string };
	frozenState: FrozenRenderingState;
	studioEdits: StudioEdits;
	clipDurationSec: number;
	tempDir: string;
	touchedOptionalAssetClasses: Set<OptionalAssetClass>;
}) {
	const {
		run,
		clip,
		frozenState,
		studioEdits,
		clipDurationSec,
		tempDir,
		touchedOptionalAssetClasses,
	} = input;
	let musicPlan: ResolvedMusicAsset | null = null;
	// Library asset (vizard-parity.md "Music/SFX library" —
	// `studioMusicSchema.assetId`) wins over the pasted `url` at render
	// time — same precedence the schema's own doc comment documents.
	// Resolution failure (deleted row, DB hiccup) is treated exactly like
	// a failed download below: log and skip music entirely, never fail
	// the whole clip (the existing `music_download_failed` policy this
	// mirrors never actually fails the clip either — see the catch below,
	// which only logs).
	let musicUrl: string | null = null;
	let musicDurationSec: number | undefined;
	// M6 (vizard-parity.md "Music/SFX library"): an AudioAsset-resolved
	// music track already passed the AUDIO_UPLOAD_MAX_BYTES gate once at
	// upload time (or is a curated row seeded well under it) — downloading
	// it back down for a render must not silently inherit the much larger
	// 250MB pasted-URL/B-roll budget. A pasted `url` (no assetId) predates
	// this change and keeps the original 250MB policy.
	let musicUrlIsAssetResolved = false;
	if (studioEdits.music.assetId) {
		try {
			const resolved =
				await currentRenderAdapters().audioAsset.resolveRenderSource(
					frozenState.workspaceOwnerUserId,
					studioEdits.music.assetId,
					frozenState.workspaceId,
				);
			musicUrl = resolved?.url ?? null;
			musicDurationSec = resolved?.durationSec;
			musicUrlIsAssetResolved = Boolean(resolved);
			if (!resolved) {
				diagnoseOptionalAssetFallback({
					assetClass: "music",
					phase: "lookup",
					failureCode: "music_asset_unavailable",
					context: { workflowRunId: run.id, clipId: clip.id },
				});
			}
		} catch (error) {
			rethrowRenderControlFlow(error);
			const accessFailure = optionalAccessFailure(error, "music");
			diagnoseOptionalAssetFallback({
				assetClass: "music",
				...accessFailure,
				context: { workflowRunId: run.id, clipId: clip.id },
			});
		}
	} else {
		musicUrl = studioEdits.music.url;
	}

	if (musicUrl) {
		let musicUrlSafe = false;
		try {
			assertPublicHttpUrl(musicUrl);
			musicUrlSafe = true;
		} catch {
			diagnoseOptionalAssetFallback({
				assetClass: "music",
				phase: "lookup",
				failureCode: "music_url_rejected",
				context: { workflowRunId: run.id, clipId: clip.id },
			});
		}
		if (musicUrlSafe) {
			touchedOptionalAssetClasses.add("music");
			const musicPath = join(tempDir, `music-${clip.id}.bin`);
			try {
				await currentRenderAdapters().optionalAssets.downloadUrlToFile(
					musicUrl,
					musicPath,
					"music_download_failed",
					musicUrlIsAssetResolved
						? { maxBytes: AUDIO_UPLOAD_MAX_BYTES }
						: undefined,
				);
				const decodable =
					await currentRenderAdapters().optionalAssets.validateOptionalMedia(
						musicPath,
						"audio",
					);
				if (decodable) {
					musicPlan = {
						path: musicPath,
						ref: compositionAssetRef(
							"music",
							studioEdits.music.assetId ?? musicUrl,
						),
						durationSec: musicDurationSec,
					};
				} else {
					diagnoseOptionalAssetFallback({
						assetClass: "music",
						phase: "decode",
						failureCode: "music_media_invalid",
						context: { workflowRunId: run.id, clipId: clip.id },
					});
				}
			} catch (error) {
				rethrowRenderControlFlow(error);
				diagnoseOptionalAssetFallback({
					assetClass: "music",
					phase: "download",
					failureCode: "music_download_failed",
					context: { workflowRunId: run.id, clipId: clip.id },
				});
			}
		}
	}

	// One-shot SFX placements (vizard-parity.md "Music/SFX library" —
	// `studioEdits.sfx[]`). Each placement is resolved/downloaded
	// independently and best-effort: a single bad placement is skipped
	// (logged) rather than failing every other placement or the whole
	// clip, mirroring the music download policy above.
	const sfxPlans: ResolvedSfxAsset[] = [];
	for (const placement of studioEdits.sfx) {
		if (placement.startSec >= clipDurationSec) {
			log("info", "clip_sfx_skipped_beyond_duration", {
				workflowRunId: run.id,
				clipId: clip.id,
				sfxId: placement.id,
				startSec: placement.startSec,
				clipDurationSec,
			});
			continue;
		}

		let sfxUrl: string | null = null;
		let sfxDurationSec: number | null = null;
		try {
			const resolved =
				await currentRenderAdapters().audioAsset.resolveRenderSource(
					frozenState.workspaceOwnerUserId,
					placement.assetId,
					frozenState.workspaceId,
				);
			sfxUrl = resolved?.url ?? null;
			sfxDurationSec = resolved?.durationSec ?? null;
			if (!resolved) {
				diagnoseOptionalAssetFallback({
					assetClass: "sound_effect",
					phase: "lookup",
					failureCode: "sound_effect_asset_unavailable",
					context: {
						workflowRunId: run.id,
						clipId: clip.id,
						sfxId: placement.id,
					},
				});
			}
		} catch (error) {
			rethrowRenderControlFlow(error);
			const accessFailure = optionalAccessFailure(error, "sound_effect");
			diagnoseOptionalAssetFallback({
				assetClass: "sound_effect",
				...accessFailure,
				context: {
					workflowRunId: run.id,
					clipId: clip.id,
					sfxId: placement.id,
				},
			});
		}
		if (!sfxUrl) continue;

		let sfxUrlSafe = false;
		try {
			assertPublicHttpUrl(sfxUrl);
			sfxUrlSafe = true;
		} catch (error) {
			rethrowRenderControlFlow(error);
			diagnoseOptionalAssetFallback({
				assetClass: "sound_effect",
				phase: "lookup",
				failureCode: "sound_effect_url_rejected",
				context: {
					workflowRunId: run.id,
					clipId: clip.id,
					sfxId: placement.id,
				},
			});
		}
		if (!sfxUrlSafe) continue;

		const sfxPath = join(tempDir, `sfx-${clip.id}-${placement.id}.bin`);
		touchedOptionalAssetClasses.add("sound_effect");
		try {
			// M6: SFX placements are always resolved through an AudioAsset
			// (`assetId` is required by `studioSfxPlacementSchema`) — bounded
			// by the same AUDIO_UPLOAD_MAX_BYTES the upload gate enforced,
			// not the larger 250MB B-roll/pasted-URL budget.
			await currentRenderAdapters().optionalAssets.downloadUrlToFile(
				sfxUrl,
				sfxPath,
				"sfx_download_failed",
				{
					maxBytes: AUDIO_UPLOAD_MAX_BYTES,
				},
			);
			const decodable =
				await currentRenderAdapters().optionalAssets.validateOptionalMedia(
					sfxPath,
					"audio",
				);
			if (decodable && sfxDurationSec && sfxDurationSec > 0) {
				sfxPlans.push({
					path: sfxPath,
					id: placement.id,
					ref: compositionAssetRef("sound-effect", placement.assetId),
					durationSec: sfxDurationSec,
				});
			} else {
				diagnoseOptionalAssetFallback({
					assetClass: "sound_effect",
					phase: "decode",
					failureCode: "sound_effect_media_invalid",
					context: {
						workflowRunId: run.id,
						clipId: clip.id,
						sfxId: placement.id,
					},
				});
			}
		} catch (error) {
			rethrowRenderControlFlow(error);
			diagnoseOptionalAssetFallback({
				assetClass: "sound_effect",
				phase: "download",
				failureCode: "sound_effect_download_failed",
				context: {
					workflowRunId: run.id,
					clipId: clip.id,
					sfxId: placement.id,
				},
			});
		}
	}

	return { musicPlan, sfxPlans };
}

// Private clip-group phase. Frozen revisions share evidence and assets; their
// failures affect only the variants in this group. Source and settlement failures
// remain owned by the enclosing Clip Render Attempt.
async function renderClipGroup(input: {
	run: WorkflowRunJob;
	attempt: ClipRenderingWorkflowAttempt;
	renderGroup: FrozenRenderingState["pendingRenders"];
	frozenState: FrozenRenderingState;
	probe: SourceProbe;
	sourcePath: string;
	tempDir: string;
	brandLogo: LogoOverlay | null;
	brandLogoWasRequested: boolean;
	touchedOptionalAssetClasses: Set<OptionalAssetClass>;
	motionAnalyticsByRenderId: Map<string, MotionRenderAnalyticsMetadata>;
	applyWatermark: boolean;
	scheduleUpload(
		output: PendingRenderOutput,
		metadata: {
			clipDurationSec: number;
			brollCredits?: string | null;
			encodeMs: number;
			motionAnalytics: MotionRenderAnalyticsMetadata;
		},
	): void;
}) {
	const {
		run,
		attempt,
		renderGroup,
		frozenState,
		probe,
		sourcePath,
		tempDir,
		brandLogo,
		brandLogoWasRequested,
		touchedOptionalAssetClasses,
		motionAnalyticsByRenderId,
		applyWatermark,
		scheduleUpload,
	} = input;
	const storedClip = renderGroup[0]!.clipSnapshot ?? renderGroup[0]!.clip;
	const editorDocument = decodeClipEditorDocumentFromStorage(
		storedClip,
		frozenState.sourceDurationSeconds,
	);
	let motionAnalytics = motionRenderAnalyticsMetadata(editorDocument, {
		applyScope: "clip",
		renderOutcome: "completed",
	});
	// Export-bound rows carry a complete frozen rendering snapshot. This
	// metadata view deliberately excludes document decoding: every
	// document-owned field above crossed the canonical persistence codec.
	const clip = renderGroup[0]!.clipSnapshot
		? (renderGroup[0]!
				.clipSnapshot as unknown as (typeof renderGroup)[number]["clip"])
		: renderGroup[0]!.clip;
	const effective = resolveRenderTimingForClip({
		llmModel: clip.llmModel,
		utterances: editorDocument.transcriptSlice,
		startSec: editorDocument.clipStartSec,
		endSec: editorDocument.clipEndSec,
	});
	const clipStartSec = effective.startSec;
	const clipEndSec = effective.endSec;
	const utterances = effective.transcriptSlice;

	const deletedRanges = editorDocument.deletedRanges;
	const cutPlan = buildClipCutPlan(deletedRanges, {
		startSec: clipStartSec,
		endSec: clipEndSec,
	});
	if (cutPlan.droppedSliverCount > 0) {
		log("info", "clip_cut_plan_slivers_dropped", {
			workflowRunId: run.id,
			clipId: clip.id,
			droppedSliverCount: cutPlan.droppedSliverCount,
		});
	}
	// Every downstream duration-dependent consumer (captions, text layers,
	// transitions, music, B-roll cutaway planning, the audiogram
	// waveform/background, and the final `-t` output bound) reads THIS
	// value — the edited (post-cut) duration when the clip has real cuts,
	// otherwise the exact original `effective.durationSec` (not
	// `cutPlan.editedDurationSec`, which is ms-rounded — keeping the raw
	// value for the untouched common case is what makes the no-deletions
	// render byte-identical to before this change).
	const clipDurationSec = cutPlan.isUncut
		? effective.durationSec
		: cutPlan.editedDurationSec;
	const initialResourceMeasurement =
		measureCompositionResourceSafely() ?? resourceMeasurementFallback;
	const compositionResources = {
		planVersion: null as number | null,
		planFingerprint: null as string | null,
		requestedMode: null as CompositionMode | null,
		effectiveModes: [] as CompositionMode[],
		sceneCount: 0,
		visualLayerCount: 0,
		planningDurationMs: 0,
		analysisRequestKeys: new Set<string>(),
		analysisExecutionCount: 0,
		detectorExecutionCount: 0,
		extractedSegmentCount: 0,
		commandCount: 0,
		sourceDecodeCount: 0,
		commandBytes: 0,
		encodeDurationMs: 0,
		peakRssBytes: initialResourceMeasurement.rssBytes,
		peakRssScope: initialResourceMeasurement.scope,
	};
	const recordCompositionCommand = (args: readonly string[]): void => {
		compositionResources.commandCount += 1;
		compositionResources.commandBytes += commandSizeBytes("ffmpeg", args);
		const measurement = measureCompositionResourceSafely();
		if (measurement) {
			compositionResources.peakRssScope = measurement.scope;
			recordCompositionResourceSample(measurement.rssBytes);
		}
	};
	const recordCompositionResourceSample = (rssBytes: number): void => {
		compositionResources.peakRssBytes = Math.max(
			compositionResources.peakRssBytes,
			rssBytes,
		);
	};
	const recordCompositionSourceDecodeCompleted = (): void => {
		compositionResources.sourceDecodeCount += 1;
	};
	const recordCompositionEncodeCompleted = (startedAtMs: number): number => {
		const durationMs = Math.max(0, currentTimeMs() - startedAtMs);
		compositionResources.encodeDurationMs += durationMs;
		const measurement = measureCompositionResourceSafely();
		if (measurement) {
			compositionResources.peakRssScope = measurement.scope;
			recordCompositionResourceSample(measurement.rssBytes);
		}
		return durationMs;
	};
	const getAnalysisSegment = async () => {
		const segment =
			await currentRenderAdapters().analysis.extractFaceDetectionSegment({
				sourcePath,
				tempDir,
				clipId: clip.id,
				workflowRunId: run.id,
				clipStartSec,
				durationSec: effective.durationSec,
			});
		if (segment && segment.path !== sourcePath)
			compositionResources.extractedSegmentCount += 1;
		return segment ? { ...segment, durationSec: effective.durationSec } : null;
	};

	const captionPreset = editorDocument.captionPreset;
	const studioEdits = editorDocument.studioEdits;

	// Per-clip effective logo: this clip's studioEdits.logo override
	// merged over the project-wide brandLogo (frozen snapshot + already
	// -downloaded file). `null` whenever there's no logo asset at all, or
	// this clip's override disables it.
	const logo = resolveClipLogoOverlay(brandLogo, studioEdits.logo);
	const plannedLogoSettings = brandLogo
		? resolveEffectiveLogoSettings(
				{
					position: brandLogo.position,
					opacity: brandLogo.opacity,
					scalePct: brandLogo.scalePct,
				},
				studioEdits.logo,
			)
		: null;

	const outputs: PendingRenderOutput[] = renderGroup.map((render) => {
		const aspectRatio =
			clipAspectRatioFromDb[clipAspectRatioDbSchema.parse(render.aspectRatio)];
		const slug =
			clipAspectRatioOptions.find((option) => option.value === aspectRatio)
				?.slug ?? "9x16";
		// Tolerant parse, same fallback as clip.service's
		// toClipRenderVariantSnapshot — a row written before this column
		// existed (or an unexpected value) degrades to the column's own DB
		// default rather than failing the whole clip.
		const resolution =
			clipRenderResolutionSchema.safeParse(render.resolution).data ?? "1080p";

		return {
			clipRenderId: render.id,
			clipId: clip.id,
			clipIndex: clip.index,
			aspectRatio,
			outputPath: join(tempDir, `clip-${clip.id}-${render.id}-${slug}.mp4`),
			storageKey: render.exportVariant
				? clipExportAttemptStorageKey({
						projectId: run.projectId,
						exportId: render.exportVariant.exportId,
						variantId: render.exportVariantId!,
						aspectRatioSlug: slug,
						attemptId: attempt.attemptId,
					})
				: clipRenderAttemptStorageKey(
						run.projectId,
						clip.id,
						slug,
						attempt.attemptId,
					),
			resolution,
			watermark: render.exportVariant?.watermark ?? applyWatermark,
		};
	});
	for (const output of outputs) {
		motionAnalyticsByRenderId.set(output.clipRenderId, motionAnalytics);
	}

	// Claim the variants before every terminal branch. Lifecycle failure
	// settlement is fenced to rows owned by this render attempt; failing a
	// still-pending row is intentionally rejected as stale.
	await Promise.all(
		outputs.map((output) =>
			currentRenderAdapters().clip.markClipRenderVariantRendering(
				attempt,
				output.clipRenderId,
			),
		),
	);

	// Guard (vizard-parity Phase B step 7): deletedRanges covering the
	// whole clip window (or leaving only sub-50ms slivers) leaves nothing
	// renderable. Fail every variant in this group with a structured error
	// instead of ever attempting a zero/near-zero-duration encode, and
	// skip straight to the next clip group.
	if (cutPlan.isEmpty) {
		log("error", "clip_cut_plan_empty", {
			workflowRunId: run.id,
			clipId: clip.id,
			clipIndex: clip.index,
			deletedRangeCount: deletedRanges.length,
		});
		await Promise.all(
			outputs.map((output) =>
				currentRenderAdapters().clip.failClipRenderVariant(
					attempt,
					output.clipRenderId,
					"clip_cut_plan_empty",
					"permanent",
					{ ...motionAnalytics, renderOutcome: "failed" },
				),
			),
		);
		return;
	}

	// Stock B-roll: when a Pexels key is set, plan 2-4 recurring cutaways
	// (driven by the detection LLM's cues when present on the clip, else
	// the keyword-derived query spaced evenly across the clip) — a single
	// cutaway reads as accidental and is a known quality complaint about
	// competitors. Best-effort: any failure renders normally without
	// B-roll. The studio picker's explicit choice, when present, always
	// wins and stays a single cutaway — a user who hand-picked one asset
	// didn't ask to see it repeated.
	let brollPlan: BrollPlan | null = null;
	const brollEnabled =
		currentRenderConfig().pexelsConfigured &&
		currentRenderConfig().brollEnabled;
	const userBrollUrl = editorDocument.brollUrl;
	if (
		(brollEnabled || userBrollUrl) &&
		probe.hasVideo &&
		clipDurationSec >= 12
	) {
		let safeUserBrollUrl: string | null = null;
		if (userBrollUrl) {
			try {
				assertPublicHttpUrl(userBrollUrl);
				safeUserBrollUrl = userBrollUrl;
			} catch {
				diagnoseOptionalAssetFallback({
					assetClass: "broll",
					phase: "lookup",
					failureCode: "broll_url_rejected",
					context: { workflowRunId: run.id, clipId: clip.id },
				});
			}
		}

		if (safeUserBrollUrl) {
			touchedOptionalAssetClasses.add("broll");
			const brollPath = join(tempDir, `broll-${clip.id}-manual.mp4`);
			try {
				await currentRenderAdapters().optionalAssets.downloadUrlToFile(
					safeUserBrollUrl,
					brollPath,
					"broll_download_failed",
				);
				const decodable =
					await currentRenderAdapters().optionalAssets.validateOptionalMedia(
						brollPath,
						"video",
					);
				if (!decodable) {
					diagnoseOptionalAssetFallback({
						assetClass: "broll",
						phase: "decode",
						failureCode: "broll_media_invalid",
						context: { workflowRunId: run.id, clipId: clip.id },
					});
				} else {
					// A manual pick has no reported duration — probe the downloaded
					// file so the cutaway window (and therefore the B-roll input's
					// own -t trim in buildBrollVideoArgs) is sized against real
					// footage rather than a guess.
					const effectiveDurationSec =
						await currentRenderAdapters().optionalAssets.probeMediaDurationSec(
							brollPath,
						);
					const window =
						effectiveDurationSec !== null
							? planBrollWindow(clipDurationSec, effectiveDurationSec)
							: null;

					if (window) {
						brollPlan = {
							cutaways: [
								{
									ref: compositionAssetRef("broll", safeUserBrollUrl),
									path: brollPath,
									window,
								},
							],
							credits: [],
						};
						log("info", "clip_broll_selected", {
							workflowRunId: run.id,
							clipId: clip.id,
							source: "studio_pick",
							cutawayCount: 1,
							brollDurationSec: effectiveDurationSec,
						});
					} else {
						diagnoseOptionalAssetFallback({
							assetClass: "broll",
							phase: "probe",
							failureCode: "broll_media_unusable",
							context: { workflowRunId: run.id, clipId: clip.id },
						});
					}
				}
			} catch (error) {
				rethrowRenderControlFlow(error);
				brollPlan = null;
				diagnoseOptionalAssetFallback({
					assetClass: "broll",
					phase: "download",
					failureCode: "broll_download_failed",
					context: {
						workflowRunId: run.id,
						clipId: clip.id,
						source: "studio_pick",
					},
				});
			}
		} else {
			// Auto path: consume LLM-provided cues when the clip carries them
			// (optional column — absent on existing rows and any clip not yet
			// produced by a detect-clips.ts that writes it), else fall back to
			// the keyword-derived query for every auto-placed slot.
			const rawBrollCues = (clip as { brollCues?: unknown }).brollCues;
			const brollCuesParsed = rawBrollCues
				? brollCuesArraySchema.safeParse(rawBrollCues)
				: null;
			if (brollCuesParsed && !brollCuesParsed.success) {
				diagnoseOptionalAssetFallback({
					assetClass: "broll",
					phase: "parse",
					failureCode: "broll_cues_invalid",
					context: { workflowRunId: run.id, clipId: clip.id },
				});
			}
			const rawCues: BrollCueInput[] | null =
				brollCuesParsed?.success && brollCuesParsed.data.length > 0
					? brollCuesParsed.data
					: null;
			// Fix #2: brollCues[].atSec are uncut clip-relative seconds, but
			// clipDurationSec/planBrollCutaways below operate on the edited
			// (post-cut) timeline once deletedRanges are in play — remap
			// through the same cutPlan.map every other cut-concat consumer
			// (captions, reframe) uses, dropping cues whose moment was cut.
			const remappedCues = remapBrollCuesForCutPlan(
				rawCues,
				cutPlan,
				clipStartSec,
			);
			const cues: BrollCueInput[] | null =
				remappedCues && remappedCues.length > 0 ? remappedCues : null;

			const category = clip.category as ClipCategory;
			const fallbackQuery = brollQueryForClip(
				clip.title,
				clip.hookText,
				category,
			);
			const broaderFallbackQuery =
				CATEGORY_BROLL_FALLBACK_QUERY[category] ?? null;

			if (cues || fallbackQuery) {
				const orientation = dominantPexelsOrientation(
					outputs.map((o) => o.aspectRatio),
				);
				const targetWidth = orientation === "landscape" ? 1920 : 1080;
				const targetHeight = orientation === "landscape" ? 1080 : 1920;

				try {
					const resolvedCutaways =
						await currentRenderAdapters().optionalAssets.resolveBrollCutaways({
							clipDurationSec,
							cues,
							fallbackQuery,
							broaderFallbackQuery,
							orientation,
							targetWidth,
							targetHeight,
						});

					const cutaways: BrollCutaway[] = [];
					const credits: BrollPlan["credits"] = [];

					for (const [index, resolved] of resolvedCutaways.entries()) {
						try {
							touchedOptionalAssetClasses.add("broll");
							let brollPath =
								await currentRenderAdapters().optionalAssets.getCachedBrollAssetPath(
									resolved.downloadUrl,
									currentRenderConfig().brollAssetCacheTtlMs,
								);
							let downloadedForCache = false;
							if (!brollPath) {
								const downloadedPath = join(
									tempDir,
									`broll-${clip.id}-${index}.mp4`,
								);
								await currentRenderAdapters().optionalAssets.downloadUrlToFile(
									resolved.downloadUrl,
									downloadedPath,
									"broll_download_failed",
								);
								brollPath = downloadedPath;
								downloadedForCache = true;
							}
							const decodable =
								await currentRenderAdapters().optionalAssets.validateOptionalMedia(
									brollPath,
									"video",
								);
							if (!decodable) {
								diagnoseOptionalAssetFallback({
									assetClass: "broll",
									phase: "decode",
									failureCode: "broll_media_invalid",
									context: {
										workflowRunId: run.id,
										clipId: clip.id,
										query: resolved.query,
									},
								});
								continue;
							}
							if (downloadedForCache) {
								try {
									await currentRenderAdapters().optionalAssets.saveBrollAssetToCache(
										resolved.downloadUrl,
										brollPath,
									);
								} catch (error) {
									rethrowRenderControlFlow(error);
									diagnoseOptionalAssetFallback({
										assetClass: "broll",
										phase: "cleanup",
										failureCode: "broll_cache_write_failed",
										context: {
											workflowRunId: run.id,
											clipId: clip.id,
											query: resolved.query,
										},
									});
								}
							}
							cutaways.push({
								ref: compositionAssetRef("broll", resolved.downloadUrl),
								path: brollPath,
								window: {
									startSec: resolved.startSec,
									endSec: resolved.endSec,
								},
							});
							credits.push({
								query: resolved.query,
								startSec: resolved.startSec,
								endSec: resolved.endSec,
								authorName: resolved.attribution.authorName,
								authorUrl: resolved.attribution.authorUrl,
								pageUrl: resolved.attribution.pageUrl,
							});
						} catch (error) {
							rethrowRenderControlFlow(error);
							diagnoseOptionalAssetFallback({
								assetClass: "broll",
								phase: "download",
								failureCode: "broll_download_failed",
								context: {
									workflowRunId: run.id,
									clipId: clip.id,
									query: resolved.query,
								},
							});
						}
					}

					if (cutaways.length > 0) {
						brollPlan = { cutaways, credits };
						log("info", "clip_broll_selected", {
							workflowRunId: run.id,
							clipId: clip.id,
							source: cues ? "cues" : "auto",
							cutawayCount: cutaways.length,
							credits,
						});
					}
				} catch (error) {
					rethrowRenderControlFlow(error);
					diagnoseOptionalAssetFallback({
						assetClass: "broll",
						phase: "lookup",
						failureCode: "broll_provider_unavailable",
						context: {
							workflowRunId: run.id,
							clipId: clip.id,
							source: "auto",
						},
					});
				}
			}
		}
	}

	// Missing or unavailable evidence stays planner input and produces an
	// explicit Center fallback. The persisted plan is shared with Studio.
	const layoutEngineEnabled = currentRenderConfig().layoutEngineEnabled;
	const compositionSourceIdentity = compositionAssetRef(
		"source",
		run.projectId,
	);
	const compositionDocument: EditorDocument = {
		...editorDocument,
		clipStartSec,
		clipEndSec,
		captionPreset,
		transcriptSlice: utterances,
		studioEdits,
		brollUrl: editorDocument.brollUrl,
		deletedRanges,
	};
	const sceneAssetReferences = [
		...new Map([
			...compositionDocument.sceneBlocks.flatMap((block) =>
				block.content.kind === "image" || block.content.kind === "video"
					? [
							[
								block.content.asset.id,
								{ ...block.content.asset, kind: block.content.kind },
							] as const,
						]
					: [],
			),
			...studioEdits.visualBroll.map(
				(placement) =>
					[
						placement.asset.id,
						{ ...placement.asset, kind: "image" as const },
					] as const,
			),
		]).values(),
	];
	const sceneFontReferences = [
		...new Map(
			compositionDocument.sceneBlocks.flatMap((block) =>
				block.content.kind === "text" && block.content.fontAsset
					? [
							[
								block.content.fontAsset.id,
								{
									...block.content.fontAsset,
									family: block.content.fontFamily,
								},
							] as const,
						]
					: [],
			),
		).values(),
	];
	const resolvedSceneAssets: Record<
		string,
		{ path: string; kind: "image" | "video"; hasAudio: boolean }
	> = {};
	const resolvedSceneFonts: Record<string, string> = {};
	const sceneSources =
		sceneAssetReferences.length > 0 || sceneFontReferences.length > 0
			? await currentRenderAdapters().assets.loadSceneSources({
					workspaceId: frozenState.workspaceId,
					visualIds: sceneAssetReferences.map((asset) => asset.id),
					fontIds: sceneFontReferences.map((font) => font.id),
				})
			: { visuals: [], fonts: [] };
	if (sceneAssetReferences.length > 0) {
		const assets = sceneSources.visuals;
		const byId = new Map(assets.map((asset) => [asset.id, asset]));
		for (const reference of sceneAssetReferences) {
			const asset = byId.get(reference.id);
			if (
				!asset ||
				asset.fingerprint !== reference.fingerprint ||
				asset.kind !== reference.kind
			) {
				throw new WorkflowWorkerError(
					"scene_asset_unavailable",
					"An inserted scene asset is missing or changed",
					"permanent",
				);
			}
			const path = join(
				tempDir,
				`scene-${asset.id}${extname(asset.storageKey) || (asset.kind === "image" ? ".png" : ".mp4")}`,
			);
			await currentRenderAdapters().storage.downloadObjectToFile({
				key: asset.storageKey,
				filePath: path,
				signal: renderStorageSignal(),
			});
			const decodable =
				await currentRenderAdapters().optionalAssets.validateOptionalMedia(
					path,
					asset.kind,
				);
			if (!decodable)
				throw new WorkflowWorkerError(
					"scene_asset_invalid",
					"An inserted scene asset is not decodable",
					"permanent",
				);
			const sceneProbe =
				asset.kind === "video" ? await probeSource(path) : null;
			if (sceneProbe) {
				const sceneDurationSec =
					await currentRenderAdapters().optionalAssets.probeMediaDurationSec(
						path,
					);
				const invalidRange = compositionDocument.sceneBlocks.some(
					(block) =>
						block.content.kind === "video" &&
						block.content.asset.id === asset.id &&
						(sceneDurationSec === null ||
							block.content.sourceEndSec > sceneDurationSec + 0.05),
				);
				if (invalidRange || sceneDurationSec === null) {
					throw new WorkflowWorkerError(
						"scene_asset_range_invalid",
						"An inserted video scene exceeds its source duration",
						"permanent",
					);
				}
			}
			resolvedSceneAssets[
				compositionAssetRef("visual_asset", `${asset.id}:${asset.fingerprint}`)
			] = {
				path,
				kind: asset.kind,
				hasAudio: sceneProbe?.hasAudio ?? false,
			};
		}
	}
	if (sceneFontReferences.length > 0) {
		const fonts = sceneSources.fonts;
		const byId = new Map(fonts.map((font) => [font.id, font]));
		for (const reference of sceneFontReferences) {
			const font = byId.get(reference.id);
			if (
				!font ||
				font.fingerprint !== reference.fingerprint ||
				font.family !== reference.family
			) {
				throw new WorkflowWorkerError(
					"scene_font_unavailable",
					"An inserted scene font is missing or changed",
					"permanent",
				);
			}
			const path = join(
				tempDir,
				`scene-font-${font.id}.${font.format.toLowerCase()}`,
			);
			await currentRenderAdapters().storage.downloadObjectToFile({
				key: font.storageKey,
				filePath: path,
				signal: renderStorageSignal(),
			});
			resolvedSceneFonts[
				compositionAssetRef("brand_font", `${font.id}:${font.fingerprint}`)
			] = path;
		}
	}
	const sceneVisualAvailability = Object.fromEntries(
		compositionDocument.sceneBlocks.flatMap((scene) =>
			scene.content.kind === "image" || scene.content.kind === "video"
				? [
						[
							scene.id,
							{
								state: "available" as const,
								ref: compositionAssetRef(
									"visual_asset",
									`${scene.content.asset.id}:${scene.content.asset.fingerprint}`,
								),
							},
						],
					]
				: [],
		),
	);
	const sceneFontAvailability = Object.fromEntries(
		compositionDocument.sceneBlocks.flatMap((scene) =>
			scene.content.kind === "text" && scene.content.fontAsset
				? [
						[
							scene.id,
							{
								state: "available" as const,
								ref: compositionAssetRef(
									"brand_font",
									`${scene.content.fontAsset.id}:${scene.content.fontAsset.fingerprint}`,
								),
							},
						],
					]
				: [],
		),
	);
	const layoutEvidence = new LayoutEvidence(
		{
			source: {
				identity: compositionSourceIdentity,
				hasVideo: probe.hasVideo,
				width: probe.width || 1,
				height: probe.height || 1,
			},
			clip: {
				id: clip.id,
				startSec: clipStartSec,
				endSec: clipEndSec,
				deletedRanges,
				utterances,
				editorRevision: clip.editorRevision,
				previewStorageKey: clip.previewStorageKey,
			},
			durable: {
				automatic: clip.autoLayoutAnalysis,
				screen: clip.layoutAnalysis,
				split: clip.splitLayoutAnalysis,
			},
			enabled: {
				automatic: layoutEngineEnabled,
				screen: currentRenderConfig().screenLayoutEnabled,
				split: currentRenderConfig().splitEnabled,
			},
			hasBroll: Boolean(brollPlan),
			pipMotionThreshold: currentRenderConfig().pipMotionThreshold,
			signal: currentRenderSignal() ?? new AbortController().signal,
			getSegment: getAnalysisSegment,
		},
		{
			detectors: currentRenderAdapters().analysis,
			now: currentTimeMs,
			rethrowControl: rethrowRenderControlFlow,
			diagnose: (message, context) =>
				log(message.includes("failed") ? "error" : "info", message, {
					workflowRunId: run.id,
					...context,
				}),
			persist: async (write, snapshot) => {
				if (!snapshot.previewStorageKey) return false;
				const expected = {
					editorRevision: snapshot.editorRevision,
					previewStorageKey: snapshot.previewStorageKey,
				};
				const adapter = currentRenderAdapters().clip;
				if (write.kind === "automatic")
					return adapter.completeClipAutoLayoutAnalysis(
						attempt,
						clip.id,
						write.value,
						expected,
					);
				if (write.kind === "split")
					return adapter.completeClipSplitLayoutAnalysis(
						attempt,
						clip.id,
						write.value,
						expected,
					);
				if (write.kind === "split-failure")
					return adapter.completeClipSplitLayoutFailure(
						attempt,
						clip.id,
						write.value,
						expected,
					);
				if (write.kind === "screen")
					await adapter.setClipLayoutAnalysis(
						attempt,
						clip.id,
						write.value,
						expected,
					);
				else
					await adapter.setClipLayoutAnalysisFailure(
						attempt,
						clip.id,
						write.value,
						expected,
					);
				return undefined;
			},
		},
	);
	// Ask the shared planner which evidence this exact document and target set
	// needs. Scene layout selections can require speaker analysis even when the
	// clip-wide framing mode is Center or Fit, so the global mode is not a
	// complete scheduling signal.
	const layoutEvidenceProbe = probe.hasVideo
		? planClipComposition({
				document: compositionDocument,
				source: {
					identity: compositionSourceIdentity,
					kind: "video",
					width: probe.width,
					height: probe.height,
				},
				evidence: layoutEvidence.availability,
				assets: {
					backgroundImage: { state: "missing" },
					sceneVisuals: sceneVisualAvailability,
					sceneFonts: sceneFontAvailability,
				},
				capabilities: {
					automaticSpeakerLayout: layoutEngineEnabled,
					automaticSpeakerEngineVersion: CLIP_AUTO_LAYOUT_ENGINE,
					explicitSplitLayout: currentRenderConfig().splitEnabled,
					splitEngineVersion: "explicit-split-v1",
					screenLayout: currentRenderConfig().screenLayoutEnabled,
					screenEngineVersion: SCREEN_LAYOUT_ENGINE_VERSION,
				},
				targets: outputs.map((output) => {
					const target = aspectRatioConfig.get(output.aspectRatio)!;
					return {
						id: output.clipRenderId,
						aspectRatio: output.aspectRatio,
						width: target.width,
						height: target.height,
					};
				}),
			})
		: null;
	const requestedLayoutEvidence =
		layoutEvidenceProbe && layoutEvidenceProbe.status !== "invalid"
			? layoutEvidenceProbe.plan.evidenceRequests
			: [];
	await layoutEvidence.fulfill(requestedLayoutEvidence);
	for (const key of layoutEvidence.resources.requestKeys)
		compositionResources.analysisRequestKeys.add(key);
	compositionResources.analysisExecutionCount +=
		layoutEvidence.resources.analysisExecutionCount;
	compositionResources.detectorExecutionCount +=
		layoutEvidence.resources.detectorExecutionCount;
	const automaticAvailability = layoutEvidence.availability.automaticLayout;
	const automaticLayoutAnalysisForPlan =
		automaticAvailability.state === "available"
			? automaticAvailability.value.analysis
			: null;
	const automaticLayoutEvidenceFailure =
		automaticAvailability.state === "disabled" ? "disabled" : "failed";
	const automaticLayoutEvidenceSource = layoutEvidence.automaticSource;
	const splitLayoutEvidenceForPlan = layoutEvidence.availability.splitLayout;
	const screenLayoutEvidenceForPlan = layoutEvidence.availability.screenLayout;

	const { musicPlan, sfxPlans } = await resolveClipAudioAssets({
		run,
		clip,
		frozenState,
		studioEdits,
		clipDurationSec,
		tempDir,
		touchedOptionalAssetClasses,
	});

	const renderedAspectRatios = new Set(
		outputs.map((output) => output.aspectRatio),
	);
	const needsCanvasBackground =
		resolveEffectiveFramingMode(studioEdits) === "fit" ||
		studioEdits.sceneLayouts.some(
			(selection) =>
				sceneLayoutPresetShowsBackground(selection.preset) &&
				renderedAspectRatios.has(selection.aspectRatio),
		);

	// Canvas background (vizard-parity Phase C item 2): mirrors the music
	// plan above — resolve once per clip, downloading the background image
	// (if any) to a local file so the per-output builders never touch the
	// network themselves. A bad/unsafe image URL, a failed download, or a
	// downloaded file that ffprobe can't find a decodable video/image
	// stream in (e.g. the URL 200s with an HTML page instead of an image)
	// degrades to the solid-color fallback (black if no color was chosen
	// either) rather than failing the render — same "best effort, never
	// fail the clip" policy the music/B-roll downloads follow.
	//
	// Timed templates with gaps, contained source, or masked corners expose the
	// canvas just like Fit. Limit that work to aspect ratios rendered here.
	let backgroundPlan: BackgroundPlan | null = null;
	if (needsCanvasBackground) {
		const fallbackColor = studioEdits.background.color ?? "#000000";
		backgroundPlan = {
			mode: "color",
			color: fallbackColor,
			imagePath: null,
		};

		if (
			studioEdits.background.mode === "image" &&
			studioEdits.background.imageUrl
		) {
			let imageUrlSafe = false;
			try {
				assertPublicHttpUrl(studioEdits.background.imageUrl);
				imageUrlSafe = true;
			} catch {
				diagnoseOptionalAssetFallback({
					assetClass: "background",
					phase: "lookup",
					failureCode: "background_image_url_rejected",
					context: { workflowRunId: run.id, clipId: clip.id },
				});
			}
			if (imageUrlSafe) {
				touchedOptionalAssetClasses.add("background");
				const backgroundImagePath = join(tempDir, `background-${clip.id}.bin`);
				try {
					await currentRenderAdapters().optionalAssets.downloadUrlToFile(
						studioEdits.background.imageUrl,
						backgroundImagePath,
						"background_image_download_failed",
					);
					const probeDecodable =
						await currentRenderAdapters().optionalAssets.probeBackgroundImageDecodable(
							backgroundImagePath,
						);
					const decodable =
						probeDecodable &&
						(await currentRenderAdapters().optionalAssets.validateOptionalMedia(
							backgroundImagePath,
							"image",
						));
					if (!decodable) {
						diagnoseOptionalAssetFallback({
							assetClass: "background",
							phase: probeDecodable ? "decode" : "probe",
							failureCode: probeDecodable
								? "background_image_decode_failed"
								: "background_image_invalid",
							context: { workflowRunId: run.id, clipId: clip.id },
						});
					}
					backgroundPlan = resolveBackgroundPlanForDownloadedImage({
						decodable,
						color: fallbackColor,
						imagePath: backgroundImagePath,
					});
				} catch (error) {
					rethrowRenderControlFlow(error);
					diagnoseOptionalAssetFallback({
						assetClass: "background",
						phase: "download",
						failureCode: "background_image_download_failed",
						context: { workflowRunId: run.id, clipId: clip.id },
					});
					// backgroundPlan stays the color fallback set above.
				}
			}
		}
	}

	const optionalCommandAssets: Array<{
		assetClass: OptionalAssetClass;
		failureCode: string;
	}> = [
		...(logo
			? [
					{
						assetClass: "logo" as const,
						failureCode: "brand_logo_command_failed",
					},
				]
			: []),
		...(brollPlan || studioEdits.visualBroll.length > 0
			? [
					{
						assetClass: "broll" as const,
						failureCode: "broll_command_failed",
					},
				]
			: []),
		...(musicPlan
			? [
					{
						assetClass: "music" as const,
						failureCode: "music_mix_failed",
					},
				]
			: []),
		...(sfxPlans.length > 0
			? [
					{
						assetClass: "sound_effect" as const,
						failureCode: "sound_effect_mix_failed",
					},
				]
			: []),
		...(backgroundPlan?.mode === "image"
			? [
					{
						assetClass: "background" as const,
						failureCode: "background_image_command_failed",
					},
				]
			: []),
	];
	const fallbackBackgroundPlan: BackgroundPlan | null =
		backgroundPlan?.mode === "image"
			? { mode: "color", color: backgroundPlan.color, imagePath: null }
			: backgroundPlan;

	const requestedCompositionMode = resolveEffectiveFramingMode(studioEdits);
	let plannedAudio: BoundCompositionAudioRenderRequest | null = null;
	let fallbackAudio: BoundCompositionAudioRenderRequest | null = null;
	let compositionPlan: ClipCompositionPlan | null = null;
	let fallbackCompositionPlan: ClipCompositionPlan | null = null;
	{
		const planWithAssetAvailability = (
			backgroundImage:
				| { state: "missing" | "failed" }
				| { state: "available"; ref: string },
			availability: {
				broll?: boolean;
				logo?: boolean;
				music?: boolean;
				soundEffects?: boolean;
			} = {},
		) => {
			const visualBrollAvailable = studioEdits.visualBroll.every((placement) =>
				Boolean(
					resolvedSceneAssets[
						compositionAssetRef(
							"visual_asset",
							`${placement.asset.id}:${placement.asset.fingerprint}`,
						)
					],
				),
			);
			const brollAvailable =
				availability.broll ?? (Boolean(brollPlan) || visualBrollAvailable);
			const logoAvailable = availability.logo ?? Boolean(brandLogo);
			const musicAvailable = availability.music ?? Boolean(musicPlan);
			const soundEffectsAvailable =
				availability.soundEffects ?? sfxPlans.length > 0;
			return planClipComposition({
				document: compositionDocument,
				source: {
					identity: compositionSourceIdentity,
					kind: probe.hasVideo ? "video" : "audio",
					width: probe.hasVideo ? probe.width : 0,
					height: probe.hasVideo ? probe.height : 0,
					hasAudio: probe.hasAudio,
				},
				evidence: {
					automaticLayout: automaticLayoutAnalysisForPlan
						? {
								state: "available",
								value: {
									sourceIdentity: compositionSourceIdentity,
									inputFingerprint: automaticLayoutInputFingerprint({
										sourceIdentity: compositionSourceIdentity,
										clipStartSec,
										clipEndSec,
										deletedRanges,
										engineVersion: CLIP_AUTO_LAYOUT_ENGINE,
									}),
									engineVersion: CLIP_AUTO_LAYOUT_ENGINE,
									analysis: automaticLayoutAnalysisForPlan,
								},
							}
						: { state: automaticLayoutEvidenceFailure },
					splitLayout: splitLayoutEvidenceForPlan,
					screenLayout: screenLayoutEvidenceForPlan,
				},
				assets: {
					backgroundImage,
					sceneVisuals: sceneVisualAvailability,
					sceneFonts: sceneFontAvailability,
					...(studioEdits.music.assetId || studioEdits.music.url
						? {
								music:
									musicAvailable && musicPlan?.ref
										? {
												state: "available" as const,
												ref: musicPlan.ref,
												durationSec: musicPlan.durationSec,
											}
										: { state: "failed" as const },
							}
						: {}),
					soundEffects: Object.fromEntries(
						studioEdits.sfx.map((placement) => {
							const resolved = soundEffectsAvailable
								? sfxPlans.find((candidate) => candidate.id === placement.id)
								: undefined;
							return [
								placement.id,
								resolved?.ref
									? {
											state: "available" as const,
											ref: resolved.ref,
											durationSec: resolved.durationSec,
										}
									: { state: "failed" as const },
							];
						}),
					),
					...(studioEdits.visualBroll.length > 0 && brollAvailable
						? {
								broll: {
									state: "available" as const,
									placements: studioEdits.visualBroll.map((placement) => ({
										id: placement.id,
										ref: compositionAssetRef(
											"visual_asset",
											`${placement.asset.id}:${placement.asset.fingerprint}`,
										),
										kind: "image" as const,
										startSec: placement.startSec,
										endSec: placement.endSec,
									})),
								},
							}
						: brollPlan && brollAvailable
							? {
									broll: {
										state: "available" as const,
										placements: brollPlan.cutaways.map((cutaway, index) => ({
											id: `cutaway-${index}`,
											ref: cutaway.ref,
											startSec: cutaway.window.startSec,
											endSec: cutaway.window.endSec,
										})),
									},
								}
							: userBrollUrl || brollPlan || studioEdits.visualBroll.length > 0
								? { broll: { state: "failed" as const } }
								: {}),
					...(brandLogo && logoAvailable && plannedLogoSettings
						? {
								logo: {
									state: "available" as const,
									ref: brandLogo.ref,
									settings: plannedLogoSettings,
								},
							}
						: brandLogoWasRequested
							? { logo: { state: "failed" as const } }
							: {}),
				},
				capabilities: {
					automaticSpeakerLayout: currentRenderConfig().layoutEngineEnabled,
					automaticSpeakerEngineVersion: CLIP_AUTO_LAYOUT_ENGINE,
					explicitSplitLayout: currentRenderConfig().splitEnabled,
					splitEngineVersion: "explicit-split-v1",
					screenLayout: currentRenderConfig().screenLayoutEnabled,
					screenEngineVersion: SCREEN_LAYOUT_ENGINE_VERSION,
				},
				targets: outputs.map((output) => {
					const target = aspectRatioConfig.get(output.aspectRatio)!;
					return {
						id: output.clipRenderId,
						aspectRatio: output.aspectRatio,
						width: target.width,
						height: target.height,
						outputTreatment: {
							resolution: output.resolution,
							watermark: output.watermark,
						},
					};
				}),
			});
		};
		const backgroundImageAvailability =
			needsCanvasBackground &&
			backgroundPlan?.mode === "image" &&
			backgroundPlan.imagePath &&
			studioEdits.background.imageUrl
				? {
						state: "available" as const,
						ref: compositionAssetRef(
							"background",
							studioEdits.background.imageUrl,
						),
					}
				: needsCanvasBackground && studioEdits.background.mode === "image"
					? ({ state: "failed" } as const)
					: ({ state: "missing" } as const);
		const planningStartedAtMs = currentTimeMs();
		const planned = planWithAssetAvailability(backgroundImageAvailability);
		const planningDurationMs = Math.max(
			0,
			currentTimeMs() - planningStartedAtMs,
		);
		if (planned.status === "invalid") {
			throw new WorkflowWorkerError(
				planned.error.code,
				`Clip Composition Plan rejected ${planned.error.code}`,
				"permanent",
			);
		}
		compositionResources.planVersion = planned.plan.version;
		compositionResources.planFingerprint = planned.plan.fingerprint;
		compositionResources.requestedMode = requestedCompositionMode;
		compositionResources.effectiveModes = planned.plan.targets.map(
			(target) => target.effectiveMode,
		);
		compositionResources.planningDurationMs = planningDurationMs;
		const sceneCount = planned.plan.targets.reduce(
			(count, target) => count + target.scenes.length,
			0,
		);
		const visualLayerCount = planned.plan.targets.reduce(
			(count, target) => count + target.visualLayers.length,
			0,
		);
		compositionResources.sceneCount = sceneCount;
		compositionResources.visualLayerCount = visualLayerCount;
		const compositionEvidenceDiagnostics =
			requestedCompositionMode === "auto"
				? {
						source: automaticLayoutEvidenceSource,
						version: automaticLayoutAnalysisForPlan?.version ?? null,
					}
				: requestedCompositionMode === "split" &&
						splitLayoutEvidenceForPlan.state === "available"
					? {
							source: splitLayoutEvidenceForPlan.value.source,
							version: splitLayoutEvidenceForPlan.value.engineVersion,
						}
					: requestedCompositionMode === "screen" &&
							screenLayoutEvidenceForPlan.state === "available"
						? {
								source: screenLayoutEvidenceForPlan.value.source,
								version: screenLayoutEvidenceForPlan.value.engineVersion,
							}
						: { source: null, version: null };
		log("info", "clip_composition_plan", {
			workflowRunId: run.id,
			clipId: clip.id,
			adapter: "ffmpeg",
			planVersion: planned.plan.version,
			planFingerprint: planned.plan.fingerprint,
			planFidelity: planned.plan.fidelity,
			audioScheduleFingerprint: planned.plan.audioSchedule.fingerprint,
			audioSchedule: {
				sourceAvailable: planned.plan.audioSchedule.source.available,
				musicIncluded: Boolean(planned.plan.audioSchedule.music),
				duckingWindowCount:
					planned.plan.audioSchedule.music?.ducking.windows.length ?? 0,
				soundEffectCount: planned.plan.audioSchedule.soundEffects.length,
			},
			planningDurationMs,
			requestedMode: requestedCompositionMode,
			evidenceSource: compositionEvidenceDiagnostics.source,
			evidenceVersion: compositionEvidenceDiagnostics.version,
			evidenceRequestCount: planned.plan.evidenceRequests.length,
			effectiveModes: planned.plan.targets.map(
				(target) => target.effectiveMode,
			),
			targets: planned.plan.targets.map((target) => ({
				id: target.id,
				aspectRatio: target.aspectRatio,
				canvas: target.canvas,
				scenes: target.scenes.map((scene) => ({
					startSec: scene.startSec,
					endSec: scene.endSec,
					layerKinds: scene.layers.map((layer) => layer.kind),
				})),
				visualLayerKinds: target.visualLayers.map((layer) => layer.kind),
			})),
			sceneCount,
			visualLayerCount,
			noticeCodes: planned.plan.notices.map((notice) => notice.code),
			optionalDegradationCount: planned.plan.notices.filter(
				(notice) => notice.fidelity === "degraded",
			).length,
		});
		compositionPlan = planned.plan;
		motionAnalytics = motionRenderAnalyticsMetadata(compositionDocument, {
			applyScope: "clip",
			fallbackCodes: planned.plan.notices
				.map((notice) => notice.code)
				.filter((code) => code.includes("motion")),
			renderOutcome: "completed",
		});
		for (const output of outputs) {
			motionAnalyticsByRenderId.set(output.clipRenderId, motionAnalytics);
		}
		plannedAudio = bindCompositionPlanAudioInputs(
			compileCompositionPlanAudioSchedule(compositionPlan),
			{
				music: musicPlan
					? { sourceRef: musicPlan.ref, path: musicPlan.path }
					: null,
				soundEffects: sfxPlans.map((effect) => ({
					id: effect.id,
					sourceRef: effect.ref,
					path: effect.path,
				})),
			},
		);
		for (const output of outputs) {
			const target = compositionPlan.targets.find(
				(candidate) => candidate.id === output.clipRenderId,
			);
			if (!target) {
				throw new WorkflowWorkerError(
					"invalid_clip_composition_plan",
					`Clip Composition Plan target missing for ${output.clipRenderId}`,
					"permanent",
				);
			}
			const assContent = compileCompositionPlanCaptions(
				compositionPlan,
				output.clipRenderId,
			);
			if (assContent.length > 0) {
				const assPath = join(
					tempDir,
					`clip-${clip.id}-${output.aspectRatio.replace(":", "x")}.ass`,
				);
				await currentRenderAdapters().workspace.writeFile(
					assPath,
					assContent,
					"utf-8",
				);
				output.subtitlePath = assPath;
			}
		}
		if (optionalCommandAssets.length > 0) {
			const fallbackPlan = planWithAssetAvailability(
				backgroundImageAvailability.state === "available"
					? { state: "failed" }
					: backgroundImageAvailability,
				{
					broll: false,
					logo: false,
					music: false,
					soundEffects: false,
				},
			);
			if (fallbackPlan.status !== "invalid") {
				fallbackCompositionPlan = fallbackPlan.plan;
				fallbackAudio = bindCompositionPlanAudioInputs(
					compileCompositionPlanAudioSchedule(fallbackPlan.plan),
					{},
				);
			}
		}
	}

	if (!probe.hasVideo) {
		if (!compositionPlan || !plannedAudio) {
			throw new WorkflowWorkerError(
				"clip_composition_plan_missing",
				"Audio-only render requires a Clip Composition Plan",
				"permanent",
			);
		}
		for (const output of outputs) {
			try {
				const compositionForOutput = {
					plan: compositionPlan,
					targetId: output.clipRenderId,
				};
				const fallbackCompositionForOutput =
					fallbackCompositionPlan && fallbackAudio
						? {
								plan: fallbackCompositionPlan,
								targetId: output.clipRenderId,
							}
						: null;
				const audioOptionalAssets = optionalCommandAssets.filter(
					({ assetClass }) =>
						assetClass === "logo" ||
						assetClass === "music" ||
						assetClass === "sound_effect",
				);
				const ffmpegArgs = currentRenderAdapters().composition.compileCommand({
					sourcePath,
					outputPath: output.outputPath,
					startSec: clipStartSec,
					endSec: clipEndSec,
					audio: plannedAudio,
					cutPlan,
					source: probe,
					plan: compositionForOutput.plan,
					targetId: compositionForOutput.targetId,
					encoder: { preset: x264Preset(), crf: x264Crf() },
					assets: {
						subtitlePath: output.subtitlePath ?? null,
						logo: logo,
						scenes: resolvedSceneAssets,
						fonts: resolvedSceneFonts,
					},
				});

				const encodeStartedAtMs = currentTimeMs();
				const commandMode = await executeRenderCommandWithOptionalFallback({
					primaryArgs: ffmpegArgs,
					fallbackArgs:
						fallbackCompositionForOutput &&
						fallbackAudio &&
						audioOptionalAssets.length > 0
							? () =>
									currentRenderAdapters().composition.compileCommand({
										sourcePath,
										outputPath: output.outputPath,
										startSec: clipStartSec,
										endSec: clipEndSec,
										audio: fallbackAudio,
										cutPlan,
										source: probe,
										plan: fallbackCompositionForOutput.plan,
										targetId: fallbackCompositionForOutput.targetId,
										encoder: { preset: x264Preset(), crf: x264Crf() },
										assets: {
											subtitlePath: output.subtitlePath ?? null,
											logo: null,
											scenes: resolvedSceneAssets,
											fonts: resolvedSceneFonts,
										},
									})
							: undefined,
					optionalAssets: audioOptionalAssets,
					context: {
						workflowRunId: run.id,
						clipId: clip.id,
						clipRenderId: output.clipRenderId,
					},
					recordCommand: recordCompositionCommand,
					recordSourceDecodeCompleted: recordCompositionSourceDecodeCompleted,
					recordResourceSample: recordCompositionResourceSample,
				});
				const encodeDurationMs =
					recordCompositionEncodeCompleted(encodeStartedAtMs);
				// Upload runs in the bounded background queue (overlaps the next
				// clip's work). The stale-discard/`persisted` counting and the
				// upload-failure variant marking both live in `scheduleUpload`;
				// this catch now only ever sees ENCODE failures.
				scheduleUpload(output, {
					clipDurationSec:
						commandMode === "fallback"
							? (fallbackCompositionForOutput?.plan.editedDurationSec ??
								compositionPlan.editedDurationSec)
							: compositionPlan.editedDurationSec,
					encodeMs: encodeDurationMs,
					motionAnalytics,
				});
			} catch (error) {
				rethrowWorkflowAttemptLost(error);
				rethrowRenderCancellation(error);
				const errorCode =
					error instanceof WorkflowFailure
						? error.code
						: "ffmpeg_render_failed";

				await currentRenderAdapters().clip.failClipRenderVariant(
					attempt,
					output.clipRenderId,
					errorCode,
					error instanceof WorkflowFailure ? error.disposition : "retryable",
					{ ...motionAnalytics, renderOutcome: "failed" },
				);

				log("error", "clip_render_variant_failed", {
					workflowRunId: run.id,
					clipId: output.clipId,
					clipRenderId: output.clipRenderId,
					clipIndex: output.clipIndex,
					aspectRatio: output.aspectRatio,
					code: errorCode,
					message:
						error instanceof Error ? error.message : "Unknown render error",
				});
			}
		}
	} else {
		// Every video output is compiled from the shared composition plan.
		const plan = brollPlan;
		const brollCredits =
			plan && plan.credits.length > 0 ? JSON.stringify(plan.credits) : null;
		for (const output of outputs) {
			if (!compositionPlan || !plannedAudio) {
				throw new WorkflowWorkerError(
					"clip_composition_plan_missing",
					"Video render requires a Clip Composition Plan",
					"permanent",
				);
			}
			const compositionForOutput = {
				plan: compositionPlan,
				targetId: output.clipRenderId,
			};
			const optionalAssetFallbackPlan =
				fallbackCompositionPlan ?? compositionPlan;
			const fallbackCompositionForOutput = {
				plan: optionalAssetFallbackPlan,
				targetId: output.clipRenderId,
			};
			try {
				const resolvedBrollAssets = {
					...Object.fromEntries(
						plan?.cutaways.map((cutaway) => [cutaway.ref, cutaway.path]) ?? [],
					),
					...Object.fromEntries(
						studioEdits.visualBroll.flatMap((placement) => {
							const ref = compositionAssetRef(
								"visual_asset",
								`${placement.asset.id}:${placement.asset.fingerprint}`,
							);
							const asset = resolvedSceneAssets[ref];
							return asset ? [[ref, asset.path] as const] : [];
						}),
					),
				};
				const ffmpegArgs = currentRenderAdapters().composition.compileCommand({
					sourcePath,
					outputPath: output.outputPath,
					startSec: clipStartSec,
					endSec: clipEndSec,
					source: probe,
					plan: compositionForOutput.plan,
					targetId: compositionForOutput.targetId,
					audio: plannedAudio,
					cutPlan,
					encoder: { preset: x264Preset(), crf: x264Crf() },
					assets: {
						broll: resolvedBrollAssets,
						subtitlePath: output.subtitlePath ?? null,
						logo,
						background: backgroundPlan,
						scenes: resolvedSceneAssets,
						fonts: resolvedSceneFonts,
					},
				});
				const encodeStartedAtMs = currentTimeMs();
				const commandMode = await executeRenderCommandWithOptionalFallback({
					primaryArgs: ffmpegArgs,
					fallbackArgs:
						optionalCommandAssets.length > 0
							? () =>
									currentRenderAdapters().composition.compileCommand({
										sourcePath,
										outputPath: output.outputPath,
										startSec: clipStartSec,
										endSec: clipEndSec,
										audio: fallbackAudio ?? plannedAudio,
										cutPlan,
										source: probe,
										plan: fallbackCompositionForOutput.plan,
										targetId: fallbackCompositionForOutput.targetId,
										encoder: { preset: x264Preset(), crf: x264Crf() },
										assets: {
											subtitlePath: output.subtitlePath ?? null,
											logo: null,
											background: fallbackBackgroundPlan,
											scenes: resolvedSceneAssets,
											fonts: resolvedSceneFonts,
										},
									})
							: undefined,
					optionalAssets: optionalCommandAssets,
					context: {
						workflowRunId: run.id,
						clipId: clip.id,
						clipRenderId: output.clipRenderId,
					},
					recordCommand: recordCompositionCommand,
					recordSourceDecodeCompleted: recordCompositionSourceDecodeCompleted,
					recordResourceSample: recordCompositionResourceSample,
				});
				const encodeDurationMs =
					recordCompositionEncodeCompleted(encodeStartedAtMs);
				// Bounded background upload — see `scheduleUpload`. This catch
				// now only ever sees encode/build failures.
				scheduleUpload(output, {
					clipDurationSec:
						commandMode === "fallback"
							? optionalAssetFallbackPlan.editedDurationSec
							: compositionPlan.editedDurationSec,
					brollCredits: commandMode === "primary" ? brollCredits : null,
					encodeMs: encodeDurationMs,
					motionAnalytics,
				});
			} catch (error) {
				rethrowWorkflowAttemptLost(error);
				rethrowRenderCancellation(error);
				const contractFailure = compositionContractFailure(error);
				const renderFailure =
					error instanceof WorkflowFailure ? error : contractFailure;
				const errorCode = renderFailure
					? renderFailure.code
					: "ffmpeg_render_failed";
				await currentRenderAdapters().clip.failClipRenderVariant(
					attempt,
					output.clipRenderId,
					errorCode,
					renderFailure ? renderFailure.disposition : "retryable",
					{ ...motionAnalytics, renderOutcome: "failed" },
				);
				log("error", "clip_render_variant_failed", {
					workflowRunId: run.id,
					clipId: output.clipId,
					clipRenderId: output.clipRenderId,
					clipIndex: output.clipIndex,
					aspectRatio: output.aspectRatio,
					code: errorCode,
					message:
						error instanceof Error ? error.message : "Unknown render error",
				});
			}
		}
	}

	const finalResourceMeasurement = measureCompositionResourceSafely();
	if (finalResourceMeasurement) {
		compositionResources.peakRssScope = finalResourceMeasurement.scope;
		recordCompositionResourceSample(finalResourceMeasurement.rssBytes);
	}
	log("info", "clip_composition_resources", {
		workflowRunId: run.id,
		clipId: clip.id,
		planVersion: compositionResources.planVersion,
		planFingerprint: compositionResources.planFingerprint,
		requestedMode: compositionResources.requestedMode,
		effectiveModes: compositionResources.effectiveModes,
		sceneCount: compositionResources.sceneCount,
		visualLayerCount: compositionResources.visualLayerCount,
		commandGrouping: "independent",
		targetCount: outputs.length,
		analysisRequestCount: compositionResources.analysisRequestKeys.size,
		analysisRequestKeys: [...compositionResources.analysisRequestKeys].sort(),
		analysisExecutionCount: compositionResources.analysisExecutionCount,
		detectorExecutionCount: compositionResources.detectorExecutionCount,
		extractedSegmentCount: compositionResources.extractedSegmentCount,
		commandCount: compositionResources.commandCount,
		sourceDecodeCount: compositionResources.sourceDecodeCount,
		commandBytes: compositionResources.commandBytes,
		planningDurationMs: compositionResources.planningDurationMs,
		encodeDurationMs: compositionResources.encodeDurationMs,
		peakRssBytes: compositionResources.peakRssBytes,
		peakRssScope: compositionResources.peakRssScope,
	});
}

async function executeClipRenderAttemptInScratch(params: {
	run: WorkflowRunJob;
	signal: AbortSignal;
	attempt: ClipRenderingWorkflowAttempt;
	lifecycle: ClipRenderAttemptLifecycle;
	workSetVariantIds: readonly string[];
	abortAttempt: (error: WorkflowAttemptLost) => void;
	frozenState: FrozenRenderingState;
	pendingRenders: FrozenRenderingState["pendingRenders"];
	applyWatermark: boolean;
	runStartedAtMs: number;
	tempDir: string;
	touchedOptionalAssetClasses: Set<OptionalAssetClass>;
}): Promise<RenderWorkSetOutcome> {
	const {
		run,
		signal,
		attempt,
		lifecycle,
		workSetVariantIds,
		abortAttempt,
		frozenState,
		pendingRenders,
		applyWatermark,
		runStartedAtMs,
		tempDir,
		touchedOptionalAssetClasses,
	} = params;
	// Captured outside the try so `finally` can settle in-flight background
	// uploads before deleting tempDir (their source files live there).
	let uploadQueueRef: { drain: () => Promise<void> } | null = null;
	let settlementStarted = false;
	const motionAnalyticsByRenderId = new Map<
		string,
		MotionRenderAnalyticsMetadata
	>();

	try {
		// Freeze the document-derived baseline before any source I/O. Source
		// resolution and probing can fail before composition planning, but those
		// failures still belong in motion outcome analytics. Planner notices
		// enrich this baseline later when planning is reached.
		for (const render of pendingRenders) {
			const storedClip = render.clipSnapshot ?? render.clip;
			try {
				const editorDocument = decodeClipEditorDocumentFromStorage(
					storedClip,
					frozenState.sourceDurationSeconds,
				);
				motionAnalyticsByRenderId.set(
					render.id,
					motionRenderAnalyticsMetadata(editorDocument, {
						applyScope: "clip",
						renderOutcome: "completed",
					}),
				);
			} catch {
				// Keep document corruption on its existing post-source failure path.
				// There is no trustworthy motion payload to classify here.
			}
		}

		// `sourcePath` is what every ffmpeg builder receives as input: a presigned
		// URL in ranged mode (see RENDER_SOURCE_URL_TTL_SEC above), or the local
		// download in fallback/download mode. All builders seek with -ss before
		// -i, so both forms behave identically apart from what gets transferred.
		const { sourcePath, probe } = await resolveRequiredSource({
			sourceStorageKey: frozenState.sourceStorageKey,
			tempDir,
			attempt,
		});

		log("info", "clip_rendering_source_probed", {
			workflowRunId: run.id,
			width: probe.width,
			height: probe.height,
			hasVideo: probe.hasVideo,
			hasAudio: probe.hasAudio,
		});

		let brandLogo: LogoOverlay | null = null;
		let brandLogoWasRequested = false;
		let rawBrandSnapshot: unknown = null;
		if (frozenState.brandSnapshot.status === "available") {
			rawBrandSnapshot = frozenState.brandSnapshot.value;
		} else {
			diagnoseOptionalAssetFallback({
				assetClass: "logo",
				phase: "lookup",
				failureCode: "brand_snapshot_unavailable",
				context: { workflowRunId: run.id, projectId: run.projectId },
			});
		}
		if (rawBrandSnapshot) {
			try {
				const snapshot = brandTemplateSnapshotSchema.parse(rawBrandSnapshot);
				if (snapshot.logoStorageKey) {
					brandLogoWasRequested = true;
					touchedOptionalAssetClasses.add("logo");
					const logoExt = extname(snapshot.logoStorageKey) || ".png";
					const logoPath = join(tempDir, `brand-logo${logoExt}`);
					try {
						await currentRenderAdapters().storage.downloadObjectToFile({
							key: snapshot.logoStorageKey,
							filePath: logoPath,
							signal: renderStorageSignal(),
						});
						const decodable =
							await currentRenderAdapters().optionalAssets.validateOptionalMedia(
								logoPath,
								"image",
							);
						if (decodable) {
							brandLogo = {
								filePath: logoPath,
								ref: compositionAssetRef("logo", snapshot.logoStorageKey),
								position: snapshot.logoPosition,
								opacity: snapshot.logoOpacity,
								scalePct: snapshot.logoScalePct,
							};
						} else {
							diagnoseOptionalAssetFallback({
								assetClass: "logo",
								phase: "decode",
								failureCode: "brand_logo_invalid",
								context: {
									workflowRunId: run.id,
									projectId: run.projectId,
								},
							});
						}
					} catch (error) {
						rethrowRenderControlFlow(error);
						diagnoseOptionalAssetFallback({
							assetClass: "logo",
							phase: "download",
							failureCode: "brand_logo_download_failed",
							context: {
								workflowRunId: run.id,
								projectId: run.projectId,
							},
						});
					}
				}
			} catch (error) {
				rethrowRenderControlFlow(error);
				diagnoseOptionalAssetFallback({
					assetClass: "logo",
					phase: "parse",
					failureCode: "brand_snapshot_invalid",
					context: { workflowRunId: run.id, projectId: run.projectId },
				});
			}
		}

		// A clip may now have several immutable export revisions queued at once.
		// Group by export (or by clip for the ordinary mutable latest-render row)
		// so aspect variants from different frozen snapshots can never be encoded
		// together.
		const rendersByClipId = new Map<string, typeof pendingRenders>();

		for (const render of pendingRenders) {
			const groupKey = render.exportVariant
				? `export:${render.exportVariant.exportId}`
				: `latest:${render.clipId}`;
			const existing = rendersByClipId.get(groupKey) ?? [];
			existing.push(render);
			rendersByClipId.set(groupKey, existing);
		}

		const clipGroups = [...rendersByClipId.values()].sort(
			(left, right) => left[0]!.clip.index - right[0]!.clip.index,
		);

		await currentRenderAdapters().project.reportProgress(attempt, 10);

		let renderedVariantCount = 0;

		// Uploads run in a bounded background queue so the next clip's
		// detection/encode overlaps the previous clip's R2 upload (the dominant
		// per-clip wall-time cost on a slow uplink). Every task owns its own
		// error handling — an upload failure marks ITS variant failed and never
		// fails the run — and `renderedVariantCount` is only read after
		// `uploadQueue.drain()` below, so the all-failed check and run
		// completion always see the settled truth.
		const uploadQueue = createBoundedTaskQueue(uploadConcurrency(), signal);
		uploadQueueRef = uploadQueue;
		const scheduleUpload = (
			output: PendingRenderOutput,
			params: {
				clipDurationSec: number;
				brollCredits?: string | null;
				encodeMs: number;
				motionAnalytics: MotionRenderAnalyticsMetadata;
			},
		) => {
			uploadQueue.schedule(async () => {
				try {
					const persisted = await uploadRenderedOutput({
						attempt,
						workflowRunId: run.id,
						projectId: run.projectId,
						output,
						clipDurationSec: params.clipDurationSec,
						brollCredits: params.brollCredits,
						encodeMs: params.encodeMs,
						motionAnalytics: params.motionAnalytics,
					});
					if (persisted) renderedVariantCount += 1;
				} catch (error) {
					if (error instanceof WorkflowAttemptLost) {
						abortAttempt(error);
						return;
					}
					rethrowRenderCancellation(error);
					const errorCode =
						error instanceof WorkflowFailure
							? error.code
							: "render_upload_failed";
					const disposition =
						error instanceof WorkflowFailure ? error.disposition : "retryable";
					await currentRenderAdapters().clip.failClipRenderVariant(
						attempt,
						output.clipRenderId,
						errorCode,
						disposition,
						{ ...params.motionAnalytics, renderOutcome: "failed" },
					);
					const persistenceFailure =
						error instanceof RenderPersistenceFailure ? error : null;
					log("error", "clip_render_variant_failed", {
						workflowRunId: run.id,
						attemptId: attempt.attemptId,
						clipId: output.clipId,
						clipRenderId: output.clipRenderId,
						clipIndex: output.clipIndex,
						aspectRatio: output.aspectRatio,
						code: errorCode,
						failureCode: errorCode,
						disposition,
						phase: persistenceFailure ? "persistence" : "upload",
						operation: persistenceFailure
							? "complete_clip_render_variant"
							: "storage_put",
						...(persistenceFailure
							? { cleanupResult: persistenceFailure.cleanupResult }
							: {}),
						message:
							error instanceof Error ? error.message : "Unknown render error",
					});
				}
			});
		};

		for (
			let clipGroupIndex = 0;
			clipGroupIndex < clipGroups.length;
			clipGroupIndex++
		) {
			signal?.throwIfAborted();
			const renderGroup = clipGroups[clipGroupIndex]!;
			try {
				await renderClipGroup({
					run,
					attempt,
					renderGroup,
					frozenState,
					probe,
					sourcePath,
					tempDir,
					brandLogo,
					brandLogoWasRequested,
					touchedOptionalAssetClasses,
					motionAnalyticsByRenderId,
					applyWatermark,
					scheduleUpload,
				});
			} catch (error) {
				rethrowRenderControlFlow(error);
				// Any delivery already scheduled must settle before failure writes.
				await uploadQueue.drain();
				signal.throwIfAborted();
				const failure = workflowFailureFromUnknown(error);
				for (const render of renderGroup) {
					await currentRenderAdapters().clip.markClipRenderVariantRendering(
						attempt,
						render.id,
					);
					const motionAnalytics = motionAnalyticsByRenderId.get(render.id);
					await currentRenderAdapters().clip.failClipRenderVariant(
						attempt,
						render.id,
						failure.code,
						failure.disposition,
						motionAnalytics
							? { ...motionAnalytics, renderOutcome: "failed" }
							: undefined,
					);
				}
				log("error", "clip_render_group_failed", {
					workflowRunId: run.id,
					clipId: renderGroup[0]!.clipId,
					failureCode: failure.code,
					disposition: failure.disposition,
				});
			}

			const progress =
				10 + Math.round(((clipGroupIndex + 1) / clipGroups.length) * 80);
			await currentRenderAdapters().project.reportProgress(attempt, progress);
		}

		// Settle every in-flight upload before reading `renderedVariantCount` —
		// the all-failed check and run completion below must see the final
		// truth, and render settlement must never race a
		// completeClipRenderVariant write.
		const drainStartedAtMs = currentTimeMs();
		await uploadQueue.drain();
		signal.throwIfAborted();
		log("info", "clip_render_upload_drain", {
			workflowRunId: run.id,
			projectId: run.projectId,
			scheduledUploads: uploadQueue.scheduledCount(),
			drainMs: currentTimeMs() - drainStartedAtMs,
		});

		settlementStarted = true;
		const outcome = await lifecycle.settleRenderWorkSet(attempt);

		log("info", "clip_rendering_run_completed", {
			workflowRunId: run.id,
			projectId: run.projectId,
			totalClipGroups: clipGroups.length,
			totalVariantCount: pendingRenders.length,
			renderedVariantCount,
			failedVariantCount: pendingRenders.length - renderedVariantCount,
			totalMs: currentTimeMs() - runStartedAtMs,
			sourceMode: isHttpSource(sourcePath) ? "ranged" : "download",
			encoder: "libx264",
			preset: x264Preset(),
			status: outcome.status,
			supersededVariantCount: outcome.superseded,
			followUpWorkflowRunId: outcome.followUpWorkflowRunId,
		});
		return outcome;
	} catch (error) {
		if (error instanceof WorkflowAttemptLost) {
			abortAttempt(error);
			throw error;
		}
		rethrowRenderCancellation(error);
		if (settlementStarted) throw error;
		if (uploadQueueRef) {
			await uploadQueueRef.drain();
		}
		const failure = workflowFailureFromUnknown(error);
		const code = failure.code;

		const message =
			error instanceof Error ? error.message : "Unknown worker error";
		for (const clipRenderId of workSetVariantIds) {
			await currentRenderAdapters().clip.markClipRenderVariantRendering(
				attempt,
				clipRenderId,
			);
			await currentRenderAdapters().clip.failClipRenderVariant(
				attempt,
				clipRenderId,
				code,
				failure.disposition,
				motionAnalyticsByRenderId.has(clipRenderId)
					? {
							...motionAnalyticsByRenderId.get(clipRenderId)!,
							renderOutcome: "failed",
						}
					: undefined,
			);
		}

		log("error", "clip_rendering_run_failed", {
			workflowRunId: run.id,
			projectId: run.projectId,
			code,
			message,
		});
		const outcome = await lifecycle.settleRenderWorkSet(attempt);
		return outcome;
	} finally {
		// A failure path can reach here with uploads still in flight (their
		// output files live in tempDir) — settle them before deleting it, so a
		// late-succeeding upload can't read a half-deleted file. Idempotent on
		// the success path (already drained above). Never let a drain error
		// block cleanup.
		if (uploadQueueRef) await uploadQueueRef.drain().catch(() => {});
	}
}
