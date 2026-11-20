import { planClipComposition, type CaptionOverride } from "@narriflow/composition-plan";
import { buildClipCutPlan, captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import {
	bindCompositionPlanAudioInputs,
	compileClipCompositionCommand,
	compileCompositionPlanAudioSchedule,
} from "./composition-ffmpeg-adapter";
import type { WorkerMediaInspection } from "./worker-process";

/** One deterministic argument-builder scenario, shared by the no-dub golden
 *  test (arguments recorded before the dub path existed) and the dub tests. */
export interface DubScenario {
	builder: "single" | "broll" | "audiogram";
	cut?: boolean;
	music?: boolean;
	scenes?: boolean;
	sourceVolume?: number;
	sourceMuted?: boolean;
	sourceHasAudio?: boolean;
	/** Plan the clip with the dub's caption words. */
	captionOverride?: CaptionOverride;
}

const durationSec = 6;
const deletedRanges = [{ startSec: 2, endSec: 3 }];

export function scenarioProbe(scenario: Pick<DubScenario, "builder" | "sourceHasAudio">): WorkerMediaInspection {
	return {
		hasVideo: scenario.builder !== "audiogram",
		hasAudio: scenario.sourceHasAudio ?? true,
		hasVisualStream: scenario.builder !== "audiogram",
		width: scenario.builder === "audiogram" ? 0 : 1920,
		height: scenario.builder === "audiogram" ? 0 : 1080,
		durationSec: 12,
		fps: 30,
	};
}

export function planScenario(scenario: DubScenario) {
	const probe = scenarioProbe(scenario);
	const result = planClipComposition({
		document: editorDocumentSchema.parse({
			version: 1, clipStartSec: 0, clipEndSec: durationSec,
			captionPreset: captionPresetSchema.parse({}),
			transcriptSlice: [],
			studioEdits: studioEditsSchema.parse({
				framing: { mode: "center" },
				sourceAudio: { muted: scenario.sourceMuted ?? false, volume: scenario.sourceVolume ?? 100 },
				...(scenario.music ? { music: { blocks: [{ id: "bed", url: "https://example.com/music.wav", startSec: 0, volume: 20 }], ducking: true } } : {}),
			}),
			brollUrl: null,
			deletedRanges: scenario.cut ? deletedRanges : [],
			censorSegments: [], mediaMotions: [],
			sceneBlocks: scenario.scenes ? [{
				schemaVersion: 1, id: "8ab9d330-688f-4574-932c-27ac661245c1", anchorSec: 1, durationSec: 1,
				content: { kind: "color", color: "#112233" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null,
			}] : [],
		}),
		source: { identity: "source:key", kind: probe.hasVideo ? "video" : "audio", width: probe.width, height: probe.height, hasAudio: probe.hasAudio },
		evidence: { automaticLayout: { state: "missing" } },
		assets: {
			backgroundImage: { state: "missing" },
			...(scenario.music ? { music: { bed: { state: "available", ref: "music:bed", durationSec: 30 } } } as const : {}),
			...(scenario.builder === "broll" ? { broll: { state: "available", placements: [{ id: "cutaway", ref: "broll:clip", startSec: 0.5, endSec: 1.5 }] } } as const : {}),
		},
		capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
		targets: [{ id: "variant-1", aspectRatio: "9:16", width: 1080, height: 1920 }],
		...(scenario.captionOverride ? { captionOverride: scenario.captionOverride } : {}),
	});
	if (result.status === "invalid") throw new Error(result.error.code);
	return result.plan;
}

export function scenarioArgs(scenario: DubScenario, dubPath?: string): string[] {
	const probe = scenarioProbe(scenario);
	const plan = planScenario(scenario);
	return compileClipCompositionCommand({
		sourcePath: "/tmp/source.mp4", outputPath: "/tmp/output.mp4", startSec: 0, endSec: durationSec, source: probe, plan, targetId: "variant-1",
		...(scenario.cut ? { cutPlan: buildClipCutPlan(deletedRanges, { startSec: 0, endSec: durationSec }) } : {}),
		audio: bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(plan), {
			...(scenario.music ? { music: [{ id: "bed", sourceRef: "music:bed", path: "/tmp/music.wav" }] } : {}),
			...(dubPath ? { dub: { path: dubPath } } : {}),
		}),
		encoder: { preset: "veryfast", crf: "21" },
		assets: { subtitlePath: null, ...(scenario.builder === "broll" ? { broll: { "broll:clip": "/tmp/broll.mp4" } } : {}) },
	});
}

export const dubScenarios: ReadonlyArray<{ name: string } & DubScenario> = (["single", "broll", "audiogram"] as const).flatMap(builder => [
	{ name: `${builder} plain`, builder },
	{ name: `${builder} cut`, builder, cut: true },
	{ name: `${builder} music`, builder, music: true },
	{ name: `${builder} scenes`, builder, scenes: true },
	{ name: `${builder} scenes music cut`, builder, scenes: true, music: true, cut: true },
	{ name: `${builder} gain`, builder, sourceVolume: 40 },
	{ name: `${builder} muted`, builder, sourceMuted: true, music: true },
	...(builder === "audiogram" ? [] : [
		{ name: `${builder} silent source`, builder, sourceHasAudio: false },
		{ name: `${builder} silent source music`, builder, sourceHasAudio: false, music: true },
		{ name: `${builder} silent source scenes`, builder, sourceHasAudio: false, scenes: true },
	]),
]);
