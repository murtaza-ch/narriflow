import { describe, expect, test } from "bun:test";
import { captionColourContrast, captionSceneMeta, getCaptionPresetById } from "@narriflow/validators";
import { describeSpeechConformance, fastRun } from "./conformance-support";
import { SCENE_EDGE_DEMOS, demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import { exportFrameAtOrAfter, exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, SCENE_PIECE_BUDGET, evaluatePiece, pieceBounds } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";
import { LABELS_DEMO, labelsHash, labelsProgram } from "./templates/labels";

describeSpeechConformance("labels", labelsProgram, { anchorLineY: 1290 });

const COLOURS = { primary: "#FFFFFF", highlight: "#FFE600", accent: "#F4E9C3", shadow: "#000000" };
const build = (cues: readonly SceneCue[], overrides = {}) =>
  labelsProgram.build(sceneInput(cues, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const { cues } = demoCues(LABELS_DEMO);
const scene = build(cues);
const ofCue = (pieces: readonly Piece[], cue: number) => pieces.filter((piece) => piece.id.split(":")[1] === String(cue));
const find = (pieces: readonly Piece[], id: string) => pieces.find((piece) => piece.id === id);
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};
const plate = (pieces: readonly Piece[], cue: number, word: number) => need<ShapePiece>(find(pieces, `labels:${cue}:p${word}`));
const face = (pieces: readonly Piece[], cue: number, word: number) => need<TextPiece>(find(pieces, `labels:${cue}:w${word}`));
const REST = 1500;

describe("Labels", () => {
  test("the catalogue row and preset are the sample's", () => {
    const row = captionSceneMeta("labels");
    expect(row).toMatchObject({ bodyPx: 100, anchorLineY: 1290, wordsPerCue: 4, fontName: "Montserrat ExtraBold" });
    expect(getCaptionPresetById("labels")!.preset).toMatchObject({ scene: "labels", fontName: "Montserrat ExtraBold" });
    // The brand colours must read against the label ink, so a dark brand colour is refused for a label.
    for (const slot of [row.brand.primary, row.brand.secondary]) expect(slot?.readsOn).toEqual(["#0C0C10"]);
    expect(captionColourContrast(row.colours.primary, "#0C0C10")).toBeGreaterThan(3);
    expect(captionColourContrast(row.colours.highlight, "#0C0C10")).toBeGreaterThan(3);
  });

  test("a word is its own label: white plates, a yellow key plate, the sample's geometry at rest", () => {
    const u = 1;
    const words = cues[0]!.words;
    for (const [at, word] of words.entries()) {
      const p = plate(scene, 0, at);
      expect(p.fill!.colour).toBe(word.role === "hero" ? COLOURS.highlight : COLOURS.primary);
      const pose = evaluatePiece(p, REST);
      // 1.1 line box plus the sample's padding: 119 px for the body size, 137.4 for the key word.
      const height = word.role === "hero" ? 1.1 * 114 + 12 : 1.1 * 100 + 9;
      expect(pieceBounds(p, REST, fakeMeasure)).not.toBeNull();
      expect(p.origin).toEqual({ dx: expect.any(Number), dy: expect.closeTo(height * u, 1) });
      expect(pose.sx).toBe(1);
      const t = face(scene, 0, at);
      expect(t.text).toBe(word.text);
      expect(t.face).toBe("Montserrat ExtraBold");
      expect(t.letterSpacingEm).toBe(-0.02);
      expect(t.sizePx).toBeCloseTo(word.role === "hero" ? 114 : 100, 5);
    }
    // Four words pile into two rows 118 px apart, the key word's row below, nudged by the sample's offsets.
    const centres = words.map((_, at) => {
      const p = plate(scene, 0, at);
      return evaluatePiece(p, REST).y - p.origin!.dy / 2;
    });
    expect(centres[1]).toBeCloseTo(centres[0]!, 3);
    expect(centres[3]).toBeCloseTo(centres[2]!, 3);
    expect(centres[2]! - centres[0]!).toBeCloseTo(118, 3);
    // The key word lies crooked 5 to 6.2 degrees, alternating sign from key word to key word; the others are straight.
    const tilts = [0, 2, 3, 4].map((cue) => evaluatePiece(plate(scene, cue, cues[cue]!.words.findIndex((w) => w.role === "hero")), cues[cue]!.words.at(-1)!.endMs + 80).rz);
    expect(tilts.map((t) => Math.sign(t))).toEqual([-1, 1, -1, 1]);
    for (const t of tilts) expect(Math.abs(t)).toBeGreaterThan(4.9);
    expect(evaluatePiece(plate(scene, 0, 0), REST).rz).toBeCloseTo(0, 3);
  });

  test("a label flies in on the sample's formula", () => {
    // Cue 0, word 1 ("quit", 502 to 717): first paint 90 ms early, the sample's outExpo slide over 340 ms, spring turn over 420 ms.
    const word = cues[0]!.words[1]!;
    const p = plate(scene, 0, 1);
    const from = word.startMs - 90;
    expect(p.fromMs).toBe(from);
    const rest = evaluatePiece(p, REST);
    // A flight that would leave the safe area keeps a share g of the sample's 340 px, 150 px and 13 degrees.
    const g = Math.abs(evaluatePiece(p, from).x - rest.x) / 340;
    expect(g).toBeGreaterThan(0.3);
    expect(g).toBeLessThanOrEqual(1);
    const side = Math.sign(evaluatePiece(p, from).x - rest.x);
    for (const dt of [0, 40, 100, 200, 340]) {
      const t = from + dt;
      const pose = evaluatePiece(p, t);
      const slide = EASES.outExpo(prog(t, from, 340));
      expect(pose.x - rest.x).toBeCloseTo(side * 340 * g * (1 - slide), 2);
      expect(rest.y - pose.y).toBeCloseTo(150 * g * (1 - slide), 2);
      const settle = EASES.spring(prog(t, from, 420));
      expect(pose.rz).toBeCloseTo(side * 13 * g * (1 - settle), 2);
    }
    // The key word lands bigger and settles.
    const key = plate(scene, 0, 3);
    const keyFrom = cues[0]!.words[3]!.startMs - 90;
    expect(evaluatePiece(key, keyFrom).sx).toBeGreaterThan(1.1);
    expect(evaluatePiece(key, keyFrom).sx).toBeLessThanOrEqual(1.2);
    expect(evaluatePiece(key, keyFrom + 420).sx).toBeCloseTo(1, 5);
    // Opaque within 45 ms of the first frame, so the word reads on its first frames.
    expect(evaluatePiece(p, from).o).toBeGreaterThan(0);
    expect(evaluatePiece(p, from + 45).o).toBe(1);
  });

  test("the text and its plate share one pose", () => {
    for (const t of [412, 480, 640, 900, 1300]) {
      const a = evaluatePiece(plate(scene, 0, 1), t);
      const b = evaluatePiece(face(scene, 0, 1), t);
      expect([b.x, b.y, b.rz, b.sx, b.sy, b.o]).toEqual([a.x, a.y, a.rz, a.sx, a.sy, a.o]);
    }
  });

  test("every spoken word appears exactly once and is never split into letters", () => {
    for (const demo of [LABELS_DEMO, ...SCENE_EDGE_DEMOS.map((kind) => ({ lines: [] as string[], kind }))]) {
      const list = "kind" in demo ? sceneEdgeDemo(demo.kind).cues : cues;
      const pieces = build(list);
      list.forEach((cue, n) => {
        const texts = ofCue(pieces, n).filter((piece): piece is TextPiece => piece.kind === "text");
        expect(texts.map((piece) => piece.text)).toEqual(cue.words.map((word) => word.text));
        expect(ofCue(pieces, n).filter((piece) => piece.id.includes(":p"))).toHaveLength(cue.words.length);
      });
    }
    const emoji = demoCues({ lines: ["🇵🇰:b@900 👩‍💻:b@900"] });
    expect(build(emoji.cues).filter((piece) => piece.kind === "text").map((piece) => (piece as TextPiece).text)).toEqual(["🇵🇰", "👩‍💻"]);
  });

  test("rows come from the words and a long cue piles up instead of running in one strip", () => {
    const rows = (list: readonly SceneCue[], cue: number) => {
      const pieces = build(list);
      return new Set(list[cue]!.words.map((_, at) => {
        const p = plate(pieces, cue, at);
        return Math.round(evaluatePiece(p, list[cue]!.endMs - 300).y - p.origin!.dy / 2);
      }));
    };
    expect(rows(cues, 0).size).toBe(2);
    const nine = sceneEdgeDemo("nine-words").cues;
    expect(rows(nine, 0).size).toBeGreaterThanOrEqual(3);
    expect(rows(sceneEdgeDemo("one-word").cues, 0).size).toBe(1);
  });

  test("right-to-left cues run right to left", () => {
    const urdu = sceneEdgeDemo("urdu").cues;
    const pieces = build(urdu);
    const x = (at: number) => evaluatePiece(plate(pieces, 0, at), urdu[0]!.words[at]!.endMs + 200).x;
    expect(x(0)).toBeGreaterThan(x(1));
  });

  test("a label wider than the safe width shrinks by itself and lands inside the safe area", () => {
    const long = sceneEdgeDemo("long-word").cues;
    const pieces = build(long);
    const word = long[1]!.words[0]!;
    const t = face(pieces, 1, 0);
    expect(t.sizePx).toBeLessThan(100);
    for (const ms of exportFrameTimes(word.startMs - 100, word.endMs + 600, 30)) {
      for (const piece of ofCue(pieces, 1)) {
        const box = pieceBounds(piece, ms, fakeMeasure);
        if (!box) continue;
        expect(box.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
        expect(box.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
      }
    }
  });

  test("a flight that would leave the safe area is scaled back, a narrow one keeps all of it", () => {
    const near = demoCues({ lines: ["wait:b@600"] }).cues;
    const narrow = plate(build(near), 0, 0);
    const start = evaluatePiece(narrow, narrow.fromMs);
    const rest = evaluatePiece(narrow, narrow.fromMs + 2000);
    expect(Math.abs(start.x - rest.x)).toBeGreaterThan(300);
    const wide = demoCues({ lines: ["extraordinarily:h@900"] }).cues;
    const w = plate(build(wide, { scale: 1 }), 0, 0);
    expect(Math.abs(evaluatePiece(w, w.fromMs).x - evaluatePiece(w, w.fromMs + 2000).x)).toBeLessThan(300);
  });

  test("a cue waits for nothing: with no gap its first label paints on its first word and the cue before leaves on that frame", () => {
    for (const fps of [24, 25, 30, 60]) {
      const run = fastRun(0);
      const pieces = build(run, { fps });
      for (const n of [1, 4, 6]) {
        const first = run[n]!.words[0]!;
        const onset = exportFrameAtOrAfter(first.startMs, fps);
        const incoming = ofCue(pieces, n).filter((piece) => pieceBounds(piece, onset, fakeMeasure));
        expect(incoming.length).toBeGreaterThan(0);
        // Nothing of the cue before paints on that frame or later; its last words painted through their spoken end.
        for (const piece of ofCue(pieces, n - 1)) expect(pieceBounds(piece, onset, fakeMeasure)).toBeNull();
        const last = run[n - 1]!.words.at(-1)!;
        const before = face(pieces, n - 1, run[n - 1]!.words.length - 1);
        expect(before.toMs).toBeGreaterThanOrEqual(last.endMs);
      }
    }
  });

  test("the staggered collapse starts 150 ms after the last word with room, is dropped for a cut without it", () => {
    // Room: a long tail.
    const room = demoCues({ lines: ["so:b@200 it:b@200 goes:h@200"], options: { lead: 400, tail: 1500 } }).cues;
    const pieces = build(room);
    const last = room[0]!.words.at(-1)!;
    const words = room[0]!.words.map((_, at) => face(pieces, 0, at));
    // The last word collapses first, the first word last, none before 150 ms after the last spoken end.
    const collapse = words.map((piece) => {
      for (let t = piece.fromMs + 600; t < piece.toMs; t++) if (evaluatePiece(piece, t).sy < 0.999) return t;
      return Number.POSITIVE_INFINITY;
    });
    expect(collapse[2]).toBeGreaterThanOrEqual(last.endMs + 150);
    expect(collapse[0]).toBeGreaterThan(collapse[1]!);
    expect(collapse[1]).toBeGreaterThan(collapse[2]!);
    expect(words[0]!.toMs).toBeLessThanOrEqual(room[0]!.endMs);
    // No room: a cue followed 60 ms later by the next is cut, not collapsed.
    const tight = fastRun(60);
    const cut = build(tight, { fps: 30 });
    const w = face(cut, 0, 4);
    for (let t = w.fromMs + 600; t < w.toMs; t++) expect(evaluatePiece(w, t).sy).toBe(1);
  });

  test("overlapping speakers stack, neither covering the other", () => {
    const { cues: base } = demoCues({ lines: ["first:b@300 late:b@300", "wait:b@300", "what:b@300"], options: { lead: 357, gap: 0, cueGap: 0 } });
    const starts = [357, 887, 1187];
    const run = base.map((cue, i) => {
      const by = starts[i]! - cue.startMs;
      return { ...cue, startMs: cue.startMs + by, endMs: cue.endMs + by, speaker: i % 2, words: cue.words.map((w) => ({ ...w, startMs: w.startMs + by, endMs: w.endMs + by })) };
    });
    const pieces = build(run);
    const y = (cue: number) => evaluatePiece(plate(pieces, cue, 0), run[cue]!.words[0]!.endMs + 100).y;
    // The second speaker's label sits above the first's (or below it), never on it.
    expect(Math.abs(y(1) - y(0))).toBeGreaterThan(100);
  });

  test("the sample's recurring beats come back on every cue of a long clip, varying by counter and hash", () => {
    const run = fastRun(60);
    const long = [...run, ...run.map((cue) => ({ ...cue, index: cue.index + run.length, startMs: cue.startMs + 40000, endMs: cue.endMs + 40000, words: cue.words.map((w) => ({ ...w, startMs: w.startMs + 40000, endMs: w.endMs + 40000 })) }))];
    expect(long.length).toBeGreaterThanOrEqual(24);
    const pieces = build(long);
    const tapes: number[] = [];
    const angles = new Set<number>();
    long.forEach((cue, n) => {
      const group = ofCue(pieces, n);
      const tape = group.find((piece) => piece.id.endsWith(":tape"));
      expect(tape, `cue ${n} tape`).toBeDefined();
      const rays = group.filter((piece) => piece.id.includes(":ray"));
      if (cue.words.some((w) => w.role === "hero")) expect(rays.length, `cue ${n} rays`).toBeGreaterThanOrEqual(1);
      tapes.push(Math.sign(Math.round(evaluatePiece(tape!, tape!.fromMs + 300).rz)));
      angles.add(Math.round(evaluatePiece(tape!, tape!.fromMs + 300).rz));
      expect(group.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0)).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
    });
    // The tape lands on both sides, at several angles.
    expect(new Set(tapes).size).toBe(2);
    expect(angles.size).toBeGreaterThan(4);
    // Deterministic: the same input builds the same scene.
    expect(JSON.stringify(build(long))).toBe(JSON.stringify(pieces));
  });

  test("the tape is pinned on a label's outer corner and its painted box never reaches a word's ink", () => {
    // Real phrasing, 2026-11-25 gallery review: the tilted tape's box met the first word's ink box on most cues.
    const { cues: real } = demoCues({
      lines: ["it's:b time:b to:m say:b goodbye:h@420", "the:m remote:b doesn't:h@360 work.:b", "all:b of:m them:b are:m unplugged.:h@480", "is:m it:m dead?:h@380", "oh.:b"],
      options: { lead: 400, gap: 30, cueGap: 120, tail: 500 },
    });
    const pieces = build(real);
    real.forEach((cue, n) => {
      const tape = need<ShapePiece>(find(pieces, `labels:${n}:tape`));
      const words = ofCue(pieces, n).filter((piece): piece is TextPiece => piece.kind === "text");
      for (const t of exportFrameTimes(cue.startMs, cue.endMs, 30)) {
        const box = pieceBounds(tape, t, fakeMeasure);
        if (!box) continue;
        for (const word of words) {
          const ink = pieceBounds(word, t, fakeMeasure);
          if (!ink) continue;
          const dx = (ink.x2 - ink.x1) * 0.06;
          const dy = (ink.y2 - ink.y1) * 0.18;
          const hit = box.x1 + 0.5 < ink.x2 - dx && ink.x1 + dx < box.x2 - 0.5 && box.y1 + 0.5 < ink.y2 - dy && ink.y1 + dy < box.y2 - 0.5;
          expect(hit, `cue ${n} ${word.text} at ${t}`).toBe(false);
        }
      }
    });
  });

  test("all edge cues and aspect ratios keep every painted frame inside the safe area and the budget", () => {
    for (const kind of SCENE_EDGE_DEMOS) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
        const list = sceneEdgeDemo(kind).cues;
        const pieces = build(list, { canvas });
        list.forEach((cue, n) => {
          const group = ofCue(pieces, n);
          expect(group.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0)).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
          for (const t of exportFrameTimes(cue.startMs - 100, cue.endMs, 30)) {
            for (const piece of group) {
              const box = pieceBounds(piece, t, fakeMeasure);
              if (!box) continue;
              expect(box.x1, `${kind} ${piece.id} ${t}`).toBeGreaterThanOrEqual(canvas.width * 0.05 - 1);
              expect(box.x2, `${kind} ${piece.id} ${t}`).toBeLessThanOrEqual(canvas.width * 0.95 + 1);
              expect(box.y1, `${kind} ${piece.id} ${t}`).toBeGreaterThanOrEqual(canvas.height * 0.05 - 1);
              expect(box.y2, `${kind} ${piece.id} ${t}`).toBeLessThanOrEqual(canvas.height * 0.95 + 1);
            }
          }
        });
      }
    }
  });

  test("the hash is FNV-1a and spreads", () => {
    expect(labelsHash("")).toBe(0x811c9dc5);
    expect(labelsHash("a")).not.toBe(labelsHash("b"));
  });
});
