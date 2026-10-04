import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	automaticLayoutInputFingerprint,
	interpolateCompositionCropTrack,
	compositionAssetRef,
	MOTION_ADAPTER_FIXTURES,
	SCENE_TEXT_ADAPTER_FIXTURES,
	planClipComposition,
	planMediaMotion,
	sampleCompositionMotion,
	screenLayoutInputFingerprint,
	splitLayoutInputFingerprint,
} from "@narriflow/composition-plan";
import {
	captionPresetSchema,
	clipAutoLayoutAnalysisSchema,
	editorDocumentSchema,
	studioEditsSchema,
	type SceneLayoutPreset,
} from "@narriflow/validators";
import {
	compileClipCompositionCommand,
	compileLayoutEvidenceSegmentCommand,
	compileOptionalMediaValidationCommand,
	compileCompositionPlanAudiogram,
	compileCompositionPlanAudioSchedule,
	compileCompositionPlanSceneAudio,
	compileCompositionPlanVideo,
	compileCompositionPlanVisualLayers,
	bindCompositionPlanAudioInputs,
} from "./composition-ffmpeg-adapter";
import { escapeDrawtextText } from "./ffmpeg-text";
import { productionWorkerProcessModule } from "./worker-process";

function planCenter() {
	const result = planClipComposition({
		document: editorDocumentSchema.parse({
			version: 2,
			clipStartSec: 0,
			clipEndSec: 5,
			captionPreset: captionPresetSchema.parse({}),
			transcriptSlice: [],
			studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
			brollUrl: null,
			deletedRanges: [],
		}),
		source: {
			identity: "source:key",
			kind: "video",
			width: 1920,
			height: 1080,
		},
		evidence: { automaticLayout: { state: "missing" } },
		assets: { backgroundImage: { state: "missing" } },
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v3",
		},
		targets: [
			{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 },
		],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return result.plan;
}

const realMediaDirectories: string[] = [];
afterEach(async () =>
	Promise.all(
		realMediaDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	),
);

test("analysis segment commands seek and decode a bounded low-resolution video without audio", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "narriflow-analysis-segment-"),
	);
	realMediaDirectories.push(directory);
	const sourcePath = join(directory, "source.mp4");
	const outputPath = join(directory, "segment.mp4");
	const signal = new AbortController().signal;
	const execute = (args: string[]) =>
		productionWorkerProcessModule.execute({
			command: "ffmpeg",
			args,
			signal,
			deadlineMs: 5_000,
		});
	await execute([
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=640x480:rate=10:duration=3",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=3",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		sourcePath,
	]);
	await execute(
		compileLayoutEvidenceSegmentCommand({
			sourcePath,
			outputPath,
			startSec: 1,
			durationSec: 0.5,
		}),
	);
	await execute(compileOptionalMediaValidationCommand(outputPath, "video"));
	const probe = await productionWorkerProcessModule.inspectMedia({
		sourcePath: outputPath,
		signal,
		deadlineMs: 5_000,
	});
	expect(probe.height).toBe(360);
	expect(probe.width).toBe(480);
	expect(probe.durationSec).toBeCloseTo(0.5, 2);
	expect(probe.hasVideo).toBe(true);
	expect(probe.hasAudio).toBe(false);
	const remote = compileLayoutEvidenceSegmentCommand({
		sourcePath: "https://media.example/source.mp4",
		outputPath,
		startSec: 1,
		durationSec: 0.5,
	});
	expect(remote.indexOf("-reconnect")).toBeLessThan(remote.indexOf("-i"));
	expect(remote).toContain("429,500,502,503,504");
	expect(remote).toContain("-rw_timeout");
});

function planInsertedScenes(
	targets = [
		{ id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
		{ id: "square", aspectRatio: "1:1" as const, width: 1080, height: 1080 },
		{
			id: "landscape",
			aspectRatio: "16:9" as const,
			width: 1920,
			height: 1080,
		},
		{ id: "portrait", aspectRatio: "4:5" as const, width: 1080, height: 1350 },
	],
	source = { width: 1920, height: 1080 },
) {
	const imageId = "141b738e-f106-4da1-b670-8b71ff7f0a58";
	const videoId = "9e2af81d-8a41-4404-af89-b560f9c4eb98";
	const fontId = "2eb2cc4f-1d68-44d7-acbc-447388066562";
	const fingerprint = "a".repeat(64);
	const result = planClipComposition({
		document: editorDocumentSchema.parse({
			version: 2,
			clipStartSec: 0,
			clipEndSec: 5,
			captionPreset: captionPresetSchema.parse({}),
			transcriptSlice: [],
			studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
			brollUrl: null,
			deletedRanges: [],
			censorSegments: [],
			mediaMotions: [],
			sceneBlocks: [
				{
					id: "8ab9d330-688f-4574-932c-27ac661245c1",
					schemaVersion: 1,
					anchorSec: 0,
					durationSec: 1,
					content: { kind: "color", color: "#112233" },
					motion: {
						entrance: "scale-in",
						exit: "scale-out",
						durationSec: 0.35,
					},
					templateSnapshot: null,
				},
				{
					id: "d8ab95f8-fc16-4e60-814e-69762a59a99b",
					schemaVersion: 1,
					anchorSec: 1,
					durationSec: 1,
					content: {
						kind: "text",
						text: "Opening: 100%",
						fontFamily: "Missing Brand Font",
						fontAsset: {
							kind: "brand_font",
							id: fontId,
							fingerprint: "a".repeat(64),
						},
						color: "#FFFFFF",
						backgroundColor: "#111827",
					},
					motion: { entrance: "fade", exit: "fade" },
					templateSnapshot: null,
				},
				{
					id: "a3196d76-b71d-4b93-8812-7435b9e17faf",
					schemaVersion: 1,
					anchorSec: 2,
					durationSec: 1,
					content: {
						kind: "image",
						asset: { kind: "visual_asset", id: imageId, fingerprint },
						fit: "contain",
						backgroundColor: "#223344",
					},
					motion: {
						entrance: "ken-burns-in",
						exit: "ken-burns-out",
						durationSec: 0.35,
					},
					templateSnapshot: null,
				},
				{
					id: "31ddc1dd-838c-4fed-a940-4cbed7a3974b",
					schemaVersion: 1,
					anchorSec: 3,
					durationSec: 1,
					content: {
						kind: "video",
						asset: { kind: "visual_asset", id: videoId, fingerprint },
						sourceStartSec: 0,
						sourceEndSec: 1,
						fit: "cover",
						backgroundColor: "#000000",
						muted: false,
						volume: 65,
					},
					motion: { entrance: "pan-up", exit: "pan-down", durationSec: 0.35 },
					templateSnapshot: null,
				},
			],
		}),
		source: { identity: "source:key", kind: "video", ...source },
		evidence: { automaticLayout: { state: "missing" } },
		assets: { backgroundImage: { state: "missing" } },
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v3",
		},
		targets,
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return {
		plan: result.plan,
		imageRef: compositionAssetRef("visual_asset", `${imageId}:${fingerprint}`),
		videoRef: compositionAssetRef("visual_asset", `${videoId}:${fingerprint}`),
		fontRef: compositionAssetRef("brand_font", `${fontId}:${fingerprint}`),
	};
}

function planFit(imageAvailable: boolean) {
	const result = planClipComposition({
		document: editorDocumentSchema.parse({
			version: 2,
			clipStartSec: 0,
			clipEndSec: 5,
			captionPreset: captionPresetSchema.parse({}),
			transcriptSlice: [],
			studioEdits: studioEditsSchema.parse({
				background: {
					mode: "image",
					color: "#123456",
					imageUrl: "https://example.com/background.jpg",
				},
			}),
			brollUrl: null,
			deletedRanges: [],
		}),
		source: {
			identity: "source:key",
			kind: "video",
			width: 1920,
			height: 1080,
		},
		evidence: { automaticLayout: { state: "missing" } },
		assets: {
			backgroundImage: imageAvailable
				? { state: "available", ref: "background:image" }
				: { state: "failed" },
		},
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v3",
		},
		targets: [
			{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 },
		],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return result.plan;
}

function planAuto() {
	const document = editorDocumentSchema.parse({
		version: 2,
		clipStartSec: 0,
		clipEndSec: 5,
		captionPreset: captionPresetSchema.parse({}),
		transcriptSlice: [],
		studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
		brollUrl: null,
		deletedRanges: [],
	});
	const sourceIdentity = "source:key";
	const analysis = clipAutoLayoutAnalysisSchema.parse({
		version: 3,
		engine: "shot-layout-v3",
		sourceIdentity,
		analyzedAtISO: "2026-08-26T00:00:00.000Z",
		clipStartSec: 0,
		clipEndSec: 5,
		deletedRanges: [],
		editedDurationSec: 5,
		sourceWidth: 1920,
		sourceHeight: 1080,
		segments: [
			{
				startSec: 0,
				endSec: 5,
				layout: "two-up",
				topCxNorm: 0.25,
				bottomCxNorm: 0.75,
				subjects: [
					{ id: "left", cxNorm: 0.25, cyNorm: 0.5, zoom: 1 },
					{ id: "right", cxNorm: 0.75, cyNorm: 0.5, zoom: 1 },
				],
			},
		],
		noSplitSegments: [
			{
				startSec: 0,
				endSec: 5,
				layout: "single",
				cxNorm: 0.5,
				subjects: [
					{ id: "left", cxNorm: 0.25, cyNorm: 0.5, zoom: 1 },
					{ id: "right", cxNorm: 0.75, cyNorm: 0.5, zoom: 1 },
				],
			},
		],
		shotCount: 1,
		soloShotCount: 0,
		multiShotCount: 1,
		twoUpSegmentCount: 1,
		speakerCount: 2,
		mappedSpeakerCount: 2,
	});
	const result = planClipComposition({
		document,
		source: {
			identity: sourceIdentity,
			kind: "video",
			width: 1920,
			height: 1080,
		},
		evidence: {
			automaticLayout: {
				state: "available",
				value: {
					sourceIdentity,
					inputFingerprint: automaticLayoutInputFingerprint({
						sourceIdentity,
						clipStartSec: 0,
						clipEndSec: 5,
						deletedRanges: [],
						engineVersion: "shot-layout-v3",
					}),
					engineVersion: "shot-layout-v3",
					analysis,
				},
			},
		},
		assets: { backgroundImage: { state: "missing" } },
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v3",
		},
		targets: [
			{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 },
		],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return result.plan;
}

function planSplit() {
	const sourceIdentity = "source:key";
	const engineVersion = "explicit-split-v1";
	const result = planClipComposition({
		document: editorDocumentSchema.parse({
			version: 2,
			clipStartSec: 0,
			clipEndSec: 5,
			captionPreset: captionPresetSchema.parse({}),
			transcriptSlice: [],
			studioEdits: studioEditsSchema.parse({ framing: { mode: "split" } }),
			brollUrl: null,
			deletedRanges: [],
		}),
		source: {
			identity: sourceIdentity,
			kind: "video",
			width: 1920,
			height: 1080,
		},
		evidence: {
			automaticLayout: { state: "missing" },
			splitLayout: {
				state: "available",
				value: {
					sourceIdentity,
					inputFingerprint: splitLayoutInputFingerprint({
						sourceIdentity,
						clipStartSec: 0,
						clipEndSec: 5,
						deletedRanges: [],
						engineVersion,
					}),
					engineVersion,
					source: "explicit-detector",
					segments: [
						{
							startSec: 0,
							endSec: 5,
							layout: "two-up",
							topCxNorm: 0.25,
							bottomCxNorm: 0.75,
						},
					],
					fallbackSegments: [
						{ startSec: 0, endSec: 5, layout: "single", cxNorm: 0.5 },
					],
				},
			},
		},
		assets: { backgroundImage: { state: "missing" } },
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v3",
			explicitSplitLayout: true,
			splitEngineVersion: engineVersion,
		},
		targets: [
			{ id: "variant-1", aspectRatio: "4:5", width: 1080, height: 1350 },
		],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return result.plan;
}

function planScreen() {
	const sourceIdentity = "source:key";
	const engineVersion = "screen-layout-v2";
	const result = planClipComposition({
		document: editorDocumentSchema.parse({
			version: 2,
			clipStartSec: 0,
			clipEndSec: 5,
			captionPreset: captionPresetSchema.parse({}),
			transcriptSlice: [],
			studioEdits: studioEditsSchema.parse({ framing: { mode: "screen" } }),
			brollUrl: null,
			deletedRanges: [],
		}),
		source: {
			identity: sourceIdentity,
			kind: "video",
			width: 1920,
			height: 1080,
		},
		evidence: {
			automaticLayout: { state: "missing" },
			screenLayout: {
				state: "available",
				value: {
					sourceIdentity,
					inputFingerprint: screenLayoutInputFingerprint({
						sourceIdentity,
						clipStartSec: 0,
						clipEndSec: 5,
						deletedRanges: [],
						engineVersion,
					}),
					engineVersion,
					source: "durable-pip",
					pictureInPicture: {
						state: "confirmed",
						rect: { x: 0.72, y: 0.68, width: 0.2, height: 0.22 },
					},
					faceBand: { state: "unavailable" },
				},
			},
		},
		assets: { backgroundImage: { state: "missing" } },
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v3",
			screenLayout: true,
			screenEngineVersion: engineVersion,
		},
		targets: [
			{ id: "variant-1", aspectRatio: "4:5", width: 1080, height: 1350 },
		],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return result.plan;
}

function planSceneLayout(
	preset: SceneLayoutPreset | null,
	background: "off" | "color" | "image" = "off",
) {
	const sourceIdentity = "source:scene-layout";
	const screenEngineVersion = "screen-layout-v2";
	const document = editorDocumentSchema.parse({
		version: 2,
		clipStartSec: 0,
		clipEndSec: 1,
		captionPreset: captionPresetSchema.parse({ visible: false }),
		transcriptSlice: [],
		studioEdits: studioEditsSchema.parse({
			framing: { mode: "center" },
			background:
				background === "image"
					? {
							mode: "image",
							color: "#123456",
							imageUrl: "https://example.com/background.jpg",
						}
					: background === "color"
						? { mode: "color", color: "#123456" }
						: { mode: "off" },
			sceneLayouts: preset
				? [
						{
							id: `layout-${preset}`,
							aspectRatio: "9:16",
							startSec: 0.25,
							endSec: 0.75,
							preset,
						},
					]
				: [],
		}),
		brollUrl: null,
		deletedRanges: [],
	});
	const analysis = clipAutoLayoutAnalysisSchema.parse({
		version: 3,
		engine: "shot-layout-v3",
		sourceIdentity,
		analyzedAtISO: "2026-09-13T00:00:00.000Z",
		clipStartSec: 0,
		clipEndSec: 1,
		deletedRanges: [],
		editedDurationSec: 1,
		sourceWidth: 320,
		sourceHeight: 180,
		segments: [
			{
				startSec: 0,
				endSec: 0.5,
				layout: "two-up",
				topCxNorm: 0.28,
				bottomCxNorm: 0.72,
				subjects: [
					{ id: "one", cxNorm: 0.14, cyNorm: 0.5, zoom: 1 },
					{ id: "two", cxNorm: 0.38, cyNorm: 0.5, zoom: 1 },
					{ id: "three", cxNorm: 0.62, cyNorm: 0.5, zoom: 1 },
					{ id: "four", cxNorm: 0.86, cyNorm: 0.5, zoom: 1 },
				],
			},
			{
				startSec: 0.5,
				endSec: 1,
				layout: "two-up",
				topCxNorm: 0.32,
				bottomCxNorm: 0.68,
				subjects: [
					{ id: "one", cxNorm: 0.16, cyNorm: 0.5, zoom: 1 },
					{ id: "two", cxNorm: 0.39, cyNorm: 0.5, zoom: 1 },
					{ id: "three", cxNorm: 0.61, cyNorm: 0.5, zoom: 1 },
					{ id: "four", cxNorm: 0.84, cyNorm: 0.5, zoom: 1 },
				],
			},
		],
		noSplitSegments: [
			{
				startSec: 0,
				endSec: 0.5,
				layout: "single",
				cxNorm: 0.72,
				subjects: [
					{ id: "one", cxNorm: 0.14, cyNorm: 0.5, zoom: 1 },
					{ id: "two", cxNorm: 0.38, cyNorm: 0.5, zoom: 1 },
					{ id: "three", cxNorm: 0.62, cyNorm: 0.5, zoom: 1 },
					{ id: "four", cxNorm: 0.86, cyNorm: 0.5, zoom: 1 },
				],
			},
			{
				startSec: 0.5,
				endSec: 1,
				layout: "single",
				cxNorm: 0.68,
				subjects: [
					{ id: "one", cxNorm: 0.16, cyNorm: 0.5, zoom: 1 },
					{ id: "two", cxNorm: 0.39, cyNorm: 0.5, zoom: 1 },
					{ id: "three", cxNorm: 0.61, cyNorm: 0.5, zoom: 1 },
					{ id: "four", cxNorm: 0.84, cyNorm: 0.5, zoom: 1 },
				],
			},
		],
		shotCount: 2,
		soloShotCount: 0,
		multiShotCount: 2,
		twoUpSegmentCount: 2,
		speakerCount: 4,
		mappedSpeakerCount: 4,
	});
	const result = planClipComposition({
		document,
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
					inputFingerprint: automaticLayoutInputFingerprint({
						sourceIdentity,
						clipStartSec: 0,
						clipEndSec: 1,
						deletedRanges: [],
						engineVersion: "shot-layout-v3",
					}),
					engineVersion: "shot-layout-v3",
					analysis,
				},
			},
			screenLayout: {
				state: "available",
				value: {
					sourceIdentity,
					inputFingerprint: screenLayoutInputFingerprint({
						sourceIdentity,
						clipStartSec: 0,
						clipEndSec: 1,
						deletedRanges: [],
						engineVersion: screenEngineVersion,
					}),
					engineVersion: screenEngineVersion,
					source: "durable-pip",
					pictureInPicture: {
						state: "confirmed",
						rect: { x: 0.72, y: 0.68, width: 0.2, height: 0.22 },
					},
					faceBand: { state: "unavailable" },
				},
			},
		},
		assets: {
			backgroundImage:
				background === "image"
					? { state: "available", ref: "background:scene-layout" }
					: { state: "missing" },
		},
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v3",
			screenLayout: true,
			screenEngineVersion,
		},
		targets: [
			{ id: "scene-layout", aspectRatio: "9:16", width: 180, height: 320 },
		],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return result.plan;
}

function planBroll() {
	const result = planClipComposition({
		document: editorDocumentSchema.parse({
			version: 2,
			clipStartSec: 0,
			clipEndSec: 5,
			captionPreset: captionPresetSchema.parse({}),
			transcriptSlice: [],
			studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
			brollUrl: "https://example.com/cutaway.mp4",
			deletedRanges: [],
		}),
		source: {
			identity: "source:key",
			kind: "video",
			width: 1920,
			height: 1080,
		},
		evidence: { automaticLayout: { state: "missing" } },
		assets: {
			backgroundImage: { state: "missing" },
			broll: {
				state: "available",
				placements: [
					{ id: "cutaway", ref: "broll:cutaway", startSec: 1.5, endSec: 4 },
				],
			},
		},
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v3",
		},
		targets: [
			{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 },
		],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return result.plan;
}

function planBrollWithInsertions(anchors = [2.5]) {
	const result = planClipComposition({
		document: editorDocumentSchema.parse({
			version: 2,
			clipStartSec: 0,
			clipEndSec: 5,
			captionPreset: captionPresetSchema.parse({ visible: false }),
			transcriptSlice: [],
			studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
			brollUrl: "https://example.com/cutaway.mp4",
			deletedRanges: [],
			sceneBlocks: anchors.map((anchorSec, index) => ({
				id:
					index === 0
						? "8ab9d330-688f-4574-932c-27ac661245c1"
						: "d8ab95f8-fc16-4e60-814e-69762a59a99b",
				schemaVersion: 1,
				anchorSec,
				durationSec: 1,
				content: { kind: "color", color: "#00FF00" },
				motion: { entrance: "none", exit: "none" },
				templateSnapshot: null,
			})),
			mediaMotions: [
				{
					schemaVersion: 1,
					id: "a3196d76-b71d-4b93-8812-7435b9e17faf",
					target: { kind: "broll" },
					startSec: 0,
					endSec: 5 + anchors.length,
					entrance: "fade",
					exit: "fade",
					durationSec: 0.5,
					enabled: true,
				},
			],
		}),
		source: { identity: "source:key", kind: "video", width: 160, height: 90 },
		evidence: { automaticLayout: { state: "missing" } },
		assets: {
			backgroundImage: { state: "missing" },
			broll: {
				state: "available",
				placements: [
					{ id: "cutaway", ref: "broll:cutaway", startSec: 1.5, endSec: 4 },
				],
			},
		},
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v3",
		},
		targets: [
			{ id: "inserted-broll", aspectRatio: "16:9", width: 160, height: 90 },
		],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return result.plan;
}

function planVisualStack(
	input: {
		captions?: boolean;
		transitionType?: (typeof MOTION_ADAPTER_FIXTURES.transitions)[number]["type"];
	} = {},
) {
	const result = planClipComposition({
		document: editorDocumentSchema.parse({
			version: 2,
			clipStartSec: 0,
			clipEndSec: 5,
			captionPreset: captionPresetSchema.parse({
				visible: input.captions ?? false,
			}),
			transcriptSlice: input.captions
				? [
						{
							index: 0,
							speaker: 0,
							speakerLabel: "Speaker 1",
							startSec: 0.5,
							endSec: 1.5,
							text: "Plan first",
							confidence: 0.99,
							words: [
								{ word: "Plan", startSec: 0.5, endSec: 1, confidence: 0.99 },
								{ word: "first", startSec: 1, endSec: 1.5, confidence: 0.99 },
							],
						},
					]
				: [],
			studioEdits: studioEditsSchema.parse({
				framing: { mode: "center" },
				textLayers: [{ id: "hook", text: "It's 50%", startSec: 1, endSec: 4 }],
				transition: {
					type: input.transitionType ?? "dip-white",
					durationSec: 0.5,
				},
			}),
			brollUrl: null,
			deletedRanges: [],
		}),
		source: {
			identity: "source:key",
			kind: "video",
			width: 1920,
			height: 1080,
		},
		evidence: { automaticLayout: { state: "missing" } },
		assets: {
			backgroundImage: { state: "missing" },
			logo: {
				state: "available",
				ref: "logo:brand",
				settings: {
					enabled: true,
					position: "top-right",
					opacity: 80,
					scalePct: 12,
				},
			},
		},
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v3",
		},
		targets: [
			{
				id: "variant-1",
				aspectRatio: "9:16",
				width: 1080,
				height: 1920,
				outputTreatment: { resolution: "720p", watermark: true },
			},
		],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return result.plan;
}

function planTransitionOnly(
	type: (typeof MOTION_ADAPTER_FIXTURES.transitions)[number]["type"],
) {
	const result = planClipComposition({
		document: editorDocumentSchema.parse({
			version: 2,
			clipStartSec: 0,
			clipEndSec: 1,
			captionPreset: captionPresetSchema.parse({ visible: false }),
			transcriptSlice: [],
			studioEdits: studioEditsSchema.parse({
				framing: { mode: "center" },
				transition: { type, durationSec: 0.3 },
			}),
			brollUrl: null,
			deletedRanges: [],
		}),
		source: { identity: "source:key", kind: "video", width: 320, height: 180 },
		evidence: { automaticLayout: { state: "missing" } },
		assets: { backgroundImage: { state: "missing" } },
		capabilities: {
			automaticSpeakerLayout: true,
			automaticSpeakerEngineVersion: "shot-layout-v3",
		},
		targets: [{ id: "smoke", aspectRatio: "16:9", width: 320, height: 180 }],
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return result.plan;
}

describe("composition FFmpeg adapter", () => {
	test("compiles every shared transition fixture from canonical motion", () => {
		for (const fixture of MOTION_ADAPTER_FIXTURES.transitions) {
			const compiled = compileCompositionPlanVisualLayers({
				plan: planVisualStack({ transitionType: fixture.type }),
				targetId: "variant-1",
				inputLabel: "[composition_base]",
				outputLabel: "[outv]",
				logoInputIndex: 1,
			});
			expect(compiled.filterParts.length).toBeGreaterThan(0);
			expect(compiled.filterParts.join(";").length).toBeLessThan(64_000);
		}
	});

	test("executes every shared transition fixture in real FFmpeg", async () => {
		for (const fixture of MOTION_ADAPTER_FIXTURES.transitions) {
			const compiled = compileCompositionPlanVisualLayers({
				plan: planTransitionOnly(fixture.type),
				targetId: "smoke",
				inputLabel: "[0:v]",
				outputLabel: "[outv]",
			});
			const process = Bun.spawn(
				[
					"ffmpeg",
					"-v",
					"error",
					"-f",
					"lavfi",
					"-i",
					"testsrc2=size=320x180:rate=24:duration=1",
					"-filter_complex",
					compiled.filterParts.join(";"),
					"-map",
					"[outv]",
					"-f",
					"null",
					"-",
				],
				{ stdout: "ignore", stderr: "pipe" },
			);
			const stderr = await new Response(process.stderr).text();
			expect(await process.exited, `${fixture.id}: ${stderr}`).toBe(0);
		}
	}, 30_000);

	test("keeps a concurrent four-target motion encode within time, branch, and RSS budgets", async () => {
		const planned = planClipComposition({
			document: editorDocumentSchema.parse({
				version: 2,
				clipStartSec: 0,
				clipEndSec: 0.6,
				captionPreset: captionPresetSchema.parse({ visible: false }),
				transcriptSlice: [],
				studioEdits: studioEditsSchema.parse({
					framing: { mode: "center" },
					transition: { type: "wipe-left", durationSec: 0.25 },
				}),
				brollUrl: null,
				deletedRanges: [],
			}),
			source: {
				identity: "source:four-target-motion",
				kind: "video",
				width: 320,
				height: 180,
			},
			evidence: { automaticLayout: { state: "missing" } },
			assets: { backgroundImage: { state: "missing" } },
			capabilities: {
				automaticSpeakerLayout: true,
				automaticSpeakerEngineVersion: "shot-layout-v3",
			},
			targets: [
				{ id: "vertical", aspectRatio: "9:16", width: 90, height: 160 },
				{ id: "square", aspectRatio: "1:1", width: 120, height: 120 },
				{ id: "landscape", aspectRatio: "16:9", width: 160, height: 90 },
				{ id: "portrait", aspectRatio: "4:5", width: 128, height: 160 },
			],
		});
		if (planned.status === "invalid") throw new Error(planned.error.code);

		const startedAt = performance.now();
		const processes = planned.plan.targets.map((target) => {
			const compiled = compileCompositionPlanVisualLayers({
				plan: planned.plan,
				targetId: target.id,
				inputLabel: "[0:v]",
				outputLabel: "[outv]",
			});
			expect(compiled.filterParts.length).toBeLessThanOrEqual(4);
			expect(compiled.filterParts.join(";").length).toBeLessThan(64_000);
			return Bun.spawn(
				[
					"ffmpeg",
					"-v",
					"error",
					"-f",
					"lavfi",
					"-i",
					`testsrc2=size=${target.canvas.width}x${target.canvas.height}:rate=24:duration=0.6`,
					"-filter_complex",
					compiled.filterParts.join(";"),
					"-map",
					"[outv]",
					"-f",
					"null",
					"-",
				],
				{ stdout: "ignore", stderr: "pipe" },
			);
		});
		const stderrs = await Promise.all(
			processes.map((process) => new Response(process.stderr).text()),
		);
		const exitCodes = await Promise.all(
			processes.map((process) => process.exited),
		);
		exitCodes.forEach((code, index) => {
			expect(code, stderrs[index]).toBe(0);
		});
		const totalPeakRss = processes.reduce(
			(total, process) => total + (process.resourceUsage()?.maxRSS ?? 0),
			0,
		);

		expect(performance.now() - startedAt).toBeLessThan(10_000);
		expect(totalPeakRss).toBeGreaterThan(0);
		expect(totalPeakRss).toBeLessThan(1_000_000_000);
	}, 15_000);

	test("translates the planned audio-only audiogram without choosing its visual policy", () => {
		const result = planClipComposition({
			document: editorDocumentSchema.parse({
				version: 2,
				clipStartSec: 0,
				clipEndSec: 5,
				captionPreset: captionPresetSchema.parse({ highlightColor: "#12AB34" }),
				transcriptSlice: [],
				studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
				brollUrl: null,
				deletedRanges: [],
			}),
			source: { identity: "audio:key", kind: "audio", width: 0, height: 0 },
			evidence: { automaticLayout: { state: "missing" } },
			assets: { backgroundImage: { state: "missing" } },
			capabilities: {
				automaticSpeakerLayout: true,
				automaticSpeakerEngineVersion: "shot-layout-v3",
			},
			targets: [
				{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 },
			],
		});
		if (result.status === "invalid") throw new Error(result.error.code);

		expect(compileCompositionPlanAudiogram(result.plan, "variant-1")).toEqual({
			sourceRef: "audio:key",
			canvas: { width: 1080, height: 1920, divisibleBy: 2 },
			backgroundColor: "#0F172A",
			waveformColor: "#12AB34",
			waveformHeight: 806,
		});
	});

	test("splices inserted scenes into an audio-only audiogram and pauses source audio", () => {
		const result = planClipComposition({
			document: editorDocumentSchema.parse({
				version: 2,
				clipStartSec: 0,
				clipEndSec: 5,
				captionPreset: captionPresetSchema.parse({}),
				transcriptSlice: [],
				studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
				brollUrl: null,
				deletedRanges: [],
				censorSegments: [],
				mediaMotions: [],
				sceneBlocks: [
					{
						id: "2fc72899-b6f5-4a8e-a708-8c8c6ffc4bba",
						schemaVersion: 1,
						anchorSec: 2,
						durationSec: 1,
						content: { kind: "color", color: "#112233" },
						motion: { entrance: "fade", exit: "fade" },
						templateSnapshot: null,
					},
				],
			}),
			source: { identity: "audio:key", kind: "audio", width: 0, height: 0 },
			evidence: { automaticLayout: { state: "missing" } },
			assets: { backgroundImage: { state: "missing" } },
			capabilities: {
				automaticSpeakerLayout: true,
				automaticSpeakerEngineVersion: "shot-layout-v3",
			},
			targets: [
				{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 },
			],
		});
		if (result.status === "invalid") throw new Error(result.error.code);
		const audio = bindCompositionPlanAudioInputs(
			compileCompositionPlanAudioSchedule(result.plan),
			{},
		);
		const args = compileClipCompositionCommand({
			sourcePath: "/tmp/source.mp3",
			outputPath: "/tmp/output.mp4",
			startSec: 0,
			endSec: 5,
			audio,
			source: {
				hasVideo: false,
				hasAudio: true,
				hasVisualStream: false,
				width: 0,
				height: 0,
				durationSec: 10,
				fps: 30,
			},
			plan: { plan: result.plan, targetId: "variant-1" }.plan,
			targetId: { plan: result.plan, targetId: "variant-1" }.targetId,
			encoder: { preset: "veryfast", crf: "21" },
			assets: { subtitlePath: null },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("[audiogram_source]");
		expect(graph).toContain("concat=n=3:v=1:a=0");
		expect(graph).toContain("anullsrc=channel_layout=stereo");
		expect(args.slice(-20)).toContain("6.000");
	});

	test("translates the shared audio schedule into normalized render requests", () => {
		const plan = planCenter();
		const translated = compileCompositionPlanAudioSchedule({
			...plan,
			audioSchedule: {
				fingerprint: "audio:one",
				outputFades: {
					fadeIn: { startSec: 0, endSec: 0.04 },
					fadeOut: { startSec: 4.88, endSec: 5 },
				},
				source: {
					sourceRef: "source:key",
					available: true,
					activeRange: { startSec: 0, endSec: 5 },
					gain: 0.65,
					muted: false,
				},
				music: {
					sourceRef: "music:bed",
					activeRange: { startSec: 0, endSec: 5 },
					gain: 0.4,
					startOffsetSec: 3,
					sourceDurationSec: 10,
					loop: true,
					fades: {
						fadeIn: { startSec: 0, endSec: 2 },
						fadeOut: { startSec: 4, endSec: 5 },
					},
					ducking: {
						enabled: true,
						windows: [{ startSec: 1, endSec: 2 }],
						duckedGainFraction: 0.3,
						attackSec: 0.25,
						releaseSec: 0.4,
					},
				},
				soundEffects: [
					{
						id: "sting",
						sourceRef: "sfx:sting",
						activeRange: { startSec: 2, endSec: 5 },
						gain: 0.8,
					},
				],
				censors: [
					{
						startSec: 1,
						endSec: 1.5,
						treatment: "beep",
						frequencyHz: 1_000,
						gain: 0.25,
						fadeInSec: 0.015,
						fadeOutSec: 0.015,
					},
					{ startSec: 3, endSec: 3.4, treatment: "mute" },
				],
			},
		});

		expect(translated).toEqual({
			scheduleFingerprint: "audio:one",
			outputFades: {
				fadeIn: { startSec: 0, endSec: 0.04 },
				fadeOut: { startSec: 4.88, endSec: 5 },
			},
			source: {
				activeRange: { startSec: 0, endSec: 5 },
				available: true,
				gain: 0.65,
				muted: false,
			},
			music: {
				sourceRef: "music:bed",
				activeRange: { startSec: 0, endSec: 5 },
				gain: 0.4,
				startOffsetSec: 3,
				sourceDurationSec: 10,
				loop: true,
				fades: {
					fadeIn: { startSec: 0, endSec: 2 },
					fadeOut: { startSec: 4, endSec: 5 },
				},
				ducking: {
					enabled: true,
					windows: [{ startSec: 1, endSec: 2 }],
					duckedGainFraction: 0.3,
					attackSec: 0.25,
					releaseSec: 0.4,
				},
			},
			soundEffects: [
				{
					id: "sting",
					sourceRef: "sfx:sting",
					activeRange: { startSec: 2, endSec: 5 },
					gain: 0.8,
				},
			],
			censors: [
				{
					startSec: 1,
					endSec: 1.5,
					treatment: "beep",
					frequencyHz: 1_000,
					gain: 0.25,
					fadeInSec: 0.015,
					fadeOutSec: 0.015,
				},
				{ startSec: 3, endSec: 3.4, treatment: "mute" },
			],
		});
	});

	test("compiles mute and beep from the shared schedule without touching music", () => {
		const base = planCenter();
		const plan = {
			...base,
			audioSchedule: {
				...base.audioSchedule,
				fingerprint: "audio:censor",
				censors: [
					{
						startSec: 1,
						endSec: 1.5,
						treatment: "beep" as const,
						frequencyHz: 1_000,
						gain: 0.25,
						fadeInSec: 0.015,
						fadeOutSec: 0.015,
					},
					{ startSec: 3, endSec: 3.4, treatment: "mute" as const },
				],
			},
		};
		const audio = bindCompositionPlanAudioInputs(
			compileCompositionPlanAudioSchedule(plan),
			{},
		);
		const args = compileClipCompositionCommand({
			sourcePath: "/tmp/source.mp4",
			outputPath: "/tmp/output.mp4",
			startSec: 0,
			endSec: 5,
			audio,
			source: {
				hasVideo: true,
				hasAudio: true,
				width: 1920,
				height: 1080,
				durationSec: 5,
				fps: 30,
			},
			plan: { plan, targetId: "variant-1" }.plan,
			targetId: { plan, targetId: "variant-1" }.targetId,
			encoder: { preset: "veryfast", crf: "21" },
			assets: { subtitlePath: null },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;

		expect(graph).toContain("between(t,1.000000,1.500000)");
		expect(graph).toContain("between(t,3.000000,3.400000)");
		expect(graph).toContain(
			"sine=frequency=1000:sample_rate=48000:duration=0.500000",
		);
		expect(graph).toContain("afade=t=in:st=0:d=0.015000");
		expect(graph).toContain("alimiter=limit=0.950:level=disabled");
	});

	test("preserves a sub-millisecond censor interval and fades in the FFmpeg graph", () => {
		const base = planCenter();
		const plan = {
			...base,
			audioSchedule: {
				...base.audioSchedule,
				fingerprint: "audio:sub-ms-censor",
				censors: [
					{
						startSec: 0.25,
						endSec: 0.2505,
						treatment: "beep" as const,
						frequencyHz: 1_000,
						gain: 0.4,
						fadeInSec: 0.00025,
						fadeOutSec: 0.00025,
					},
				],
			},
		};
		const audio = bindCompositionPlanAudioInputs(
			compileCompositionPlanAudioSchedule(plan),
			{},
		);
		const args = compileClipCompositionCommand({
			sourcePath: "/tmp/source.mp4",
			outputPath: "/tmp/output.mp4",
			startSec: 0,
			endSec: 5,
			audio,
			source: {
				hasVideo: true,
				hasAudio: true,
				width: 1920,
				height: 1080,
				durationSec: 5,
				fps: 30,
			},
			plan: { plan, targetId: "variant-1" }.plan,
			targetId: { plan, targetId: "variant-1" }.targetId,
			encoder: { preset: "veryfast", crf: "21" },
			assets: { subtitlePath: null },
		});
		const graph = args[args.indexOf("-filter_complex") + 1]!;

		expect(graph).toContain(
			"aeval=exprs='if(between(t,0.250000,0.250500),0,val(ch)*1.000000)':c=same",
		);
		expect(graph).toContain("between(t,0.250000,0.250500)");
		expect(graph).toContain("duration=0.000500");
		expect(graph).toContain("afade=t=in:st=0:d=0.000250");
		expect(graph).toContain("afade=t=out:st=0.000250:d=0.000250");
	});

	test("compiles the planner's complete visual order without re-reading editor policy", () => {
		expect(
			compileCompositionPlanVisualLayers({
				plan: planVisualStack(),
				targetId: "variant-1",
				inputLabel: "[composition_base]",
				outputLabel: "[outv]",
				logoInputIndex: 1,
			}),
		).toEqual({
			filterParts: [
				"[composition_base]drawtext=font='Arial':text='It\\'s 50\\%':fontsize=44:fontcolor=0xFFFFFF:x=w*0.5000-text_w/2:y=h*0.1800-text_h/2:enable='between(t\\,1.000\\,4.000)':shadowcolor=black@0.45:shadowx=0:shadowy=2:borderw=2:bordercolor=0x000000[composition_visual_0]",
				"[1:v]scale=130:-1,format=rgba,colorchannelmixer=aa=0.800[composition_logo_1]",
				"[composition_visual_0][composition_logo_1]overlay=W-w-24:24[composition_visual_1]",
				"[composition_visual_1]fade=t=in:st=0.000:d=0.500:color=white,fade=t=out:st=4.500:d=0.500:color=white[composition_visual_2]",
				"[composition_visual_2]scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2,drawtext=text=Made with Narriflow:font='Arial Bold':fontcolor=0xFFFFFF@0.85:borderw=2:bordercolor=0x000000@0.60:fontsize=46:x=w-tw-32:y=32[outv]",
			],
			logoInput: { sourceRef: "logo:brand", inputIndex: 1 },
		});
	});

	test("rejects missing resolved inputs for planned optional visual assets", () => {
		expect(() =>
			compileCompositionPlanVisualLayers({
				plan: planVisualStack(),
				targetId: "variant-1",
				inputLabel: "[composition_base]",
				outputLabel: "[outv]",
			}),
		).toThrow("clip_composition_logo_input_missing");

		expect(() =>
			compileCompositionPlanVisualLayers({
				plan: planVisualStack({ captions: true }),
				targetId: "variant-1",
				inputLabel: "[composition_base]",
				outputLabel: "[outv]",
				logoInputIndex: 1,
			}),
		).toThrow("clip_composition_caption_asset_missing");
	});

	test("rejects visual geometry outside the planned target canvas", () => {
		const plan = planVisualStack();
		const target = plan.targets[0]!;
		const layer = target.visualLayers[0]!;
		const invalid = {
			...plan,
			targets: [
				{
					...target,
					visualLayers: [
						{
							...layer,
							destination: { ...layer.destination, x: target.canvas.width },
						},
						...target.visualLayers.slice(1),
					],
				},
			],
		};

		expect(() =>
			compileCompositionPlanVisualLayers({
				plan: invalid,
				targetId: "variant-1",
				inputLabel: "[composition_base]",
				outputLabel: "[outv]",
				logoInputIndex: 1,
			}),
		).toThrow("invalid_clip_composition_visual_destination");
	});

	test("rejects unknown canonical motion versions at the adapter boundary", () => {
		const plan = planVisualStack();
		const target = plan.targets[0]!;
		const transition = target.visualLayers.find(
			(layer) => layer.kind === "transition",
		)!;
		const invalid = {
			...plan,
			targets: [
				{
					...target,
					visualLayers: target.visualLayers.map((layer) =>
						layer.id === transition.id
							? {
									...transition,
									motion: { ...transition.motion, version: 2 },
								}
							: layer,
					),
				},
			],
		};
		expect(() =>
			compileCompositionPlanVisualLayers({
				plan: invalid,
				targetId: "variant-1",
				inputLabel: "[composition_base]",
				outputLabel: "[outv]",
				logoInputIndex: 1,
			}),
		).toThrow("unsupported_composition_motion_version");
	});
	test("compiles the Center plan's exact crop without choosing geometry", () => {
		expect(
			compileCompositionPlanVideo({
				plan: planCenter(),
				targetId: "variant-1",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
			}),
		).toEqual({
			filterParts: [
				"[0:v]crop=608:1080:656:0,scale=1080:1920,format=yuv420p[outv]",
			],
			backgroundImageInputRequired: false,
			brollInputs: [],
			sceneInputs: [],
		});
	});

	test("rejects an unknown plan version before command construction", () => {
		expect(() =>
			compileCompositionPlanVideo({
				plan: { ...planCenter(), version: 1 } as never,
				targetId: "variant-1",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
			}),
		).toThrow("unsupported_clip_composition_plan_version");
	});

	test("rejects invalid source geometry before command construction", () => {
		const plan = planCenter();
		const target = plan.targets[0]!;
		const scene = target.scenes[0]!;
		const layer = scene.layers[0]!;
		const invalid = {
			...plan,
			targets: [
				{
					...target,
					scenes: [
						{
							...scene,
							layers: [
								{
									...layer,
									sourceCrop: { ...layer.sourceCrop, x: plan.source.width },
								},
							],
						},
					],
				},
			],
		};
		expect(() =>
			compileCompositionPlanVideo({
				plan: invalid,
				targetId: "variant-1",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
			}),
		).toThrow("invalid_clip_composition_source_crop");
	});

	test("rejects a non-centered Center crop instead of letting FFmpeg choose", () => {
		const plan = planCenter();
		const target = plan.targets[0]!;
		const scene = target.scenes[0]!;
		const layer = scene.layers[0]!;
		const invalid = {
			...plan,
			targets: [
				{
					...target,
					scenes: [
						{
							...scene,
							layers: [
								{
									...layer,
									sourceCrop: {
										...layer.sourceCrop,
										x: layer.sourceCrop.x - 1,
									},
								},
							],
						},
					],
				},
			],
		};
		expect(() =>
			compileCompositionPlanVideo({
				plan: invalid,
				targetId: "variant-1",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
			}),
		).toThrow("unsupported_clip_composition_center_crop");
	});

	test("the production single-output builder rejects an unknown plan before FFmpeg starts", () => {
		expect(() =>
			compileClipCompositionCommand({
				sourcePath: "/tmp/source.mp4",
				outputPath: "/tmp/output.mp4",
				startSec: 0,
				endSec: 5,
				source: {
					hasVideo: true,
					hasAudio: true,
					width: 1920,
					height: 1080,
					durationSec: 5,
					fps: 30,
				},
				plan: {
					plan: { ...planCenter(), version: 1 } as never,
					targetId: "variant-1",
				}.plan,
				targetId: {
					plan: { ...planCenter(), version: 1 } as never,
					targetId: "variant-1",
				}.targetId,
				encoder: { preset: "veryfast", crf: "21" },
				assets: { subtitlePath: null },
			}),
		).toThrow("unsupported_clip_composition_plan_version");
	});

	test("compiles exact Fit image and color-fallback geometry from plan layers", () => {
		const image = compileCompositionPlanVideo({
			plan: planFit(true),
			targetId: "variant-1",
			videoInputLabel: "[0:v]",
			outputLabel: "[outv]",
			backgroundImageInputIndex: 1,
			fps: 30,
		});
		const fallback = compileCompositionPlanVideo({
			plan: planFit(false),
			targetId: "variant-1",
			videoInputLabel: "[0:v]",
			outputLabel: "[outv]",
			fps: 30,
		});

		expect(image).toEqual({
			backgroundImageInputRequired: true,
			brollInputs: [],
			sceneInputs: [],
			filterParts: [
				"[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[composition_bg]",
				"[0:v]crop=1920:1080:0:0,scale=1080:608[composition_source]",
				"[composition_bg][composition_source]overlay=0:656,format=yuv420p[outv]",
			],
		});
		expect(fallback).toEqual({
			backgroundImageInputRequired: false,
			brollInputs: [],
			sceneInputs: [],
			filterParts: [
				"[0:v]crop=1920:1080:0:0,scale=1080:608,pad=1080:1920:0:656:color=0x123456,format=yuv420p[outv]",
			],
		});
	});

	test("renders timed Fit backgrounds and Inset geometry through real FFmpeg", async () => {
		const cases = [
			{
				label: "fit color",
				plan: planSceneLayout("fit", "color"),
				image: false,
			},
			{
				label: "fit image",
				plan: planSceneLayout("fit", "image"),
				image: true,
			},
			{ label: "inset", plan: planSceneLayout("inset"), image: false },
		];

		for (const renderCase of cases) {
			const compiled = compileCompositionPlanVideo({
				plan: renderCase.plan,
				targetId: "scene-layout",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
				backgroundImageInputIndex: renderCase.image ? 1 : null,
				fps: 24,
			});
			expect(compiled.backgroundImageInputRequired, renderCase.label).toBe(
				renderCase.image,
			);
			const graph = compiled.filterParts.join(";");
			if (renderCase.label === "fit color") {
				expect(graph).toContain("color=0x123456");
			} else if (renderCase.label === "fit image") {
				expect(graph).toContain(
					"[composition_scene_1_background_src]loop=loop=-1:size=1:start=0,trim=duration=0.500",
				);
			} else {
				expect(graph).toContain("overlay=");
			}

			const process = Bun.spawn(
				[
					"ffmpeg",
					"-v",
					"error",
					"-f",
					"lavfi",
					"-i",
					"testsrc2=size=320x180:rate=24:duration=1",
					...(renderCase.image
						? ["-f", "lavfi", "-i", "color=c=0B7A42:s=180x320:r=24:d=0.042"]
						: []),
					"-filter_complex",
					graph,
					"-map",
					"[outv]",
					"-frames:v",
					"24",
					"-pix_fmt",
					"rgb24",
					"-f",
					"rawvideo",
					"pipe:1",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [stderr, output] = await Promise.all([
				new Response(process.stderr).text(),
				new Response(process.stdout).arrayBuffer(),
			]);
			expect(await process.exited, `${renderCase.label}: ${stderr}`).toBe(0);
			expect(output.byteLength, renderCase.label).toBe(180 * 320 * 3 * 24);
		}
	}, 30_000);

	test("renders masked circles, rounded corners, and three/four-layer templates", async () => {
		const cases: Array<{
			preset: SceneLayoutPreset;
			expectedSourceLayers: number;
			inspectPixels: "circle" | "rounded" | null;
		}> = [
			{
				preset: "screen-top-circle",
				expectedSourceLayers: 2,
				inspectPixels: "circle",
			},
			{
				preset: "screen-top-two-circle",
				expectedSourceLayers: 3,
				inspectPixels: null,
			},
			{ preset: "three-top", expectedSourceLayers: 3, inspectPixels: null },
			{
				preset: "four-grid-padded",
				expectedSourceLayers: 4,
				inspectPixels: "rounded",
			},
		];

		for (const renderCase of cases) {
			const plan = planSceneLayout(renderCase.preset, "color");
			const target = plan.targets[0]!;
			const selectedScene = target.scenes.find(
				(scene) => scene.layoutSelection?.preset === renderCase.preset,
			)!;
			const sourceLayers = selectedScene.layers.filter(
				(layer) => layer.kind === "source-video",
			);
			expect(sourceLayers, renderCase.preset).toHaveLength(
				renderCase.expectedSourceLayers,
			);
			const compiled = compileCompositionPlanVideo({
				plan,
				targetId: "scene-layout",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
				fps: 24,
			});
			const process = Bun.spawn(
				[
					"ffmpeg",
					"-v",
					"error",
					"-f",
					"lavfi",
					"-i",
					"color=c=E53935:s=320x180:r=24:d=1",
					"-filter_complex",
					compiled.filterParts.join(";"),
					"-map",
					"[outv]",
					"-frames:v",
					"24",
					"-pix_fmt",
					"rgb24",
					"-f",
					"rawvideo",
					"pipe:1",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [stderr, buffer] = await Promise.all([
				new Response(process.stderr).text(),
				new Response(process.stdout).arrayBuffer(),
			]);
			expect(await process.exited, `${renderCase.preset}: ${stderr}`).toBe(0);
			expect(buffer.byteLength, renderCase.preset).toBe(180 * 320 * 3 * 24);

			if (renderCase.inspectPixels) {
				const bytes = new Uint8Array(buffer);
				const pixel = (x: number, y: number) => {
					const frameOffset = 12 * 180 * 320 * 3;
					const offset = frameOffset + (y * 180 + x) * 3;
					return [
						bytes[offset]!,
						bytes[offset + 1]!,
						bytes[offset + 2]!,
					] as const;
				};
				const isSourceRed = ([red, green, blue]: readonly number[]) =>
					red > green + 80 && red > blue + 80;
				const isPlannedBackground = ([red, green, blue]: readonly number[]) =>
					red >= 5 &&
					red <= 35 &&
					green >= 35 &&
					green <= 70 &&
					blue >= 70 &&
					blue <= 105;
				const maskedLayers = sourceLayers.filter((layer) => layer.mask);
				if (renderCase.inspectPixels === "circle") {
					const circle = maskedLayers.find(
						(layer) => layer.mask?.kind === "circle",
					)!;
					expect(circle.destination.width).toBe(circle.destination.height);
					expect(
						isSourceRed(
							pixel(
								circle.destination.x + circle.destination.width / 2,
								circle.destination.y + circle.destination.height / 2,
							),
						),
					).toBe(true);
					expect(
						isPlannedBackground(
							pixel(circle.destination.x + 1, circle.destination.y + 1),
						),
					).toBe(true);
				} else {
					expect(maskedLayers).toHaveLength(4);
					for (const layer of maskedLayers) {
						expect(
							isSourceRed(
								pixel(
									layer.destination.x + layer.destination.width / 2,
									layer.destination.y + layer.destination.height / 2,
								),
							),
						).toBe(true);
						expect(
							isPlannedBackground(
								pixel(layer.destination.x + 1, layer.destination.y + 1),
							),
						).toBe(true);
					}
				}
			}
		}
	}, 30_000);

	test("accepts planner scene boundaries under clip-wide Center and Fit modes", () => {
		const plans = [planSceneLayout(null), planSceneLayout(null, "color")].map(
			(plan) => {
				const target = plan.targets[0]!;
				const scene = target.scenes[0]!;
				return {
					...plan,
					targets: [
						{
							...target,
							scenes: [
								{ ...scene, startSec: 0, endSec: 0.5 },
								{ ...scene, startSec: 0.5, endSec: 1 },
							],
						},
					],
				};
			},
		);

		for (const plan of plans) {
			const compiled = compileCompositionPlanVideo({
				plan,
				targetId: "scene-layout",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
				fps: 24,
			});
			expect(compiled.filterParts.join(";")).toContain("[outv]");
		}
	});

	test("compiles Auto scenes from exact planned crops and destinations", () => {
		expect(
			compileCompositionPlanVideo({
				plan: planAuto(),
				targetId: "variant-1",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
			}),
		).toEqual({
			backgroundImageInputRequired: false,
			brollInputs: [],
			sceneInputs: [],
			filterParts: [
				"[0:v]trim=start=0.000:end=5.000,setpts=PTS-STARTPTS[composition_scene_0_trim]",
				"[composition_scene_0_trim]split=2[composition_scene_0_layer_0_src][composition_scene_0_layer_1_src]",
				"[composition_scene_0_layer_0_src]crop=1215:1080:0:0,scale=1080:960[composition_scene_0_layer_0]",
				"[composition_scene_0_layer_1_src]crop=1215:1080:705:0,scale=1080:960[composition_scene_0_layer_1]",
				"[composition_scene_0_layer_0][composition_scene_0_layer_1]vstack=inputs=2,setsar=1,format=yuv420p[composition_scene_0]",
				"[composition_scene_0]format=yuv420p[outv]",
			],
		});
	});

	test("compiles explicit Split with the planner's encodable 4:5 partition", () => {
		const compiled = compileCompositionPlanVideo({
			plan: planSplit(),
			targetId: "variant-1",
			videoInputLabel: "[0:v]",
			outputLabel: "[outv]",
		});

		expect(compiled.filterParts).toContain(
			"[composition_scene_0_layer_0_src]crop=1725:1080:0:0,scale=1080:676[composition_scene_0_layer_0]",
		);
		expect(compiled.filterParts).toContain(
			"[composition_scene_0_layer_1_src]crop=1731:1080:189:0,scale=1080:674[composition_scene_0_layer_1]",
		);
		expect(compiled.filterParts).toContain(
			"[composition_scene_0_layer_0][composition_scene_0_layer_1]vstack=inputs=2,setsar=1,format=yuv420p[composition_scene_0]",
		);
	});

	test("compiles Screen from planned contain and PiP geometry", () => {
		expect(
			compileCompositionPlanVideo({
				plan: planScreen(),
				targetId: "variant-1",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
			}).filterParts,
		).toEqual([
			"[0:v]trim=start=0.000:end=5.000,setpts=PTS-STARTPTS[composition_scene_0_trim]",
			"[composition_scene_0_trim]split=2[composition_scene_0_layer_0_src][composition_scene_0_layer_1_src]",
			"[composition_scene_0_layer_0_src]scale=1080:676:force_original_aspect_ratio=decrease,pad=1080:676:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[composition_scene_0_layer_0]",
			"[composition_scene_0_layer_1_src]crop=445:278:1352:714,scale=1080:674[composition_scene_0_layer_1]",
			"[composition_scene_0_layer_0][composition_scene_0_layer_1]vstack=inputs=2,setsar=1,format=yuv420p[composition_scene_0]",
			"[composition_scene_0]format=yuv420p[outv]",
		]);
	});

	test("keeps a rotated manual layer centered on its planned destination", () => {
		const plan = planAuto();
		const target = plan.targets[0]!;
		const scene = target.scenes[0]!;
		const layer = scene.layers[0]!;
		const rotated = {
			...plan,
			targets: [
				{
					...target,
					scenes: [
						{
							...scene,
							layers: [
								{
									...layer,
									destination: { x: 108, y: 200, width: 864, height: 720 },
									rotationDeg: 15,
								},
							],
						},
					],
				},
			],
		};

		const compiled = compileCompositionPlanVideo({
			plan: rotated,
			targetId: "variant-1",
			videoInputLabel: "[0:v]",
			outputLabel: "[outv]",
		}).filterParts.join(";");
		expect(compiled).toContain(
			"rotate=15.000*PI/180:ow=rotw(iw):oh=roth(ih):c=black@0",
		);
		expect(compiled).toContain(
			"overlay=108+(864-overlay_w)/2:200+(720-overlay_h)/2",
		);
	});

	test("maps B-roll inputs from planned windows while compiling the unchanged base geometry", () => {
		const plan = planBroll();
		const compiled = compileCompositionPlanVideo({
			plan,
			targetId: "variant-1",
			videoInputLabel: "[0:v]",
			outputLabel: "[stage0]",
			resolvedBrollAssets: { "broll:cutaway": "/tmp/cutaway.mp4" },
			brollInputStartIndex: 1,
		});
		expect(compiled.brollInputs).toEqual([
			{
				sourceRef: "broll:cutaway",
				path: "/tmp/cutaway.mp4",
				kind: "video",
				motion: null,
				inputIndex: 1,
				startSec: 1.5,
				endSec: 4,
			},
		]);
		expect(compiled.filterParts.join(";")).toContain(
			"[1:v]scale=1080:1920:force_original_aspect_ratio=increase",
		);
		expect(compiled.filterParts.join(";")).toContain(
			"overlay=0:0:enable='gte(t,1.5)*lt(t,4)'[stage0]",
		);
	});

	test("compiles every shared media-motion fixture on the FFmpeg B-roll path", () => {
		for (const fixture of MOTION_ADAPTER_FIXTURES.media) {
			const base = planBroll();
			const target = base.targets[0]!;
			const motion = planMediaMotion({
				entrance: fixture.entrance,
				exit: fixture.exit,
				durationSec: fixture.durationSec,
				activeRange: { startSec: 1.5, endSec: 4 },
				canvas: target.canvas,
			});
			const plan = {
				...base,
				targets: base.targets.map((candidate) => ({
					...candidate,
					scenes: candidate.scenes.map((scene) => ({
						...scene,
						layers: scene.layers.map((layer) =>
							layer.kind === "broll-video" || layer.kind === "broll-image"
								? { ...layer, motion }
								: layer,
						),
					})),
				})),
			};
			const compiled = compileCompositionPlanVideo({
				plan,
				targetId: "variant-1",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
				resolvedBrollAssets: { "broll:cutaway": "/tmp/cutaway.mp4" },
				brollInputStartIndex: 1,
			});

			expect(compiled.brollInputs[0]?.motion, fixture.id).toEqual(motion);
			expect(compiled.filterParts.join(";"), fixture.id).toContain("[outv]");
			expect(compiled.filterParts.join(";").length, fixture.id).toBeLessThan(
				64_000,
			);
		}
	});

	test.each([
		{ anchors: [2.5] },
		{ anchors: [0] },
		{ anchors: [0, 3.5] },
		{ anchors: [1.75] },
		{ anchors: [3.75] },
	])("preserves final B-roll motion across inserted scenes at %j", ({
		anchors,
	}) => {
		const plan = planBrollWithInsertions(anchors);
		const target = plan.targets[0]!;
		const planned = target.scenes
			.flatMap((scene) => scene.layers)
			.find((layer) => layer.kind === "broll-video");
		if (!planned || planned.kind !== "broll-video")
			throw new Error("expected planned B-roll");
		const compiled = compileCompositionPlanVideo({
			plan,
			targetId: target.id,
			videoInputLabel: "[0:v]",
			outputLabel: "[outv]",
			resolvedBrollAssets: { "broll:cutaway": "/tmp/cutaway.mp4" },
			brollInputStartIndex: 1,
		});
		expect(compiled.brollInputs).toEqual([
			{
				sourceRef: planned.sourceRef,
				path: "/tmp/cutaway.mp4",
				inputIndex: 1,
				startSec: planned.activeRange.startSec,
				endSec: planned.activeRange.endSec,
				kind: "video",
				motion: planned.motion,
			},
		]);
		expect(compiled.filterParts.join(";")).toContain(
			`setpts=PTS-STARTPTS+${planned.activeRange.startSec}/TB`,
		);
	});

	test("renders middle insertion visibility, final-time B-roll fades and video playback", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "narriflow-inserted-broll-"),
		);
		realMediaDirectories.push(directory);
		const sourcePath = join(directory, "source.mp4");
		const brollPath = join(directory, "broll.mp4");
		const outputPath = join(directory, "output.mp4");
		const run = async (args: string[]) => {
			const process = Bun.spawn(["ffmpeg", "-v", "error", "-y", ...args], {
				stdout: "ignore",
				stderr: "pipe",
			});
			const stderr = await new Response(process.stderr).text();
			expect(await process.exited, stderr).toBe(0);
		};
		await run([
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=160x90:r=20:d=5",
			"-vf",
			"drawbox=color=yellow:t=fill:enable='gte(t,4.1)'",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			sourcePath,
		]);
		await run([
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=160x90:r=20:d=5",
			"-vf",
			"drawbox=color=blue:t=fill:enable='gte(t,2)'",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			brollPath,
		]);
		const plan = planBrollWithInsertions();
		const target = plan.targets[0]!;
		const motion = target.scenes
			.flatMap((scene) => scene.layers)
			.find((layer) => layer.kind === "broll-video")?.motion;
		if (!motion) throw new Error("expected planned motion");
		const compiled = compileCompositionPlanVideo({
			plan,
			targetId: target.id,
			videoInputLabel: "[0:v]",
			outputLabel: "[outv]",
			fps: 20,
			resolvedBrollAssets: { "broll:cutaway": brollPath },
			brollInputStartIndex: 1,
		});
		await run([
			"-i",
			sourcePath,
			"-i",
			brollPath,
			"-filter_complex",
			compiled.filterParts.join(";"),
			"-map",
			"[outv]",
			"-t",
			String(plan.editedDurationSec),
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			outputPath,
		]);
		const rgbAt = async (timeSec: number) => {
			const process = Bun.spawn(
				[
					"ffmpeg",
					"-v",
					"error",
					"-ss",
					String(timeSec),
					"-i",
					outputPath,
					"-frames:v",
					"1",
					"-vf",
					"format=rgb24",
					"-f",
					"rawvideo",
					"pipe:1",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const bytes = new Uint8Array(
				await new Response(process.stdout).arrayBuffer(),
			);
			const stderr = await new Response(process.stderr).text();
			expect(await process.exited, stderr).toBe(0);
			expect(bytes.length).toBe(160 * 90 * 3);
			const offset = (45 * 160 + 80) * 3;
			return [bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!];
		};
		const before = await rgbAt(2.2);
		expect(before[0]).toBeGreaterThan(230);
		expect(before[2]).toBeLessThan(20);
		for (const time of [2.5, 3]) {
			const inserted = await rgbAt(time);
			expect(inserted[1]).toBeGreaterThan(230);
			expect(inserted[0]).toBeLessThan(20);
			expect(inserted[2]).toBeLessThan(20);
		}
		// Video time continues through the inserted Scene, matching Studio's
		// final-time playback: at 4s the B-roll's own time is 2.5s, already blue.
		const after = await rgbAt(4);
		expect(after[2]).toBeGreaterThan(230);
		expect(after[0]).toBeLessThan(20);
		for (const time of [4.6, 4.85]) {
			const exiting = await rgbAt(time);
			const expected =
				sampleCompositionMotion(motion, time).opacity * after[2]!;
			expect(Math.abs(exiting[2]! - expected)).toBeLessThan(20);
		}
		// After the cutaway, final 5.2s must expose source 4.2s, whose frames
		// turned yellow. Trimming source fragments at final time would miss it.
		const resumed = await rgbAt(5.2);
		expect(resumed[0]).toBeGreaterThan(230);
		expect(resumed[1]).toBeGreaterThan(230);
		expect(resumed[2]).toBeLessThan(20);
	}, 30_000);

	test("renders delayed inserted Scene motion overrides at their final-time windows", async () => {
		const planned = planClipComposition({
			document: editorDocumentSchema.parse({
				version: 2,
				clipStartSec: 0,
				clipEndSec: 4,
				captionPreset: captionPresetSchema.parse({ visible: false }),
				transcriptSlice: [],
				studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
				brollUrl: null,
				deletedRanges: [],
				sceneBlocks: [
					{
						id: "8ab9d330-688f-4574-932c-27ac661245c1",
						schemaVersion: 1,
						anchorSec: 2,
						durationSec: 3,
						content: { kind: "color", color: "#FF0000" },
						motion: { entrance: "none", exit: "none" },
						templateSnapshot: null,
					},
				],
				mediaMotions: [
					{
						schemaVersion: 1,
						id: "a3196d76-b71d-4b93-8812-7435b9e17faf",
						target: {
							kind: "scene_block",
							sceneBlockId: "8ab9d330-688f-4574-932c-27ac661245c1",
						},
						startSec: 3,
						endSec: 5,
						entrance: "fade",
						exit: "fade",
						durationSec: 0.5,
						enabled: true,
					},
				],
			}),
			source: {
				identity: "source:delayed-scene-motion",
				kind: "video",
				width: 160,
				height: 90,
			},
			evidence: { automaticLayout: { state: "missing" } },
			assets: { backgroundImage: { state: "missing" } },
			capabilities: {
				automaticSpeakerLayout: true,
				automaticSpeakerEngineVersion: "shot-layout-v3",
			},
			targets: [
				{ id: "delayed-scene", aspectRatio: "16:9", width: 160, height: 90 },
			],
		});
		if (planned.status === "invalid") throw new Error(planned.error.code);
		const plan = planned.plan;
		const scene = plan.targets[0]!.scenes.find((candidate) =>
			candidate.layers.some((layer) => layer.kind === "inserted-scene"),
		)!;
		const motion = scene.layers.find(
			(layer) => layer.kind === "inserted-scene",
		)!.motion!;
		expect(scene.startSec).toBe(2);
		expect(motion.entrance!.range).toEqual({ startSec: 3, endSec: 3.5 });
		const compiled = compileCompositionPlanVideo({
			plan,
			targetId: "delayed-scene",
			videoInputLabel: "[0:v]",
			outputLabel: "[outv]",
			fps: 20,
		});
		const directory = await mkdtemp(
			join(tmpdir(), "narriflow-delayed-scene-motion-"),
		);
		realMediaDirectories.push(directory);
		const outputPath = join(directory, "output.mp4");
		const render = Bun.spawn(
			[
				"ffmpeg",
				"-v",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"color=c=blue:s=160x90:r=20:d=4",
				"-filter_complex",
				compiled.filterParts.join(";"),
				"-map",
				"[outv]",
				"-t",
				String(plan.editedDurationSec),
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				outputPath,
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		const renderError = await new Response(render.stderr).text();
		expect(await render.exited, renderError).toBe(0);
		const redAt = async (timeSec: number) => {
			const frame = Bun.spawn(
				[
					"ffmpeg",
					"-v",
					"error",
					"-ss",
					String(timeSec),
					"-i",
					outputPath,
					"-frames:v",
					"1",
					"-vf",
					"format=rgb24",
					"-f",
					"rawvideo",
					"pipe:1",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const bytes = new Uint8Array(
				await new Response(frame.stdout).arrayBuffer(),
			);
			const frameError = await new Response(frame.stderr).text();
			expect(await frame.exited, frameError).toBe(0);
			expect(bytes).toHaveLength(160 * 90 * 3);
			return bytes[(45 * 160 + 80) * 3]!;
		};
		const fullRed = await redAt(4);
		expect(fullRed).toBeGreaterThan(230);
		for (const timeSec of [2.25, 3.25, 4.75]) {
			const expected =
				sampleCompositionMotion(motion, timeSec).opacity * fullRed;
			expect(Math.abs((await redAt(timeSec)) - expected)).toBeLessThan(20);
		}
		expect(compiled.filterParts.join(";")).toContain(
			"fade=t=in:st=1.000:d=0.500",
		);
		expect(compiled.filterParts.join(";")).toContain(
			"fade=t=out:st=2.500:d=0.500",
		);
	}, 30_000);

	test("bounds source-fragment compilation at 64 Automatic scenes and four targets", () => {
		const sourceIdentity = "source:max-inserted-scenes";
		const segments = Array.from({ length: 64 }, (_, index) => ({
			startSec: index,
			endSec: index + 1,
			layout: "single" as const,
			cxNorm: index % 2 === 0 ? 0.3 : 0.7,
			cyNorm: 0.5,
			zoom: 1,
			subjects: [],
		}));
		const analysis = clipAutoLayoutAnalysisSchema.parse({
			version: 3,
			engine: "shot-layout-v3",
			sourceIdentity,
			analyzedAtISO: "2026-10-04T00:00:00.000Z",
			clipStartSec: 0,
			clipEndSec: 64,
			deletedRanges: [],
			editedDurationSec: 64,
			sourceWidth: 1920,
			sourceHeight: 1080,
			segments,
			noSplitSegments: segments,
			shotCount: 64,
			soloShotCount: 64,
			multiShotCount: 0,
			twoUpSegmentCount: 0,
			speakerCount: 1,
			mappedSpeakerCount: 1,
		});
		const document = editorDocumentSchema.parse({
			version: 2,
			clipStartSec: 0,
			clipEndSec: 64,
			captionPreset: captionPresetSchema.parse({ visible: false }),
			transcriptSlice: [],
			studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
			brollUrl: "https://example.com/cutaway.mp4",
			deletedRanges: [],
			sceneBlocks: [
				{
					id: "8ab9d330-688f-4574-932c-27ac661245c1",
					schemaVersion: 1,
					anchorSec: 32.5,
					durationSec: 1,
					content: { kind: "color", color: "#00FF00" },
					motion: { entrance: "none", exit: "none" },
					templateSnapshot: null,
				},
			],
			mediaMotions: [],
		});
		const planned = planClipComposition({
			document,
			source: {
				identity: sourceIdentity,
				kind: "video",
				width: 1920,
				height: 1080,
			},
			evidence: {
				automaticLayout: {
					state: "available",
					value: {
						sourceIdentity,
						engineVersion: "shot-layout-v3",
						analysis,
						inputFingerprint: automaticLayoutInputFingerprint({
							sourceIdentity,
							clipStartSec: 0,
							clipEndSec: 64,
							deletedRanges: [],
							engineVersion: "shot-layout-v3",
						}),
					},
				},
			},
			assets: {
				backgroundImage: { state: "missing" },
				broll: {
					state: "available",
					placements: [
						{ id: "cutaway", ref: "broll:cutaway", startSec: 0, endSec: 64 },
					],
				},
			},
			capabilities: {
				automaticSpeakerLayout: true,
				automaticSpeakerEngineVersion: "shot-layout-v3",
			},
			targets: [
				{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 },
				{ id: "square", aspectRatio: "1:1", width: 1080, height: 1080 },
				{ id: "landscape", aspectRatio: "16:9", width: 1920, height: 1080 },
				{ id: "portrait", aspectRatio: "4:5", width: 1080, height: 1350 },
			],
		});
		if (planned.status === "invalid") throw new Error(planned.error.code);
		for (const target of planned.plan.targets) {
			const compiled = compileCompositionPlanVideo({
				plan: planned.plan,
				targetId: target.id,
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
				resolvedBrollAssets: { "broll:cutaway": "/tmp/cutaway.mp4" },
				brollInputStartIndex: 1,
			});
			expect(compiled.filterParts.join(";").length).toBeLessThan(64_000);
			expect(compiled.brollInputs).toHaveLength(1);
			expect(compiled.brollInputs[0]).toMatchObject({
				startSec: 0,
				endSec: 65,
				motion: null,
			});
		}
	});

	test("compiles every inserted scene kind, fit treatment, own audio, frozen font, and target from one plan", () => {
		const { plan, imageRef, videoRef, fontRef } = planInsertedScenes();
		for (const target of plan.targets) {
			const compiled = compileCompositionPlanVideo({
				plan,
				targetId: target.id,
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
				resolvedSceneAssets: {
					[imageRef]: { path: "/tmp/card.png", kind: "image" },
					[videoRef]: { path: "/tmp/insert.mp4", kind: "video" },
				},
				resolvedSceneFonts: { [fontRef]: "/tmp/brand.ttf" },
				sceneInputStartIndex: 1,
			});
			const graph = compiled.filterParts.join(";");
			expect(compiled.sceneInputs.map((input) => input.sourceRef)).toEqual([
				imageRef,
				videoRef,
			]);
			expect(graph).toContain(
				`s=${target.canvas.width}x${target.canvas.height}`,
			);
			expect(graph).toContain(
				`drawtext=fontfile='/tmp/brand.ttf':text=${escapeDrawtextText("Opening: 100%")}`,
			);
			expect(graph).toContain("force_original_aspect_ratio=decrease,pad=");
			expect(graph).toContain("force_original_aspect_ratio=increase,crop=");
			expect(graph).toContain("scale=w='max(2,round(iw*");
			expect(graph).toContain("1.080000+-0.080000");
			expect(graph).toContain(
				`pad=${target.canvas.width}:${target.canvas.height}:(ow-iw)/2:(oh-ih)/2`,
			);
			expect(graph).toContain(
				`crop=w='min(iw,${target.canvas.width})':h='min(ih,${target.canvas.height})'`,
			);
			expect(graph).toContain("concat=n=5:v=1:a=0");

			const audio = compileCompositionPlanSceneAudio({
				plan,
				targetId: target.id,
				sourceAudioLabel: "[0:a]",
				sceneInputs: [
					{ sourceRef: imageRef, inputIndex: 1, hasAudio: false },
					{ sourceRef: videoRef, inputIndex: 2, hasAudio: true },
				],
			});
			expect(audio.outputLabel).toBe("[composition_scene_audio]");
			expect(audio.filterParts.join(";")).toContain(
				"[2:a]atrim=start=0.000:end=1.000",
			);
			expect(audio.filterParts.join(";")).toContain("volume=0.650");
			expect(audio.filterParts.join(";")).toContain("concat=n=5:v=0:a=1");
		}
	});

	test("translates every shared Scene text fixture without re-fitting it", () => {
		const { plan, imageRef, videoRef, fontRef } = planInsertedScenes();
		for (const fixture of SCENE_TEXT_ADAPTER_FIXTURES) {
			const fixturePlan = {
				...plan,
				targets: plan.targets.map((target) => ({
					...target,
					scenes: target.scenes.map((scene) => ({
						...scene,
						layers: scene.layers.map((layer) =>
							layer.kind === "inserted-scene" && layer.content.kind === "text"
								? {
										...layer,
										content: { ...layer.content, text: fixture.text },
										textRender: fixture.render,
									}
								: layer,
						),
					})),
				})),
			};
			const compiled = compileCompositionPlanVideo({
				plan: fixturePlan,
				targetId: "vertical",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
				resolvedSceneAssets: {
					[imageRef]: { path: "/tmp/card.png", kind: "image" },
					[videoRef]: { path: "/tmp/insert.mp4", kind: "video" },
				},
				resolvedSceneFonts: { [fontRef]: "/tmp/brand.ttf" },
				sceneInputStartIndex: 1,
			});
			const graph = compiled.filterParts.join(";");
			expect(graph.match(/drawtext=/g), fixture.id).toHaveLength(
				fixture.render.lines.length,
			);
			expect(
				graph.match(new RegExp(`fontsize=${fixture.render.fontSizePx}`, "g")),
				fixture.id,
			).toHaveLength(fixture.render.lines.length);
			const expectedEscapedLines = fixture.render.lines.map(escapeDrawtextText);
			for (const line of expectedEscapedLines) {
				expect(graph, fixture.id).toContain(line);
			}
			expect(graph, fixture.id).not.toContain("line_spacing=12");
		}
	});

	test("executes the shared multilingual Scene text fixture in real FFmpeg", async () => {
		const fixture = SCENE_TEXT_ADAPTER_FIXTURES.find(
			(candidate) => candidate.id === "escaped-multilingual-title",
		);
		if (!fixture) throw new Error("missing multilingual Scene text fixture");
		const planned = planClipComposition({
			document: editorDocumentSchema.parse({
				version: 2,
				clipStartSec: 0,
				clipEndSec: 1,
				captionPreset: captionPresetSchema.parse({ visible: false }),
				transcriptSlice: [],
				studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
				brollUrl: null,
				deletedRanges: [],
				sceneBlocks: [
					{
						id: "d8ab95f8-fc16-4e60-814e-69762a59a99b",
						schemaVersion: 1,
						anchorSec: 0,
						durationSec: 1,
						content: {
							kind: "text",
							text: fixture.text,
							fontFamily: "Arial",
							fontAsset: null,
							color: "#FFFFFF",
							backgroundColor: "#111827",
						},
						motion: { entrance: "none", exit: "none" },
						templateSnapshot: null,
					},
				],
			}),
			source: {
				identity: "source:real-scene-text",
				kind: "video",
				width: 1080,
				height: 1080,
			},
			evidence: { automaticLayout: { state: "missing" } },
			assets: { backgroundImage: { state: "missing" } },
			capabilities: {
				automaticSpeakerLayout: true,
				automaticSpeakerEngineVersion: "shot-layout-v3",
			},
			targets: [
				{ id: "square", aspectRatio: "1:1", width: 1080, height: 1080 },
			],
		});
		if (planned.status === "invalid") throw new Error(planned.error.code);
		const fixturePlan = {
			...planned.plan,
			targets: planned.plan.targets.map((target) => ({
				...target,
				scenes: target.scenes.map((scene) => ({
					...scene,
					layers: scene.layers.map((layer) =>
						layer.kind === "inserted-scene" && layer.content.kind === "text"
							? { ...layer, textRender: fixture.render }
							: layer,
					),
				})),
			})),
		};
		const compiled = compileCompositionPlanVideo({
			plan: fixturePlan,
			targetId: "square",
			videoInputLabel: "[0:v]",
			outputLabel: "[outv]",
		});
		const process = Bun.spawn(
			[
				"ffmpeg",
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=1080x1080:rate=24:duration=1",
				"-filter_complex",
				compiled.filterParts.join(";"),
				"-map",
				"[outv]",
				"-f",
				"null",
				"-",
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		const stderr = await new Response(process.stderr).text();
		expect(await process.exited, stderr).toBe(0);
	}, 30_000);

	test("fails closed when a required inserted-scene asset is missing", () => {
		const { plan } = planInsertedScenes();
		expect(() =>
			compileCompositionPlanVideo({
				plan,
				targetId: "vertical",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
				resolvedSceneAssets: {},
				sceneInputStartIndex: 1,
			}),
		).toThrow("clip_composition_scene_input_missing");
	});

	test("fails closed when a frozen Brand font file is missing", () => {
		const { plan, imageRef, videoRef } = planInsertedScenes();
		expect(() =>
			compileCompositionPlanVideo({
				plan,
				targetId: "vertical",
				videoInputLabel: "[0:v]",
				outputLabel: "[outv]",
				resolvedSceneAssets: {
					[imageRef]: { path: "/tmp/card.png", kind: "image" },
					[videoRef]: { path: "/tmp/insert.mp4", kind: "video" },
				},
				sceneInputStartIndex: 1,
			}),
		).toThrow("clip_composition_scene_font_missing");
	});

	test("matches shared preview deltas while rendering every media-motion family with real media", async () => {
		const directory = await mkdtemp(join(tmpdir(), "narriflow-scene-render-"));
		realMediaDirectories.push(directory);
		const sourcePath = join(directory, "source.mp4");
		const imagePath = join(directory, "image.png");
		const outputPath = join(directory, "output.mp4");
		const run = async (args: string[]) => {
			const process = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
			const stderr = await new Response(process.stderr).text();
			expect(await process.exited, stderr).toBe(0);
		};
		await run([
			"ffmpeg",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=320x180:rate=24",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000",
			"-t",
			"4",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			sourcePath,
		]);
		await run([
			"ffmpeg",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=180x320:rate=1",
			"-frames:v",
			"1",
			imagePath,
		]);

		const imageId = "141b738e-f106-4da1-b670-8b71ff7f0a58";
		const fingerprint = "a".repeat(64);
		const families = ["fade", "scale-in", "ken-burns-in", "pan-up"] as const;
		const sceneIds = [
			"8ab9d330-688f-4574-932c-27ac661245c1",
			"d8ab95f8-fc16-4e60-814e-69762a59a99b",
			"a3196d76-b71d-4b93-8812-7435b9e17faf",
			"31ddc1dd-838c-4fed-a940-4cbed7a3974b",
		];
		const planned = planClipComposition({
			document: editorDocumentSchema.parse({
				version: 2,
				clipStartSec: 0,
				clipEndSec: 4,
				captionPreset: captionPresetSchema.parse({}),
				transcriptSlice: [],
				studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
				brollUrl: null,
				deletedRanges: [],
				sceneBlocks: families.map((entrance, index) => ({
					id: sceneIds[index]!,
					schemaVersion: 1,
					anchorSec: index,
					durationSec: 1,
					content: {
						kind: "image" as const,
						asset: { kind: "visual_asset" as const, id: imageId, fingerprint },
						fit: "cover" as const,
						backgroundColor: "#050505",
					},
					motion: { entrance, exit: "none" as const, durationSec: 0.35 },
					templateSnapshot: null,
				})),
			}),
			source: {
				identity: "source:key",
				kind: "video",
				width: 320,
				height: 180,
			},
			evidence: { automaticLayout: { state: "missing" } },
			assets: { backgroundImage: { state: "missing" } },
			capabilities: {
				automaticSpeakerLayout: true,
				automaticSpeakerEngineVersion: "shot-layout-v3",
			},
			targets: [{ id: "real", aspectRatio: "9:16", width: 180, height: 320 }],
		});
		if (planned.status === "invalid") throw new Error(planned.error.code);
		const plan = planned.plan;
		const imageRef = compositionAssetRef(
			"visual_asset",
			`${imageId}:${fingerprint}`,
		);
		const motionLayers = plan.targets[0]!.scenes.flatMap((scene) =>
			scene.layers.filter(
				(layer) => layer.kind === "inserted-scene" && layer.motion,
			),
		);
		expect(motionLayers).toHaveLength(families.length);
		const sampledFamilies = motionLayers.map((layer, index) => {
			const motion = layer.motion!;
			const startSec = index + 1 / 24;
			const middleSec = index + 0.5;
			return {
				startSec,
				middleSec,
				start: sampleCompositionMotion(motion, startSec),
				middle: sampleCompositionMotion(motion, middleSec),
			};
		});
		expect(sampledFamilies[0]!.start.opacity).toBeLessThan(
			sampledFamilies[0]!.middle.opacity,
		);
		expect(sampledFamilies[1]!.start.transform.scale).toBeLessThan(
			sampledFamilies[1]!.middle.transform.scale,
		);
		expect(sampledFamilies[2]!.start.crop.width).toBeGreaterThan(
			sampledFamilies[2]!.middle.crop.width,
		);
		expect(sampledFamilies[3]!.start.transform.translateY).not.toBe(
			sampledFamilies[3]!.middle.transform.translateY,
		);
		const audio = bindCompositionPlanAudioInputs(
			compileCompositionPlanAudioSchedule(plan),
			{},
		);
		const args = compileClipCompositionCommand({
			sourcePath,
			outputPath,
			startSec: 0,
			endSec: 4,
			audio,
			source: {
				hasVideo: true,
				hasAudio: true,
				width: 320,
				height: 180,
				durationSec: 4,
				fps: 24,
			},
			plan: { plan, targetId: "real" }.plan,
			targetId: { plan, targetId: "real" }.targetId,
			encoder: { preset: "veryfast", crf: "21" },
			assets: {
				subtitlePath: null,
				scenes: {
					[imageRef]: { path: imagePath, kind: "image", hasAudio: false },
				},
				fonts: {},
			},
		});
		await run(["ffmpeg", ...args]);
		const probe = Bun.spawn(
			[
				"ffprobe",
				"-v",
				"error",
				"-show_entries",
				"format=duration:stream=codec_type,width,height",
				"-of",
				"json",
				outputPath,
			],
			{ stdout: "pipe" },
		);
		const result = (await new Response(probe.stdout).json()) as {
			format: { duration: string };
			streams: Array<{ codec_type: string; width?: number; height?: number }>;
		};
		expect(await probe.exited).toBe(0);
		expect(Number(result.format.duration)).toBeCloseTo(
			plan.editedDurationSec,
			1,
		);
		expect(result.streams).toContainEqual(
			expect.objectContaining({ codec_type: "video", width: 180, height: 320 }),
		);
		expect(result.streams).toContainEqual(
			expect.objectContaining({ codec_type: "audio" }),
		);
		const frameAt = async (timeSec: number) => {
			const frame = Bun.spawn(
				[
					"ffmpeg",
					"-v",
					"error",
					"-ss",
					timeSec.toFixed(3),
					"-i",
					outputPath,
					"-frames:v",
					"1",
					"-vf",
					"format=rgb24",
					"-f",
					"rawvideo",
					"pipe:1",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const bytes = new Uint8Array(
				await new Response(frame.stdout).arrayBuffer(),
			);
			const stderr = await new Response(frame.stderr).text();
			expect(await frame.exited, stderr).toBe(0);
			expect(bytes).toHaveLength(180 * 320 * 3);
			return bytes;
		};
		const meanAbsoluteDifference = (left: Uint8Array, right: Uint8Array) => {
			let total = 0;
			for (let index = 0; index < left.length; index++) {
				total += Math.abs(left[index]! - right[index]!);
			}
			return total / left.length;
		};
		for (const sample of sampledFamilies) {
			const startFrame = await frameAt(sample.startSec);
			const middleFrame = await frameAt(sample.middleSec);
			// Each pair is the same frozen, non-uniform image. A material frame
			// delta therefore proves that the FFmpeg adapter expressed the exact
			// state change predicted by the shared preview sampler, rather than
			// merely producing a valid but motionless file.
			expect(meanAbsoluteDifference(startFrame, middleFrame)).toBeGreaterThan(
				2,
			);
		}
	}, 30_000);

	test("renders beep and mute against real dialogue while preserving music without clipping", async () => {
		const directory = await mkdtemp(join(tmpdir(), "narriflow-censor-audio-"));
		realMediaDirectories.push(directory);
		const sourcePath = join(directory, "source.mp4");
		const musicPath = join(directory, "music.wav");
		const outputPath = join(directory, "output.mp4");
		const run = async (args: string[]) => {
			const process = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
			const stderr = await new Response(process.stderr).text();
			expect(await process.exited, stderr).toBe(0);
		};
		await run([
			"ffmpeg",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=320x180:r=24",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000",
			"-t",
			"4",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			sourcePath,
		]);
		await run([
			"ffmpeg",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=220:sample_rate=48000",
			"-t",
			"4",
			musicPath,
		]);

		const planned = planClipComposition({
			document: editorDocumentSchema.parse({
				version: 2,
				clipStartSec: 0,
				clipEndSec: 4,
				captionPreset: captionPresetSchema.parse({}),
				transcriptSlice: [],
				studioEdits: studioEditsSchema.parse({
					framing: { mode: "center" },
					music: { url: "https://example.com/music.wav", volume: 30 },
				}),
				brollUrl: null,
				deletedRanges: [],
				censorSegments: [
					{
						schemaVersion: 1,
						id: "02650dd9-6f3c-44ec-986c-2fdd5c69d984",
						sourceWordIds: ["word:beep"],
						sourceStartSec: 1,
						sourceEndSec: 1.5,
						treatment: "beep",
						paddingSec: 0,
						beepSettings: { frequencyHz: 1_000, levelDb: -8 },
						captionMaskPolicy: null,
						suggestionFingerprint: null,
						policyVersion: "fixture-v1",
						enabled: true,
					},
					{
						schemaVersion: 1,
						id: "359735d5-2e12-44e0-bf50-bdaee376a20d",
						sourceWordIds: ["word:mute"],
						sourceStartSec: 2,
						sourceEndSec: 2.5,
						treatment: "mute",
						paddingSec: 0,
						beepSettings: null,
						captionMaskPolicy: null,
						suggestionFingerprint: null,
						policyVersion: "fixture-v1",
						enabled: true,
					},
				],
			}),
			source: {
				identity: "source:censor-real",
				kind: "video",
				width: 320,
				height: 180,
				hasAudio: true,
			},
			evidence: { automaticLayout: { state: "missing" } },
			capabilities: {
				automaticSpeakerLayout: true,
				automaticSpeakerEngineVersion: "shot-layout-v3",
			},
			assets: {
				backgroundImage: { state: "missing" },
				music: { state: "available", ref: "music:censor-real", durationSec: 4 },
			},
			targets: [{ id: "real", aspectRatio: "9:16", width: 180, height: 320 }],
		});
		if (planned.status === "invalid") throw new Error(planned.error.code);
		const audio = bindCompositionPlanAudioInputs(
			compileCompositionPlanAudioSchedule(planned.plan),
			{ music: { sourceRef: "music:censor-real", path: musicPath } },
		);
		const args = compileClipCompositionCommand({
			sourcePath,
			outputPath,
			startSec: 0,
			endSec: 4,
			audio,
			source: {
				hasVideo: true,
				hasAudio: true,
				width: 320,
				height: 180,
				durationSec: 4,
				fps: 24,
			},
			plan: { plan: planned.plan, targetId: "real" }.plan,
			targetId: { plan: planned.plan, targetId: "real" }.targetId,
			encoder: { preset: "veryfast", crf: "21" },
			assets: { subtitlePath: null },
		});
		await run(["ffmpeg", ...args]);

		const decode = Bun.spawn(
			[
				"ffmpeg",
				"-v",
				"error",
				"-i",
				outputPath,
				"-ac",
				"1",
				"-ar",
				"48000",
				"-f",
				"f32le",
				"pipe:1",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const bytes = await new Response(decode.stdout).arrayBuffer();
		const decodeError = await new Response(decode.stderr).text();
		expect(await decode.exited, decodeError).toBe(0);
		const samples = new Float32Array(bytes);
		const amplitude = (
			frequencyHz: number,
			startSec: number,
			endSec: number,
		) => {
			const start = Math.round(startSec * 48_000);
			const end = Math.min(samples.length, Math.round(endSec * 48_000));
			let real = 0;
			let imaginary = 0;
			for (let index = start; index < end; index += 1) {
				const angle = (2 * Math.PI * frequencyHz * index) / 48_000;
				real += samples[index]! * Math.cos(angle);
				imaginary -= samples[index]! * Math.sin(angle);
			}
			return (2 * Math.hypot(real, imaginary)) / Math.max(1, end - start);
		};
		const dialogueBefore = amplitude(440, 0.5, 0.8);
		const musicBefore = amplitude(220, 0.5, 0.8);
		const beepAmplitude = amplitude(1_000, 1.15, 1.35);
		const expectedBeepAmplitude = 10 ** (-8 / 20);
		expect(beepAmplitude).toBeGreaterThan(expectedBeepAmplitude - 0.04);
		expect(beepAmplitude).toBeLessThan(expectedBeepAmplitude + 0.04);
		expect(amplitude(440, 1.15, 1.35)).toBeLessThan(dialogueBefore * 0.15);
		expect(amplitude(440, 2.1, 2.4)).toBeLessThan(dialogueBefore * 0.15);
		expect(amplitude(220, 1.15, 1.35)).toBeGreaterThan(musicBefore * 0.5);
		expect(amplitude(220, 2.1, 2.4)).toBeGreaterThan(musicBefore * 0.5);
		expect(
			samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0),
		).toBeLessThanOrEqual(0.95);
	}, 30_000);

	test("mutes a sub-millisecond dialogue window at decoded sample precision", async () => {
		const directory = await mkdtemp(join(tmpdir(), "narriflow-censor-sub-ms-"));
		realMediaDirectories.push(directory);
		const sourcePath = join(directory, "source.mkv");
		const outputPath = join(directory, "output.mkv");
		const run = async (args: string[]) => {
			const process = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
			const stderr = await new Response(process.stderr).text();
			expect(await process.exited, stderr).toBe(0);
		};
		await run([
			"ffmpeg",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"color=c=black:s=160x90:r=24:d=0.5",
			"-f",
			"lavfi",
			"-i",
			"aevalsrc=0.5:sample_rate=48000:d=0.5",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"pcm_f32le",
			sourcePath,
		]);
		const planned = planClipComposition({
			document: editorDocumentSchema.parse({
				version: 2,
				clipStartSec: 0,
				clipEndSec: 0.5,
				captionPreset: captionPresetSchema.parse({}),
				transcriptSlice: [],
				studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
				brollUrl: null,
				deletedRanges: [],
				censorSegments: [
					{
						schemaVersion: 1,
						id: "42650dd9-6f3c-44ec-986c-2fdd5c69d984",
						sourceWordIds: ["word:sub-ms"],
						sourceStartSec: 0.25,
						sourceEndSec: 0.2505,
						treatment: "mute",
						paddingSec: 0,
						beepSettings: null,
						captionMaskPolicy: null,
						suggestionFingerprint: null,
						policyVersion: "fixture-v1",
						enabled: true,
					},
				],
			}),
			source: {
				identity: "source:sub-ms",
				kind: "video",
				width: 160,
				height: 90,
				hasAudio: true,
			},
			evidence: { automaticLayout: { state: "missing" } },
			capabilities: {
				automaticSpeakerLayout: true,
				automaticSpeakerEngineVersion: "shot-layout-v3",
			},
			assets: { backgroundImage: { state: "missing" } },
			targets: [{ id: "real", aspectRatio: "16:9", width: 160, height: 90 }],
		});
		if (planned.status === "invalid") throw new Error(planned.error.code);
		const audio = bindCompositionPlanAudioInputs(
			compileCompositionPlanAudioSchedule(planned.plan),
			{},
		);
		const args = compileClipCompositionCommand({
			sourcePath,
			outputPath,
			startSec: 0,
			endSec: 0.5,
			audio,
			source: {
				hasVideo: true,
				hasAudio: true,
				width: 160,
				height: 90,
				durationSec: 0.5,
				fps: 24,
			},
			plan: { plan: planned.plan, targetId: "real" }.plan,
			targetId: { plan: planned.plan, targetId: "real" }.targetId,
			encoder: { preset: "veryfast", crf: "21" },
			assets: { subtitlePath: null },
		});
		const audioCodecIndex = args.indexOf("-c:a");
		args[audioCodecIndex + 1] = "pcm_f32le";
		const audioBitrateIndex = args.indexOf("-b:a");
		args.splice(audioBitrateIndex, 2);
		await run(["ffmpeg", ...args]);

		const decode = Bun.spawn(
			[
				"ffmpeg",
				"-v",
				"error",
				"-i",
				outputPath,
				"-ac",
				"1",
				"-ar",
				"48000",
				"-f",
				"f32le",
				"pipe:1",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const bytes = await new Response(decode.stdout).arrayBuffer();
		const decodeError = await new Response(decode.stderr).text();
		expect(await decode.exited, decodeError).toBe(0);
		const samples = new Float32Array(bytes);
		const peak = (startSample: number, endSample: number) =>
			samples
				.slice(startSample, endSample)
				.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
		const muteStart = Math.round(0.25 * 48_000);
		const muteEnd = Math.round(0.2505 * 48_000);
		expect(peak(muteStart, muteEnd)).toBeLessThan(0.001);
		expect(peak(muteStart - 48, muteStart)).toBeGreaterThan(0.4);
		expect(peak(muteEnd, muteEnd + 48)).toBeGreaterThan(0.4);
	}, 30_000);
});

  test("interpolates an automatic crop track inside its shot without changing crop size", () => {
    const plan = planAuto();
    const target = plan.targets[0]!;
    const scene = target.scenes[0]!;
    const layer = scene.layers.find((candidate) => candidate.kind === "source-video")!;
    const tracked = {
      ...plan,
      targets: [{
        ...target,
        scenes: [{
          ...scene,
          layers: scene.layers.map((candidate) => candidate === layer ? {
            ...candidate,
            sourceCropTrack: [
              { ...candidate.sourceCrop, timeSec: 0 },
              { ...candidate.sourceCrop, x: 100, timeSec: 5 },
            ],
          } : candidate),
        }],
      }],
    };
    const compiled = compileCompositionPlanVideo({
      plan: tracked,
      targetId: "variant-1",
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
    });
    expect(compiled.filterParts.join(";")).toContain(
      "x='if(lt(t,5.000),0+(100-0)*(t-0.000)/5.000,100)'",
    );
  });

  test("renders scene-relative crop tracking at three times and matches preview interpolation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "narriflow-crop-track-"));
    realMediaDirectories.push(directory);
    const sourcePath = join(directory, "source.mp4");
    const graphPath = join(directory, "track.ffgraph");
    const outputPath = join(directory, "output.mp4");
    const run = async (args: string[]) => {
      const process = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(process.stderr).text();
      expect(await process.exited, stderr).toBe(0);
    };
    await run([
      "ffmpeg", "-y", "-f", "lavfi", "-i",
      "color=black:s=320x180:r=24,drawbox=x=0:y=0:w=107:h=180:c=red:t=fill,drawbox=x=107:y=0:w=106:h=180:c=green:t=fill,drawbox=x=213:y=0:w=107:h=180:c=blue:t=fill",
      "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", sourcePath,
    ]);
    const sourceIdentity = "source:crop-track";
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 3,
      engine: "shot-layout-v3",
      sourceIdentity,
      analyzedAtISO: "2026-09-14T00:00:00.000Z",
      clipStartSec: 0,
      clipEndSec: 5,
      deletedRanges: [],
      editedDurationSec: 5,
      sourceWidth: 320,
      sourceHeight: 180,
      segments: [
        { startSec: 0, endSec: 2, layout: "single", cxNorm: 0.5, cyNorm: 0.5, zoom: 1, subjects: [] },
        {
          startSec: 2,
          endSec: 5,
          layout: "single",
          cxNorm: 0.25,
          cyNorm: 0.5,
          zoom: 1,
          cropTrack: [
            { timeSec: 2, cxNorm: 0.25, cyNorm: 0.5 },
            { timeSec: 3, cxNorm: 0.75, cyNorm: 0.5 },
            { timeSec: 5, cxNorm: 0.75, cyNorm: 0.5 },
          ],
          subjects: [],
        },
      ],
      noSplitSegments: [
        { startSec: 0, endSec: 2, layout: "single", cxNorm: 0.5, cyNorm: 0.5, zoom: 1, subjects: [] },
        { startSec: 2, endSec: 5, layout: "single", cxNorm: 0.25, cyNorm: 0.5, zoom: 1, cropTrack: [{ timeSec: 2, cxNorm: 0.25, cyNorm: 0.5 }, { timeSec: 3, cxNorm: 0.75, cyNorm: 0.5 }, { timeSec: 5, cxNorm: 0.75, cyNorm: 0.5 }], subjects: [] },
      ],
      shotCount: 2,
      soloShotCount: 2,
      multiShotCount: 0,
      twoUpSegmentCount: 0,
      speakerCount: 0,
      mappedSpeakerCount: 0,
    });
    const document = editorDocumentSchema.parse({
      version: 2,
      clipStartSec: 0,
      clipEndSec: 5,
      captionPreset: captionPresetSchema.parse({ visible: false }),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const planResult = planClipComposition({
      document,
      source: { identity: sourceIdentity, kind: "video", width: 320, height: 180 },
      evidence: { automaticLayout: { state: "available", value: { sourceIdentity, inputFingerprint: automaticLayoutInputFingerprint({ sourceIdentity, clipStartSec: 0, clipEndSec: 5, deletedRanges: [], engineVersion: "shot-layout-v3" }), engineVersion: "shot-layout-v3", analysis } } },
      assets: { backgroundImage: { state: "missing" } },
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v3" },
      targets: [{ id: "vertical", aspectRatio: "9:16", width: 90, height: 160 }],
    });
    if (planResult.status === "invalid") throw new Error(planResult.error.code);
    const compiled = compileCompositionPlanVideo({
      plan: planResult.plan,
      targetId: "vertical",
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
      fps: 24,
    });
    await writeFile(graphPath, compiled.filterParts.join(";"));
    await run(["ffmpeg", "-y", "-i", sourcePath, "-filter_complex_script", graphPath, "-map", "[outv]", "-c:v", "libx264", "-pix_fmt", "yuv420p", outputPath]);
    const trackedLayer = planResult.plan.targets[0]!.scenes[1]!.layers.find(
      (layer) => layer.kind === "source-video",
    );
    if (!trackedLayer || trackedLayer.kind !== "source-video") throw new Error("expected tracked layer");
    const colorAt = async (timeSec: number) => {
      const process = Bun.spawn([
        "ffmpeg", "-v", "error", "-i", outputPath, "-ss", timeSec.toFixed(3),
        "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "pipe:1",
      ], { stdout: "pipe", stderr: "pipe" });
      const bytes = new Uint8Array(await new Response(process.stdout).arrayBuffer());
      const stderr = await new Response(process.stderr).text();
      expect(await process.exited, stderr).toBe(0);
      const offset = (80 * 90 + 45) * 3;
      return [bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!] as const;
    };
    const expectedBand = (timeSec: number) => {
      const crop = interpolateCompositionCropTrack(
        trackedLayer.sourceCrop,
        trackedLayer.sourceCropTrack,
        timeSec,
      );
      const center = crop.x + crop.width / 2;
      return center < 107 ? "red" : center < 213 ? "green" : "blue";
    };
    for (const [timeSec, expected] of [[2.1, "red"], [2.5, "green"], [3.1, "blue"]] as const) {
      expect(expectedBand(timeSec)).toBe(expected);
      const [red, green, blue] = await colorAt(timeSec);
      if (expected === "red") expect(red).toBeGreaterThan(Math.max(green, blue) + 40);
      if (expected === "green") expect(green).toBeGreaterThan(Math.max(red, blue) + 40);
      if (expected === "blue") expect(blue).toBeGreaterThan(Math.max(red, green) + 40);
    }
  }, 30_000);



test("rejects malformed crop tracking instead of emitting unsafe FFmpeg expressions", () => {
  const plan = planAuto();
  const target = plan.targets[0]!;
  const scene = target.scenes[0]!;
  const layer = scene.layers.find((candidate) => candidate.kind === "source-video")!;
  const point = { ...layer.sourceCrop, timeSec: 0 };
  const invalidTracks = [
    [{ ...point, timeSec: Number.NaN }],
    [point, point],
    [point, { ...point, timeSec: 5, width: point.width + 2 }],
    [{ ...point, timeSec: -1 }, { ...point, timeSec: 5 }],
    [point, { ...point, timeSec: 6 }],
    Array.from({ length: 49 }, (_, index) => ({ ...point, timeSec: index * 5 / 48 })),
  ];
  for (const sourceCropTrack of invalidTracks) {
    const tracked = { ...plan, targets: [{ ...target, scenes: [{ ...scene, layers: scene.layers.map((candidate) => candidate === layer ? { ...candidate, sourceCropTrack } : candidate) }] }] };
    expect(() => compileCompositionPlanVideo({ plan: tracked, targetId: target.id, videoInputLabel: "[0:v]", outputLabel: "[outv]" })).toThrow("invalid_clip_composition_source_crop_track");
  }
});


test("compiles 128 tracked two-up shots for four targets within the independent FFmpeg command budget", () => {
    const document = editorDocumentSchema.parse({
    version: 2,
      clipStartSec: 0,
      clipEndSec: 128,
      captionPreset: captionPresetSchema.parse({}),
      transcriptSlice: [],
      studioEdits: studioEditsSchema.parse({ framing: { mode: "auto" } }),
      brollUrl: null,
      deletedRanges: [],
    });
    const source = {
      identity: "source:max-scenes",
      kind: "video" as const,
      width: 1920,
      height: 1080,
    };
    const segments = Array.from({ length: 128 }, (_, index) => ({ subjects: [{ id: "person-0", cxNorm: 0.25, cyNorm: 0.5, zoom: 1 }, { id: "person-1", cxNorm: 0.75, cyNorm: 0.5, zoom: 1 }],
      startSec: index,
      endSec: index + 1,
      layout: "two-up" as const,
      topCxNorm: 0.25,
      bottomCxNorm: 0.75,
      topCropTrack: [{ timeSec: index, cxNorm: 0.25, cyNorm: 0.5 }, { timeSec: index + 1, cxNorm: 0.3, cyNorm: 0.5 }],
      bottomCropTrack: [{ timeSec: index, cxNorm: 0.75, cyNorm: 0.5 }, { timeSec: index + 1, cxNorm: 0.7, cyNorm: 0.5 }],
    }));
    const noSplitSegments = Array.from({ length: 128 }, (_, index) => ({ subjects: [{ id: "person-0", cxNorm: 0.5, cyNorm: 0.5, zoom: 1 }],
      startSec: index,
      endSec: index + 1,
      layout: "single" as const,
      cxNorm: 0.5,
      cropTrack: [{ timeSec: index, cxNorm: 0.5, cyNorm: 0.5 }, { timeSec: index + 1, cxNorm: 0.55, cyNorm: 0.5 }],
    }));
    const analysis = clipAutoLayoutAnalysisSchema.parse({
      version: 3,
      engine: "shot-layout-v3",
      sourceIdentity: source.identity,
      analyzedAtISO: "2026-08-26T00:00:00.000Z",
      clipStartSec: 0,
      clipEndSec: 128,
      deletedRanges: [],
      editedDurationSec: 128,
      sourceWidth: 1920,
      sourceHeight: 1080,
      segments,
      noSplitSegments,
      shotCount: 128,
      soloShotCount: 0,
      multiShotCount: 128,
      twoUpSegmentCount: 128,
      speakerCount: 2,
      mappedSpeakerCount: 2,
    });
    const inputFingerprint = automaticLayoutInputFingerprint({
      sourceIdentity: source.identity,
      clipStartSec: 0,
      clipEndSec: 128,
      deletedRanges: [],
      engineVersion: "shot-layout-v3",
    });
    const input = {
      document,
      source,
      evidence: {
        automaticLayout: {
          state: "available" as const,
          value: {
            sourceIdentity: source.identity,
            inputFingerprint,
            engineVersion: "shot-layout-v3",
            analysis,
          },
        },
      },
      assets: { backgroundImage: { state: "missing" as const } },
      capabilities: {
        automaticSpeakerLayout: true,
        automaticSpeakerEngineVersion: "shot-layout-v3",
      },
      targets: [
        { id: "vertical", aspectRatio: "9:16" as const, width: 1080, height: 1920 },
        { id: "square", aspectRatio: "1:1" as const, width: 1080, height: 1080 },
        { id: "landscape", aspectRatio: "16:9" as const, width: 1920, height: 1080 },
        { id: "portrait", aspectRatio: "4:5" as const, width: 1080, height: 1350 },
      ],
    };

  const result = planClipComposition(input);
  if (result.status === "invalid") throw new Error(result.error.code);
  const plan = result.plan;
  const audio = bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(plan), {});
  for (const target of plan.targets) {
    expect(target.scenes).toHaveLength(128);
    expect(target.scenes.every((scene) => scene.layers.some((layer) => layer.kind === "source-video" && (layer.sourceCropTrack?.length ?? 0) > 0))).toBe(true);
    const args = compileClipCompositionCommand({
      sourcePath: "/tmp/source.mp4", outputPath: "/tmp/output.mp4",
      startSec: 0, endSec: 128, source: { width: 1920, height: 1080, hasVideo: true, hasAudio: true, hasVisualStream: true, durationSec: 128, fps: 30 },
      plan, targetId: target.id, audio, encoder: { preset: "veryfast", crf: "21" }, assets: { subtitlePath: null },
    });
    const bytes = ["ffmpeg", ...args].reduce((total, part) => total + new TextEncoder().encode(part).byteLength + 1, 0);
    expect(bytes).toBeLessThanOrEqual(512 * 1024);
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("concat=n=128");
  }
});
