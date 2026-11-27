import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { CaptionEmojiArt } from "@narriflow/caption-emoji/art";
import * as captionScene from "@narriflow/caption-scene";
import { CAPTION_EMOJI_MAX_GAP, CAPTION_EMOJI_POP_MS, type CaptionEmojiLayerInput, captionEmojiShownAtPop, pieceBounds } from "@narriflow/caption-scene";
import { type ClipCompositionPlan, planClipComposition } from "@narriflow/composition-plan";
import { CAPTION_PRESETS, captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import { loadPlanCaptionEmojiArt } from "./caption-emoji-ass";
import { compileCompositionPlanCaptions } from "./composition-ffmpeg-adapter";

/**
 * Every classic and Dynamic preset's emojis sit close to the text that reads on their first painted frame (ticket 33,
 * `captionEmojiShownAtPop`), through the export's own feeders, with the caption at its default height, at 30% and at 58%:
 * every pick drawn, at most `CAPTION_EMOJI_MAX_GAP` of the emoji's height from that text, off it, inside the safe area. A classic line shows all its text at once (its box); a Dynamic block
 * draws each word from its onset. The Scene Styles' run is `packages/caption-scene/src/emoji/placement.test.ts`.
 */

const CANVAS = { width: 1080, height: 1920 };
const WORDS = ["the", "biggest", "mistake", "people", "make", "is", "waiting", "until", "they", "feel", "ready", "today"];
/** An emoji on every other word: two in most cues, so back-to-back emojis of one cue are covered too. */
const EMOJI_WORDS = [1, 3, 5, 6, 9, 11];
const keyOf = (index: number) => String(Math.round((0.2 + index * 0.4) * 1000));
const IDS = ["flame", "rocket", "heart-eyes", "astronaut", "money-bag", "brain"];
/** Placement keeps the gap from the turned ink box, which holds the drawn paths a little loosely. */
const GAP_TOLERANCE = 0.03;

function planFor(presetId: string, positionY: number | undefined): ClipCompositionPlan {
  const spans = WORDS.map((word, index) => ({ word, startSec: 0.2 + index * 0.4, endSec: 0.55 + index * 0.4, confidence: 1 }));
  const preset = CAPTION_PRESETS.find((entry) => entry.id === presetId)!.preset;
  const document = editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 0.6 + WORDS.length * 0.4,
    captionPreset: captionPresetSchema.parse({ ...preset, wordsPerCue: 4, emojis: true, ...(positionY === undefined ? {} : { positionY }) }),
    transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "Speaker", startSec: 0.2, endSec: spans.at(-1)!.endSec, text: WORDS.join(" "), confidence: 1, words: spans }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, captionEmojis: Object.fromEntries(EMOJI_WORDS.map((word, at) => [keyOf(word), { id: IDS[at % IDS.length]! }])) }),
    brollUrl: null,
    deletedRanges: [],
  });
  const result = planClipComposition({
    document,
    source: { identity: "caption-emoji-closeness", kind: "video", width: 1280, height: 720 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: CANVAS.width, height: CANVAS.height }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

type Box = captionScene.Box;
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
const gapOf = (a: Box, b: Box) => Math.hypot(Math.max(0, b.x1 - a.x2, a.x1 - b.x2), Math.max(0, b.y1 - a.y2, a.y1 - b.y2));
/** Shapes never measure text. */
const noText = () => ({ advance: 0, inkTop: 0, inkBottom: 0, ascent: 0, descent: 0 });

let art: Map<string, CaptionEmojiArt>;
beforeAll(async () => {
  art = await loadPlanCaptionEmojiArt(planFor("electric", undefined));
});

const PRESETS = CAPTION_PRESETS.filter((entry) => !entry.preset.scene);

describe("classic and Dynamic emojis sit close to their caption", () => {
  for (const positionY of [undefined, 30, 58]) {
    test(`every classic and Dynamic preset, caption at ${positionY === undefined ? "its default height" : `${positionY}%`}`, () => {
      expect(PRESETS.length).toBeGreaterThan(0);
      for (const { id } of PRESETS) {
        const outcomes: string[] = [];
        const spy = spyOn(captionScene, "placeCaptionEmojis");
        let calls: { input: CaptionEmojiLayerInput; output: ReturnType<typeof captionScene.placeCaptionEmojis> }[];
        let plan: ClipCompositionPlan;
        try {
          plan = planFor(id, positionY);
          compileCompositionPlanCaptions(plan, "vertical", undefined, undefined, 30, art);
          calls = spy.mock.calls.map((call, at) => ({ input: call[0], output: spy.mock.results[at]!.value as ReturnType<typeof captionScene.placeCaptionEmojis> }));
        } finally {
          spy.mockRestore();
        }
        for (const { input, output } of calls) {
          // No emoji shows past the clip's end.
          expect(input.endMs).toBe(plan!.editedDurationSec * 1000);
          for (const outcome of output) {
            outcomes.push(outcome.placed ? "placed" : outcome.reason);
            if (!outcome.placed) continue;
            const cue = input.cueBoxes.find((box) => box.cueIndex === outcome.emoji.cueIndex)!;
            const piece = outcome.pieces[0]!;
            const shown = captionEmojiShownAtPop(cue, piece.fromMs, 30);
            const restMs = Math.min(piece.fromMs + CAPTION_EMOJI_POP_MS, piece.toMs - 1);
            const parts = outcome.pieces.flatMap((part) => pieceBounds({ ...part, path: part.path.slice(2) }, restMs, noText) ?? []);
            const ink = { x1: Math.min(...parts.map((b) => b.x1)), y1: Math.min(...parts.map((b) => b.y1)), x2: Math.max(...parts.map((b) => b.x2)), y2: Math.max(...parts.map((b) => b.y2)) };
            const where = `${id} cue ${cue.cueIndex} at ${piece.fromMs}`;
            expect(Math.min(...shown.map((box) => gapOf(ink, box))) / (ink.y2 - ink.y1), where).toBeLessThanOrEqual(CAPTION_EMOJI_MAX_GAP + GAP_TOLERANCE);
            expect(shown.some((box) => meets(ink, box)), where).toBe(false);
            expect(ink.x1 >= 0.05 * CANVAS.width - 0.5 && ink.y1 >= 0.05 * CANVAS.height - 0.5 && ink.x2 <= 0.95 * CANVAS.width + 0.5 && ink.y2 <= 0.95 * CANVAS.height + 0.5, where).toBe(true);
            // At full strength for at least 250 ms before it fades.
            expect(piece.track.o![0]![0] - piece.fromMs, where).toBeGreaterThanOrEqual(captionScene.CAPTION_EMOJI_MIN_HOLD_MS);
          }
        }
        // Measured 2026-11-27: every pick of every preset is drawn at each height.
        expect(outcomes, `${id} at ${positionY ?? "default"}`).toEqual(EMOJI_WORDS.map(() => "placed"));
      }
    });
  }
});
