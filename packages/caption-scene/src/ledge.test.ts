import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { pathBounds } from "./shapes";
import { LEDGE_DEMO, ledgeBarWidth, ledgeBaseline, ledgeCase, ledgeHash, ledgeProgram, ledgeRng, ledgeShuffle } from "./templates/ledge";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(LEDGE_DEMO);
const COLOURS = { primary: "#FFFFFF", highlight: "#FFE600", accent: "#FFFFFF", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) => ledgeProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const scene = build(cues);
const find = (list: readonly Piece[], id: string) => list.find((piece) => piece.id === `ledge:${id}`);
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};
const ofCue = (list: readonly Piece[], cue: number) => list.filter((piece) => piece.id.split(":")[1] === String(cue));
const kindOf = (piece: Piece) => piece.id.split(":")[2]!;
const stretch = (list: readonly SceneCue[], rounds: number, gap = 200): SceneCue[] => {
  const base = demoCues({ ...LEDGE_DEMO, options: { ...LEDGE_DEMO.options } });
  const long: SceneCue[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const cue of list) {
      const shift = round * (base.duration + gap);
      long.push({ ...cue, index: long.length, startMs: cue.startMs + shift, endMs: cue.endMs + shift, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + shift, endMs: word.endMs + shift })) });
    }
  }
  return long;
};

describe("Ledge geometry", () => {
  test("a body bar is the sample's: 112 tall, a 5 px keyline, a 19 px depth face leaning 15 px, padded 30 px with words 0.22 em apart", () => {
    // Cue 0 "okay real talk": three four-letter words at 80 px; the fake face is 0.55 em per character plus 0.012 em of spacing.
    const box = 4 * (0.55 + 0.012) * 80;
    const full = 2 * 30 + 3 * box + 2 * 0.22 * 80;
    const faceInk = need<ShapePiece>(find(scene, "0:b0fi"));
    const faceFill = need<ShapePiece>(find(scene, "0:b0ff"));
    const depthInk = need<ShapePiece>(find(scene, "0:b0di"));
    const depthFill = need<ShapePiece>(find(scene, "0:b0df"));
    const cap = need<ShapePiece>(find(scene, "0:b0cl"));
    expect(pathBounds(faceInk.path).x2).toBeCloseTo(full, 0);
    expect(pathBounds(faceInk.path).y2).toBeCloseTo(112, 3);
    expect(pathBounds(faceFill.path).y2 - pathBounds(faceFill.path).y1).toBeCloseTo(112 - 10, 3);
    expect(pathBounds(depthInk.path).x2).toBeCloseTo(full - 15, 0);
    expect(pathBounds(depthInk.path).y2).toBeCloseTo(19, 3);
    expect(pathBounds(depthFill.path).y2).toBeCloseTo(14, 3);
    expect(pathBounds(cap.path).x2 - pathBounds(cap.path).x1).toBeCloseTo(15, 3);
    expect(cap.stroke?.widthPx).toBe(5);
    expect(faceFill.fill?.colour).toBe(COLOURS.primary);
    expect(depthFill.fill?.colour).toBe(COLOURS.highlight);
    expect(faceInk.fill?.colour).toBe("#111111");
  });

  test("a key word's bar is 138 tall with a 104 px word, a yellow face and a white depth face; it is stacked under the bar before it", () => {
    const heroFace = need<ShapePiece>(find(scene, "1:b1ff"));
    const heroDepth = need<ShapePiece>(find(scene, "1:b1df"));
    expect(heroFace.fill?.colour).toBe(COLOURS.highlight);
    expect(heroDepth.fill?.colour).toBe(COLOURS.primary);
    expect(pathBounds(need<ShapePiece>(find(scene, "1:b1fi")).path).y2).toBeCloseTo(138, 3);
    const word = need<TextPiece>(find(scene, "1:w3"));
    expect(word.text).toBe("JOB");
    expect(word.sizePx).toBe(104);
    expect(need<TextPiece>(find(scene, "1:w0")).sizePx).toBe(80);
    // The key word's bar sits below the first bar (y grows downwards on the canvas).
    expect(evaluatePiece(need(find(scene, "1:b1fi")), 3000).y).toBeGreaterThan(evaluatePiece(need(find(scene, "1:b0fi")), 3000).y + 100);
  });

  test("Chrome's baseline of a line-height 1 Anton box: 74 of 80 px and 96 of 104 px", () => {
    expect(ledgeBaseline(80)).toBe(74);
    expect(ledgeBaseline(104)).toBe(96);
  });

  test("the first cue turns -9 degrees (a seeded wobble of under 1), the next ones cycle the turn and the side of the step", () => {
    const turns = [0, 1, 2, 3, 4].map((cue) => evaluatePiece(need(find(scene, `${cue}:b0fi`)), cues[cue]!.startMs + 600).rz);
    expect(Math.abs(turns[0]! + 9)).toBeLessThan(0.8);
    expect(Math.abs(turns[1]! + 7.2)).toBeLessThan(0.8);
    expect(Math.abs(turns[2]! + 10.4)).toBeLessThan(0.8);
    expect(Math.abs(turns[3]! + 8.2)).toBeLessThan(0.8);
    // Cue 1 steps one way, cue 2 the other.
    const step = (cue: number) => evaluatePiece(need(find(scene, `${cue}:b1fi`)), cues[cue]!.startMs + 1500).x - evaluatePiece(need(find(scene, `${cue}:b0fi`)), cues[cue]!.startMs + 1500).x;
    expect(Math.sign(step(1))).not.toBe(Math.sign(step(2)));
  });
});

describe("Ledge motion", () => {
  test("a bar's width is the sample's: each word pulls the edge to its reach with an outBack of 1.25, in 230 ms from 85 ms before the word", () => {
    const items = [{ startMs: 1000, reach: 200 }, { startMs: 1400, reach: 380 }];
    const back = (p: number) => 1 + 2.25 * (p - 1) ** 3 + 1.25 * (p - 1) ** 2;
    expect(ledgeBarWidth(900, items)).toBe(0);
    expect(ledgeBarWidth(916, items)).toBeCloseTo(14 + (200 - 14) * back(1 / 230), 6);
    expect(ledgeBarWidth(1030, items)).toBeCloseTo(14 + (200 - 14) * back(prog(1030, 915, 230)), 6);
    expect(ledgeBarWidth(1200, items)).toBe(200);
    expect(ledgeBarWidth(1500, items)).toBeCloseTo(200 + (380 - 200) * back(prog(1500, 1315, 230)), 6);
    expect(ledgeBarWidth(2000, items)).toBe(380);
  });

  test("the body and the depth face scale along the bar with its width; the leading cap rides its end", () => {
    const face = need<ShapePiece>(find(scene, "0:b0ff"));
    const cap = need<ShapePiece>(find(scene, "0:b0cr"));
    const start = cues[0]!.words[0]!.startMs;
    const rest = evaluatePiece(face, 3000);
    expect(rest.sx).toBeCloseTo(1, 3);
    const mid = evaluatePiece(face, start + 40);
    expect(mid.sx).toBeLessThan(0.6);
    const early = evaluatePiece(cap, start + 40);
    const late = evaluatePiece(cap, 1000);
    expect(Math.hypot(late.x - early.x, late.y - early.y)).toBeGreaterThan(100);
  });

  test("a key word's bar drops 70 px along its own axis on a spring and settles", () => {
    const face = need<ShapePiece>(find(scene, "1:b1ff"));
    const first = cues[1]!.words[3]!.startMs - 85;
    const rest = evaluatePiece(face, first + 560);
    const early = evaluatePiece(face, first + 1);
    expect(Math.hypot(early.x - rest.x, early.y - rest.y)).toBeGreaterThan(60);
    expect(Math.hypot(early.x - rest.x, early.y - rest.y)).toBeLessThan(75);
    const settled = evaluatePiece(face, first + 380);
    expect(Math.hypot(settled.x - rest.x, settled.y - rest.y)).toBeLessThan(1.5);
    expect(EASES.spring(1)).toBe(1);
  });

  test("the cube sticker bounces onto the key word's corner 160 ms after it starts, spinning in; it goes heart, bolt, star over the key-word cues", () => {
    const heart = need<ShapePiece>(find(scene, "1:stk1"));
    const hero = cues[1]!.words[3]!;
    expect(heart.fromMs).toBeGreaterThanOrEqual(hero.startMs + 160);
    expect(heart.fromMs).toBeLessThanOrEqual(hero.startMs + 180);
    const spun = evaluatePiece(heart, heart.fromMs + 10);
    const rested = evaluatePiece(heart, heart.fromMs + 700);
    expect(Math.abs(spun.rz - rested.rz)).toBeGreaterThan(10);
    expect(spun.sx).toBeLessThan(0.5);
    expect(rested.sx).toBeCloseTo(1, 2);
    const icons = [1, 2, 4].map((cue) => String(need<ShapePiece>(find(scene, `${cue}:stk2`)).path.length));
    expect(new Set(icons).size).toBe(3);
    expect(need<ShapePiece>(find(scene, "1:stk2")).fill?.colour).toBe("#F0323C");
  });

  test("a cue without a key word gets a smaller cube on its last bar, ticks, dashes and popcorn too", () => {
    const mini = need<ShapePiece>(find(scene, "3:stk1"));
    const big = need<ShapePiece>(find(scene, "1:stk1"));
    expect(pathBounds(big.path).x2).toBeCloseTo(70, 1);
    expect(pathBounds(mini.path).x2).toBeCloseTo(70 * 0.62, 1);
    expect(evaluatePiece(mini, mini.fromMs + 700).sx).toBeCloseTo(1, 2);
    const ids = ofCue(scene, 3).map(kindOf);
    expect(ids.filter((id) => /^tk\d$/.test(id))).toHaveLength(3);
    expect(ids.filter((id) => /^pc\d[df]$/.test(id))).toHaveLength(4);
    expect(ids.filter((id) => /^ds\d$/.test(id)).length).toBeGreaterThanOrEqual(1);
  });

  test("the seeded helpers are pure: a shuffle is a permutation, the hash is stable, a build is deterministic", () => {
    expect(ledgeShuffle(8, ledgeRng(3))).toEqual(ledgeShuffle(8, ledgeRng(3)));
    expect([...ledgeShuffle(8, ledgeRng(3))].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(ledgeHash("0|a b")).toBe(ledgeHash("0|a b"));
    expect(ledgeHash("0|a b")).not.toBe(ledgeHash("1|a b"));
    expect(JSON.stringify(build(cues))).toBe(JSON.stringify(build(cues)));
  });
});

describe("Ledge real speech and long clips", () => {
  test("fast speech: with 60 ms between cues every word stays visible, uncovered and opaque for 150 ms after it lands", () => {
    const fast = demoCues({ ...LEDGE_DEMO, options: { ...LEDGE_DEMO.options, cueGap: 60 } }).cues;
    const list = build(fast);
    fast.forEach((cue, number) => {
      cue.words.forEach((word, index) => {
        const piece = need<TextPiece>(find(list, `${number}:w${index}`));
        const hero = word.role === "hero";
        const landed = word.startMs - 85 + 230 + (hero ? 70 : 0);
        const advance = fakeMeasure(piece.text, "Anton", piece.sizePx, 0.012).advance;
        for (let t = landed; t <= landed + 150; t += 10) {
          const pose = evaluatePiece(piece, t);
          expect(pose.visible).toBe(true);
          expect(pose.o).toBeGreaterThan(0.9);
          // The clip's edge is vertical, the bar's end leans with the turn: allow the lean between baseline and centre line.
          const lean = 0.45 * piece.sizePx * Math.abs(Math.sin((pose.rz * Math.PI) / 180));
          expect(pose.clip!.x2).toBeGreaterThanOrEqual(pose.x + advance * Math.cos((pose.rz * Math.PI) / 180) - lean);
        }
      });
    });
  });

  test("a long clip keeps the cube, ticks, dashes and popcorn coming back on every cue, and they vary", () => {
    const long = stretch(cues, 6);
    expect(long.length).toBeGreaterThanOrEqual(24);
    const list = build(long);
    const count = { cube: 0, ticks: 0, dashes: 0, popcorn: 0 };
    const turns = new Set<number>();
    const icons = new Set<string>();
    const popcornFaces = new Set<string>();
    const dashCounts = new Set<number>();
    const tickAngles = new Set<number>();
    long.forEach((_, number) => {
      const mine = ofCue(list, number);
      const kinds = mine.map(kindOf);
      expect(kinds.filter((id) => /^stk[012]$/.test(id))).toHaveLength(3);
      count.cube++;
      const ticks = kinds.filter((id) => /^tk\d$/.test(id)).length;
      const dashes = kinds.filter((id) => /^ds\d$/.test(id)).length;
      const popcorn = kinds.filter((id) => /^pc\d[df]$/.test(id)).length;
      expect(ticks).toBe(3);
      expect(dashes).toBeGreaterThanOrEqual(1);
      expect(popcorn).toBe(4);
      count.ticks += ticks;
      count.dashes += dashes;
      count.popcorn += popcorn / 2;
      dashCounts.add(dashes);
      turns.add(Math.round(evaluatePiece(need(find(list, `${number}:b0fi`)), long[number]!.startMs + 700).rz * 2));
      icons.add(String(need<ShapePiece>(find(list, `${number}:stk2`)).path.length));
      popcornFaces.add(String(need<ShapePiece>(find(list, `${number}:pc0f`)).fill?.colour));
      tickAngles.add(Math.round(evaluatePiece(need(find(list, `${number}:tk0`)), need(find(list, `${number}:tk0`)).fromMs + 20).rz));
    });
    expect(count.cube).toBe(long.length);
    expect(count.ticks).toBe(3 * long.length);
    expect(count.dashes).toBeGreaterThanOrEqual(long.length);
    expect(count.popcorn).toBe(2 * long.length);
    expect(turns.size).toBeGreaterThanOrEqual(8);
    expect(icons.size).toBe(3);
    expect(popcornFaces.size).toBeGreaterThanOrEqual(2);
    expect(dashCounts.size).toBeGreaterThanOrEqual(2);
    expect(tickAngles.size).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(list).includes("NaN")).toBe(false);
  });
});

describe("Ledge scripts and edges", () => {
  test("capitals only for cased scripts; an Urdu cue mirrors the lockup: bars start at the right, words run right to left, the turn flips", () => {
    expect(ledgeCase("hello")).toBe("HELLO");
    expect(ledgeCase("اچھا")).toBe("اچھا");
    expect(ledgeCase("你好")).toBe("你好");
    const urdu = build(sceneEdgeDemo("urdu").cues);
    const first = need<TextPiece>(find(urdu, "0:w0"));
    const second = need<TextPiece>(find(urdu, "0:w1"));
    expect(evaluatePiece(first, 1500).x).toBeGreaterThan(evaluatePiece(second, 1500).x);
    expect(evaluatePiece(first, 1500).rz).toBeGreaterThan(0);
    // The reveal edge is the clip's left side and moves left as words come.
    expect(evaluatePiece(first, 1500).clip!.x1).toBeGreaterThan(0);
    expect(urdu.filter((piece) => piece.kind === "text").every((piece) => (piece as TextPiece).text.length > 0)).toBe(true);
    const box = sceneBoundsAt(urdu, 1500, fakeMeasure);
    expect(box!.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
    expect(box!.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
  });

  test("every spoken word is drawn: a cue with two key-word runs gets a bar for each and the cube only on the first", () => {
    const words = ["so", "quit", "my", "job", "and", "move", "abroad"].map((text, at) => ({ text, startMs: 1000 + at * 300, endMs: 1250 + at * 300, role: (at === 1 || at === 5 ? "hero" : "body") as "hero" | "body", key: null }));
    const cue: SceneCue = { index: 0, startMs: 1000, endMs: 3400, speaker: null, language: "en", words };
    const list = build([cue]);
    expect(list.filter((piece) => piece.kind === "text")).toHaveLength(7);
    expect(list.filter((piece) => piece.kind === "shape" && kindOf(piece) === "stk0")).toHaveLength(1);
    const heroBars = list.filter((piece) => kindOf(piece).endsWith("ff") && (piece as ShapePiece).fill?.colour === COLOURS.highlight);
    expect(heroBars).toHaveLength(2);
  });

  test("the nine-words, one-word and long-word demos fit the safe area on 9:16, 1:1 and 16:9 at every time", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const kind of ["one-word", "nine-words", "long-word", "no-hero", "two-speakers", "urdu"] as const) {
        const edge = sceneEdgeDemo(kind).cues;
        const list = build(edge, { canvas, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } });
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

  test("a word wider than a bar shrinks its bar instead of leaving it", () => {
    const word = { text: "extraordinarily", startMs: 1000, endMs: 1800, role: "body" as const, key: null };
    const cue: SceneCue = { index: 0, startMs: 1000, endMs: 2800, speaker: null, language: "en", words: [word] };
    const piece = need<TextPiece>(find(build([cue]), "0:w0"));
    expect(piece.sizePx).toBeLessThan(80);
    expect(piece.sizePx).toBeGreaterThanOrEqual(0.45 * 80 - 1);
  });
});
