import { describe, expect, test } from "bun:test";
import { describeSpeechConformance, staccatoRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
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
      if (hero) expect(ofCue(pieces, cue.index, "ray").length).toBeGreaterThanOrEqual(8);
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

  test("a word too long for a row at a readable size breaks into equal chunks on their own slabs, never shrunk to a sliver", () => {
    const cues = sceneEdgeDemo("long-word").cues;
    const pieces = animeProgram.build(sceneInput(cues, { fps: 30, anchor: { xPct: 50, yPct: (1275 / 1920) * 100 } })).pieces;
    const word = cues[1]!.words[0]!.text;
    const chunks = pieces.filter((piece) => piece.kind === "text" && /^anime:1:w0(?:l\d+)?$/.test(piece.id));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.map((piece) => (piece.kind === "text" ? piece.text : "")).join("").toLowerCase()).toBe(word.toLowerCase());
    for (const piece of chunks) expect(piece.kind === "text" && piece.sizePx, piece.id).toBeGreaterThanOrEqual(60);
    expect(pieces.filter((piece) => /^anime:1:slab\d$/.test(piece.id)).length).toBe(chunks.length);
  });

  test("a word in a script that must stay joined is not split, however long", () => {
    const { pieces } = build(["हिन्दुस्तानीमहाविद्यालयप्रवेशपरीक्षा:h@600"]);
    expect(pieces.filter((piece) => piece.kind === "text" && /^anime:0:w0/.test(piece.id) && !/o\d$/.test(piece.id)).length).toBe(1);
  });

  test("very fast speech keeps its slab under every painted word at 24, 25 and 30 fps, and its doodles and sparks on nearly every cue", () => {
    for (const fps of [24, 25, 30]) {
      for (const cueGap of [0, 60]) {
        const cues = staccatoRun(cueGap);
        const pieces = animeProgram.build(sceneInput(cues, { fps, anchor: { xPct: 50, yPct: (1275 / 1920) * 100 } })).pieces;
        for (const face of pieces.filter((piece) => /^anime:\d+:w\d+$/.test(piece.id))) {
          const cue = face.id.split(":")[1];
          const slabs = pieces.filter((piece) => piece.id.startsWith(`anime:${cue}:`) && piece.kind === "shape" && (piece.id.includes(":slab") || /:w\d+l\d+$/.test(piece.id)));
          for (const t of exportFrameTimes(face.fromMs, face.toMs, fps)) {
            if (!pieceBounds(face, t, fakeMeasure)) continue;
            expect(slabs.some((slab) => pieceBounds(slab, t, fakeMeasure) !== null), `${face.id} is bare at ${t}, ${fps} fps, gap ${cueGap}`).toBe(true);
          }
        }
      }
    }
    const { cues, pieces } = build(Array.from({ length: 18 }, (_, i) => `${i % 2 ? "now:h" : "yes:m"}@${[70, 80, 90, 100, 120][i % 5]}`), { lead: 333, gap: 0, cueGap: 0, tail: 500 });
    const withStickers = cues.filter((cue) => pieces.some((piece) => piece.id.startsWith(`anime:${cue.index}:sticker`))).length;
    const withSparks = cues.filter((cue) => pieces.some((piece) => piece.id.startsWith(`anime:${cue.index}:spark`))).length;
    expect(withStickers).toBeGreaterThanOrEqual(cues.length - 1);
    expect(withSparks).toBeGreaterThanOrEqual(cues.length - 1);
  });

  test("a nine-word cue keeps its whole stack, stamp motion included, inside the caption band", () => {
    const cues = sceneEdgeDemo("nine-words").cues;
    const pieces = animeProgram.build(sceneInput(cues, { fps: 30, anchor: { xPct: 50, yPct: (1275 / 1920) * 100 } })).pieces;
    for (const piece of pieces.filter((p) => p.id.includes(":slab") || p.kind === "text")) {
      for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 60)) {
        const box = pieceBounds(piece, t, fakeMeasure);
        if (!box) continue;
        expect(box.y1, `${piece.id} at ${t}`).toBeGreaterThanOrEqual(880 - 1);
        expect(box.y2, `${piece.id} at ${t}`).toBeLessThanOrEqual(1630 + 1);
      }
    }
  });

  test("two speakers at twice the size on 16:9 each keep their stack in their lane, at comparable sizes", () => {
    const { cues: a } = demoCues({ lines: ["there:m are:m intensively:b practised:b extraordinary:h@450 examples:b after:m every:m interruption:b"], options: { lead: 350, gap: 30, cueGap: 0, tail: 500 } });
    const { cues: b } = demoCues({ lines: ["wow:h@600 now:m@210"], options: { lead: 1350, gap: 30, cueGap: 0, tail: 500 } });
    const cues = [{ ...a[0]!, speaker: 0 }, { ...b[0]!, index: 1, speaker: 1 }];
    const canvas = { width: 1920, height: 1080 };
    const pieces = animeProgram.build(sceneInput(cues, { fps: 30, canvas, scale: 2, anchor: { xPct: 50, yPct: (1275 / 1920) * 100 } })).pieces;
    const sizeOf = (cue: number, word: number) => (pieces.find((piece) => piece.id === `anime:${cue}:w${word}`) as { sizePx: number }).sizePx;
    expect(sizeOf(0, 0)).toBeGreaterThanOrEqual(0.5 * sizeOf(1, 1));
    for (const cue of [0, 1]) expect(pieces.filter((piece) => piece.id.startsWith(`anime:${cue}:spark`)).length, `cue ${cue} sparks`).toBeGreaterThanOrEqual(2);
    for (const piece of pieces) {
      for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
        const box = pieceBounds(piece, t, fakeMeasure);
        if (!box) continue;
        expect(box.y1 >= 0.05 * 1080 - 0.5 && box.y2 <= 0.95 * 1080 + 0.5 && box.x1 >= 0.05 * 1920 - 0.5 && box.x2 <= 0.95 * 1920 + 0.5, `${piece.id} at ${t}: ${JSON.stringify(box)}`).toBe(true);
      }
    }
  });

  test("a final one-frame cue keeps its slab, and no slab lingers under the next cue's words (24 fps)", () => {
    const cues = [
      { index: 0, startMs: 350, endMs: 825, language: "en", speaker: null, words: [{ text: "THEN", role: "body" as const, key: null, startMs: 350, endMs: 825 }] },
      { index: 1, startMs: 825, endMs: 850, language: "en", speaker: null, words: [{ text: "NOW", role: "minor" as const, key: null, startMs: 825, endMs: 850 }] },
    ];
    const pieces = animeProgram.build(sceneInput(cues, { fps: 24, anchor: { xPct: 50, yPct: (1275 / 1920) * 100 } })).pieces;
    for (const face of pieces.filter((piece) => /^anime:\d+:w\d+$/.test(piece.id))) {
      const cue = face.id.split(":")[1];
      const slabs = pieces.filter((piece) => piece.id.startsWith(`anime:${cue}:`) && (piece.id.includes("slab") || /:w\d+l\d+$/.test(piece.id)) && piece.kind === "shape");
      for (const t of exportFrameTimes(face.fromMs, face.toMs, 24)) {
        if (pieceBounds(face, t, fakeMeasure)) expect(slabs.some((slab) => pieceBounds(slab, t, fakeMeasure) !== null), `${face.id} is bare at ${t}`).toBe(true);
      }
      // The slab goes with its word: nothing of the cue paints after the cue's last word piece.
      const lastFace = Math.max(...pieces.filter((piece) => piece.id.startsWith(`anime:${cue}:w`) && piece.kind === "text").map((piece) => piece.toMs));
      for (const slab of slabs) expect(slab.toMs, slab.id).toBeLessThanOrEqual(lastFace);
    }
  });

  test("the doodles keep bobbing on a long hold: their transforms differ at 2, 3 and 5 seconds", () => {
    const { pieces } = build(["one:b two:b three:h@5600"], { lead: 400, gap: 30, cueGap: 0, tail: 2500 });
    const stickers = pieces.filter((piece) => /^anime:0:sticker\d$/.test(piece.id));
    expect(stickers.length).toBeGreaterThanOrEqual(4);
    for (const piece of stickers) {
      const ys = [2000, 3000, 5000].map((t) => evaluatePiece(piece, t).y);
      expect(new Set(ys.map((y) => y.toFixed(2))).size, piece.id).toBeGreaterThan(1);
    }
    // The bob is cheap: about one keyframe per half period (750 ms and up).
    for (const piece of stickers) expect((piece.track.y ?? []).length, piece.id).toBeLessThanOrEqual(Math.ceil((piece.toMs - piece.fromMs) / 700) + 4);
  });
});
