import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { TAPE_DEMO, tapeBlockScale, tapeCase, tapeHash, tapeLetterRanks, tapePoints, tapeProgram, tapeRng, tapeShuffle } from "./templates/tape";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(TAPE_DEMO);
const COLOURS = { primary: "#FFFFFF", highlight: "#402EEC", accent: "#D4FF3A", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) => tapeProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const scene = build(cues);
const find = (list: readonly Piece[], id: string) => list.find((piece) => piece.id === `tape:${id}`);
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};
const ofCue = (list: readonly Piece[], cue: number) => list.filter((piece) => piece.id.split(":")[1] === String(cue));

describe("Tape geometry", () => {
  test("rows pack greedily in 900 px and centre on y 1290; boxes are padded 0.13 em; baseline 78 of 92 px", () => {
    // Cue 2 "is on you": three 92 px words in one row. The fake face is 0.55 em per character.
    const size = 92;
    const adv = (text: string) => fakeMeasure(text.toUpperCase(), "Archivo Expanded Black", size, -0.01).advance - 0.01 * size;
    const boxes = ["is", "on", "you"].map((text) => adv(text) + 2 * 0.13 * size);
    const total = boxes.reduce((a, b) => a + b, 0);
    const word = need<TextPiece>(find(scene, "2:w0"));
    expect(word.text).toBe("IS");
    expect(word.sizePx).toBe(92);
    const pose = evaluatePiece(word, 4000);
    const sb = tapeBlockScale(4000, cues[2]!.startMs, cues[2]!.endMs, cues[2]!.endMs - 240, 170);
    // The ink box's centre is the pivot; the row is centred on x 540 before the block's push.
    const inkLeft = 540 - total / 2 + 0.13 * size;
    const pivotX = inkLeft + adv("is") / 2;
    expect(pose.x).toBeCloseTo(540 + sb * (pivotX - 540), 0);
    // One row of 1.04 * 92 px centred on 1290: its pivot (line box centre) sits on y 1290.
    expect(pose.y).toBeCloseTo(1290, 0);
    expect(word.origin!.dy).toBeCloseTo(0.52 * size - (78 / 92) * size, 6);
  });

  test("a hero cue: lead row, then the hero's own row of letter pieces with no kerning, 158 px", () => {
    const letters = scene.filter((piece): piece is TextPiece => piece.kind === "text" && piece.id.startsWith("tape:1:w1l"));
    expect(letters.map((piece) => piece.text).join("")).toBe("CAREER");
    expect(letters.every((piece) => piece.sizePx === 158 || piece.sizePx < 158)).toBe(true);
    const lead = need<TextPiece>(find(scene, "1:w0"));
    const hero = letters[0]!;
    // Block: 1.04 * (92 + 158) + 4 px, centred on 1290: the lead row's centre is 0.52 * 92 below the block top.
    const total = 1.04 * 92 + 4 + 1.04 * 158;
    const rest = (piece: TextPiece) => evaluatePiece(piece, 3000);
    const sb = tapeBlockScale(3000, cues[1]!.startMs, cues[1]!.endMs, cues[1]!.endMs - 240, 170);
    expect(rest(lead).y).toBeCloseTo(1290 + sb * (1290 - total / 2 + 0.52 * 92 - 1290), 0);
    expect(rest(hero).y).toBeCloseTo(1290 + sb * (1290 - total / 2 + 1.04 * 92 + 4 + 0.52 * 158 - 1290), 0);
  });

  test("a cue with a hero has five strips; a plain cue one thin strip under its last row", () => {
    const strips = scene.filter((piece) => piece.id.startsWith("tape:1:s"));
    expect(strips).toHaveLength(5);
    expect(strips.every((piece) => piece.kind === "shape" && piece.fill?.alpha === 0.74 && piece.fill.colour === "#402EEC")).toBe(true);
    const angles = strips.map((piece) => evaluatePiece(piece, 3000).rz);
    expect(new Set(angles.map((angle) => Math.round(angle))).size).toBeGreaterThanOrEqual(4);
    const thin = need<ShapePiece>(find(scene, "0:thin"));
    expect(ofCue(scene, 0).filter((piece) => /:s\d/.test(piece.id))).toHaveLength(0);
    // 30 px thick, centred 14 px under the last row's bottom edge (the last word's line box centre is 0.52 * 92 above that edge).
    const height = Math.max(...thin.path.flatMap((cmd) => (cmd[0] === "Z" ? [] : [cmd[cmd.length - 1] as number])));
    expect(height).toBeCloseTo(30, 6);
    const last = need<TextPiece>(find(scene, "0:w5"));
    const sb = tapeBlockScale(1500, cues[0]!.startMs, cues[0]!.endMs, cues[0]!.endMs - 240, 170);
    const lastPivot = 1290 + (evaluatePiece(last, 1500).y - 1290) / sb;
    expect(evaluatePiece(thin, 1500).y).toBeCloseTo(1290 + sb * (lastPivot + 0.52 * 92 + 14 - 1290), 0);
  });

  test("strips are torn: ten points with zig-zag ends, the same for the same seed", () => {
    const a = tapePoints(500, 70, tapeRng(7));
    expect(a).toHaveLength(10);
    expect(tapePoints(500, 70, tapeRng(7))).toEqual(a);
    expect(Math.max(...a.map(([x]) => x))).toBeLessThanOrEqual(500);
    expect(Math.min(...a.map(([x]) => x))).toBeGreaterThanOrEqual(0);
  });
});

describe("Tape motion", () => {
  test("a body word pops from 1.22 to 1 over 140 ms starting 60 ms before it is spoken (outExpo), times the block's push", () => {
    const cue = cues[2]!;
    const word = need<TextPiece>(find(scene, "2:w1"));
    const spoken = cue.words[1]!;
    for (const t of [spoken.startMs - 40, spoken.startMs, spoken.startMs + 60, spoken.startMs + 120]) {
      const own = 1.22 + (1 - 1.22) * EASES.outExpo(prog(t, spoken.startMs - 60, 140));
      expect(evaluatePiece(word, t).sx).toBeCloseTo(own * tapeBlockScale(t, cue.startMs, cue.endMs, cue.endMs - 240, 170), 2);
    }
    expect(word.fromMs).toBeGreaterThan(spoken.startMs - 60);
  });

  test("the hero's letters pop in a seeded shuffled order, the first among the first third, from 1.35", () => {
    const letters = scene.filter((piece) => piece.id.startsWith("tape:1:w1l"));
    const starts = letters.map((piece) => piece.fromMs);
    expect(new Set(starts).size).toBe(6);
    expect(starts[0]!).toBeLessThanOrEqual([...starts].sort((a, b) => a - b)[2]!);
    expect(evaluatePiece(letters[0]!, letters[0]!.fromMs + 1).sx).toBeGreaterThan(1.25);
    for (let n = 3; n < 20; n++) {
      const ranks = tapeLetterRanks(n, tapeRng(n * 31));
      expect([...ranks].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, at) => at));
      expect(ranks[0]!).toBeLessThanOrEqual(Math.floor(n / 3));
    }
  });

  test("a strip slaps in along its axis (outExpo, 190 ms) with a 1.25 squash that eases out", () => {
    const strip = need<ShapePiece>(find(scene, "1:s1k0"));
    const first = evaluatePiece(strip, strip.fromMs + 2);
    const rested = evaluatePiece(strip, strip.fromMs + 600);
    expect(Math.hypot(first.x - rested.x, first.y - rested.y)).toBeGreaterThan(100);
    expect(first.sy / first.sx).toBeGreaterThan(1.2);
    expect(rested.sy / rested.sx).toBeCloseTo(1, 2);
    expect(evaluatePiece(strip, strip.fromMs + 600).o).toBeCloseTo(1, 2);
  });

  test("the first cue's label (hero counter 0) pops with a spring; the second hero has a tick of two wiped arms", () => {
    const label = need<ShapePiece>(find(scene, "1:lab1"));
    expect(evaluatePiece(label, label.fromMs + 2).rz).toBeLessThan(-50);
    expect(evaluatePiece(label, label.fromMs + 800).rz).toBeCloseTo(-30, 1);
    const printed = need<TextPiece>(find(scene, "1:lab1t"));
    expect(printed.text).toBe("• CAREER • CAREER •");
    expect(printed.fill).toBe("#101010");
    expect(find(scene, "3:tk1aw")).toBeDefined();
    expect(find(scene, "3:tk1bw")).toBeDefined();
    expect(find(scene, "3:lab1")).toBeUndefined();
    const arm = need<ShapePiece>(find(scene, "3:tk1bw"));
    const quarter = evaluatePiece(arm, arm.fromMs + 40);
    expect(quarter.sx).toBeGreaterThan(0);
    expect(quarter.sx).toBeLessThan(evaluatePiece(arm, arm.toMs - 2).sx);
  });

  test("the block pushes in 3.5 % over the cue and shrinks 6 % as it leaves", () => {
    expect(tapeBlockScale(1000, 1000, 3000, 2760, 170)).toBeCloseTo(1, 6);
    expect(tapeBlockScale(3000, 1000, 3000, 2760, 170)).toBeCloseTo(1.035 * 0.94, 3);
    expect(tapeBlockScale(2000, 1000, 3000, 2760, 170)).toBeCloseTo(1 + 0.035 * EASES.out(0.5), 6);
  });

  test("the seeded helpers are pure: a shuffle is a permutation and the hash is stable", () => {
    expect(tapeShuffle(8, tapeRng(3))).toEqual(tapeShuffle(8, tapeRng(3)));
    expect([...tapeShuffle(8, tapeRng(3))].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(tapeHash("0|a b")).toBe(tapeHash("0|a b"));
    expect(tapeHash("0|a b")).not.toBe(tapeHash("1|a b"));
    expect(JSON.stringify(build(cues))).toBe(JSON.stringify(build(cues)));
  });
});

describe("Tape real speech and long clips", () => {
  test("fast speech: with 60 ms between cues every word stays visible for 150 ms after it lands", () => {
    const fast = demoCues({ ...TAPE_DEMO, options: { ...TAPE_DEMO.options, cueGap: 60 } }).cues;
    const list = build(fast);
    fast.forEach((cue, number) => {
      cue.words.forEach((_word, index) => {
        const mine = list.filter((piece) => new RegExp(`^tape:${number}:w${index}(l\\d+)?$`).test(piece.id));
        expect(mine.length).toBeGreaterThan(0);
        // Landed: its pop (140 ms body, 120 ms letters) is over.
        const landed = Math.max(...mine.map((piece) => piece.fromMs)) + 140;
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

  test("a long clip keeps its tape, label and tick coming back and varying", () => {
    const base = demoCues(TAPE_DEMO);
    const long: SceneCue[] = [];
    for (let round = 0; round < 6; round++) {
      for (const cue of base.cues) {
        const shift = round * (base.duration + 200);
        long.push({ ...cue, index: long.length, startMs: cue.startMs + shift, endMs: cue.endMs + shift, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + shift, endMs: word.endMs + shift })) });
      }
    }
    expect(long.length).toBeGreaterThanOrEqual(30);
    const list = build(long);
    let labels = 0;
    let ticks = 0;
    const fans = new Set<string>();
    long.forEach((cue, number) => {
      const mine = ofCue(list, number);
      const hero = cue.words.some((word) => word.role === "hero");
      const strips = mine.filter((piece) => /^tape:\d+:s\d+k\d$/.test(piece.id));
      if (hero) {
        expect(strips).toHaveLength(5);
        fans.add(strips.map((piece) => Math.round(evaluatePiece(piece, piece.toMs - 5).rz)).join(","));
        if (mine.some((piece) => /:lab\d+$/.test(piece.id))) labels++;
        if (mine.some((piece) => /:tk\d+aw$/.test(piece.id))) ticks++;
      } else {
        expect(mine.some((piece) => piece.id.endsWith(":thin"))).toBe(true);
      }
    });
    expect(labels).toBeGreaterThanOrEqual(6);
    expect(ticks).toBeGreaterThanOrEqual(6);
    // The same demo words repeat, but the fan of strips is a hash of the cue's index: it does not repeat.
    expect(fans.size).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(list).includes("NaN")).toBe(false);
  });
});

describe("Tape scripts and edges", () => {
  test("capitals only for cased scripts; an Urdu hero pops as one piece and mirrors its tick or label", () => {
    expect(tapeCase("hello")).toBe("HELLO");
    expect(tapeCase("اچھا")).toBe("اچھا");
    expect(tapeCase("你好")).toBe("你好");
    const urdu = build(sceneEdgeDemo("urdu").cues);
    const heroPieces = urdu.filter((piece) => piece.id.startsWith("tape:0:w2"));
    expect(heroPieces.filter((piece) => piece.kind === "text")).toHaveLength(1);
    // Right to left: the first spoken word of the row sits right of the second.
    const first = need<TextPiece>(urdu.find((piece) => piece.id === "tape:0:w0"));
    const second = need<TextPiece>(urdu.find((piece) => piece.id === "tape:0:w1"));
    expect(evaluatePiece(first, 1500).x).toBeGreaterThan(evaluatePiece(second, 1500).x);
  });

  test("a hero too wide for the frame shrinks and a 45-letter word still fits the safe width", () => {
    const long = build(sceneEdgeDemo("long-word").cues);
    const hero = long.filter((piece): piece is TextPiece => piece.kind === "text" && piece.id.startsWith("tape:0:w1l"));
    expect(hero.length).toBeGreaterThan(0);
    expect(hero[0]!.sizePx).toBeLessThan(158);
    for (let t = 2100; t < 4000; t += 50) {
      const box = sceneBoundsAt(long, t, fakeMeasure);
      if (!box) continue;
      expect(box.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
      expect(box.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
    }
  });

  test("tape strips stay inside the safe area at rest on 9:16, 1:1 and 16:9", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      const list = build(cues, { canvas });
      for (const piece of list.filter((p) => /:s\d+k\d$/.test(p.id) || p.id.endsWith(":thin"))) {
        const t = piece.toMs - 300;
        const pose = evaluatePiece(piece, t);
        expect(pose.x).toBeGreaterThan(0.05 * canvas.width);
        expect(pose.x).toBeLessThan(0.95 * canvas.width);
        expect(pose.y).toBeGreaterThan(0.05 * canvas.height);
        expect(pose.y).toBeLessThan(0.95 * canvas.height);
      }
    }
  });
});
