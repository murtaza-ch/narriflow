import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { BEAT_DEMO, beatBaseline, beatBlockScale, beatCase, beatHash, beatProgram, beatRng, beatShuffle } from "./templates/beat";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(BEAT_DEMO);
const COLOURS = { primary: "#FFFFFF", highlight: "#5CF542", accent: "#0D0D0D", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) => beatProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1300 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const scene = build(cues);
const ofCue = (list: readonly Piece[], cue: number) => list.filter((piece) => piece.id.split(":")[1] === String(cue));
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};
const scaleOf = (cue: SceneCue, t: number, exitFrom: number, exitDur: number) =>
  beatBlockScale(t, { startMs: cue.startMs, endMs: cue.endMs, hero: cue.words.some((word) => word.role === "hero"), wordStarts: cue.words.map((word) => word.startMs) }, { from: exitFrom, dur: exitDur });

describe("Beat geometry", () => {
  test("rows are the sample's: lead words wrap greedily at 780 px, the key word has its own 150 px row, rows are 0.9 em apart", () => {
    // Cue 0 "talent gets you NOTICED": the fake face is 0.55 em per character, so rows differ from Archivo's; check the structure.
    const word = (id: string) => need<TextPiece>(scene.find((piece) => piece.id === `beat:0:${id}`));
    expect(word("w0").text).toBe("TALENT");
    expect(word("w0").sizePx).toBe(120);
    const letters = scene.filter((piece): piece is TextPiece => piece.kind === "text" && piece.id.startsWith("beat:0:w3l"));
    expect(letters.map((piece) => piece.text).join("")).toBe("NOTICED");
    expect(letters.every((piece) => piece.sizePx <= 150)).toBe(true);
    const a = evaluatePiece(word("w0"), 1000);
    const hero = evaluatePiece(letters[0]!, 1700);
    expect(hero.y).toBeGreaterThan(a.y);
    expect(word("w0").anchor).toBe("baseline-left");
  });

  test("Chrome's baseline of a line-height 1 Archivo Black box: 100 of 120 px and 125 of 150 px", () => {
    expect(beatBaseline(120)).toBe(100);
    expect(beatBaseline(150)).toBe(125);
  });

  test("the block is flush left at x 112 (letter spacing included) and its first word sits on the left edge", () => {
    const first = need<TextPiece>(scene.find((piece) => piece.id === "beat:0:w0"));
    const w = fakeMeasure("TALENT", "Archivo Black", 120, -0.01).advance - 0.01 * 120;
    const pose = evaluatePiece(first, 1500);
    const s = scaleOf(cues[0]!, 1500, 2e9, 110);
    // The pivot is the word's centre; the block scales about its left edge (112), so the word's left edge is 112 + s * 0.
    expect(pose.x - (w / 2) * s).toBeCloseTo(112, 0);
  });
});

describe("Beat motion", () => {
  test("a body word cuts in 40 ms before it is spoken at 1.12x and settles in 90 ms (ease out), times the block's scale", () => {
    const cue = cues[0]!;
    const word = need<TextPiece>(scene.find((piece) => piece.id === "beat:0:w1"));
    const spoken = cue.words[1]!;
    expect(word.fromMs).toBe(spoken.startMs - 40);
    for (const t of [spoken.startMs - 40, spoken.startMs, spoken.startMs + 50, spoken.startMs + 120]) {
      const own = 1.12 + (1 - 1.12) * EASES.out(prog(t, spoken.startMs - 40, 90));
      const pose = evaluatePiece(word, t);
      expect(pose.sx).toBeCloseTo(own * scaleOf(cue, t, cue.endMs - 180, 110), 2);
    }
  });

  test("the block kicks 0.035 per key word and 0.02 per other word, decaying with a 90 ms constant, and is capped", () => {
    const cue = cues[3]!;
    const at = cue.words[0]!.startMs;
    const rest = (t: number) => scaleOf(cue, t, 1e9, 110) - (1 + 0.07 * EASES.out(prog(t, cue.startMs, cue.endMs - cue.startMs)));
    expect(rest(at)).toBeCloseTo(0.035, 6);
    expect(rest(at + 90)).toBeCloseTo(0.035 * Math.exp(-1), 6);
    const crowd = { startMs: 0, endMs: 1000, hero: false, wordStarts: [0, 10, 20, 30, 40, 50] };
    expect(beatBlockScale(50, crowd, { from: 1e9, dur: 100 }) - (1 + 0.04 * EASES.out(0.05))).toBeLessThanOrEqual(0.045 + 1e-9);
  });

  test("the key word's letters cut in hard in a seeded order, 36 ms apart", () => {
    const letters = scene.filter((piece): piece is TextPiece => piece.kind === "text" && piece.id.startsWith("beat:0:w3l"));
    const starts = letters.map((piece) => piece.fromMs);
    expect(new Set(starts).size).toBe(7);
    expect([...starts].sort((x, y) => x - y).map((t, i, all) => (i ? t - all[i - 1]! : 0)).slice(1).every((d) => Math.abs(d - 36) < 1e-6)).toBe(true);
    expect(Math.min(...starts)).toBe(cues[0]!.words[3]!.startMs - 70);
    for (let n = 1; n < 20; n++) expect([...beatShuffle(n, beatRng(n))].sort((x, y) => x - y)).toEqual(Array.from({ length: n }, (_, at) => at));
  });

  test("marks cycle swipe, label, loop over the key-word cues; a cue with no key word has a cursor that hops", () => {
    // Hero cues are 0, 3 and 4 of the demo: swipe, label, loop.
    const kindOf = (cue: number) => {
      const mark = need<ShapePiece>(scene.find((piece) => piece.id === `beat:${cue}:mark`));
      return mark.fill?.colour === COLOURS.primary ? "label" : mark.stroke ? "loop" : "swipe";
    };
    expect([0, 3, 4].map(kindOf)).toEqual(["swipe", "label", "loop"]);
    const cursors = ofCue(scene, 1).filter((piece) => /:cur\d+$/.test(piece.id));
    expect(cursors).toHaveLength(4);
    const xs = cursors.map((piece) => evaluatePiece(piece, piece.fromMs + 300).x);
    expect(new Set(xs.map(Math.round)).size).toBeGreaterThan(1);
    expect(ofCue(scene, 3).some((piece) => /:cur\d+$/.test(piece.id))).toBe(false);
  });

  test("the label bar's words print dark on it; other words are white with a hard drop", () => {
    const bar = scene.filter((piece): piece is TextPiece => piece.kind === "text" && piece.id.startsWith("beat:3:w"));
    expect(bar.every((piece) => piece.fill === "#0D0D0D" && !piece.shadows)).toBe(true);
    const plain = need<TextPiece>(scene.find((piece) => piece.id === "beat:0:w0"));
    expect(plain.fill).toBe("#FFFFFF");
    expect(plain.shadows![0]!.blur).toBe(0);
  });

  test("the seeded helpers are pure", () => {
    expect(beatHash("a")).toBe(beatHash("a"));
    expect(beatHash("a")).not.toBe(beatHash("b"));
    expect(JSON.stringify(build(cues))).toBe(JSON.stringify(build(cues)));
  });
});

describe("Beat real speech and long clips", () => {
  test("fast speech: with 60 ms between cues every word stays visible for 150 ms after it lands", () => {
    const fast = demoCues({ ...BEAT_DEMO, options: { ...BEAT_DEMO.options, cueGap: 60 } }).cues;
    const list = build(fast);
    fast.forEach((cue, number) => {
      cue.words.forEach((word, index) => {
        const mine = list.filter((piece) => new RegExp(`^beat:${number}:w${index}(l\\d+)?$`).test(piece.id));
        expect(mine.length).toBeGreaterThan(0);
        const hero = word.role === "hero";
        const landed = Math.max(...mine.map((piece) => piece.fromMs)) + (hero ? 0 : 90);
        for (let t = landed; t <= landed + 150; t += 10) {
          for (const piece of mine) {
            const pose = evaluatePiece(piece, t);
            expect(pose.visible).toBe(true);
            expect(pose.o).toBeGreaterThan(0.9);
          }
        }
      });
    });
  });

  test("a long clip keeps swipes, labels, loops and cursors coming back, varying", () => {
    const base = demoCues(BEAT_DEMO);
    const long: SceneCue[] = [];
    for (let round = 0; round < 6; round++) {
      for (const cue of base.cues) {
        const shift = round * (base.duration + 200);
        long.push({ ...cue, index: long.length, startMs: cue.startMs + shift, endMs: cue.endMs + shift, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + shift, endMs: word.endMs + shift })) });
      }
    }
    expect(long.length).toBeGreaterThanOrEqual(30);
    const list = build(long);
    const kinds: Record<string, number> = { swipe: 0, label: 0, loop: 0, cursor: 0 };
    const tilts = new Set<number>();
    long.forEach((cue, number) => {
      const mine = ofCue(list, number);
      const mark = mine.find((piece) => piece.id.endsWith(":mark")) as ShapePiece | undefined;
      if (cue.words.some((word) => word.role === "hero")) {
        expect(mark).toBeDefined();
        const kind = mark!.fill?.colour === COLOURS.primary ? "label" : mark!.stroke ? "loop" : "swipe";
        kinds[kind]!++;
        if (kind !== "label") tilts.add(Math.round(evaluatePiece(mark!, mark!.toMs - 5).rz * 10));
      } else {
        expect(mine.some((piece) => /:cur\d+$/.test(piece.id))).toBe(true);
        kinds.cursor!++;
      }
    });
    expect(kinds.swipe).toBeGreaterThanOrEqual(5);
    expect(kinds.label).toBeGreaterThanOrEqual(5);
    expect(kinds.loop).toBeGreaterThanOrEqual(5);
    expect(kinds.cursor).toBeGreaterThanOrEqual(6);
    expect(tilts.size).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(list).includes("NaN")).toBe(false);
  });
});

describe("Beat scripts and edges", () => {
  test("capitals only for cased scripts; an Urdu cue is flush right, runs right to left and keeps the key word whole", () => {
    expect(beatCase("hello")).toBe("HELLO");
    expect(beatCase("اچھا")).toBe("اچھا");
    expect(beatCase("你好")).toBe("你好");
    const urdu = build(sceneEdgeDemo("urdu").cues);
    const first = need<TextPiece>(urdu.find((piece) => piece.id === "beat:0:w0"));
    const second = need<TextPiece>(urdu.find((piece) => piece.id === "beat:0:w1"));
    expect(evaluatePiece(first, 1500).x).toBeGreaterThan(evaluatePiece(second, 1500).x);
    expect(urdu.filter((piece) => piece.kind === "text" && /^beat:0:w2l/.test(piece.id))).toHaveLength(0);
    const box = sceneBoundsAt(urdu, 1500, fakeMeasure);
    expect(box!.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
    expect(box!.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
  });

  test("the nine-words, one-word and long-word demos fit the safe area on 9:16, 1:1 and 16:9 at every time", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const kind of ["one-word", "nine-words", "long-word", "no-hero", "two-speakers"] as const) {
        const edge = sceneEdgeDemo(kind).cues;
        const list = build(edge, { canvas, anchor: { xPct: 50, yPct: (1300 / 1920) * 100 } });
        const end = Math.max(...list.map((piece) => piece.toMs));
        for (let t = 0; t < end; t += 40) {
          const box = sceneBoundsAt(list, t, fakeMeasure);
          if (!box) continue;
          expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
          expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
          expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
          expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
        }
      }
    }
  });
});
