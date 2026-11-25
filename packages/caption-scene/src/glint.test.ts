import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { evaluatePiece, pieceBounds } from "./scene";
import { glintProgram } from "./templates/glint";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("glint", glintProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFD320", highlight: "#FF2F8B", accent: "#FFFFFF", shadow: "#000000" };

const build = (lines: string[], options: Record<string, number> = {}, language?: string, fps = 30) => {
  const { cues } = demoCues({ lines, language, options: { lead: 400, gap: 30, cueGap: 140, tail: 800, ...options } });
  return { cues, pieces: glintProgram.build(sceneInput(cues, { fps, colours })).pieces };
};
const faceOf = (id: RegExp, pieces: ReturnType<typeof build>["pieces"]) => pieces.filter((piece) => id.test(piece.id));

describe("glint", () => {
  test("every word lands readable in its own colour on its first painted frame, never before it is spoken", () => {
    const { cues, pieces } = build(["stop:b scrolling:b and:m listen:h@600"]);
    for (const [w, word] of cues[0]!.words.entries()) {
      const faces = faceOf(new RegExp(`^glint:0:w${w}(l\\d+)?$`), pieces);
      expect(faces.length).toBeGreaterThan(0);
      for (const face of faces) {
        expect(face.fromMs).toBeGreaterThanOrEqual(word.startMs);
        const pose = evaluatePiece(face, face.fromMs);
        expect(pose.o).toBe(1);
        expect(pose.sx).toBeGreaterThanOrEqual(0.88);
        expect(["#FFD320", "#FF2F8B"]).toContain(pose.colour);
      }
    }
  });

  test("rows alternate yellow and pink and the key word's row is pink", () => {
    const { pieces } = build(["stop:b scrolling:b and:m listen:h@600", "it's:m free:b and:m easy:b"]);
    const colourOf = (id: string) => evaluatePiece(pieces.find((piece) => piece.id === id)!, 99999).colour;
    expect(colourOf("glint:0:w0")).toBe("#FFD320");
    expect(colourOf("glint:0:w3l0")).toBe("#FF2F8B");
    expect(colourOf("glint:1:w0")).toBe("#FFD320");
  });

  test("the bounce is one short overshoot: 88% to 105% to 100% inside 115 ms", () => {
    const { pieces } = build(["just:b start:b today:h@600"]);
    const face = pieces.find((piece) => piece.id === "glint:0:w0")!;
    const scales = exportFrameTimes(face.fromMs, face.fromMs + 140, 60).map((t) => evaluatePiece(face, t).sx);
    expect(scales[0]).toBeCloseTo(0.88, 2);
    expect(Math.max(...scales)).toBeGreaterThan(1.03);
    expect(Math.max(...scales)).toBeLessThan(1.07);
    expect(scales.at(-1)).toBeCloseTo(1, 2);
    expect(scales.indexOf(Math.max(...scales))).toBeLessThan(scales.length - 1);
  });

  test("the key word's letters all appear within 45 ms of its first, at small alternating resting angles", () => {
    const { cues, pieces } = build(["just:b start:b today:h@600"]);
    const letters = faceOf(/^glint:0:w2l\d$/, pieces);
    expect(letters).toHaveLength(5);
    const starts = letters.map((piece) => piece.fromMs);
    expect(starts[0]).toBeGreaterThanOrEqual(cues[0]!.words[2]!.startMs);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThanOrEqual(45);
    const angles = letters.map((piece) => evaluatePiece(piece, piece.toMs - 300).rz);
    expect(new Set(angles.map((a) => Math.round(a * 10))).size).toBeGreaterThan(2);
  });

  test("a short key word's letters finish inside its own time, a 13-letter key word and a Hindi word land whole", () => {
    const { cues, pieces } = build(["go:b now:h@100"]);
    const letters = faceOf(/^glint:0:w1l\d$/, pieces);
    expect(Math.max(...letters.map((piece) => piece.fromMs))).toBeLessThan(cues[0]!.words[1]!.endMs);
    const long = build(["it's:m organisations:h@900"]);
    expect(faceOf(/^glint:0:w1l\d+$/, long.pieces)).toHaveLength(0);
    expect(long.pieces.some((piece) => piece.id === "glint:0:w1")).toBe(true);
    const hindi = build(["यह:b बहुत:h@700"], {}, "hi");
    expect(faceOf(/^glint:0:w1l\d+$/, hindi.pieces)).toHaveLength(0);
    expect(hindi.pieces.some((piece) => piece.id === "glint:0:w1")).toBe(true);
  });

  test("depth is painted far to near on one pivot, so it turns and scales with the face", () => {
    const { pieces } = build(["just:b start:b today:h@600"]);
    const stack = ["glint:0:w0b", "glint:0:w0e", "glint:0:w0"].map((id) => pieces.find((piece) => piece.id === id)!);
    expect(stack.every(Boolean)).toBe(true);
    expect(stack.map((piece) => piece.z)).toEqual([...stack.map((piece) => piece.z)].sort((a, b) => a - b));
    for (const piece of stack) expect(piece.track).toEqual(stack[2]!.track);
    const offsets = stack.map((piece) => piece.origin!.dx);
    expect(offsets[0]).toBeLessThan(offsets[1]!);
    expect(offsets[1]).toBeLessThan(offsets[2]!);
  });

  test("a brand colour gets a derived depth colour, the sample's colours keep the sample's", () => {
    const { cues } = demoCues({ lines: ["just:b start:b"], options: { lead: 400 } });
    const brand = glintProgram.build(sceneInput(cues, { fps: 30, colours: { ...colours, primary: "#22CC88" } })).pieces;
    const own = evaluatePiece(brand.find((piece) => piece.id === "glint:0:w0e")!, 5000).colour;
    expect(own).not.toBe("#D2570B");
    expect(own).not.toBe("#22CC88");
    const sample = build(["just:b start:b"]).pieces;
    expect(evaluatePiece(sample.find((piece) => piece.id === "glint:0:w0e")!, 5000).colour).toBe("#D2570B");
  });

  test("the light pass is a clipped white copy: a narrow band, white for about 35-55 ms at any point", () => {
    const { pieces } = build(["just:b start:b today:h@600"]);
    const sheen = pieces.find((piece) => piece.id === "glint:0:w0h")!;
    expect(sheen.kind === "text" && sheen.fill).toBe("#FFFFFF");
    expect(sheen.clip).toBeDefined();
    const box = pieceBounds({ ...sheen, clip: undefined }, sheen.fromMs + 200, fakeMeasure)!;
    let lit = 0;
    let first = 0;
    for (let t = sheen.fromMs; t < sheen.fromMs + 330; t++) {
      const x = (box.x1 + box.x2) / 2;
      const clip = evaluatePiece(sheen, t).clip!;
      if (clip.x1 <= x && x <= clip.x2) {
        lit++;
        first ||= t;
      }
    }
    expect(lit).toBeGreaterThanOrEqual(30);
    expect(lit).toBeLessThanOrEqual(60);
    expect(first).toBeLessThan(sheen.fromMs + 300);
  });

  test("every cue twinkles twice in small shapes, off the other words, and a long hold re-passes the light and twinkles again", () => {
    const { cues, pieces } = build(["so:m here:b is:h@500 it:b", "no:h@400 way:b", "wait:h@4200"]);
    for (const cue of cues) {
      const twinkles = pieces.filter((piece) => piece.id.startsWith(`glint:${cue.index}:tw`));
      expect(twinkles.length, `cue ${cue.index}`).toBeGreaterThanOrEqual(2);
      for (const piece of twinkles) {
        const box = pieceBounds(piece, piece.fromMs + 90, fakeMeasure)!;
        expect(box.x2 - box.x1).toBeLessThanOrEqual(100);
      }
    }
    const count = (cue: number) => pieces.filter((piece) => piece.id.startsWith(`glint:${cue}:tw`)).length;
    expect(count(2)).toBeGreaterThan(count(1));
    const sheens = pieces.filter((piece) => /^glint:2:w0l0h\d*$/.test(piece.id));
    expect(sheens.length).toBeGreaterThan(2);
    for (const sheen of sheens) expect(sheen.toMs - sheen.fromMs).toBeLessThanOrEqual(260);
  });

  test("the cue leaves as one unit over its last 70 ms: every piece fades together, none is left for the next cue", () => {
    const { cues, pieces } = build(["just:b start:b", "make:b it:m"], { cueGap: 900, tail: 900 });
    const own = pieces.filter((piece) => piece.id.startsWith("glint:0:") && !piece.id.includes(":tw"));
    const end = Math.max(...own.map((piece) => piece.toMs));
    expect(end).toBeLessThanOrEqual(cues[0]!.endMs);
    const t = end - 30;
    const opacities = own.map((piece) => evaluatePiece(piece, t).o);
    expect(Math.max(...opacities) - Math.min(...opacities)).toBeLessThan(0.001);
    expect(opacities[0]).toBeLessThan(1);
    expect(evaluatePiece(own[0]!, end - 120).o).toBe(1);
  });

  test("rows keep their painted depth off the next row's lettering", () => {
    const { pieces } = build(["stop:b scrolling:b and:m listen:h@600"]);
    const rest = 2000;
    const bottom = (id: string) => pieceBounds(pieces.find((piece) => piece.id === id)!, rest, fakeMeasure)!;
    const faces = pieces.filter((piece) => /^glint:0:w\dl?\d?$/.test(piece.id));
    const first = faces.filter((piece) => /^glint:0:w[01]$/.test(piece.id));
    const second = faces.filter((piece) => /^glint:0:w[23]/.test(piece.id));
    const lowest = Math.max(...first.map((piece) => bottom(`${piece.id}b`).y2 - 0.07 * (piece.kind === "text" ? piece.sizePx : 0)));
    const top = Math.min(...second.map((piece) => bottom(piece.id).y1));
    expect(lowest).toBeLessThanOrEqual(top + 30);
  });

  test("a word wider than the column breaks across rows at a readable size", () => {
    const word = "pneumonoultramicroscopicsilicovolcanoconiosis";
    const { pieces } = build([`${word}:h@900`]);
    const parts = pieces.filter((piece) => /^glint:0:w0l\d$/.test(piece.id));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(word.toUpperCase());
    for (const piece of parts) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(80);
  });

  test("a long word splits into the fewest rows and the rows come out even, never a stray last letter", () => {
    const word = "unbelievablyextraordinarily";
    const { pieces } = build([`${word}:h@900`]);
    const parts = pieces.filter((piece) => /^glint:0:w0l\d$/.test(piece.id));
    const text = parts.map((piece) => (piece.kind === "text" ? piece.text : ""));
    expect(text.join("")).toBe(word.toUpperCase());
    expect(text.every((part) => part.length >= 0.6 * Math.max(...text.map((t) => t.length)))).toBe(true);
    expect(text.every((part) => !part.includes(" "))).toBe(true);
  });

  test("a short cue still twinkles, inside its own window, and no twinkle outlives the cue or starts before its key word", () => {
    const { cues, pieces } = build(["no:h@120 way:b", "ok:m fine:h@160", "yes:h@110"], { cueGap: 60, gap: 20, tail: 0 });
    for (const cue of cues) {
      const twinkles = pieces.filter((piece) => piece.id.startsWith(`glint:${cue.index}:tw`));
      const key = cue.words.find((word) => word.role === "hero") ?? cue.words.at(-1)!;
      expect(twinkles.length, `cue ${cue.index}`).toBeGreaterThanOrEqual(1);
      for (const piece of twinkles) {
        expect(piece.fromMs).toBeGreaterThanOrEqual(key.startMs);
        expect(piece.toMs).toBeLessThanOrEqual(cue.words.at(-1)!.endMs + 200);
      }
    }
  });

  test("a cue stays inside the safe area at twice the size, portrait and landscape, and under the piece budget", () => {
    for (const edge of ["urdu", "nine-words", "long-word"] as const) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
        const { cues } = sceneEdgeDemo(edge);
        const pieces = glintProgram.build(sceneInput(cues, { fps: 30, colours, scale: 2, canvas })).pieces;
        for (const cue of cues) {
          const own = pieces.filter((piece) => piece.id.startsWith(`glint:${cue.index}:`));
          expect(own.length, `${edge} cue ${cue.index}`).toBeLessThanOrEqual(150);
        }
      }
    }
  });
});
