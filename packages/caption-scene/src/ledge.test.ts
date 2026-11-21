import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { captionColourContrast, captionSceneMeta } from "@narriflow/validators";
import { type Measure, type Piece, type ShapePiece, type TextPiece, evaluatePiece, pieceBounds, sceneBoundsAt } from "./scene";
import { pathBounds } from "./shapes";
import { LEDGE_DEMO, ledgeBarWidth, ledgeFrameAtOrAfter, ledgePaintedFrames, ledgeBaseline, ledgeCase, ledgeHash, ledgeProgram, ledgeRng, ledgeShuffle } from "./templates/ledge";
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
    expect(need<ShapePiece>(find(scene, "1:stk2")).fill?.colour).toBe("#E82D37");
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
  test("fast speech: with 60 ms between cues every word is there from its speech, opaque and uncovered until the exit, which waits 150 ms or the next entrance", () => {
    const fast = demoCues({ ...LEDGE_DEMO, options: { ...LEDGE_DEMO.options, cueGap: 60 } }).cues;
    const list = build(fast);
    fast.forEach((cue, number) => {
      const nextFrom = number + 1 < fast.length ? Math.min(...ofCue(list, number + 1).map((piece) => piece.fromMs)) : Number.POSITIVE_INFINITY;
      cue.words.forEach((word, index) => {
        const piece = need<TextPiece>(find(list, `${number}:w${index}`));
        // Entrances are locked to speech: a word's piece starts before the word does.
        expect(piece.fromMs).toBeLessThanOrEqual(word.startMs);
        const ready = readyOf(piece);
        const exitFrom = exitOf(piece).from;
        expect(exitFrom).toBeGreaterThanOrEqual(Math.min(ready + 150, nextFrom - 25));
        for (let t = ready; t < exitFrom; t += 10) {
          const pose = evaluatePiece(piece, t);
          expect(pose.visible).toBe(true);
          expect(pose.o).toBeGreaterThan(0.9);
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

const word = (text: string, startMs: number, endMs: number, role: "hero" | "body" | "minor" = "body") => ({ text, startMs, endMs, role, key: null });
/** Whether a word's clip has uncovered all of it at `t`. */
const openAt = (piece: TextPiece, t: number): boolean => {
  const advance = fakeMeasure(piece.text, "Anton", piece.sizePx, 0.012).advance;
  const pose = evaluatePiece(piece, t);
  const lean = 0.45 * piece.sizePx * Math.abs(Math.sin((pose.rz * Math.PI) / 180));
  const far = pose.x + advance * Math.cos((pose.rz * Math.PI) / 180) * (pose.rz > 0 ? -1 : 1);
  return pose.rz > 0 ? pose.clip!.x1 <= far + lean : pose.clip!.x2 >= far - lean;
};
/** The first ms a word's clip has uncovered all of it. */
const readyOf = (piece: TextPiece): number => {
  for (let t = piece.fromMs; t < piece.toMs; t++) if (openAt(piece, t)) return t;
  return piece.toMs;
};
/** The 30 fps frame times (ms) inside a window. */
const framesIn = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let n = Math.ceil((from * 30) / 1000); Math.round((n * 1000) / 30) < to; n++) if (Math.round((n * 1000) / 30) >= from) out.push(Math.round((n * 1000) / 30));
  return out;
};
const exitOf = (piece: Piece): { from: number; to: number } => {
  const frames = piece.track.o!;
  // A cut has no fade: it leaves exactly at the piece's end.
  if (frames.length < 3) return { from: piece.toMs, to: piece.toMs };
  return { from: frames[frames.length - 2]![0], to: frames[frames.length - 1]![0] };
};
const cueOf = (index: number, startMs: number, endMs: number, words: ReturnType<typeof word>[], language: string | null = "en"): SceneCue => ({ index, startMs, endMs, speaker: null, language, words });

describe("Ledge review fixes", () => {
  test("1: a cue that follows closely never covers the last word of the one before until it has been readable for 150 ms", () => {
    // GO is spoken 1000-1120 and the next cue starts at 1180: the old build let the next bar grow over GO at 1123.
    const list = build([cueOf(0, 1000, 1180, [word("go", 1000, 1120)]), cueOf(1, 1180, 2400, [word("no", 1180, 1400)])]);
    const go = need<TextPiece>(find(list, "0:w0"));
    const advance = fakeMeasure(go.text, "Anton", go.sizePx, 0.012).advance;
    let ready = go.fromMs;
    while (evaluatePiece(go, ready).clip!.x2 < evaluatePiece(go, ready).x + advance && ready < 3000) ready++;
    const next = ofCue(list, 1).filter((piece) => piece.kind === "shape");
    expect(next.length).toBeGreaterThan(0);
    for (let t = ready; t <= ready + 150; t += 4) {
      const pose = evaluatePiece(go, t);
      for (const along of [0.25, 0.5]) {
        const reach = advance * along;
        const point = { x: pose.x + reach * Math.cos((pose.rz * Math.PI) / 180), y: pose.y + reach * Math.sin((pose.rz * Math.PI) / 180) - 0.3 * go.sizePx };
        for (const piece of next) {
          const box = pieceBounds(piece, t, fakeMeasure);
          const covers = box !== null && box.x1 <= point.x && point.x <= box.x2 && box.y1 <= point.y && point.y <= box.y2;
          expect(covers).toBe(false);
        }
      }
    }
    // The next cue is not delayed: it starts before its own first word is spoken.
    const now = need<TextPiece>(find(list, "1:w0"));
    expect(now.fromMs).toBeLessThanOrEqual(1180);
  });

  test("2: a script taller than Anton gets a bar and baseline that hold its measured ink inside the keylines", () => {
    const tall: Measure = (text, face, size, ls) => {
      const base = fakeMeasure(text, face, size, ls);
      return /[\u0600-\u06ff]/.test(text) ? { ...base, inkTop: -1.05 * size, inkBottom: 0.6 * size } : base;
    };
    const cue = cueOf(0, 1000, 2400, [word("پاکستان", 1000, 1500)], "ur");
    const list = build([cue], { measure: tall });
    const face = need<ShapePiece>(find(list, "0:b0fi"));
    const text = need<TextPiece>(find(list, "0:w0"));
    const at = 1800;
    const a = evaluatePiece(face, at);
    const b = evaluatePiece(text, at);
    const turn = (-a.rz * Math.PI) / 180;
    const vy = (b.y - a.y) * Math.cos(turn) + (b.x - a.x) * Math.sin(turn);
    const h = pathBounds(face.path).y2;
    expect(h).toBeGreaterThan(112);
    expect(vy - 1.05 * 80).toBeGreaterThanOrEqual(5 - 1e-6);
    expect(vy + 0.6 * 80).toBeLessThanOrEqual(h - 5 + 1e-6);
    // Latin keeps the sample's 112 px bar.
    expect(pathBounds(need<ShapePiece>(find(scene, "0:b0fi")).path).y2).toBeCloseTo(112, 3);
  });

  test("3: a mixed-direction bar appears for the word spoken first, not the word that sits first on the bar", () => {
    const cue = cueOf(0, 1000, 2300, [word("یہ", 1000, 1250, "hero"), word("NEW", 1300, 1500), word("YORK", 1600, 1800)], "ur");
    const list = build([cue]);
    const body = need<ShapePiece>(find(list, "0:b1ff"));
    expect(body.fromMs).toBeLessThanOrEqual(1300 - 85 + 1);
    const neu = need<TextPiece>(find(list, "0:w1"));
    const advance = fakeMeasure("NEW", "Anton", neu.sizePx, 0.012).advance;
    const pose = evaluatePiece(neu, 1300 + 160);
    expect(pose.visible).toBe(true);
    // Uncovered: the reveal edge (the clip's left side in a right-to-left cue) has passed the word's far end.
    expect(pose.clip!.x1).toBeLessThanOrEqual(pose.x + 4);
    expect(evaluatePiece(body, 1300 + 160).sx).toBeGreaterThan(0.3);
    void advance;
  });

  test("4: the exit drop stays inside the safe area on 16:9 at a large size, across the whole exit", () => {
    const roles = ["body", "hero", "body", "hero", "body"] as const;
    const words = roles.map((role, at) => word(["alpha", "BRAVO", "charlie", "DELTA", "echo"][at]!, 1000 + at * 300, 1250 + at * 300, role));
    const canvas = { width: 1920, height: 1080 };
    const list = build([cueOf(0, 1000, 3000, words)], { canvas, scale: 2.5, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } });
    const end = Math.max(...list.map((piece) => piece.toMs));
    for (let t = 0; t < end; t++) {
      const box = sceneBoundsAt(list, t, fakeMeasure);
      if (!box) continue;
      expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
      expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
      expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
      expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
    }
  });

  test("5: a very short cue keeps its cube, ticks, dashes and popcorn, with a gap of 60 ms or none", () => {
    for (const gap of [60, 0]) {
      const list = build([cueOf(0, 1000, 1120 + gap, [word("i", 1000, 1120)]), cueOf(1, 1120 + gap, 2600, [word("quit", 1120 + gap, 1500), word("now", 1550, 1900)])]);
      const kinds = ofCue(list, 0).map(kindOf);
      expect(kinds.filter((id) => /^stk[012]$/.test(id))).toHaveLength(3);
      expect(kinds.filter((id) => /^tk\d$/.test(id))).toHaveLength(3);
      expect(kinds.filter((id) => /^ds\d$/.test(id)).length).toBeGreaterThanOrEqual(1);
      expect(kinds.filter((id) => /^pc\d[df]$/.test(id))).toHaveLength(4);
      // And the cube has a window of its own before the cue leaves (a cut when the next cue is that close).
      const cube = need<ShapePiece>(find(list, "0:stk1"));
      expect(cube.toMs - cube.fromMs).toBeGreaterThanOrEqual(67);
    }
  });

  test("6: the dashes change colour when the brand's depth colour is as red as they are, and stay red on the catalogue's yellow", () => {
    const red = "#F0323C";
    const branded = build(cues, { colours: { ...COLOURS, highlight: red } });
    const dash = need<ShapePiece>(find(branded, "0:ds0"));
    expect(dash.fill?.colour).not.toBe(red);
    expect(captionColourContrast(dash.fill!.colour, red)).toBeGreaterThanOrEqual(3);
    // The shipping row's own colours: the dashes are red, and red reads on its yellow depth face.
    const row = captionSceneMeta("ledge").colours;
    const shipped = build(cues, { colours: { ...row, shadow: "#000000" } });
    const kept = need<ShapePiece>(find(shipped, "0:ds0"));
    expect(kept.fill?.colour).toBe("#E82D37");
    expect(captionColourContrast("#E82D37", row.highlight)).toBeGreaterThanOrEqual(3);
  });
});

describe("Ledge re-check fixes", () => {
  const run = (count: number, gap: number, wordMs: number, wordsPer: number): SceneCue[] => {
    const list: SceneCue[] = [];
    let at = 1000;
    for (let k = 0; k < count; k++) {
      const words = Array.from({ length: wordsPer }, (_, w) => word(["so", "go", "now", "yes"][w % 4]!, at + w * wordMs, at + (w + 1) * wordMs, w === wordsPer - 1 && wordsPer > 1 ? "hero" : "body"));
      const end = at + wordsPer * wordMs;
      list.push(cueOf(k, at, k === count - 1 ? end + 650 : end + gap, words));
      at = end + gap;
    }
    return list;
  };

  test("1: entrances are locked to speech: ten four-word cues at 150 ms a word never run late, whatever the gap, and the last cue ends inside the clip", () => {
    for (const gap of [0, 60]) {
      const cues10 = run(12, gap, 150, 4);
      const list = build(cues10);
      cues10.forEach((cue, number) => {
        cue.words.forEach((spoken, index) => {
          const piece = need<TextPiece>(find(list, `${number}:w${index}`));
          expect(piece.fromMs).toBeLessThanOrEqual(spoken.startMs);
          expect(piece.fromMs).toBeGreaterThanOrEqual(spoken.startMs - 100);
        });
      });
      const last = cues10[cues10.length - 1]!;
      expect(Math.max(...ofCue(list, cues10.length - 1).map((piece) => piece.toMs))).toBeLessThanOrEqual(last.endMs + 100);
    }
  });

  test("2: the handoff rule in painted frames: runs shifted by 0, 2, 7, 13, 23, 31 ms keep every word readable until the next cue's first painted frame, with no blank frame and no late first paint", () => {
    for (const shift of [0, 2, 7, 13, 23, 31]) {
      const runs = [run(10, 0, 120, 1), run(10, 60, 120, 1), run(12, 0, 150, 4), run(12, 60, 150, 4), run(10, 0, 100, 3), run(10, 60, 100, 3)].map((cues) =>
        cues.map((cue) => ({ ...cue, startMs: cue.startMs + shift, endMs: cue.endMs + shift, words: cue.words.map((w) => ({ ...w, startMs: w.startMs + shift, endMs: w.endMs + shift })) })),
      );
      for (const cues of runs) {
        const list = build(cues);
        for (const piece of list) {
          // No animated piece is painted on a single frame: a window is two painted frames at least.
          expect(ledgePaintedFrames(piece.fromMs, piece.toMs)).toBeGreaterThanOrEqual(2);
        }
        // No blank frame from the first cue's first painted frame to the end of the last cue, and a frame is never empty.
        const begin = ledgeFrameAtOrAfter(Math.min(...list.map((piece) => piece.fromMs)));
        const finish = Math.max(...list.map((piece) => piece.toMs));
        for (let f = begin; f < finish; f = ledgeFrameAtOrAfter(f + 1)) expect(list.some((piece) => piece.fromMs <= f && f < piece.toMs)).toBe(true);
        cues.forEach((cue, number) => {
          cue.words.forEach((spoken, index) => {
            const piece = need<TextPiece>(find(list, `${number}:w${index}`));
            // The first painted frame is at most one frame after the word's onset, whatever the offset.
            expect(ledgeFrameAtOrAfter(piece.fromMs)).toBeLessThanOrEqual(ledgeFrameAtOrAfter(spoken.startMs));
          });
          if (number + 1 >= cues.length) return;
          const mine = ofCue(list, number);
          const nextPaint = ledgeFrameAtOrAfter(Math.min(...ofCue(list, number + 1).map((other) => other.fromMs)));
          // Nothing of this cue is painted from the next cue's first painted frame (no covering), and with nothing missing between them.
          expect(Math.max(...mine.map((piece) => piece.toMs))).toBeLessThanOrEqual(nextPaint);
          if (cues[number + 1]!.startMs - cue.endMs <= 100) expect(Math.max(...mine.map((piece) => piece.toMs))).toBe(nextPaint);
          cue.words.forEach((_, index) => {
            const piece = need<TextPiece>(find(list, `${number}:w${index}`));
            const ready = ledgeFrameAtOrAfter(readyOf(piece));
            const out = exitOf(piece);
            expect(out.from).toBeGreaterThanOrEqual(Math.min(ready + 150, nextPaint) - 1);
            for (let f = ready; f < out.from; f = ledgeFrameAtOrAfter(f + 1)) expect(evaluatePiece(piece, f).o).toBeGreaterThan(0.9);
          });
        });
      }
    }
  });

  test("4: the reveal's overshoot is inside the safe width at size 200 on 9:16 and 1:1", () => {
    const cue = cueOf(0, 1000, 2300, [word("یہ", 1000, 1250, "hero"), word("NEW", 1300, 1500), word("YORK", 1600, 1800)], "ur");
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      const list = build([cue], { canvas, scale: 2.5, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } });
      const end = Math.max(...list.map((piece) => piece.toMs));
      for (let t = 0; t < end; t++) {
        const box = sceneBoundsAt(list, t, fakeMeasure);
        if (!box) continue;
        expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
        expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
      }
    }
  });

  test("6: on a short cue the ticks start before the exit and keep a lifetime", () => {
    for (const gap of [60, 0]) {
      const list = build([cueOf(0, 1000, 1120 + gap, [word("i", 1000, 1120)]), cueOf(1, 1120 + gap, 2600, [word("quit", 1120 + gap, 1500), word("now", 1550, 1900)])]);
      const exitFrom = exitOf(need(find(list, "0:stk1"))).from;
      for (const j of [0, 1, 2]) {
        const tick = need<ShapePiece>(find(list, `0:tk${j}`));
        expect(tick.fromMs).toBeLessThanOrEqual(exitFrom - 15);
        expect(tick.toMs - tick.fromMs).toBeGreaterThanOrEqual(67);
      }
    }
  });
});

describe("Ledge re-check 2 fixes", () => {
  const goes = (gap: number, count = 10) => {
    const list: SceneCue[] = [];
    let at = 1000;
    for (let k = 0; k < count; k++) {
      list.push(cueOf(k, at, k === count - 1 ? at + 120 + 650 : at + 120 + gap, [word(["go", "no"][k % 2]!, at, at + 120)]));
      at += 120 + gap;
    }
    return list;
  };

  test("1: a word's ink is open and opaque at the first export frame at or after its onset, in runs of 120 ms cues", () => {
    for (const gap of [0, 60]) {
      const cues10 = goes(gap);
      const list = build(cues10);
      cues10.forEach((cue, number) => {
        const piece = need<TextPiece>(find(list, `${number}:w0`));
        const onset = cue.words[0]!.startMs;
        const frame = framesIn(onset, onset + 100)[0]!;
        const pose = evaluatePiece(piece, frame);
        expect(pose.visible).toBe(true);
        expect(pose.o).toBeGreaterThan(0.9);
        expect(openAt(piece, frame)).toBe(true);
      });
    }
  });

  test("2: a short word followed by a taller lockup keeps its 150 ms until the next cue really reaches its ink", () => {
    for (const [wordMs, gap] of [[120, 60], [120, 0], [80, 0]] as const) {
      const one = cueOf(0, 1000, 1000 + wordMs + gap, [word("go", 1000, 1000 + wordMs)]);
      const three = cueOf(1, 1000 + wordMs + gap, 3000, [word("we", 1000 + wordMs + gap, 1300), word("can", 1300, 1420, "hero"), word("go", 1420, 1600)]);
      const list = build([one, three]);
      const go = need<TextPiece>(find(list, "0:w0"));
      const ready = readyOf(go);
      const out = exitOf(go);
      // The first painted frame in which a piece of the next cue lies over the word's ink box.
      let meet = Number.POSITIVE_INFINITY;
      for (let t = ledgeFrameAtOrAfter(go.fromMs); t < 3000 && meet === Number.POSITIVE_INFINITY; t = ledgeFrameAtOrAfter(t + 1)) {
        const ink = pieceBounds(go, t, fakeMeasure);
        if (!ink) continue;
        for (const other of ofCue(list, 1)) {
          const box = pieceBounds(other, t, fakeMeasure);
          if (box && box.x1 < ink.x2 && box.x2 > ink.x1 && box.y1 < ink.y2 && box.y2 > ink.y1) meet = t;
        }
      }
      // The next cue's lockup is taller and reaches the word's ink only later than its 150 ms: the word keeps all of them.
      expect(meet).toBeGreaterThan(ready + 150);
      expect(out.from).toBeGreaterThanOrEqual(ready + 148);
      // And no painted frame has anything of the next cue over the word while it is there.
      for (let f = ledgeFrameAtOrAfter(ready); f < out.to; f = ledgeFrameAtOrAfter(f + 1)) {
        const ink = pieceBounds(go, f, fakeMeasure);
        if (!ink) continue;
        for (const other of ofCue(list, 1)) {
          const box = pieceBounds(other, f, fakeMeasure);
          expect(box !== null && box.x1 < ink.x2 && box.x2 > ink.x1 && box.y1 < ink.y2 && box.y2 > ink.y1).toBe(false);
        }
      }
    }
  });

  test("3: a key word whose drop cannot settle before the cue leaves is drawn settled, and every piece has two painted frames", () => {
    for (const heroMs of [100, 60]) {
      for (const gap of [60, 0]) {
        const pre = cueOf(0, 1000, 1100 + gap, [word("no", 1000, 1100)]);
        const hero = cueOf(1, 1100 + gap, 1100 + gap + heroMs + gap, [word("go", 1100 + gap, 1100 + gap + heroMs, "hero")]);
        const post = cueOf(2, 1100 + gap + heroMs + gap, 3000, [word("now", 1100 + gap + heroMs + gap, 1500), word("please", 1500, 2000)]);
        const list = build([pre, hero, post]);
        const face = need<ShapePiece>(find(list, "1:b0ff"));
        const out = exitOf(face);
        // No motion that never settles: it is still where it ended up before the exit starts, or it never moved.
        const before = evaluatePiece(face, out.from - 1);
        const earlier = evaluatePiece(face, Math.max(face.fromMs + 1, out.from - 40));
        expect(Math.hypot(before.x - earlier.x, before.y - earlier.y)).toBeLessThan(0.6);
        for (const piece of ofCue(list, 1)) expect(ledgePaintedFrames(piece.fromMs, piece.toMs)).toBeGreaterThanOrEqual(2);
      }
    }
  });

  test("4: every word of a cue still appears when the next speaker starts first, and the last cue ends by its own end", () => {
    const early = cueOf(0, 1000, 1500, [word("early", 1000, 1100), word("late", 1320, 1500, "hero")]);
    const other = cueOf(1, 1200, 3000, [word("hello", 1200, 1500), word("there", 1500, 1900)]);
    const list = build([early, other]);
    const late = need<TextPiece>(find(list, "0:w1"));
    expect(late.toMs - late.fromMs).toBeGreaterThanOrEqual(67);
    expect(framesIn(late.fromMs, late.toMs).length).toBeGreaterThanOrEqual(2);
    // Drawn above the next cue's bars, so it is never the thing covered.
    expect(Math.min(late.z, ...ofCue(list, 0).filter((piece) => piece.kind === "text").map((piece) => piece.z))).toBeGreaterThan(Math.max(...ofCue(list, 1).filter((piece) => piece.kind === "shape").map((piece) => piece.z)));
    const closing = cueOf(0, 7000, 7540, [word("so", 7000, 7150), word("much", 7250, 7400, "hero")]);
    const tail = build([closing]);
    expect(Math.max(...tail.map((piece) => piece.toMs))).toBeLessThanOrEqual(7540);
  });

  test("5: at the top anchor the entrance stays inside the safe edge, and the brand guard names the sticker's red", () => {
    const cue = cueOf(0, 1000, 2600, [word("یہ", 1000, 1250, "hero"), word("NEW", 1300, 1500), word("YORK", 1600, 1800)], "ur");
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      const list = build([cue], { canvas, anchor: { xPct: 50, yPct: 5 } });
      const end = Math.max(...list.map((piece) => piece.toMs));
      for (let t = 0; t < end; t++) {
        const box = sceneBoundsAt(list, t, fakeMeasure);
        if (box) expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
      }
    }
    const row = captionSceneMeta("ledge");
    expect(row.brand.primary?.readsOn).toContain("#E82D37");
    expect(row.brand.primary?.readsOn).not.toContain("#F0323C");
    expect(captionColourContrast("#FFD83A", "#E82D37")).toBeGreaterThanOrEqual(3);
  });
});
