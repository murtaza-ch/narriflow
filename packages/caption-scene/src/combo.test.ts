import { describe, expect, test } from "bun:test";
import { describeSpeechConformance, fastRun, staccatoRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { type Box, type Piece, type TextPiece, pieceBounds } from "./scene";
import { sceneInput } from "./test-support";
import { comboProgram } from "./templates/combo";

describeSpeechConformance("combo", comboProgram, { anchorLineY: 1320 });

const build = (lines: string[], options = { lead: 400, gap: 30, cueGap: 120, tail: 600 }) => {
  const { cues } = demoCues({ lines, options });
  const input = sceneInput(cues, { fps: 30, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } });
  return { cues, input, pieces: comboProgram.build(input).pieces };
};

const overlaps = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;

describe("Combo draws no bar and no counter", () => {
  test("no piece of any cue is a progress segment, a shine, a count or a pulse", () => {
    for (const fps of [24, 30, 60]) {
      for (const cues of [fastRun(0), fastRun(60), staccatoRun(0), sceneEdgeDemo("long-word").cues, sceneEdgeDemo("urdu").cues]) {
        const pieces = comboProgram.build(sceneInput(cues, { fps, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } })).pieces;
        for (const piece of pieces) {
          expect(piece.id, piece.id).not.toMatch(/:(seg|fill|shine|count|pulse)\d*$/);
          if (piece.kind === "text") expect(piece.text, `${piece.id} draws a count`).not.toMatch(/×\d/);
        }
      }
    }
  });

  test("every text piece is a spoken word, its colour-split copy, or a piece of an overlong word", () => {
    const { cues, pieces } = build(["this:m one:b trick:b doubled:h@560 my:m views:b", "your:m turn:h@520"]);
    for (const piece of pieces) {
      if (piece.kind !== "text") continue;
      expect(piece.id).toMatch(/^combo:\d+:w\d+(?:l\d+)?[hk]?$/);
      const word = cues[Number(piece.id.split(":")[1])]!.words[Number(/:w(\d+)/.exec(piece.id)![1])]!;
      expect(word.text.toUpperCase()).toContain(piece.text);
    }
  });
});

describe("Combo key word", () => {
  test("its ring and shards sit behind every word and stay inside the safe area", () => {
    const { cues, input, pieces } = build(["this:m one:b trick:b doubled:h@560 my:m views:b", "your:m turn:h@520"]);
    const faceZ = Math.min(...pieces.filter((piece) => /^combo:\d+:w\d+$/.test(piece.id)).map((piece) => piece.z));
    const decor = pieces.filter((piece) => /^combo:\d+:(ring|shard)\d/.test(piece.id));
    expect(decor.length).toBeGreaterThanOrEqual(14);
    for (const piece of decor) {
      expect(piece.z).toBeLessThan(faceZ);
      for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
        const box = pieceBounds(piece, t, input.measure);
        if (!box) continue;
        expect(box.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
        expect(box.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
        expect(box.y1).toBeGreaterThanOrEqual(0.05 * 1920 - 1);
        expect(box.y2).toBeLessThanOrEqual(0.95 * 1920 + 1);
      }
    }
    expect(cues.length).toBe(2);
  });

  test("two key words in a cue each land their own critical hit", () => {
    const { pieces } = build(["this:b gold:h@500 and:m that:h@500"]);
    expect(pieces.some((piece) => piece.id === "combo:0:ring1")).toBe(true);
    expect(pieces.some((piece) => piece.id === "combo:0:ring3")).toBe(true);
  });

  test("the shard fan turns and changes colour from one key word to the next", () => {
    const { pieces } = build(["one:h@500", "two:h@500", "three:h@500"]);
    const shard = (cue: number) => pieces.find((piece) => piece.id === `combo:${cue}:shard0-0`)!;
    const signature = (cue: number) => `${shard(cue).track.rz?.[0]?.[1]}|${shard(cue).kind === "shape" ? shard(cue).fill?.colour : ""}`;
    expect(new Set([0, 1, 2].map(signature)).size).toBeGreaterThan(1);
  });

  test("a cue without a key word still lands a small hit ring behind its last word", () => {
    const { pieces } = build(["go:b crush:b it:b"]);
    expect(pieces.some((piece) => piece.id === "combo:0:hit2")).toBe(true);
  });
});

describe("Combo block", () => {
  test("an overlong key word breaks across rows at a readable size instead of shrinking the whole block", () => {
    const { cues, pieces } = build(["we:b need:b incomprehensibility:h@600"]);
    const parts = pieces.filter((piece): piece is TextPiece => piece.kind === "text" && /^combo:0:w2l\d+$/.test(piece.id));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((piece) => piece.text).join("")).toBe(cues[0]!.words[2]!.text.toUpperCase());
    for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(0.7 * 130 * 0.9);
    const body = pieces.find((piece) => piece.id === "combo:0:w0") as TextPiece;
    expect(body.sizePx).toBeGreaterThan(70);
  });

  test("a 44-letter word stays readable at phone size", () => {
    const { cues } = build(["it's:m pneumonoultramicroscopicsilicovolcanoconiosis:b"]);
    const input = sceneInput(cues, { fps: 30, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } });
    const sizes = comboProgram.build(input).pieces.filter((piece): piece is TextPiece => piece.kind === "text" && /^combo:0:w1l\d+$/.test(piece.id)).map((piece) => piece.sizePx);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(56);
  });

  test("a long word is broken into pieces of equal measured width, not equal letter counts", () => {
    const wide = (text: string, size: number, spacing: number) => ({
      advance: [...text].reduce((sum, letter) => sum + (letter === "M" ? 1.0 : 0.3) * size + spacing * size, 0),
      inkTop: -0.72 * size, inkBottom: 0.2 * size, ascent: 1.1 * size, descent: 0.3 * size,
    });
    const { cues } = demoCues({ lines: [`${"M".repeat(20)}${"I".repeat(20)}:b`], options: { lead: 400, gap: 30, cueGap: 120, tail: 600 } });
    const input = sceneInput(cues, { fps: 30, measure: (text, _face, size, spacing) => wide(text, size, spacing), anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } });
    const parts = comboProgram.build(input).pieces.filter((piece): piece is TextPiece => piece.kind === "text" && /^combo:0:w0l\d+$/.test(piece.id));
    expect(parts.length).toBeGreaterThan(1);
    const widths = parts.map((piece) => wide(piece.text, piece.sizePx, 0).advance);
    expect(Math.max(...widths) / Math.min(...widths)).toBeLessThan(1.35);
    expect(Math.min(...parts.map((piece) => piece.sizePx))).toBeGreaterThanOrEqual(56);
  });

  test("two speakers on screen together read at one size", () => {
    const { cues } = demoCues({ lines: ["go:b hard:h@300 now:b real:h@300", "yes:b ok:b"], options: { lead: 400, gap: 0, cueGap: 0, tail: 600 } });
    const by = 500 - cues[1]!.startMs + cues[0]!.startMs;
    const run = cues.map((cue, i) => ({
      ...cue, speaker: i, startMs: cue.startMs + (i ? by : 0), endMs: cue.endMs + (i ? by : 0),
      words: cue.words.map((word) => ({ ...word, startMs: word.startMs + (i ? by : 0), endMs: word.endMs + (i ? by : 0) })),
    }));
    const input = sceneInput(run, { fps: 30, scale: 2, canvas: { width: 1920, height: 1080 }, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } });
    const pieces = comboProgram.build(input).pieces;
    const body = (cue: number) => Math.min(...pieces.flatMap((piece) => (piece.kind === "text" && new RegExp(`^combo:${cue}:w\\d+$`).test(piece.id) && run[cue]!.words[Number(piece.id.split(":w")[1])]!.role !== "hero" ? [piece.sizePx] : [])));
    expect(Math.abs(body(0) - body(1)) / Math.min(body(0), body(1))).toBeLessThan(0.05);
  });
});

describe("Combo caption band", () => {
  const lines = ["it's:m accidentally:b open:b them:h@400", "a:b go:h@300 now:b real:h@300", "all:b of:m them:b are:m unplugged.:h@480", "this:m one:b trick:b doubled:h@560 my:m views:b", "oh:b"];
  const looks = [
    ["9:16", { width: 1080, height: 1920 }, 1], ["16:9", { width: 1920, height: 1080 }, 1], ["2x on 16:9", { width: 1920, height: 1080 }, 2], ["2x on 9:16", { width: 1080, height: 1920 }, 2],
  ] as const;
  for (const [label, canvas, scale] of looks) {
    test(`words and hero copies stay inside the band (${label})`, () => {
      const { cues } = demoCues({ lines, options: { lead: 400, gap: 30, cueGap: 120, tail: 600 } });
      const input = sceneInput(cues, { fps: 30, canvas, scale, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } });
      const pieces = comboProgram.build(input).pieces;
      const anchorY = (1320 / 1920) * canvas.height;
      const grow = Math.max(1, scale);
      const top = Math.max(0.05 * canvas.height + 3, anchorY - (460 / 1920) * canvas.height * grow);
      const bottom = Math.min(0.95 * canvas.height - 3, anchorY + (330 / 1920) * canvas.height * grow);
      for (const piece of pieces) {
        if (!/:w\d+(?:l\d+)?[hk]?$/.test(piece.id)) continue;
        for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
          const box = pieceBounds(piece, t, input.measure);
          if (!box) continue;
          expect(box.y1, `${piece.id} above the band at ${t} (${label})`).toBeGreaterThanOrEqual(top - 1);
          expect(box.y2, `${piece.id} below the band at ${t} (${label})`).toBeLessThanOrEqual(bottom + 1);
        }
      }
    });
  }

  test("a one-row cue is centred on the anchor line, as a normal style is", () => {
    const { cues, input, pieces } = build(["go:b crush:b it:b"]);
    const faces = pieces.filter((piece) => /^combo:0:w\d$/.test(piece.id));
    const t = cues[0]!.words.at(-1)!.endMs - 20;
    const boxes = faces.flatMap((piece) => pieceBounds(piece, t, input.measure) ?? []);
    const middle = (Math.min(...boxes.map((box) => box.y1)) + Math.max(...boxes.map((box) => box.y2))) / 2;
    expect(Math.abs(middle - (1320 / 1920) * 1920)).toBeLessThan(0.1 * 1920 * 0.2);
  });
});

describe("Combo entrances keep clear of their neighbours", () => {
  const lines = ["hey,:b real,:h@300 honest:b", "this:m one:b trick:b doubled:h@560 my:m views:b", "all:b of:m them:b are:m unplugged.:h@480", "这个:b 真的:h@400 很:m 好:b"];
  for (const [label, canvas, scale] of [["9:16", { width: 1080, height: 1920 }, 1], ["2x on 16:9", { width: 1920, height: 1080 }, 2]] as const) {
    test(`no word, nor the colour-split copy of one, ever covers another word (${label})`, () => {
      const { cues } = demoCues({ lines, options: { lead: 400, gap: 30, cueGap: 120, tail: 600 } });
      const input = sceneInput(cues, { fps: 30, canvas, scale, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } });
      const pieces = comboProgram.build(input).pieces;
      for (const cue of cues) {
        const own = pieces.filter((piece) => piece.id.startsWith(`combo:${cue.index}:w`));
        const faces = own.filter((piece) => /^combo:\d+:w\d+(?:l\d+)?$/.test(piece.id));
        const wordOf = (piece: Piece) => Number(/:w(\d+)/.exec(piece.id)![1]);
        for (const t of exportFrameTimes(cue.startMs - 100, cue.endMs, 30)) {
          for (const mine of own) {
            const a = pieceBounds(mine, t, input.measure);
            if (!a) continue;
            for (const other of faces) {
              if (wordOf(other) === wordOf(mine)) continue;
              const b = pieceBounds(other, t, input.measure);
              if (b) expect(overlaps(a, b), `${mine.id} covers ${other.id} at ${t} (${label})`).toBe(false);
            }
          }
        }
      }
    });
  }
});

describe("Combo keeps its beats on fast cues", () => {
  test("16 single-word 70 ms cues with no gap still burst on their key words", () => {
    const lines = Array.from({ length: 16 }, (_, i) => `${i % 2 ? "yes" : "no"}${i % 2 ? ":h" : ":b"}@70`);
    const { cues } = demoCues({ lines, options: { lead: 400, gap: 0, cueGap: 0, tail: 400 } });
    for (const fps of [24, 30, 60]) {
      const pieces = comboProgram.build(sceneInput(cues, { fps, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } })).pieces;
      const shards = new Set(pieces.filter((piece) => /:shard\d+-0$/.test(piece.id)).map((piece) => piece.id.split(":")[1]));
      // A 70 ms window holds one or two frames at 24 and 25 fps depending on its phase; a decoration needs two.
      expect(shards.size, `shards at ${fps} fps`).toBeGreaterThanOrEqual(fps >= 30 ? 6 : 4);
    }
  });
});

describe("Combo stays inside the safe area", () => {
  test("two speakers and a mirrored cue at positionX 20 keep every piece inside the safe area", () => {
    const check = (pieces: readonly Piece[], input: ReturnType<typeof sceneInput>, label: string) => {
      const { canvas } = input;
      const safe = { x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 };
      expect(pieces.length, label).toBeGreaterThan(0);
      for (const piece of pieces) {
        for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
          const box = pieceBounds(piece, t, input.measure);
          if (!box) continue;
          expect(box.x1 >= safe.x1 && box.x2 <= safe.x2 && box.y1 >= safe.y1 && box.y2 <= safe.y2, `${piece.id} at ${t} ${label}: ${JSON.stringify(box)}`).toBe(true);
        }
      }
    };
    const two = demoCues({ lines: ["go:b hard:h@300 now:b real:h@300", "yes:b ok:b"], options: { lead: 333, gap: 0, cueGap: 0, tail: 600 } }).cues;
    const run = two.map((cue, i) => ({ ...cue, speaker: i }));
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      const input = sceneInput(run, { fps: 30, canvas, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } });
      check(comboProgram.build(input).pieces, input, `two speakers ${canvas.width}x${canvas.height}`);
    }
    const urdu = sceneEdgeDemo("urdu").cues;
    for (const xPct of [20, 80]) {
      const input = sceneInput(urdu, { fps: 30, anchor: { xPct, yPct: (1320 / 1920) * 100 } });
      check(comboProgram.build(input).pieces, input, `urdu at positionX ${xPct}`);
    }
  });
});
