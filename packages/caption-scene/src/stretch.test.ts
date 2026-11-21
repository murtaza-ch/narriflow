import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue, SceneWord } from "./input";
import { type Piece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { STRETCH_DEMO, stretchHash, stretchProgram, stretchSpring, stretchText } from "./templates/stretch";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(STRETCH_DEMO);
const build = (list: readonly SceneCue[], overrides = {}) => stretchProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, ...overrides })).pieces;
const scene = build(cues);
const find = (list: readonly Piece[], id: string) => list.find((piece) => piece.id === `stretch:${id}`);
const need = (piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as TextPiece;
};
const word = (text: string, startMs: number, role: SceneWord["role"] = "body", endMs = startMs + 250): SceneWord => ({ text, startMs, endMs, role, key: null });

describe("Stretch geometry", () => {
  test("the line is 66 px (84 px without a hero), the hero at most 270 px and fitted inside the safe width", () => {
    expect(need(find(scene, "0:w1")).sizePx).toBe(66);
    expect(need(find(scene, "1:w0")).sizePx).toBe(84);
    const hero = need(find(scene, "0:hero"));
    expect(hero.sizePx).toBeLessThanOrEqual(270);
    const box = fakeMeasure(hero.text, hero.face, hero.sizePx, -0.01).advance - 0.01 * hero.sizePx;
    // The spring starts 1.12 x wide: even then it stays inside the 5 % margins.
    expect(box * 1.12).toBeLessThanOrEqual(1080 * 0.9);
  });

  test("at rest the line sits 22 px above the hero's box, the hero pivoting at 88 % of it, the block centred on y 1290", () => {
    const hero = need(find(scene, "0:hero"));
    const t = 1794 + 450;
    const pose = evaluatePiece(hero, t);
    expect(pose.sy).toBeCloseTo(1, 6);
    expect(pose.sx).toBeCloseTo(1, 6);
    const boxH = Math.round(0.86 * hero.sizePx);
    const heroTop = pose.y - 0.88 * boxH;
    const lastRow = ["w3", "w4"].map((id) => need(find(scene, `0:${id}`)));
    for (const piece of lastRow) {
      const p = evaluatePiece(piece, t);
      // The word's centre is its pivot: its box ends half the size below it.
      expect(p.y + piece.sizePx / 2).toBeCloseTo(heroTop - 22, 3);
    }
    // The fake measure sets the lead words in one row.
    const lineH = 66;
    const total = lineH + 22 + boxH;
    expect(heroTop + boxH).toBeCloseTo(1290 + total / 2, 3);
  });

  test("a cue with no hero is centred on y 1290 and its words wrap inside the 920 px zone", () => {
    // One row of 84 px words: its bottom is the floor, 42 px under the anchor line.
    const first = need(find(scene, "1:w0"));
    expect(evaluatePiece(first, 2900).y + first.sizePx / 2).toBeCloseTo(1290 + 42, 3);
    for (const piece of scene.filter((p) => p.id.startsWith("stretch:1:"))) {
      const p = evaluatePiece(piece, 2900);
      expect(p.x).toBeGreaterThan(80);
      expect(p.x).toBeLessThan(1000);
    }
  });

  test("words after the hero are not dropped: a second small line under the floor", () => {
    const list = build([{ index: 0, startMs: 0, endMs: 3000, speaker: 0, language: "en", words: [word("so", 0), word("BIG", 300, "hero", 700), word("deal", 800), word("really", 1050)] }]);
    const hero = need(find(list, "0:hero"));
    const floor = evaluatePiece(hero, 1500).y + 0.12 * Math.round(0.86 * hero.sizePx);
    for (const id of ["w2", "w3"]) {
      const tail = need(find(list, `0:${id}`));
      expect(evaluatePiece(tail, 1800).y - tail.sizePx / 2).toBeCloseTo(floor + 22, 3);
    }
    expect(list.filter((piece) => piece.kind === "text").map((piece) => (piece as TextPiece).text).sort()).toEqual(["BIG", "DEAL", "REALLY", "SO"]);
  });
});

describe("Stretch motion", () => {
  test("the hero springs from flat and wide exactly as the sample, then squashes into the floor", () => {
    const cue = cues[0]!;
    const start = cue.words[5]!.startMs;
    const hero = need(find(scene, "0:hero"));
    for (const dt of [-80, -40, 0, 80, 160, 220, 290, 350, 400]) {
      const t = start + dt;
      const pose = evaluatePiece(hero, t);
      const sample = stretchSpring(dt);
      expect(pose.sy).toBeCloseTo(sample.sy, 2);
      expect(pose.sx).toBeCloseTo(sample.sx, 2);
    }
    expect(stretchSpring(-80)).toEqual({ sy: 0.1, sx: 1.12 });
    const exitFrom = cue.endMs - 190;
    for (const dt of [20, 80, 140, 180]) {
      const pose = evaluatePiece(hero, exitFrom + dt);
      const out = EASES.in(prog(exitFrom + dt, exitFrom, 190));
      expect(pose.sy).toBeCloseTo(1 - out, 1);
      expect(pose.sx).toBeCloseTo(1 + 0.1 * out, 1);
    }
  });

  test("the line rides the hero's height: it is shoved up as the hero grows (the sample's lineBottom)", () => {
    const hero = need(find(scene, "0:hero"));
    const w4 = need(find(scene, "0:w4"));
    const start = cues[0]!.words[5]!.startMs;
    const at = (t: number) => evaluatePiece(w4, t).y;
    // Before the spring the line sits at the floor; the spring shoves it up by 0.88 H + 22, past it by the overshoot.
    const H = Math.round(0.86 * hero.sizePx);
    expect(at(start - 100) - at(start + 450)).toBeCloseTo(0.88 * H + 22, 0);
    expect(at(start + 160)).toBeLessThan(at(start + 450));
  });

  test("a word pops: 16 px up and .9 to 1 over 170 ms (outExpo) from 50 ms before it is spoken", () => {
    const w = need(find(scene, "0:w1"));
    const spoken = cues[0]!.words[1]!;
    const rest = evaluatePiece(w, spoken.startMs + 300);
    for (const dt of [-50, -20, 40, 120]) {
      const t = spoken.startMs + dt;
      const p = EASES.outExpo(prog(t, spoken.startMs - 50, 170));
      expect(evaluatePiece(w, t).sx).toBeCloseTo(0.9 + 0.1 * p, 2);
      expect(evaluatePiece(w, t).y - rest.y).toBeCloseTo((1 - p) * 16, 0);
    }
  });

  test("a cue without a hero squashes flat and widens by 1.18 on exit, no fade", () => {
    const cue = cues[1]!;
    const w = need(find(scene, "1:w0"));
    const exitFrom = cue.endMs - 190;
    const p = evaluatePiece(w, exitFrom + 150);
    const out = EASES.in(prog(exitFrom + 150, exitFrom, 190));
    expect(p.sy).toBeCloseTo(Math.max(0.02, 1 - out), 1);
    expect(p.sx).toBeGreaterThan(1);
    expect(p.o).toBe(1);
  });
});

describe("Stretch with real speech", () => {
  const fast = demoCues({ ...STRETCH_DEMO, options: { ...STRETCH_DEMO.options, cueGap: 60 } }).cues;
  test("every word stays visible for 150 ms after it lands (cueGap 60)", () => {
    const list = build(fast);
    fast.forEach((cue, number) => {
      cue.words.forEach((spoken, at) => {
        const hero = spoken.role === "hero" && cue.words.findIndex((w) => w.role === "hero") === at;
        const piece = need(find(list, `${number}:${hero ? "hero" : `w${at}`}`));
        const landed = spoken.startMs + (hero ? 160 : 120);
        for (let t = landed; t <= landed + 150; t += 5) {
          const pose = evaluatePiece(piece, t);
          expect(pose.visible).toBe(true);
          expect(pose.o).toBeGreaterThan(0.9);
          expect(pose.sy).toBeGreaterThan(0.9);
        }
      });
    });
  });

  test("a short last word shortens the exit (40 ms at least) instead of cutting the word, and never outlives the cue", () => {
    const tight: SceneCue[] = [{ index: 0, startMs: 0, endMs: 520, speaker: 0, language: "en", words: [word("go", 0), word("NOW", 60, "hero", 200)] }];
    const list = build(tight);
    const hero = need(find(list, "0:hero"));
    expect(hero.toMs).toBe(520);
    // Landed at 220, readable until 370, then the 150 ms exit (the cue ends at 520).
    expect(evaluatePiece(hero, 370).sy).toBeGreaterThan(0.9);
    for (const piece of build(cues)) expect(piece.toMs).toBeLessThanOrEqual(cues[Number(piece.id.split(":")[1])]!.endMs);
  });
});

describe("Stretch across a whole clip", () => {
  const long: SceneCue[] = Array.from({ length: 24 }, (_, i) => {
    const base = cues[i % cues.length]!;
    const shift = Math.floor(i / cues.length) * 9000 + (i % cues.length) * 0;
    return { ...base, index: i, startMs: base.startMs + shift, endMs: base.endMs + shift, words: base.words.map((w) => ({ ...w, startMs: w.startMs + shift, endMs: w.endMs + shift })) };
  });
  const list = build(long);

  test("every hero cue springs and alternates its lean, with a size that varies", () => {
    const heroes = list.filter((piece) => piece.id.endsWith(":hero")) as TextPiece[];
    expect(heroes.length).toBe(long.filter((cue) => cue.words.some((w) => w.role === "hero")).length);
    const leans = heroes.map((piece) => evaluatePiece(piece, piece.fromMs).skx);
    for (const [at, lean] of leans.entries()) expect(Math.sign(lean)).toBe(at % 2 === 0 ? 1 : -1);
    expect(new Set(leans.map((lean) => Math.abs(lean).toFixed(2))).size).toBeGreaterThan(2);
    for (const hero of heroes) expect(evaluatePiece(hero, hero.toMs - 1).skx).toBeCloseTo(0, 6);
  });

  test("every cue keeps its pops and its exit, and nothing leaves the safe area", () => {
    for (let number = 0; number < long.length; number++) {
      const mine = list.filter((piece) => piece.id.startsWith(`stretch:${number}:`));
      expect(mine.length).toBe(long[number]!.words.length);
    }
    for (let t = 0; t < 25000; t += 50) {
      const box = sceneBoundsAt(list, t, fakeMeasure);
      if (!box) continue;
      expect(box.x1).toBeGreaterThanOrEqual(54 - 0.5);
      expect(box.x2).toBeLessThanOrEqual(1026 + 0.5);
    }
  });

  test("the hash is stable and the same cue gets the same lean", () => {
    expect(stretchHash(3, "QUIET")).toBe(stretchHash(3, "QUIET"));
    expect(stretchHash(3, "QUIET")).not.toBe(stretchHash(4, "QUIET"));
    expect(build(long).map((piece) => piece.id)).toEqual(list.map((piece) => piece.id));
  });
});

describe("Stretch edge cases", () => {
  test("uppercase only for cased scripts; Urdu is set as typed, whole, without letter spacing", () => {
    expect(stretchText("quiet", "en")).toEqual({ text: "QUIET", cased: true });
    expect(stretchText("اچھا", "ur")).toEqual({ text: "اچھا", cased: false });
    expect(stretchText("こんにちは", "ja").cased).toBe(false);
    expect(stretchText("istanbul", "tr").text).toBe("İSTANBUL");
    const list = build(sceneEdgeDemo("urdu").cues);
    for (const piece of list as TextPiece[]) expect(piece.letterSpacingEm).toBe(0);
    expect((list as TextPiece[]).map((piece) => piece.text)).toContain("اچھا");
  });

  test("a right-to-left row reads from the right", () => {
    const urdu = sceneEdgeDemo("urdu").cues[1]!;
    const list = build([urdu]);
    const xs = urdu.words.map((_, at) => evaluatePiece(need(find(list, `0:w${at}`)), urdu.words[at]!.startMs + 600).x);
    expect(xs[0]!).toBeGreaterThan(xs[1]!);
  });

  test("a very long word shrinks the line and the hero keeps 1.6 x the line", () => {
    const list = build(sceneEdgeDemo("long-word").cues);
    const hero = need(find(list, "0:hero"));
    const lead = need(find(list, "0:w0"));
    expect(hero.sizePx).toBeLessThan(270);
    expect(hero.sizePx).toBeGreaterThanOrEqual(1.6 * lead.sizePx - 0.01);
    const solo = need(find(list, "1:w0"));
    expect(solo.sizePx).toBeLessThan(84);
  });

  test("a 16:9 canvas keeps the block inside the safe area", () => {
    const wide = build(cues, { canvas: { width: 1920, height: 1080 }, anchor: { xPct: 50, yPct: 67 } });
    for (let t = 0; t < 8400; t += 40) {
      const box = sceneBoundsAt(wide, t, fakeMeasure);
      if (!box) continue;
      expect(box.y1).toBeGreaterThanOrEqual(54 - 0.5);
      expect(box.y2).toBeLessThanOrEqual(1026 + 0.5);
    }
  });
});
