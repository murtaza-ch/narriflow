import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	automaticLayoutInputFingerprint,
	planClipComposition,
} from "@narriflow/composition-plan";
import {
	CLIP_AUTO_LAYOUT_ENGINE,
	buildClipCutPlan,
	captionPresetSchema,
	editorDocumentSchema,
	studioEditsSchema,
} from "@narriflow/validators";
import {
	bindCompositionPlanAudioInputs,
	compileClipCompositionCommand,
	compileCompositionPlanAudioSchedule,
} from "./composition-ffmpeg-adapter";
import { parseRenderConfig } from "./render-config";
import { analyzeClipAutoLayout } from "./tasks/auto-layout-analysis";
import {
	productionWorkerProcessModule as worker,
	type WorkerProcessModule,
} from "./worker-process";

test.each([
	"uncut",
	"inserted",
	"deleted",
	"deleted-start",
	"repeated-deletions",
	"combined",
	"sliver",
] as const)("native camera cuts and layout switches share every frame with %s footage and a retimed proxy", async (variant) => {
	await worker.withScratchDirectory(
		"narriflow-camera-clock-",
		async (directory) => {
			const signal = new AbortController().signal;
			const execute = (args: string[]) =>
				worker.execute({
					command: "ffmpeg",
					args: ["-hide_banner", "-loglevel", "error", "-y", ...args],
					signal,
					deadlineMs: 10_000,
					captureStdout: true,
				});
			const sourcePath = join(directory, "source.mp4");
			const proxyPath = join(directory, "proxy.mp4");
			const outputPath = join(directory, "output.mp4");
			const frameSec = 1001 / 60000;
			const startSec = 0.047; // Seeks between native frames, leaving a nonzero first PTS.
			const durationSec = 3.2;
			const firstFrame = Math.ceil(startSec / frameSec);
			const cameraFrames = [73, 149];
			const cuts = cameraFrames.map((frame) => (frame - firstFrame) * frameSec);
			const deletedRanges =
				variant === "sliver"
					? [{ startSec: startSec + 0.05, endSec: startSec + 0.3 }]
					: variant === "deleted-start"
						? [{ startSec, endSec: startSec + 0.3 }]
						: ["deleted", "repeated-deletions", "combined"].includes(variant)
							? [
									{ startSec: startSec + 0.3, endSec: startSec + 0.6 },
									...(variant === "repeated-deletions"
										? [{ startSec: startSec + 1.8, endSec: startSec + 2.1 }]
										: []),
								]
							: [];
			const insertedFrames =
				variant === "inserted" || variant === "combined" ? 60 : 0;
			const insertionFrame = 60;
			const sceneBlocks = insertedFrames
				? [
						{
							id: "8ab9d330-688f-4574-932c-27ac661245c1",
							schemaVersion: 1,
							anchorSec: insertionFrame * frameSec,
							durationSec: insertedFrames * frameSec,
							content: { kind: "color", color: "#FFFF00" },
							motion: { entrance: "none", exit: "none" },
							templateSnapshot: null,
						},
					]
				: [];
			await execute([
				"-f",
				"lavfi",
				"-i",
				"color=blue:s=320x180:r=60000/1001",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:sample_rate=48000:duration=4",
				"-vf",
				"drawbox=x=0:y=0:w=iw:h=ih:c=black:t=fill:enable='gte(n,73)'," +
					"drawbox=x=0:y=0:w=107:h=180:c=red:t=fill:enable='between(n,73,148)'," +
					"drawbox=x=213:y=0:w=107:h=180:c=green:t=fill:enable='between(n,73,148)'," +
					"drawbox=x=107:y=0:w=106:h=180:c=blue:t=fill:enable='gte(n,149)'",
				"-frames:v",
				"210",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-shortest",
				sourcePath,
			]);
			// Reproduce the real bug: a 30fps proxy cannot be the camera-cut clock.
			await execute([
				"-ss",
				String(startSec),
				"-i",
				sourcePath,
				"-t",
				String(durationSec),
				"-r",
				"30",
				"-c:v",
				"libx264",
				"-an",
				proxyPath,
			]);
			const face = (cx: number, h: number) => ({
				cx,
				cy: 0.4,
				w: h * 0.75,
				h,
				score: 0.99,
			});
			const samples = Array.from({ length: 13 }, (_, index) => {
				const t = index / 4;
				return {
					t,
					faces:
						t >= cuts[0]! && t < cuts[1]!
							? [face(0.16, 0.15), face(0.84, 0.15)]
							: [face(0.5, 0.3)],
				};
			});
			const analysisWorker: WorkerProcessModule = {
				inspectMedia: (request) => worker.inspectMedia(request),
				withScratchDirectory: (prefix, work) =>
					worker.withScratchDirectory(prefix, work),
				execute: (request) =>
					request.command === "python3"
						? Promise.resolve({
								exitCode: 0,
								stdout: Buffer.from(JSON.stringify({ samples })),
							})
						: worker.execute(request),
			};
			const analysis = await analyzeClipAutoLayout({
				clip: {
					id: "camera-clock",
					projectId: "camera-clock",
					startSec,
					endSec: startSec + durationSec,
					transcriptSlice: [],
					deletedRanges,
					editorRevision: 0,
					sourceStorageKey: "source",
					previewStorageKey: "proxy",
					previewStartSec: startSec,
					previewDurationSec: durationSec,
					autoLayoutClaimToken: "claim",
					leaseMs: 180000,
				},
				originalSourcePath: sourcePath,
				previewPath: proxyPath,
				workerProcess: analysisWorker,
				config: parseRenderConfig({ REFRAME_SCENE_THRESHOLD: "0.1" }),
				signal,
			});
			if (!deletedRanges.length) {
				expect(analysis.segments.map((segment) => segment.layout)).toEqual([
					"single",
					"two-up",
					"single",
				]);
				expect(analysis.segments[1]!.startSec).toBeCloseTo(cuts[0]!, 6);
				expect(analysis.segments[2]!.startSec).toBeCloseTo(cuts[1]!, 6);
			}
			const sourceIdentity = analysis.sourceIdentity;
			const result = planClipComposition({
				document: editorDocumentSchema.parse({
					version: 1,
					clipStartSec: startSec,
					clipEndSec: startSec + durationSec,
					captionPreset: captionPresetSchema.parse({ visible: false }),
					transcriptSlice: [],
					studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
					brollUrl: null,
					deletedRanges,
					sceneBlocks,
				}),
				source: {
					identity: sourceIdentity,
					kind: "video",
					width: 320,
					height: 180,
				},
				evidence: {
					automaticLayout: {
						state: "available",
						value: {
							sourceIdentity,
							engineVersion: CLIP_AUTO_LAYOUT_ENGINE,
							analysis,
							inputFingerprint: automaticLayoutInputFingerprint({
								sourceIdentity,
								clipStartSec: startSec,
								clipEndSec: startSec + durationSec,
								deletedRanges,
								engineVersion: CLIP_AUTO_LAYOUT_ENGINE,
							}),
						},
					},
				},
				assets: { backgroundImage: { state: "missing" } },
				capabilities: {
					automaticSpeakerLayout: true,
					automaticSpeakerEngineVersion: CLIP_AUTO_LAYOUT_ENGINE,
				},
				targets: [
					{ id: "vertical", aspectRatio: "9:16", width: 90, height: 160 },
				],
			});
			if (result.status === "invalid") throw new Error(result.error.code);
			const cutPlan = buildClipCutPlan(deletedRanges, {
				startSec,
				endSec: startSec + durationSec,
			});
			expect(result.plan.editedDurationSec).toBeCloseTo(
				cutPlan.editedDurationSec + insertedFrames * frameSec,
				6,
			);
			const source = await worker.inspectMedia({
				sourcePath,
				signal,
				deadlineMs: 5000,
			});
			await execute(
				compileClipCompositionCommand({
					sourcePath,
					outputPath,
					startSec,
					endSec: startSec + durationSec,
					source,
					plan: result.plan,
					targetId: "vertical",
					cutPlan,
					audio: bindCompositionPlanAudioInputs(
						compileCompositionPlanAudioSchedule(result.plan),
						{},
					),
					encoder: { preset: "ultrafast", crf: "18" },
					assets: { subtitlePath: null },
				}),
			);
			// Decode every output frame. The wide camera must be red/green, and the
			// solo cameras blue. A stale crop exposes black pixels at either cut.
			const decoded = await execute([
				"-i",
				outputPath,
				"-vf",
				"crop=2:160:44:0,scale=2:4:flags=neighbor,format=rgb24",
				"-fps_mode",
				"passthrough",
				"-f",
				"rawvideo",
				"pipe:1",
			]);
			const bytesPerFrame = 24;
			const frameCount = decoded.stdout.length / bytesPerFrame;
			const sourceFrames = Array.from(
				{ length: 192 },
				(_, index) => index,
			).filter(
				(index) =>
					!(variant === "sliver" && index < 3) &&
					!deletedRanges.some(
						(range) =>
							index * frameSec >= range.startSec - startSec &&
							index * frameSec < range.endSec - startSec,
					),
			);
			expect(frameCount).toBe(sourceFrames.length + insertedFrames);
			const output = await worker.inspectMedia({
				sourcePath: outputPath,
				signal,
				deadlineMs: 5000,
			});
			expect(output.hasAudio).toBe(true);
			expect(
				Math.abs(output.durationSec! - result.plan.editedDurationSec),
			).toBeLessThan(0.05);
			const incorrectFrames: number[] = [];
			for (let frame = 0; frame < frameCount; frame += 1) {
				if (
					insertedFrames &&
					frame >= insertionFrame &&
					frame < insertionFrame + insertedFrames
				) {
					const rgb = [
						...decoded.stdout.subarray(
							frame * bytesPerFrame,
							frame * bytesPerFrame + 3,
						),
					];
					if (rgb[0]! < 200 || rgb[1]! < 200 || rgb[2]! > 60)
						incorrectFrames.push(frame);
					continue;
				}
				const sourceFrame =
					sourceFrames[
						frame -
							(insertedFrames && frame >= insertionFrame ? insertedFrames : 0)
					]! + firstFrame;
				const wide =
					sourceFrame >= cameraFrames[0]! && sourceFrame < cameraFrames[1]!;
				for (const [offset, channel] of [
					[0, wide ? 0 : 2],
					[12, wide ? 1 : 2],
				]) {
					const rgb = [
						...decoded.stdout.subarray(
							frame * bytesPerFrame + offset!,
							frame * bytesPerFrame + offset! + 3,
						),
					];
					if (
						rgb[channel!]! <
						Math.max(...rgb.filter((_, index) => index !== channel)) + 40
					)
						incorrectFrames.push(frame);
				}
			}
			expect([...new Set(incorrectFrames)]).toEqual([]);
		},
	);
}, 30_000);
