import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo, type DemoScript } from "./demo";
import { countUpText, parseNumberInWord } from "./detect";
import { BULLETIN_DEMO, bulletinCounter, bulletinPlateOutAt, bulletinPlateVisible, bulletinProgram } from "./templates/bulletin";
import { evaluatePiece, pieceBounds, type Piece, type ShapePiece, type TextPiece } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";

const COLOURS = { primary: "#FFFFFF", highlight: "#FF4B2B", accent: "#141519", shadow: "#000000" };
const inputFor = (cues: ReturnType<typeof demoCues>["cues"], overrides = {}) => sceneInput(cues, { anchor: { xPct: 50, yPct: (1320 / 1920) * 100 }, colours: COLOURS, ...overrides });
const { cues } = demoCues(BULLETIN_DEMO);
const scene = bulletinProgram.build(inputFor(cues));
const of = (cue: number, name: string) => scene.pieces.find((piece) => piece.id === `bulletin:${cue}:${name}`);
const shape = (cue: number, name: string) => of(cue, name) as ShapePiece;
const text = (cue: number, name: string) => of(cue, name) as TextPiece;
const at = (piece: Piece | undefined, t: number) => evaluatePiece(piece!, t);
const cueNo = (piece: Piece) => Number(piece.id.split(":")[1]);
const build = (script: DemoScript, overrides = {}) => {
  const demo = demoCues(script);
  return { cues: demo.cues, pieces: bulletinProgram.build(inputFor(demo.cues, overrides)).pieces };
};

// The sample's own formulas, written out again so the tests do not check the program against itself.
const outExpo = (p: number) => (p >= 1 ? 1 : 1 - 2 ** (-10 * p));
const out = (p: number) => 1 - (1 - p) ** 3;
const ins = (p: number) => p ** 3;
const prog = (t: number, start: number, dur: number) => Math.min(1, Math.max(0, (t - start) / dur));
const sampleVisible = (t: number, start: number, end: number, index: number, count: number) => {
  const right = 100 - outExpo(prog(t, start - 80, 320)) * 100 + ins(prog(t, end - 200 + (count - 1 - index) * 30, 110)) * 100;
  return 1 - Math.min(100, right) / 100;
};

const BOX = (word: string, size: number, ls: number) => fakeMeasure(word, "Inter Tight Bold", size, ls).advance + ls * size;

describe("Bulletin geometry", () => {
  test("a cue with a number hero is a bar, lead, hero and tail plates, a rule, words and a counter", () => {
    const ids = scene.pieces.filter((piece) => cueNo(piece) === 0).map((piece) => piece.id.split(":")[2]!);
    expect(ids.filter((id) => !id.startsWith("count")).sort()).toEqual(["bar", "plate0", "plate1", "plate2", "rule", "w0", "w1", "w3", "w4", "w5"].sort());
    expect(ids.filter((id) => id.startsWith("count")).length).toBeGreaterThan(10);
    // A hero that is no number draws no rule and no counter.
    expect(scene.pieces.filter((piece) => cueNo(piece) === 2).map((piece) => piece.id.split(":")[2])).not.toContain("rule");
    expect(text(2, "w4").text).toBe("PRICING");
    // A cue without a hero is the white plates alone.
    expect(scene.pieces.filter((piece) => cueNo(piece) === 1).map((piece) => piece.id.split(":")[2]!).sort()).toEqual(["bar", "plate0", "plate1", "w0", "w1", "w2", "w3", "w4"].sort());
  });

  test("plates are the sample's: white lead, vermilion hero, ink tail, square, stacked without a gap, 22 px right of the bar", () => {
    const plates = [0, 1, 2].map((index) => shape(0, `plate${index}`));
    expect(plates.map((plate) => plate.fill?.colour)).toEqual(["#FFFFFF", "#FF4B2B", "#141519"]);
    const rest = plates.map((plate) => at(plate, 2200));
    expect(rest.every((pose) => pose.x === rest[0]!.x && pose.sx === 1)).toBe(true);
    // 84 + 14 (bar) + 8 (air) = 106.
    expect(rest[0]!.x).toBe(106);
    const heights = plates.map((plate) => plate.path.reduce((max, cmd) => (cmd[0] === "L" ? Math.max(max, cmd[2]) : max), 0));
    expect(rest[1]!.y - rest[0]!.y).toBeCloseTo(heights[0]!, 6);
    expect(rest[2]!.y - rest[1]!.y).toBeCloseTo(heights[1]!, 6);
    // Lead and tail: padding 13 + 1.12 * 60 + 16; hero: 26 + cap box + 28 (cap = 0.72 em in the fake measure).
    expect(heights[0]!).toBeCloseTo(13 + 67.2 + 16, 6);
    expect(heights[2]!).toBeCloseTo(13 + 67.2 + 16, 6);
    expect(heights[1]!).toBeCloseTo(26 + Math.round(0.72 * 132) + 28, 6);
    // The block is centred on the anchor line, the bar is 14 wide and as tall as the block.
    const total = heights[0]! + heights[1]! + heights[2]!;
    expect(rest[0]!.y + total / 2).toBeCloseTo(1320, 6);
    const bar = shape(0, "bar");
    expect(at(bar, 2200)).toMatchObject({ x: 84, y: rest[0]!.y });
    expect(at(bar, 2200).sy).toBeCloseTo(1, 9);
    expect(bar.path).toEqual([["M", 0, 0], ["L", 14, 0], ["L", 14, total], ["L", 0, total], ["Z"]]);
    expect(bar.fill?.colour).toBe("#FF4B2B");
  });

  test("a plate hugs its words: 28 px padding, 0.26 em between words, Inter Tight Bold 60 px, ink on paper and white on ink", () => {
    const lead = shape(0, "plate0");
    const w0 = text(0, "w0");
    const w1 = text(0, "w1");
    expect(w0).toMatchObject({ face: "Inter Tight Bold", sizePx: 60, letterSpacingEm: -0.015, fill: "#141519", text: "Revenue" });
    expect(text(0, "w3")).toMatchObject({ fill: "#FFFFFF", sizePx: 60 });
    const box0 = BOX("Revenue", 60, -0.015);
    const box1 = BOX("grew", 60, -0.015);
    expect(at(w0, 600).x).toBeCloseTo(106 + 28, 6);
    expect(at(w1, 900).x).toBeCloseTo(106 + 28 + box0 + 0.26 * 60, 6);
    const width = lead.path.reduce((max, cmd) => (cmd[0] === "L" ? Math.max(max, cmd[1]) : max), 0);
    expect(width).toBeCloseTo(56 + box0 + 0.26 * 60 + box1, 6);
  });

  test("the hero is Archivo Black caps, 132 px, white on the vermilion plate, whose width is fixed at the final value (the sample's min-width)", () => {
    const counts = scene.pieces.filter((piece) => piece.id.startsWith("bulletin:0:count")) as TextPiece[];
    expect(counts[0]).toMatchObject({ face: "Archivo Black", sizePx: 132, letterSpacingEm: -0.01, fill: "#FFFFFF", text: "0%" });
    expect(counts[counts.length - 1]!.text).toBe("312%");
    const final = fakeMeasure("312%", "Archivo Black", 132, -0.01).advance + -0.01 * 132;
    const plate = shape(0, "plate1");
    const width = plate.path.reduce((max, cmd) => (cmd[0] === "L" ? Math.max(max, cmd[1]) : max), 0);
    expect(width).toBeCloseTo(68 + Math.max(Math.round(final), final), 6);
    // Every counted value starts at the same x, 34 px in.
    for (const piece of counts) expect(at(piece, piece.fromMs).x).toBeCloseTo(106 + 34, 6);
  });

  test("a no-hero cue is the white plate, one row of 66 px type up to 16 characters and two rows over", () => {
    expect(text(1, "w0").sizePx).toBe(66);
    expect(scene.pieces.filter((piece) => cueNo(piece) === 1 && piece.id.includes("plate")).length).toBe(2);
    const short = build({ lines: ["so:b what:b"] });
    expect(short.pieces.filter((piece) => piece.id.includes("plate")).length).toBe(1);
    // "And we didn't | hire anyone": the sample's balance of characters (4 + 3 + 7 = 14 over 5 + 7 = 12 after the spaces).
    const rows = [0, 1, 2, 3, 4].map((index) => Math.round(at(text(1, `w${index}`), 4200).y));
    expect(new Set(rows).size).toBe(2);
    expect(rows[0]).toBe(rows[2]);
    expect(rows[3]).toBe(rows[4]);
    expect(rows[3]! - rows[0]!).toBeCloseTo(1.12 * 66 + 15 + 17, 0);
  });

  test("everything stays inside the safe area, on a phone canvas and on 16:9", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      for (const kind of ["one-word", "nine-words", "long-word", "no-hero", "urdu", "two-speakers"] as const) {
        const edge = sceneEdgeDemo(kind);
        const pieces = bulletinProgram.build(inputFor(edge.cues, { canvas, anchor: { xPct: 50, yPct: (1320 / 1920) * 100 } })).pieces;
        for (let t = 0; t < edge.duration; t += 40) {
          for (const piece of pieces) {
            const box = pieceBounds(piece, t, fakeMeasure);
            if (!box) continue;
            expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
            expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
          }
        }
      }
    }
  });
});

describe("Bulletin motion, against the sample's own formulas", () => {
  test("a plate wipes in from its left edge in 320 ms outExpo, starting 80 ms early, and the bar reaches its bottom in 300 ms", () => {
    const cue = cues[0]!;
    const plate = shape(0, "plate0");
    const start = cue.words[0]!.startMs;
    for (const t of [start - 79, start - 40, start, start + 80, start + 160, start + 240, start + 400]) {
      expect(at(plate, t).sx).toBeCloseTo(sampleVisible(t, start, cue.endMs, 0, 3), 2);
    }
    // The text is clipped by the same moving edge: x2 follows the plate, x1 stays at the plate's left.
    const word = text(0, "w0");
    const wide = (plate.path.reduce((max, cmd) => (cmd[0] === "L" ? Math.max(max, cmd[1]) : max), 0));
    for (const t of [start - 40, start + 80, start + 200]) {
      const clip = at(word, t).clip!;
      expect(clip.x1).toBe(106);
      expect(clip.x2).toBeCloseTo(106 + wide * sampleVisible(t, start, cue.endMs, 0, 3), 1);
    }
  });

  test("the bar grows to each plate's bottom as the plate arrives and shrinks last", () => {
    const bar = shape(0, "bar");
    const cue = cues[0]!;
    const plates = [0, 1, 2].map((index) => shape(0, `plate${index}`));
    const height = (plate: ShapePiece) => plate.path.reduce((max, cmd) => (cmd[0] === "L" ? Math.max(max, cmd[2]) : max), 0);
    const bottoms = [height(plates[0]!), height(plates[0]!) + height(plates[1]!), height(plates[0]!) + height(plates[1]!) + height(plates[2]!)];
    const total = bottoms[2]!;
    const starts = [cue.words[0]!.startMs, cue.words[2]!.startMs, cue.words[3]!.startMs];
    const reach = (t: number) => {
      let value = 0;
      starts.forEach((start, index) => {
        const g = outExpo(prog(t, start - 80, 300));
        if (g > 0) value = Math.max(value, (index === 0 ? 0 : bottoms[index - 1]!) + (bottoms[index]! - (index === 0 ? 0 : bottoms[index - 1]!)) * g);
      });
      return value;
    };
    for (const t of [300, 400, 600, 900, 1000, 1100, 1400, 1800, 1900, 2000, 2200, 2615, 2650, 2690, 2714]) {
      expect(at(bar, t).sy * total).toBeCloseTo(reach(t) * (1 - ins(prog(t, cue.endMs - 100, 100))), 0);
    }
  });

  test("a word rises 140 % of its box from under the plate in 360 ms outExpo at its own spoken time", () => {
    const grew = text(0, "w1");
    const word = cues[0]!.words[1]!;
    const rest = at(grew, word.startMs + 800).y;
    for (const t of [word.startMs - 80, word.startMs - 40, word.startMs, word.startMs + 120, word.startMs + 250, word.startMs + 280]) {
      expect(at(grew, t).y).toBeCloseTo(rest + (1 - outExpo(prog(t, word.startMs - 80, 360))) * 1.4 * (1.12 * 60), 4);
    }
    // The hero's box is its cap height.
    const hero = scene.pieces.find((piece) => piece.id === "bulletin:0:count0") as TextPiece;
    const heroRest = at(scene.pieces.filter((piece) => piece.id.startsWith("bulletin:0:count")).pop(), 2200).y;
    const hw = cues[0]!.words[2]!;
    for (const t of [hw.startMs - 79, hw.startMs, hw.startMs + 200]) {
      expect(at(hero, t).y).toBeCloseTo(heroRest + (1 - outExpo(prog(t, hw.startMs - 80, 360))) * 1.4 * Math.round(0.72 * 132), 2);
    }
  });

  test("the plates leave bottom first, 30 ms apart, each in 110 ms ease in, inside the last 200 ms", () => {
    const cue = cues[0]!;
    expect([0, 1, 2].map((index) => bulletinPlateOutAt(cue.endMs, index, 3))).toEqual([cue.endMs - 140, cue.endMs - 170, cue.endMs - 200]);
    for (const [index, name] of ["plate0", "plate1", "plate2"].entries()) {
      for (const t of [cue.endMs - 215, cue.endMs - 170, cue.endMs - 140, cue.endMs - 100, cue.endMs - 60, cue.endMs - 31]) {
        expect(at(shape(0, name), t).sx).toBeCloseTo(sampleVisible(t, cues[0]!.words[[0, 2, 3][index]!]!.startMs, cue.endMs, index, 3), 2);
      }
    }
    // The tail plate is gone first.
    expect(at(shape(0, "plate2"), cue.endMs - 95).sx).toBeLessThan(at(shape(0, "plate0"), cue.endMs - 95).sx);
    expect(bulletinPlateVisible(cue.endMs - 200 + 110, 0, cue.endMs - 200)).toBe(0);
  });

  test("a plate whose wipes overlap (a last word spoken as the cue leaves) is wiped out as it comes in", () => {
    const late = build({ lines: ["so:m we:b did:b it:h@900"] });
    const { cues: lateCues, pieces } = late;
    const hero = pieces.find((piece) => piece.id === "bulletin:0:plate1") as ShapePiece;
    const cue = lateCues[0]!;
    const start = cue.words[3]!.startMs;
    for (let t = start - 79; t < hero.toMs; t += 17) {
      expect(at(hero, t).sx).toBeCloseTo(Math.max(0, outExpo(prog(t, start - 80, 320)) - ins(prog(t, bulletinPlateOutAt(cue.endMs, 1, 2), 110))), 2);
    }
  });

  test("the whole block is visible only from 80 ms before the cue starts to the cue's end", () => {
    for (const cue of cues) {
      const mine = scene.pieces.filter((piece) => cueNo(piece) === cue.index);
      expect(Math.min(...mine.map((piece) => piece.fromMs))).toBeGreaterThanOrEqual(cue.startMs - 80);
      expect(Math.max(...mine.map((piece) => piece.toMs))).toBeLessThanOrEqual(cue.endMs);
    }
  });

  test("a newer cue paints over an older one: its pieces sit in a higher z band", () => {
    const z = (cue: number) => Math.min(...scene.pieces.filter((piece) => cueNo(piece) === cue).map((piece) => piece.z));
    expect(z(1)).toBeGreaterThan(Math.max(...scene.pieces.filter((piece) => cueNo(piece) === 0).map((piece) => piece.z)));
    // Within a cue: plates and bar, then the rule, then text.
    expect(shape(0, "bar").z).toBe(shape(0, "plate0").z);
    expect(shape(0, "rule").z).toBeGreaterThan(shape(0, "plate0").z);
    expect(text(0, "w0").z).toBeGreaterThan(shape(0, "rule").z);
  });

  test("the plates and the bar cast the block's drop shadow (0 8 18, 22 %); text and the rule cast none", () => {
    for (const piece of scene.pieces) {
      const id = piece.id.split(":")[2]!;
      if (id === "bar" || id.startsWith("plate")) expect(piece.shadows).toEqual([{ dx: 0, dy: 8, blur: 9, colour: "#000000", alpha: 0.22 }]);
      else expect(piece.shadows).toBeUndefined();
    }
  });
});

describe("Bulletin numbers", () => {
  test("the count-up text of 3, 40%, $1.2M, 312%, 1,000 and the words that are no number", () => {
    const counter = (word: string) => bulletinCounter(word)!;
    expect([0, 0.5, 1].map((p) => counter("3").at(p))).toEqual(["0", "2", "3"]);
    expect([0, 0.25, 1].map((p) => counter("40%").at(p))).toEqual(["0%", "10%", "40%"]);
    expect([0, 0.5, 1].map((p) => counter("$1.2M").at(p))).toEqual(["$0.0M", "$0.6M", "$1.2M"]);
    expect([0, 0.5, 1].map((p) => counter("312%").at(p))).toEqual(["0%", "156%", "312%"]);
    // The sample would count "1,000" as 1 with a ",000" tail; here it counts the value and groups it.
    expect([0, 0.5, 0.9, 1].map((p) => counter("1,000").at(p))).toEqual(["0", "500", "900", "1,000"]);
    expect(counter("$1,250,000").at(0.5)).toBe("$625,000");
    expect(counter("1,250.5").at(1)).toBe("1,250.5");
    // The detector's own reading for plain numbers, unchanged.
    expect(counter("$4.2M").at(0.5)).toBe(countUpText(parseNumberInWord("$4.2M")!, 0.5));
    expect(bulletinCounter("ten")).toBeNull();
    expect(bulletinCounter("pricing")).toBeNull();
    expect(bulletinCounter("")).toBeNull();
  });

  const countAt = (word: string, t: number) => {
    const built = build({ lines: [`so:m ${word}:h@800 now:b`] });
    const pieces = built.pieces.filter((piece) => piece.id.startsWith("bulletin:0:count")) as TextPiece[];
    return { word: built.cues[0]!.words[1]!, pieces, now: pieces.filter((piece) => t >= piece.fromMs && t < piece.toMs) };
  };

  test("the counter shows the sample's value at every export frame, as one piece per value, 0 first and the word last", () => {
    for (const word of ["3", "40%", "$1.2M", "312%", "1,000", "7.25"]) {
      const { word: spoken, pieces } = countAt(word, 0);
      const counter = bulletinCounter(word)!;
      expect(pieces[0]!.text).toBe(counter.at(0));
      expect(pieces[pieces.length - 1]!.text).toBe(counter.at(1));
      // Pieces follow one another without a gap or an overlap.
      for (let index = 1; index < pieces.length; index++) expect(pieces[index]!.fromMs).toBe(pieces[index - 1]!.toMs);
      for (let n = Math.ceil(((spoken.startMs - 80) * 30) / 1000); n < Math.floor(((spoken.endMs + 800) * 30) / 1000); n++) {
        const t = Math.round((n * 1000) / 30);
        const shown = pieces.filter((piece) => t >= piece.fromMs && t < piece.toMs);
        expect(shown.length).toBe(1);
        expect(shown[0]!.text).toBe(counter.at(out(prog(t, spoken.startMs, spoken.endMs - spoken.startMs + 250))));
      }
    }
  });

  test("a counter of any size stays inside the piece budget and its plate never changes width", () => {
    for (const word of ["3", "$1,250,000", "99999%", "312%"]) {
      const { pieces } = build({ lines: [`so:m ${word}:h@900`] });
      expect(pieces.filter((piece) => piece.id.startsWith("bulletin:0:count")).length).toBeLessThan(40);
      expect(pieces.length + pieces.filter((piece) => piece.shadows).length).toBeLessThanOrEqual(150);
      const plate = pieces.find((piece) => piece.id === "bulletin:0:plate1") as ShapePiece;
      const widths = new Set([plate.fromMs + 5, plate.toMs - 5].map((t) => at(plate, t)).map((pose) => pose.sx).filter((sx) => sx === 1));
      expect(widths.size).toBeLessThanOrEqual(1);
    }
  });

  test("the rule draws along the plate's bottom in the word's time plus 250 ms, ease out, under the same wipe", () => {
    const rule = shape(0, "rule");
    const word = cues[0]!.words[2]!;
    const total = word.endMs - word.startMs + 250;
    for (const t of [word.startMs + 1, word.startMs + 100, word.startMs + 400, word.startMs + total, word.startMs + total + 200]) {
      expect(at(rule, t).sx).toBeCloseTo(out(prog(t, word.startMs, total)), 6);
    }
    expect(rule.fill?.colour).toBe("#FFFFFF");
    // It sits on the plate's bottom edge, 6 px tall, and is clipped to the plate.
    const plate = shape(0, "plate1");
    const plateHeight = plate.path.reduce((max, cmd) => (cmd[0] === "L" ? Math.max(max, cmd[2]) : max), 0);
    expect(at(rule, 1500).y + 6).toBeCloseTo(at(plate, 1500).y + plateHeight, 6);
    expect(at(rule, 1500).clip).not.toBeNull();
  });

  test("a hero wider than a plate shrinks to fit; the cue is never wider than the safe area", () => {
    const long = build({ lines: ["it's:m extraordinarily:h@900 hard:b"] });
    const hero = long.pieces.find((piece) => piece.id === "bulletin:0:w1") as TextPiece;
    expect(hero.text).toBe("EXTRAORDINARILY");
    expect(hero.sizePx).toBeLessThan(132);
    expect(hero.sizePx).toBeGreaterThan(40);
    const plate = long.pieces.find((piece) => piece.id === "bulletin:0:plate1") as ShapePiece;
    const right = at(plate, plate.toMs - 150).x + plate.path.reduce((max, cmd) => (cmd[0] === "L" ? Math.max(max, cmd[1]) : max), 0);
    expect(right).toBeLessThanOrEqual(0.95 * 1080 + 0.5);
  });
});

describe("Bulletin edge cases", () => {
  test("a hero with no lead or tail is one plate", () => {
    const one = sceneEdgeDemo("one-word");
    const pieces = bulletinProgram.build(inputFor(one.cues)).pieces.filter((piece) => cueNo(piece) === 0);
    expect(pieces.filter((piece) => piece.id.includes("plate")).length).toBe(1);
  });

  test("a long lead row wraps into stacked plates of the same kind instead of running off the screen", () => {
    const { pieces } = build({ lines: ["so:m the:m real:b reason:b most:b of:m them:b never:b get:m there:b wow:h@500"] });
    const plates = pieces.filter((piece) => piece.id.includes("plate")) as ShapePiece[];
    expect(plates.length).toBeGreaterThan(2);
    for (const plate of plates.filter((p) => p.fill?.colour === "#FFFFFF")) expect(plate.path[1]![1]!).toBeLessThanOrEqual(0.9 * 1080 - 106 + 1);
  });

  test("right-to-left rows run from the right: the first spoken word is the rightmost on its plate", () => {
    const { pieces } = build({ lines: ["یہ:m بہت:b اچھا:h@600 ہے:m"], language: "ur" } as DemoScript);
    const x = (name: string) => at(pieces.find((piece) => piece.id === `bulletin:0:${name}`), 900).x;
    expect(x("w0")).toBeGreaterThan(x("w1"));
  });

  test("the size scale scales the block about its anchor", () => {
    // 1.05 keeps the bar inside the safe area; a larger scale shifts the whole cue right (never scales it down).
    const big = bulletinProgram.build(inputFor(cues, { scale: 1.05 })).pieces;
    const plate = big.find((piece) => piece.id === "bulletin:0:plate0") as ShapePiece;
    expect(at(plate, 2200).x).toBeCloseTo(540 + (106 - 540) * 1.05, 6);
    expect((big.find((piece) => piece.id === "bulletin:0:w0") as TextPiece).sizePx).toBeCloseTo(63, 6);
    const huge = bulletinProgram.build(inputFor(cues, { scale: 2 })).pieces;
    expect(at(huge.find((piece) => piece.id === "bulletin:0:bar"), 2200).x).toBeGreaterThanOrEqual(54 - 0.5);
  });
});
