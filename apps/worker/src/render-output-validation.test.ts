import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaFacts } from "@narriflow/validators";
import { SDR_OUTPUT_COLOR } from "./composition-ffmpeg-adapter";
import {
	passthroughColor,
	RenderOutputInvalid,
	validateRenderOutput,
	type RenderOutputExpectation,
} from "./render-output-validation";
import {
	productionWorkerProcessModule as processes,
	WorkerProcessFailure,
	type WorkerProcessModule,
} from "./worker-process";

const signal = new AbortController().signal;
let directory: string;
let path: string;
let media: MediaFacts;
const expected: RenderOutputExpectation = {
	durationSec: 1,
	width: 160,
	height: 90,
	frameRate: { numerator: 30, denominator: 1 },
	sampleAspectRatio: { numerator: 1, denominator: 1 },
	audio: { sampleRate: 48000, channels: 1 },
	color: passthroughColor(undefined),
};
const make = async (file: string, extra: string[] = []) =>
	processes.execute({
		command: "ffmpeg",
		signal,
		deadlineMs: 30_000,
		args: [
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=s=160x90:r=30:d=1",
			"-f",
			"lavfi",
			"-i",
			"sine=r=48000:d=1",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			...extra,
			file,
		],
	});

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "render-validation-09-"));
	path = join(directory, "good.mp4");
	await make(path);
	media = (
		await processes.inspectMedia({
			sourcePath: path,
			signal,
			deadlineMs: 30_000,
		})
	).facts!;
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

function injected(
	facts: MediaFacts,
	execute = processes.execute.bind(processes),
): WorkerProcessModule {
	return {
		...processes,
		inspectMedia: async () => ({
			durationSec: 1,
			width: 160,
			height: 90,
			hasAudio: true,
			hasVideo: true,
			hasVisualStream: true,
			fps: 30,
			facts,
		}),
		execute,
		withScratchDirectory: processes.withScratchDirectory.bind(processes),
	};
}
const validate = (
	workerProcess = processes,
	contract = expected,
	filePath = path,
) =>
	validateRenderOutput({
		path: filePath,
		expected: contract,
		workerProcess,
		signal,
	});

// Truncation and unreadable output are worth another encode; a mismatch
// against the plan or the pipeline's color contract fails the same way again.
const TRANSIENT = new Set([
	"output_video_stream_missing_or_extra",
	"output_decode_failed",
	"output_video_stream_unreadable",
	"output_video_duration_mismatch",
	"output_video_timestamps_invalid",
	"output_video_frame_count_mismatch",
	"output_audio_duration_mismatch",
	"output_container_duration_mismatch",
]);

async function rejectsWith(
	worker: WorkerProcessModule,
	code: string,
	contract = expected,
	disposition: "retryable" | "permanent" = TRANSIENT.has(code)
		? "retryable"
		: "permanent",
): Promise<void> {
	try {
		await validate(worker, contract);
		throw new Error("expected rejection");
	} catch (error) {
		expect(error).toBeInstanceOf(RenderOutputInvalid);
		expect(error).toMatchObject({
			code: "render_output_invalid",
			disposition,
		});
		expect((error as RenderOutputInvalid).diagnosticCodes).toContain(code);
	}
}

describe("render output admission", () => {
	test("one probe and one full decode return measured duration/stat and AAC padding facts", async () => {
		let probes = 0;
		let decodes = 0;
		const result = await validate({
			...injected(media),
			inspectMedia: async (request) => {
				probes++;
				return processes.inspectMedia(request);
			},
			execute: async (request) => {
				decodes++;
				expect(request.args).toContain("-xerror");
				expect(request.deadlineMs).toBe(30_000);
				return processes.execute(request);
			},
		});
		expect([probes, decodes]).toEqual([1, 1]);
		expect(result.durationSec).toBeCloseTo(1, 6);
		expect(result.sizeBytes).toBe((await stat(path)).size);
		expect(result.decoded.video.frames).toBe(30);
		expect(result.decoded.audio!.endSec).toBeGreaterThanOrEqual(1);
	});
	test("missing nb_frames is established by decode, not rejected or trusted", async () => {
		const facts = structuredClone(media);
		facts.videos[0]!.frameCount = null;
		expect((await validate(injected(facts))).decoded.video.frames).toBe(30);
	});
	for (const [label, change, code] of [
		[
			"no video",
			(facts: MediaFacts) => {
				facts.videos = [];
			},
			"output_video_stream_missing_or_extra",
		],
		[
			"missing audio",
			(facts: MediaFacts) => {
				facts.audios = [];
			},
			"output_audio_stream_missing_or_extra",
		],
		[
			"canvas",
			(facts: MediaFacts) => {
				facts.videos[0]!.width = 162;
			},
			"output_canvas_mismatch",
		],
		[
			"pixel format",
			(facts: MediaFacts) => {
				facts.videos[0]!.pixelFormat = "yuv444p";
			},
			"output_video_codec_contract",
		],
		[
			"codec",
			(facts: MediaFacts) => {
				facts.videos[0]!.codec = "hevc";
			},
			"output_video_codec_contract",
		],
		[
			"profile",
			(facts: MediaFacts) => {
				facts.videos[0]!.profile = "Main";
			},
			"output_video_codec_contract",
		],
		[
			"SAR",
			(facts: MediaFacts) => {
				facts.videos[0]!.sampleAspectRatio = { numerator: 2, denominator: 1 };
			},
			"output_sar_mismatch",
		],
		[
			"clock",
			(facts: MediaFacts) => {
				facts.videos[0]!.avgFrameRate = { numerator: 29, denominator: 1 };
			},
			"output_frame_rate_mismatch",
		],
		[
			"audio rate",
			(facts: MediaFacts) => {
				facts.audios[0]!.sampleRate = 44100;
			},
			"output_audio_format_mismatch",
		],
		[
			"audio channels",
			(facts: MediaFacts) => {
				facts.audios[0]!.channels = 2;
			},
			"output_audio_format_mismatch",
		],
		[
			"false frame count",
			(facts: MediaFacts) => {
				facts.videos[0]!.frameCount = 31;
			},
			"output_video_frame_count_mismatch",
		],
		[
			"format duration",
			(facts: MediaFacts) => {
				facts.format.durationSec = 1.1;
			},
			"output_container_duration_mismatch",
		],
	] as const) {
		test(`rejects ${label}`, async () => {
			const facts = structuredClone(media);
			change(facts);
			await rejectsWith(injected(facts), code);
		});
	}
	test("one frame tolerance passes exactly one frame, rejects two and 20.38/30s", async () => {
		await validate(processes, { ...expected, durationSec: 1 + 1 / 30 });
		await rejectsWith(processes, "output_video_duration_mismatch", {
			...expected,
			durationSec: 1 + 2 / 30,
		});
		await rejectsWith(processes, "output_video_duration_mismatch", {
			...expected,
			durationSec: 30,
		});
	});
	test("converted SDR asserts exact BT.709 tags and removes stale HDR metadata", async () => {
		const asserted: RenderOutputExpectation = {
			...expected,
			color: { mode: "asserted", tags: SDR_OUTPUT_COLOR },
		};
		await rejectsWith(injected(media), "output_colorSpace_mismatch", asserted);
		const tagged = structuredClone(media);
		Object.assign(tagged.videos[0]!, SDR_OUTPUT_COLOR);
		await validate(injected(tagged), asserted);
		tagged.videos[0]!.colorTransfer = null;
		await rejectsWith(injected(tagged), "output_colorTransfer_mismatch", asserted);
		const facts = structuredClone(tagged);
		Object.assign(facts.videos[0]!, SDR_OUTPUT_COLOR);
		facts.videos[0]!.contentLight = { maxContent: 1000, maxAverage: 400 };
		await rejectsWith(injected(facts), "output_hdr_metadata_present", asserted);
	});
	// Real 1080p60 podcast footage (fully BT.709 tagged AV1) rendered through a
	// caption/RGB overlay stage: swscale writes the matrix and range but leaves
	// transfer and primaries unspecified. Passthrough must accept that.
	test("passthrough accepts partial, absent or rewritten SDR tags", async () => {
		const source = {
			colorRange: "tv",
			colorSpace: "bt709",
			colorTransfer: "bt709",
			colorPrimaries: "bt709",
		};
		const contract = { ...expected, color: passthroughColor(source) };
		for (const tags of [
			{},
			{ colorRange: "tv", colorSpace: "bt709" },
			{ colorRange: "tv", colorSpace: "bt709", colorTransfer: "unknown" },
			{ colorSpace: "smpte170m", colorTransfer: "bt709", colorPrimaries: "bt470bg" },
			source,
		]) {
			const facts = structuredClone(media);
			Object.assign(facts.videos[0]!, {
				colorRange: null,
				colorSpace: null,
				colorTransfer: null,
				colorPrimaries: null,
				...tags,
			});
			await validate(injected(facts), contract);
		}
	});
	// Real mechanism behind the 1080p60 podcast failures: a two-up stack (and an
	// overlay on a generated background) keeps range and matrix but loses the
	// transfer and primaries, even from a fully BT.709-tagged source.
	test("a fully tagged source rendered through vstack validates as passthrough", async () => {
		const tagged = join(directory, "tagged-source.mp4");
		await make(tagged, [
			"-vf",
			"setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
		]);
		const source = (
			await processes.inspectMedia({
				sourcePath: tagged,
				signal,
				deadlineMs: 30_000,
			})
		).facts!.videos[0]!;
		expect(source).toMatchObject(SDR_OUTPUT_COLOR);
		const stacked = join(directory, "stacked.mp4");
		await processes.execute({
			command: "ffmpeg",
			signal,
			deadlineMs: 30_000,
			args: [
				"-v",
				"error",
				"-y",
				"-i",
				tagged,
				"-filter_complex",
				"[0:v]split[a][b];[a]crop=160:44:0:0[t];[b]crop=160:44:0:44[u];[t][u]vstack,format=yuv420p[o]",
				"-map",
				"[o]",
				"-map",
				"0:a",
				"-c:v",
				"libx264",
				"-c:a",
				"aac",
				stacked,
			],
		});
		const output = (
			await processes.inspectMedia({
				sourcePath: stacked,
				signal,
				deadlineMs: 30_000,
			})
		).facts!.videos[0]!;
		expect(output.colorSpace).toBe("bt709");
		expect(output.colorTransfer).not.toBe("bt709");
		const stackedExpected = { ...expected, height: 88 };
		await validate(
			processes,
			{ ...stackedExpected, color: passthroughColor(source) },
			stacked,
		);
		// The pre-fix contract: exact source tags, which the stack never wrote.
		await rejectsWith(processes, "output_colorTransfer_mismatch", {
			...stackedExpected,
			color: { mode: "asserted", tags: SDR_OUTPUT_COLOR },
		}, "permanent");
	});
	test("passthrough rejects HDR tags the source did not carry", async () => {
		for (const [key, value, code] of [
			["colorTransfer", "smpte2084", "output_colorTransfer_mismatch"],
			["colorTransfer", "arib-std-b67", "output_colorTransfer_mismatch"],
			["colorPrimaries", "bt2020", "output_colorPrimaries_mismatch"],
			["colorSpace", "bt2020nc", "output_colorSpace_mismatch"],
		] as const) {
			const facts = structuredClone(media);
			Object.assign(facts.videos[0]!, { [key]: value });
			await rejectsWith(injected(facts), code);
			// The same tag is the source's own and so is not a conversion defect.
			await validate(injected(facts), {
				...expected,
				color: passthroughColor({ [key]: value }),
			});
		}
	});
	test("a deterministic mismatch is permanent, truncation stays retryable", async () => {
		const facts = structuredClone(media);
		facts.videos[0]!.colorTransfer = "smpte2084";
		facts.videos[0]!.width = 162;
		await rejectsWith(injected(facts), "output_canvas_mismatch", expected, "permanent");
		const short = structuredClone(media);
		short.format.durationSec = 1.1;
		await rejectsWith(injected(short), "output_container_duration_mismatch", expected, "retryable");
	});
	test("rejects accidental audio in a silent plan", async () => {
		await rejectsWith(processes, "output_audio_stream_missing_or_extra", {
			...expected,
			audio: null,
		});
	});
	test("bad packet order and decode failure cannot complete", async () => {
		const worker = injected(media, async () => ({
			exitCode: 0,
			stdout: Buffer.from(
				"#tb 0: 1/30\n#media_type 0: video\n0, 1, 1, 1, 416, 0x0\n0, 0, 0, 1, 416, 0x0\n",
			),
		}));
		await rejectsWith(worker, "output_video_timestamps_invalid");
		await rejectsWith(
			injected(media, async () => {
				throw new WorkerProcessFailure(
					"worker_command_input_invalid",
					"permanent",
					"corrupt frame",
				);
			}),
			"output_decode_failed",
		);
	});
	test("AAC span gets exactly one video frame plus one measured AAC packet", async () => {
		const decode = (endSec: number) =>
			injected(media, async () => ({
				exitCode: 0,
				stdout: Buffer.from(
					"#tb 0: 1/30\n#media_type 0: video\n" +
						Array.from(
							{ length: 30 },
							(_, i) => `0, ${i}, ${i}, 1, 416, 0x0`,
						).join("\n") +
						`\n#tb 1: 1/48000\n#media_type 1: audio\n1, 0, 0, ${Math.round(endSec * 48000)}, 4096, 0x0\n`,
				),
			}));
		const allowance = 1 / 30 + 1024 / 48000;
		await validate(decode(1 + allowance));
		await rejectsWith(
			decode(1 + allowance + 0.001),
			"output_audio_duration_mismatch",
		);
		await rejectsWith(
			decode(1 - allowance - 0.001),
			"output_audio_duration_mismatch",
		);
	});
	test("damaged payload with an intact MP4 header cannot validate", async () => {
		const bytes = await readFile(path);
		const mdat = bytes.indexOf(Buffer.from("mdat"));
		expect(mdat).toBeGreaterThan(0);
		const size = bytes.readUInt32BE(mdat - 4);
		bytes.fill(0, mdat + 4, mdat - 4 + size);
		const file = join(directory, "damaged.mp4");
		await writeFile(file, bytes);
		await expect(validate(processes, expected, file)).rejects.toMatchObject({
			code: "render_output_invalid",
			disposition: "retryable",
		});
	});
	test("spawn and configuration failures propagate unchanged", async () => {
		for (const code of [
			"worker_command_spawn_failed",
			"worker_command_unavailable",
		]) {
			const failure = new WorkerProcessFailure(
				code,
				"retryable",
				"executor failed",
			);
			await expect(
				validate(
					injected(media, async () => {
						throw failure;
					}),
				),
			).rejects.toBe(failure);
			await expect(
				validate({
					...injected(media),
					inspectMedia: async () => {
						throw failure;
					},
				}),
			).rejects.toBe(failure);
		}
	});
	test("missing, tiny files and directories never reach ffprobe", async () => {
		const worker = {
			...injected(media),
			inspectMedia: async () => {
				throw new Error("must not probe");
			},
		};
		for (const file of [
			join(directory, "missing.mp4"),
			directory,
			join(directory, "empty.mp4"),
		]) {
			if (file.endsWith("empty.mp4")) await writeFile(file, "");
			await expect(validate(worker, expected, file)).rejects.toBeInstanceOf(
				RenderOutputInvalid,
			);
		}
	});
	test("caption omissions and final mix peak are first-class measured result fields", async () => {
		const events: unknown[] = [];
		const mixPeak = {
			outcome: "within_full_scale" as const,
			measured: { samplePeak: 0.5, truePeak: 0.5, truePeakDbtp: -6 },
		};
		const result = await validateRenderOutput({
			path,
			expected,
			workerProcess: processes,
			signal,
			mixPeak,
			captionGlyphsOmitted: [{ codePoint: 0x378, cueIndex: 2 }],
			captionEmojiSkipped: [{ emoji: "🇵🇰", cueIndex: 3 }],
			diagnose: (event) => events.push(event),
		});
		expect(result.captionGlyphsOmitted).toEqual([
			{ codePoint: 0x378, cueIndex: 2 },
		]);
		expect(result.captionEmojiSkipped).toEqual([{ emoji: "🇵🇰", cueIndex: 3 }]);
		expect(result.mixPeak).toBe(mixPeak);
		expect(events).toMatchObject([{ accepted: true }]);
	});
	test("real seek past source end exits zero but cannot validate", async () => {
		const file = join(directory, "no-frames.mp4");
		await processes.execute({
			command: "ffmpeg",
			signal,
			deadlineMs: 30_000,
			args: [
				"-v",
				"error",
				"-y",
				"-ss",
				"5",
				"-i",
				path,
				"-t",
				"1",
				"-c:v",
				"libx264",
				"-c:a",
				"aac",
				file,
			],
		});
		await expect(validate(processes, expected, file)).rejects.toMatchObject({
			code: "render_output_invalid",
			disposition: "retryable",
		});
	});
	test("silent NTSC and low-rate mono outputs keep their existing contract", async () => {
		const file = join(directory, "ntsc.mp4");
		await processes.execute({
			command: "ffmpeg",
			signal,
			deadlineMs: 30_000,
			args: [
				"-v",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=s=160x90:r=30000/1001:d=1",
				"-c:v",
				"libx264",
				file,
			],
		});
		expect(
			(
				await validate(
					processes,
					{
						...expected,
						frameRate: { numerator: 30000, denominator: 1001 },
						audio: null,
					},
					file,
				)
			).decoded.video.frames,
		).toBe(30);
		const mono = join(directory, "mono.mp4");
		await make(mono, ["-ar", "22050", "-ac", "1"]);
		expect(
			(
				await validate(
					processes,
					{ ...expected, audio: { sampleRate: 22050, channels: 1 } },
					mono,
				)
			).media.audios[0]!.sampleRate,
		).toBe(22050);
	});
});
