import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, clamp, lerp, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";
import { WALLPAPER_DEMO, wallpaperHash, wallpaperProgram, wallpaperSchemes } from "./templates/wallpaper";

const COLOURS = { primary: "#F6F1E9", highlight: "#FF6B43", accent: "#25222A", shadow: "#000000" };
const ANCHOR = { xPct: 50, yPct: (1290 / 1920) * 100 };
const build = (list: readonly SceneCue[], overrides = {}) => wallpaperProgram.build(sceneInput(list, { anchor: ANCHOR, colours: COLOURS, ...overrides })).pieces;
const { cues } = demoCues(WALLPAPER_DEMO);
const scene = build(cues);
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const ofCue = (list: readonly Piece[], n: number) => list.filter((piece) => cueOf(piece) === n);
const texts = (list: readonly Piece[]) => list.filter((piece): piece is TextPiece => piece.kind === "text");
const walls = (list: readonly Piece[], n: number) => texts(ofCue(list, n)).filter((piece) => /:s[ud]\d/.test(piece.id));
const words = (list: readonly Piece[], n: number) => texts(ofCue(list, n)).filter((piece) => /:w\d/.test(piece.id));
const at = (id: string, t: number) => evaluatePiece(scene.find((piece) => piece.id === id)!, t);

/** The sample's panel rect (px of its frame) from the same formula, for rows of the given visible widths. */
function panel(t: number, opts: { start: number; rowW: number; lineH: number; heroStart: number | null; end: number }) {
  const rowsShown = 1;
  const pillW = opts.rowW + 92;
  const pillH = rowsShown * opts.lineH + 44;
  const open = opts.heroStart === null ? 0 : EASES.outExpo(prog(t, opts.heroStart - 60, 360)) * (1 - EASES.inOut(prog(t, opts.end - 200, 160)));
  const pw = lerp(pillW, Math.max(pillW, 880), open);
  const ph = lerp(pillH, 5 * opts.lineH + 44, open);
  const w = lerp(pillH, pw, EASES.outExpo(prog(t, opts.start - 80, 300)));
  return { w, h: ph, rad: lerp(pillH / 2, 34, open) };
}

describe("Wallpaper geometry", () => {
  test("a plain cue is 70 px capitals in the Expanded ExtraBold, on a pill hugging its row", () => {
    const first = texts(ofCue(scene, 0));
    expect(first.every((piece) => piece.face === "Archivo Expanded ExtraBold" && piece.sizePx === 70 && piece.letterSpacingEm === -0.005)).toBe(true);
    expect(words(scene, 0).map((piece) => piece.text)).toEqual(["STOP", "CHASING", "EVERY", "NEW", "TREND"]);
    // The vertical band is the pill's body at rest: its width is the row plus the padding less the two radii.
    const rest = 1900;
    const v = scene.find((piece) => piece.id.startsWith("wallpaper:0:v")) as ShapePiece;
    const pose = evaluatePiece(v, rest);
    expect(pose.visible).toBe(true);
    expect(pose.y).toBeCloseTo(1290, 3);
  });

  test("the panel is the sample's rect: its discs sit a radius inside the corners, its bands fill the rest", () => {
    const cue = cues[1]!;
    const heroStart = cue.words[1]!.startMs;
    const t = heroStart + 700;
    const lineH = 1.06 * evaluatePiece(words(scene, 1)[0]!, t).sy * 0 + 1.06 * words(scene, 1)[0]!.sizePx;
    const rect = panel(t, { start: cue.startMs, rowW: 0, lineH, heroStart, end: cue.endMs });
    const tl = at("wallpaper:1:tl", t);
    const br = at("wallpaper:1:br", t);
    const radius = (evaluatePiece(scene.find((piece) => piece.id === "wallpaper:1:tl")!, t).sx * 100) / 2;
    expect(radius).toBeCloseTo(34, 1);
    // Fully open: height 5 rows + 44, corner discs at the corners of the band.
    expect(br.y - tl.y).toBeCloseTo(rect.h - 2 * 34, 1);
    expect(br.x - tl.x).toBeGreaterThan(rect.rad);
    expect(tl.x + br.x).toBeCloseTo(2 * 540, 1);
  });

  test("a hero cue sizes to its row (at most 100 px) and gets four strips of the hero word", () => {
    const hero = texts(ofCue(scene, 1)).find((piece) => piece.fill === scene.find((p) => p.id === "wallpaper:1:w1l0")!.fill && piece.id.includes(":s"))!;
    expect(hero).toBeUndefined();
    const sizes = new Set(words(scene, 1).concat(texts(ofCue(scene, 1)).filter((piece) => /:w1l/.test(piece.id))).map((piece) => piece.sizePx));
    expect(sizes.size).toBe(1);
    expect([...sizes][0]!).toBeLessThanOrEqual(100);
    const strips = new Set(walls(scene, 1).map((piece) => piece.id.split(":")[2]!.replace(/c.*/, "")));
    expect([...strips].sort()).toEqual(["sd1", "sd2", "su1", "su2"]);
    expect(walls(scene, 1).every((piece) => piece.text === "ONE")).toBe(true);
    // The hero types on letter by letter in the bright colour.
    const letters = texts(ofCue(scene, 1)).filter((piece) => /:w1l\d/.test(piece.id));
    expect(letters.map((piece) => piece.text).join("")).toBe("ONE");
    expect(letters.every((piece) => piece.fill === "#FF6B43")).toBe(true);
    expect(letters[1]!.fromMs).toBeGreaterThan(letters[0]!.fromMs);
  });

  test("colourways follow a cue counter: charcoal, charcoal, cream, cream, charcoal", () => {
    const [charcoal, cream] = wallpaperSchemes(COLOURS);
    const panelColour = (n: number) => (scene.find((piece) => piece.id === `wallpaper:${n}:tl`) as ShapePiece).fill!.colour;
    expect([0, 1, 2, 3, 4].map(panelColour)).toEqual([charcoal.panel, charcoal.panel, cream.panel, cream.panel, charcoal.panel]);
    expect(charcoal.panel).toBe("#25222A");
    // The cream hero is the highlight darkened, the wall a tint of the hero's hue (warm grey-brown, then its complement).
    expect(cream.hero).not.toBe(charcoal.hero);
    expect(charcoal.wall).toMatch(/^#[0-9A-F]{6}$/);
    expect(cream.wall).not.toBe(charcoal.wall);
  });
});

describe("Wallpaper motion", () => {
  test("words rise in over 240 ms from 0.2 em below and fade in three times as fast (the sample's formula)", () => {
    // One row, so the line does not move as rows are added.
    const word = { text: "so", startMs: 400, endMs: 700, role: "body" as const, key: null };
    const single: SceneCue[] = [{ index: 0, startMs: 400, endMs: 3000, speaker: 0, language: "en", words: [word] }];
    const piece = words(build(single), 0)[0]!;
    const base = evaluatePiece(piece, word.startMs + 900).y;
    for (const dt of [-40, 0, 80, 200]) {
      const t = word.startMs + dt;
      const p = EASES.outExpo(prog(t, word.startMs - 60, 240));
      const pose = evaluatePiece(piece, t);
      expect(pose.y - base).toBeCloseTo((1 - p) * 70 * 0.2, 0);
      expect(pose.o).toBeCloseTo(clamp(p * 3), 1);
    }
  });

  test("hero letters type on 55 ms apart (240 / n at most) and bounce on a spring from 0.22 em below", () => {
    const letters = texts(ofCue(scene, 1)).filter((piece) => /:w1l\d/.test(piece.id));
    const start = cues[1]!.words[1]!.startMs - 60;
    expect(letters.map((piece) => piece.fromMs)).toEqual([start, start + 55, start + 110]);
    const size = letters[0]!.sizePx;
    const rest = evaluatePiece(letters[0]!, start + 900).y;
    for (const dt of [0, 60, 150, 280]) expect(evaluatePiece(letters[0]!, start + dt).y - rest).toBeCloseTo((1 - EASES.spring(prog(start + dt, start, 300))) * size * 0.22, 0);
  });

  test("the wallpaper unfolds outward from the live line two frames apart, then drifts in alternating directions", () => {
    const heroStart = cues[1]!.words[1]!.startMs;
    const strip = (id: string) => walls(scene, 1).filter((piece) => piece.id.includes(`:${id}c`));
    const first = (id: string) => Math.min(...strip(id).map((piece) => piece.fromMs));
    expect(first("su2") - first("su1")).toBeGreaterThanOrEqual(55);
    expect(first("su1")).toBeLessThanOrEqual(heroStart + 5);
    const copy = (id: string) => strip(id).find((piece) => piece.fromMs <= heroStart + 600 && piece.toMs >= heroStart + 1200)!;
    const dx = (id: string) => evaluatePiece(copy(id), heroStart + 1200).x - evaluatePiece(copy(id), heroStart + 700).x;
    expect(dx("su1")).toBeGreaterThan(20);
    expect(dx("su2")).toBeLessThan(-20);
    expect(Math.sign(dx("sd1"))).toBe(Math.sign(dx("su1")));
    // Each strip unfolds about its edge nearest the live line.
    const above = copy("su1");
    expect(evaluatePiece(above, heroStart + 30).sy).toBeLessThan(evaluatePiece(above, heroStart + 400).sy);
    expect(above.origin!.dy).toBeGreaterThan(0);
    expect(copy("sd1").origin!.dy).toBeLessThan(0);
  });

  test("a hero cue after another one runs the brick variant: reversed drift, odd rows offset", () => {
    const second = walls(scene, 3);
    const heroStart = cues[3]!.words[1]!.startMs;
    const copy = (id: string) => second.filter((piece) => piece.id.includes(`:${id}c`)).find((piece) => piece.fromMs <= heroStart + 400 && piece.toMs >= heroStart + 900)!;
    const dx = (id: string) => evaluatePiece(copy(id), heroStart + 900).x - evaluatePiece(copy(id), heroStart + 400).x;
    expect(dx("su1")).toBeLessThan(-20);
    expect(dx("su2")).toBeGreaterThan(20);
  });

  test("the exit scales the group to 0.94 and fades it, ending with the cue", () => {
    const cue = cues[1]!;
    const word = scene.find((piece) => piece.id === "wallpaper:1:w0") as TextPiece;
    const end = word.toMs;
    expect(end).toBeGreaterThanOrEqual(cue.endMs - 1);
    expect(evaluatePiece(word, end - 1).sx).toBeCloseTo(0.94, 2);
    expect(evaluatePiece(word, end - 1).o).toBeLessThan(0.05);
    expect(evaluatePiece(word, cue.endMs - 260).sx).toBe(1);
  });
});

describe("Wallpaper on real speech", () => {
  const fast = demoCues({ ...WALLPAPER_DEMO, options: { ...WALLPAPER_DEMO.options, cueGap: 60 } });
  const list = build(fast.cues);

  test("every word is whole and visible for 150 ms after it lands (cueGap 60)", () => {
    for (const cue of fast.cues) {
      const n = cue.index;
      for (const piece of texts(ofCue(list, n)).filter((p) => /:w\d/.test(p.id))) {
        const land = /l\d+$/.test(piece.id) ? piece.fromMs : cue.words[Number(piece.id.match(/:w(\d+)/)![1])]!.startMs;
        for (let t = land; t <= land + 150; t += 10) {
          const pose = evaluatePiece(piece, t);
          expect(pose.visible).toBe(true);
          expect(pose.o).toBeGreaterThan(0.9);
        }
      }
    }
  });

  test("a cue is gone 40 ms after its end at the latest", () => {
    for (const cue of fast.cues) {
      const last = Math.max(...ofCue(list, cue.index).map((piece) => piece.toMs));
      expect(last).toBeLessThanOrEqual(cue.endMs + 41);
    }
  });

  test("a clip of 25 cues keeps its wallpaper recurring and varying", () => {
    const lines = Array.from({ length: 5 }, () => WALLPAPER_DEMO.lines).flat();
    const long = demoCues({ ...WALLPAPER_DEMO, lines });
    const pieces = build(long.cues);
    const hero = long.cues.filter((cue) => cue.words.some((word) => word.role === "hero"));
    expect(hero.length).toBe(15);
    for (const cue of hero) expect(walls(pieces, cue.index).length).toBeGreaterThanOrEqual(8);
    // The rows' relative motion (row 1 against row 2) is the drift alone: the words landing shift both alike.
    const direction = hero.map((cue) => {
      const heroStart = cue.words.find((word) => word.role === "hero")!.startMs;
      const pick = (id: string) => walls(pieces, cue.index).find((piece) => piece.id.includes(`:${id}c`) && piece.fromMs <= heroStart + 300 && piece.toMs >= heroStart + 700)!;
      const gap = (t: number) => evaluatePiece(pick("su1"), t).x - evaluatePiece(pick("su2"), t).x;
      return Math.sign(gap(heroStart + 700) - gap(heroStart + 300));
    });
    expect(new Set(direction).size).toBe(2);
    expect(direction.slice(0, 4)).toEqual([direction[0], -direction[0]!, direction[0], -direction[0]!]);
    expect(direction.every((sign) => sign !== 0)).toBe(true);
    // Plain cues alternate their rise, and every cue stays within the piece budget.
    const rises = long.cues.filter((cue) => !cue.words.some((word) => word.role === "hero")).map((cue) => {
      const piece = words(pieces, cue.index)[0]!;
      return Math.sign(evaluatePiece(piece, cue.words[0]!.startMs - 55).y - evaluatePiece(piece, cue.words[0]!.startMs + 900).y);
    });
    expect(new Set(rises).size).toBe(2);
    const counts = new Map<number, number>();
    for (const piece of pieces) counts.set(cueOf(piece), (counts.get(cueOf(piece)) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(150);
  });
});

describe("Wallpaper fit and scripts", () => {
  const word = (text: string, startMs: number, role: "hero" | "body" = "body") => ({ text, startMs, endMs: startMs + 260, role, key: null });
  const one = (words: ReturnType<typeof word>[], language = "en"): SceneCue[] => [{ index: 0, startMs: 0, endMs: 3000, speaker: 0, language, words }];
  const inside = (list: readonly Piece[], width: number, height: number, tail = 60) => {
    for (let t = 0; t < 3300; t += 50) {
      const box = sceneBoundsAt(list, t, fakeMeasure);
      if (!box) continue;
      expect(box.x1).toBeGreaterThanOrEqual(0.05 * width - tail);
      expect(box.x2).toBeLessThanOrEqual(0.95 * width + tail);
      expect(box.y1).toBeGreaterThanOrEqual(0.05 * height - tail);
      expect(box.y2).toBeLessThanOrEqual(0.95 * height + tail);
    }
  };

  test("a long hero word shrinks the cue, a long cue of nine words wraps evenly, on every frame shape", () => {
    for (const [width, height] of [[1080, 1920], [1080, 1080], [1920, 1080]] as const) {
      for (const kind of ["long-word", "nine-words", "one-word", "urdu"] as const) {
        const list = build(sceneEdgeDemo(kind).cues, { canvas: { width, height }, anchor: { xPct: 50, yPct: 66 } });
        expect(list.length).toBeGreaterThan(0);
        inside(list, width, height, 2);
      }
    }
    const nine = words(build(sceneEdgeDemo("nine-words").cues), 0);
    expect(new Set(nine.map((piece) => Math.round(evaluatePiece(piece, 1500).y))).size).toBeGreaterThan(1);
  });

  test("a hero too wide for a row wraps below 60 px and the wallpaper fills the rows around the block", () => {
    const list = build(one([word("one", 0), word("really", 300), word("quite", 600), word("long", 900), word("THEMES", 1200, "hero"), word("indeed", 1500)]));
    const sizes = new Set(texts(list).map((piece) => piece.sizePx));
    expect([...sizes].every((size) => size >= 55)).toBe(true);
    const ys = new Set(words(list, 0).map((piece) => Math.round(evaluatePiece(piece, 2500).y)));
    expect(ys.size).toBeGreaterThan(1);
  });

  test("Urdu and Devanagari words are never split into letters; Latin heroes are", () => {
    const urdu = build(one([word("یہ", 0), word("بہت", 300), word("اہم", 600, "hero")], "ur"));
    expect(texts(urdu).some((piece) => /l\d+$/.test(piece.id))).toBe(false);
    const hindi = build(one([word("यह", 0), word("बहुत", 300), word("महत्वपूर्ण", 600, "hero")], "hi"));
    expect(texts(hindi).some((piece) => /l\d+$/.test(piece.id))).toBe(false);
    expect(texts(hindi).find((piece) => piece.text === "महत्वपूर्ण")).toBeDefined();
    const latin = build(one([word("so", 0), word("DONE", 300, "hero")]));
    expect(texts(latin).some((piece) => /l\d+$/.test(piece.id))).toBe(true);
  });

  test("a right-to-left cue builds its rows from the right: the first word is the rightmost", () => {
    const list = build(one([word("یہ", 0), word("بہت", 300), word("اچھا", 600)], "ur"));
    const [first, second, third] = words(list, 0).map((piece) => evaluatePiece(piece, 2400).x);
    expect(first!).toBeGreaterThan(second!);
    expect(second!).toBeGreaterThan(third!);
  });

  test("capitals apply to cased scripts only", () => {
    const list = build(one([word("café", 0), word("日本語", 300), word("اہم", 600)], "en"));
    expect(words(list, 0).map((piece) => piece.text)).toEqual(["CAFÉ", "日本語", "اہم"]);
  });

  test("the hash is deterministic and spread", () => {
    expect(wallpaperHash("1:pick one idea")).toBe(wallpaperHash("1:pick one idea"));
    expect(wallpaperHash("a")).not.toBe(wallpaperHash("b"));
  });
});
