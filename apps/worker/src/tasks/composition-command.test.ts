import { describe, expect, test } from "bun:test";
import { planClipComposition } from "@narriflow/composition-plan";
import {
	bindCompositionPlanAudioInputs,
	compileCompositionPlanAudioSchedule,
} from "../composition-ffmpeg-adapter";
import {
	captionPresetSchema,
	computeSpeechWindows,
	editorDocumentSchema,
	getCaptionPresetById,
	studioEditsSchema,
} from "@narriflow/validators";
import type {
	CaptionPreset,
	StudioEdits,
	TranscriptUtterance,
} from "@narriflow/validators";
import {
	compileClipCompositionCommand,
	compileCompositionPlanCaptions,
	type ClipCompositionCommandInput,
} from "../composition-ffmpeg-adapter";
import { clipRenderAttemptStorageKey } from "../render-object-key";
import { buildClipCutPlan } from "./cut-plan";

type PlannedTestCommand = {
	sourcePath: string;
	outputPath: string;
	startSec: number;
	endSec: number;
	aspectRatio: "9:16" | "1:1" | "16:9" | "4:5";
	probe?: ClipCompositionCommandInput["source"];
	composition: { plan: ClipCompositionCommandInput["plan"]; targetId: string };
	audio: ClipCompositionCommandInput["audio"];
	srtPath: string | null;
	logo?: ClipCompositionCommandInput["assets"]["logo"];
	background?: ClipCompositionCommandInput["assets"]["background"];
	resolvedBrollAssets?: ClipCompositionCommandInput["assets"]["broll"];
	resolvedSceneAssets?: ClipCompositionCommandInput["assets"]["scenes"];
	resolvedSceneFonts?: ClipCompositionCommandInput["assets"]["fonts"];
	cutPlan?: ClipCompositionCommandInput["cutPlan"];
	clipDurationSec?: number;
};
type SingleVideoArgs = PlannedTestCommand;
type BrollVideoArgs = PlannedTestCommand;
type AudiogramArgs = PlannedTestCommand;
function compileFixture(params: PlannedTestCommand) {
	return compileClipCompositionCommand({
		sourcePath: params.sourcePath,
		outputPath: params.outputPath,
		startSec: params.startSec,
		endSec: params.endSec,
		source: params.probe ?? {
			hasVideo: false,
			hasAudio: true,
			hasVisualStream: false,
			width: 0,
			height: 0,
			durationSec: params.endSec - params.startSec,
			fps: 30,
		},
		plan: params.composition.plan,
		targetId: params.composition.targetId,
		audio: params.audio,
		cutPlan: params.cutPlan,
		encoder: { preset: "veryfast", crf: "21" },
		assets: {
			subtitlePath: params.srtPath,
			logo: params.logo,
			background: params.background,
			broll: params.resolvedBrollAssets,
			scenes: params.resolvedSceneAssets,
			fonts: params.resolvedSceneFonts,
		},
	});
}
type VisualTestOptions = {
	captionPreset?: CaptionPreset | null;
	resolution?: "720p" | "1080p";
	watermark?: boolean;
};
type TestMusicInput = {
	path: string;
	ref?: string;
	volume: number;
	startOffsetSec: number;
	fadeInSec?: number;
	fadeOutSec?: number;
	duckingWindows?: Array<{ startSec: number; endSec: number }>;
};
type TestSfxInput = {
	path: string;
	id?: string;
	ref?: string;
	startSec: number;
	volume: number;
	durationSec?: number;
};

type AudioTestOptions = {
	studioEdits?: StudioEdits | null;
	music?: TestMusicInput | null;
	sfx?: TestSfxInput[] | null;
};
type TestSingleVideoArgs = Omit<SingleVideoArgs, "audio"> &
	VisualTestOptions &
	AudioTestOptions;
type TestBrollVideoArgs = Omit<BrollVideoArgs, "audio"> &
	VisualTestOptions &
	AudioTestOptions;
type TestAudiogramArgs = Omit<AudiogramArgs, "audio"> &
	VisualTestOptions &
	AudioTestOptions;

function testComposition(params: {
	aspectRatio: TestSingleVideoArgs["aspectRatio"];
	probe: TestSingleVideoArgs["probe"];
	startSec: number;
	endSec: number;
	cutPlan?: TestSingleVideoArgs["cutPlan"];
	background?: TestSingleVideoArgs["background"];
	captionPreset?: CaptionPreset | null;
	srtPath: string | null;
	studioEdits?: TestSingleVideoArgs["studioEdits"];
	logo?: TestSingleVideoArgs["logo"];
	resolution?: "720p" | "1080p";
	watermark?: boolean;
	brollCutaways?: Array<{
		path: string;
		window: { startSec: number; endSec: number };
	}>;
}): TestSingleVideoArgs["composition"] {
	const canvas = {
		"9:16": { width: 1080, height: 1920 },
		"1:1": { width: 1080, height: 1080 },
		"16:9": { width: 1920, height: 1080 },
		"4:5": { width: 1080, height: 1350 },
	}[params.aspectRatio];
	const duration =
		params.cutPlan && !params.cutPlan.isUncut
			? params.cutPlan.editedDurationSec
			: params.endSec - params.startSec;
	const captionPreset = captionPresetSchema.parse({
		...(params.captionPreset ?? {}),
		visible: params.srtPath ? params.captionPreset?.visible : false,
	});
	const studioEdits = studioEditsSchema.parse({
		...params.studioEdits,
		...(params.music
			? {
					music: {
						url: "https://example.com/test-music.mp3",
						volume: params.music.volume,
						startOffsetSec: params.music.startOffsetSec,
						fadeInSec: params.music.fadeInSec ?? 0,
						fadeOutSec: params.music.fadeOutSec ?? 0,
						ducking: Boolean(params.music.duckingWindows?.length),
					},
				}
			: {}),
		...(params.sfx
			? {
					sfx: params.sfx.map((effect, index) => ({
						id: effect.id ?? `test-sfx-${index}`,
						assetId: "11111111-1111-4111-8111-111111111111",
						startSec: effect.startSec,
						volume: effect.volume,
					})),
				}
			: {}),
		framing: { mode: "center" },
		...(params.background
			? {
					background: {
						mode: params.background.mode,
						color: params.background.color,
						imageUrl:
							params.background.mode === "image"
								? "https://example.com/background.jpg"
								: null,
					},
				}
			: {}),
	});
	const captionTranscript =
		params.srtPath && captionPreset.visible !== false
			? [
					{
						index: 0,
						speaker: 0,
						speakerLabel: "Speaker 1",
						startSec: 0,
						endSec: duration,
						text: "Test",
						confidence: 1,
						words: [
							{
								word: "Test",
								startSec: 0,
								endSec: duration,
								confidence: 1,
							},
						],
					},
				]
			: [];
	const duckingTranscript = (params.music?.duckingWindows ?? []).map(
		(window, index) => ({
			index: captionTranscript.length + index,
			speaker: 0,
			speakerLabel: "Speaker 1",
			startSec: window.startSec + 0.12,
			endSec: window.endSec - 0.12,
			text: "Speech",
			confidence: 1,
			words: [
				{
					word: "Speech",
					startSec: window.startSec + 0.12,
					endSec: window.endSec - 0.12,
					confidence: 1,
				},
			],
		}),
	);
	const transcriptSlice = [...captionTranscript, ...duckingTranscript];
	const result = planClipComposition({
		document: editorDocumentSchema.parse({
			version: 1,
			clipStartSec: 0,
			clipEndSec: duration,
			captionPreset,
			transcriptSlice,
			studioEdits,
			brollUrl: null,
			deletedRanges: [],
		}),
		source: {
			identity: "source:test",
			kind: "video",
			width: params.probe.width,
			height: params.probe.height,
			hasAudio: params.probe.hasAudio,
		},
		evidence: { automaticLayout: { state: "missing" } },
		assets: {
			backgroundImage:
				params.background?.mode === "image" && params.background.imagePath
					? { state: "available", ref: "background:test" }
					: { state: "missing" },
			...(params.logo
				? {
						logo: {
							state: "available" as const,
							ref: "logo:test",
							settings: {
								enabled: true,
								position: params.logo.position,
								opacity: params.logo.opacity,
								scalePct: params.logo.scalePct,
							},
						},
					}
				: {}),
			...(params.music
				? {
						music: {
							state: "available" as const,
							ref: params.music.ref ?? "music:test",
						},
					}
				: {}),
			soundEffects: Object.fromEntries(
				(params.sfx ?? []).map((effect, index) => {
					const id = effect.id ?? `test-sfx-${index}`;
					return [
						id,
						{
							state: "available" as const,
							ref: effect.ref ?? `sfx:${id}`,
							durationSec:
								effect.durationSec ??
								Math.max(0.001, duration - effect.startSec),
						},
					];
				}),
			),
			...(params.brollCutaways
				? {
						broll: {
							state: "available" as const,
							placements: params.brollCutaways.map((cutaway, index) => ({
								id: `cutaway-${index}`,
								ref: `broll:test:${index}`,
								startSec: cutaway.window.startSec,
								endSec: cutaway.window.endSec,
							})),
						},
					}
				: {}),
		},
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v1",
		},
		targets: [
			{
				id: "test-target",
				aspectRatio: params.aspectRatio,
				...canvas,
				outputTreatment: {
					resolution: params.resolution ?? "1080p",
					watermark: params.watermark ?? false,
				},
			},
		],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return { plan: result.plan, targetId: "test-target" };
}

function testAudio(
	composition: SingleVideoArgs["composition"],
	music?: TestMusicInput | null,
	sfx?: TestSfxInput[] | null,
) {
	return bindCompositionPlanAudioInputs(
		compileCompositionPlanAudioSchedule(composition.plan),
		{
			music: music
				? {
						sourceRef: music.ref ?? "music:test",
						path: music.path,
					}
				: null,
			soundEffects: (sfx ?? []).map((effect, index) => {
				const id = effect.id ?? `test-sfx-${index}`;
				return {
					id,
					sourceRef: effect.ref ?? `sfx:${id}`,
					path: effect.path,
				};
			}),
		},
	);
}

function buildSingleVideoArgs(
	params: Omit<TestSingleVideoArgs, "composition"> & {
		composition?: TestSingleVideoArgs["composition"];
	},
) {
	const composition = params.composition ?? testComposition(params);
	return compileFixture({
		...params,
		logo: params.logo ? { ...params.logo, ref: "logo:test" } : params.logo,
		composition,
		audio: testAudio(composition, params.music, params.sfx),
	});
}

function buildAudiogramArgs(
	params: Omit<TestAudiogramArgs, "composition"> & {
		composition?: TestAudiogramArgs["composition"];
	},
) {
	const canvas = {
		"9:16": { width: 1080, height: 1920 },
		"1:1": { width: 1080, height: 1080 },
		"16:9": { width: 1920, height: 1080 },
		"4:5": { width: 1080, height: 1350 },
	}[params.aspectRatio];
	const studioEdits = studioEditsSchema.parse({
		...params.studioEdits,
		...(params.music
			? {
					music: {
						url: "https://example.com/test-music.mp3",
						volume: params.music.volume,
						startOffsetSec: params.music.startOffsetSec,
						fadeInSec: params.music.fadeInSec ?? 0,
						fadeOutSec: params.music.fadeOutSec ?? 0,
						ducking: Boolean(params.music.duckingWindows?.length),
					},
				}
			: {}),
		...(params.sfx
			? {
					sfx: params.sfx.map((effect, index) => ({
						id: effect.id ?? `test-sfx-${index}`,
						assetId: "11111111-1111-4111-8111-111111111111",
						startSec: effect.startSec,
						volume: effect.volume,
					})),
				}
			: {}),
	});
	const duckingTranscript = (params.music?.duckingWindows ?? []).map(
		(window, index) => ({
			index,
			speaker: 0,
			speakerLabel: "Speaker 1",
			startSec: window.startSec + 0.12,
			endSec: window.endSec - 0.12,
			text: "Speech",
			confidence: 1,
			words: [
				{
					word: "Speech",
					startSec: window.startSec + 0.12,
					endSec: window.endSec - 0.12,
					confidence: 1,
				},
			],
		}),
	);
	const captionPreset = captionPresetSchema.parse({
		...(params.captionPreset ?? {}),
		visible: params.srtPath ? params.captionPreset?.visible : false,
	});
	const result = planClipComposition({
		document: editorDocumentSchema.parse({
			version: 1,
			clipStartSec: 0,
			clipEndSec: params.clipDurationSec,
			captionPreset,
			transcriptSlice: duckingTranscript,
			studioEdits,
			brollUrl: null,
			deletedRanges: [],
		}),
		source: { identity: "audio:test", kind: "audio", width: 0, height: 0 },
		evidence: { automaticLayout: { state: "missing" } },
		assets: {
			backgroundImage: { state: "missing" },
			...(params.music && (studioEdits.music.assetId || studioEdits.music.url)
				? { music: { state: "available" as const, ref: "music:test" } }
				: {}),
			soundEffects: Object.fromEntries(
				studioEdits.sfx.map((placement, index) => [
					placement.id,
					params.sfx?.[index]
						? {
								state: "available" as const,
								ref: `sfx:${placement.id}`,
								durationSec:
									params.sfx[index]?.durationSec ??
									Math.max(0.001, params.clipDurationSec - placement.startSec),
							}
						: { state: "failed" as const },
				]),
			),
			...(params.logo
				? {
						logo: {
							state: "available" as const,
							ref: "logo:test",
							settings: {
								enabled: true,
								position: params.logo.position,
								opacity: params.logo.opacity,
								scalePct: params.logo.scalePct,
							},
						},
					}
				: {}),
		},
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v1",
		},
		targets: [
			{
				id: "test-target",
				aspectRatio: params.aspectRatio,
				...canvas,
				outputTreatment: {
					resolution: params.resolution ?? "1080p",
					watermark: params.watermark ?? false,
				},
			},
		],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	const composition = params.composition ?? {
		plan: result.plan,
		targetId: "test-target",
	};
	return compileFixture({
		...params,
		logo: params.logo ? { ...params.logo, ref: "logo:test" } : params.logo,
		composition,
		audio: testAudio(composition, params.music, params.sfx),
	});
}

function buildBrollVideoArgs(
	params: Omit<TestBrollVideoArgs, "composition" | "resolvedBrollAssets"> & {
		cutaways: Array<{
			path: string;
			window: { startSec: number; endSec: number };
		}>;
		composition?: TestBrollVideoArgs["composition"];
	},
) {
	const { cutaways, ...rest } = params;
	const composition =
		params.composition ??
		testComposition({ ...params, brollCutaways: cutaways });
	return compileFixture({
		...rest,
		logo: rest.logo ? { ...rest.logo, ref: "logo:test" } : rest.logo,
		resolvedBrollAssets: Object.fromEntries(
			cutaways.map((cutaway, index) => [`broll:test:${index}`, cutaway.path]),
		),
		composition,
		audio: testAudio(composition, params.music, params.sfx),
	});
}

function makeUtterance(
	words: Array<[string, number, number]>,
): TranscriptUtterance {
	return {
		index: 0,
		speaker: 0,
		speakerLabel: "Speaker 1",
		startSec: words[0]![1],
		endSec: words[words.length - 1]![2],
		text: words.map(([w]) => w).join(" "),
		confidence: 0.95,
		words: words.map(([word, startSec, endSec]) => ({
			word,
			startSec,
			endSec,
			confidence: 0.95,
		})),
	};
}

function preset(id: string): CaptionPreset {
	const found = getCaptionPresetById(id);
	if (!found) throw new Error(`missing preset ${id}`);
	return found.preset;
}

test("planned ASS serialization preserves the planner's punctuation filtering and cue boundaries", () => {
	const document = editorDocumentSchema.parse({
		version: 1,
		clipStartSec: 0,
		clipEndSec: 2,
		captionPreset: { ...preset("karaoke"), punctuation: false },
		transcriptSlice: [
			makeUtterance([
				["one", 0, 0.3],
				["...", 0.3, 0.5],
				["two", 0.5, 0.8],
				["three", 0.8, 1.1],
				["four", 1.1, 1.4],
			]),
		],
	});
	const result = planClipComposition({
		document,
		source: {
			identity: "source:caption",
			kind: "video",
			width: 1920,
			height: 1080,
		},
		evidence: { automaticLayout: { state: "missing" } },
		assets: { backgroundImage: { state: "missing" } },
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v1",
		},
		targets: [
			{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
		],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	const target = result.plan.targets[0]!;
	const layers = target.visualLayers.filter(
		(layer) => layer.kind === "caption",
	);
	const ass = compileCompositionPlanCaptions(result.plan, target.id);

	expect(layers.map((layer) => layer.words.map((word) => word.text))).toEqual([
		["ONE", "TWO", "THREE"],
		["FOUR"],
	]);
	expect([...new Set(ass.split("\n")
		.filter((line) => line.startsWith("Dialogue:"))
		.map((line) => line.split(",").slice(1, 3).join(",")))])
		.toEqual([
			"0:00:00.00,0:00:00.50",
			"0:00:00.50,0:00:00.80",
			"0:00:00.80,0:00:01.10",
			"0:00:01.10,0:00:01.40",
		]);
	expect(ass).not.toContain("...");
});

describe("buildSingleVideoArgs with a canvas background active", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};

	test("color Fit plan compiles its explicit full-source crop and pad", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			background: { mode: "color", color: "#112233", imagePath: null },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("pad=1080:1920");
		expect(graph).toContain("color=0x112233");
		expect(graph).toContain("crop=1920:1080:0:0");
		expect(args.filter((a) => a === "-i")).toHaveLength(1); // source only
	});

	test("image mode adds the background image as its own -i before the logo input", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			logo: {
				filePath: "/tmp/logo.png",
				position: "bot-right",
				opacity: 80,
				scalePct: 15,
			},
			background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
		});
		const iIndexes = args
			.map((a, i) => (a === "-i" ? i : -1))
			.filter((i) => i >= 0);
		expect(iIndexes).toHaveLength(3); // source, background image, logo
		expect(args[iIndexes[0]! + 1]).toBe("/tmp/src.mp4");
		expect(args[iIndexes[1]! + 1]).toBe("/tmp/bg.png");
		expect(args[iIndexes[2]! + 1]).toBe("/tmp/logo.png");

		const graph = args[args.indexOf("-filter_complex") + 1]!;
		// fps=30 pinned from probe.fps (Opus review Finding 1 — overlay's output
		// otherwise inherits the still image's demuxer-default 25fps).
		expect(graph).toContain(
			"[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[composition_bg]",
		);
		// The visual-plan adapter overlays the planned logo on the composed base;
		// input index shifts to 2 because the background image occupies input 1.
		expect(graph).toContain("[composition_base][composition_logo_0]overlay=");
		expect(graph).toContain("[2:v]scale=");
	});

	test("pins the [bgimg] chain's fps to the probed source rate (not the default)", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe: { ...probe, fps: 59.94 },
			srtPath: null,
			background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain(",fps=59.94[composition_bg]");
	});

	test("music input index shifts correctly when a background image input is present", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			logo: {
				filePath: "/tmp/logo.png",
				position: "bot-right",
				opacity: 80,
				scalePct: 15,
			},
			music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
			background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
		});
		const iIndexes = args
			.map((a, i) => (a === "-i" ? i : -1))
			.filter((i) => i >= 0);
		// 0=source, 1=background image, 2=logo, 3=music
		expect(iIndexes).toHaveLength(4);
		expect(args[iIndexes[1]! + 1]).toBe("/tmp/bg.png");
		expect(args[iIndexes[2]! + 1]).toBe("/tmp/logo.png");
		expect(args[iIndexes[3]! + 1]).toBe("/tmp/music.mp3");

		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("[3:a]atrim=");
	});

	test("reframe is ignored (no crop@reframe) when a background is active", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			background: { mode: "color", color: "#112233", imagePath: null },
			reframe: { scriptPath: "/tmp/r.txt", cropName: "crop@reframe" },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).not.toContain("crop@reframe");
		expect(graph).not.toContain("sendcmd");
		expect(graph).toContain("pad=1080:1920");
	});

	test("without a background, the graph is unchanged (crop+scale, no extra input)", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("crop=");
		expect(graph).not.toContain("pad=");
		expect(args.filter((a) => a === "-i")).toHaveLength(1);
	});
});

describe("export treatment: resolution + watermark (vizard-parity Phase C export options)", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};
	const SCALE_FRAGMENT = "scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2";
	const WATERMARK_FRAGMENT = "drawtext=text=Made with Narriflow";

	/** The `;`-delimited filter-graph section whose output pad is `label`
	 *  (e.g. "[outvfree]") — lets assertions check what feeds a given stage
	 *  without depending on the drawtext option list's exact contents. */
	function stageEndingIn(graph: string, label: string): string {
		const stage = graph.split(";").find((section) => section.endsWith(label));
		if (!stage) throw new Error(`no filter-graph stage ends in ${label}`);
		return stage;
	}

	describe("buildSingleVideoArgs", () => {
		test("720p row adds the 2/3 downscale, 1080p row doesn't", () => {
			const at720p = buildSingleVideoArgs({
				sourcePath: "/tmp/src.mp4",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 10,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
				resolution: "720p",
			});
			const at1080p = buildSingleVideoArgs({
				sourcePath: "/tmp/src.mp4",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 10,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
				resolution: "1080p",
			});
			const graph720 = at720p[at720p.indexOf("-filter_complex") + 1]!;
			const graph1080 = at1080p[at1080p.indexOf("-filter_complex") + 1]!;
			expect(graph720).toContain(SCALE_FRAGMENT);
			expect(graph720).toContain("[outv]");
			expect(at720p).toContain("[outv]"); // mapped as the final output
			expect(graph1080).not.toContain(SCALE_FRAGMENT);
			expect(graph1080).not.toContain("[outvfree]");
		});

		test("omitting resolution behaves like 1080p (no downscale)", () => {
			const args = buildSingleVideoArgs({
				sourcePath: "/tmp/src.mp4",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 10,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;
			expect(graph).not.toContain(SCALE_FRAGMENT);
			expect(graph).not.toContain("drawtext=");
		});

		test("watermark is present iff entitlement is absent, independent of resolution", () => {
			const noWatermark1080 = buildSingleVideoArgs({
				sourcePath: "/tmp/src.mp4",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 10,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
				resolution: "1080p",
				watermark: false,
			});
			const watermarked1080 = buildSingleVideoArgs({
				sourcePath: "/tmp/src.mp4",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 10,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
				resolution: "1080p",
				watermark: true,
			});
			const graphNoWatermark =
				noWatermark1080[noWatermark1080.indexOf("-filter_complex") + 1]!;
			const graphWatermarked =
				watermarked1080[watermarked1080.indexOf("-filter_complex") + 1]!;
			expect(graphNoWatermark).not.toContain("drawtext=");
			// A paid user on 1080p still gets no watermark and no downscale.
			expect(graphNoWatermark).not.toContain(SCALE_FRAGMENT);
			expect(graphWatermarked).toContain(WATERMARK_FRAGMENT);
			// Watermark alone (1080p) never triggers the 720p downscale.
			expect(graphWatermarked).not.toContain(SCALE_FRAGMENT);
		});

		test("720p + watermark combine into a single trailing filter stage", () => {
			const args = buildSingleVideoArgs({
				sourcePath: "/tmp/src.mp4",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 10,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
				resolution: "720p",
				watermark: true,
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;
			// Exactly one final visual-plan stage carries both fragments, comma-joined —
			// scale before drawtext (a filter chain is order-dependent: drawtext
			// computing font size off `h` must see the already-downscaled frame).
			const stage = graph
				.split(";")
				.find((section) => section.endsWith("[outv]"))!;
			expect(stage).toContain(`${SCALE_FRAGMENT},${WATERMARK_FRAGMENT}`);
			expect(args).toContain("[outv]");
		});

		test("combined with a canvas background and a fade transition, the map target is the planned final output", () => {
			const studioEdits = studioEditsSchema.parse({
				transition: { type: "fade", durationSec: 0.4 },
			});
			const args = buildSingleVideoArgs({
				sourcePath: "/tmp/src.mp4",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 10,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
				background: { mode: "color", color: "#112233", imagePath: null },
				studioEdits,
				resolution: "720p",
				watermark: true,
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;
			expect(graph).toContain("pad=1080:1920"); // background still applied
			expect(graph).toContain("fade=t=in"); // transition still applied
			const stage = stageEndingIn(graph, "[outv]");
			expect(stage).toContain(SCALE_FRAGMENT);
			expect(stage).toContain(WATERMARK_FRAGMENT);
			expect(args[args.indexOf("-map") + 1]).toBe("[outv]");
		});
	});

	describe("buildBrollVideoArgs", () => {
		test("720p + watermark fold in after the b-roll overlay chain", () => {
			const args = buildBrollVideoArgs({
				sourcePath: "/tmp/src.mp4",
				cutaways: [
					{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } },
				],
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 20,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
				resolution: "720p",
				watermark: true,
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;
			expect(graph).toContain("overlay=0:0:enable='gte(t,2)*lt(t,5)'");
			const stage = stageEndingIn(graph, "[outv]");
			expect(stage).toContain(SCALE_FRAGMENT);
			expect(stage).toContain(WATERMARK_FRAGMENT);
			expect(args[args.indexOf("-map") + 1]).toBe("[outv]");
		});

		test("neither flag set: no [outvfree] stage, maps the plain composited output", () => {
			const args = buildBrollVideoArgs({
				sourcePath: "/tmp/src.mp4",
				cutaways: [
					{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } },
				],
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 20,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;
			expect(graph).not.toContain("[outvfree]");
			const mapTarget = args[args.indexOf("-map") + 1]!;
			expect(mapTarget).toBe("[outv]");
			expect(graph).toContain("overlay=0:0:enable='gte(t,2)*lt(t,5)'[stage0]");
		});
	});

	describe("buildAudiogramArgs", () => {
		test("720p + watermark fold in after the waveform/caption chain", () => {
			const args = buildAudiogramArgs({
				sourcePath: "/tmp/a.mp3",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 10,
				aspectRatio: "9:16",
				clipDurationSec: 10,
				srtPath: null,
				resolution: "720p",
				watermark: true,
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;
			expect(graph).toContain("showwaves=");
			const stage = stageEndingIn(graph, "[composition_visual]");
			expect(stage).toContain(SCALE_FRAGMENT);
			expect(stage).toContain(WATERMARK_FRAGMENT);
			expect(args[args.indexOf("-map") + 1]).toBe("[outv]");
		});

		test("neither flag set: no [outvfree] stage, maps the plain output", () => {
			const args = buildAudiogramArgs({
				sourcePath: "/tmp/a.mp3",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 10,
				aspectRatio: "9:16",
				clipDurationSec: 10,
				srtPath: null,
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;
			expect(graph).not.toContain("[outvfree]");
			expect(args[args.indexOf("-map") + 1]).toBe("[outv]");
		});
	});
});

describe("buildBrollVideoArgs with a canvas background active", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};

	test("cutaway input indices shift by 1 when a background image occupies input 1", () => {
		const args = buildBrollVideoArgs({
			sourcePath: "/tmp/src.mp4",
			cutaways: [
				{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } },
			],
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
		});
		const iIndexes = args
			.map((a, i) => (a === "-i" ? i : -1))
			.filter((i) => i >= 0);
		expect(iIndexes).toHaveLength(3); // source, background image, b-roll
		expect(args[iIndexes[1]! + 1]).toBe("/tmp/bg.png");
		expect(args[iIndexes[2]! + 1]).toBe("/tmp/broll.mp4");

		const graph = args[args.indexOf("-filter_complex") + 1]!;
		// The plan adapter composes Fit as the base, then applies its B-roll layer.
		expect(graph).toContain(
			"[composition_bg][composition_source]overlay=0:656,format=yuv420p[composition_base]",
		);
		expect(graph).toContain(
			"[2:v]scale=1080:1920:force_original_aspect_ratio=increase",
		);
		// fps pinned from probe.fps on the [bgimg] chain specifically.
		expect(graph).toContain(",fps=30[composition_bg]");
	});

	test("music input index [N:a] shifts correctly with a background image AND cutaways present", () => {
		const args = buildBrollVideoArgs({
			sourcePath: "/tmp/src.mp4",
			cutaways: [
				{ path: "/tmp/broll-0.mp4", window: { startSec: 2, endSec: 5 } },
				{ path: "/tmp/broll-1.mp4", window: { startSec: 8, endSec: 11 } },
			],
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
			logo: {
				filePath: "/tmp/logo.png",
				position: "top-right",
				opacity: 100,
				scalePct: 12,
			},
			music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
		});
		const iIndexes = args
			.map((a, i) => (a === "-i" ? i : -1))
			.filter((i) => i >= 0);
		// 0=source, 1=background image, 2-3=b-roll, 4=logo, 5=music
		expect(iIndexes).toHaveLength(6);
		expect(args[iIndexes[1]! + 1]).toBe("/tmp/bg.png");
		expect(args[iIndexes[2]! + 1]).toBe("/tmp/broll-0.mp4");
		expect(args[iIndexes[3]! + 1]).toBe("/tmp/broll-1.mp4");
		expect(args[iIndexes[4]! + 1]).toBe("/tmp/logo.png");
		expect(args[iIndexes[5]! + 1]).toBe("/tmp/music.mp3");

		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("[5:a]atrim=");
	});

	test("reframe is ignored (no crop@reframe) when a background is active", () => {
		const args = buildBrollVideoArgs({
			sourcePath: "/tmp/src.mp4",
			cutaways: [
				{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } },
			],
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			background: { mode: "color", color: "#112233", imagePath: null },
			reframe: { scriptPath: "/tmp/r.txt", cropName: "crop@reframe" },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).not.toContain("crop@reframe");
		expect(graph).not.toContain("sendcmd");
		expect(graph).toContain("pad=1080:1920");
	});
});

describe("buildBrollVideoArgs (B-roll cutaway)", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};

	test("overlays a single b-roll cutaway only during its window, keeps source audio", () => {
		const args = buildBrollVideoArgs({
			sourcePath: "/tmp/src.mp4",
			cutaways: [
				{ path: "/tmp/broll.mp4", window: { startSec: 8, endSec: 11.5 } },
			],
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 30,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			captionPreset: getCaptionPresetById("karaoke")!.preset,
		});
		const fi = args.indexOf("-filter_complex");
		const graph = args[fi + 1]!;
		// b-roll is input [1] and is cover-fit then overlaid within the window
		expect(args.filter((a) => a === "-i")).toHaveLength(2);
		expect(graph).toContain("force_original_aspect_ratio=increase");
		expect(graph).toContain("overlay=0:0:enable='gte(t,8)*lt(t,11.5)'");
		// source audio is routed through the boundary fade, not the b-roll's
		expect(graph).toContain("[0:a:0]afade=t=in");
		expect(args).toContain("[outa]");
	});

	test("chains multiple recurring cutaways through successive overlay stages", () => {
		const args = buildBrollVideoArgs({
			sourcePath: "/tmp/src.mp4",
			cutaways: [
				{ path: "/tmp/broll-0.mp4", window: { startSec: 3, endSec: 6 } },
				{ path: "/tmp/broll-1.mp4", window: { startSec: 12, endSec: 15 } },
				{ path: "/tmp/broll-2.mp4", window: { startSec: 21, endSec: 24 } },
			],
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 30,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
		});

		// source + 3 b-roll inputs
		expect(args.filter((a) => a === "-i")).toHaveLength(4);

		const fi = args.indexOf("-filter_complex");
		const graph = args[fi + 1]!;
		expect(graph).toContain("overlay=0:0:enable='gte(t,3)*lt(t,6)'");
		expect(graph).toContain("overlay=0:0:enable='gte(t,12)*lt(t,15)'");
		expect(graph).toContain("overlay=0:0:enable='gte(t,21)*lt(t,24)'");
		// Each overlay stage feeds the next (chained, not independent/parallel).
		expect(graph).toContain("[composition_broll_stage_0]");
		expect(graph).toContain("[composition_broll_stage_1]");

		// Every b-roll input is trimmed to its own window's duration.
		const iIndexes: number[] = [];
		args.forEach((a, i) => {
			if (a === "-i") iIndexes.push(i);
		});
		expect(args[iIndexes[1]! - 2]).toBe("-t");
		expect(args[iIndexes[1]! - 1]).toBe("3.000");
		expect(args[iIndexes[2]! - 2]).toBe("-t");
		expect(args[iIndexes[2]! - 1]).toBe("3.000");
		expect(args[iIndexes[3]! - 2]).toBe("-t");
		expect(args[iIndexes[3]! - 1]).toBe("3.000");

		// Output-level -t still bounds the whole render to the clip's duration.
		const tIndexes = indexesOf(args, "-t");
		const outputTIndex = tIndexes[tIndexes.length - 1]!;
		expect(args[outputTIndex + 1]).toBe("30.000");
		expect(outputTIndex).toBeGreaterThan(fi);
	});

	test("shifts the logo/music input indices by the number of cutaways", () => {
		const args = buildBrollVideoArgs({
			sourcePath: "/tmp/src.mp4",
			cutaways: [
				{ path: "/tmp/broll-0.mp4", window: { startSec: 3, endSec: 6 } },
				{ path: "/tmp/broll-1.mp4", window: { startSec: 12, endSec: 15 } },
			],
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 30,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			logo: {
				filePath: "/tmp/logo.png",
				position: "top-right",
				opacity: 100,
				scalePct: 12,
			},
			music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
		});

		const fi = args.indexOf("-filter_complex");
		const graph = args[fi + 1]!;
		// logo is input [3] (0=source, 1-2=broll, 3=logo), music is input [4]
		expect(graph).toContain("[3:v]");
		expect(graph).toContain("[4:a]");
	});
});

describe("buildAudiogramArgs (audio-only renders)", () => {
	test("builds an animated waveform over a background with the preset color", () => {
		const args = buildAudiogramArgs({
			sourcePath: "/tmp/a.mp3",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 30,
			aspectRatio: "9:16",
			clipDurationSec: 30,
			srtPath: null,
			captionPreset: getCaptionPresetById("karaoke")!.preset,
		});
		const filterIdx = args.indexOf("-filter_complex");
		expect(filterIdx).toBeGreaterThan(-1);
		const graph = args[filterIdx + 1]!;
		expect(graph).toContain("showwaves");
		expect(graph).toContain("overlay");
		// karaoke highlight #00FF88 -> 0x00FF88
		expect(graph).toContain("colors=0x00FF88");
		// maps the composited video + the fade-wrapped source audio
		expect(args).toContain("[outv]");
		expect(args).toContain("[outa]");
		expect(graph).toContain("afade=t=out");
	});
});

describe("subtitle visibility toggle (vizard-parity Phase C) — captionPreset.visible === false gates every render path", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};
	const captionPresetVisible = getCaptionPresetById("karaoke")!.preset;
	const captionPresetHidden = { ...captionPresetVisible, visible: false };

	test("buildSingleVideoArgs: visible=true burns the ASS filter, visible=false omits it entirely", () => {
		const shown = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: "/tmp/clip.ass",
			captionPreset: captionPresetVisible,
		});
		expect(shown[shown.indexOf("-filter_complex") + 1]).toContain("ass=");

		const hidden = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: "/tmp/clip.ass",
			captionPreset: captionPresetHidden,
		});
		expect(hidden[hidden.indexOf("-filter_complex") + 1]).not.toContain("ass=");
	});

	test("buildBrollVideoArgs: visible=false omits the ASS filter but keeps the cutaway overlay", () => {
		const hidden = buildBrollVideoArgs({
			sourcePath: "/tmp/src.mp4",
			cutaways: [
				{ path: "/tmp/broll.mp4", window: { startSec: 1, endSec: 3 } },
			],
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: "/tmp/clip.ass",
			captionPreset: captionPresetHidden,
		});
		const graph = hidden[hidden.indexOf("-filter_complex") + 1]!;
		expect(graph).not.toContain("ass=");
		expect(graph).toContain("overlay=0:0:enable=");
	});

	test("buildAudiogramArgs: visible=false omits the ASS filter but keeps the waveform", () => {
		const hidden = buildAudiogramArgs({
			sourcePath: "/tmp/a.mp3",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 30,
			aspectRatio: "9:16",
			clipDurationSec: 30,
			srtPath: "/tmp/clip.ass",
			captionPreset: captionPresetHidden,
		});
		const graph = hidden[hidden.indexOf("-filter_complex") + 1]!;
		expect(graph).not.toContain("ass=");
		expect(graph).toContain("showwaves");
	});
});

function indexesOf(args: string[], value: string): number[] {
	const result: number[] = [];
	args.forEach((arg, index) => {
		if (arg === value) result.push(index);
	});
	return result;
}

// General assertion helper (multi-model review fix #1): ffmpeg does NOT fan
// a named filter pad out to multiple consumers implicitly — only `[0:a]`/
// `[0:v]` style raw input-stream refs get that behavior. Feeding a pad like
// `[acat]` into two filters without an explicit `asplit`/`split` silently
// rebinds the second consumer to the raw uncut input, which is exactly how
// the audiogram double-consumption bug leaked deleted audio into exports.
// This counts how many times `label` appears as a LEADING (input) pad
// reference across every filter spec in a `-filter_complex` graph — output
// pad references (which always trail the filter's own text) are excluded by
// construction, since the leading-bracket-run regex stops at the first
// non-bracket character.
function countLabelConsumptions(graph: string, label: string): number {
	const specs = graph.split(";");
	let count = 0;
	for (const spec of specs) {
		const leadingRun = spec.match(/^(\[[^\]]+\])+/);
		if (!leadingRun) continue;
		const leadingLabels = leadingRun[0].match(/\[[^\]]+\]/g) ?? [];
		count += leadingLabels.filter((candidate) => candidate === label).length;
	}
	return count;
}

/** Asserts `label` (e.g. `"[acat]"`) is consumed as a filter input EXACTLY
 *  once across the whole graph — the general form of the fix #1 regression
 *  check, reusable for any builder's cut-concat output labels. */
function expectLabelConsumedOnce(graph: string, label: string) {
	expect(countLabelConsumptions(graph, label)).toBe(1);
}

describe("output duration bound (FIX: over-long B-roll/inputs can no longer stretch the output)", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};

	test("buildSingleVideoArgs adds an explicit output -t in addition to the input -t", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 5,
			endSec: 25, // 20s clip
			aspectRatio: "9:16",
			probe,
			srtPath: null,
		});

		const tIndexes = indexesOf(args, "-t");
		// one input-level -t (trims input 0) + one output-level -t (bounds the file)
		expect(tIndexes).toHaveLength(2);
		expect(args[tIndexes[0]! + 1]).toBe("20");
		expect(args[tIndexes[1]! + 1]).toBe("20.000");
		// the output -t sits in the output-option section, after -filter_complex
		expect(tIndexes[1]!).toBeGreaterThan(args.indexOf("-filter_complex"));
	});

	test("buildBrollVideoArgs trims the b-roll input to its own cutaway window and still bounds total output duration", () => {
		// Regression check for the measured bug: a 20s clip with a much longer
		// b-roll asset (e.g. 25s) starting its cutaway at 5.6s used to produce a
		// ~30.6s output, because the untrimmed b-roll input (input [1]) ran past
		// the (correctly trimmed) 20s main input, and overlay's default
		// shortest=0 stretches the output to the longer of the two.
		const args = buildBrollVideoArgs({
			sourcePath: "/tmp/src.mp4",
			cutaways: [
				{ path: "/tmp/broll.mp4", window: { startSec: 5.6, endSec: 9.1 } }, // a 3.5s cutaway window
			],
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20, // 20s clip
			aspectRatio: "9:16",
			probe,
			srtPath: null,
		});

		const iIndexes = indexesOf(args, "-i");
		expect(iIndexes).toHaveLength(2); // source, then b-roll

		// The b-roll's own -t (immediately preceding its -i) is scoped to just
		// the 3.5s cutaway window — never the full length of whatever asset was
		// downloaded (previously untrimmed, however long the source file was).
		expect(args[iIndexes[1]! - 2]).toBe("-t");
		expect(args[iIndexes[1]! - 1]).toBe("3.500");

		// Output-level -t bounds the whole render to the clip's own 20s duration
		// regardless of the (now-trimmed) b-roll input.
		const tIndexes = indexesOf(args, "-t");
		const outputTIndex = tIndexes[tIndexes.length - 1]!;
		expect(args[outputTIndex + 1]).toBe("20.000");
		expect(outputTIndex).toBeGreaterThan(args.indexOf("-filter_complex"));
	});

	test("buildAudiogramArgs adds an explicit -t alongside -shortest", () => {
		const args = buildAudiogramArgs({
			sourcePath: "/tmp/a.mp3",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 12,
			aspectRatio: "9:16",
			clipDurationSec: 12,
			srtPath: null,
		});

		const shortestIdx = args.indexOf("-shortest");
		expect(shortestIdx).toBeGreaterThan(-1);
		expect(args[shortestIdx + 1]).toBe("-t");
		expect(args[shortestIdx + 2]).toBe("12.000");
	});
});

describe("music mixing (FIX: no more quiet 6dB dialogue duck + startOffsetSec)", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};

	test("mixes at unity gain (normalize=0) and applies volume only to the music branch", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			music: { path: "/tmp/music.mp3", volume: 40, startOffsetSec: 12 },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;

		// amix must disable automatic 1/N normalization (previously missing —
		// ffmpeg's default silently dropped the dialogue ~6dB for a 2-input mix).
		expect(graph).toContain(
			"amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
		);
		// the music's own volume (40/100) is applied explicitly on its branch...
		expect(graph).toContain("volume=0.400");
		// ...and the dialogue (0:a) branch is never itself scaled down.
		expect(graph).not.toMatch(/\[0:a\][^;]*volume=/);
	});

	test("honors studioEdits.music.startOffsetSec by seeking into the (looped) music input", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			music: { path: "/tmp/music.mp3", volume: 40, startOffsetSec: 12 },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("atrim=start=12.000:duration=20.000");
	});

	test("defaults the offset to 0 when startOffsetSec is 0", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			music: { path: "/tmp/music.mp3", volume: 35, startOffsetSec: 0 },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("atrim=start=0.000:duration=10.000");
	});
});

describe("SFX one-shot mixing (vizard-parity.md Music/SFX library)", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};

	test("adelay ms rounding: startSec=1.2345 rounds to 1235ms, all=1 delays every channel", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			sfx: [{ path: "/tmp/sfx.mp3", startSec: 1.2345, volume: 80 }],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("adelay=1235:all=1");
	});

	test("volume mapping: 0-100 scale maps to a 0-1 volume= fragment", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			sfx: [{ path: "/tmp/sfx.mp3", startSec: 0, volume: 42 }],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("adelay=0:all=1,volume=0.420");
	});

	test("truncates the SFX branch at the clip's own end via atrim=duration", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 15,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			sfx: [{ path: "/tmp/sfx.mp3", startSec: 10, volume: 80 }],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain(
			"adelay=10000:all=1,volume=0.800,atrim=duration=15.000,apad,atrim=duration=15.000",
		);
	});

	test("SFX with no music: dialogue + one SFX branch mix at inputs=2", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			sfx: [{ path: "/tmp/sfx.mp3", startSec: 2, volume: 80 }],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("[0:a]");
		expect(graph).toContain("[1:a]adelay=2000");
		expect(graph).toContain(
			"[maina][sfx0a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
		);
		// Mixed audio (music or sfx) always maps -shortest, same as the music path.
		expect(args).toContain("-shortest");
	});

	test("SFX with music: dialogue + music + SFX mix at inputs=3, music branch still gets its own volume/fade", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			music: { path: "/tmp/music.mp3", volume: 30, startOffsetSec: 0 },
			sfx: [{ path: "/tmp/sfx.mp3", startSec: 2, volume: 80 }],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		// music is input 1, sfx is input 2 (source=0, no bg/logo).
		expect(graph).toContain("[1:a]atrim=start=0.000");
		expect(graph).toContain("[2:a]adelay=2000");
		expect(graph).toContain(
			"[maina][musica][sfx0a]amix=inputs=3:duration=first:dropout_transition=0:normalize=0",
		);
	});

	test("SFX with muted source audio: dialogue branch still participates in the mix at volume=0", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			studioEdits: studioEditsSchema.parse({
				sourceAudio: { volume: 100, muted: true },
			}),
			sfx: [{ path: "/tmp/sfx.mp3", startSec: 1, volume: 80 }],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain(
			"[0:a]atrim=duration=10.000,asetpts=PTS-STARTPTS,volume=0.000[maina]",
		);
		expect(graph).toContain("amix=inputs=2");
	});

	test("SFX with absent source audio: mix contains only the SFX branch(es), no dialogue, and the SFX branch still fills the full clip duration", () => {
		const noAudioProbe = { ...probe, hasAudio: false };
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe: noAudioProbe,
			srtPath: null,
			sfx: [{ path: "/tmp/sfx.mp3", startSec: 1, volume: 80 }],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		// Single branch (no dialogue, no music): no amix at all, just the SFX
		// branch feeding straight into the fixed click-guard fade chain.
		expect(graph).not.toContain("amix=");
		expect(graph).toContain("[sfx0a]afade=t=in");
		expect(args).toContain("-shortest");
		// H1 fix: `apad` before `atrim=duration=10.000` guarantees the SOLE
		// branch driving `-shortest` is exactly the clip's own duration, not
		// whatever's left of a short SFX file after `adelay` — without `apad`,
		// this branch (and the whole encode via `-shortest`) truncated to
		// ~1s + the SFX file's own length instead of the full 10s clip.
		expect(graph).toContain(
			"volume=0.800,atrim=duration=10.000,apad,atrim=duration=10.000",
		);
	});

	test("every SFX branch pads with apad before its atrim=duration bound (H1: atrim alone is a max, not a pad)", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			sfx: [
				{ path: "/tmp/sfx-a.mp3", startSec: 1, volume: 80 },
				{ path: "/tmp/sfx-b.mp3", startSec: 3, volume: 50 },
			],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		const sfxBranches = graph
			.split(";")
			.filter((part) => /^\[\d+:a\]adelay=/.test(part));
		expect(sfxBranches.length).toBe(2);
		for (const branch of sfxBranches) {
			expect(branch).toMatch(/,apad,atrim=duration=\d+\.\d{3}/);
		}
	});

	test("skip-beyond-duration: a placement whose startSec >= clipDurationSec is dropped from the mix", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			sfx: [
				{ path: "/tmp/sfx-early.mp3", startSec: 2, volume: 80 },
				{ path: "/tmp/sfx-late.mp3", startSec: 10, volume: 80 }, // >= clip duration
			],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		// Both inputs still get pushed (harmless unused input for the dropped
		// one — see buildAudioMixFilter's doc comment), but only the first is
		// referenced in the mix.
		expect(graph).toContain("[sfx0a]");
		expect(graph).not.toContain("[sfx1a]");
		expect(graph).toContain("amix=inputs=2"); // dialogue + the one surviving sfx branch
	});

	test("input index bookkeeping: background image + logo + music + 2 SFX placements all coexist", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			logo: {
				filePath: "/tmp/logo.png",
				position: "top-right",
				opacity: 100,
				scalePct: 12,
			},
			background: { mode: "image", color: "#000000", imagePath: "/tmp/bg.png" },
			music: { path: "/tmp/music.mp3", volume: 30, startOffsetSec: 0 },
			sfx: [
				{ path: "/tmp/sfx-a.mp3", startSec: 1, volume: 80 },
				{ path: "/tmp/sfx-b.mp3", startSec: 3, volume: 80 },
			],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		// 0=source, 1=bg image, 2=logo, 3=music, 4-5=sfx.
		expect(graph).toContain("[3:a]atrim=start=0.000");
		expect(graph).toContain("[4:a]adelay=1000");
		expect(graph).toContain("[5:a]adelay=3000");
		expect(graph).toContain("amix=inputs=4");
	});
});

describe("buildBrollVideoArgs SFX input index bookkeeping", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};

	test("SFX input indexes continue after music, following the existing cutaway/logo/music order", () => {
		const args = buildBrollVideoArgs({
			sourcePath: "/tmp/src.mp4",
			cutaways: [
				{ path: "/tmp/broll-0.mp4", window: { startSec: 3, endSec: 6 } },
			],
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			logo: {
				filePath: "/tmp/logo.png",
				position: "top-right",
				opacity: 100,
				scalePct: 12,
			},
			music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
			sfx: [{ path: "/tmp/sfx.mp3", startSec: 1, volume: 80 }],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		// 0=source, 1=broll cutaway, 2=logo, 3=music, 4=sfx.
		expect(graph).toContain("[3:a]atrim=start=0.000");
		expect(graph).toContain("[4:a]adelay=1000");
		expect(graph).toContain("amix=inputs=3"); // dialogue + music + sfx
	});

	test("SFX-only (no music) still uses the correct base index after cutaways/logo", () => {
		const args = buildBrollVideoArgs({
			sourcePath: "/tmp/src.mp4",
			cutaways: [
				{ path: "/tmp/broll-0.mp4", window: { startSec: 3, endSec: 6 } },
			],
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			logo: {
				filePath: "/tmp/logo.png",
				position: "top-right",
				opacity: 100,
				scalePct: 12,
			},
			sfx: [{ path: "/tmp/sfx.mp3", startSec: 1, volume: 80 }],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		// 0=source, 1=broll cutaway, 2=logo, 3=sfx (no music consumes a slot).
		expect(graph).toContain("[3:a]adelay=1000");
		expect(graph).toContain("amix=inputs=2"); // dialogue + sfx
	});
});

describe("buildAudiogramArgs music + SFX + ducking", () => {
	test("SFX-only (no music): waveform still reads dialogue, output mixes dialogue+sfx", () => {
		const args = buildAudiogramArgs({
			sourcePath: "/tmp/src.mp3",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			clipDurationSec: 10,
			srtPath: null,
			sfx: [{ path: "/tmp/sfx.mp3", startSec: 2, volume: 80 }],
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		// Waveform reads straight off [0:a] (no music/no cut => no explicit split).
		expect(graph).toContain("[0:a]showwaves");
		// SFX is input 1 (music absent), mixed with dialogue into [outa].
		expect(graph).toContain("[1:a]adelay=2000");
		expect(graph).toContain("amix=inputs=2");
	});

	test("music + ducking: the music branch carries a volume=<expr>:eval=frame stage after its fade suffix", () => {
		const utterances = [
			makeUtterance([
				["hello", 1, 1.5],
				["world", 1.5, 2],
			]),
		];
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe: {
				width: 1920,
				height: 1080,
				hasVideo: true,
				hasAudio: true,
				fps: 30,
			},
			srtPath: null,
			music: {
				path: "/tmp/music.mp3",
				volume: 40,
				startOffsetSec: 0,
				duckingWindows: computeSpeechWindows(
					utterances[0]!.words.map((w) => ({
						startSec: w.startSec,
						endSec: w.endSec,
					})),
					10,
				),
			},
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("volume=0.400");
		expect(graph).toMatch(/volume='if\(between\(t,/);
		expect(graph).toContain("':eval=frame");
	});

	test("music without ducking (duckingWindows omitted): no volume=<expr> automation stage, byte-identical to before", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe: {
				width: 1920,
				height: 1080,
				hasVideo: true,
				hasAudio: true,
				fps: 30,
			},
			srtPath: null,
			music: { path: "/tmp/music.mp3", volume: 40, startOffsetSec: 0 },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).not.toContain("eval=frame");
	});

	test("music with ducking but an empty transcript (duckingWindows: []): no-op, filter omitted", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe: {
				width: 1920,
				height: 1080,
				hasVideo: true,
				hasAudio: true,
				fps: 30,
			},
			srtPath: null,
			music: {
				path: "/tmp/music.mp3",
				volume: 40,
				startOffsetSec: 0,
				duckingWindows: [],
			},
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).not.toContain("eval=frame");
	});
});

describe("ranged https source input (presigned URL reads)", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};
	const httpsSource =
		"https://r2.example.com/projects/p1/source.mp4?X-Amz-Signature=abc";

	test("buildSingleVideoArgs injects reconnect/rw_timeout input options before -ss, which stays before -i", () => {
		const args = buildSingleVideoArgs({
			sourcePath: httpsSource,
			outputPath: "/tmp/out.mp4",
			startSec: 5,
			endSec: 25,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
		});

		const reconnectIdx = args.indexOf("-reconnect");
		const rwTimeoutIdx = args.indexOf("-rw_timeout");
		const ssIdx = args.indexOf("-ss");
		const iIdx = args.indexOf("-i");

		expect(reconnectIdx).toBeGreaterThan(-1);
		expect(rwTimeoutIdx).toBeGreaterThan(-1);
		// Input options must precede the seek, and the seek must precede -i so
		// ffmpeg range-requests only the clip window instead of the whole object.
		expect(reconnectIdx).toBeLessThan(ssIdx);
		expect(rwTimeoutIdx).toBeLessThan(ssIdx);
		expect(ssIdx).toBeLessThan(iIdx);
		expect(args[iIdx + 1]).toBe(httpsSource);

		// Reconnect only on genuinely transient statuses.
		const onHttpErrorIdx = args.indexOf("-reconnect_on_http_error");
		expect(args[onHttpErrorIdx + 1]).toBe("429,500,502,503,504");
	});

	test("local source paths get no http input options", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 5,
			endSec: 25,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
		});

		expect(args).not.toContain("-reconnect");
		expect(args).not.toContain("-rw_timeout");
	});

	test("buildBrollVideoArgs binds http input options to input 0 only", () => {
		const args = buildBrollVideoArgs({
			sourcePath: httpsSource,
			cutaways: [
				{ path: "/tmp/broll.mp4", window: { startSec: 5.6, endSec: 9.1 } },
			],
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
		});

		const iIndexes = indexesOf(args, "-i");
		const reconnectIdx = args.indexOf("-reconnect");

		expect(reconnectIdx).toBeGreaterThan(-1);
		expect(reconnectIdx).toBeLessThan(iIndexes[0]!);
		// The local b-roll input must not inherit the http-only options.
		expect(indexesOf(args, "-reconnect")).toHaveLength(1);
	});
});

describe("boundary audio fade coverage", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};

	test("buildSingleVideoArgs routes non-music audio through the fade chain", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 10,
			endSec: 40,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;

		expect(graph).toContain("[0:a:0]afade=t=in:st=0:d=0.040");
		expect(graph).toContain("afade=t=out:st=29.880:d=0.120");
		expect(args).toContain("[outa]");
		expect(args).not.toContain("0:a:0?");
	});
});

describe("source audio gain/mute + music fades (vizard-parity Phase A step 5)", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};

	test("unity source volume (100, unmuted) skips the gain filter entirely — unchanged filter graph", () => {
		const studioEdits = studioEditsSchema.parse({});
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 30,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			studioEdits,
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("[0:a:0]afade=t=in:st=0:d=0.040");
		expect(graph).not.toContain("volume=");
	});

	test("sub-100 source volume applies a volume= gain before the fade chain (buildSingleVideoArgs, no music)", () => {
		const studioEdits = studioEditsSchema.parse({
			sourceAudio: { volume: 60, muted: false },
		});
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 30,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			studioEdits,
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("[0:a:0]volume=0.600,afade=t=in:st=0:d=0.040");
	});

	test("muted source audio produces volume=0.000 (silent track, graph shape unchanged) — buildBrollVideoArgs, no music", () => {
		const studioEdits = studioEditsSchema.parse({
			sourceAudio: { volume: 100, muted: true },
		});
		const args = buildBrollVideoArgs({
			sourcePath: "/tmp/src.mp4",
			cutaways: [
				{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } },
			],
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			studioEdits,
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("[0:a:0]volume=0.000,afade=t=in:st=0:d=0.040");
		expect(args).toContain("[outa]");
		expect(args).not.toContain("-an");
	});

	test("muted source audio applies volume=0 on the dialogue branch before amix when music is also present", () => {
		const studioEdits = studioEditsSchema.parse({
			sourceAudio: { volume: 100, muted: true },
		});
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			studioEdits,
			music: { path: "/tmp/music.mp3", volume: 40, startOffsetSec: 0 },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain(
			"[0:a]atrim=duration=20.000,asetpts=PTS-STARTPTS,volume=0.000[maina]",
		);
		// music branch is unaffected by the dialogue mute — still at its own volume
		expect(graph).toContain("volume=0.400");
		expect(graph).toContain(
			"amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
		);
	});

	test("music fadeInSec/fadeOutSec apply afade on the music branch at the right times, additive to the fixed click-guard on the final mix", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 20,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			music: {
				path: "/tmp/music.mp3",
				volume: 40,
				startOffsetSec: 0,
				fadeInSec: 2,
				fadeOutSec: 3,
			},
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;

		// user fade-in/out land on the music branch itself, before [musica]...
		expect(graph).toContain(
			"volume=0.400,afade=t=in:st=0:d=2.000,afade=t=out:st=17.000:d=3.000[musica]",
		);
		// ...and the fixed 40ms/120ms click-guard still runs on the final mixed
		// track, unchanged and in addition to the user's own fades.
		expect(graph).toContain(
			"amix=inputs=2:duration=first:dropout_transition=0:normalize=0,afade=t=in:st=0:d=0.040,afade=t=out:st=19.880:d=0.120[outa]",
		);
	});

	test("music fadeInSec/fadeOutSec clamp to the clip duration when longer than the clip", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 3,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			music: {
				path: "/tmp/music.mp3",
				volume: 35,
				startOffsetSec: 0,
				fadeInSec: 5,
				fadeOutSec: 5,
			},
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		// Both fades clamp to the 3s clip duration (5s each requested), and
		// since clamped fadeIn + clamped fadeOut (3+3=6s) still exceeds the 3s
		// duration, resolveMusicFadeWindows scales both down proportionally
		// (0.5x) so fade-in ends before fade-out begins, rather than the two
		// fully overlapping over the same seconds.
		expect(graph).toContain("afade=t=in:st=0:d=1.500");
		expect(graph).toContain("afade=t=out:st=1.500:d=1.500");
	});

	test("music fadeInSec/fadeOutSec overlap case: 4s fade-in + 4s fade-out on a 4s clip scale down to 2s+2s windows", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/src.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 4,
			aspectRatio: "9:16",
			probe,
			srtPath: null,
			music: {
				path: "/tmp/music.mp3",
				volume: 35,
				startOffsetSec: 0,
				fadeInSec: 4,
				fadeOutSec: 4,
			},
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("afade=t=in:st=0:d=2.000");
		expect(graph).toContain("afade=t=out:st=2.000:d=2.000");
	});

	test("no-source-audio + music fades: music-only clip still gets the user fades plus the fixed click-guard, no amix", () => {
		const args = buildSingleVideoArgs({
			sourcePath: "/tmp/silent-source.mp4",
			outputPath: "/tmp/out.mp4",
			startSec: 0,
			endSec: 10,
			aspectRatio: "9:16",
			probe: {
				width: 1920,
				height: 1080,
				hasVideo: true,
				hasAudio: false,
				fps: 30,
			},
			srtPath: null,
			music: {
				path: "/tmp/music.mp3",
				volume: 50,
				startOffsetSec: 0,
				fadeInSec: 1,
				fadeOutSec: 1,
			},
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain(
			"afade=t=in:st=0:d=1.000,afade=t=out:st=9.000:d=1.000[musica]",
		);
		expect(graph).toContain(
			"[musica]afade=t=in:st=0:d=0.040,afade=t=out:st=9.880:d=0.120[outa]",
		);
		expect(graph).not.toContain("amix");
		expect(args).toContain("[outa]");
	});
});

describe("clipRenderAttemptStorageKey", () => {
	test("is attempt-unique: two encode attempts for the same clip+aspect never collide", () => {
		const first = clipRenderAttemptStorageKey(
			"proj-1",
			"clip-1",
			"9x16",
			"attempt-a",
		);
		const second = clipRenderAttemptStorageKey(
			"proj-1",
			"clip-1",
			"9x16",
			"attempt-b",
		);
		expect(first).not.toBe(second);
	});

	test("stays scoped under the clip's own renders prefix", () => {
		const key = clipRenderAttemptStorageKey(
			"proj-1",
			"clip-1",
			"9x16",
			"attempt-a",
		);
		expect(key.startsWith("projects/proj-1/renders/clip-1/")).toBe(true);
		expect(key.endsWith(".mp4")).toBe(true);
	});

	test("is deterministic for the same inputs (pure function, no hidden randomness)", () => {
		const a = clipRenderAttemptStorageKey(
			"proj-1",
			"clip-1",
			"9x16",
			"attempt-a",
		);
		const b = clipRenderAttemptStorageKey(
			"proj-1",
			"clip-1",
			"9x16",
			"attempt-a",
		);
		expect(a).toBe(b);
	});
});

describe("cut-concat rendering (vizard-parity Phase B step 7 — deletedRanges)", () => {
	const probe = {
		width: 1920,
		height: 1080,
		hasVideo: true,
		hasAudio: true,
		fps: 30,
	};
	// 30s clip window, one mid-clip deletion [10,15) -> two kept segments
	// [0,10) and [15,30), 25s edited duration.
	const window = { startSec: 0, endSec: 30 };
	const cutPlan = buildClipCutPlan([{ startSec: 10, endSec: 15 }], window);

	test("buildClipCutPlan sanity for the fixture used below", () => {
		expect(cutPlan.isUncut).toBe(false);
		expect(cutPlan.isEmpty).toBe(false);
		expect(cutPlan.editedDurationSec).toBe(25);
		expect(cutPlan.segments).toEqual([
			{ sourceStartSec: 0, sourceEndSec: 10, editedStartSec: 0 },
			{ sourceStartSec: 15, sourceEndSec: 30, editedStartSec: 10 },
		]);
	});

	describe("buildSingleVideoArgs", () => {
		test("no deletions: passing an explicit uncut cutPlan is byte-identical to omitting cutPlan entirely", () => {
			const uncutPlan = buildClipCutPlan([], window);
			const base = {
				sourcePath: "/tmp/src.mp4",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 30,
				aspectRatio: "9:16" as const,
				probe,
				srtPath: null,
			};
			const withPlan = buildSingleVideoArgs({ ...base, cutPlan: uncutPlan });
			const withoutPlan = buildSingleVideoArgs(base);
			expect(withPlan).toEqual(withoutPlan);
		});

		test("two kept segments: emits per-segment trim/atrim + setpts/asetpts, then concat, before crop/scale", () => {
			const args = buildSingleVideoArgs({
				sourcePath: "/tmp/src.mp4",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 30,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
				cutPlan,
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;

			expect(graph).toContain(
				"[0:v]trim=start=0.000:end=10.000,setpts=PTS-STARTPTS[vseg0]",
			);
			expect(graph).toContain(
				"[0:a:0]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS[aseg0]",
			);
			expect(graph).toContain(
				"[0:v]trim=start=15.000:end=30.000,setpts=PTS-STARTPTS[vseg1]",
			);
			expect(graph).toContain(
				"[0:a:0]atrim=start=15.000:end=30.000,asetpts=PTS-STARTPTS[aseg1]",
			);
			expect(graph).toContain(
				"[vseg0][aseg0][vseg1][aseg1]concat=n=2:v=1:a=1[vcat][acat]",
			);
			// Downstream crop/scale reads the concatenated video, not the raw input.
			expect(graph).toContain("[vcat]crop=");
			// Dialogue fade reads the concatenated audio.
			expect(graph).toContain("[acat]afade=t=in:st=0:d=0.040");
			// Concat filters land before the crop stage in the graph.
			expect(graph.indexOf("concat=n=2")).toBeLessThan(
				graph.indexOf("[vcat]crop="),
			);
			// Fix #1 regression check: every cut-concat output label is consumed
			// as a filter input exactly once (no implicit fan-out).
			expectLabelConsumedOnce(graph, "[vcat]");
			expectLabelConsumedOnce(graph, "[acat]");

			// Output duration bound uses the edited (25s) duration, not the raw
			// 30s clip window.
			const tIndexes = indexesOf(args, "-t");
			const outputTIndex = tIndexes[tIndexes.length - 1]!;
			expect(args[outputTIndex + 1]).toBe("25.000");
			// The input-level -t is unchanged: still reads the whole [0,30) window
			// as one input (cut-concat trims it downstream, not at the demuxer).
			expect(args[tIndexes[0]! + 1]).toBe("30");
		});

		test("music duration uses the edited (post-cut) duration, not the raw clip window", () => {
			const args = buildSingleVideoArgs({
				sourcePath: "/tmp/src.mp4",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 30,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
				music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
				cutPlan,
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;
			expect(graph).toContain("atrim=start=0.000:duration=25.000");
			// dialogue branch reads the concatenated audio, not [0:a]
			expect(graph).toContain(
				"[acat]atrim=duration=25.000,asetpts=PTS-STARTPTS[maina]",
			);
			// buildSingleVideoArgs' [acat] feeds ONLY the dialogue branch here (the
			// video path reads [vcat] separately) — still worth pinning as a
			// regression check alongside the audiogram fix.
			expectLabelConsumedOnce(graph, "[acat]");
			expectLabelConsumedOnce(graph, "[vcat]");
		});

		test("single kept segment (deletion at the very start) skips concat and uses acopy for audio, copy for video", () => {
			const startOnlyPlan = buildClipCutPlan(
				[{ startSec: 0, endSec: 5 }],
				window,
			);
			expect(startOnlyPlan.segments).toHaveLength(1);
			const args = buildSingleVideoArgs({
				sourcePath: "/tmp/src.mp4",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 30,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
				cutPlan: startOnlyPlan,
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;
			expect(graph).toContain(
				"[0:v]trim=start=5.000:end=30.000,setpts=PTS-STARTPTS[vseg0]",
			);
			expect(graph).toContain("[vseg0]copy[vcat]");
			expect(graph).toContain(
				"[0:a:0]atrim=start=5.000:end=30.000,asetpts=PTS-STARTPTS[aseg0]",
			);
			expect(graph).toContain("[aseg0]acopy[acat]");
			expect(graph).not.toContain("concat=");
		});

		test("all-deleted guard: throws instead of building args for an empty cut plan", () => {
			const emptyPlan = buildClipCutPlan([{ startSec: 0, endSec: 30 }], window);
			expect(emptyPlan.isEmpty).toBe(true);
			expect(() =>
				buildSingleVideoArgs({
					sourcePath: "/tmp/src.mp4",
					outputPath: "/tmp/out.mp4",
					startSec: 0,
					endSec: 30,
					aspectRatio: "9:16",
					probe,
					srtPath: null,
					cutPlan: emptyPlan,
				}),
			).toThrow();
		});
	});

	describe("buildBrollVideoArgs", () => {
		test("cut-concat runs before the b-roll overlay chain", () => {
			const args = buildBrollVideoArgs({
				sourcePath: "/tmp/src.mp4",
				cutaways: [
					{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } },
				],
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 30,
				aspectRatio: "9:16",
				probe,
				srtPath: null,
				cutPlan,
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;
			expect(graph).toContain(
				"[vseg0][aseg0][vseg1][aseg1]concat=n=2:v=1:a=1[vcat][acat]",
			);
			expect(graph).toContain("[vcat]crop=");
			expect(graph).toContain("[acat]afade=t=in:st=0:d=0.040");
			expectLabelConsumedOnce(graph, "[vcat]");
			expectLabelConsumedOnce(graph, "[acat]");

			const tIndexes = indexesOf(args, "-t");
			// last -t is the output bound (belt-and-suspenders) -> edited duration
			const outputTIndex = tIndexes[tIndexes.length - 1]!;
			expect(args[outputTIndex + 1]).toBe("25.000");
		});

		test("all-deleted guard: throws for an empty cut plan even with a valid cutaway", () => {
			const emptyPlan = buildClipCutPlan([{ startSec: 0, endSec: 30 }], window);
			expect(() =>
				buildBrollVideoArgs({
					sourcePath: "/tmp/src.mp4",
					cutaways: [
						{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } },
					],
					outputPath: "/tmp/out.mp4",
					startSec: 0,
					endSec: 30,
					aspectRatio: "9:16",
					probe,
					srtPath: null,
					cutPlan: emptyPlan,
				}),
			).toThrow();
		});
	});

	describe("buildAudiogramArgs", () => {
		test("cut-concat is audio-only (no video stream to trim/concat)", () => {
			const args = buildAudiogramArgs({
				sourcePath: "/tmp/a.mp3",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 30,
				aspectRatio: "9:16",
				clipDurationSec: cutPlan.editedDurationSec,
				srtPath: null,
				cutPlan,
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;
			expect(graph).toContain(
				"[0:a]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS[aseg0]",
			);
			expect(graph).toContain(
				"[0:a]atrim=start=15.000:end=30.000,asetpts=PTS-STARTPTS[aseg1]",
			);
			expect(graph).toContain("[aseg0][aseg1]concat=n=2:v=0:a=1[acat]");
			expect(graph).not.toContain("vseg");
			expect(graph).toContain("[acat]asplit=2[wavesrc][fadesrc]");
			expectLabelConsumedOnce(graph, "[acat]");

			const shortestIdx = args.indexOf("-shortest");
			expect(args[shortestIdx + 2]).toBe("25.000");
		});

		test("FIX #1 regression: with music AND a cut, [acat] is split (not double-consumed) so the exported dialogue never silently rebinds to raw uncut [0:a]", () => {
			const args = buildAudiogramArgs({
				sourcePath: "/tmp/a.mp3",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 30,
				aspectRatio: "9:16",
				clipDurationSec: cutPlan.editedDurationSec,
				srtPath: null,
				cutPlan,
				music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
			});
			const graph = args[args.indexOf("-filter_complex") + 1]!;

			// The cut-concat stage still produces [acat] from the two kept segments.
			expect(graph).toContain("[aseg0][aseg1]concat=n=2:v=0:a=1[acat]");
			// [acat] is explicitly split before being fanned to showwaves + the
			// dialogue/music mix — this is the actual fix.
			expect(graph).toContain("[acat]asplit=2[wavesrc][dlgsrc]");
			expect(graph).toContain(
				"[wavesrc]showwaves=s=1080x806:mode=cline:colors=0xFFE11A:rate=25[wave]",
			);
			// The music mix's dialogue branch reads the SPLIT pad, not [acat]
			// directly and not raw [0:a] — this is what stops deleted audio from
			// leaking back in.
			expect(graph).toContain(
				"[dlgsrc]atrim=duration=25.000,asetpts=PTS-STARTPTS[maina]",
			);
			expect(graph).not.toContain("[0:a]atrim=duration=25.000");

			// General regression check: every emitted pad this graph produces is
			// consumed as a filter input exactly once (nothing is dropped or
			// double-fed).
			expectLabelConsumedOnce(graph, "[acat]");
			expectLabelConsumedOnce(graph, "[wavesrc]");
			expectLabelConsumedOnce(graph, "[dlgsrc]");
		});

		test("no cut, music present: [0:a] is read directly by both showwaves and the dialogue mix (raw input streams DO fan out implicitly) — byte-identical to before the fix", () => {
			const uncutPlan = buildClipCutPlan([], window);
			const args = buildAudiogramArgs({
				sourcePath: "/tmp/a.mp3",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 30,
				aspectRatio: "9:16",
				clipDurationSec: 30,
				srtPath: null,
				cutPlan: uncutPlan,
				music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
			});
			const withoutPlanArgs = buildAudiogramArgs({
				sourcePath: "/tmp/a.mp3",
				outputPath: "/tmp/out.mp4",
				startSec: 0,
				endSec: 30,
				aspectRatio: "9:16",
				clipDurationSec: 30,
				srtPath: null,
				music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
			});
			expect(args).toEqual(withoutPlanArgs);
			const graph = args[args.indexOf("-filter_complex") + 1]!;
			expect(graph).not.toContain("asplit");
			expect(graph).toContain("[0:a]showwaves=");
			expect(graph).toContain("[0:a]atrim=duration=30.000");
		});

		test("all-deleted guard: throws for an empty cut plan", () => {
			const emptyPlan = buildClipCutPlan([{ startSec: 0, endSec: 30 }], window);
			expect(() =>
				buildAudiogramArgs({
					sourcePath: "/tmp/a.mp3",
					outputPath: "/tmp/out.mp4",
					startSec: 0,
					endSec: 30,
					aspectRatio: "9:16",
					clipDurationSec: 0,
					srtPath: null,
					cutPlan: emptyPlan,
				}),
			).toThrow();
		});
	});
});
