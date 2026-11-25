import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { evaluatePiece, pieceBounds } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";
import { ANIME_DEMO, animeProgram } from "./templates/anime";

describeSpeechConformance("anime", animeProgram, { anchorLineY: 1275 });

const build = (lines: readonly string[], options = ANIME_DEMO.options, overrides = {}) => {
  const { cues } = demoCues({ lines, options });
  return { cues, pieces: animeProgram.build(sceneInput(cues, { fps: 30, anchor: { xPct: 50, yPct: (1275 / 1920) * 100 }, ...overrides })).pieces };
};
const ofCue = (pieces: ReturnType<typeof build>["pieces"], cue: number, part: string) => pieces.filter((piece) => piece.id.startsWith(`anime:${cue}:${part}`));

describe("anime", () => {
  test("every shape has a fill, whatever the cue's hash is", () => {
    const lines = Array.from({ length: 40 }, (_, at) => `word${at}:b more${at * 7}:b ${at % 3 === 0 ? "hit:h@300" : "tail:m"}`);
    const { pieces } = build(lines);
    for (const piece of pieces) if (piece.kind === "shape") expect(piece.fill?.colour, piece.id).toMatch(/^#[0-9A-F]{6}$/i);
  });

  test("each row has its slab; the words ride one rigid pose with the slab", () => {
    const { cues, pieces } = build(ANIME_DEMO.lines);
    for (const cue of cues) {
      const slabs = ofCue(pieces, cue.index, "slab");
      expect(slabs.length, `cue ${cue.index}`).toBeGreaterThanOrEqual(1);
    }
    // Cue 0 ("this will blow your mind"): three rows, the key word's own slab last.
    expect(ofCue(pieces, 0, "slab").length).toBeGreaterThanOrEqual(2);
  });

  test("the slab opens word by word, and a slab's rows stay inside the safe area at 1.22x jitter", () => {
    const { cues, pieces } = build(ANIME_DEMO.lines);
    const slab = pieces.find((piece) => piece.id === "anime:0:slab0")!;
    const word = cues[0]!.words[0]!;
    const early = pieceBounds(slab, word.startMs, fakeMeasure)!;
    const late = pieceBounds(slab, word.startMs + 400, fakeMeasure)!;
    expect(early.x2 - early.x1).toBeLessThanOrEqual(late.x2 - late.x1 + 1);
    const safe = { x1: 54 - 1, x2: 1026 + 1, y1: 96 - 1, y2: 1824 + 1 };
    for (const piece of pieces) {
      for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 60)) {
        const box = pieceBounds(piece, t, fakeMeasure);
        if (!box) continue;
        expect(box.x1 >= safe.x1 && box.x2 <= safe.x2 && box.y1 >= safe.y1 && box.y2 <= safe.y2, `${piece.id} at ${t}`).toBe(true);
      }
    }
  });

  test("the slab slams in with two hard jittered poses, then settles", () => {
    const { cues, pieces } = build(ANIME_DEMO.lines);
    const slab = pieces.find((piece) => piece.id === "anime:1:slab0")!;
    const start = slab.fromMs;
    const a = evaluatePiece(slab, start + 1);
    const b = evaluatePiece(slab, start + 40);
    const rest = evaluatePiece(slab, cues[1]!.words[0]!.endMs);
    expect(a.sx).toBeGreaterThan(rest.sx + 0.02);
    expect(Math.sign(a.rz - rest.rz)).not.toBe(Math.sign(b.rz - rest.rz));
    expect(Math.abs(rest.sx - 1)).toBeLessThan(0.06);
  });

  test("a row of only small words is hollow; others are filled with a black inline", () => {
    const { pieces } = build(["it's:m time:m", "build:b it:b now:h@500"]);
    const hollow = pieces.find((piece) => piece.id === "anime:0:w0");
    expect(hollow?.kind === "text" && hollow.fillAlpha).toBe(0);
    const filled = pieces.find((piece) => piece.id === "anime:1:w0");
    expect(filled?.kind === "text" && filled.fillAlpha).toBeUndefined();
    expect(filled?.kind === "text" && filled.stroke?.colour).toBe("#0A0E0F");
  });

  test("every cue draws four doodles (six with a key word), impact ticks and sparks, none above a word", () => {
    const { cues, pieces } = build(ANIME_DEMO.lines);
    for (const cue of cues) {
      const hero = cue.words.some((word) => word.role === "hero");
      const stickers = ofCue(pieces, cue.index, "sticker");
      expect(stickers.length, `cue ${cue.index}`).toBeGreaterThanOrEqual(hero ? 4 : 3);
      expect(ofCue(pieces, cue.index, "tick").length).toBeGreaterThanOrEqual(1);
      expect(ofCue(pieces, cue.index, "spark").length).toBeGreaterThanOrEqual(2);
      if (hero) expect(ofCue(pieces, cue.index, "ray").length).toBeGreaterThanOrEqual(10);
      const faces = ofCue(pieces, cue.index, "w");
      const topFace = Math.min(...faces.map((piece) => piece.z));
      for (const piece of [...stickers, ...ofCue(pieces, cue.index, "ray"), ...ofCue(pieces, cue.index, "tick"), ...ofCue(pieces, cue.index, "spark")]) {
        expect(piece.z, piece.id).toBeLessThan(topFace);
      }
    }
  });

  test("doodles that tuck over a slab never touch a word's letters", () => {
    const { pieces } = build(["we:m didn't:h@400 want:b anyone:b", "all:b of:m them:b are:m unplugged.:h@500"]);
    for (const front of pieces.filter((piece) => /:sticker[45]$/.test(piece.id))) {
      const cue = front.id.split(":")[1];
      const words = pieces.filter((piece) => new RegExp(`^anime:${cue}:w\\d+$`).test(piece.id));
      for (const t of exportFrameTimes(front.fromMs, front.toMs, 30)) {
        const box = pieceBounds(front, t, fakeMeasure);
        if (!box) continue;
        for (const word of words) {
          const ink = pieceBounds(word, t, fakeMeasure);
          if (!ink) continue;
          const hit = box.x1 < ink.x2 && ink.x1 < box.x2 && box.y1 < ink.y2 && ink.y1 < box.y2;
          expect(hit, `${front.id} over ${word.id} at ${t}`).toBe(false);
        }
      }
    }
  });

  test("the burst's angle turns from one key word to the next", () => {
    const { pieces } = build(["so:m this:b is:b it:h@400", "now:m that:b was:b it:h@400"]);
    const first = evaluatePiece(pieces.find((piece) => piece.id === "anime:0:ray0")!, 400).rz;
    const second = evaluatePiece(pieces.find((piece) => piece.id === "anime:1:ray0")!, 3000).rz;
    expect(first).not.toBeCloseTo(second, 2);
  });

  test("the exit squashes the slab after the words' hold, and never before the last word is spoken", () => {
    const { cues, pieces } = build(ANIME_DEMO.lines, { ...ANIME_DEMO.options, cueGap: 700 });
    const slab = pieces.find((piece) => piece.id === "anime:0:slab0")!;
    const end = cues[0]!.words.at(-1)!.endMs;
    expect(evaluatePiece(slab, end).sy).toBeGreaterThan(0.9);
    expect(evaluatePiece(slab, slab.toMs - 5).sy).toBeLessThan(0.3);
  });
});
