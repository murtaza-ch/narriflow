import { describe, expect, test } from "bun:test";
import { type DemoScript, demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece } from "./scene";
import { VERIFIED_DEMO, verifiedBaseline, verifiedCase, verifiedExit, verifiedHash, verifiedPalette, verifiedProgram, verifiedRows } from "./templates/verified";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(VERIFIED_DEMO);
const COLOURS = { primary: "#FFFFFF", highlight: "#FFE53B", accent: "#1E4FD8", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) => verifiedProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1280 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const scene = build(cues);
const find = (list: readonly Piece[], id: string) => list.find((piece) => piece.id === `verified:${id}`);
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};
const outBack14 = (p: number) => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2;

describe("Verified geometry", () => {
  test("Chrome's baselines of the sample's line boxes (read in the probe)", () => {
    expect(verifiedBaseline(70, 0.84)).toBe(52);
    expect(verifiedBaseline(84, 0.84)).toBe(63);
    expect(verifiedBaseline(185.855, 0.84)).toBe(140);
    expect(verifiedBaseline(125.05, 0.84)).toBe(94);
    expect(verifiedBaseline(50, 1)).toBe(41);
  });

  test("the hero is three rows 860 px wide at most (220 px at most); the middle one rests at the block's centre", () => {
    const rows = ["h0", "h1", "h2"].map((id) => need<TextPiece | ShapePiece>(find(scene, `1:${id}`) ?? find(scene, `1:${id}f`)));
    const mid = need<TextPiece>(find(scene, "1:h1"));
    expect(mid.text).toBe("STUCK");
    expect(mid.face).toBe("Archivo Expanded Black Italic");
    const probe = fakeMeasure("STUCK", mid.face, 220, -0.01).advance - 0.01 * 220;
    const size = Math.min(220, (220 * 860) / probe);
    expect(mid.sizePx).toBeCloseTo(size, 6);
    expect(rows.length).toBe(3);
    // Echoes are an outline piece and a fill piece, fill first fading away.
    const ring = need<TextPiece>(find(scene, "1:h0r"));
    expect(ring.fillAlpha).toBe(0);
    expect(ring.stroke?.alpha).toBe(0.7);
    const fill = need<TextPiece>(find(scene, "1:h0f"));
    expect(evaluatePiece(fill, 2641 + 520).o).toBeCloseTo(1, 3);
    expect(evaluatePiece(fill, 2641 + 940).o).toBeCloseTo(0, 3);
    expect(evaluatePiece(ring, 2641 + 940).o).toBeCloseTo(0.5, 3);
    // Both shrink to 0.94 toward the hero.
    expect(evaluatePiece(ring, 2641 + 940).sx).toBeCloseTo(0.94, 4);
  });

  test("a hero wipe: the clip edge follows outExpo over 380 ms from 70 ms before the row's start; echoes are offset 50 ms", () => {
    const mid = need<TextPiece>(find(scene, "1:h1"));
    const left = evaluatePiece(mid, 2641).x - 0.08 * mid.sizePx;
    const width = fakeMeasure("STUCK", mid.face, mid.sizePx, -0.01).advance - 0.01 * mid.sizePx + 0.16 * mid.sizePx;
    for (const t of [2600, 2641, 2700, 2800]) expect(evaluatePiece(mid, t).clip!.x2).toBeCloseTo(left + EASES.outExpo(prog(t, 2641 - 70, 380)) * width, 1);
    const top = need<TextPiece>(find(scene, "1:h0r"));
    expect(evaluatePiece(top, 2641 - 50).clip!.x2).toBeCloseTo(left + EASES.outExpo(prog(2641 - 50, 2641 - 50 - 70, 380)) * width, 1);
  });

  test("the pill shoots in along its tilt with the sample's outBack (1.4) and carries its words", () => {
    const body = need<ShapePiece>(find(scene, "1:pill"));
    const inAt = Math.max(2641 + 160, 3191 - 280);
    const rest = evaluatePiece(body, inAt + 300);
    const start = evaluatePiece(body, inAt);
    const tilt = (rest.rz * Math.PI) / 180;
    expect(rest.rz).toBeLessThan(0);
    expect(start.x - rest.x).toBeCloseTo(Math.cos(tilt) * 900, 1);
    expect(start.y - rest.y).toBeCloseTo(Math.sin(tilt) * 900, 1);
    const t = inAt + 150;
    expect(evaluatePiece(body, t).x - rest.x).toBeCloseTo(Math.cos(tilt) * 900 * (1 - outBack14(0.5)), 0);
    expect(need<TextPiece>(find(scene, "1:pw3")).text).toBe("FOR");
    expect(find(scene, "1:pw5")).toBeDefined();
  });

  test("badge and sparkles spring in on the hero's corners", () => {
    const hs = 2641;
    const badge = need<ShapePiece>(find(scene, "1:badge"));
    for (const t of [hs + 300, hs + 400, hs + 600]) {
      const p = prog(t, hs + 260, 420);
      expect(evaluatePiece(badge, t).sx).toBeCloseTo(EASES.spring(p), 2);
      expect(evaluatePiece(badge, t).rz).toBeCloseTo(-40 * (1 - EASES.spring(p)), 1);
    }
    expect(find(scene, "1:sparkA")).toBeDefined();
    expect(find(scene, "1:sparkB")).toBeDefined();
  });

  test("a plain word wipes on over 260 ms behind a block cursor that fades while it lands", () => {
    const word = cues[2]!.words[1]!;
    const piece = need<TextPiece>(find(scene, "2:w1"));
    const rest = evaluatePiece(piece, word.startMs + 400).clip!;
    for (const t of [word.startMs - 40, word.startMs + 60, word.startMs + 150]) {
      const clip = evaluatePiece(piece, t).clip!;
      expect(clip.x2 - clip.x1 > 0).toBe(true);
      expect(clip.x2).toBeCloseTo(rest.x2 - (1 - EASES.outExpo(prog(t, word.startMs - 70, 260))) * (rest.x2 - evaluatePiece(piece, t).x + 0.08 * piece.sizePx), 0);
    }
    const cursor = need<ShapePiece>(find(scene, "2:w1c"));
    expect(evaluatePiece(cursor, word.startMs).sx).toBe(1);
    expect(cursor.toMs).toBeLessThan(word.startMs + 260);
  });

  test("the sample's exit is shortened, never early: it waits for the last word", () => {
    const cue = cues[1]!;
    const exit = verifiedExit(cue, cue.words[5]!.startMs + 100);
    expect(exit.from).toBeGreaterThanOrEqual(cue.words[5]!.startMs + 100 + 158);
    expect(exit.to).toBeGreaterThanOrEqual(exit.from + 12);
    expect(verifiedExit(cue, 0).to).toBe(cue.endMs - 70);
  });
});

describe("Verified helpers", () => {
  test("case only changes cased scripts; the hash is stable; the palette cycles over four", () => {
    expect(verifiedCase("year")).toBe("YEAR");
    expect(verifiedCase("اچھا")).toBe("اچھا");
    expect(verifiedCase("नमस्ते")).toBe("नमस्ते");
    expect(verifiedCase("Привет")).toBe("ПРИВЕТ");
    expect(verifiedHash(cues[0]!)).toBe(verifiedHash(cues[0]!));
    expect(verifiedHash(cues[0]!)).not.toBe(verifiedHash(cues[1]!));
    const pills = [0, 1, 2, 3, 4].map((n) => verifiedPalette(COLOURS, n).pill);
    expect(new Set(pills.slice(0, 4)).size).toBe(4);
    expect(pills[4]).toBe(pills[0]);
  });

  test("rows: one row at no less than the floor, else even rows; a lone wide word shrinks", () => {
    const widthsAt = (size: number) => [450, 450, 450].map((w) => (w * size) / 70);
    const fit = verifiedRows(widthsAt, 70, 0.05, 920, 0.78);
    expect(fit.rows.length).toBeGreaterThan(1);
    const one = verifiedRows((size) => [200, 200].map((w) => (w * size) / 70), 70, 0.05, 920, 0.78);
    expect(one.rows).toEqual([[0, 1]]);
    const wide = verifiedRows((size) => [2000 * (size / 70)], 70, 0.05, 920, 0.78);
    expect(wide.size).toBeLessThan(70);
  });
});

const fastDemo: DemoScript = { ...VERIFIED_DEMO, options: { ...VERIFIED_DEMO.options, cueGap: 60 } };

describe("Verified with real speech (cues 60 ms apart)", () => {
  const fast = demoCues(fastDemo).cues;
  const list = build(fast);
  const wordOf = (piece: Piece): { cue: number; word: number } | null => {
    const m = /^verified:(\d+):(?:w|l|pw)(\d+)$/.exec(piece.id);
    if (m) return { cue: Number(m[1]), word: Number(m[2]) };
    const h = /^verified:(\d+):h1$/.exec(piece.id);
    if (h) return { cue: Number(h[1]), word: fast[Number(h[1])]!.words.findIndex((word) => word.role === "hero") };
    return null;
  };

  test("every word stays whole for at least 150 ms after it lands", () => {
    let checked = 0;
    for (const piece of list) {
      const at = wordOf(piece);
      if (!at || piece.kind !== "text") continue;
      const word = fast[at.cue]!.words[at.word]!;
      const rest = evaluatePiece(piece, word.startMs + 200).clip!.x2;
      const left = evaluatePiece(piece, piece.fromMs).clip!.x1;
      // A plain or hero word has landed when its wipe has uncovered 99 % of it; a pill word is typed inside a moving pill, so its edge
      // is judged once it is within 1.5 px (99 % of a 150 px word) of where it rests.
      const pill = piece.id.includes(":pw");
      const first = pill ? rest - 150 : evaluatePiece(piece, piece.fromMs).clip!.x2;
      const reached = (x: number) => (pill ? x >= rest - 1.5 : x >= first + 0.99 * (rest - first));
      let landed = -1;
      for (let t = word.startMs - (pill ? 60 : 100); t < word.startMs + 400; t++) {
        if (reached(evaluatePiece(piece, t).clip!.x2)) {
          landed = t;
          break;
        }
      }
      expect(landed).toBeGreaterThan(0);
      for (let t = landed; t <= landed + 150; t += 5) {
        const pose = evaluatePiece(piece, t);
        expect(pose.visible).toBe(true);
        expect(pose.o).toBeGreaterThan(0.9);
        expect(pose.clip!.x1).toBeCloseTo(left, 3);
        expect(reached(pose.clip!.x2)).toBe(true);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  test("a clip never inverts while a cue leaves", () => {
    for (const piece of list) {
      for (let t = piece.fromMs; t < piece.toMs; t += 5) {
        const clip = evaluatePiece(piece, t).clip;
        if (clip) expect(clip.x2).toBeGreaterThanOrEqual(clip.x1 - 0.01);
      }
    }
  });
});

describe("Verified over a long clip: the decoration keeps recurring and varying", () => {
  const lines = Array.from({ length: 6 }, () => VERIFIED_DEMO.lines).flat();
  const long = demoCues({ ...VERIFIED_DEMO, lines }).cues;
  const list = build(long);
  const heroCues = long.filter((cue) => cue.words.some((word) => word.role === "hero")).map((cue) => cue.index);
  const plainCues = long.filter((cue) => cue.words.every((word) => word.role !== "hero")).map((cue) => cue.index);

  test("30 cues: every hero cue has its badge, sparkles and pill; every other cue its badge and sparkle", () => {
    expect(long.length).toBe(30);
    for (const cue of heroCues) for (const part of ["badge", "sparkA", "sparkB", "pill", "pillcheck"]) expect(find(list, `${cue}:${part}`)).toBeDefined();
    for (const cue of plainCues) for (const part of ["badge", "spark"]) expect(find(list, `${cue}:${part}`)).toBeDefined();
    const perCue = new Map<string, number>();
    for (const piece of list) perCue.set(piece.id.split(":")[1]!, (perCue.get(piece.id.split(":")[1]!) ?? 0) + 1 + (piece.shadows?.length ?? 0));
    for (const count of perCue.values()) expect(count).toBeLessThanOrEqual(150);
  });

  test("the pill's colour, its tilt and side, the badge's corner and the sparkles' side vary down the clip", () => {
    const fills = new Set(heroCues.map((cue) => need<ShapePiece>(find(list, `${cue}:pill`)).fill!.colour));
    expect(fills.size).toBe(4);
    const tilts = heroCues.map((cue) => evaluatePiece(need<ShapePiece>(find(list, `${cue}:pill`)), long[cue]!.endMs - 400).rz);
    expect(tilts.some((tilt) => tilt < 0)).toBe(true);
    expect(tilts.some((tilt) => tilt > 0)).toBe(true);
    expect(new Set(tilts.map((tilt) => tilt.toFixed(2))).size).toBeGreaterThan(4);
    const sides = heroCues.map((cue) => {
      const badge = evaluatePiece(need<ShapePiece>(find(list, `${cue}:badge`)), long[cue]!.endMs - 400).x;
      const spark = evaluatePiece(need<ShapePiece>(find(list, `${cue}:sparkA`)), long[cue]!.endMs - 400).x;
      return Math.sign(badge - spark);
    });
    expect(sides).toContain(1);
    expect(sides).toContain(-1);
  });

  test("the plain cues swap the badge between their last and first word", () => {
    const xs = plainCues.map((cue) => Math.sign(evaluatePiece(need<ShapePiece>(find(list, `${cue}:badge`)), long[cue]!.endMs - 400).x - 540));
    expect(new Set(xs).size).toBe(2);
  });

  test("the sparkles twinkle for as long as a cue is held", () => {
    const word = (text: string, startMs: number, role: "hero" | "body" = "body") => ({ text, startMs, endMs: startMs + 400, role, key: null });
    const held: SceneCue[] = [{ index: 0, startMs: 0, endMs: 6000, speaker: 0, language: "en", words: [word("held", 0, "hero"), word("long", 500)] }];
    const spark = need<ShapePiece>(find(build(held), "0:sparkA"));
    const t0 = 360 + 380;
    const scales = [1, 2, 3].map((n) => evaluatePiece(spark, t0 + 550 * n).sx);
    expect(scales[0]).toBeCloseTo(0.86, 2);
    expect(scales[1]).toBeCloseTo(1, 2);
    expect(scales[2]).toBeCloseTo(0.86, 2);
    expect(spark.toMs).toBeGreaterThan(4000);
  });
});

describe("Verified edge cases", () => {
  test("a right-to-left cue runs right to left: the wipe moves the clip's left edge, the first word sits rightmost, the badge flips", () => {
    const list = build(sceneEdgeDemo("urdu").cues);
    const first = need<TextPiece>(find(list, "0:l0"));
    const second = need<TextPiece>(find(list, "0:l1"));
    expect(evaluatePiece(first, 1000).x).toBeGreaterThan(evaluatePiece(second, 1000).x);
    const early = evaluatePiece(first, 450).clip!;
    const rest = evaluatePiece(first, 1000).clip!;
    expect(early.x1).toBeGreaterThan(rest.x1);
    expect(early.x2).toBeCloseTo(rest.x2, 3);
    const badge = evaluatePiece(need<ShapePiece>(find(list, "0:badge")), 1900).x;
    expect(badge).toBeLessThan(540);
  });

  test("a long hero shrinks to the 860 px fit; a word wider than a row shrinks instead of overflowing", () => {
    const list = build(sceneEdgeDemo("long-word").cues);
    const hero = need<TextPiece>(find(list, "0:h1"));
    expect(hero.sizePx).toBeLessThan(120);
    const huge = need<TextPiece>(find(list, "1:w0"));
    expect(huge.sizePx).toBeLessThan(84);
  });

  test("a hero with nothing after it still gets the pill, with the star and the check and no text", () => {
    const list = build(sceneEdgeDemo("one-word").cues);
    expect(find(list, "0:pill")).toBeDefined();
    expect(find(list, "0:pillcheck")).toBeDefined();
    expect(list.some((piece) => /:pw\d+$/.test(piece.id) && piece.id.startsWith("verified:0:"))).toBe(false);
  });

  test("a lead that is too wide wraps onto more rows and keeps every row inside the safe width", () => {
    const word = (text: string, startMs: number, role: "hero" | "body" = "body") => ({ text, startMs, endMs: startMs + 400, role, key: null });
    const wide: SceneCue[] = [{ index: 0, startMs: 0, endMs: 3000, speaker: 0, language: "en", words: [word("extraordinary", 0), word("unbelievable", 400), word("circumstances", 800), word("DONE", 1200, "hero")] }];
    const list = build(wide);
    const leads = list.filter((piece): piece is TextPiece => piece.kind === "text" && /^verified:0:l\d+$/.test(piece.id));
    expect(leads.length).toBe(3);
    expect(new Set(leads.map((piece) => evaluatePiece(piece, 2000).y)).size).toBeGreaterThan(1);
    for (let t = 0; t < 3000; t += 50) for (const piece of list) if (!piece.bleed && piece.kind === "text") expect(evaluatePiece(piece, t).x).toBeGreaterThan(40);
  });
});
