import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { POPUP_DEMO, popupBodyBaseline, popupBurstPoints, popupHeroBaseline, popupLetters, popupProgram, popupWindow, popupWordPop } from "./templates/popup";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(POPUP_DEMO);
const COLOURS = { primary: "#FFFFFF", highlight: "#FFE24B", accent: "#FF8FA3", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) => popupProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const scene = build(cues);
const find = (list: readonly Piece[], id: string) => list.find((piece) => piece.id === `popup:${id}`);
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};
const HERO_CUE = 1;
const ofCue = (list: readonly Piece[], cue: number) => list.filter((piece) => piece.id.startsWith(`popup:${cue}:`));
const part = (piece: Piece) => piece.id.split(":")[2]!;

describe("Popup geometry", () => {
  test("the window is 0.84 em + 10 px wider than the letters and 60 px + 1.52 em tall, centred on x 540", () => {
    // The probe's `instant`: letters 640.04 px at 128 px, window 758 x 255.
    expect(popupWindow(128, 640.04)).toEqual({ width: 758, height: 255 });
    const frame = need<ShapePiece>(find(scene, `${HERO_CUE}:win-frame`));
    const rest = evaluatePiece(frame, 3800);
    expect(rest.x).toBeCloseTo(540, 4);
    const right = Math.max(...frame.path.flatMap((cmd) => (cmd[0] === "Z" ? [] : [cmd[1] as number])));
    const letters = ofCue(scene, HERO_CUE).filter((piece): piece is TextPiece => piece.kind === "text" && /^l\d+$/.test(part(piece)));
    const size = letters[0]!.sizePx;
    const lettersWidth = letters.reduce((sum, l) => sum + fakeMeasure(l.text, "Chango", size, 0.01).advance + 0.01 * size, 0);
    expect(right).toBeCloseTo(Math.round(10 + 0.84 * size + lettersWidth), 4);
  });

  test("Chrome's baselines: Lilita 78 of 92 px, Chango 119 of 128 px and 122 of 130 px", () => {
    expect(popupBodyBaseline(92)).toBe(78);
    expect(popupHeroBaseline(128)).toBe(119);
    expect(popupHeroBaseline(130)).toBe(122);
  });

  test("the hero is Chango sized so its letters run 640 px (130 px at most), one piece per letter in four pastels", () => {
    const letters = ofCue(scene, HERO_CUE).filter((piece): piece is TextPiece => piece.kind === "text" && /^l\d+$/.test(part(piece)));
    expect(letters.map((l) => l.text).join("")).toBe("instant");
    expect(letters[0]!.face).toBe("Chango");
    expect(letters.map((l) => l.fill)).toEqual(["#7DE0C1", "#B58CFF", "#FFE24B", "#FF8FA3", "#7DE0C1", "#B58CFF", "#FFE24B"]);
    expect(letters[0]!.stroke!.widthPx).toBeCloseTo(0.035 * letters[0]!.sizePx, 6);
    expect(letters[0]!.shadows![0]).toMatchObject({ blur: 0, colour: "#2A1A5E" });
  });

  test("body words: Lilita One 92 px, a violet outline of 8 px and a hard shadow of 6 / 8", () => {
    const word = need<TextPiece>(find(scene, `${HERO_CUE}:w0`));
    expect(word).toMatchObject({ text: "now", face: "Lilita One", sizePx: 92, fill: "#FFFFFF" });
    expect(word.stroke).toMatchObject({ widthPx: 8, colour: "#2A1A5E" });
    expect(word.shadows![0]).toMatchObject({ dx: 6, dy: 8, blur: 0 });
  });

  test("the starburst is the sample's 13 spikes for the first hero", () => {
    const points = popupBurstPoints(13, 0);
    expect(points.length).toBe(26);
    expect(points[1]).toEqual([expect.any(Number), expect.any(Number)]);
    expect(Math.hypot(...points[1]!)).toBeCloseTo(36, 0);
  });
});

describe("Popup motion", () => {
  test("a body word pops with the sample's spring, rise and tilt over 380 ms from 70 ms before it", () => {
    const cue = cues[HERO_CUE]!;
    const word = cue.words[0]!;
    const piece = need<TextPiece>(find(scene, `${HERO_CUE}:w0`));
    const rest = evaluatePiece(piece, cue.startMs + 600);
    for (const t of [word.startMs - 40, word.startMs + 20, word.startMs + 120, word.startMs + 250]) {
      const pop = popupWordPop(prog(t, word.startMs - 70, 380));
      const pose = evaluatePiece(piece, t);
      expect(pose.sx).toBeCloseTo(pop.scale, 2);
      expect(pose.y - rest.y).toBeCloseTo(pop.rise, 0);
    }
  });

  test("the window opens on the hero word (80 ms before it), never earlier, then the copies cascade 16 and 32 px", () => {
    const hero = cues[HERO_CUE]!.words[3]!;
    const win = need<ShapePiece>(find(scene, `${HERO_CUE}:win-frame`));
    expect(win.fromMs).toBeGreaterThanOrEqual(hero.startMs - 80);
    expect(evaluatePiece(win, hero.startMs - 80 + 4).sx).toBeCloseTo(0.6, 1);
    expect(evaluatePiece(win, hero.startMs + 400).sx).toBeCloseTo(1, 3);
    const copy1 = need<ShapePiece>(find(scene, `${HERO_CUE}:copy1-frame`));
    const copy2 = need<ShapePiece>(find(scene, `${HERO_CUE}:copy2-frame`));
    const at = hero.startMs + 600;
    expect(evaluatePiece(copy1, at).x - evaluatePiece(win, at).x).toBeCloseTo(16, 0);
    expect(evaluatePiece(copy2, at).y - evaluatePiece(win, at).y).toBeCloseTo(32, 0);
    expect(copy1.z).toBeGreaterThan(copy2.z);
    expect(win.z).toBeGreaterThan(copy1.z);
  });

  test("letters pop 9 ms apart, tilt to a third of their random turn, and bob 4 px while the hero holds", () => {
    const hero = cues[HERO_CUE]!.words[3]!;
    const l3 = need<TextPiece>(find(scene, `${HERO_CUE}:l3`));
    const held = demoCues({ lines: ["wait:h@3000"], options: { tail: 3000 } }).cues;
    const l0 = need<TextPiece>(find(build(held), "0:l0"));
    const start = held[0]!.words[0]!.startMs;
    expect(evaluatePiece(l3, hero.startMs - 80 + 3 * 9 + 20).sx).toBeGreaterThan(0);
    const ys: number[] = [];
    for (let t = start + 700; t < start + 1200; t += 20) ys.push(evaluatePiece(l0, t).y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(2 * 4 + 0.5);
    const tilt = (rnd: number) => (rnd - 0.5) * 10 * 0.3;
    expect(Math.abs(evaluatePiece(l0, start + 1500).rz)).toBeLessThanOrEqual(Math.abs(tilt(0)) + 1.5);
  });

  test("the block shrinks to 0.75 about its centre and fades over the 170 ms before end - 40", () => {
    const cue = cues[HERO_CUE]!;
    const word = need<TextPiece>(find(scene, `${HERO_CUE}:w0`));
    const from = cue.endMs - 210;
    const t = from + 85;
    expect(evaluatePiece(word, t).sx).toBeCloseTo(1 - 0.25 * EASES.in(0.5), 2);
    expect(evaluatePiece(word, t).o).toBeCloseTo(1 - EASES.in(0.5), 3);
    expect(word.toMs).toBe(cue.endMs - 40);
  });
});

describe("Popup recurrence and variants", () => {
  const many = (count: number): SceneCue[] => {
    const lines = Array.from({ length: count }, (_, i) => (i % 3 === 2 ? "just:m this:b ok:b" : i % 3 === 1 ? "so:m wild:h@500" : "and:m then:b it:m glowed:h@520"));
    return demoCues({ lines, options: { rate: 270 } }).cues;
  };
  const long = build(many(30));

  test("every cue of a long clip draws its decoration: a window, burst and sparkles with a hero, two sparkles without", () => {
    for (let cue = 0; cue < 30; cue++) {
      const ids = ofCue(long, cue).map(part);
      if (cue % 3 === 2) {
        expect(ids).toContain("sp0");
        expect(ids).toContain("sp1");
        expect(ids.some((id) => id.startsWith("win") || id === "burst")).toBe(false);
      } else {
        expect(ids).toContain("win-frame");
        expect(ids).toContain("burst");
        expect(ids.filter((id) => id.startsWith("sp")).length).toBe(3);
      }
    }
  });

  test("hero cues alternate the cascade side, the starburst place and the pastel the letters start on", () => {
    const heroCues = Array.from({ length: 30 }, (_, i) => i).filter((i) => i % 3 !== 2);
    const side = heroCues.slice(0, 6).map((cue) => {
      const win = need<ShapePiece>(find(long, `${cue}:win-frame`));
      const copy = need<ShapePiece>(find(long, `${cue}:copy1-frame`));
      const at = Math.max(win.toMs, copy.toMs) - 400;
      return Math.sign(evaluatePiece(copy, at).x - evaluatePiece(win, at).x);
    });
    expect(side).toEqual([1, -1, 1, -1, 1, -1]);
    const burstSide = heroCues.slice(0, 6).map((cue) => {
      const win = need<ShapePiece>(find(long, `${cue}:win-frame`));
      const burst = need<ShapePiece>(find(long, `${cue}:burst`));
      const at = win.toMs - 300;
      return Math.sign(evaluatePiece(burst, at).x - evaluatePiece(win, at).x);
    });
    expect(burstSide).toEqual([-1, 1, 0, -1, 1, 0]);
    const first = heroCues.slice(0, 5).map((cue) => need<TextPiece>(find(long, `${cue}:l0`)).fill);
    expect(new Set(first).size).toBe(4);
  });

  test("a hero's starburst and sparkles keep turning and twinkling while a long hold lasts", () => {
    const slow = demoCues({ lines: ["wait:h@3000"], options: { tail: 3000 } }).cues;
    const list = build(slow);
    const burst = need<ShapePiece>(find(list, "0:burst"));
    const a = evaluatePiece(burst, 1500).rz;
    const b = evaluatePiece(burst, 3000).rz;
    expect(b - a).toBeCloseTo(0.006 * 1500, 0);
    const sparkle = need<ShapePiece>(find(list, "0:sp0"));
    const scales = Array.from({ length: 40 }, (_, i) => evaluatePiece(sparkle, 1500 + i * 50).sx);
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.1);
  });

  test("a 30 cue clip stays inside the safe area in 9:16, 1:1 and 16:9", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      const list = build(many(12), { canvas, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } });
      for (let t = 0; t < 12000; t += 40) {
        const box = sceneBoundsAt(list, t, fakeMeasure);
        if (!box) continue;
        expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
        expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
        expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
        expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
      }
    }
  });
});

describe("Popup real speech and scripts", () => {
  test("fast speech (cue gap 60 ms): every word stays fully visible for 150 ms after it lands", () => {
    const tight = demoCues({ ...POPUP_DEMO, options: { ...POPUP_DEMO.options, cueGap: 60 } }).cues;
    const list = build(tight);
    for (const cue of tight) {
      cue.words.forEach((word, at) => {
        const isHero = word.role === "hero" && cue.words.findIndex((w) => w.role === "hero") === at;
        const pieces = ofCue(list, cue.index).filter((piece) => (isHero ? /^l\d+$/.test(part(piece)) : part(piece) === `w${at}`));
        expect(pieces.length).toBeGreaterThan(0);
        for (const piece of pieces) {
          const stagger = isHero ? 9 * Number(part(piece).slice(1)) : 0;
          for (let t = word.startMs + stagger; t <= word.startMs + stagger + 150; t += 10) {
            const pose = evaluatePiece(piece, t);
            expect(pose.visible).toBe(true);
            expect(pose.o).toBeGreaterThan(0.9);
          }
        }
      });
    }
  });

  test("a shaped script (Urdu) is never split into letters; the hero pops as one word and the chrome mirrors", () => {
    expect(popupLetters("اچھا")).toEqual(["اچھا"]);
    expect(popupLetters("नमस्ते")).toEqual(["नमस्ते"]);
    expect(popupLetters("你好")).toEqual(["你好"]);
    expect(popupLetters("café")).toEqual(["c", "a", "f", "é"]);
    expect(popupLetters("x".repeat(40))).toEqual(["x".repeat(40)]);
    const urdu = sceneEdgeDemo("urdu").cues;
    const list = build(urdu);
    const heroLetters = ofCue(list, 0).filter((piece) => /^l\d+$/.test(part(piece)));
    expect(heroLetters.length).toBe(1);
    const dot = need<ShapePiece>(find(list, "0:dot0"));
    const win = need<ShapePiece>(find(list, "0:win-frame"));
    expect(evaluatePiece(dot, 1500).x).toBeGreaterThan(evaluatePiece(win, 1500).x);
  });

  test("a hero too long for the window shrinks it into the safe width", () => {
    const longHero = demoCues({ lines: ["it's:m internationalization:h@900 again:b"] }).cues;
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      const list = build(longHero, { canvas, anchor: { xPct: 50, yPct: 67 } });
      const letters = ofCue(list, 0).filter((piece): piece is TextPiece => /^l\d+$/.test(part(piece)));
      expect(letters.length).toBe(20);
      expect(letters[0]!.sizePx).toBeLessThan(130);
    }
  });
});
