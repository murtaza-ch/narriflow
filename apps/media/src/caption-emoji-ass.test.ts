import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { CaptionEmojiArt } from "@narriflow/caption-emoji/art";
import * as captionScene from "@narriflow/caption-scene";
import {
  CAPTION_EMOJI_LATE_HOLD_MS,
  CAPTION_EMOJI_MIN_SHOWN_MS,
  CAPTION_EMOJI_PIECE_CAP,
  CAPTION_EMOJI_Z,
  CAPTION_SCENE_PROGRAMS,
  type CaptionEmojiCueBox,
  type CaptionEmojiLayerInput,
  captionEmojiLayerEmojis,
  captionEmojiLayerStyle,
  classicLineReachBox,
  placeCaptionEmojis,
} from "@narriflow/caption-scene";
import { type ClipCompositionPlan, type CompositionCaptionVisualLayer, planClipComposition } from "@narriflow/composition-plan";
import { captionFontFace, captionPresetSchema, editorDocumentSchema, getCaptionPresetById, studioEditsSchema } from "@narriflow/validators";
import { CAPTION_FACE_OWN_SCRIPTS } from "../../web/app/caption-script-fonts";
import { type ClassicLineFace, classicLineBoxEm } from "../../web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/cue-emoji-boxes";
import { type OneCueEmojiInput, emojiFollowingCue, heldEmojiCues, rememberHeldCue } from "../../web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/held-cue-boxes";
import { captionEmojiEvents, loadPlanCaptionEmojiArt } from "./caption-emoji-ass";
import { compileCompositionPlanCaptions } from "./composition-ffmpeg-adapter";

/**
 * The export's emoji layer (spec D3): every caption path hands the shared builder its cue boxes and the Scene writer draws the
 * pieces, above every caption event of the target, with all parts of one emoji on one drawing box so libass pops them together.
 */

const CANVAS = { width: 540, height: 960 };
const ENGLISH = ["the", "biggest", "mistake", "people", "make", "is", "waiting", "until", "they", "feel", "ready", "today"];
const URDU = ["یہ", "بہت", "اچھا", "ہے", "میں", "نے", "آج", "سیکھا"];
/** Short words: lines that fit at the preset's size, as most real cues of three to five words do. */
const SHORT = ["take", "big", "bets", "now", "make", "them", "work", "fast", "keep", "your", "team", "sharp"];
/** Word Key of word `index`: its source start in ms (the plan resolves the nearest kept word). */
const keyOf = (index: number) => String(Math.round((0.2 + index * 0.4) * 1000));

function planFor(
  presetId: string,
  emojis: Record<string, { id: string; tone?: number }>,
  options: { words?: readonly string[]; language?: string; pitchSec?: number; wordSec?: number } = {},
): ClipCompositionPlan {
  const words = options.words ?? ENGLISH;
  const pitch = options.pitchSec ?? 0.4;
  const spans = words.map((word, index) => ({ word, startSec: 0.2 + index * pitch, endSec: 0.2 + index * pitch + (options.wordSec ?? 0.35), confidence: 1 }));
  const document = editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 0.6 + words.length * 0.4,
    captionPreset: captionPresetSchema.parse({ ...getCaptionPresetById(presetId)!.preset, wordsPerCue: 4, emojis: true }),
    transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker", startSec: 0.2, endSec: spans.at(-1)!.endSec, text: words.join(" "), confidence: 1, words: spans }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, captionEmojis: emojis }),
    brollUrl: null,
    deletedRanges: [],
  });
  const result = planClipComposition({
    document,
    source: { identity: "caption-emoji", kind: "video", width: 1280, height: 720 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: CANVAS.width, height: CANVAS.height }],
    ...(options.language ? { captionLanguage: options.language } : {}),
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

interface Dialogue {
  readonly layer: number;
  readonly start: string;
  readonly end: string;
  readonly text: string;
}

function dialogues(ass: string): Dialogue[] {
  return ass.split("\n").filter((line) => line.startsWith("Dialogue:")).map((line) => {
    const fields = line.slice("Dialogue: ".length).split(",");
    return { layer: Number(fields[0]), start: fields[1]!, end: fields[2]!, text: fields.slice(8).join(",") };
  });
}

/** Emoji pieces sit at `CAPTION_EMOJI_Z`; the writer puts a piece's events on `z * 10 + sub`. */
const isEmojiEvent = (event: Dialogue) => event.layer >= CAPTION_EMOJI_Z * 10;
/** The position and transform tags of an event, without its colour and drawing. */
const poseOf = (text: string) => ({
  position: /\\(?:pos|move)\([^)]*\)/.exec(text)?.[0] ?? null,
  org: /\\org\([^)]*\)/.exec(text)?.[0] ?? null,
  scale: (text.match(/\\fsc[xy][^\\}]*|\\t\(\d+,\d+,\\fsc[xy][^)]*\)/g) ?? []).join(""),
  turn: /\\frz-?[\d.]+/.exec(text)?.[0] ?? null,
});

let art: Map<string, CaptionEmojiArt>;
beforeAll(async () => {
  art = await loadPlanCaptionEmojiArt(planFor("electric", { [keyOf(1)]: { id: "flame" }, [keyOf(5)]: { id: "astronaut" }, [keyOf(6)]: { id: "rocket" }, [keyOf(9)]: { id: "flexed-biceps", tone: 4 }, [keyOf(2)]: { id: "heart-eyes" } }));
});

describe("one emoji on each caption path", () => {
  for (const [kind, presetId] of [["classic", "electric"], ["Dynamic", "headline"], ["Scene", "reveal"]] as const) {
    test(`${kind} (${presetId}): drawn above every caption event, all parts on one pose through the pop`, () => {
      const plan = planFor(presetId, { [keyOf(1)]: { id: "flame" } });
      const track = compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 30, art);
      expect(track.emojis).toEqual({ placed: 1, dropped: {} });
      const events = dialogues(track.ass);
      const emoji = events.filter(isEmojiEvent);
      const captions = events.filter((event) => !isEmojiEvent(event));
      expect(captions.length).toBeGreaterThan(0);
      // The flame's pieces: the outline's shadow, the white outline, then its layers; one event each.
      const pieces = placeCaptionEmojis({
        cueBoxes: [{ cueIndex: 0, box: { x1: 100, y1: 600, x2: 440, y2: 660 }, fromMs: 0, toMs: 2000, bodyPx: 60, tiltDeg: 0, direction: "ltr" }],
        emojis: [{ cueIndex: 0, id: "flame", atMs: 500 }],
        art,
        style: captionEmojiLayerStyle(plan.targets[0]!.visualLayers.find((layer) => layer.kind === "caption")!.preset),
        canvas: CANVAS,
        anchorYPct: 70,
      })[0]!;
      expect(pieces.placed).toBe(true);
      expect(emoji).toHaveLength(pieces.placed ? pieces.pieces.length : 0);
      expect(Math.min(...emoji.map((event) => event.layer))).toBeGreaterThan(Math.max(...captions.map((event) => event.layer)));
      // Drawings on the Shape style; every part starts at the same time and shares \pos, \org, the scale chain and the turn.
      expect(emoji.every((event) => event.text.includes("\\p1"))).toBe(true);
      expect(new Set(emoji.map((event) => `${event.start}-${event.end}`)).size).toBe(1);
      const poses = new Set(emoji.map((event) => JSON.stringify(poseOf(event.text))));
      expect(poses.size).toBe(1);
      const pose = poseOf(emoji[0]!.text);
      expect(pose.scale).toContain("\\t(");
      expect(pose.turn).not.toBeNull();
    });
  }
});

describe("events per emoji", () => {
  // Measured with the real writer: one event per piece (the shared drawing box keeps libass from cutting a part per frame of
  // the pop): rocket 6, heart-eyes 7, party 8, astronaut 20 at 24, 30 and 60 fps. The most layered designs (19 layers, plus
  // the outline and its shadow) draw 21; a design may not exceed `CAPTION_EMOJI_PIECE_CAP`.
  const CAP = 21;
  for (const fps of [24, 30, 60]) {
    test(`at ${fps} fps an emoji writes one event per piece, at most ${CAP}`, () => {
      const layers = planFor("electric", Object.fromEntries(["flame", "astronaut", "rocket", "heart-eyes"].map((id, at) => [keyOf(at * 4 + 1), { id }]))).targets[0]!.visualLayers.flatMap((layer) => (layer.kind === "caption" ? [layer] : []));
      for (const layer of layers) {
        const box = { cueIndex: layer.cueIndex, box: { x1: 100, y1: 600, x2: 440, y2: 660 }, fromMs: layer.activeRange.startSec * 1000, toMs: layer.activeRange.endSec * 1000, bodyPx: 60, tiltDeg: 0, direction: "ltr" as const };
        const alone = [{ ...layer }];
        const { events, summary } = captionEmojiEvents({ groups: [{ layers: alone, cueBoxes: () => [box] }], layers: alone, art, canvas: CANVAS, fps });
        if (layer.emojis.length === 0) {
          expect(events).toHaveLength(0);
          continue;
        }
        expect(summary.placed).toBe(1);
        const pieces = placeCaptionEmojis({ cueBoxes: [box], emojis: layer.emojis.map((emoji) => ({ cueIndex: layer.cueIndex, id: emoji.id, atMs: emoji.atSec * 1000 })), art, style: captionEmojiLayerStyle(layer.preset), canvas: CANVAS, anchorYPct: layer.anchor.yPct });
        const count = pieces.flatMap((outcome) => (outcome.placed ? outcome.pieces : [])).length;
        expect(events).toHaveLength(count);
        expect(events.length).toBeLessThanOrEqual(CAP);
        expect(CAP).toBeLessThanOrEqual(CAPTION_EMOJI_PIECE_CAP);
      }
    });
  }
});

test("an RTL cue mirrors the sticker's tilt", () => {
  const turnOf = (plan: ClipCompositionPlan) => {
    const track = compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 30, art);
    expect(track.emojis.placed).toBe(1);
    const turns = new Set(dialogues(track.ass).filter(isEmojiEvent).map((event) => poseOf(event.text).turn));
    expect(turns.size).toBe(1);
    return Number([...turns][0]!.slice("\\frz".length));
  };
  const ltr = turnOf(planFor("electric", { [keyOf(1)]: { id: "flame" } }));
  const rtl = turnOf(planFor("electric", { [keyOf(1)]: { id: "flame" } }, { words: URDU, language: "ur" }));
  expect(Math.abs(ltr)).toBeGreaterThan(1);
  expect(rtl).toBeCloseTo(-ltr, 5);
});

test("an emoji whose art is not loaded is left out and counted; the captions still burn", () => {
  const plan = planFor("electric", { [keyOf(1)]: { id: "flame" }, [keyOf(5)]: { id: "rocket" } });
  const track = compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 30, new Map([["rocket", art.get("rocket")!]]));
  expect(track.emojis).toEqual({ placed: 1, dropped: { "no-art": 1 } });
  const events = dialogues(track.ass);
  expect(events.some((event) => !isEmojiEvent(event))).toBe(true);
  expect(events.filter(isEmojiEvent).length).toBeGreaterThan(0);
  // Without any art (nothing preloaded), no emoji is drawn and nothing throws.
  expect(compileCompositionPlanCaptions(plan, "vertical").emojis).toEqual({ placed: 0, dropped: { "no-art": 2 } });
});

test("no emoji on the plan writes exactly the captions", () => {
  const plain = planFor("reveal", {});
  const track = compileCompositionPlanCaptions(plain, "vertical", undefined, undefined, 30, art);
  expect(track.emojis).toEqual({ placed: 0, dropped: {} });
  expect(dialogues(track.ass).some(isEmojiEvent)).toBe(false);
});

describe("a Scene Style that throws", () => {
  const original = CAPTION_SCENE_PROGRAMS.reveal.program.build;
  afterAll(() => {
    (CAPTION_SCENE_PROGRAMS.reveal.program as { build: typeof original }).build = original;
  });

  test("places its emojis on the classic line it falls back to", () => {
    const plan = planFor("reveal", { [keyOf(1)]: { id: "flame" } });
    const healthy = compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 30, art);
    (CAPTION_SCENE_PROGRAMS.reveal.program as { build: typeof original }).build = () => {
      throw new Error("template exploded");
    };
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const track = compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 30, art);
      expect(track.notices.some((notice) => notice.code === "caption_scene_failed")).toBe(true);
      expect(track.emojis).toEqual({ placed: 1, dropped: {} });
      const emoji = dialogues(track.ass).filter(isEmojiEvent);
      expect(emoji.length).toBeGreaterThan(0);
      // The classic line's box, not the scene's: the emoji lands elsewhere than over the healthy scene.
      expect(poseOf(emoji[0]!.text).position).not.toBe(poseOf(dialogues(healthy.ass).filter(isEmojiEvent)[0]!.text).position);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("an emoji layer that throws", () => {
  // An emoji problem never changes the captions or fails the render: the layer logs once and draws nothing.
  const cases = [
    ["the Scene cue boxes", "reveal", "captionSceneEmojiCueBoxes"],
    ["a classic cue box", "electric", "classicLineCueBox"],
    ["a Dynamic cue box", "headline", "captionBlockCueBox"],
    ["placement", "reveal", "placeCaptionEmojis"],
    ["placement", "electric", "placeCaptionEmojis"],
  ] as const;
  for (const [what, presetId, name] of cases) {
    test(`${what} (${presetId}): the captions are unchanged and no emoji is drawn`, () => {
      const plan = planFor(presetId, { [keyOf(1)]: { id: "flame" }, [keyOf(5)]: { id: "rocket" } });
      const healthy = compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 30, art);
      expect(dialogues(healthy.ass).some(isEmojiEvent)).toBe(true);
      const broken = spyOn(captionScene, name).mockImplementation(() => {
        throw new Error("emoji exploded");
      });
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const track = compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 30, art);
        expect(broken).toHaveBeenCalled();
        expect(track.notices).toEqual(healthy.notices);
        expect(dialogues(track.ass)).toEqual(dialogues(healthy.ass).filter((event) => !isEmojiEvent(event)));
        expect(track.emojis).toEqual({ placed: 0, dropped: {} });
        const logged = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as { message: string; error?: string });
        expect(logged).toEqual([{ level: "warn", message: "caption_emoji_layer_failed", error: "emoji exploded" }]);
      } finally {
        broken.mockRestore();
        warn.mockRestore();
      }
    });
  }
});

describe("the export places as the Studio does", () => {
  const rocketLayer = () => {
    const layer = planFor("electric", { [keyOf(1)]: { id: "rocket" } }).targets[0]!.visualLayers.find((each) => each.kind === "caption" && each.emojis.length > 0);
    if (layer?.kind !== "caption") throw new Error("no caption layer");
    return layer;
  };
  const boxOf = (layer: ReturnType<typeof rocketLayer>) => ({ cueIndex: layer.cueIndex, box: { x1: 100, y1: 600, x2: 440, y2: 660 }, fromMs: layer.activeRange.startSec * 1000, toMs: layer.activeRange.endSec * 1000, bodyPx: 60, tiltDeg: 0, direction: "ltr" as const });

  test("on the render's frame grid, the Studio's at the same rate: an obstacle seen only on 60 fps frames moves the emoji at 60 fps alone", () => {
    const layer = rocketLayer();
    const anchorMs = layer.emojis[0]!.atSec * 1000;
    // Something crosses the slot above for 8 ms, mid-window, on a 60 fps frame and between two frames of every other rate.
    const others = [24, 25, 30, 50].flatMap((fps) => Array.from({ length: 200 }, (_, frame) => Math.round((frame * 1000) / fps)));
    const flash = Array.from({ length: 200 }, (_, frame) => Math.round((frame * 1000) / 60)).find((t) => t - anchorMs >= 400 && others.every((other) => Math.abs(other - t) > 4))!;
    const above = { x1: 0, y1: 0, x2: CANVAS.width, y2: 595 };
    const cue = { ...boxOf(layer), obstacles: (t: number) => [boxOf(layer).box, ...(t >= flash - 4 && t < flash + 4 ? [above] : [])] };
    const y = (events: readonly { text: string }[]) => Number(/\\pos\([\d.]+,([\d.]+)\)/.exec(events[0]!.text)![1]);
    for (const fps of [24, 25, 30, 50, 60]) {
      const { events, summary } = captionEmojiEvents({ groups: [{ layers: [layer], cueBoxes: () => [cue] }], layers: [layer], art, canvas: CANVAS, fps });
      expect(summary.placed).toBe(1);
      if (fps === 60) expect(y(events)).toBeGreaterThan(600);
      else expect(y(events)).toBeLessThan(600);
      // The Studio places with the shared builder at the clip's rate: the same pivot as the export's.
      const [studio] = placeCaptionEmojis({ cueBoxes: [cue], emojis: captionScene.captionEmojiLayerEmojis([layer]), art, style: captionEmojiLayerStyle(layer.preset), canvas: CANVAS, anchorYPct: layer.anchor.yPct, fps });
      expect(studio?.placed && studio.pieces[0]!.track.y![0]![1]).toBeCloseTo(y(events), 1);
    }
  });

  test("each classic or Dynamic cue is placed alone, as the Studio draws it; a Scene Style's cues together", () => {
    const layer = rocketLayer();
    const left = { ...boxOf(layer), cueIndex: 0 };
    // Two live cue boxes in one place (a second line over the first): placed together, the second emoji would move off the first.
    const right = { ...left, cueIndex: 1 };
    const layers = [{ ...layer, cueIndex: 0, emojis: [{ ...layer.emojis[0]!, order: 0 }] }, { ...layer, cueIndex: 1, emojis: [{ ...layer.emojis[0]!, id: "flame", order: 1 }] }];
    const pose = (events: readonly { text: string }[]) => [...new Set(events.map((event) => poseOf(event.text).position))];
    const apart = captionEmojiEvents({ groups: [{ layers: [layers[0]!], cueBoxes: () => [left] }, { layers: [layers[1]!], cueBoxes: () => [right] }], layers, art, canvas: CANVAS });
    const firstAlone = captionEmojiEvents({ groups: [{ layers: [layers[0]!], cueBoxes: () => [left] }], layers, art, canvas: CANVAS });
    const secondAlone = captionEmojiEvents({ groups: [{ layers: [layers[1]!], cueBoxes: () => [right] }], layers, art, canvas: CANVAS });
    expect(apart.summary.placed).toBe(2);
    expect(pose(apart.events)).toEqual([...new Set([...pose(firstAlone.events), ...pose(secondAlone.events)])]);
    const together = captionEmojiEvents({ groups: [{ layers, cueBoxes: () => [left, right] }], layers, art, canvas: CANVAS });
    expect(pose(together.events)).toHaveLength(2);
    // The plan ends a classic cue where the next one starts, so two speakers' lines never share time on screen.
    const plan = planFor("electric", { [keyOf(1)]: { id: "rocket" }, [keyOf(5)]: { id: "flame" } });
    const cues = plan.targets[0]!.visualLayers.flatMap((each) => (each.kind === "caption" ? [each] : []));
    for (const [at, cue] of cues.slice(1).entries()) expect(cue.activeRange.startSec).toBeGreaterThanOrEqual(cues[at]!.activeRange.endSec);
  });
});

describe("a late word's emoji holds past its cue and leaves, the same on both feeders", () => {
  // Words 250 ms apart, each 150 ms long: the fourth word ends the first cue, under 340 ms before its last paint; the fifth
  // opens the next cue. To yield, words 360 ms apart: the next cue's emoji starts inside the hold, late enough to leave the
  // held emoji its least window (`CAPTION_EMOJI_MIN_SHOWN_MS`).
  const pitchOf = (yields: boolean) => (yields ? 0.36 : 0.25);
  const clock = (time: string) => {
    const [h, m, s] = time.split(":").map(Number);
    return Math.round(((h! * 60 + m!) * 60 + s!) * 1000);
  };
  const face = (presetId: string): ClassicLineFace => {
    const { preset } = getCaptionPresetById(presetId)!;
    const own = CAPTION_FACE_OWN_SCRIPTS[preset.fontName];
    return { ascent: captionFontFace(preset.fontName).ascent, descent: captionFontFace(preset.fontName).descent, ...(own ? { ownScripts: own } : {}) };
  };
  for (const [kind, presetId] of [["classic", "electric"], ["Dynamic", "headline"], ["Scene", "reveal"]] as const) {
    for (const yields of [false, true]) {
      test(`${kind} (${presetId})${yields ? ", yielding to the next cue's emoji" : ""}`, () => {
        const pitch = pitchOf(yields);
        const atMs = Math.round((0.2 + 3 * pitch) * 1000);
        const nextAtMs = Math.round((0.2 + 4 * pitch) * 1000);
        const plan = planFor(presetId, { [String(atMs)]: { id: "rocket" }, ...(yields ? { [String(nextAtMs)]: { id: "flame" } } : {}) }, { words: SHORT, pitchSec: pitch, wordSec: 0.15 });
        const layers = plan.targets[0]!.visualLayers.flatMap((layer): CompositionCaptionVisualLayer[] => (layer.kind === "caption" ? [layer] : []));
        const owner = layers.find((layer) => layer.emojis.some((emoji) => emoji.id === "rocket"))!;
        const spy = spyOn(captionScene, "placeCaptionEmojis");
        let worker: CaptionEmojiLayerInput;
        let track: ReturnType<typeof compileCompositionPlanCaptions>;
        try {
          track = compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 30, art);
          worker = spy.mock.calls.map((call) => call[0]).find((call) => call.emojis.some((emoji) => emoji.id === "rocket"))!;
        } finally {
          spy.mockRestore();
        }
        expect(track.emojis).toEqual({ placed: yields ? 2 : 1, dropped: {} });
        const cue = worker.cueBoxes.find((box) => box.cueIndex === owner.cueIndex)!;
        expect(cue.toMs - atMs).toBeLessThan(CAPTION_EMOJI_MIN_SHOWN_MS);
        const endMs = yields ? nextAtMs : atMs + CAPTION_EMOJI_LATE_HOLD_MS;
        // The export: one event per piece (the exit is a `\t` chain, not one event per frame), from the word, past the
        // cue's last paint, to the late hold or the next cue's emoji (the writer snaps to the render's frames).
        const placed = placeCaptionEmojis(worker).find((outcome) => outcome.emoji.id === "rocket")!;
        const pieces = placed.placed ? placed.pieces : [];
        expect(pieces.map((piece) => [piece.fromMs, piece.toMs])).toEqual(pieces.map(() => [atMs, endMs]));
        const events = dialogues(track.ass).filter(isEmojiEvent).filter((event) => Math.abs(clock(event.start) - atMs) < 1000 / 30);
        expect(events).toHaveLength(pieces.length);
        for (const event of events) {
          expect(Math.abs(clock(event.end) - endMs)).toBeLessThan(1000 / 30);
          // The exit: the fill's alpha and the scale each change in `\t` spans; the scale ends near 0.85 (the writer
          // samples the last frame drawn, a frame before the window ends).
          expect(event.text).toMatch(/\\t\(\d+,\d+,\\1a&H[0-9A-F]{2}&\)/);
          const scales = [...event.text.matchAll(/\\t\(\d+,\d+,\\fscx([\d.]+)\)/g)].map((match) => Number(match[1]));
          if (!yields) expect(scales.at(-1)!).toBeLessThan(90);
          expect(Math.min(...scales.slice(-2))).toBeGreaterThanOrEqual(84.9);
        }
        // The Studio's feeder: a Scene Style's cues as one scene; else the one cue it mounts, from its box (the boxes' own
        // parity is ticket 12's and 19's) and the next cue's as `emojiFollowingCue` finds it, with the next emoji's time.
        const following = emojiFollowingCue(layers, owner);
        const nextBox = owner.scene
          ? null
          : owner.block
            ? worker.cueBoxes[1]!
            : classicLineReachBox(following.layer!, classicLineBoxEm(following.layer!.words, face(presetId), following.layer!.language), CANVAS);
        if (!owner.scene) {
          expect(worker.cueBoxes).toHaveLength(2);
          expect(nextBox!.cueIndex).toBe(owner.cueIndex + 1);
          for (const key of ["x1", "y1", "x2", "y2"] as const) expect(nextBox!.box[key]).toBeCloseTo(worker.cueBoxes[1]!.box[key], 0);
          expect(following.emojiAtMs).toBe(worker.nextEmojiAtMs);
        }
        const studioInput: OneCueEmojiInput = { boxes: [cue, ...(nextBox ? [nextBox] : [])], nextEmojiAtMs: following.emojiAtMs };
        const studioLayers = owner.scene ? layers.filter((layer) => layer.scene !== undefined) : [owner];
        const studio = (boxes: readonly CaptionEmojiCueBox[]) =>
          placeCaptionEmojis({
            cueBoxes: owner.scene ? worker.cueBoxes : boxes,
            emojis: captionEmojiLayerEmojis(studioLayers),
            art,
            style: captionEmojiLayerStyle(owner.preset),
            canvas: { width: owner.destination.width, height: owner.destination.height },
            anchorYPct: owner.anchor.yPct,
            fps: 30,
            ...(owner.scene || studioInput.nextEmojiAtMs === undefined ? {} : { nextEmojiAtMs: studioInput.nextEmojiAtMs }),
          });
        expect(studio(owner.scene ? worker.cueBoxes : [cue, worker.cueBoxes[1]!]).find((outcome) => outcome.emoji.id === "rocket")).toEqual(placed);
        // The Studio mounts a classic or Dynamic cue only while it is on screen; from its end the held layer draws its emojis
        // from the input the cue was placed from, so it stays where it was, on every export frame the export still shows it.
        rememberHeldCue(owner, studioInput);
        const ownerEnd = owner.activeRange.endSec * 1000;
        for (let t = atMs; t < endMs; t += 1000 / 30) {
          const held = heldEmojiCues(layers, t / 1000);
          if (owner.scene || t < ownerEnd) expect(held).toEqual([]);
          else expect(held).toEqual([{ layer: owner, input: studioInput }]);
        }
        if (!owner.scene) expect(ownerEnd).toBeLessThan(endMs);
      });
    }
  }
});

describe("a held emoji never covers the next cue's words", () => {
  // Fast speech so the last word's emoji holds: English, Urdu, and an English cue before Urdu ones (the real clip whose next
  // line box is several times taller). Every frame from the cue's end to the emoji's last is checked against the next cue's
  // own drawn words: a classic line's or block's exact box (placed as its own cue), a Scene Style's text pieces that read.
  const pitch = 0.25;
  const SCRIPTS = {
    LTR: { words: SHORT, language: "en" },
    RTL: { words: [...URDU, ...URDU], language: "ur" },
    "LTR then RTL": { words: [...SHORT.slice(0, 4), ...URDU], language: "ur" },
  } as const;
  const meets = (a: captionScene.Box, b: captionScene.Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
  let held = 0;
  let coveredWithoutNextBox = 0;
  for (const presetId of ["electric", "headline", "reveal", "tunnel", "horizon"]) {
    for (const [script, { words, language }] of Object.entries(SCRIPTS)) {
      test(`${presetId}, ${script}`, () => {
        // The rocket on the first cue's last word; a flame on the next cue's second word gives that cue's exact box (classic,
        // Dynamic) and starts after the hold.
        const options = { words, language, pitchSec: pitch, wordSec: 0.15 };
        const cues = planFor(presetId, {}, options).targets[0]!.visualLayers.flatMap((layer) => (layer.kind === "caption" ? [layer] : []));
        const keyAt = (sec: number) => String(Math.round(sec * 1000));
        const emojis = { [keyAt(cues[0]!.words.at(-1)!.startSec)]: { id: "rocket" }, [keyAt(cues[1]!.words[1]!.startSec)]: { id: "flame" } };
        const plan = planFor(presetId, emojis, options);
        const placeSpy = spyOn(captionScene, "placeCaptionEmojis");
        const sceneSpy = spyOn(captionScene, "captionSceneEmojiCueBoxes");
        let inputs: CaptionEmojiLayerInput[];
        let scene: { pieces: readonly captionScene.Piece[] } | null = null;
        let measure: captionScene.Measure | null = null;
        try {
          compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 30, art);
          inputs = placeSpy.mock.calls.map((call) => call[0]);
          if (sceneSpy.mock.calls[0]) [scene, , measure] = sceneSpy.mock.calls[0] as unknown as [typeof scene, unknown, captionScene.Measure];
        } finally {
          placeSpy.mockRestore();
          sceneSpy.mockRestore();
        }
        const input = inputs.find((each) => each.emojis.some((emoji) => emoji.id === "rocket"))!;
        const outcome = placeCaptionEmojis(input).find((each) => each.emoji.id === "rocket")!;
        const own = input.cueBoxes.find((box) => box.cueIndex === outcome.emoji.cueIndex)!;
        const nextIndex = own.cueIndex + 1;
        // The next cue's exact box: its own emoji's group places it as the cue's own.
        const exact = inputs.find((each) => each.cueBoxes[0]?.cueIndex === nextIndex)?.cueBoxes[0];
        const nextWords = (t: number): captionScene.Box[] => {
          if (scene && measure) {
            return scene.pieces.flatMap((piece) => {
              if (piece.kind !== "text" || piece.id.split(":")[1] !== String(nextIndex) || t < piece.fromMs || t >= piece.toMs) return [];
              if (piece.track.o && captionScene.kf(t, piece.track.o) < 0.1) return [];
              const box = captionScene.pieceBounds(piece, t, measure!);
              return box ? [box] : [];
            });
          }
          return exact && t >= exact.fromMs && t < exact.toMs ? [exact.box] : [];
        };
        const covers = (pieces: readonly captionScene.ShapePiece[]) =>
          pieces.some((piece) => {
            for (let t = own.toMs; t < piece.toMs; t += 1000 / 30) {
              // What the piece draws, without the corner moves that size its shared drawing box; shapes never measure text.
              const ink = captionScene.pieceBounds({ ...piece, path: piece.path.slice(2) }, t, measure ?? (() => ({ advance: 0, inkTop: 0, inkBottom: 0, ascent: 0, descent: 0 })));
              if (ink && nextWords(t).some((box) => meets(ink, box))) return true;
            }
            return false;
          });
        if (!scene) expect(exact).toBeDefined();
        if (!outcome.placed || outcome.pieces[0]!.toMs <= own.toMs) return;
        held += 1;
        expect(covers(outcome.pieces)).toBe(false);
        // A one-cue feeder that left the next cue's box out would have covered it here.
        if (!scene) {
          const alone = placeCaptionEmojis({ ...input, cueBoxes: [own] }).find((each) => each.emoji.id === "rocket")!;
          if (alone.placed && covers(alone.pieces)) coveredWithoutNextBox += 1;
        }
      });
    }
  }
  afterAll(() => {
    // Not vacuous: emojis were held, and on some of these cues the next cue's box is what kept them off its words.
    expect(held).toBeGreaterThan(5);
    expect(coveredWithoutNextBox).toBeGreaterThan(0);
  });
});
