import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { CAPTION_SCENE_PROGRAMS } from "@narriflow/caption-scene";
import { planClipComposition } from "@narriflow/composition-plan";
import { captionPresetSchema, editorDocumentSchema, getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";
import { renderCaptionTrack } from "./caption-ass";
import { compileCompositionPlanCaptions } from "./composition-ffmpeg-adapter";

/**
 * A Scene Style program that throws must not fail the render (fix 6): its cues burn as the classic line, a structured warning is
 * logged, and the track carries a notice. The writer samples frame times at the render's own frame rate, not always 30.
 */

const WORDS = ["the", "biggest", "mistake", "people", "make", "is", "waiting", "until", "they", "feel", "ready", "today"];

function planFor(scene: string | null, words = WORDS) {
  const spans = words.map((word, index) => ({ word, startSec: 0.2 + index * 0.4, endSec: 0.55 + index * 0.4, confidence: 1 }));
  const base = scene ? getCaptionPresetById(scene)!.preset : {};
  const document = editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 0.6 + words.length * 0.4,
    captionPreset: captionPresetSchema.parse({ ...base, wordsPerCue: 4 }),
    transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker", startSec: 0.2, endSec: spans.at(-1)!.endSec, text: words.join(" "), confidence: 1, words: spans }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null,
    deletedRanges: [],
  });
  const result = planClipComposition({
    document,
    source: { identity: "scene-failure", kind: "video", width: 1280, height: 720 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 540, height: 960 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

const dialogueLines = (ass: string) => ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
const startsOf = (ass: string) => new Set(dialogueLines(ass).map((line) => line.split(",")[1]!));

describe("a template exception does not fail the render", () => {
  const original = CAPTION_SCENE_PROGRAMS.reveal.program.build;
  afterAll(() => {
    (CAPTION_SCENE_PROGRAMS.reveal.program as { build: typeof original }).build = original;
  });

  test("the cues burn as the classic line, a structured warning is logged and the track says so", () => {
    const plan = planFor("reveal");
    const healthy = compileCompositionPlanCaptions(plan, "vertical");
    expect(healthy.notices.filter((notice) => notice.code === "caption_scene_failed")).toHaveLength(0);

    (CAPTION_SCENE_PROGRAMS.reveal.program as { build: typeof original }).build = () => {
      throw new Error("template exploded");
    };
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const track = compileCompositionPlanCaptions(plan, "vertical");
      // The classic line: one event per cue (or more), the text of the words, no scene drawing.
      const events = dialogueLines(track.ass);
      expect(events.length).toBeGreaterThan(0);
      const text = events.join("\n");
      for (const word of ["biggest", "waiting", "ready"]) expect(text.toLowerCase()).toContain(word);
      expect(text).not.toContain("\\p1");
      // The notice and the log.
      const failure = track.notices.find((notice) => notice.code === "caption_scene_failed");
      expect(failure).toMatchObject({ code: "caption_scene_failed", scene: "reveal", message: "template exploded" });
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(String(warn.mock.calls[0]![0]));
      expect(logged).toMatchObject({ level: "warn", message: "caption_scene_failed", scene: "reveal", error: "template exploded", fallback: "classic_line" });
    } finally {
      warn.mockRestore();
      (CAPTION_SCENE_PROGRAMS.reveal.program as { build: typeof original }).build = original;
    }
  });

  test("a throwing writer is caught the same way, and the other styles are not touched", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const plan = planFor("reveal");
      const target = plan.targets.find((candidate) => candidate.id === "vertical")!;
      const layers = target.visualLayers.filter((layer) => layer.kind === "caption");
      const broken = layers.map((layer) => (layer.kind === "caption" ? { ...layer, scene: { roles: undefined as never, keys: [], speaker: null } } : layer));
      const track = renderCaptionTrack({ layers: broken as never, canvas: target.canvas });
      expect(track.notices.some((notice) => notice.code === "caption_scene_failed")).toBe(true);
      expect(dialogueLines(track.ass).length).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the writer samples the render's frame rate", () => {
  test("a 25 fps render and a 30 fps render write different frame times", () => {
    const plan = planFor("reveal");
    const at30 = compileCompositionPlanCaptions(plan, "vertical");
    const at25 = compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 25);
    const explicit30 = compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 30);
    expect(startsOf(at25.ass)).not.toEqual(startsOf(at30.ass));
    expect(at30.ass).toBe(explicit30.ass);
    // Every event of the 25 fps track starts on the 25 fps grid (a frame is 40 ms; ASS time is centiseconds, so 40 ms steps).
    for (const start of startsOf(at25.ass)) {
      const [h, m, s] = start.split(":");
      const ms = Math.round((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000);
      expect(ms % 40).toBe(0);
    }
  });
});
