import { WorkflowFailure } from "@narriflow/services";
import type { BoundCompositionAudioRenderRequest } from "./composition-ffmpeg-adapter";

/**
 * Peak guard for music/SFX mixes.
 *
 * `amix` runs with `normalize=0`, so a hot track plus dialogue can sum past
 * digital full scale. A candidate is decoded once; only a proven peak above
 * 0 dBFS buys corrective re-encodes of the same frozen composition with a
 * limiter (`mixPeakCeiling` on the compiler input), one per tier of
 * `MIX_PEAK_CEILINGS`, each measured, stopping at the first that fits. A mix
 * that already fits keeps its original encode, bytes and PCM. The result is a typed fact
 * the output validator can reuse instead of probing the file again.
 */

/** Digital full scale as a linear sample value. */
export const MIX_PEAK_FULL_SCALE = 1;

/** Limiter ceilings tried in order (linear). AAC overshoots a limited signal
 *  by a few percent, so a tier can still land above full scale; the next one
 *  leaves more headroom. */
export const MIX_PEAK_CEILINGS: readonly number[] = [0.95, 0.89, 0.79];

export interface MixPeakFacts {
	/** Largest decoded absolute sample value, linear. */
	samplePeak: number;
	/** Largest 4x-oversampled value (EBU R128 true peak), linear. ffmpeg
	 *  reports it to three decimals. */
	truePeak: number;
	truePeakDbtp: number | null;
}

export type MixPeakResult =
	| { outcome: "within_full_scale"; measured: MixPeakFacts }
	| {
			outcome: "limited";
			/** 1-based index into `MIX_PEAK_CEILINGS` that fit. */
			tier: number;
			ceiling: number;
			initial: MixPeakFacts;
			measured: MixPeakFacts;
	  };

export interface MixPeakAttempt {
	tier: number;
	ceiling: number;
	measured: MixPeakFacts;
}

export type MixPeakFailureReason =
	| "mix_peak_exceeded"
	| "mix_peak_unmeasurable";

/** Typed invalid-output failure. A mix that is still above full scale after
 *  every limiter tier is deterministic, so it is permanent; an unreadable
 *  measurement may be a transient read problem. */
export class MixPeakError extends WorkflowFailure {
	constructor(
		readonly reason: MixPeakFailureReason,
		message: string,
		readonly facts: { initial?: MixPeakFacts; attempts?: MixPeakAttempt[] } = {},
	) {
		super(
			"render_output_invalid",
			reason === "mix_peak_exceeded" ? "permanent" : "retryable",
			message,
		);
		this.name = "MixPeakError";
	}
}

/** Only mixes that add music or sound effects to the dialogue can sum past
 *  full scale; every other path keeps its single, explicitly gained track. */
export function mixCanClip(
	audio: Pick<BoundCompositionAudioRenderRequest, "music" | "soundEffects">,
): boolean {
	return Boolean(audio.music) || audio.soundEffects.length > 0;
}

export function exceedsFullScale(facts: MixPeakFacts): boolean {
	return (
		facts.samplePeak > MIX_PEAK_FULL_SCALE ||
		facts.truePeak > MIX_PEAK_FULL_SCALE
	);
}

/** Decode-validation budget from the render spec: `min(300s, max(30s, 2 x
 *  edited duration))`. */
export function mixPeakMeasureDeadlineMs(editedDurationSec: number): number {
	return Math.min(300_000, Math.max(30_000, 2_000 * editedDurationSec));
}

const MEASURE_FILTER =
	"aformat=sample_fmts=fltp," +
	"astats=metadata=1:reset=0:measure_perchannel=none:measure_overall=Max_level+Min_level," +
	"ebur128=metadata=1:peak=true," +
	"ametadata=mode=print:file=-";

/** ffmpeg arguments that decode the first audio stream and print its peak
 *  metadata on stdout. `-xerror` turns a decode error into a failed exit. */
export function mixPeakMeasureArgs(mediaPath: string): string[] {
	return [
		"-nostdin",
		"-hide_banner",
		"-nostats",
		"-v",
		"error",
		"-xerror",
		"-i",
		mediaPath,
		"-map",
		"0:a:0",
		"-vn",
		"-af",
		MEASURE_FILTER,
		"-f",
		"null",
		"-",
	];
}

const SAMPLE_KEYS = new Set([
	"lavfi.astats.Overall.Max_level",
	"lavfi.astats.Overall.Min_level",
]);

/** Reads `ametadata=print` output. Throws when no decoded audio frame
 *  reported a peak (no audio stream, empty or malformed output). */
export function parseMixPeakMetadata(stdout: string): MixPeakFacts {
	let samplePeak = Number.NEGATIVE_INFINITY;
	let truePeak = Number.NEGATIVE_INFINITY;
	for (const line of stdout.split("\n")) {
		const separator = line.indexOf("=");
		if (separator < 0) continue;
		const key = line.slice(0, separator);
		const isSample = SAMPLE_KEYS.has(key);
		if (!isSample && key !== "lavfi.r128.true_peak") continue;
		const value = Number(line.slice(separator + 1));
		if (!Number.isFinite(value)) continue;
		if (isSample) samplePeak = Math.max(samplePeak, Math.abs(value));
		else truePeak = Math.max(truePeak, value);
	}
	if (!Number.isFinite(samplePeak) || !Number.isFinite(truePeak)) {
		throw new MixPeakError(
			"mix_peak_unmeasurable",
			"The rendered audio reported no decoded peak",
		);
	}
	return {
		samplePeak,
		truePeak,
		truePeakDbtp: truePeak > 0 ? 20 * Math.log10(truePeak) : null,
	};
}

/**
 * Guard one encoded candidate. Returns null for audio that cannot sum past
 * full scale. Otherwise measures the output, and if it is above full scale
 * re-encodes with the limiter (`limitedArgs(ceiling)`, the same frozen
 * command) at each tier of `MIX_PEAK_CEILINGS` in turn, measuring after each,
 * until one fits. Fails typed, with every measurement, only when the last tier
 * is still above full scale. Process failures from either callback propagate
 * unchanged, so a missing executable stays an executor-health failure.
 */
export async function guardMixPeak(input: {
	audio: Pick<BoundCompositionAudioRenderRequest, "music" | "soundEffects">;
	outputPath: string;
	limitedArgs: (ceiling: number) => string[];
	/** Runs ffmpeg and returns stdout. */
	measureStdout: (args: string[]) => Promise<string>;
	/** Runs a corrective encode. */
	execute: (args: string[]) => Promise<void>;
}): Promise<MixPeakResult | null> {
	if (!mixCanClip(input.audio)) return null;
	const measure = async () =>
		parseMixPeakMetadata(
			await input.measureStdout(mixPeakMeasureArgs(input.outputPath)),
		);
	const initial = await measure();
	if (!exceedsFullScale(initial)) {
		return { outcome: "within_full_scale", measured: initial };
	}
	const attempts: MixPeakAttempt[] = [];
	for (const [index, ceiling] of MIX_PEAK_CEILINGS.entries()) {
		await input.execute(input.limitedArgs(ceiling));
		const measured = await measure();
		if (!exceedsFullScale(measured)) {
			return { outcome: "limited", tier: index + 1, ceiling, initial, measured };
		}
		attempts.push({ tier: index + 1, ceiling, measured });
	}
	throw new MixPeakError(
		"mix_peak_exceeded",
		`The mix is still above full scale after ${attempts.length} limiter tiers (initial sample/true peak ${initial.samplePeak}/${initial.truePeak}; ${attempts
			.map(
				(attempt) =>
					`${attempt.ceiling}: ${attempt.measured.samplePeak}/${attempt.measured.truePeak}`,
			)
			.join(", ")})`,
		{ initial, attempts },
	);
}
