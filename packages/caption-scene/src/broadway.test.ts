import { describe, expect, test } from "bun:test";
import { CAPTION_SCENES } from "@narriflow/validators";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { exportFrameAtOrAfter, exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { SCENE_PIECE_BUDGET, evaluatePiece, pieceBounds } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";
import { BROADWAY_DEMO, broadwayProgram } from "./templates/broadway";

describeSpeechConformance("broadway", broadwayProgram, { anchorLineY: 1290 });

const build = (lines: readonly string[], options = BROADWAY_DEMO.options) => {
  const { cues } = demoCues({ lines, options });
  return { cues, pieces: broadwayProgram.build(sceneInput(cues, { fps: 30, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } })).pieces };
};
const word = /^broadway:\d+:w\d+$/;

describe("broadway", () => {
  test("no bulb, glint, ray, sweep or frame ever covers a readable word", () => {
    for (const cueGap of [0, 60, 150]) {
      const { cues, pieces } = build(BROADWAY_DEMO.lines, { ...BROADWAY_DEMO.options, cueGap });
      for (const cue of cues) {
        const own = pieces.filter((piece) => piece.id.startsWith(`broadway:${cue.index}:`));
        const faces = own.filter((piece) => word.test(piece.id));
        for (const t of exportFrameTimes(cue.startMs, cue.endMs, 30)) {
          for (const face of faces) {
            const pose = evaluatePiece(face, t);
            if (!pose.visible || pose.o < 0.9) continue;
            const box = pieceBounds(face, t, fakeMeasure)!;
            for (const other of own) {
              if (word.test(other.id) || other.z <= face.z) continue;
              const ob = pieceBounds(other, t, fakeMeasure);
              if (!ob || evaluatePiece(other, t).o < 0.5) continue;
              const meets = ob.x1 < box.x2 && box.x1 < ob.x2 && ob.y1 < box.y2 && box.y1 < ob.y2;
              expect(meets, `${other.id} over ${face.id} at ${t}, gap ${cueGap}`).toBe(false);
            }
          }
        }
      }
    }
  });

  test("the sign is wider than its words and grows as they are spoken", () => {
    const { cues, pieces } = build(["your:m time:b to:m shine:h@700"]);
    const sign = pieces.find((piece) => piece.id === "broadway:0:sign")!;
    const words = pieces.filter((piece) => word.test(piece.id));
    const at = (t: number) => pieceBounds(sign, t, fakeMeasure)!;
    const early = at(cues[0]!.words[0]!.startMs + 400);
    const late = at(cues[0]!.words[3]!.endMs - 50);
    expect(late.x2 - late.x1).toBeGreaterThan(early.x2 - early.x1);
    for (const face of words) {
      const t = cues[0]!.words[3]!.endMs - 50;
      const w = pieceBounds(face, t, fakeMeasure)!;
      expect(w.x1, face.id).toBeGreaterThan(late.x1);
      expect(w.x2, face.id).toBeLessThan(late.x2);
      expect(w.y1, face.id).toBeGreaterThan(late.y1);
      expect(w.y2, face.id).toBeLessThan(late.y2);
    }
  });

  test("a long key word makes the sign wider instead of making the word small", () => {
    const { cues, pieces } = build(["so:m keep:b going:b", "unbelievable:h@800"]);
    const hero = pieces.find((piece) => piece.id === "broadway:1:w0")!;
    const sign = pieces.find((piece) => piece.id === "broadway:1:sign")!;
    const t = cues[1]!.words[0]!.endMs - 30;
    const word = pieceBounds(hero, t, fakeMeasure)!;
    const frame = pieceBounds(sign, t, fakeMeasure)!;
    // The sample fits the key word to 700 px; here it gets the whole width the safe area leaves inside the frame.
    expect(word.x2 - word.x1).toBeGreaterThan(740);
    expect(frame.x2 - frame.x1).toBeGreaterThan(word.x2 - word.x1 + 120);
  });

  test("the key word flashes every bulb at once, and the ring chases without it", () => {
    const { cues, pieces } = build(BROADWAY_DEMO.lines);
    const bulbs = pieces.filter((piece) => /^broadway:1:glow\d+$/.test(piece.id));
    expect(bulbs.length).toBeGreaterThanOrEqual(12);
    const hero = cues[1]!.words[3]!;
    const flash = bulbs.filter((piece) => evaluatePiece(piece, hero.startMs - 40).o > 0.9).length;
    expect(flash).toBe(bulbs.length);
    const chase = bulbs.map((piece) => evaluatePiece(piece, cues[1]!.words[0]!.startMs + 120).o);
    expect(chase.some((o) => o === 0)).toBe(true);
    expect(chase.some((o) => o > 0.9)).toBe(true);
  });

  test("every cue draws its recurring beats and stays inside the piece budget", () => {
    const { cues, pieces } = build(BROADWAY_DEMO.lines);
    for (const cue of cues) {
      const own = pieces.filter((piece) => piece.id.startsWith(`broadway:${cue.index}:`));
      expect(own.some((piece) => piece.id.includes(":sweep")), `cue ${cue.index} sweep`).toBe(true);
      expect(own.some((piece) => piece.id.includes(":glint")), `cue ${cue.index} glint`).toBe(true);
      const layers = own.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0);
      expect(layers, `cue ${cue.index} layers`).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
    }
  });

  test("the sign shuts off when the cue has room to leave: bulbs and frame fade out", () => {
    const { cues, pieces } = build(BROADWAY_DEMO.lines, { ...BROADWAY_DEMO.options, cueGap: 700 });
    const sign = pieces.find((piece) => piece.id === "broadway:0:sign")!;
    const rest = evaluatePiece(sign, cues[0]!.words[2]!.endMs + 100);
    const gone = evaluatePiece(sign, sign.toMs - 20);
    expect(rest.o).toBeCloseTo(1, 1);
    expect(gone.o).toBeLessThan(0.5);
  });

  test("a word too long for a row breaks over rows at a readable size instead of shrinking to nothing", () => {
    const { pieces } = build(["it's:m pneumonoultramicroscopicsilicovolcanoconiosis:h@900 hard:b", "a:m pneumonoultramicroscopicsilicovolcanoconiosis:b@1400"]);
    for (const cue of [0, 1]) {
      const parts = pieces.filter((piece) => new RegExp(`^broadway:${cue}:w1l\\d$`).test(piece.id) || (cue === 1 && /^broadway:1:w1l\d$/.test(piece.id)));
      expect(parts.length, `cue ${cue}`).toBeGreaterThanOrEqual(2);
      for (const part of parts) if (part.kind === "text") expect(part.sizePx).toBeGreaterThan(50);
      expect(parts.map((part) => (part.kind === "text" ? part.text : "")).join("")).toBe("pneumonoultramicroscopicsilicovolcanoconiosis");
    }
  });

  test("a tall cue keeps the sign inside the caption band and every word on the plate, on 9:16, 1:1 and 16:9", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      const { cues } = demoCues({ lines: ["so:m the:m real:b reason:b most:b people:h@520 never:b get:b there:m"], options: { lead: 400, tail: 900 } });
      const input = sceneInput(cues, { fps: 30, canvas, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } });
      const pieces = broadwayProgram.build(input).pieces;
      const ay = (1290 / 1920) * canvas.height;
      const top = ay - (430 * canvas.height) / 1920;
      const bottom = ay + (360 * canvas.height) / 1920;
      const t = cues[0]!.endMs - 100;
      const sign = pieceBounds(pieces.find((piece) => piece.id === "broadway:0:sign")!, t, fakeMeasure)!;
      expect(sign.y1, `${canvas.width}x${canvas.height}`).toBeGreaterThanOrEqual(top - 1);
      expect(sign.y2, `${canvas.width}x${canvas.height}`).toBeLessThanOrEqual(bottom + 1);
      const faces = pieces.filter((piece) => /^broadway:0:w\d+(l\d+)?$/.test(piece.id));
      expect(faces.length).toBeGreaterThanOrEqual(9);
      for (const face of faces) {
        const box = pieceBounds(face, t, fakeMeasure)!;
        expect(box.x1, face.id).toBeGreaterThan(sign.x1);
        expect(box.x2, face.id).toBeLessThan(sign.x2);
        expect(box.y1, face.id).toBeGreaterThan(sign.y1);
        expect(box.y2, face.id).toBeLessThan(sign.y2);
        if (face.kind === "text") expect(face.sizePx, face.id).toBeGreaterThan(24);
      }
    }
  });

  test("words and rows never overlap while the sign re-centres, even at 70 ms per word", () => {
    for (const per of [70, 150, 270]) {
      const { cues, pieces } = build([`one:b@${per} two:b@${per} three:b@${per} four:b@${per} five:b@${per} six:b@${per}`], { lead: 400, tail: 800 });
      const faces = pieces.filter((piece) => /^broadway:0:w\d$/.test(piece.id));
      for (const t of exportFrameTimes(cues[0]!.startMs - 100, cues[0]!.endMs, 60)) {
        const live = faces.flatMap((piece) => {
          const pose = evaluatePiece(piece, t);
          const box = pieceBounds(piece, t, fakeMeasure);
          return pose.visible && pose.o > 0.2 && box ? [{ piece, box }] : [];
        });
        for (const [i, a] of live.entries()) {
          for (const b of live.slice(i + 1)) {
            const meets = a.box.x1 + 1 < b.box.x2 && b.box.x1 + 1 < a.box.x2 && a.box.y1 + 1 < b.box.y2 && b.box.y1 + 1 < a.box.y2;
            expect(meets, `${a.piece.id} meets ${b.piece.id} at ${t} (${per} ms)`).toBe(false);
          }
        }
      }
    }
  });

  test("fast speech: the sign is in place on the first painted word and the recurring beats still paint", () => {
    for (const per of [70, 100, 120]) {
      const lines = ["go:b now:b@" + per + " and:m" , "stop:b@" + per + " right:b@" + per + " there:h@" + per, "keep:b going:b@" + per].map((line) => line.replace(/(\w+:[bhm])(?!@)/g, `$1@${per}`));
      const { cues, pieces } = build(lines, { lead: 400, gap: 0, cueGap: 0, tail: 600 });
      for (const cue of cues) {
        const own = pieces.filter((piece) => piece.id.startsWith(`broadway:${cue.index}:`));
        const onset = exportFrameAtOrAfter(cue.words[0]!.startMs, 30);
        const face = own.find((piece) => piece.id === `broadway:${cue.index}:w0`)!;
        const faceBox = pieceBounds(face, onset, fakeMeasure)!;
        for (const id of ["sign", "plate"]) {
          const piece = own.find((p) => p.id === `broadway:${cue.index}:${id}`)!;
          expect(evaluatePiece(piece, onset).o, `${id} cue ${cue.index} at ${per} ms`).toBeGreaterThan(0.85);
          const box = pieceBounds(piece, onset, fakeMeasure)!;
          expect(box.x1 < faceBox.x1 && box.x2 > faceBox.x2 && box.y1 < faceBox.y1 && box.y2 > faceBox.y2, `${id} backs the first word, cue ${cue.index} at ${per} ms`).toBe(true);
        }
        const beats = own.filter((piece) => /:(sweep|glint)\d$/.test(piece.id) && exportFrameTimes(piece.fromMs, piece.toMs, 30).some((t) => pieceBounds(piece, t, fakeMeasure)));
        expect(beats.length, `beats of cue ${cue.index} at ${per} ms`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("overlapping speakers at 2x on 16:9 get lanes of alike, readable size", () => {
    const { cues } = demoCues({ lines: ["some:b@300 fairly:b@300 long:b@300", "other:b@300"], options: { lead: 357, gap: 0, cueGap: 0 } });
    const starts = [400, 500];
    const run: SceneCue[] = cues.map((cue, i) => {
      const by = starts[i]! - cue.startMs;
      return { ...cue, startMs: cue.startMs + by, endMs: cue.endMs + by, speaker: i % 2, words: cue.words.map((w) => ({ ...w, startMs: w.startMs + by, endMs: w.endMs + by })) };
    });
    const canvas = { width: 1920, height: 1080 };
    const pieces = broadwayProgram.build(sceneInput(run, { fps: 30, canvas, scale: 2, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } })).pieces;
    const size = (cue: number) => Math.max(...pieces.flatMap((piece) => (piece.kind === "text" && piece.id.startsWith(`broadway:${cue}:w`) ? [piece.sizePx] : [])));
    expect(size(0)).toBeGreaterThan(50);
    expect(size(1)).toBeGreaterThan(50);
    expect(Math.max(size(0), size(1)) / Math.min(size(0), size(1))).toBeLessThan(1.5);
  });

  test("brand colours must read against the plate", () => {
    const { brand } = CAPTION_SCENES.broadway;
    expect(brand.primary?.readsOn?.length).toBeGreaterThan(0);
    expect(brand.secondary?.readsOn?.length).toBeGreaterThan(0);
  });
});
