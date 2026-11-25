import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { describeSpeechConformance } from "./conformance-support";
import { comboProgram } from "./templates/combo";
import { evaluatePiece, pieceBounds } from "./scene";
import { sceneInput } from "./test-support";

describeSpeechConformance("combo", comboProgram, { anchorLineY: 1320 });

const build = (lines: string[], options = { lead: 400, gap: 30, cueGap: 120, tail: 600 }) => {
  const { cues } = demoCues({ lines, options });
  const input = sceneInput(cues, { fps: 30, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } });
  return { cues, input, pieces: comboProgram.build(input).pieces };
};

const counterAt = (pieces: ReturnType<typeof build>["pieces"], t: number) =>
  pieces.flatMap((piece) => (piece.kind === "text" && /:count\d+$/.test(piece.id) && evaluatePiece(piece, t).visible && evaluatePiece(piece, t).o > 0.01 ? [piece.text] : []));

describe("Combo counter", () => {
  test("counts every word of a run across cues and restarts after a pause of 500 ms", () => {
    const { cues, pieces } = build(["a:b b:b c:b", "d:b e:b", "f:b+700 g:b"]);
    const all = cues.flatMap((cue) => cue.words);
    // Words 0..4 are one run; the pause before "f" starts a new run.
    for (const [i, word] of all.entries()) {
      const t = word.startMs + 90;
      const expected = i < 5 ? i + 1 : i - 4;
      expect(counterAt(pieces, t), `after ${word.text}`).toEqual([`×${expected}`]);
    }
  });

  test("never holds two counts at once and never stays after a break", () => {
    const { cues, input, pieces } = build(["go:b crush:b it:b", "now:b+900 stop:b"]);
    const end = cues.at(-1)!.endMs;
    for (const t of exportFrameTimes(0, end, 30)) expect(counterAt(pieces, t).length).toBeLessThanOrEqual(1);
    const last = cues[0]!.words.at(-1)!;
    expect(counterAt(pieces, last.endMs + 400)).toEqual([]);
    expect(input.cues.length).toBe(2);
  });

  test("a run that goes on across a cue boundary keeps its counter solid at the handoff", () => {
    const { cues, pieces } = build(["one:b two:b three:b", "four:b five:b"], { lead: 400, gap: 0, cueGap: 0, tail: 600 });
    const boundary = cues[1]!.words[0]!.startMs;
    for (const t of exportFrameTimes(boundary - 120, boundary + 120, 30)) {
      const counts = pieces.flatMap((piece) => (piece.kind === "text" && /:count\d+$/.test(piece.id) ? [{ piece, o: evaluatePiece(piece, t) }] : []))
        .filter(({ o }) => o.visible);
      expect(counts.length, `counter at ${t}`).toBe(1);
      expect(counts[0]!.o.o).toBe(1);
    }
  });

  test("turns hot at ten words", () => {
    const { pieces } = build([Array.from({ length: 12 }, (_, i) => `w${i}:b`).join(" ")]);
    const counts = pieces.filter((piece) => piece.kind === "text" && /:count\d+$/.test(piece.id));
    expect(counts.some((piece) => piece.kind === "text" && piece.text === "×10" && piece.fill === "#FF2E88")).toBe(true);
    expect(counts.some((piece) => piece.kind === "text" && piece.text === "×9" && piece.fill !== "#FF2E88")).toBe(true);
  });

  test("keeps clear of every word of its cue on every painted frame", () => {
    const { cues, input, pieces } = build(["this:m one:b trick:b doubled:h@560 my:m views:b", "in:m just:b ten:b days:b", "your:m turn:h@520"]);
    for (const cue of cues) {
      const faces = pieces.filter((piece) => new RegExp(`^combo:${cue.index}:w\\d+$`).test(piece.id));
      const counts = pieces.filter((piece) => new RegExp(`^combo:${cue.index}:count`).test(piece.id));
      for (const t of exportFrameTimes(cue.startMs, cue.endMs, 30)) {
        for (const count of counts) {
          const a = pieceBounds(count, t, input.measure);
          if (!a) continue;
          for (const face of faces) {
            const b = pieceBounds(face, t, input.measure);
            if (!b) continue;
            // The ink drop shadow and the pop may graze the first row; they never sit on a word.
            const hit = a.x1 + 2 < b.x2 && b.x1 + 2 < a.x2 && a.y1 + 2 < b.y2 - (b.y2 - b.y1) * 0.18 && b.y1 + (b.y2 - b.y1) * 0.18 < a.y2 - 2;
            expect(hit, `${count.id} over ${face.id} at ${t}`).toBe(false);
          }
        }
      }
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
});

describe("Combo block", () => {
  test("a long key word keeps the body words at the sample ratio instead of shrinking them", () => {
    const { pieces } = build(["we:b need:b incomprehensibility:h@600"]);
    const size = (id: string) => (pieces.find((piece) => piece.id === id) as { sizePx: number }).sizePx;
    expect(size("combo:0:w2")).toBeLessThan(130);
    expect(size("combo:0:w0")).toBeGreaterThan(70);
  });

  test("the XP bar has one segment per word and its last segment fills when the last word is said", () => {
    const { cues, pieces } = build(["a:b b:b c:b d:b"]);
    expect(pieces.filter((piece) => /^combo:0:seg\d$/.test(piece.id)).length).toBe(4);
    const fills = pieces.filter((piece) => /^combo:0:fill\d$/.test(piece.id));
    expect(fills.length).toBe(4);
    const last = cues[0]!.words[3]!;
    expect(fills[3]!.fromMs).toBeLessThanOrEqual(last.startMs);
    expect(fills[3]!.fromMs).toBeGreaterThan(last.startMs - 100);
    expect(pieces.some((piece) => piece.id === "combo:0:shine")).toBe(true);
  });
});
