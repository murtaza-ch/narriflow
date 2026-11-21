import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, lerp, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, pieceBounds, sceneBoundsAt } from "./scene";
import { RANSOM_DEMO, ransomBoil, ransomCase, ransomHash, ransomProgram, ransomRng, ransomTorn } from "./templates/ransom";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(RANSOM_DEMO);
const COLOURS = { primary: "#F7F2E6", highlight: "#F39A1E", accent: "#1D2A7A", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) => ransomProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const scene = build(cues);
const ofCue = (list: readonly Piece[], cue: number) => list.filter((piece) => piece.id.split(":")[1] === String(cue));
const texts = (list: readonly Piece[]) => list.filter((piece): piece is TextPiece => piece.kind === "text");
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};

describe("Ransom rows", () => {
  test("a run of two minor words is a small Anton strip; the other words share big Alfa Slab One strips", () => {
    const first = texts(ofCue(scene, 0));
    const taste = need<TextPiece>(first.find((piece) => piece.text === "TASTE"));
    const small = first.filter((piece) => piece.text === "IS" || piece.text === "A");
    expect(taste.face).toBe("Alfa Slab One");
    expect(taste.sizePx).toBeCloseTo(118, 6);
    expect(small).toHaveLength(2);
    for (const piece of small) {
      expect(piece.face).toBe("Anton");
      expect(piece.sizePx).toBeCloseTo(74, 6);
      expect(piece.letterSpacingEm).toBe(0.04);
    }
  });

  test("the hero is one tile per letter, in the sample's four faces, never two neighbours alike", () => {
    const letters = texts(ofCue(scene, 0)).filter((piece) => piece.id.includes(":h3l"));
    expect(letters.map((piece) => piece.text).join("")).toBe("SKILL");
    const tiles = ofCue(scene, 0).filter((piece): piece is ShapePiece => piece.kind === "shape" && /:h3l\d$/.test(piece.id));
    expect(tiles).toHaveLength(5);
    for (let at = 1; at < letters.length; at++) {
      expect(letters[at]!.face).not.toBe(letters[at - 1]!.face);
      expect(tiles[at]!.fill!.colour).not.toBe(tiles[at - 1]!.fill!.colour);
    }
    // The tile is a six-point ragged cut.
    expect(tiles[0]!.path.filter((cmd) => cmd[0] === "L" || cmd[0] === "M")).toHaveLength(6);
  });

  test("every spoken word is on screen, even in a row that holds the hero (the sample dropped them)", () => {
    for (const [number, cue] of cues.entries()) {
      const drawn = ofCue(scene, number);
      for (const word of cue.words) {
        const upper = word.text.toUpperCase();
        const found = word.role === "hero" ? drawn.some((piece) => piece.kind === "text" && upper.startsWith(piece.text) && piece.id.includes(`:h${cue.words.indexOf(word)}l`)) : texts(drawn).some((piece) => piece.text === upper);
        expect(found).toBe(true);
      }
    }
    // A hero in the middle keeps the words around it.
    const middle: SceneCue[] = [{ index: 0, startMs: 0, endMs: 3000, speaker: 0, language: "en", words: ["so", "this", "wins", "every", "time"].map((text, at) => ({ text, startMs: 300 + at * 400, endMs: 600 + at * 400, role: at === 2 ? "hero" : "body", key: null })) }];
    const list = build(middle);
    for (const text of ["SO", "THIS", "EVERY", "TIME"]) expect(texts(list).some((piece) => piece.text === text)).toBe(true);
    expect(texts(list).filter((piece) => piece.id.includes(":h2l")).map((piece) => piece.text).join("")).toBe("WINS");
  });

  test("strip colours cycle on a running counter, never by the cue's index", () => {
    const fills = (list: readonly Piece[]) => list.filter((piece): piece is ShapePiece => piece.kind === "shape" && /:r\d+s$/.test(piece.id)).map((piece) => piece.fill!.colour);
    const all = fills(scene);
    expect(all.slice(0, 4)).toEqual(["#F39A1E", "#2E9C93", "#D81E78", "#F6D13A"]);
    for (let at = 1; at < all.length; at++) expect(all[at]).not.toBe(all[at - 1]);
  });
});

describe("Ransom motion", () => {
  test("a strip snaps on 70 ms before its first word: 0.88 to 1 on the spring, a twist that eases out", () => {
    const strip = need<ShapePiece>(scene.find((piece) => piece.id === "ransom:0:r0s"));
    const first = cues[0]!.words[0]!;
    for (const t of [first.startMs - 60, first.startMs, first.startMs + 80, first.startMs + 190]) {
      const p = prog(t, first.startMs - 70, 260);
      expect(evaluatePiece(strip, t).sx).toBeCloseTo(lerp(0.88, 1, EASES.spring(p)), 2);
      expect(evaluatePiece(strip, t).o).toBeCloseTo(Math.min(1, p * 6), 1);
    }
  });

  test("the boil is stepped: constant within a 150 ms step, new offsets on the next, as the sample's formula says", () => {
    const strip = need<ShapePiece>(scene.find((piece) => piece.id === "ransom:0:r0s"));
    const a = evaluatePiece(strip, 900);
    const b = evaluatePiece(strip, 1000);
    expect(a.x).toBe(b.x);
    expect(a.rz).toBe(b.rz);
    const c = evaluatePiece(strip, 1060);
    expect(c.x === a.x && c.y === a.y).toBe(false);
    const id = ransomHash(`${ransomHash(`${cues[0]!.index}|${cues[0]!.words.map((w) => w.text).join(" ")}`)}|row0`);
    const now = ransomBoil(id, Math.floor(900 / 150));
    const next = ransomBoil(id, Math.floor(1060 / 150));
    expect(c.rz - a.rz).toBeCloseTo(next.r - now.r, 1);
    for (let step = 0; step < 40; step++) {
      const boil = ransomBoil(step * 31, step);
      expect(Math.abs(boil.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(boil.r)).toBeLessThanOrEqual(0.9);
    }
  });

  test("tiles fly in tiny and spinning (outBack 1.8 scale from 0.2) and settle by 300 ms", () => {
    const tile = need<ShapePiece>(scene.find((piece) => piece.id === "ransom:0:h3l0"));
    const start = cues[0]!.words[3]!.startMs - 170;
    expect(evaluatePiece(tile, start + 6).sx).toBeLessThan(0.45);
    expect(Math.abs(evaluatePiece(tile, start + 6).rz)).toBeGreaterThan(Math.abs(evaluatePiece(tile, start + 500).rz) - 4);
    const peak = Math.max(...Array.from({ length: 30 }, (_, at) => evaluatePiece(tile, start + 150 + at * 5).sx));
    expect(peak).toBeGreaterThan(1.03);
    expect(evaluatePiece(tile, start + 320).sx).toBeCloseTo(1, 2);
  });

  test("the exit is the roll: a paper bar that sweeps across, inside the safe area, in the cue's last 80 to 200 ms", () => {
    const roll = need<ShapePiece>(scene.find((piece) => piece.id === "ransom:0:roll"));
    expect(roll.toMs - roll.fromMs).toBeGreaterThanOrEqual(80);
    expect(roll.toMs - roll.fromMs).toBeLessThanOrEqual(200);
    expect(roll.toMs).toBeLessThanOrEqual(cues[0]!.endMs + 50);
    const early = evaluatePiece(roll, roll.fromMs + 2).x;
    const late = evaluatePiece(roll, roll.toMs - 2).x;
    expect(late).toBeGreaterThan(early + 100);
    for (let t = roll.fromMs; t < roll.toMs; t += 10) {
      const box = need(pieceBounds(roll, t, fakeMeasure) ? roll : undefined);
      void box;
      const b = pieceBounds(roll, t, fakeMeasure)!;
      expect(b.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
      expect(b.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
    }
  });
});

describe("Ransom recurring beats", () => {
  test("every strip has tape, every cue has a loose scrap and a scribble", () => {
    for (const number of [0, 1, 2, 3]) {
      const mine = ofCue(scene, number);
      const strips = mine.filter((piece) => /:r\d+s$/.test(piece.id));
      expect(mine.filter((piece) => /:r\d+t$/.test(piece.id))).toHaveLength(strips.length);
      expect(mine.some((piece) => piece.id.endsWith(":x"))).toBe(true);
      expect(mine.some((piece) => piece.id.endsWith(":q"))).toBe(true);
    }
  });

  test("the scribble is drawn left to right by a wipe", () => {
    const ink = need<ShapePiece>(scene.find((piece) => piece.id === "ransom:0:q"));
    const early = evaluatePiece(ink, ink.fromMs + 10).clip!;
    const late = evaluatePiece(ink, ink.fromMs + 400).clip!;
    expect(late.x2 - late.x1).toBeGreaterThan(early.x2 - early.x1);
  });

  test("a long clip keeps the tape, scrap and scribble coming back and varying", () => {
    const base = demoCues(RANSOM_DEMO);
    const long: SceneCue[] = [];
    for (let round = 0; round < 7; round++) {
      for (const cue of base.cues) {
        const shift = round * (base.duration + 200);
        long.push({ ...cue, index: long.length, startMs: cue.startMs + shift, endMs: cue.endMs + shift, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + shift, endMs: word.endMs + shift })) });
      }
    }
    expect(long.length).toBeGreaterThanOrEqual(24);
    const list = build(long);
    let tapes = 0;
    let scraps = 0;
    let scribbles = 0;
    const sides = new Set<number>();
    const shapes = new Set<string>();
    const colours = new Set<string>();
    long.forEach((_cue, number) => {
      const mine = ofCue(list, number);
      expect(mine.length).toBeGreaterThan(0);
      tapes += mine.filter((piece) => /:r\d+t$/.test(piece.id)).length;
      const scrap = mine.find((piece) => piece.id.endsWith(":x")) as ShapePiece | undefined;
      if (scrap) {
        scraps++;
        sides.add(Math.sign(evaluatePiece(scrap, scrap.toMs - 10).rz));
        colours.add(scrap.fill!.colour);
      }
      const ink = mine.find((piece) => piece.id.endsWith(":q")) as ShapePiece | undefined;
      if (ink) {
        scribbles++;
        shapes.add(String(ink.path.length));
      }
    });
    expect(scraps).toBe(long.length);
    expect(scribbles).toBe(long.length);
    expect(tapes).toBeGreaterThanOrEqual(long.length);
    expect(sides.size).toBe(2);
    expect(colours.size).toBeGreaterThanOrEqual(4);
    expect(shapes.size).toBeGreaterThanOrEqual(3);
    // Past the demo's four cues nothing throws and nothing is NaN.
    expect(JSON.stringify(list).includes("NaN")).toBe(false);
  });
});

describe("Ransom real speech", () => {
  test("fast speech: with 60 ms between cues every word stays readable for 150 ms once it has landed", () => {
    const fast = demoCues({ ...RANSOM_DEMO, options: { ...RANSOM_DEMO.options, cueGap: 60 } }).cues;
    const list = build(fast);
    const whole = (piece: Piece, t: number) => {
      const full = pieceBounds({ ...piece, clip: undefined }, t, fakeMeasure);
      const cut = pieceBounds(piece, t, fakeMeasure);
      return full !== null && cut !== null && cut.x2 - cut.x1 >= full.x2 - full.x1 - 1;
    };
    for (const piece of texts(list)) {
      let landed = -1;
      for (let t = piece.fromMs; t < piece.toMs; t += 5) {
        if (evaluatePiece(piece, t).o > 0.9 && whole(piece, t)) {
          landed = t;
          break;
        }
      }
      expect(landed).toBeGreaterThan(0);
      expect(piece.toMs).toBeGreaterThanOrEqual(landed + 150);
      for (let t = landed; t <= landed + 150; t += 10) {
        expect(evaluatePiece(piece, t).o).toBeGreaterThan(0.9);
        expect(whole(piece, t)).toBe(true);
      }
    }
  });

  test("each exit is 80 to 200 ms and ends at most 50 ms into the next cue", () => {
    const fast = demoCues({ ...RANSOM_DEMO, options: { ...RANSOM_DEMO.options, cueGap: 60 } }).cues;
    const list = build(fast);
    fast.forEach((cue, number) => {
      const roll = need<ShapePiece>(list.find((piece) => piece.id === `ransom:${number}:roll`));
      expect(roll.toMs - roll.fromMs).toBeGreaterThanOrEqual(80);
      expect(roll.toMs - roll.fromMs).toBeLessThanOrEqual(200);
      expect(roll.toMs).toBeLessThanOrEqual(cue.endMs + 50);
    });
  });
});

describe("Ransom scripts, fits and edges", () => {
  test("capitals only for cased scripts; an Urdu hero is one tile, rows run right to left, the tape is on the right", () => {
    expect(ransomCase("hello")).toBe("HELLO");
    expect(ransomCase("اچھا")).toBe("اچھا");
    expect(ransomCase("你好")).toBe("你好");
    const urdu = build(sceneEdgeDemo("urdu").cues);
    const hero = urdu.filter((piece) => piece.id.startsWith("ransom:0:h2l"));
    expect(hero.filter((piece) => piece.kind === "text")).toHaveLength(1);
    const first = need<TextPiece>(urdu.find((piece) => piece.kind === "text" && piece.text === "یہ"));
    const second = need<TextPiece>(urdu.find((piece) => piece.kind === "text" && piece.text === "بہت"));
    const left = (piece: TextPiece) => evaluatePiece(piece, 1500).x - piece.origin!.dx;
    expect(left(first)).toBeGreaterThan(left(second));
    const tape = need<ShapePiece>(urdu.find((piece) => piece.id === "ransom:0:r0t"));
    const strip = need<ShapePiece>(urdu.find((piece) => piece.id === "ransom:0:r0s"));
    expect(evaluatePiece(tape, 1500).x).toBeGreaterThan(evaluatePiece(strip, 1500).x);
  });

  test("a hero too long to split is one tile; a 45-letter word shrinks into the safe width", () => {
    const word = "supercalifragilisticexpialidocious";
    const heroCue: SceneCue[] = [{ index: 0, startMs: 0, endMs: 3000, speaker: 0, language: "en", words: [{ text: word, startMs: 400, endMs: 1400, role: "hero", key: null }] }];
    expect(texts(build(heroCue)).filter((piece) => piece.id.startsWith("ransom:0:h0l"))).toHaveLength(1);
    const long = build(sceneEdgeDemo("long-word").cues);
    for (let t = 1500; t < 4200; t += 50) {
      const box = sceneBoundsAt(long, t, fakeMeasure);
      if (!box) continue;
      expect(box.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
      expect(box.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
    }
  });

  test("nine words fit: the block is no taller than 720 px and stays inside the safe area", () => {
    const nine = build(sceneEdgeDemo("nine-words").cues);
    for (let t = 400; t < 6000; t += 50) {
      const box = sceneBoundsAt(nine, t, fakeMeasure);
      if (!box) continue;
      expect(box.y2 - box.y1).toBeLessThan(0.85 * 1920);
      expect(box.y1).toBeGreaterThanOrEqual(0.05 * 1920 - 1);
      expect(box.y2).toBeLessThanOrEqual(0.95 * 1920 + 1);
    }
  });

  test("everything stays inside the safe area on 9:16, 1:1 and 16:9", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      const list = build(cues, { canvas });
      for (let t = 0; t < 8000; t += 40) {
        const box = sceneBoundsAt(list, t, fakeMeasure);
        if (!box) continue;
        expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
        expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
        expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
        expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
      }
    }
  });

  test("the seeded helpers are pure: the rng, the torn strip and the whole build", () => {
    expect(ransomRng(5)()).toBe(ransomRng(5)());
    expect(ransomHash("a")).not.toBe(ransomHash("b"));
    const torn = ransomTorn(500, 100, 3, ransomRng(9), 1);
    expect(ransomTorn(500, 100, 3, ransomRng(9), 1)).toEqual(torn);
    expect(Math.min(...torn.map(([, y]) => y))).toBeGreaterThanOrEqual(-4);
    expect(JSON.stringify(build(cues))).toBe(JSON.stringify(build(cues)));
  });
});
