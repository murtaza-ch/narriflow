import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { describeSpeechConformance, fastRun, staccatoRun } from "./conformance-support";
import { comboProgram } from "./templates/combo";
import { type Box, type Piece, type TextPiece, evaluatePiece, pieceBounds } from "./scene";
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

const overlaps = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;

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

describe("Combo counter stays put and stays small", () => {
  test("it does not jump between the cues of a run, whatever the height of their blocks", () => {
    const { cues, input, pieces } = build(["this:m one:b trick:b doubled:h@560 my:m views:b", "in:b just:b", "all:b of:m them:b are:m unplugged:h@480"], { lead: 400, gap: 0, cueGap: 0, tail: 600 });
    const centre = (t: number) => pieces.flatMap((piece) => {
      if (piece.kind !== "text" || !/:count\d+$/.test(piece.id)) return [];
      const pose = evaluatePiece(piece, t);
      return pose.visible && pose.o > 0.99 ? [pose.y] : [];
    });
    let last: number | undefined;
    for (const t of exportFrameTimes(cues[0]!.words[0]!.startMs, cues.at(-1)!.words.at(-1)!.endMs, 30)) {
      const ys = centre(t);
      expect(ys.length, `counter at ${t}`).toBe(1);
      if (last !== undefined) expect(Math.abs(ys[0]! - last), `counter moves ${Math.abs(ys[0]! - last)} px at ${t}`).toBeLessThan(25);
      last = ys[0];
    }
    expect(input.cues.length).toBe(3);
  });

  test("the badge keeps one slot for the whole run and the block moves down for it, never the other way round", () => {
    const { cues, input, pieces } = build(["go:b hard:h@300 now:b real:h@300", "then:b stop:b", "all:b of:m them:b are:m unplugged:h@480"], { lead: 400, gap: 0, cueGap: 0, tail: 600 });
    const counts = pieces.filter((piece): piece is TextPiece => piece.kind === "text" && /:count\d+$/.test(piece.id));
    expect(new Set(counts.map((piece) => piece.track.x?.[0]?.[1])).size).toBe(1);
    const ys = counts.map((piece) => evaluatePiece(piece, piece.fromMs).y - piece.origin!.dy);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1);
    // The tallest block starts under the badge.
    const slot = Math.max(...counts.map((piece) => pieceBounds(piece, piece.fromMs + 200, input.measure)?.y2 ?? 0));
    for (const cue of cues) {
      const top = Math.min(...pieces.filter((piece) => new RegExp(`^combo:${cue.index}:w\\d+$`).test(piece.id)).map((piece) => pieceBounds(piece, cue.endMs - 200, input.measure)?.y1 ?? Number.POSITIVE_INFINITY));
      expect(top, `cue ${cue.index} block top`).toBeGreaterThan(slot - 8);
    }
  });

  test("a sentence end restarts the count", () => {
    const { cues, pieces } = build(["so:b it:b works.:b", "now:b try:b it:b"], { lead: 400, gap: 0, cueGap: 0, tail: 600 });
    const all = cues.flatMap((cue) => cue.words);
    const expected = [1, 2, 3, 1, 2, 3];
    for (const [i, word] of all.entries()) expect(counterAt(pieces, word.startMs + 90), all[i]!.text).toEqual([`×${expected[i]}`]);
  });

  test("it never shows more than x99 and a wide count is set no wider than a single digit's cap", () => {
    const { pieces } = build(Array.from({ length: 22 }, (_, c) => Array.from({ length: 5 }, (_, i) => `w${c * 5 + i}:b@60`).join(" ")));
    const counts = pieces.filter((piece): piece is TextPiece => piece.kind === "text" && /:count\d+$/.test(piece.id));
    expect(counts.some((piece) => piece.text === "×99")).toBe(true);
    expect(counts.some((piece) => piece.text === "×100" || piece.text === "×101")).toBe(false);
    const wide = counts.find((piece) => piece.text === "×99")!;
    const one = counts.find((piece) => piece.text === "×1" || piece.text === "×2")!;
    expect(wide.sizePx).toBeLessThan(one.sizePx);
  });
});

describe("Combo keeps its beats on fast cues", () => {
  test("16 single-word 70 ms cues with no gap still paint the XP shine, and key words still burst", () => {
    const lines = Array.from({ length: 16 }, (_, i) => `${i % 2 ? "yes" : "no"}${i % 2 ? ":h" : ":b"}@70`);
    const { cues } = demoCues({ lines, options: { lead: 400, gap: 0, cueGap: 0, tail: 400 } });
    for (const fps of [24, 30, 60]) {
      const input = sceneInput(cues, { fps, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } });
      const pieces = comboProgram.build(input).pieces;
      const shine = new Set(pieces.filter((piece) => piece.id.endsWith(":shine")).map((piece) => piece.id.split(":")[1]));
      const shards = new Set(pieces.filter((piece) => /:shard\d+-0$/.test(piece.id)).map((piece) => piece.id.split(":")[1]));
      // A 70 ms window holds one or two frames at 24 and 25 fps depending on its phase; a decoration needs two.
      expect(shine.size, `shine at ${fps} fps`).toBeGreaterThanOrEqual(fps >= 30 ? 14 : 10);
      expect(shards.size, `shards at ${fps} fps`).toBeGreaterThanOrEqual(fps >= 30 ? 6 : 4);
    }
  });
});

describe("Combo review re-check", () => {
  test("the badge keeps one place whatever a cue's fit does to its block", () => {
    const { pieces } = build(["so:m it:b is:b", "pneumonoultramicroscopicsilicovolcanoconiosis:h@600", "and:b then:b", "accidentally:b open:b them:b"], { lead: 400, gap: 0, cueGap: 0, tail: 600 });
    const counts = pieces.filter((piece): piece is TextPiece => piece.kind === "text" && /:count\d+$/.test(piece.id));
    expect(counts.length).toBeGreaterThan(6);
    expect(new Set(counts.map((piece) => Math.round(piece.track.x![0]![1]))).size).toBe(1);
    expect(new Set(counts.map((piece) => Math.round(evaluatePiece(piece, piece.fromMs).y - piece.origin!.dy))).size).toBe(1);
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
    const run = cues.map((cue, i) => ({ ...cue, speaker: i, startMs: cue.startMs + (i ? 500 - cues[1]!.startMs + cues[0]!.startMs : 0), endMs: cue.endMs + (i ? 500 - cues[1]!.startMs + cues[0]!.startMs : 0), words: cue.words.map((word) => ({ ...word, startMs: word.startMs + (i ? 500 - cues[1]!.startMs + cues[0]!.startMs : 0), endMs: word.endMs + (i ? 500 - cues[1]!.startMs + cues[0]!.startMs : 0) })) }));
    const input = sceneInput(run, { fps: 30, scale: 2, canvas: { width: 1920, height: 1080 }, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } });
    const pieces = comboProgram.build(input).pieces;
    const body = (cue: number) => Math.min(...pieces.flatMap((piece) => (piece.kind === "text" && new RegExp(`^combo:${cue}:w\\d+$`).test(piece.id) && run[cue]!.words[Number(piece.id.split(":w")[1])]!.role !== "hero" ? [piece.sizePx] : [])));
    expect(Math.abs(body(0) - body(1)) / Math.min(body(0), body(1))).toBeLessThan(0.05);
  });
});

describe("Combo badge slot inside the band", () => {
  const lines = ["it's:m accidentally:b open:b them:h@400", "a:b go:h@300 now:b real:h@300", "all:b of:m them:b are:m unplugged.:h@480", "this:m one:b trick:b doubled:h@560 my:m views:b"];
  const looks = [
    ["9:16", { width: 1080, height: 1920 }, 1], ["16:9", { width: 1920, height: 1080 }, 1], ["2x on 16:9", { width: 1920, height: 1080 }, 2], ["2x on 9:16", { width: 1080, height: 1920 }, 2],
  ] as const;
  for (const [label, canvas, scale] of looks) {
    test(`words, hero copies and the XP bar stay under the badge and inside the band (${label})`, () => {
      const { cues } = demoCues({ lines, options: { lead: 400, gap: 30, cueGap: 120, tail: 600 } });
      const input = sceneInput(cues, { fps: 30, canvas, scale, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } });
      const pieces = comboProgram.build(input).pieces;
      const anchorY = (1320 / 1920) * canvas.height;
      const bandBottom = Math.min(0.95 * canvas.height - 3, anchorY + (330 / 1920) * canvas.height * Math.max(1, scale));
      for (const cue of cues) {
        const badges = pieces.filter((piece) => piece.id.startsWith(`combo:${cue.index}:count`));
        const block = pieces.filter((piece) => piece.id.startsWith(`combo:${cue.index}:`) && /:(w\d+(?:l\d+)?[hk]?|seg\d+|fill\d+)$/.test(piece.id));
        for (const t of exportFrameTimes(cue.startMs - 100, cue.endMs, 30)) {
          const lowestBadge = Math.max(0, ...badges.map((piece) => pieceBounds(piece, t, input.measure)?.y2 ?? 0));
          for (const piece of block) {
            const box = pieceBounds(piece, t, input.measure);
            if (!box) continue;
            expect(box.y2, `${piece.id} below the band at ${t} (${label})`).toBeLessThanOrEqual(bandBottom + 1);
            if (/:w\d+(?:l\d+)?$/.test(piece.id) && lowestBadge > 0) {
              const badge = badges.flatMap((candidate) => pieceBounds(candidate, t, input.measure) ?? []);
              for (const b of badge) {
                const hit = box.x1 + 1 < b.x2 && b.x1 + 1 < box.x2 && box.y1 + 1 < b.y2 && b.y1 + 1 < box.y2;
                expect(hit, `${piece.id} in the badge at ${t} (${label})`).toBe(false);
              }
            }
          }
        }
      }
    });
  }

  test("a run's badge ends on the frame the next run's badge starts, with no double badge", () => {
    // en-waveform 14,190-15,750 ms (Sol's repro): "Just tear it down." then "Who cares?" 40 ms later, the reading hold of the first cue free to run on.
    const word = (text: string, startMs: number, endMs: number, role: "hero" | "body" | "minor") => ({ text, startMs, endMs, role, key: null });
    const cues = [
      { index: 0, startMs: 14190, endMs: 15250, speaker: 4, language: "en", words: [word("Just", 14190, 14470, "body"), word("tear", 14470, 14710, "body"), word("it", 14710, 14870, "minor"), word("down.", 14870, 15210, "minor")] },
      { index: 1, startMs: 15250, endMs: 15750, speaker: 4, language: "en", words: [word("Who", 15250, 15430, "minor"), word("cares?", 15430, 15710, "hero")] },
    ];
    for (const fps of [24, 25, 30, 60]) {
      const input = sceneInput(cues, { fps, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } });
      const pieces = comboProgram.build(input).pieces;
      for (const t of exportFrameTimes(14190, 15750, fps)) {
        const shown = pieces.filter((piece) => piece.kind === "text" && /:count\d+$/.test(piece.id) && evaluatePiece(piece, t).visible && evaluatePiece(piece, t).o > 0.02);
        expect(shown.length, `two badges at ${t} (${fps} fps)`).toBeLessThanOrEqual(1);
      }
    }
  });

  test("never two badges at once on a long fast run, at any frame rate", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const cues of [fastRun(0), fastRun(60), staccatoRun(0), staccatoRun(60)]) {
        const pieces = comboProgram.build(sceneInput(cues, { fps, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } })).pieces;
        for (const t of exportFrameTimes(cues[0]!.startMs, cues.at(-1)!.endMs, fps)) {
          const shown = pieces.filter((piece) => piece.kind === "text" && /:count\d+$/.test(piece.id) && evaluatePiece(piece, t).visible && evaluatePiece(piece, t).o > 0.02);
          expect(shown.length, `two badges at ${t} (${fps} fps)`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("the badge is inside the safe area on every painted frame, for two speakers and for a mirrored cue at positionX 20", () => {
    const check = (pieces: readonly Piece[], input: ReturnType<typeof sceneInput>, label: string) => {
      const { canvas } = input;
      const safe = { x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 };
      const badges = pieces.filter((piece) => /:(count|pulse)\d+$/.test(piece.id));
      expect(badges.length, label).toBeGreaterThan(0);
      for (const piece of badges) {
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
