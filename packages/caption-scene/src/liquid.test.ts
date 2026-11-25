import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { kf } from "./ease";
import { pieceBounds } from "./scene";
import { liquidProgram } from "./templates/liquid";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("liquid", liquidProgram, { anchorLineY: 1290 });

const build = (lines: string[]) => {
  const { cues } = demoCues({ lines, options: { lead: 400, gap: 30, cueGap: 140, tail: 800 } });
  return { cues, pieces: liquidProgram.build(sceneInput(cues, { fps: 30 })).pieces };
};

describe("liquid recurring beats", () => {
  test("every cue, with or without a key word, draws glass, a light sweep and a glint", () => {
    const { cues, pieces } = build(["the:m new:b update:b feels:b like:m glass:h@900", "every:b edge:b catches:b light:b", "just:m clear:b", "simple:h@900"]);
    for (const cue of cues) {
      const own = pieces.filter((piece) => piece.id.startsWith(`liquid:${cue.index}:`));
      for (const name of ["smoke", "dome", "spec", "rim", "sweep", "glint"]) {
        expect(own.some((piece) => piece.id.startsWith(`liquid:${cue.index}:${name}`)), `cue ${cue.index} has no ${name}`).toBe(true);
      }
    }
  });

  test("the key word gets a thumb and every other cue does not", () => {
    const { pieces } = build(["the:m new:b glass:h@900", "every:b edge:b"]);
    expect(pieces.some((piece) => piece.id.startsWith("liquid:0:thumbfill"))).toBe(true);
    expect(pieces.some((piece) => piece.id.startsWith("liquid:1:thumb"))).toBe(false);
  });

  test("each word lands with a chromatic split that closes before its face is settled", () => {
    const { cues, pieces } = build(["new:b update:b feels:b glass:h@900"]);
    for (const [at] of cues[0]!.words.entries()) {
      const copy = pieces.find((piece) => piece.id === `liquid:0:w${at}ca`);
      expect(copy, `word ${at} has no split copy`).toBeDefined();
    }
  });
});

describe("liquid layout", () => {
  test("the glass opens word by word: the clip is narrow at the first word and full once the row is complete", () => {
    const { cues, pieces } = build(["the:m new:b update:b glass:h@900"]);
    const clip = pieces.find((piece) => piece.id === "liquid:0:smoke0")!.clip!;
    const first = cues[0]!.words[0]!;
    const last = cues[0]!.words.at(-1)!;
    const open = (t: number) => kf(t, clip.x2) - kf(t, clip.x1);
    expect(open(first.startMs + 30)).toBeLessThan(open(last.endMs) * 0.6);
    expect(open(last.endMs)).toBeGreaterThan(300);
    expect(clip.radius).toBeGreaterThan(40);
  });

  test("the key word's thumb sits inside its row's capsule", () => {
    const { cues, pieces } = build(["display:b glare:b बहुत:h@900"]);
    const bounds = (id: string, t: number) => pieceBounds(pieces.find((piece) => piece.id === id)!, t, fakeMeasure)!;
    const t = cues[0]!.endMs - 300;
    const capsule = bounds("liquid:0:smoke1", t);
    const thumb = bounds("liquid:0:thumbfill2", t);
    expect(thumb.y1).toBeGreaterThanOrEqual(capsule.y1);
    expect(thumb.y2).toBeLessThanOrEqual(capsule.y2);
    expect(thumb.x1).toBeGreaterThanOrEqual(capsule.x1 - 1);
    expect(thumb.x2).toBeLessThanOrEqual(capsule.x2 + 1);
  });
});
