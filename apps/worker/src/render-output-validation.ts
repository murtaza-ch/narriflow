import { stat } from "node:fs/promises";
import type { ClipCompositionPlan } from "@narriflow/composition-plan";
import { WorkflowFailure } from "@narriflow/services";
import {
	standardFrameRate,
	type FrameRate,
	type MediaFacts,
} from "@narriflow/validators";
import type { OmittedGlyph, SkippedEmoji } from "./caption-glyphs";
import {
	OUTPUT_PIXEL_FORMAT,
	rendersConvertedSdr,
	SDR_OUTPUT_COLOR,
	type BoundCompositionAudioRenderRequest,
} from "./composition-ffmpeg-adapter";
import {
	exceedsFullScale,
	mixPeakMeasureDeadlineMs,
	type MixPeakResult,
} from "./render-mix-peak";
import type {
	WorkerMediaInspection,
	WorkerProcessModule,
} from "./worker-process";

type ColorTags = Pick<
	MediaFacts["videos"][number],
	"colorRange" | "colorSpace" | "colorTransfer" | "colorPrimaries"
>;

/** Color tags are asserted only where the pipeline writes them. A converted
 * SDR render (HDR to SDR, ticket 07) writes exact BT.709 tags. Every other
 * render leaves the tags the filter graph happens to carry: partial, absent or
 * rewritten by an RGB overlay stage are all valid. It must only never present
 * itself as HDR, unless that is what its source already said. */
export type RenderColorExpectation =
	| { mode: "asserted"; tags: Readonly<ColorTags> }
	| { mode: "passthrough"; source: Partial<ColorTags> };

const HDR_TAG_VALUES: Readonly<Record<keyof ColorTags, readonly string[]>> = {
	colorRange: [],
	colorSpace: ["bt2020nc", "bt2020c", "ictcp"],
	colorTransfer: ["smpte2084", "arib-std-b67"],
	colorPrimaries: ["bt2020"],
};

export function passthroughColor(
	source: Partial<ColorTags> | undefined,
): RenderColorExpectation {
	return {
		mode: "passthrough",
		source: {
			colorRange: source?.colorRange ?? null,
			colorSpace: source?.colorSpace ?? null,
			colorTransfer: source?.colorTransfer ?? null,
			colorPrimaries: source?.colorPrimaries ?? null,
		},
	};
}

/** Failures that say the file is incomplete or unreadable, which a fresh
 * encode may fix. Any other code is a mismatch against the plan or the
 * pipeline's own contract; the same inputs fail the same way. */
const TRANSIENT_OUTPUT_CODES: ReadonlySet<string> = new Set([
	"output_missing",
	"output_file_empty_or_too_small",
	"output_probe_failed",
	"output_probe_facts_missing",
	"output_video_stream_unreadable",
	"output_video_stream_missing_or_extra",
	"output_decode_failed",
	"output_video_timestamps_invalid",
	"output_video_duration_mismatch",
	"output_video_frame_count_mismatch",
	"output_video_header_duration_mismatch",
	"output_audio_timestamps_invalid",
	"output_audio_duration_mismatch",
	"output_container_duration_mismatch",
]);

export interface RenderOutputExpectation {
	durationSec: number;
	width: number;
	height: number;
	frameRate: FrameRate;
	sampleAspectRatio: FrameRate;
	/** Inserted-scene concat preserves its authored variable frame spacing. */
	variableFrameSpacing?: boolean;
	audio: { sampleRate?: number; channels?: number } | null;
	color: RenderColorExpectation;
}

export interface DecodedStreamFacts {
	frames: number;
	startSec: number;
	endSec: number;
	durationSec: number;
	maxGapSec: number;
	monotonic: boolean;
}

export interface ValidatedRenderResult {
	durationSec: number;
	sizeBytes: number;
	media: MediaFacts;
	decoded: { video: DecodedStreamFacts; audio: DecodedStreamFacts | null };
	mixPeak: MixPeakResult | null;
	captionGlyphsOmitted: readonly OmittedGlyph[];
	captionEmojiSkipped: readonly SkippedEmoji[];
	diagnosticCodes: string[];
}

export class RenderOutputInvalid extends WorkflowFailure {
	constructor(
		readonly diagnosticCodes: string[],
		readonly facts: Record<string, unknown>,
	) {
		// An output cannot establish that an immutable source is invalid. That
		// requires a refreshed content-bound probe and repeat local reproduction.
		// Only an incomplete or unreadable file is worth another encode.
		super(
			"render_output_invalid",
			diagnosticCodes.every((code) => TRANSIENT_OUTPUT_CODES.has(code))
				? "retryable"
				: "permanent",
			`Rendered media failed validation: ${diagnosticCodes.join(", ")}`,
		);
		this.name = "RenderOutputInvalid";
	}
}

/** Same plan and bound schedule used by the compiler, shared with the golden
 * runner. No new delivery rate/channel standard is imposed on source audio.
 * Mixed assets negotiate their format in FFmpeg; exact source facts apply to
 * the single-source path, while all paths require a valid measured AAC format. */
export function compositionOutputExpectation(input: {
	plan: ClipCompositionPlan;
	targetId: string;
	source: WorkerMediaInspection;
	audio: BoundCompositionAudioRenderRequest;
	hdrAssets?: boolean;
}): RenderOutputExpectation {
	const target = input.plan.targets.find(
		(target) => target.id === input.targetId,
	);
	if (!target) throw new Error("clip_composition_target_missing");
	const treatment = target.visualLayers.find(
		(layer) => layer.kind === "output-treatment",
	);
	const scale =
		treatment?.kind === "output-treatment" && treatment.resolution === "720p"
			? 2 / 3
			: 1;
	const sourceVideo = input.source.facts?.videos[0];
	const sourceAudio = input.source.facts?.audios[0];
	const sceneAudio = target.scenes.some((scene) =>
		scene.layers.some((layer) => layer.kind === "inserted-scene"),
	);
	const mixed =
		Boolean(input.audio.music) ||
		input.audio.soundEffects.length > 0 ||
		input.audio.censors.some((censor) => censor.treatment === "beep") ||
		sceneAudio;
	const hasAudio = input.audio.source.available || mixed;
	const converted = rendersConvertedSdr(input.source, Boolean(input.hdrAssets));
	return {
		durationSec: input.plan.editedDurationSec,
		width: Math.trunc((target.canvas.width * scale) / 2) * 2,
		height: Math.trunc((target.canvas.height * scale) / 2) * 2,
		frameRate:
			target.effectiveMode === "audiogram"
				? { numerator: 25, denominator: 1 }
				: (input.source.videoClock?.constantRate ??
					sourceVideo?.rFrameRate ??
					standardFrameRate(input.source.fps) ?? {
						numerator: 30,
						denominator: 1,
					}),
		sampleAspectRatio: { numerator: 1, denominator: 1 },
		variableFrameSpacing: sceneAudio,
		audio: hasAudio
			? {
					...(!mixed && sourceAudio?.sampleRate
						? { sampleRate: sourceAudio.sampleRate }
						: {}),
					...(!mixed && sourceAudio?.channels
						? { channels: sourceAudio.channels }
						: {}),
				}
			: null,
		color: converted
			? { mode: "asserted", tags: SDR_OUTPUT_COLOR }
			: passthroughColor(sourceVideo),
	};
}

/** Decode every frame without scaling, retiming or re-encoding the artifact.
 * wrapped_avframe avoids copying/checksumming raw video pixels. framecrc's
 * packet clock reports decoded frame PTS/duration, including AAC skip samples
 * applied by the decoder. A bounded stdout and deadline cap the scan. */
export function renderOutputDecodeArgs(path: string): string[] {
	return [
		"-nostdin",
		"-v",
		"error",
		"-xerror",
		"-err_detect",
		"explode",
		"-copyts",
		"-i",
		path,
		"-map",
		"0:v:0",
		"-map",
		"0:a:0?",
		"-fps_mode",
		"passthrough",
		"-enc_time_base:v",
		"demux",
		"-c:v",
		"wrapped_avframe",
		"-c:a",
		"pcm_s16le",
		"-f",
		"framecrc",
		"-",
	];
}

function decodedStreams(stdout: string): ValidatedRenderResult["decoded"] {
	const clocks = new Map<number, number>();
	const kinds = new Map<number, string>();
	const streams = new Map<number, DecodedStreamFacts>();
	const previous = new Map<number, number>();
	for (const line of stdout.split("\n")) {
		const clock = /^#tb (\d+): (\d+)\/(\d+)$/.exec(line);
		if (clock)
			clocks.set(Number(clock[1]), Number(clock[2]) / Number(clock[3]));
		const kind = /^#media_type (\d+): (video|audio)$/.exec(line);
		if (kind) kinds.set(Number(kind[1]), kind[2]!);
		if (!line || line.startsWith("#")) continue;
		const fields = line.split(",");
		const [index, dts, pts, duration, size] = fields.slice(0, 5).map(Number);
		const clockSec = clocks.get(index!);
		if (
			fields.length < 6 ||
			!clockSec ||
			![index, dts, pts, duration, size].every(Number.isFinite) ||
			duration! <= 0 ||
			size! <= 0
		)
			throw new Error("invalid decoded frame record");
		const startSec = pts! * clockSec;
		const endSec = startSec + duration! * clockSec;
		const stream = streams.get(index!);
		if (!stream)
			streams.set(index!, {
				frames: 1,
				startSec,
				endSec,
				durationSec: endSec - startSec,
				maxGapSec: 0,
				monotonic: true,
			});
		else {
			stream.monotonic &&= startSec > previous.get(index!)!;
			stream.maxGapSec = Math.max(stream.maxGapSec, startSec - stream.endSec);
			stream.frames++;
			stream.endSec = Math.max(stream.endSec, endSec);
			stream.durationSec = stream.endSec - stream.startSec;
		}
		previous.set(index!, startSec);
	}
	const get = (kind: string) =>
		[...streams].find(([index]) => kinds.get(index) === kind)?.[1];
	const video = get("video");
	if (!video) throw new Error("no decoded video frames");
	return { video, audio: get("audio") ?? null };
}

function equalRate(actual: FrameRate | null, expected: FrameRate): boolean {
	return (
		actual !== null &&
		actual.numerator * expected.denominator ===
			expected.numerator * actual.denominator
	);
}

/**
 * ffprobe reports avg_frame_rate as frames / (last pts - first pts). That span
 * omits the final frame's duration, so a constant-rate file of N frames reads
 * N/(N-1) times its real rate (958 frames at 30000/1001 report 30.0016). Accept
 * exactly that structural error; the decoded frame count, duration and spacing
 * checks below prove the clock is constant.
 */
function averageRateMatches(
	actual: FrameRate | null,
	expected: FrameRate,
	frameCount: number | null,
): boolean {
	if (actual === null || actual.denominator === 0) return false;
	if (equalRate(actual, expected)) return true;
	const ratio =
		(actual.numerator * expected.denominator) /
		(actual.denominator * expected.numerator);
	// The omitted final frame can only make the reported average higher, by at
	// most N/(N-1); a lower average is a real clock error.
	const ceiling =
		frameCount !== null && frameCount > 1 ? frameCount / (frameCount - 1) : 1;
	return ratio >= 1 - 1e-9 && ratio <= ceiling + 1e-9;
}

function healthOrControl(error: unknown, signal: AbortSignal): void {
	signal.throwIfAborted();
	if (
		error instanceof WorkflowFailure &&
		![
			"source_media_invalid",
			"worker_command_input_invalid",
			"worker_command_failed",
			"worker_command_timeout",
		].includes(error.code)
	)
		throw error;
}

export async function validateRenderOutput(input: {
	path: string;
	expected: RenderOutputExpectation;
	workerProcess: WorkerProcessModule;
	signal: AbortSignal;
	statFile?: typeof stat;
	mixPeak?: MixPeakResult | null;
	captionGlyphsOmitted?: readonly OmittedGlyph[];
	captionEmojiSkipped?: readonly SkippedEmoji[];
	diagnose?(event: {
		accepted: boolean;
		diagnosticCodes: string[];
		facts: Record<string, unknown>;
	}): void;
}): Promise<ValidatedRenderResult> {
	const facts: Record<string, unknown> = {
		expected: input.expected,
		mixPeak: input.mixPeak ?? null,
		captionGlyphsOmitted: input.captionGlyphsOmitted ?? [],
		captionEmojiSkipped: input.captionEmojiSkipped ?? [],
	};
	const reject = (codes: string[]): never => {
		input.diagnose?.({ accepted: false, diagnosticCodes: codes, facts });
		throw new RenderOutputInvalid(codes, facts);
	};
	input.signal.throwIfAborted();
	let file;
	try {
		file = await (input.statFile ?? stat)(input.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return reject(["output_missing"]);
	}
	facts.sizeBytes = Number(file.size);
	if (!file.isFile() || file.size < 1024)
		return reject(["output_file_empty_or_too_small"]);
	let probe: WorkerMediaInspection;
	try {
		probe = await input.workerProcess.inspectMedia({
			sourcePath: input.path,
			analyzeVideoClock: false,
			signal: input.signal,
			deadlineMs: 30_000,
		});
	} catch (error) {
		healthOrControl(error, input.signal);
		facts.processFailureCode =
			error instanceof WorkflowFailure ? error.code : null;
		return reject(["output_probe_failed"]);
	}
	const media = probe.facts;
	facts.media = media;
	if (!media) return reject(["output_probe_facts_missing"]);
	const video = media.videos[0];
	const audio = media.audios[0];
	const expected = input.expected;
	const codes: string[] = [];
	if (!media.format.name?.split(",").includes("mp4"))
		codes.push("output_container_invalid");
	if (!video || media.videos.length !== 1 || media.attachedPictureCount !== 0)
		return reject(["output_video_stream_missing_or_extra"]);
	// ffprobe spells full-range planar 8-bit 4:2:0 as yuvj420p. It is the
	// same chroma/bit-depth contract; keep that measured spelling and range.
	if (video.pixelFormat === null || video.profile === null)
		codes.push("output_video_stream_unreadable");
	else if (
		video.codec !== "h264" ||
		!(
			video.pixelFormat === OUTPUT_PIXEL_FORMAT ||
			(video.pixelFormat === "yuvj420p" &&
				video.colorRange === "pc" &&
				expected.color.mode === "passthrough")
		) ||
		video.profile !== "High"
	)
		codes.push("output_video_codec_contract");
	if (video.width !== expected.width || video.height !== expected.height)
		codes.push("output_canvas_mismatch");
	if (!equalRate(video.sampleAspectRatio, expected.sampleAspectRatio))
		codes.push("output_sar_mismatch");
	if (
		(!expected.variableFrameSpacing &&
			!averageRateMatches(
				video.avgFrameRate,
				expected.frameRate,
				video.frameCount,
			)) ||
		!equalRate(video.rFrameRate, expected.frameRate) ||
		!video.avgFrameRate
	)
		codes.push("output_frame_rate_mismatch");
	for (const key of Object.keys(HDR_TAG_VALUES) as (keyof ColorTags)[]) {
		const actual = video[key];
		const invalid =
			expected.color.mode === "asserted"
				? actual !== expected.color.tags[key]
				: actual !== null &&
					HDR_TAG_VALUES[key].includes(actual) &&
					actual !== expected.color.source[key];
		if (invalid) codes.push(`output_${key}_mismatch`);
	}
	if (
		expected.color.mode === "asserted" &&
		(video.masteringDisplay || video.contentLight || video.dolbyVision)
	)
		codes.push("output_hdr_metadata_present");
	if (media.audios.length !== (expected.audio === null ? 0 : 1))
		codes.push("output_audio_stream_missing_or_extra");
	if (
		audio &&
		(audio.codec !== "aac" ||
			!audio.sampleRate ||
			!audio.channels ||
			(expected.audio?.sampleRate !== undefined &&
				audio.sampleRate !== expected.audio.sampleRate) ||
			(expected.audio?.channels !== undefined &&
				audio.channels !== expected.audio.channels))
	)
		codes.push("output_audio_format_mismatch");
	if (codes.length) return reject(codes);
	let decoded: ValidatedRenderResult["decoded"];
	try {
		const result = await input.workerProcess.execute({
			command: "ffmpeg",
			args: renderOutputDecodeArgs(input.path),
			signal: input.signal,
			deadlineMs: mixPeakMeasureDeadlineMs(expected.durationSec),
			captureStdout: true,
			maxStdoutBytes: 32 * 1024 * 1024,
		});
		decoded = decodedStreams(result.stdout.toString("utf8"));
	} catch (error) {
		healthOrControl(error, input.signal);
		facts.processFailureCode =
			error instanceof WorkflowFailure ? error.code : null;
		return reject(["output_decode_failed"]);
	}
	facts.decoded = decoded;
	const frameSec =
		expected.frameRate.denominator / expected.frameRate.numerator;
	const epsilon = 0.000002; // probe/container timestamp rounding, never another frame allowance
	const tolerance = frameSec + epsilon;
	const picture = decoded.video;
	if (
		!picture.monotonic ||
		(!expected.variableFrameSpacing && picture.maxGapSec > epsilon)
	)
		codes.push("output_video_timestamps_invalid");
	if (
		Math.abs(picture.startSec) > tolerance ||
		Math.abs(picture.endSec - expected.durationSec) > tolerance ||
		Math.abs(picture.durationSec - expected.durationSec) > tolerance ||
		(!expected.variableFrameSpacing &&
			Math.abs(picture.frames - expected.durationSec / frameSec) >
				1 + epsilon / frameSec)
	)
		codes.push("output_video_duration_mismatch");
	if (video.frameCount !== null && video.frameCount !== picture.frames)
		codes.push("output_video_frame_count_mismatch");
	if (
		video.durationSec === null ||
		Math.abs(video.durationSec - picture.durationSec) > tolerance
	)
		codes.push("output_video_header_duration_mismatch");
	const packetSec = audio?.sampleRate ? 1024 / audio.sampleRate : 0;
	const audioTolerance = tolerance + packetSec;
	if (expected.audio !== null) {
		const sound = decoded.audio;
		if (
			!sound ||
			!sound.monotonic ||
			sound.maxGapSec > (audio?.sampleRate ? 1.1 / audio.sampleRate : epsilon)
		)
			codes.push("output_audio_timestamps_invalid");
		// The decoder applies AAC priming/skip_samples. One final packet may
		// contain padding beyond the edit list; no blanket millisecond allowance.
		if (
			!sound ||
			Math.abs(sound.startSec) > audioTolerance ||
			Math.abs(sound.endSec - expected.durationSec) > audioTolerance ||
			Math.abs(sound.durationSec - expected.durationSec) > audioTolerance ||
			audio?.durationSec === null ||
			(audio?.durationSec !== undefined &&
				Math.abs(audio.durationSec - sound.durationSec) > audioTolerance)
		)
			codes.push("output_audio_duration_mismatch");
	}
	const formatEnd =
		(media.format.startTimeSec ?? 0) + (media.format.durationSec ?? 0);
	const streamEnd = Math.max(
		picture.endSec,
		audio?.endTimeSec ?? picture.endSec,
	);
	if (
		media.format.durationSec === null ||
		Math.abs(media.format.startTimeSec ?? 0) > tolerance ||
		Math.abs(formatEnd - streamEnd) > tolerance ||
		Math.abs(formatEnd - expected.durationSec) > audioTolerance
	)
		codes.push("output_container_duration_mismatch");
	if (input.mixPeak && exceedsFullScale(input.mixPeak.measured))
		codes.push("output_mix_peak_exceeded");
	if (codes.length) return reject(codes);
	const warnings = [
		...(input.captionGlyphsOmitted?.length ? ["caption_glyph_omitted"] : []),
		...(input.captionEmojiSkipped?.length ? ["caption_emoji_skipped"] : []),
	];
	const result: ValidatedRenderResult = {
		durationSec: picture.durationSec,
		sizeBytes: Number(file.size),
		media,
		decoded,
		mixPeak: input.mixPeak ?? null,
		captionGlyphsOmitted: input.captionGlyphsOmitted ?? [],
		captionEmojiSkipped: input.captionEmojiSkipped ?? [],
		diagnosticCodes: warnings,
	};
	input.diagnose?.({
		accepted: true,
		diagnosticCodes: warnings,
		facts: { ...facts, ...result },
	});
	return result;
}
