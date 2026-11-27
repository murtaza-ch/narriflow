import { describe, expect, test } from "bun:test";
import { CAPTION_EMOJI_LATE_HOLD_MS, type CaptionEmojiCueBox } from "@narriflow/caption-scene";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { NO_FOLLOWING_CUE, emojiFollowingCue, heldEmojiCues, rememberHeldCue } from "./held-cue-boxes";

const box: CaptionEmojiCueBox = { cueIndex: 0, box: { x1: 240, y1: 1200, x2: 840, y2: 1290 }, fromMs: 1000, toMs: 2000, bodyPx: 80, tiltDeg: 0, direction: "ltr" };
const input = { boxes: [box, { ...box, cueIndex: 1, fromMs: 2000, toMs: 3000 }], nextEmojiAtMs: 2400, endMs: undefined };
const layer = (patch: Partial<CompositionCaptionVisualLayer>) =>
  ({ id: "cue", activeRange: { startSec: 1, endSec: 2 }, emojis: [{ id: "rocket", atSec: 1.85, order: 0 }], ...patch }) as CompositionCaptionVisualLayer;

describe("emojis held past a classic or Dynamic cue's end", () => {
  test("a drawn cue with emojis is held from its end for the late hold, from the input it was placed from", () => {
    const cue = layer({});
    expect(heldEmojiCues([cue], 2.1)).toEqual([]);
    rememberHeldCue(cue, input);
    expect(heldEmojiCues([cue], 1.9)).toEqual([]);
    expect(heldEmojiCues([cue], 2)).toEqual([{ layer: cue, input }]);
    expect(heldEmojiCues([cue], 2 + CAPTION_EMOJI_LATE_HOLD_MS / 1000 - 0.001)).toEqual([{ layer: cue, input }]);
    expect(heldEmojiCues([cue], 2 + CAPTION_EMOJI_LATE_HOLD_MS / 1000)).toEqual([]);
  });

  test("Scene cues (the scene draws all of them) and cues without emojis are not held", () => {
    const scene = layer({ id: "scene", scene: { roles: [], keys: [], speaker: null } });
    const empty = layer({ id: "empty", emojis: [] });
    rememberHeldCue(scene, input);
    rememberHeldCue(empty, input);
    expect(heldEmojiCues([scene, empty], 2.1)).toEqual([]);
  });

  test("the cue after, and the first emoji of any later cue, by the plan's word time", () => {
    const cues = [
      layer({ id: "a", cueIndex: 0 }),
      layer({ id: "b", cueIndex: 1, emojis: [] }),
      layer({ id: "c", cueIndex: 2, emojis: [{ id: "flame", atSec: 2.3, order: 1 }] }),
    ];
    expect(emojiFollowingCue(cues, cues[0]!)).toEqual({ layer: cues[1]!, emojiAtMs: 2300 });
    expect(emojiFollowingCue(cues, cues[2]!)).toEqual({ layer: null, emojiAtMs: undefined });
    // A cue without emojis has no held emoji to give way.
    expect(emojiFollowingCue(cues, cues[1]!)).toBe(NO_FOLLOWING_CUE);
  });
});
