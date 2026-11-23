import { describe, expect, test } from "bun:test";
import { captionSceneMeta, getCaptionPresetById } from "@narriflow/validators";
import { demoCues, SCENE_EDGE_DEMOS, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
import { buildCaptionScene, captionSceneDemo } from "./registry";
import { evaluatePiece, pieceBounds, SCENE_PIECE_BUDGET, sceneBoundsAt } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";

describe("Orbit", () => {
  test("an entering word never jumps sideways between animation pieces", () => {
    const { cues } = demoCues({ lines: ["with:m Apple:b@900 Pencil:b@900 support:h@900"] });
    const word = cues[0]!.words[1]!;
    const pieces = buildCaptionScene("orbit", sceneInput(cues)).pieces.filter((piece) => piece.id.startsWith("orbit:0:w1"));
    let largestJump = 0;
    const boundaries = [...pieces.map((piece) => piece.fromMs), ...Array.from({ length: 519 }, (_, i) => word.startMs - 79 + i)];
    for (const boundary of boundaries.filter((ms) => ms > word.startMs - 80 && ms < word.startMs + 440)) {
      const before = sceneBoundsAt(pieces, boundary - 0.001, fakeMeasure);
      const after = sceneBoundsAt(pieces, boundary + 0.001, fakeMeasure);
      if (before && after) largestJump = Math.max(largestJump, Math.abs(after.x1 - before.x1), Math.abs(after.x2 - before.x2));
    }
    expect(largestJump).toBeLessThan(0.1);
  });

  test("the preset and sample register the cream regular face and five-word cues", () => {
    expect(getCaptionPresetById("orbit")!.preset).toMatchObject({ scene: "orbit", fontName: "Inter Tight Regular", wordsPerCue: 5, primaryColor: "#F3ECDC", highlightColor: "#FF7A1A", accentColor: "#FF5FA8" });
    expect(captionSceneMeta("orbit").bodyPx).toBe(124);
    const { cues } = captionSceneDemo("orbit");
    const { pieces } = buildCaptionScene("orbit", sceneInput(cues));
    expect(pieces.filter((piece) => piece.id.endsWith(":ring"))).toHaveLength(3);
    expect(pieces.filter((piece) => piece.id.endsWith(":sticker"))).toHaveLength(3);
    expect(pieces.some((piece) => piece.id.endsWith(":sticker-eye"))).toBe(true);
    expect(pieces.some((piece) => piece.id.endsWith(":sticker-line0"))).toBe(true);
    expect(pieces.filter((piece) => piece.id.includes(":sticker-dot"))).toHaveLength(24);
    expect(pieces.filter((piece) => piece.id.startsWith("orbit:0:spark"))).toHaveLength(2);
  });

  for (const fps of [24, 25, 30, 60]) {
    test(`${fps} fps: speech stays readable until its end and only spare cue time is squashed`, () => {
      const { cues } = demoCues({ lines: ["keep:b@180 going:h@180", "trust:h@120 it:b@120"], options: { lead: 357, gap: 0, cueGap: 0 } });
      const { pieces } = buildCaptionScene("orbit", sceneInput(cues, { fps }));
      cues.forEach((cue, n) => { cue.words.forEach((word, at) => {
        const t = exportFrameAtOrBefore(word.endMs - 1, fps);
        const face = pieces.find((piece) => piece.id.startsWith(`orbit:${n}:w${at}c`) && evaluatePiece(piece, t).visible)!;
        expect(face).toBeDefined();
        expect(evaluatePiece(face, t).sy).toBe(1);
        expect(evaluatePiece(face, t).o).toBeGreaterThan(0.9);
      }); });
      const final = cues.at(-1)!;
      const rest = pieces.find((piece) => piece.id.startsWith("orbit:1:w1c") && evaluatePiece(piece, final.endMs - 20).visible)!;
      expect(evaluatePiece(rest, final.endMs - 20).sy).toBeLessThan(0.5);
      for (const piece of pieces.filter((piece) => piece.kind === "shape")) {
        const painted = exportFrameTimes(piece.fromMs, piece.toMs, fps).filter((t) => pieceBounds(piece, t, fakeMeasure));
        expect(painted.length, piece.id).not.toBe(1);
      }
    });
  }

  test("tracking moves continuously while glyphs keep their size, font and case", () => {
    const { cues } = demoCues({ lines: ["Stay:b@900 focused:h@900"] });
    const { pieces } = buildCaptionScene("orbit", sceneInput(cues));
    const faces = pieces.filter((piece) => piece.kind === "text" && piece.id.startsWith("orbit:0:w0c"));
    expect(faces.map((piece) => piece.kind === "text" ? piece.text : "").join("")).toBe("Stay");
    expect(faces.every((piece) => piece.kind === "text" && piece.face === "Inter Tight Regular" && piece.letterSpacingEm === -0.03)).toBe(true);
    const first = faces[0]!;
    const last = faces.at(-1)!;
    let previous = Number.POSITIVE_INFINITY;
    for (let t = first.fromMs + 20; t <= first.fromMs + 520; t += 10) {
      const a = evaluatePiece(first, t), b = evaluatePiece(last, t);
      expect(b.x - a.x).toBeLessThan(previous);
      expect(a.sx).toBe(1);
      expect(b.sx).toBe(1);
      previous = b.x - a.x;
    }
    expect(evaluatePiece(first, first.fromMs + 60).x).toBe(evaluatePiece(first, first.fromMs + 520).x);
    expect(evaluatePiece(last, last.fromMs + 60).x - evaluatePiece(last, last.fromMs + 61).x).toBeGreaterThan(0);
  });

  test("joining scripts and emoji keep their whole-word shaping", () => {
    const urdu = sceneEdgeDemo("urdu");
    const joined = buildCaptionScene("orbit", sceneInput(urdu.cues)).pieces.filter((piece) => piece.kind === "text");
    expect(joined).toHaveLength(urdu.cues.reduce((sum, cue) => sum + cue.words.length, 0));
    expect(joined.every((piece) => piece.kind === "text" && piece.letterSpacingEm === 0)).toBe(true);
    const emoji = demoCues({ lines: ["🇵🇰:b@900 👩‍💻:b@900"] });
    const symbols = buildCaptionScene("orbit", sceneInput(emoji.cues)).pieces.filter((piece) => piece.kind === "text");
    expect(symbols.map((piece) => piece.kind === "text" ? piece.text : "")).toEqual(["🇵🇰", "👩‍💻"]);
  });

  test("long cues retain every character within the piece budget", () => {
    const words = ["extraordinarily".repeat(3), "unbelievable".repeat(3), "impressive".repeat(3), "incredible".repeat(3), "beautiful".repeat(3)];
    const { cues } = demoCues({ lines: Array.from({ length: 3 }, () => words.map((text, i) => `${text}:${i === 4 ? "h" : "b"}@900`).join(" ")) });
    const { pieces } = buildCaptionScene("orbit", sceneInput(cues));
    for (let n = 0; n < cues.length; n++) {
      const group = pieces.filter((piece) => piece.id.split(":")[1] === String(n));
      expect(group.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0)).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
      words.forEach((text, at) => {
        const parts = group.filter((piece) => piece.kind === "text" && piece.id.startsWith(`orbit:${n}:w${at}c`));
        expect(parts.map((piece) => piece.kind === "text" ? piece.text : "").join("")).toBe(text);
      });
    }
  });

  test("the planet travels a tilted ellipse throughout a long held cue", () => {
    const { cues } = demoCues({ lines: ["trust:h@1000"], options: { tail: 13000 } });
    const { pieces } = buildCaptionScene("orbit", sceneInput(cues));
    const planet = pieces.find((piece) => piece.id.endsWith(":planet"))!;
    const start = cues[0]!.startMs + 900;
    const a = evaluatePiece(planet, start);
    const b = evaluatePiece(planet, start + 2600);
    const c = evaluatePiece(planet, start + 5200);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(100);
    expect(c.x).toBeCloseTo(a.x, 0);
    expect(c.y).toBeCloseTo(a.y, 0);
  });

  test("all edge cues, aspect ratios and sticker variants stay inside the safe area and budget", () => {
    for (const kind of SCENE_EDGE_DEMOS) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
        const original = sceneEdgeDemo(kind).cues;
        // Repeating the edge cue exercises the third hero's dotted sticker too.
        const cues = Array.from({ length: 3 }, (_, n) => original.map((cue) => ({ ...cue, index: n * original.length + cue.index,
          startMs: cue.startMs + n * 10000, endMs: cue.endMs + n * 10000,
          words: cue.words.map((word) => ({ ...word, startMs: word.startMs + n * 10000, endMs: word.endMs + n * 10000 })) }))).flat();
        const { pieces } = buildCaptionScene("orbit", sceneInput(cues, { canvas }));
        cues.forEach((cue, n) => {
          const group = pieces.filter((piece) => piece.id.split(":")[1] === String(n));
          expect(group.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0)).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
          for (const t of exportFrameTimes(cue.startMs - 80, cue.endMs, 30)) {
            const box = sceneBoundsAt(group, t, fakeMeasure);
            if (!box) continue;
            expect(box.x1).toBeGreaterThanOrEqual(canvas.width * 0.05 - 1);
            expect(box.x2).toBeLessThanOrEqual(canvas.width * 0.95 + 1);
            expect(box.y1).toBeGreaterThanOrEqual(canvas.height * 0.05 - 1);
            expect(box.y2).toBeLessThanOrEqual(canvas.height * 0.95 + 1);
          }
        });
      }
    }
  });
});
