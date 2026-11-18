import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { planClipComposition } from "@narriflow/composition-plan";
import { buildClipCutPlan, captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import {
	bindCompositionPlanAudioInputs,
	compileClipCompositionCommand,
	compileCompositionPlanAudioSchedule,
	DUB_OUTPUT_AUDIO,
} from "./composition-ffmpeg-adapter";
import { dubScenarios, planScenario, scenarioArgs, scenarioProbe } from "./composition-dub-fixture";
import goldenArgs from "./__fixtures__/composition-no-dub-args.json";
import { compositionOutputExpectation, validateRenderOutput } from "./render-output-validation";
import { productionWorkerProcessModule as worker, type WorkerMediaInspection } from "./worker-process";

const DUB_PATH = "/tmp/dub.mp3";
const words = [[
	{ text: "Hello", spaceBefore: false, startSec: 0.2, endSec: 0.6 },
	{ text: "there", spaceBefore: true, startSec: 0.6, endSec: 1 },
]];

const graphOf = (args: string[]) => args[args.indexOf("-filter_complex") + 1]!;
const inputsOf = (args: string[]) => args.flatMap((value, index) => (value === "-i" ? [args[index + 1]!] : []));

describe("ordinary renders are unchanged by the dub path", () => {
	test("every scenario names a recorded argument list", () => {
		expect(dubScenarios.map((scenario) => scenario.name).sort()).toEqual(Object.keys(goldenArgs).sort());
	});

	// The recorded lists were produced by the builders before the dub existed.
	test.each(dubScenarios.map((scenario) => [scenario.name, scenario] as const))("%s keeps its exact ffmpeg arguments", (name, scenario) => {
		const { name: _name, ...input } = scenario;
		expect(scenarioArgs(input)).toEqual((goldenArgs as Record<string, string[]>)[name]!);
	});
});

describe("a dub is the dialogue of every builder", () => {
	test.each(dubScenarios.map((scenario) => [scenario.name, scenario] as const))("%s", (_name, scenario) => {
		const { name: _unused, ...input } = scenario;
		const args = scenarioArgs(input, DUB_PATH);
		const graph = graphOf(args);
		const inputs = inputsOf(args);
		// One extra input, last, after music and sound effects.
		expect(inputs.at(-1)).toBe(DUB_PATH);
		expect(inputs.filter((path) => path === DUB_PATH)).toHaveLength(1);
		const dubIndex = inputs.length - 1;
		expect(graph).toContain(`[${dubIndex}:a]aresample=${DUB_OUTPUT_AUDIO.sampleRate},aformat=channel_layouts=stereo,apad,atrim=duration=`);
		// The original audio is never read, aligned or cut.
		expect(graph).not.toContain("[0:a");
		expect(graph).not.toContain("composition_source_audio_clock");
		expect(graph).not.toContain("[acat]");
		expect(graph).not.toContain("aseg");
		// Neither the source's gain nor its mute reaches the narration.
		expect(graph).not.toContain("volume=0.400");
		expect(graph).not.toContain("volume=0.000");
		expect(graph).not.toContain("aeval");
		// There is always an output track, even over a silent source.
		expect(args).toContain("[outa]");
		expect(args).not.toContain("-an");
		// No filter output is left unconnected: every label is produced and read once.
		const mapped = args.flatMap((value, index) => (args[index - 1] === "-map" ? [value] : []));
		const text = `${graph};${mapped.join(";")}`;
		for (const label of new Set(text.match(/\[[a-z_][a-z0-9_]*\]/g))) {
			expect(text.split(label).length - 1).toBe(2);
		}
	});

	test("the dub is cut to the clip, not to the MP3's padding", () => {
		const graph = graphOf(scenarioArgs({ builder: "single" }, DUB_PATH));
		expect(graph).toContain("atrim=duration=6.000,asetpts=PTS-STARTPTS[composition_dub_audio]");
	});

	test("with inserted scenes the dub is cut to the source timeline the scenes wrap", () => {
		const plan = planScenario({ builder: "single", scenes: true });
		expect(plan.editedDurationSec).toBeGreaterThan(6);
		const graph = graphOf(scenarioArgs({ builder: "single", scenes: true }, DUB_PATH));
		expect(graph).toContain("atrim=duration=6.000,asetpts=PTS-STARTPTS[composition_dub_audio]");
		expect(graph).toContain("[composition_dub_audio]asplit=2[composition_source_audio_0][composition_source_audio_1]");
		expect(graph).toContain("[composition_source_audio_0]atrim=start=0.000:end=1.000,asetpts=PTS-STARTPTS,apad,atrim=duration=1.000[composition_scene_audio_0]");
		expect(graph).toContain("concat=n=3:v=0:a=1[composition_scene_audio]");
	});

	test("music and the dub mix through the same mix, dialogue first", () => {
		const graph = graphOf(scenarioArgs({ builder: "single", music: true }, DUB_PATH));
		expect(graph).toContain("[composition_dub_audio]atrim=duration=6.000,asetpts=PTS-STARTPTS[maina]");
		expect(graph).toContain("amix=inputs=2:duration=first");
	});

	test("a dub plays over a source without any audio", () => {
		const args = scenarioArgs({ builder: "single", sourceHasAudio: false }, DUB_PATH);
		expect(graphOf(args)).toContain("[composition_dub_audio]afade=t=in");
		expect(args).toContain("[outa]");
		expect(args).not.toContain("-an");
	});

	test("the audiogram waveform reads the dub", () => {
		const graph = graphOf(scenarioArgs({ builder: "audiogram" }, DUB_PATH));
		expect(graph).toContain("[composition_dub_audio]asplit=2[wavesrc][fadesrc]");
		expect(graph).toContain("[wavesrc]showwaves=");
	});

	test("a dub of a clip with censor edits is refused", () => {
		const plan = planScenario({ builder: "single" });
		const schedule = compileCompositionPlanAudioSchedule(plan);
		const audio = bindCompositionPlanAudioInputs({ ...schedule, censors: [{ startSec: 1, endSec: 1.5, treatment: "mute" }] }, { dub: { path: DUB_PATH } });
		expect(() => compileClipCompositionCommand({
			sourcePath: "/tmp/source.mp4", outputPath: "/tmp/output.mp4", startSec: 0, endSec: 6, source: scenarioProbe({ builder: "single" }), plan, targetId: "variant-1",
			audio: { ...audio, scheduleFingerprint: schedule.scheduleFingerprint }, encoder: { preset: "veryfast", crf: "21" }, assets: { subtitlePath: null },
		})).toThrow("A dub cannot carry censor edits");
	});

	test("the caption words of the dub reach the plan in the dub's language", () => {
		const plan = planScenario({ builder: "single", captionOverride: { language: "ur", segments: words } });
		const captions = plan.targets[0]!.visualLayers.filter((layer) => layer.kind === "caption");
		expect(captions).toHaveLength(1);
		expect(captions[0]).toMatchObject({ language: "ur", activeRange: { startSec: 0.2 } });
		expect(plan.fingerprint).not.toBe(planScenario({ builder: "single" }).fingerprint);
	});
});

describe("output validation expects what the dub's filter produces", () => {
	const probe = (audios: unknown[]) => ({ ...scenarioProbe({ builder: "single" }), facts: { audios, videos: [] } }) as unknown as WorkerMediaInspection;
	const expectation = (scenario: Parameters<typeof planScenario>[0], dub: boolean, source: WorkerMediaInspection) => {
		const plan = planScenario(scenario);
		const audio = bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(plan), {
			...(scenario.music ? { music: { sourceRef: "music:bed", path: "/tmp/music.wav" } } : {}),
			...(dub ? { dub: { path: DUB_PATH } } : {}),
		});
		return compositionOutputExpectation({ plan, targetId: "variant-1", source, audio }).audio;
	};

	test("a plain dub is the delivery format, not the source's", () => {
		expect(expectation({ builder: "single" }, true, probe([{ sampleRate: 44_100, channels: 1 }]))).toEqual({ sampleRate: 48_000, channels: 2 });
	});

	test("a dub over a silent source still has an audio track", () => {
		expect(expectation({ builder: "single", sourceHasAudio: false }, true, scenarioProbe({ builder: "single", sourceHasAudio: false }))).toEqual({ sampleRate: 48_000, channels: 2 });
		expect(expectation({ builder: "single", sourceHasAudio: false }, false, scenarioProbe({ builder: "single", sourceHasAudio: false }))).toBeNull();
	});

	test("a dub mixed with music asserts presence only, like any mix", () => {
		expect(expectation({ builder: "single", music: true }, true, probe([{ sampleRate: 44_100, channels: 2 }]))).toEqual({});
	});

	test("without a dub the source's facts still decide", () => {
		expect(expectation({ builder: "single" }, false, probe([{ sampleRate: 44_100, channels: 1 }]))).toEqual({ sampleRate: 44_100, channels: 1 });
	});
});

describe("a dub renders through real ffmpeg", () => {
	const signal = new AbortController().signal;
	const execute = (args: string[]) => worker.execute({ command: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-y", ...args], signal, deadlineMs: 30_000, captureStdout: true });
	const cases = [
		{ name: "a silent source, muted and quiet source settings", sourceAudio: false, sourceMuted: true },
		{ name: "a talking source whose own gain is low", sourceAudio: true, sourceVolume: 25 },
		{ name: "music, a cut and an inserted scene", sourceAudio: true, music: true, cut: true, scenes: true },
		{ name: "an audio-only source as an audiogram", sourceAudio: true, audiogram: true },
		{ name: "B-roll", sourceAudio: true, broll: true, music: true },
	] as const;

	test.each(cases)("$name", async (scenario) => {
		await worker.withScratchDirectory("narriflow-dub-render-", async (directory) => {
			const sourcePath = join(directory, "source.mp4");
			const dubPath = join(directory, "dub.mp3");
			const musicPath = join(directory, "music.wav");
					const outputPath = join(directory, "output.mp4");
			const cut = "cut" in scenario && scenario.cut;
			const scenes = "scenes" in scenario && scenario.scenes;
			const music = "music" in scenario && scenario.music;
			const audiogram = "audiogram" in scenario && scenario.audiogram;
			const broll = "broll" in scenario && scenario.broll;
			const sourceLength = cut ? 4 : 3;
			// The dub holds exactly the edited timeline before scenes: 3 s.
			await execute(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=24000:duration=3", "-ac", "1", "-c:a", "libmp3lame", dubPath]);
			if (audiogram) await execute(["-f", "lavfi", "-i", `sine=frequency=880:sample_rate=48000:duration=${sourceLength}`, sourcePath.replace(".mp4", ".wav")]);
			else await execute(["-f", "lavfi", "-i", `color=blue:s=90x160:r=10:d=${sourceLength}`, ...(scenario.sourceAudio ? ["-f", "lavfi", "-i", `sine=frequency=880:sample_rate=48000:duration=${sourceLength}`] : []), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", sourcePath]);
			if (music) await execute(["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=5", musicPath]);
			const realSource = audiogram ? sourcePath.replace(".mp4", ".wav") : sourcePath;
			const inspection = await worker.inspectMedia({ sourcePath: realSource, signal, deadlineMs: 5000 });
			const deletedRanges = cut ? [{ startSec: 1, endSec: 2 }] : [];
			const result = planClipComposition({
				document: editorDocumentSchema.parse({
					version: 1, clipStartSec: 0, clipEndSec: sourceLength, captionPreset: captionPresetSchema.parse({ visible: false }), transcriptSlice: [], deletedRanges,
					studioEdits: studioEditsSchema.parse({
						framing: { mode: "center" },
						sourceAudio: { muted: "sourceMuted" in scenario && scenario.sourceMuted, volume: "sourceVolume" in scenario ? scenario.sourceVolume : 100 },
						...(music ? { music: { url: "https://example.com/music.wav", volume: 20, ducking: false, fadeInSec: 0, fadeOutSec: 0 } } : {}),
					}),
					brollUrl: null,
					sceneBlocks: scenes ? [{
						schemaVersion: 1, id: "8ab9d330-688f-4574-932c-27ac661245c1", anchorSec: 1, durationSec: 1,
						content: { kind: "color", color: "#ff0000" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null,
					}] : [],
				}),
				source: { identity: "source:dub", kind: audiogram ? "audio" : "video", width: inspection.width, height: inspection.height, hasAudio: inspection.hasAudio },
				evidence: { automaticLayout: { state: "missing" } },
				assets: {
					backgroundImage: { state: "missing" },
					...(music ? { music: { state: "available", ref: "music:bed", durationSec: 5 } } as const : {}),
					...(broll ? { broll: { state: "available", placements: [{ id: "cutaway", ref: "broll:clip", startSec: 0.2, endSec: 0.8 }] } } as const : {}),
				},
				capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
				targets: [{ id: "vertical", aspectRatio: "9:16", width: audiogram ? 1080 : 90, height: audiogram ? 1920 : 160 }],
				captionOverride: { language: "ur", segments: words },
			});
			if (result.status === "invalid") throw new Error(result.error.code);
			const bound = bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(result.plan), {
				...(music ? { music: { sourceRef: "music:bed", path: musicPath } } : {}),
				dub: { path: dubPath },
			});
			await execute(compileClipCompositionCommand({
				sourcePath: realSource, outputPath, startSec: 0, endSec: sourceLength, source: inspection, plan: result.plan, targetId: "vertical",
				...(cut ? { cutPlan: buildClipCutPlan(deletedRanges, { startSec: 0, endSec: sourceLength }) } : {}),
				audio: bound, encoder: { preset: "veryfast", crf: "24" },
				assets: { subtitlePath: null, ...(broll ? { broll: { "broll:clip": sourcePath } } : {}) },
			}));
			// The output is a valid render of the planned length, whatever MP3 padding the dub carries.
			const validated = await validateRenderOutput({
				path: outputPath, expected: compositionOutputExpectation({ plan: result.plan, targetId: "vertical", source: inspection, audio: bound }), workerProcess: worker, signal,
			});
			expect(validated.durationSec).toBeCloseTo(result.plan.editedDurationSec, 1);
			const decoded = await execute(["-i", outputPath, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
			const samples = new DataView(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength);
			const amplitude = (frequency: number, startSec: number, endSec: number) => {
				const start = Math.round(startSec * 48000);
				const end = Math.min(Math.round(endSec * 48000), samples.byteLength / 4);
				let real = 0;
				let imaginary = 0;
				for (let index = start; index < end; index++) {
					const value = samples.getFloat32(index * 4, true);
					const angle = 2 * Math.PI * frequency * index / 48000;
					real += value * Math.cos(angle);
					imaginary += value * Math.sin(angle);
				}
				return 2 * Math.hypot(real, imaginary) / (end - start);
			};
			// FFmpeg's sine source has amplitude 1/8; the narration plays at unity.
			const speech = (startSec: number, endSec: number) => expect(amplitude(330, startSec, endSec)).toBeCloseTo(0.125, 1);
			const silent = (startSec: number, endSec: number) => expect(amplitude(330, startSec, endSec)).toBeLessThan(0.01);
			expect(amplitude(880, 0.3, Math.min(2.5, result.plan.editedDurationSec - 0.3))).toBeLessThan(0.005);
			if (scenes) {
				// The narration wraps the inserted second: speech, a silent scene, speech.
				speech(0.2, 0.8);
				silent(1.2, 1.8);
				speech(2.2, 3.8);
				expect(result.plan.editedDurationSec).toBeCloseTo(4, 1);
			} else {
				speech(0.3, 2.7);
			}
			if (music) expect(amplitude(220, 0.3, 2.7)).toBeCloseTo(0.025, 1);
		});
	}, 60_000);
});
