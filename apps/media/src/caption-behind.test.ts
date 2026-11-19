import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type CaptionBehindPlacement } from "@narriflow/caption-fonts/caption-block";
import { type ClipCompositionPlan, type CompositionCaptionVisualLayer, planClipComposition } from "@narriflow/composition-plan";
import { captionPresetSchema, captionWordKey, editorDocumentSchema, getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";
import { captionBehindCandidates, renderCaptionTrack } from "./caption-ass";
import { CAPTION_MATTE_UNAVAILABLE, captionBehindGraphInput, personMatteSpec, preparePersonMatte } from "./caption-behind";
import {
	bindCompositionPlanAudioInputs,
	compileClipCompositionCommand,
	compileCompositionPlanAudioSchedule,
	compileCompositionPlanMatteCommand,
	compileCompositionPlanVisualLayers,
	personMatteCanvasSize,
	personMatteFrameIndex,
} from "./composition-ffmpeg-adapter";
import { productionWorkerProcessModule } from "./worker-process";

// Heroes behind the speaker, worker side (spec 5.12).

const directories: string[] = [];
afterAll(() => Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))));
const scratch = async () => {
	const directory = await mkdtemp(join(tmpdir(), "narriflow-behind-"));
	directories.push(directory);
	return directory;
};

function depthPlan(input: { framing?: Record<string, unknown>; background?: Record<string, unknown>; heroBehind?: boolean; durationSec?: number; source?: { width: number; height: number } } = {}): ClipCompositionPlan {
	const words = [
		{ word: "the", startSec: 0.2, endSec: 0.5 },
		{ word: "secret", startSec: 0.55, endSec: 1.0 },
		{ word: "sauce.", startSec: 1.05, endSec: 1.4 },
	].map((word) => ({ ...word, confidence: 1 }));
	const document = editorDocumentSchema.parse({
		version: 1, clipStartSec: 0, clipEndSec: input.durationSec ?? 2,
		captionPreset: captionPresetSchema.parse({ ...getCaptionPresetById("depth")!.preset, heroBehind: input.heroBehind ?? true }),
		transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker 1", startSec: 0.2, endSec: 1.4, text: "the secret sauce.", confidence: 1, words }],
		studioEdits: studioEditsSchema.parse({ framing: input.framing ?? { mode: "center" }, ...(input.background ? { background: input.background } : {}), captionEmphasis: { [captionWordKey(0.55)]: "hero" } }),
		brollUrl: null, deletedRanges: [],
	});
	const source = input.source ?? { width: 320, height: 180 };
	const planned = planClipComposition({
		document, captionLanguage: "en",
		source: { identity: "source:behind", kind: "video", ...source, hasAudio: false },
		evidence: { automaticLayout: { state: "missing" } },
		assets: { backgroundImage: { state: "missing" }, music: { state: "missing" } },
		capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
		targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
	});
	if (planned.status === "invalid") throw new Error(planned.error.code);
	return planned.plan;
}

const captionLayers = (plan: ClipCompositionPlan) =>
	plan.targets[0]!.visualLayers.filter((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption");
const dialogue = (ass: string) => ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
const posY = (line: string) => Number(/\\(?:pos|move)\([\d.-]+,([\d.-]+)/.exec(line)?.[1]);

describe("split caption track", () => {
	const plan = depthPlan();
	const layers = captionLayers(plan);
	const canvas = plan.targets[0]!.canvas;
	const cueIndex = layers[0]!.cueIndex;

	test("without placements, or placed in front, every event is in the front script, unmoved", () => {
		const plain = renderCaptionTrack({ layers, canvas });
		expect(plain.behindAss).toBe("");
		expect(plain.behind).toEqual([]);
		expect(dialogue(plain.ass).some((line) => line.endsWith("secret"))).toBe(true);
		const front = renderCaptionTrack({ layers, canvas, behind: new Map<number, CaptionBehindPlacement>([[cueIndex, { behind: false, liftPx: 0 }]]) });
		expect(front.ass).toBe(plain.ass);
		expect(front.behindAss).toBe("");
	});

	test("placed behind: the hero row moves to the behind script, the support rows stay in front, both lifted", () => {
		const plain = renderCaptionTrack({ layers, canvas });
		const split = renderCaptionTrack({ layers, canvas, behind: new Map([[cueIndex, { behind: true, liftPx: 40 }]]) });
		const behindLines = dialogue(split.behindAss);
		const frontLines = dialogue(split.ass);
		expect(behindLines.length).toBeGreaterThan(0);
		expect(behindLines.every((line) => line.endsWith("secret"))).toBe(true);
		expect(frontLines.some((line) => line.endsWith("secret"))).toBe(false);
		expect(frontLines.some((line) => line.endsWith("the")) && frontLines.some((line) => line.endsWith("sauce."))).toBe(true);
		expect(behindLines.length + frontLines.length).toBe(dialogue(plain.ass).length);
		const plainHero = dialogue(plain.ass).filter((line) => line.endsWith("secret")).at(-1)!;
		expect(posY(behindLines.at(-1)!)).toBeCloseTo(posY(plainHero) - 40, 1);
		expect(split.behind).toEqual([expect.objectContaining({ cueIndex, startSec: 0.55, endSec: layers[0]!.activeRange.endSec })]);
		// Both scripts share one header.
		expect(split.behindAss.split("[Events]")[0]).toBe(split.ass.split("[Events]")[0]);
	});

	test("candidates carry the hero onset, its ink and the unlifted bounds", () => {
		const [candidate] = captionBehindCandidates({ layers, canvas });
		expect(candidate).toMatchObject({ cueIndex, onsetSec: 0.55 });
		expect(candidate!.heroInk.height).toBeGreaterThan(0);
		expect(candidate!.bounds.y).toBeLessThanOrEqual(candidate!.heroInk.y);
	});
});

describe("graph", () => {
	const plan = depthPlan();
	const behind = {
		subtitlePath: "/tmp/behind.ass", matteInputIndex: 3, matteSize: { width: 540, height: 960 }, canvas: { width: 1080, height: 1920 },
		box: { x: 0, y: 400, width: 1080, height: 400 }, windows: [{ startSec: 0.55, endSec: 1.5 }],
	};

	test("without behind cues the caption stage is exactly the old one", () => {
		const parts = compileCompositionPlanVisualLayers({ plan, targetId: "vertical", inputLabel: "[base]", outputLabel: "[outv]", subtitlePath: "/tmp/front.ass", captionFontsDirectory: "/fonts" });
		expect(parts.filterParts).toEqual(["[base]ass='/tmp/front.ass':fontsdir='/fonts'[outv]"]);
	});

	test("with behind cues: split, behind script, matte over the box, person overlaid during the cues, then the front script", () => {
		const parts = compileCompositionPlanVisualLayers({ plan, targetId: "vertical", inputLabel: "[base]", outputLabel: "[outv]", subtitlePath: "/tmp/front.ass", captionFontsDirectory: "/fonts", captionBehind: behind });
		expect(parts.filterParts).toEqual([
			"[base]split=2[composition_caption_0_scene][composition_caption_0_person_source]",
			"[composition_caption_0_scene]ass='/tmp/behind.ass':fontsdir='/fonts'[composition_caption_0_behind]",
			"[3:v]crop=540:200:0:200,scale=1080:400,format=gray[composition_caption_0_matte]",
			"[composition_caption_0_person_source]crop=1080:400:0:400[composition_caption_0_person_box]",
			"[composition_caption_0_person_box][composition_caption_0_matte]alphamerge[composition_caption_0_person]",
			"[composition_caption_0_behind][composition_caption_0_person]overlay=0:400:format=auto:enable='between(t\\,0.550\\,1.500)'[composition_caption_0_composite]",
			"[composition_caption_0_composite]ass='/tmp/front.ass':fontsdir='/fonts'[outv]",
		]);
	});

	test("the full command takes the canvas matte as its last input only when a cue is behind", async () => {
		const directory = await scratch();
		const sourcePath = join(directory, "source.mp4");
		await productionWorkerProcessModule.execute({ command: "ffmpeg", args: ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-pix_fmt", "yuv420p", sourcePath], signal: new AbortController().signal, deadlineMs: 20_000 });
		const source = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal: new AbortController().signal, deadlineMs: 5_000 });
		const base = { sourcePath, outputPath: join(directory, "out.mp4"), startSec: 0, endSec: 2, source, plan, targetId: "vertical", audio: bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(plan), {}), encoder: { preset: "ultrafast", crf: "23" } };
		const plain = compileClipCompositionCommand({ ...base, assets: { subtitlePath: "/tmp/front.ass" } });
		const none = compileClipCompositionCommand({ ...base, assets: { subtitlePath: "/tmp/front.ass", captionBehind: null } });
		expect(none).toEqual(plain);
		const { matteInputIndex: _index, ...input } = behind;
		const withMatte = compileClipCompositionCommand({ ...base, assets: { subtitlePath: "/tmp/front.ass", captionBehind: { ...input, mattePath: "/tmp/matte.mkv" } } });
		const inputs = withMatte.flatMap((arg, index) => (arg === "-i" ? [withMatte[index + 1]] : []));
		expect(inputs.at(-1)).toBe("/tmp/matte.mkv");
		expect(withMatte[withMatte.indexOf("-filter_complex") + 1]).toContain(`[${inputs.length - 1}:v]crop=`);
	}, 30_000);
});

describe("matte pass", () => {
	/** A window-aligned source matte: white where the given drawbox is, black elsewhere. */
	async function sourceMatte(directory: string, size: { width: number; height: number }, box: string, durationSec = 2) {
		const path = join(directory, "source-matte.mkv");
		await productionWorkerProcessModule.execute({
			command: "ffmpeg",
			args: ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${size.width}x${size.height}:r=15:d=${durationSec}`, "-vf", `format=gray,drawbox=${box}:color=white:t=fill`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "gray", path],
			signal: new AbortController().signal, deadlineMs: 20_000,
		});
		return path;
	}
	const inspection = { hasVideo: true, hasAudio: false, width: 320, height: 180, fps: 30, durationSec: 2 } as Parameters<typeof compileCompositionPlanMatteCommand>[0]["source"];

	test("the matte follows the crop to canvas size, and frames at the probe times come out in order", async () => {
		const directory = await scratch();
		const plan = depthPlan();
		const mattePath = await sourceMatte(directory, { width: 320, height: 180 }, "x=140:y=60:w=40:h=120");
		const command = compileCompositionPlanMatteCommand({ plan, targetId: "vertical", mattePath, startSec: 0, source: inspection, outputPath: join(directory, "canvas.mkv"), probePath: join(directory, "probe.gray"), probeTimesSec: [1.2, 0.55, 0.56] });
		expect(command.probeFrames).toEqual([personMatteFrameIndex(0.55), personMatteFrameIndex(1.2)]);
		expect(command.size).toEqual(personMatteCanvasSize({ width: 1080, height: 1920 }));
		// Matte mode reads no input but the matte.
		expect(command.args.filter((arg) => arg === "-i").length).toBe(1);
		await productionWorkerProcessModule.execute({ command: "ffmpeg", args: ["-v", "error", ...command.args], signal: new AbortController().signal, deadlineMs: 30_000 });
		const probe = await readFile(join(directory, "probe.gray"));
		const { width, height } = command.size;
		expect(probe.byteLength).toBe(width * height * 2);
		// Centre crop of 320x180 is about 101x180 from x 110: the 40 px column sits in its middle, below y 60 (a third of the height).
		const at = (x: number, y: number) => probe[Math.round(y * height) * width + Math.round(x * width)]!;
		expect(at(0.5, 0.8)).toBeGreaterThan(200);
		expect(at(0.5, 0.2)).toBe(0);
		expect(at(0.05, 0.8)).toBe(0);
	}, 60_000);

	test("matte mode draws the Fit background black, so only the source tile carries the matte", async () => {
		const directory = await scratch();
		const plan = depthPlan({ background: { mode: "color", color: "#FF0000" } });
		expect(plan.targets[0]!.effectiveMode).toBe("fit");
		const mattePath = await sourceMatte(directory, { width: 320, height: 180 }, "x=0:y=0:w=320:h=180");
		const command = compileCompositionPlanMatteCommand({ plan, targetId: "vertical", mattePath, startSec: 0, source: inspection, outputPath: join(directory, "canvas.mkv"), probePath: join(directory, "probe.gray"), probeTimesSec: [0.55] });
		await productionWorkerProcessModule.execute({ command: "ffmpeg", args: ["-v", "error", ...command.args], signal: new AbortController().signal, deadlineMs: 30_000 });
		const probe = await readFile(join(directory, "probe.gray"));
		const { width, height } = command.size;
		const at = (x: number, y: number) => probe[Math.round(y * height) * width + Math.round(x * width)]!;
		expect(at(0.5, 0.5)).toBeGreaterThan(200);
		expect(at(0.5, 0.05)).toBe(0);
		expect(at(0.5, 0.95)).toBe(0);
	}, 60_000);
});

describe("preparePersonMatte", () => {
	const plan = depthPlan();
	const inspection = { hasVideo: true, hasAudio: false, width: 320, height: 180, fps: 30, durationSec: 2 } as Parameters<typeof preparePersonMatte>[0]["source"];
	const io = {
		writeFile: (path: string, contents: string) => writeFile(path, contents),
		readFile: async (path: string) => new Uint8Array(await readFile(path)),
	};

	test("the spec carries the plan's ranges and regions on the clip window, in source pixels", () => {
		const spec = personMatteSpec({ plan, targetId: "vertical", sourcePath: "s.mp4", startSec: 0, endSec: 2, outputPath: "m.mkv", modelPath: "model.tflite" });
		expect(spec).toMatchObject({ source: "s.mp4", output: "m.mkv", window: [0, 2], size: [320, 180], fps: 15, model: "model.tflite" });
		expect((spec!.ranges as { regions: number[][] }[])[0]!.regions).toEqual([[110, 0, 101, 180]]);
		expect(personMatteSpec({ plan: depthPlan({ heroBehind: false }), targetId: "vertical", sourcePath: "s", startSec: 0, endSec: 2, outputPath: "m", modelPath: "x" })).toBeNull();
	});

	test("typed degradation: a failed model load is unavailable with its reason, a failed pass too", async () => {
		const directory = await scratch();
		const failedModel = await preparePersonMatte({
			plan, targetId: "vertical", sourcePath: "s.mp4", startSec: 0, endSec: 2, source: inspection, directory, python: "python3", modelPath: "missing",
			run: async () => ({ exitCode: 3, stdout: `${JSON.stringify({ error: CAPTION_MATTE_UNAVAILABLE, detail: "model_load_failed: missing" })}\n` }),
			...io,
		});
		expect(failedModel).toEqual({ status: "unavailable", reason: "model_load_failed: missing" });
		const failedPass = await preparePersonMatte({
			plan, targetId: "vertical", sourcePath: "s.mp4", startSec: 0, endSec: 2, source: inspection, directory, python: "python3", modelPath: "m",
			run: async (command) => ({ exitCode: command === "ffmpeg" ? 1 : 0, stdout: "{}" }),
			...io,
		});
		expect(failedPass).toEqual({ status: "unavailable", reason: "matte_pass_failed" });
		expect(await preparePersonMatte({ plan: depthPlan({ heroBehind: false }), targetId: "vertical", sourcePath: "s", startSec: 0, endSec: 2, source: inspection, directory, python: "p", modelPath: "m", run: async () => ({ exitCode: 0, stdout: "" }), ...io })).toEqual({ status: "none" });
	});

	test("a head low in the frame keeps the hero behind; a head at the top of the frame sends it in front", async () => {
		for (const [box, behind] of [["x=0:y=150:w=320:h=30", true], ["x=0:y=0:w=320:h=180", false]] as const) {
			const directory = await scratch();
			const outcome = await preparePersonMatte({
				plan, targetId: "vertical", sourcePath: "s.mp4", startSec: 0, endSec: 2, source: inspection, directory, python: "python3", modelPath: "m",
				run: async (command, args) => {
					if (command !== "ffmpeg") {
						// Stand-in for person_matte.py: write the window-aligned matte the spec asks for.
						const spec = JSON.parse(await readFile(args.at(-1)!, "utf8")) as { output: string };
						await productionWorkerProcessModule.execute({ command: "ffmpeg", args: ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=15:d=2", "-vf", `format=gray,drawbox=${box}:color=white:t=fill`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "gray", spec.output], signal: new AbortController().signal, deadlineMs: 20_000 });
						return { exitCode: 0, stdout: "{}" };
					}
					const result = await productionWorkerProcessModule.execute({ command, args, signal: new AbortController().signal, deadlineMs: 30_000, acceptableExitCodes: [0, 1] });
					return { exitCode: result.exitCode, stdout: "" };
				},
				...io,
			});
			expect(outcome.status).toBe("ready");
			if (outcome.status !== "ready") continue;
			expect([...outcome.placements.values()][0]!.behind).toBe(behind);
			const track = renderCaptionTrack({ layers: captionLayers(plan), canvas: plan.targets[0]!.canvas, behind: outcome.placements });
			const graph = captionBehindGraphInput({ track, matte: outcome, subtitlePath: "/tmp/behind.ass", canvas: plan.targets[0]!.canvas });
			expect(graph === null).toBe(!behind);
			if (graph) {
				expect(graph.box.y % 4).toBe(0);
				expect(graph.box.height % 4).toBe(0);
				expect(graph.windows).toEqual([{ startSec: 0.55, endSec: captionLayers(plan)[0]!.activeRange.endSec }]);
			}
		}
	}, 90_000);
});

const REPO = resolve(import.meta.dir, "../../..");
const MODEL = process.env.PERSON_MATTE_MODEL_PATH ?? join(REPO, "apps/media/models/selfie_segmenter.tflite");
const PYTHON = process.env.PERSON_MATTE_PYTHON ?? "python3";
const runtimeAvailable = existsSync(MODEL) && Bun.spawnSync([PYTHON, "-c", "import ai_edge_litert, numpy, cv2"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

describe.skipIf(!runtimeAvailable)("smoke render with the real matte runtime", () => {
	test("person_matte.py, the matte pass and the render with a behind cue produce a valid video", async () => {
		const directory = await scratch();
		const sourcePath = join(directory, "source.mp4");
		const signal = new AbortController().signal;
		await productionWorkerProcessModule.execute({ command: "ffmpeg", args: ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2", "-pix_fmt", "yuv420p", sourcePath], signal, deadlineMs: 20_000 });
		const source = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal, deadlineMs: 5_000 });
		const plan = depthPlan();
		const outcome = await preparePersonMatte({
			plan, targetId: "vertical", sourcePath, startSec: 0, endSec: 2, source, directory, python: PYTHON, modelPath: MODEL,
			run: async (command, args) => {
				const result = await productionWorkerProcessModule.execute({ command, args, signal, deadlineMs: 60_000, captureStdout: true, acceptableExitCodes: [0, 1, 2, 3] });
				return { exitCode: result.exitCode, stdout: result.stdout.toString("utf8") };
			},
			writeFile: (path, contents) => writeFile(path, contents),
			readFile: async (path) => new Uint8Array(await readFile(path)),
		});
		expect(outcome.status).toBe("ready");
		if (outcome.status !== "ready") return;
		const track = renderCaptionTrack({ layers: captionLayers(plan), canvas: plan.targets[0]!.canvas, behind: outcome.placements });
		// No person in a test pattern: the hero stays behind, unmoved, and the person layer is empty.
		expect([...outcome.placements.values()]).toEqual([{ behind: true, liftPx: 0 }]);
		const frontPath = join(directory, "front.ass");
		const behindPath = join(directory, "behind.ass");
		await writeFile(frontPath, track.ass);
		await writeFile(behindPath, track.behindAss);
		const captionBehind = captionBehindGraphInput({ track, matte: outcome, subtitlePath: behindPath, canvas: plan.targets[0]!.canvas });
		expect(captionBehind).not.toBeNull();
		const outputPath = join(directory, "out.mp4");
		const args = compileClipCompositionCommand({
			sourcePath, outputPath, startSec: 0, endSec: 2, source, plan, targetId: "vertical",
			audio: bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(plan), {}), encoder: { preset: "ultrafast", crf: "23" },
			assets: { subtitlePath: frontPath, captionFontsDirectory: join(REPO, "packages/caption-fonts/fonts"), captionBehind },
		});
		await productionWorkerProcessModule.execute({ command: "ffmpeg", args: ["-v", "error", ...args], signal, deadlineMs: 60_000 });
		const inspected = await productionWorkerProcessModule.inspectMedia({ sourcePath: outputPath, signal, deadlineMs: 5_000 });
		expect(inspected.width).toBe(1080);
		expect(inspected.height).toBe(1920);
		expect(inspected.durationSec).toBeCloseTo(2, 1);
	}, 120_000);
});
