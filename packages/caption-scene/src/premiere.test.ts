import { describe, expect, test } from "bun:test";
import { demoCues, parseDemoScript, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece } from "./scene";
import { PREMIERE_DEMO, premiereCapsSize, premiereHash, premiereProgram } from "./templates/premiere";
import { fakeMeasure, sceneInput } from "./test-support";

const COLOURS = { primary: "#F5A623", highlight: "#FFF1D6", accent: "#FFF1D6", shadow: "#000000" };
const build = (list: readonly SceneCue[], overrides = {}) =>
  premiereProgram.build(sceneInput(list, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const { cues } = demoCues(PREMIERE_DEMO);
const scene = build(cues);
const find = (list: readonly Piece[], id: string) => list.find((piece) => piece.id === `premiere:${id}`);
const need = <T extends Piece>(piece: Piece | undefined) => {
  expect(piece).toBeDefined();
  return piece as T;
};

describe("Premiere geometry", () => {
  test("caps size comes from the cue's characters: 200 to 10, 172 to 16, 150 above", () => {
    expect(premiereCapsSize(10)).toBe(200);
    expect(premiereCapsSize(11)).toBe(172);
    expect(premiereCapsSize(16)).toBe(172);
    expect(premiereCapsSize(17)).toBe(150);
    // "years matter most" is 18 characters with spaces: 150 px. "so keep" is 8: 200 px.
    expect(need<TextPiece>(find(scene, "1:w1")).sizePx).toBe(150);
    expect(need<TextPiece>(find(scene, "3:w0")).sizePx).toBe(200);
  });

  test("caps are upper case Anton, rows 0.98 em apart, words 0.16 em apart, centred on the anchor", () => {
    // "so keep" (cue 3, 200 px) shares one row; "years matter most" wraps (fakeMeasure is wider than Anton).
    const so = need<TextPiece>(find(scene, "3:w0"));
    const keep = need<TextPiece>(find(scene, "3:w1"));
    expect(so.text).toBe("SO");
    expect(so.face).toBe("Anton");
    const soBox = fakeMeasure("SO", "Anton", 200, 0.004).advance + 0.004 * 200;
    const keepBox = fakeMeasure("KEEP", "Anton", 200, 0.004).advance + 0.004 * 200;
    const cue = cues[3]!;
    const t = 7000;
    const s = 1 + 0.03 * prog(t, cue.startMs - 80, cue.endMs - cue.startMs);
    const unpush = (x: number) => 540 + (x - 540) / s;
    const soX = unpush(evaluatePiece(so, t).x);
    const keepX = unpush(evaluatePiece(keep, t).x);
    expect(keepX - soX).toBeCloseTo(soBox + 0.16 * 200, 3);
    // The row is centred on the anchor.
    expect(soX + (soBox + 0.16 * 200 + keepBox) / 2).toBeCloseTo(540 + (soBox + 0.16 * 200 + keepBox) / 2 - (soBox + 0.16 * 200 + keepBox) / 2 + 0, 0);
    // "years matter most" at 150 px: the third word is on the next row, one line box (0.98 em) lower.
    const years = need<TextPiece>(find(scene, "1:w1"));
    const most = need<TextPiece>(find(scene, "1:w3"));
    const t1 = 3300;
    const s1 = 1 + 0.03 * prog(t1, 1724, 1786);
    expect(((evaluatePiece(most, t1).y - 1290) / s1) - ((evaluatePiece(years, t1).y - 1290) / s1)).toBeCloseTo(0.98 * 150, 3);
    expect(most.sizePx).toBe(150);
  });

  test("the script word is Yesteryear at 1.12x with a knockout of 0.075 em, tipped, over the caps", () => {
    const hero = need<TextPiece>(find(scene, "1:hero"));
    expect(hero.text).toBe("quiet");
    expect(hero.face).toBe("Yesteryear");
    expect(hero.sizePx).toBeCloseTo(1.12 * 150, 6);
    expect(hero.stroke).toMatchObject({ colour: "#140E06" });
    expect(hero.stroke!.widthPx).toBeCloseTo((0.075 * hero.sizePx) / 2, 6);
    const tilt = evaluatePiece(hero, 3000).rz;
    expect(tilt).toBeLessThan(-3);
    expect(tilt).toBeGreaterThan(-8);
    expect(hero.z).toBeGreaterThan(need<TextPiece>(find(scene, "1:w1")).z);
    expect(hero.fill).toBe("#FFF1D6");
  });

  test("a lone script word is centred (the sample pushed it to the frame's edge) without a footer", () => {
    const lone = build(sceneEdgeDemo("one-word").cues);
    const hero = need<TextPiece>(find(lone, "0:hero"));
    expect(evaluatePiece(hero, 1000).x).toBeCloseTo(540, 0);
  });
});

describe("Premiere motion", () => {
  test("each caps word wipes in left to right over clamp(46 ms per letter, 170, 360) from 60 ms before its start", () => {
    const cue = cues[1]!;
    const word = cue.words[1]!;
    const piece = need<TextPiece>(find(scene, "1:w1"));
    const dur = Math.min(360, Math.max(170, 5 * 46));
    const at = word.startMs - 60;
    const startClip = evaluatePiece(piece, at + 5).clip!;
    const endClip = evaluatePiece(piece, at + dur + 20).clip!;
    const width = endClip.x2 - endClip.x1;
    for (const f of [0.25, 0.5, 0.75]) {
      const clip = evaluatePiece(piece, at + f * dur).clip!;
      expect((clip.x2 - clip.x1) / width).toBeCloseTo(f, 1);
    }
    expect(startClip.x2 - startClip.x1).toBeLessThan(0.1 * width);
    // The blur settles from 6 px over 240 ms (ease out).
    expect(evaluatePiece(piece, at + 5).blur).toBeCloseTo(6 * (1 - EASES.out(5 / 240)), 0);
    expect(evaluatePiece(piece, at + 300).blur).toBeCloseTo(0, 1);
  });

  test("a blurred glow copy lights as the word lands and is gone 520 ms after its half-way point", () => {
    const cue = cues[1]!;
    const word = cue.words[1]!;
    const glow = need<TextPiece>(find(scene, "1:g1"));
    const at = word.startMs - 60;
    const dur = 230;
    expect(evaluatePiece(glow, at + 100).o).toBeCloseTo(0.95, 2);
    expect(evaluatePiece(glow, at + dur / 2 + 260).o).toBeCloseTo(0.95 * (1 - EASES.out(0.5)), 1);
    expect(glow.toMs).toBeLessThanOrEqual(at + dur / 2 + 520);
    expect(evaluatePiece(glow, at + 100).blur).toBeGreaterThan(5);
  });

  test("the script writes on over clamp(80 ms per letter, 320, 540) and rises 14 px, then the sparkle pops", () => {
    const cue = cues[1]!;
    const word = cue.words[0]!;
    const hero = need<TextPiece>(find(scene, "1:hero"));
    const at = word.startMs - 60;
    const dur = 400;
    const clipAt = (t: number) => evaluatePiece(hero, t).clip!;
    const full = clipAt(at + dur + 10);
    const half = clipAt(at + dur / 2);
    expect(half.x2 - half.x1).toBeCloseTo(0.5 * (full.x2 - full.x1), -1);
    const rise = (t: number) => evaluatePiece(hero, t).y - evaluatePiece(hero, at + dur + 200).y;
    expect(rise(at + 5)).toBeGreaterThan(12);
    const star = need<ShapePiece>(find(scene, "1:star"));
    expect(evaluatePiece(star, at + 0.85 * dur + 200).sx).toBeGreaterThan(0.5);
    expect(evaluatePiece(star, at + 0.85 * dur + 5).sx).toBeLessThan(0.1);
  });

  test("the poster pushes in 3 % over the cue and lifts 18 px while it leaves", () => {
    const cue = cues[1]!;
    const piece = need<TextPiece>(find(scene, "1:w1"));
    expect(evaluatePiece(piece, cue.startMs + 1300).sx).toBeCloseTo(1 + 0.03 * prog(cue.startMs + 1300, cue.startMs - 80, cue.endMs - cue.startMs), 3);
    const last = need<TextPiece>(find(scene, "1:w3"));
    const end = cue.endMs - 80;
    expect(last.toMs).toBe(end);
    const before = evaluatePiece(last, end - 130);
    const after = evaluatePiece(last, end - 5);
    expect(after.o).toBeLessThan(0.2);
    expect(before.o).toBeGreaterThan(0.99);
    expect(before.y - after.y).toBeGreaterThan(10);
  });
});

describe("Premiere across a whole clip", () => {
  const long = (n: number, gap = 160) => {
    const lines = Array.from({ length: n }, (_, at) => (at % 3 === 1 ? "so:m this:b matters:h@500 most:b" : at % 3 === 2 ? "that's:m where:b it:m all:m gets:b built" : "Nobody:b tells:b you:m this"));
    return demoCues({ lines, options: { rate: 290, cueGap: gap, tail: 800, lead: 350 } }).cues;
  };

  test("every cue of a 24-cue clip keeps its sparkle and words without a timestamp or line", () => {
    const list = build(long(24));
    for (let n = 0; n < 24; n++) {
      expect(find(list, `${n}:star`)).toBeDefined();
      for (const part of ["rule", "credit"]) expect(find(list, `${n}:${part}`)).toBeUndefined();
      expect(list.filter((piece) => piece.id.startsWith(`premiere:${n}:w`)).length).toBeGreaterThanOrEqual(3);
    }
  });

  test("the decoration varies cue to cue: sparkle spots, sizes and script tilts cycle", () => {
    const list = build(long(24));
    const tilts = new Set(list.filter((piece) => piece.id.endsWith(":hero")).map((piece) => Math.round(evaluatePiece(piece, piece.fromMs + 600).rz * 10)));
    expect(tilts.size).toBeGreaterThanOrEqual(3);
    const stars = list.filter((piece) => piece.id.endsWith(":star"));
    const sizes = new Set(stars.map((piece) => Math.round((piece as ShapePiece).origin!.dx)));
    expect(sizes.size).toBe(3);
    // Late cues still move: the last cue's sparkle twinkles, the first cue's too.
    const last = need<ShapePiece>(find(list, "23:star"));
    const t0 = last.fromMs + 600;
    const scales = [0, 250, 500, 750, 1000].map((dt) => evaluatePiece(last, t0 + dt).sx);
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.01);
  });

  test("the hash is deterministic and spreads", () => {
    expect(premiereHash(3, "so keep going")).toBe(premiereHash(3, "so keep going"));
    expect(premiereHash(3, "so keep going")).not.toBe(premiereHash(4, "so keep going"));
    expect(premiereHash(3, "a")).not.toBe(premiereHash(3, "b"));
  });

  test("fast speech (60 ms between cues): every word is fully visible and uncropped for 150 ms after it lands", () => {
    const fast = long(9, 60);
    const list = build(fast);
    for (const cue of fast) {
      cue.words.forEach((word, at) => {
        const caps = find(list, `${cue.index}:${word.role === "hero" ? "hero" : `w${at}`}`) as TextPiece | undefined;
        expect(caps).toBeDefined();
        const dur = word.role === "hero" ? Math.min(540, Math.max(320, 80 * word.text.length)) : Math.min(360, Math.max(170, 46 * word.text.length));
        const land = word.startMs - 60 + dur;
        for (let t = land + 2; t <= land + 150; t += 8) {
          const pose = evaluatePiece(caps!, t);
          expect(pose.visible).toBe(true);
          expect(pose.o).toBeGreaterThan(0.9);
          const adv = fakeMeasure(caps!.text, caps!.face, caps!.sizePx, caps!.letterSpacingEm).advance;
          const left = caps!.anchor === "baseline-center" ? pose.x - (adv * pose.sx) / 2 : pose.x;
          expect(pose.clip!.x2).toBeGreaterThanOrEqual(left + adv * pose.sx - 0.5);
          expect(pose.clip!.x1).toBeLessThanOrEqual(left + 0.5);
        }
      });
    }
  });

  test("the exit never begins before a late word has landed, and leaves no later than 60 ms into the next cue", () => {
    const tight: SceneCue[] = [
      { index: 0, startMs: 0, endMs: 600, speaker: 0, language: "en", words: [{ text: "go", startMs: 0, endMs: 200, role: "body", key: null }, { text: "LATE", startMs: 300, endMs: 580, role: "body", key: null }] },
    ];
    const list = build(tight);
    const late = need<TextPiece>(find(list, "0:w1"));
    // LATE lands at 300 - 60 + 184 = 424 ms: the poster stays up until 574, and still leaves within 60 ms of the cue's end.
    expect(evaluatePiece(late, 424 + 100).o).toBeGreaterThan(0.99);
    expect(late.toMs).toBeGreaterThan(574);
    expect(late.toMs).toBeLessThanOrEqual(600 + 60);
  });
});

describe("Premiere in other languages and frames", () => {
  test("a right-to-left cue wipes from the right and keeps its letters whole", () => {
    const list = build(sceneEdgeDemo("urdu").cues);
    const word = list.find((piece): piece is TextPiece => piece.kind === "text" && /:w\d+$/.test(piece.id))!;
    expect(word.letterSpacingEm).toBe(0);
    expect(word.text).toBe(word.text.replace(/[A-Z]/g, ""));
    const a = evaluatePiece(word, word.fromMs + 20).clip!;
    const b = evaluatePiece(word, word.fromMs + 150).clip!;
    expect(b.x1).toBeLessThan(a.x1);
    expect(b.x2).toBeCloseTo(a.x2, 0);
  });

  test("cased scripts only are upper-cased; spacing only on cased scripts", () => {
    const words = (text: string): SceneCue[] => [{ index: 0, startMs: 0, endMs: 1500, speaker: 0, language: null, words: [{ text, startMs: 0, endMs: 500, role: "body", key: null }] }];
    expect(need<TextPiece>(find(build(words("hello")), "0:w0")).text).toBe("HELLO");
    expect(need<TextPiece>(find(build(words("привет")), "0:w0")).text).toBe("ПРИВЕТ");
    expect(need<TextPiece>(find(build(words("你好")), "0:w0")).text).toBe("你好");
    expect(need<TextPiece>(find(build(words("नमस्ते")), "0:w0")).letterSpacingEm).toBe(0);
  });

  test("a word wider than a row shrinks the cue; a long block fits a short 16:9 frame", () => {
    const long = build(sceneEdgeDemo("long-word").cues);
    const sizes = long.filter((piece): piece is TextPiece => piece.kind === "text" && /:w\d+$/.test(piece.id)).map((piece) => piece.sizePx);
    expect(Math.min(...sizes)).toBeLessThan(80);
    const nine = build(sceneEdgeDemo("nine-words").cues, { canvas: { width: 1920, height: 1080 }, anchor: { xPct: 50, yPct: 67 } });
    for (const piece of nine) {
      for (const t of [piece.fromMs + 50, (piece.fromMs + piece.toMs) / 2]) {
        const pose = evaluatePiece(piece, t);
        if (piece.kind === "text" && pose.visible) {
          expect(pose.y).toBeGreaterThan(0.04 * 1080);
          expect(pose.y).toBeLessThan(0.96 * 1080 + 1);
        }
      }
    }
  });

  test("the demo parser still gives the sample's cues", () => {
    expect(parseDemoScript(PREMIERE_DEMO.lines, PREMIERE_DEMO.options).cues.map((cue) => cue.words.length)).toEqual([4, 4, 6, 3]);
  });
});
