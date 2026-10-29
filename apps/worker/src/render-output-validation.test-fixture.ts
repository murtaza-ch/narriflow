import { compileClipCompositionCommand } from "./composition-ffmpeg-adapter";
import {
	compositionOutputExpectation,
	type RenderOutputExpectation,
} from "./render-output-validation";
import type {
	WorkerMediaInspection,
	WorkerProcessResult,
} from "./worker-process";

/** Deterministic process facts for lifecycle tests. Media correctness is tested
 * with real FFmpeg in render-output-validation.test.ts. */
export function createRenderOutputFixture() {
	const expectations = new Map<string, RenderOutputExpectation>();
	return {
		compileCommand: (
			request: Parameters<typeof compileClipCompositionCommand>[0],
		) => {
			expectations.set(
				request.outputPath,
				compositionOutputExpectation({
					plan: request.plan,
					targetId: request.targetId,
					source: request.source,
					audio: request.audio!,
				}),
			);
			return compileClipCompositionCommand(request);
		},
		inspect(path: string): WorkerMediaInspection | undefined {
			const expected = expectations.get(path);
			if (!expected) return undefined;
			const durationSec = expected.durationSec;
			const stream = {
				index: 0,
				codec: "h264",
				profile: "High",
				timeBase: { numerator: 1, denominator: 15360 },
				startPts: 0,
				startTimeSec: 0,
				durationTs: null,
				durationSec,
				endTimeSec: durationSec,
				frameCount: Math.round(
					(durationSec * expected.frameRate.numerator) /
						expected.frameRate.denominator,
				),
				bitRate: null,
			};
			return {
				durationSec,
				width: expected.width,
				height: expected.height,
				fps: expected.frameRate.numerator / expected.frameRate.denominator,
				hasVideo: true,
				hasVisualStream: true,
				hasAudio: expected.audio !== null,
				facts: {
					format: {
						name: "mov,mp4,m4a,3gp,3g2,mj2",
						startTimeSec: 0,
						durationSec,
						sizeBytes: 4096,
						bitRate: null,
					},
					attachedPictureCount: 0,
					videos: [
						{
							...stream,
							width: expected.width,
							height: expected.height,
							codedWidth: expected.width,
							codedHeight: expected.height,
							displayWidth: expected.width,
							displayHeight: expected.height,
							sampleAspectRatio: expected.sampleAspectRatio,
							displayMatrix: null,
							rotationDeg: 0,
							reflected: false,
							avgFrameRate: expected.frameRate,
							rFrameRate: expected.frameRate,
							pixelFormat: "yuv420p",
							colorRange: null,
							colorSpace: null,
							colorTransfer: null,
							colorPrimaries: null,
							chromaLocation: null,
							fieldOrder: null,
							masteringDisplay: null,
							contentLight: null,
							dolbyVision: null,
							...expected.color,
						},
					],
					audios:
						expected.audio === null
							? []
							: [
									{
										...stream,
										index: 1,
										codec: "aac",
										profile: "LC",
										frameCount: null,
										sampleRate: expected.audio.sampleRate ?? 48000,
										channels: expected.audio.channels ?? 2,
										channelLayout: "stereo",
										sampleFormat: "fltp",
										initialPadding: 0,
										trailingPadding: 0,
									},
								],
				},
			};
		},
		decode(args: readonly string[]): WorkerProcessResult | undefined {
			if (!args.includes("framecrc")) return undefined;
			const expected = expectations.get(args[args.indexOf("-i") + 1]!)!;
			const fps = expected.frameRate.numerator / expected.frameRate.denominator;
			const count = Math.round(expected.durationSec * fps);
			return {
				exitCode: 0,
				stdout: Buffer.from(
					`#tb 0: ${expected.frameRate.denominator}/${expected.frameRate.numerator}\n#media_type 0: video\n` +
						Array.from(
							{ length: count },
							(_, i) => `0, ${i}, ${i}, 1, 416, 0x0`,
						).join("\n") +
						(expected.audio === null
							? ""
							: `\n#tb 1: 1/48000\n#media_type 1: audio\n1, 0, 0, ${Math.round((count / fps) * 48000)}, 4096, 0x0`) +
						"\n",
				),
			};
		},
	};
}
