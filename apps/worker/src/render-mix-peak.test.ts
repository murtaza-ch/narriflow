import { describe, expect, test } from "bun:test";
import {
	exceedsFullScale,
	guardMixPeak,
	MIX_PEAK_CEILINGS,
	MixPeakError,
	mixCanClip,
	mixPeakMeasureArgs,
	mixPeakMeasureDeadlineMs,
	parseMixPeakMetadata,
} from "./render-mix-peak";

const metadata = (frames: Array<{ min: number; max: number; truePeak: number }>) =>
	frames
		.map(
			(frame, index) =>
				`frame:${index}    pts:${index * 4800}    pts_time:${index / 10}\n` +
				`lavfi.astats.Overall.Min_level=${frame.min.toFixed(6)}\n` +
				`lavfi.astats.Overall.Max_level=${frame.max.toFixed(6)}\n` +
				"lavfi.r128.M=-20.000\n" +
				`lavfi.r128.true_peaks_ch0=${frame.truePeak.toFixed(3)}\n` +
				`lavfi.r128.true_peak=${frame.truePeak.toFixed(3)}\n`,
		)
		.join("");

const FITS = metadata([{ min: -0.5, max: 0.6, truePeak: 0.62 }]);
const HOT = metadata([
	{ min: -0.9, max: 0.8, truePeak: 0.9 },
	{ min: -2.2, max: 2.1, truePeak: 2.208 },
]);

const music = { music: {} as never, soundEffects: [] };
const none = { music: null, soundEffects: [] };

describe("mix peak metadata", () => {
	test("takes the largest absolute sample and true peak over every frame", () => {
		expect(parseMixPeakMetadata(HOT)).toEqual({
			samplePeak: 2.2,
			truePeak: 2.208,
			truePeakDbtp: 20 * Math.log10(2.208),
		});
	});

	test("a negative minimum can be the sample peak", () => {
		expect(
			parseMixPeakMetadata(metadata([{ min: -1.5, max: 0.2, truePeak: 1.4 }]))
				.samplePeak,
		).toBe(1.5);
	});

	test("output without a decoded peak is unmeasurable, not clean", () => {
		for (const text of ["", "frame:0 pts:0\nlavfi.r128.M=-20\n"]) {
			expect(() => parseMixPeakMetadata(text)).toThrow(MixPeakError);
		}
		try {
			parseMixPeakMetadata("");
		} catch (error) {
			expect(error).toMatchObject({
				code: "render_output_invalid",
				reason: "mix_peak_unmeasurable",
				disposition: "retryable",
			});
		}
	});

	test("exactly full scale fits; anything above it does not", () => {
		const facts = (samplePeak: number, truePeak: number) => ({
			samplePeak,
			truePeak,
			truePeakDbtp: null,
		});
		expect(exceedsFullScale(facts(1, 1))).toBe(false);
		expect(exceedsFullScale(facts(1.000001, 0.5))).toBe(true);
		expect(exceedsFullScale(facts(0.99, 1.001))).toBe(true);
	});

	test("the measurement decodes the first audio stream and fails on decode errors", () => {
		const args = mixPeakMeasureArgs("/out.mp4");
		expect(args).toContain("-xerror");
		expect(args.slice(args.indexOf("-map"), args.indexOf("-map") + 2)).toEqual([
			"-map",
			"0:a:0",
		]);
		expect(args[args.indexOf("-i") + 1]).toBe("/out.mp4");
	});

	test("the measurement deadline follows the validation budget", () => {
		expect(mixPeakMeasureDeadlineMs(5)).toBe(30_000);
		expect(mixPeakMeasureDeadlineMs(60)).toBe(120_000);
		expect(mixPeakMeasureDeadlineMs(900)).toBe(300_000);
	});

	test("only music or sound effects can sum past full scale", () => {
		expect(mixCanClip(none)).toBe(false);
		expect(mixCanClip(music)).toBe(true);
		expect(mixCanClip({ music: null, soundEffects: [{} as never] })).toBe(true);
	});
});

describe("mix peak guard", () => {
	function harness(measurements: string[]) {
		const calls: string[] = [];
		let measured = 0;
		const input = {
			audio: music,
			outputPath: "/out.mp4",
			limitedArgs: (ceiling: number) => {
				calls.push(`compile:${ceiling}`);
				return ["-i", "in", "-af", `alimiter=${ceiling}`, "/out.mp4"];
			},
			measureStdout: async () => {
				calls.push("measure");
				return measurements[measured++] ?? measurements.at(-1)!;
			},
			execute: async (args: string[]) => {
				calls.push(`execute:${args[3]}`);
			},
		};
		return { calls, input };
	}

	test("the tiers are deterministic and descend", () => {
		expect(MIX_PEAK_CEILINGS).toEqual([0.95, 0.89, 0.79]);
	});

	test("a mix that fits is measured once and never recompiled or re-encoded", async () => {
		const { calls, input } = harness([FITS]);
		const result = await guardMixPeak(input);
		expect(result).toMatchObject({
			outcome: "within_full_scale",
			measured: { samplePeak: 0.6 },
		});
		expect(calls).toEqual(["measure"]);
	});

	test("audio without music or effects is not measured at all", async () => {
		const { calls, input } = harness([HOT]);
		expect(await guardMixPeak({ ...input, audio: none })).toBeNull();
		expect(calls).toEqual([]);
	});

	test("a clipping mix that fits after the first tier uses only that tier", async () => {
		const { calls, input } = harness([HOT, FITS]);
		const result = await guardMixPeak(input);
		expect(result).toMatchObject({
			outcome: "limited",
			tier: 1,
			ceiling: 0.95,
			initial: { samplePeak: 2.2 },
			measured: { samplePeak: 0.6 },
		});
		expect(calls).toEqual([
			"measure",
			"compile:0.95",
			"execute:alimiter=0.95",
			"measure",
		]);
	});

	test("a first tier that overshoots after encoding escalates to the second", async () => {
		const overshoot = metadata([{ min: -1.03, max: 1.02, truePeak: 1.03 }]);
		const { calls, input } = harness([HOT, overshoot, FITS]);
		const result = await guardMixPeak(input);
		expect(result).toMatchObject({ outcome: "limited", tier: 2, ceiling: 0.89 });
		expect(calls.filter((call) => call.startsWith("execute"))).toEqual([
			"execute:alimiter=0.95",
			"execute:alimiter=0.89",
		]);
	});

	test("exhausting every tier fails typed with each measured peak", async () => {
		const { calls, input } = harness([HOT, HOT, HOT, HOT]);
		const failure = await guardMixPeak(input).catch((error) => error);
		expect(failure).toBeInstanceOf(MixPeakError);
		expect(failure).toMatchObject({
			code: "render_output_invalid",
			reason: "mix_peak_exceeded",
			disposition: "permanent",
			facts: { initial: { samplePeak: 2.2 } },
		});
		expect(failure.facts.attempts.map((attempt: { ceiling: number }) => attempt.ceiling)).toEqual([0.95, 0.89, 0.79]);
		expect(failure.message).toContain("0.79");
		expect(calls.filter((call) => call.startsWith("execute"))).toHaveLength(3);
	});

	test("process failures propagate unchanged", async () => {
		const { input } = harness([HOT]);
		const spawnFailure = Object.assign(new Error("spawn failed"), {
			code: "worker_command_spawn_failed",
		});
		await expect(
			guardMixPeak({
				...input,
				measureStdout: async () => {
					throw spawnFailure;
				},
			}),
		).rejects.toBe(spawnFailure);
	});
});
