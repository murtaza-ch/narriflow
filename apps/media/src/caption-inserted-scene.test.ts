import { beforeAll, describe, expect, test } from "bun:test";
import type { CaptionEmojiArt } from "@narriflow/caption-emoji/art";
import { CAPTION_EMOJI_Z } from "@narriflow/caption-scene";
import { type ClipCompositionPlan, type CompositionCaptionVisualLayer, insertedSceneRanges, planClipComposition } from "@narriflow/composition-plan";
import { captionPresetSchema, editorDocumentSchema, getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";
import { renderCaptionTrack } from "./caption-ass";
import { loadPlanCaptionEmojiArt } from "./caption-emoji-ass";
import { compileCompositionPlanCaptions } from "./composition-ffmpeg-adapter";

/**
 * A Scene Block inserted inside a cue: the plan splits the cue into two cues of their own, so every caption path burns
 * the words on both sides of the scene and the emoji on the side its word is on (classic, Dynamic and Scene Styles).
 * Nothing burns during the scene: the clip's speech stops there, and a Scene Style's pieces are cut at it.
 */

const CANVAS = { width: 540, height: 960 };
const WORDS = ["the", "biggest", "mistake", "people", "make", "is", "waiting", "until", "they", "feel", "ready", "today"];
/** The scene starts at 1.7 s (inside "people", 1.4-1.75 s) and lasts 2 s. */
const SCENE = { startSec: 1.7, endSec: 3.7 };
/** The same scene between the first two cues ("people" ends at 1.75 s, "make" starts at 1.8 s). */
const BETWEEN = { startSec: 1.8, endSec: 3.8 };

function planFor(presetId: string, scene: { startSec: number; endSec: number } | null = SCENE): ClipCompositionPlan {
  const spans = WORDS.map((word, index) => ({ word, startSec: 0.2 + index * 0.4, endSec: 0.55 + index * 0.4, confidence: 1 }));
  const document = editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 5.4,
    captionPreset: captionPresetSchema.parse({ ...getCaptionPresetById(presetId)!.preset, wordsPerCue: 4, emojis: true }),
    transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker", startSec: 0.2, endSec: 4.95, text: WORDS.join(" "), confidence: 1, words: spans }],
    // 1000 ms is "mistake": the flame shows before the scene.
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, captionEmojis: { "1000": { id: "flame" } } }),
    brollUrl: null,
    deletedRanges: [],
    sceneBlocks: scene ? [{ schemaVersion: 1, id: "38784fe0-1640-4079-ad09-7f88ab9da721", anchorSec: scene.startSec, durationSec: scene.endSec - scene.startSec,
      content: { kind: "color", color: "#000000" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null }] : [],
  });
  const result = planClipComposition({
    document,
    source: { identity: "caption-inserted-scene", kind: "video", width: 1280, height: 720 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: CANVAS.width, height: CANVAS.height }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

const seconds = (time: string) => {
  const [hours, minutes, rest] = time.split(":");
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(rest);
};

function dialogues(ass: string) {
  return ass.split("\n").filter((line) => line.startsWith("Dialogue:")).map((line) => {
    const fields = line.slice("Dialogue: ".length).split(",");
    return { layer: Number(fields[0]), start: seconds(fields[1]!), end: seconds(fields[2]!) };
  });
}

let art: Map<string, CaptionEmojiArt>;
beforeAll(async () => {
  art = await loadPlanCaptionEmojiArt(planFor("electric"));
});

const PRESETS = [["classic", "electric"], ["Dynamic", "headline"], ["Scene", "reveal"], ["Scene", "lyrics"], ["Scene", "horizon"], ["Scene", "dialogue"]] as const;

describe("captions around an inserted scene", () => {
  for (const [where, scene] of [["inside a cue", SCENE], ["between cues", BETWEEN]] as const) {
    for (const [kind, presetId] of PRESETS) {
      test(`${kind} (${presetId}), a scene ${where}: captions on both sides, none during it, the emoji on its word's side`, () => {
        const track = compileCompositionPlanCaptions(planFor(presetId, scene), "vertical", undefined, undefined, 30, art);
        expect(track.notices).toEqual([]);
        const events = dialogues(track.ass);
        const captions = events.filter((event) => event.layer < CAPTION_EMOJI_Z * 10);
        expect(captions.some((event) => event.start < scene.startSec)).toBe(true);
        expect(captions.some((event) => event.start >= scene.endSec)).toBe(true);
        // ASS times are centiseconds: 10 ms of slack at each edge.
        const during = (event: { start: number; end: number }) => event.end > scene.startSec + 0.01 && event.start < scene.endSec - 0.01;
        expect(captions.filter(during)).toEqual([]);
        expect(track.emojis).toEqual({ placed: 1, dropped: {} });
        const emoji = events.filter((event) => event.layer >= CAPTION_EMOJI_Z * 10);
        expect(emoji.length).toBeGreaterThan(0);
        expect(Math.min(...emoji.map((event) => event.start))).toBeCloseTo(1, 2);
        expect(emoji.filter(during)).toEqual([]);
        expect(emoji.every((event) => event.start < scene.startSec)).toBe(true);
      });
    }
  }

  test("the worker cuts at the plan target's inserted scenes, the ranges the Studio passes the same scene input", () => {
    expect(insertedSceneRanges(planFor("reveal").targets[0]!)).toEqual([{ startSec: SCENE.startSec, endSec: SCENE.endSec }]);
    expect(insertedSceneRanges(planFor("reveal", null).targets[0]!)).toEqual([]);
  });

  test("a clip without inserted scenes burns the script it burned before, byte for byte", () => {
    for (const [, presetId] of PRESETS) {
      const plan = planFor(presetId, null);
      const target = plan.targets[0]!;
      // The caption build as it was called before inserted scenes reached it: no ranges at all.
      const before = renderCaptionTrack({
        layers: target.visualLayers.filter((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption"),
        canvas: target.canvas,
        fps: 30,
        emojiArt: art,
      });
      expect(compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 30, art).ass).toBe(before.ass);
    }
  });
});
