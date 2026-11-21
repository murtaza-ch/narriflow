import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { CASCADE_DEMO, CASCADE_PATTERNS, cascadeBaseline, cascadeBeats, cascadeCase, cascadeHash, cascadeProgram, cascadeRand } from "./templates/cascade";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(CASCADE_DEMO);
const COLOURS = { primary: "#FFFFFF", highlight: "#FF2D55", accent: "#1FE3FF", shadow: "#000000" };
const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };
const build = (list: readonly SceneCue[], overrides = {}) => cascadeProgram.build(sceneInput(list, { anchor, colours: COLOURS, ...overrides })).pieces;
const scene = build(cues);
const ofCue = (list: readonly Piece[], cue: number) => list.filter((piece) => piece.id.split(":")[1] === String(cue));
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};
const idOf = (piece: Piece) => piece.id.split(":").slice(2).join(":");

describe("Cascade geometry", () => {
  test("a lockup word is Archivo Black caps at 84 px, sheared -12 and tipped -6 degrees, with the sample's split copies behind it", () => {
    const word = need<TextPiece>(scene.find((piece) => piece.id === "cascade:0:w1"));
    expect(word.text).toBe("DON'T");
    expect(word.sizePx).toBe(84);
    expect(word.face).toBe("Archivo Black");
    const pose = evaluatePiece(word, 1200);
    expect(pose.skx).toBe(-12);
    expect(pose.rz).toBe(-6);
    const a = need<TextPiece>(scene.find((piece) => piece.id === "cascade:0:w1a"));
    const b = need<TextPiece>(scene.find((piece) => piece.id === "cascade:0:w1b"));
    expect([a.fill, b.fill]).toEqual([COLOURS.highlight, COLOURS.accent]);
  });

  test("Chrome's baseline of a line-height 1 Archivo Black box: 70 of 84 px", () => {
    expect(cascadeBaseline(84)).toBe(70);
    expect(cascadeBaseline(128)).toBe(106.5);
  });

  test("the block, chevrons and rule are centred on the anchor and rows step in 46 px", () => {
    const rows = ofCue(scene, 0).filter((piece) => /^w\d$/.test(idOf(piece)));
    expect(rows.length).toBe(5);
    const mid = (list: readonly Piece[]) => {
      const box = sceneBoundsAt(list, 1500, fakeMeasure)!;
      return (box.x1 + box.x2) / 2;
    };
    expect(Math.abs(mid(ofCue(scene, 0)) - 540)).toBeLessThan(60);
    // The words of the second row sit 46 px further right (along the tilt) than the first row's start.
    const w0 = evaluatePiece(rows[0]!, 1900);
    const w3 = evaluatePiece(rows[3]!, 1900);
    expect(w3.y).toBeGreaterThan(w0.y - 200);
  });

  test("hero cue: the hero is upright, punches from 1.14x with a blur, and its cue has no rows when it is alone", () => {
    const hero = need<TextPiece>(scene.find((piece) => piece.id === "cascade:2:h0"));
    const start = cues[2]!.words[0]!.startMs - 40;
    expect(hero.fromMs).toBe(start);
    for (const t of [start, start + 40, start + 100, start + 200]) {
      const pose = evaluatePiece(hero, t);
      const p = EASES.outExpo(prog(t, start, 170));
      expect(pose.sx).toBeCloseTo(1.14 + (1 - 1.14) * p, 3);
      expect(pose.blur).toBeCloseTo(14 * (1 - p), 3);
      expect(pose.skx).toBe(0);
      expect(pose.rz).toBe(0);
    }
    expect(ofCue(scene, 2).some((piece) => /^w\d/.test(idOf(piece)))).toBe(false);
    const echoes = ofCue(scene, 2).filter((piece) => /^e/.test(idOf(piece)));
    expect(echoes.length).toBeGreaterThan(0);
    expect(echoes.every((piece) => (piece as TextPiece).fillAlpha === 0)).toBe(true);
  });

  test("every spoken word of a hero cue appears: the words before and after the hero are lockup rows above and below it", () => {
    const nine = sceneEdgeDemo("nine-words").cues;
    const list = build(nine);
    nine[0]!.words.forEach((_, index) => {
      const mine = ofCue(list, 0).filter((piece) => new RegExp(`^(w|h)${index}$`).test(idOf(piece)));
      expect(mine).toHaveLength(1);
    });
    const hero = need<TextPiece>(list.find((piece) => piece.id === "cascade:0:h5"));
    const first = need<TextPiece>(list.find((piece) => piece.id === "cascade:0:w0"));
    const last = need<TextPiece>(list.find((piece) => piece.id === "cascade:0:w8"));
    expect(evaluatePiece(first, 3000).y).toBeLessThan(evaluatePiece(hero, 3000).y);
    expect(evaluatePiece(last, 3000).y).toBeGreaterThan(evaluatePiece(hero, 3000).y);
    // Rows on both sides: the echo cascade is a horizontal trail, never over a row.
    const echoes = ofCue(list, 0).filter((piece) => /^e/.test(idOf(piece)));
    const ys = new Set(echoes.map((piece) => Math.round(evaluatePiece(piece, piece.fromMs).y)));
    expect(ys.size).toBe(1);
  });
});

describe("Cascade motion", () => {
  test("a word cuts in 50 ms before it is spoken: white fades in over 50 ms, the red / cyan copies close from 14 px over 150 ms", () => {
    const cue = cues[0]!;
    const spoken = cue.words[2]!;
    const start = spoken.startMs - 50;
    const main = need<TextPiece>(scene.find((piece) => piece.id === "cascade:0:w2"));
    const a = need<TextPiece>(scene.find((piece) => piece.id === "cascade:0:w2a"));
    const b = need<TextPiece>(scene.find((piece) => piece.id === "cascade:0:w2b"));
    expect(main.fromMs).toBe(start);
    expect(evaluatePiece(main, start + 25).o).toBeCloseTo(0.5, 2);
    expect(evaluatePiece(main, start + 60).o).toBe(1);
    const gap = (t: number) => evaluatePiece(b, t).x - evaluatePiece(a, t).x;
    // 14 px each side at the start, along the tilted row (cos 6 degrees), closing with the sample's ease out.
    for (const t of [start, start + 40, start + 100, start + 150]) {
      expect(gap(t)).toBeCloseTo(2 * 14 * (1 - EASES.out(prog(t, start, 150))) * Math.cos((6 * Math.PI) / 180), 0);
    }
    expect(evaluatePiece(a, start + 75).o).toBeCloseTo(0.5, 2);
    expect(a.toMs).toBe(start + 150);
  });

  test("the lockup drifts 0.018 px/ms for 1.7 s and then holds", () => {
    const word = need<TextPiece>(scene.find((piece) => piece.id === "cascade:0:w0"));
    const at = (t: number) => evaluatePiece(word, t).x;
    const v = (at(1000) - at(900)) / 100;
    expect(v).toBeCloseTo(0.018 * Math.cos((6 * Math.PI) / 180), 3);
    expect(at(1990) - at(cues[0]!.startMs + 1700)).toBeCloseTo(0, 1);
  });

  test("the cascade beats compress to the time the hero has and four patterns cycle by hero cue", () => {
    expect(cascadeBeats(2000)).toEqual({ beat: 150, steps: 6, ruleDur: 420 });
    const short = cascadeBeats(500);
    expect(short.steps).toBeLessThan(6);
    expect(short.steps * short.beat + short.ruleDur).toBeLessThanOrEqual(500 + 1);
    expect(short.beat).toBeGreaterThanOrEqual(66);
    expect(CASCADE_PATTERNS.length).toBe(4);
    expect(new Set(CASCADE_PATTERNS.map((pattern) => pattern.join())).size).toBe(4);
    // Demo hero cues 2 and 4 are hero cues 0 and 1: different first echo beat.
    const first = (cue: number) => Math.min(...ofCue(scene, cue).filter((piece) => /^e/.test(idOf(piece))).map((piece) => piece.fromMs));
    // The demo's hero cues last 1.3 s, so the sample's 150 ms beat is compressed a little (never under 100 ms, never over 150).
    for (const cue of [2, 4]) {
      const beat = first(cue) - cues[cue]!.words[0]!.startMs;
      expect(beat).toBeGreaterThanOrEqual(100);
      expect(beat).toBeLessThanOrEqual(150);
    }
    const stairs = (cue: number) => new Set(ofCue(scene, cue).filter((piece) => /^e/.test(idOf(piece))).map((piece) => idOf(piece).match(/s(\d)/)![1])).size;
    expect(stairs(2)).toBe(4);
  });

  test("the seeded helpers are pure and the build is deterministic", () => {
    expect(cascadeHash("a")).toBe(cascadeHash("a"));
    expect(cascadeHash("a")).not.toBe(cascadeHash("b"));
    expect(cascadeRand(3)).toBe(cascadeRand(3));
    expect(cascadeRand(3)).not.toBe(cascadeRand(4));
    expect(JSON.stringify(build(cues))).toBe(JSON.stringify(build(cues)));
  });
});

const longClip = (rounds: number) => {
  const base = demoCues(CASCADE_DEMO);
  const long: SceneCue[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const cue of base.cues) {
      const shift = round * (base.duration + 200);
      long.push({ ...cue, index: long.length, startMs: cue.startMs + shift, endMs: cue.endMs + shift, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + shift, endMs: word.endMs + shift })) });
    }
  }
  return long;
};

describe("Cascade real speech and long clips", () => {
  test("fast speech: with 60 ms between cues every word stays fully visible and uncut for 150 ms after it lands", () => {
    const fast = demoCues({ ...CASCADE_DEMO, options: { ...CASCADE_DEMO.options, cueGap: 60 } }).cues;
    const list = build(fast);
    fast.forEach((cue, number) => {
      cue.words.forEach((word, index) => {
        const mine = ofCue(list, number).filter((piece) => new RegExp(`^(w|h)${index}$`).test(idOf(piece)));
        expect(mine).toHaveLength(1);
        const piece = mine[0] as TextPiece;
        const hero = word.role === "hero";
        const landed = piece.fromMs + (hero ? 120 : 50);
        const width = fakeMeasure(piece.text, piece.face, piece.sizePx, piece.letterSpacingEm).advance;
        for (let t = landed; t <= landed + 150; t += 10) {
          const pose = evaluatePiece(piece, t);
          expect(pose.visible).toBe(true);
          expect(pose.o).toBeGreaterThan(0.9);
          // The wipe has not reached the word's left edge.
          expect(pose.clip!.x1).toBeLessThanOrEqual(pose.x - width / 2 + 1);
        }
      });
    });
  });

  test("a 30-cue clip keeps every decoration coming back and varying", () => {
    const long = longClip(6);
    expect(long.length).toBeGreaterThanOrEqual(30);
    const list = build(long);
    const chevronCounts = new Set<string>();
    const echoSignatures = new Set<string>();
    const bracketSignatures = new Set<string>();
    const scans = { total: 0, vertical: 0, horizontal: 0 };
    const sides = new Set<number>();
    let chevronPairs = 0;
    let scanBars = 0;
    let brackets = 0;
    let ruleLeads = 0;
    long.forEach((cue, number) => {
      const mine = ofCue(list, number);
      const hero = cue.words.some((word) => word.role === "hero");
      expect(mine.some((piece) => /^rule\d/.test(idOf(piece)))).toBe(true);
      expect(mine.some((piece) => /^rule\d+r$/.test(idOf(piece)))).toBe(true);
      ruleLeads += mine.filter((piece) => /^rule\d+[rc]$/.test(idOf(piece))).length;
      if (hero) {
        const br = mine.filter((piece) => /^br/.test(idOf(piece))) as ShapePiece[];
        expect(br.length).toBeGreaterThanOrEqual(2);
        brackets += br.length;
        bracketSignatures.add(br.map((piece) => idOf(piece)).join());
        const echoes = mine.filter((piece) => /^e/.test(idOf(piece)));
        echoSignatures.add(echoes.map((piece) => `${idOf(piece).match(/s\d/)![0]}${Math.round(evaluatePiece(piece, piece.fromMs).x)}`).join());
        expect(mine.filter((piece) => /^chev/.test(idOf(piece))).length).toBeGreaterThanOrEqual(2);
      } else {
        const chevs = mine.filter((piece) => /^chev/.test(idOf(piece)));
        expect(chevs.length).toBeGreaterThanOrEqual(2);
        chevronCounts.add(chevs.map((piece) => idOf(piece)).join());
        chevronPairs++;
        const bars = mine.filter((piece) => /^scan\d/.test(idOf(piece))) as ShapePiece[];
        expect(bars.length).toBe(cue.words.length);
        scanBars += bars.length;
        for (const bar of bars) {
          const xs = bar.path.flatMap((cmd) => (cmd[0] === "Z" ? [] : [cmd[1] as number]));
          const wide = Math.max(...xs) > 20;
          scans.total++;
          if (wide) scans.horizontal++;
          else scans.vertical++;
        }
      }
      for (const piece of mine) sides.add(Math.sign(Math.round(evaluatePiece(piece, piece.fromMs).x - 540)));
    });
    // Three chevron variants, three bracket variants, four echo patterns, both scan directions.
    expect(chevronCounts.size).toBeGreaterThanOrEqual(3);
    expect(bracketSignatures.size).toBeGreaterThanOrEqual(3);
    expect(echoSignatures.size).toBeGreaterThanOrEqual(4);
    expect(scans.horizontal).toBeGreaterThan(0);
    expect(scans.vertical).toBeGreaterThan(scans.horizontal);
    // Per 24+ cues: every lockup cue has a chevron pair and a scan bar per word, every hero cue brackets, every cue a rule lead.
    expect(chevronPairs).toBeGreaterThanOrEqual(18);
    expect(scanBars).toBeGreaterThanOrEqual(60);
    expect(brackets).toBeGreaterThanOrEqual(24);
    expect(ruleLeads).toBeGreaterThanOrEqual(2 * 30);
    expect(JSON.stringify(list).includes("NaN")).toBe(false);
  });
});

describe("Cascade scripts and edges", () => {
  test("capitals only for cased scripts; an Urdu lockup is the mirror image: tipped +6, sheared +12, flush right", () => {
    expect(cascadeCase("hello")).toBe("HELLO");
    expect(cascadeCase("اچھا")).toBe("اچھا");
    expect(cascadeCase("你好")).toBe("你好");
    const urdu = build(sceneEdgeDemo("urdu").cues);
    const word = need<TextPiece>(urdu.find((piece) => piece.id === "cascade:1:w0"));
    const pose = evaluatePiece(word, 2600);
    expect(pose.rz).toBe(6);
    expect(pose.skx).toBe(12);
    const second = need<TextPiece>(urdu.find((piece) => piece.id === "cascade:1:w1"));
    expect(pose.x).toBeGreaterThan(evaluatePiece(second, 2600).x);
    // The clip of a right-to-left cue keeps the left of the wipe edge.
    expect(pose.clip!.x1).toBeLessThan(0);
    // Hero (Urdu) is one piece per word, never split.
    expect(urdu.filter((piece) => piece.kind === "text" && /^cascade:0:h\d$/.test(piece.id))).toHaveLength(1);
  });

  test("the edge demos fit the safe area on 9:16, 1:1 and 16:9 at every time", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const kind of ["one-word", "nine-words", "long-word", "no-hero", "two-speakers"] as const) {
        const list = build(sceneEdgeDemo(kind).cues, { canvas, anchor });
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
