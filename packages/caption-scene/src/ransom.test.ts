import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, lerp, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, pieceBounds, pieceLocalBox, sceneBoundsAt } from "./scene";
import { pathBounds } from "./shapes";
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
    const start = cues[0]!.words[3]!.startMs - 100;
    expect(evaluatePiece(tile, start + 6).sx).toBeLessThan(0.45);
    expect(Math.abs(evaluatePiece(tile, start + 6).rz)).toBeGreaterThan(Math.abs(evaluatePiece(tile, start + 500).rz) - 4);
    const peak = Math.max(...Array.from({ length: 30 }, (_, at) => evaluatePiece(tile, start + 150 + at * 5).sx));
    expect(peak).toBeGreaterThan(1.03);
    expect(evaluatePiece(tile, start + 320).sx).toBeCloseTo(1, 2);
  });

  test("the exit is the roll: a paper bar that sweeps across, inside the safe area, in the cue's last 40 to 200 ms", () => {
    const roll = need<ShapePiece>(scene.find((piece) => piece.id === "ransom:0:roll"));
    expect(roll.toMs - roll.fromMs).toBeGreaterThanOrEqual(40);
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

  test("each exit is 40 to 200 ms and ends at most 50 ms into the next cue", () => {
    const fast = demoCues({ ...RANSOM_DEMO, options: { ...RANSOM_DEMO.options, cueGap: 60 } }).cues;
    const list = build(fast);
    fast.forEach((cue, number) => {
      const roll = need<ShapePiece>(list.find((piece) => piece.id === `ransom:${number}:roll`));
      expect(roll.toMs - roll.fromMs).toBeGreaterThanOrEqual(40);
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

/** The piece's whole drawing is inside its clip at `t`. */
const whole = (piece: Piece, t: number) => {
  const full = pieceBounds({ ...piece, clip: undefined }, t, fakeMeasure);
  const cut = pieceBounds(piece, t, fakeMeasure);
  return full !== null && cut !== null && cut.x2 - cut.x1 >= full.x2 - full.x1 - 1 && cut.y2 - cut.y1 >= full.y2 - full.y1 - 1;
};
const mkCue = (index: number, startMs: number, endMs: number, words: { text: string; startMs: number; endMs: number; role?: "hero" | "body" | "minor" }[], language = "en"): SceneCue => ({
  index,
  startMs,
  endMs,
  speaker: 0,
  language,
  words: words.map((word) => ({ ...word, role: word.role ?? "body", key: null })),
});

describe("Ransom review fixes", () => {
  test("1. a cue shifted into the safe area by the anchor keeps every word (clips follow the block, not the canvas edge)", () => {
    const cue = mkCue(0, 300, 3600, [
      { text: "taste", startMs: 400, endMs: 800 },
      { text: "skill", startMs: 900, endMs: 1500, role: "hero" },
      { text: "nobody", startMs: 1600, endMs: 2000 },
      { text: "makes", startMs: 2100, endMs: 2500 },
    ]);
    for (const yPct of [10, 90]) {
      const list = build([cue], { anchor: { xPct: 50, yPct } });
      const t = 3000;
      for (const piece of texts(list)) {
        expect(evaluatePiece(piece, t).visible).toBe(true);
        expect(whole(piece, t)).toBe(true);
      }
      expect(texts(list).some((piece) => piece.text === "MAKES")).toBe(true);
    }
  });

  test("2. a fast hero keeps the whole word readable for 150 ms after its last tile settles", () => {
    const first = mkCue(0, 1000, 1160, [{ text: "unbelievable", startMs: 1000, endMs: 1100, role: "hero" }]);
    const second = mkCue(1, 1160, 2600, [{ text: "next", startMs: 1160, endMs: 1500 }]);
    const list = build([first, second]);
    const tiles = texts(ofCue(list, 0)).filter((piece) => piece.id.includes(":h0l"));
    expect(tiles).toHaveLength(12);
    const ready = (t: number) => tiles.every((piece) => {
      const pose = evaluatePiece(piece, t);
      return pose.visible && pose.o > 0.9 && Math.abs(pose.sx - 1) < 0.03 && whole(piece, t);
    });
    // Handoff rule: readable for min(150, the time from landing to the next cue's first visible frame).
    const nextFirst = Math.min(...ofCue(list, 1).map((piece) => piece.fromMs));
    let landed = -1;
    let run = 0;
    let best = 0;
    for (let t = 800; t < 1400; t += 2) {
      if (ready(t)) {
        if (landed < 0) landed = t;
        run += 2;
      } else run = 0;
      best = Math.max(best, run);
    }
    expect(landed).toBeGreaterThan(0);
    expect(best).toBeGreaterThanOrEqual(Math.min(150, nextFirst - landed) - 4);
  });

  test("3. a mixed right-to-left and left-to-right row reveals each word at its own start and never takes one back", () => {
    const starts = [400, 900, 1400, 1900];
    const cue = mkCue(0, 300, 3200, ["یہ", "ABC", "DEF", "بہت"].map((text, at) => ({ text, startMs: starts[at]!, endMs: starts[at]! + 400 })), "ur");
    const list = build([cue]);
    const words = texts(list).filter((piece) => /:r\d+w\d$/.test(piece.id));
    expect(words).toHaveLength(4);
    for (const [at, text] of ["یہ", "ABC", "DEF", "بہت"].entries()) {
      const piece = need<TextPiece>(words.find((word) => word.text === text));
      let shown = -1;
      for (let t = piece.fromMs; t < piece.toMs; t += 5) {
        const visible = evaluatePiece(piece, t).o > 0.5 && whole(piece, t);
        if (visible && shown < 0) shown = t;
        if (shown >= 0 && t < 2800) expect(visible).toBe(true);
      }
      expect(shown).toBeGreaterThanOrEqual(starts[at]! - 100);
      expect(shown).toBeLessThanOrEqual(starts[at]! + 100);
    }
  });

  test("4. the largest size on landscape stays inside the safe area, entrance and roll included", () => {
    const cue = mkCue(0, 300, 3600, [
      { text: "taste", startMs: 400, endMs: 800 },
      { text: "skill", startMs: 900, endMs: 1500, role: "hero" },
      { text: "nobody", startMs: 1600, endMs: 2000 },
      { text: "makes", startMs: 2100, endMs: 2500 },
    ]);
    for (const canvas of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }]) {
      const list = build([cue], { canvas, scale: 200 / 118 });
      for (let t = 300; t < 3700; t += 16) {
        const box = sceneBoundsAt(list, t, fakeMeasure);
        if (!box) continue;
        expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
        expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
        expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
        expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
      }
    }
  });

  test("5. a strip is sized from its ink: a tall script stays on the paper and the scribble sits below it", () => {
    const deep = (text: string, face: Parameters<typeof fakeMeasure>[1], size: number, ls: number) => ({ ...fakeMeasure(text, face, size, ls), inkBottom: /[\u0600-\u06FF]/.test(text) ? 0.5 * size : 0.2 * size });
    const list = build(sceneEdgeDemo("urdu").cues, { measure: deep });
    for (const cueNumber of [0, 1]) {
      const mine = ofCue(list, cueNumber);
      for (const strip of mine.filter((piece): piece is ShapePiece => piece.kind === "shape" && /:r\d+s$/.test(piece.id))) {
        const row = strip.id.replace(/s$/, "");
        const bottom = pathBounds(strip.path).y2 - strip.origin!.dy;
        for (const word of texts(mine).filter((piece) => piece.id.startsWith(`${row}w`))) {
          const local = pieceLocalBox(word, deep);
          expect(local.y2 - word.origin!.dy).toBeLessThanOrEqual(bottom + 0.5);
        }
      }
    }
    const second = ofCue(list, 1);
    const strips = second.filter((piece): piece is ShapePiece => piece.kind === "shape" && /:r\d+s$/.test(piece.id));
    const last = strips[strips.length - 1]!;
    const ink = need<ShapePiece>(second.find((piece) => piece.id.endsWith(":q")));
    const t = Math.max(ink.fromMs, last.fromMs) + 600;
    const lastBottom = evaluatePiece(last, t).y + (pathBounds(last.path).y2 - last.origin!.dy);
    const inkTop = evaluatePiece(ink, t).y + Math.min(...ink.path.flatMap((cmd) => (cmd[0] === "Z" ? [] : [cmd[cmd.length - 1] as number]))) - 3.5;
    expect(inkTop).toBeGreaterThanOrEqual(lastBottom - 1);
  });

  test("6. a clip whose edges meet is zero width, never inverted", () => {
    const { cues: fast } = demoCues({ lines: ["first:b@55 third:b@55", "x:b@55 y:b@55"], options: { gap: 0, cueGap: 0, lead: 0, tail: 0 } });
    const list = build(fast);
    for (let t = 0; t < 600; t += 5) {
      for (const piece of list) {
        const pose = evaluatePiece(piece, t);
        if (pose.visible && pose.clip) expect(pose.clip.x1).toBeLessThanOrEqual(pose.clip.x2 + 1e-6);
      }
    }
  });
});

/** A run of cues the way real fast speech comes: 150 ms words, a 100 ms hero last, `gap` ms between cues. */
function fastRun(cuesCount: number, gap: number): SceneCue[] {
  const out: SceneCue[] = [];
  let t = 400;
  for (let n = 0; n < cuesCount; n++) {
    const words = [`alpha${"abcdefghijklmnop"[n]}`, `beta${"abcdefghijklmnop"[n]}`, `unbelievable${"abcdefghijklmnop"[n]}`.slice(0, 12)].map((text, at) => {
      const hero = at === 2;
      const dur = hero ? 100 : 150;
      const startMs = t;
      t += dur;
      return { text: at === 2 ? "unbelievable" : text, startMs, endMs: startMs + dur, role: (hero ? "hero" : "body") as "hero" | "body" };
    });
    t += gap;
    out.push(mkCue(n, words[0]!.startMs, t, words));
  }
  const last = out[out.length - 1]!;
  out[out.length - 1] = { ...last, endMs: last.words[last.words.length - 1]!.endMs + 650 };
  return out;
}
const frameTimes = (from: number, to: number) => {
  const times: number[] = [];
  for (let k = Math.ceil((from * 30) / 1000); (k * 1000) / 30 < to; k++) times.push(Math.round((k * 1000) / 30));
  return times;
};

describe("Ransom cue handoff rule", () => {
  for (const gap of [0, 60]) {
    test(`a ${gap} ms gap run of 12 fast cues: entrances locked to speech, nothing covers an outgoing word, nothing flashes`, () => {
      const run = fastRun(12, gap);
      const list = build(run);
      const mineOf = (n: number) => ofCue(list, n);
      run.forEach((cue, n) => {
        const mine = mineOf(n);
        const next = mineOf(n + 1);
        const nextFirst = next.length > 0 ? Math.min(...next.map((piece) => piece.fromMs)) : Number.POSITIVE_INFINITY;
        // No covering: the outgoing cue is gone before the incoming one has a first visible frame.
        expect(Math.max(...mine.map((piece) => piece.toMs))).toBeLessThanOrEqual(nextFirst);
        // Continuous speech does not blink: the outgoing cue ends where the incoming one first shows.
        if (next.length > 0) expect(Math.max(...mine.map((piece) => piece.toMs))).toBe(nextFirst);
        // The last cue finishes inside the clip.
        if (n === run.length - 1) expect(Math.max(...mine.map((piece) => piece.toMs))).toBeLessThanOrEqual(cue.endMs);
        for (const [at, word] of cue.words.entries()) {
          const pieces = word.role === "hero" ? texts(mine).filter((piece) => piece.id.includes(`:h${at}l`)) : texts(mine).filter((piece) => piece.text === word.text.toUpperCase());
          expect(pieces.length).toBeGreaterThan(0);
          const shown = (piece: TextPiece, t: number) => evaluatePiece(piece, t).visible && evaluatePiece(piece, t).o > 0.05 && pieceBounds(piece, t, fakeMeasure) !== null;
          const first = Math.min(...pieces.map((piece) => frameTimes(piece.fromMs, piece.toMs).find((t) => shown(piece, t)) ?? Number.POSITIVE_INFINITY));
          expect(first).toBeGreaterThanOrEqual(word.startMs - 100 - 34);
          expect(first).toBeLessThanOrEqual(word.startMs + 34);
          // Readable from landing for min(150, time to the next cue's first frame).
          const ready = (t: number) => pieces.every((piece) => {
            const pose = evaluatePiece(piece, t);
            return pose.visible && pose.o > 0.9 && (word.role !== "hero" || Math.abs(pose.sx - 1) < 0.03) && whole(piece, t);
          });
          const times = frameTimes(first, Math.max(...pieces.map((piece) => piece.toMs)));
          const landed = times.find((t) => ready(t));
          if (landed === undefined) {
            expect(nextFirst - first).toBeLessThanOrEqual(150 + 34);
            continue;
          }
          let end = landed;
          for (const t of times.filter((time) => time >= landed)) {
            if (!ready(t)) break;
            end = t + 33;
          }
          expect(end - landed).toBeGreaterThanOrEqual(Math.min(150, nextFirst - landed) - 34);
        }
      });
      // No animated piece is visible on exactly one 30 fps frame.
      for (const piece of list) expect(frameTimes(piece.fromMs, piece.toMs).length).not.toBe(1);
    });
  }

  test("the roll sweeps over at least two frames or is not drawn at all", () => {
    for (const gap of [0, 60]) {
      const first = mkCue(0, 1000, 1100 + gap, [{ text: "unbelievable", startMs: 1000, endMs: 1100, role: "hero" }]);
      const second = mkCue(1, 1100 + gap, 2600, [{ text: "overwhelming", startMs: 1100 + gap, endMs: 1200 + gap, role: "hero" }]);
      const list = build([first, second]);
      const roll = list.find((piece) => piece.id === "ransom:0:roll");
      if (roll) expect(frameTimes(roll.fromMs, roll.toMs).length).toBeGreaterThanOrEqual(2);
      // And the incoming tiles never overlap the outgoing ones in time.
      expect(Math.max(...ofCue(list, 0).map((piece) => piece.toMs))).toBeLessThanOrEqual(Math.min(...ofCue(list, 1).map((piece) => piece.fromMs)));
    }
  });

  test("the loose scrap's entrance stays inside the safe area at the largest size, top anchor, 16:9", () => {
    const canvas = { width: 1920, height: 1080 };
    const list = build(sceneEdgeDemo("one-word").cues, { canvas, scale: 200 / 118, anchor: { xPct: 50, yPct: 10 } });
    for (const number of [0, 1]) {
      const scrap = need<ShapePiece>(ofCue(list, number).find((piece) => piece.id.endsWith(":x")));
      for (let t = scrap.fromMs; t < scrap.toMs; t++) {
        const box = pieceBounds(scrap, t, fakeMeasure);
        if (!box) continue;
        expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 0.5);
        expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 0.5);
        expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 0.5);
        expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 0.5);
      }
    }
  });
});
