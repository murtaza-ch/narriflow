import { describe, expect, test } from "bun:test";
import { type DemoScript, demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import { SCENE_PIECE_BUDGET, type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { TRAIL_DEMO, TRAIL_KEYLINE, trailDisplay, trailHash, trailLetters, trailProgram, trailRise, trailRng, trailScale } from "./templates/trail";
import { fakeMeasure, sceneInput } from "./test-support";

const COLOURS = { primary: "#FFFFFF", highlight: "#F6F04A", accent: "#F0524F", shadow: "#000000" };
const ANCHOR = { xPct: 50, yPct: (1270 / 1920) * 100 };
const buildFor = (script: DemoScript, overrides = {}) => trailProgram.build(sceneInput(demoCues(script).cues, { anchor: ANCHOR, colours: COLOURS, ...overrides })).pieces;
const { cues } = demoCues(TRAIL_DEMO);
const scene = buildFor(TRAIL_DEMO);
const ofCue = (list: readonly Piece[], cue: number) => list.filter((piece) => piece.id.startsWith(`trail:${cue}:`));
const texts = (list: readonly Piece[]) => list.filter((piece): piece is TextPiece => piece.kind === "text");
const shapes = (list: readonly Piece[]) => list.filter((piece): piece is ShapePiece => piece.kind === "shape");
const layerOf = (piece: Piece) => Number(piece.id.slice(piece.id.lastIndexOf("c") + 1));
const face = (id: string) => scene.find((piece) => piece.id === `${id}c0`) as TextPiece;
const copy = (id: string, k: number) => scene.find((piece) => piece.id === `${id}c${k}`) as TextPiece;
const beats = (list: readonly Piece[]) => shapes(list);
const kindOf = (piece: Piece) => piece.id.split(":")[2]![0]!;

describe("Trail helpers", () => {
  test("hash and generator are deterministic and spread", () => {
    expect(trailHash("a")).toBe(trailHash("a"));
    expect(trailHash("a")).not.toBe(trailHash("b"));
    const r = trailRng(9);
    expect(new Set([...Array(40)].map(() => r())).size).toBe(40);
  });

  test("letters split for Latin, Greek and Cyrillic only, up to 12; other scripts stay whole and keep their case", () => {
    expect(trailLetters("WORKED")).toEqual([..."WORKED"]);
    expect(trailLetters("привет")).toHaveLength(6);
    for (const word of ["اچھا", "नमस्ते", "你好", "สวัสดี", "x".repeat(13)]) expect(trailLetters(word)).toBeNull();
    expect(trailDisplay("worked")).toBe("WORKED");
    expect(trailDisplay("اچھا")).toBe("اچھا");
  });

  test("the pose formulas are the sample's", () => {
    expect(trailScale(false, 0)).toBeCloseTo(0.3, 6);
    expect(trailScale(false, 300)).toBeCloseTo(1, 6);
    expect(trailScale(true, 150)).toBeCloseTo(1.4, 6);
    expect(trailScale(true, 540)).toBeCloseTo(1, 6);
    expect(trailRise(false, 0)).toBe(110);
    expect(trailRise(false, 380)).toBe(0);
    expect(trailRise(true, 0)).toBe(115);
    expect(trailRise(true, 190)).toBeCloseTo((1 - EASES.outExpo(prog(190, 0, 420))) * 115, 6);
  });
});

describe("Trail rows and the colour stack", () => {
  test("the demo's rows are the sample's: so I tried / this trick, and it / actually / WORKED, my sales / doubled", () => {
    // Lilita One at 116 px is about 0.62 em a letter: the fake 0.55 would let "and it actually" share one row.
    const wide = buildFor(TRAIL_DEMO, { measure: (text: string, face: never, size: number, ls: number) => ({ ...fakeMeasure(text, face, size, ls), advance: [...text].length * (0.63 + ls) * size - ls * size }) });
    const rowsOf = (cue: number) => {
      const rows = new Map<number, string[]>();
      for (const piece of texts(ofCue(wide, cue)).filter((p) => layerOf(p) === 0)) {
        const y = Math.round(evaluatePiece(piece, piece.fromMs + 330).y / 30);
        rows.set(y, [...(rows.get(y) ?? []), piece.text]);
      }
      return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, words]) => words.join(" "));
    };
    expect(rowsOf(0)).toEqual(["SO I TRIED", "THIS TRICK"]);
    expect(rowsOf(1)).toEqual(["AND IT", "ACTUALLY", "W O R K E D"]);
    expect(rowsOf(2)).toEqual(["MY SALES", "DOUBLED"]);
    expect(rowsOf(4)).toEqual(["NO JOKE"]);
  });

  test("a word is a white face on three colour copies with a navy keyline; the key word's stack is warm, and only it is 184 px", () => {
    const tried = scene.filter((p) => p.id.startsWith("trail:0:w2l0c")) as TextPiece[];
    expect(tried.map(layerOf).sort()).toEqual([0, 1, 2, 3]);
    expect(face("trail:0:w2l0").fill).toBe(COLOURS.primary);
    expect([1, 2, 3].map((k) => copy("trail:0:w2l0", k).fill)).toEqual([COLOURS.highlight, "#7DF58A", "#5BB8F0"]);
    expect([1, 2, 3].map((k) => copy("trail:1:w3l0", k).fill)).toEqual([COLOURS.highlight, COLOURS.accent, "#7A3CE6"]);
    expect(face("trail:0:w2l0").stroke).toMatchObject({ colour: TRAIL_KEYLINE });
    expect(face("trail:0:w2l0").sizePx).toBeCloseTo(116, 3);
    expect(face("trail:1:w3l0").sizePx).toBeCloseTo(184, 3);
    // The lead and tail words stay at body size: only the key word's row is big (the sample draws a whole row at 184).
    expect(face("trail:1:w2l0").sizePx).toBeCloseTo(116, 3);
    expect(texts(ofCue(scene, 1)).filter((p) => p.id.startsWith("trail:1:w3") && layerOf(p) === 0).map((p) => p.text).join("")).toBe("WORKED");
  });

  test("copies rest 0.068 em lower per step and close up on the face; mid-rise they trail it", () => {
    const id = "trail:0:w2l0";
    const piece = face(id);
    const size = 116;
    const rest = piece.fromMs + 700;
    for (let k = 1; k <= 3; k++) expect(evaluatePiece(copy(id, k), rest).y - evaluatePiece(piece, rest).y).toBeCloseTo(k * 0.068 * size, 0);
    const mid = piece.fromMs + 120;
    expect(evaluatePiece(copy(id, 3), mid).y - evaluatePiece(piece, mid).y).toBeGreaterThan(3 * 0.068 * size + 20);
  });

  test("a body word rises 110 px from 0.3 with outBack and lands exactly (no asymptotic tail)", () => {
    const piece = face("trail:0:w2l0");
    const dy = evaluatePiece(piece, piece.fromMs).y - evaluatePiece(piece, piece.fromMs + 600).y;
    expect(dy).toBeGreaterThan(105);
    expect(evaluatePiece(piece, piece.fromMs).sx).toBeCloseTo(0.3, 1);
    expect(evaluatePiece(piece, piece.fromMs + 600).sx).toBeCloseTo(1, 2);
    expect(piece.fromMs).toBe(cues[0]!.words[2]!.startMs - 60);
  });

  test("the key word's letters punch to 140 % one after another, 30 ms apart", () => {
    const letters = texts(ofCue(scene, 1)).filter((p) => p.id.startsWith("trail:1:w3") && layerOf(p) === 0);
    expect(letters).toHaveLength(6);
    for (const [at, piece] of letters.entries()) expect(piece.fromMs).toBeGreaterThanOrEqual(cues[1]!.words[3]!.startMs - 60 + at * 30);
    const w = letters[0]!;
    expect(evaluatePiece(w, cues[1]!.words[3]!.startMs - 60 + 150).sx).toBeCloseTo(1.4, 1);
  });

  test("the key word keeps a slow wave through the hold and the copies chase it", () => {
    const hold: DemoScript = { lines: ["wow:h@5000"], options: { tail: 1000 } };
    const piece = texts(buildFor(hold)).find((p) => p.id === "trail:0:w0l1c0")!;
    const ys: number[] = [];
    for (let t = piece.fromMs + 700; t < piece.toMs - 300; t += 40) ys.push(evaluatePiece(piece, t).y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(10);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(26);
  });

  test("the block lifts and shrinks to nothing by 60 ms before the cue ends, no fade", () => {
    const piece = face("trail:0:w2l0");
    expect(piece.toMs).toBeLessThanOrEqual(cues[0]!.endMs + 60);
    const end = piece.toMs - 1;
    expect(evaluatePiece(piece, end).sx).toBeLessThan(0.15);
    expect(evaluatePiece(piece, end).o).toBe(1);
    expect(evaluatePiece(piece, piece.toMs - 400).sx).toBeCloseTo(1, 2);
  });
});

describe("Trail recurs and varies", () => {
  const long: DemoScript = { lines: Array.from({ length: 6 }, () => TRAIL_DEMO.lines).flat(), options: TRAIL_DEMO.options };
  const many = buildFor(long);
  const { cues: all } = demoCues(long);

  test("every cue of a 30-cue clip gets stripes, a landing bar and pop ticks, hero or not", () => {
    expect(all).toHaveLength(30);
    all.forEach((_cue, at) => {
      const own = beats(ofCue(many, at));
      expect(own.filter((p) => kindOf(p) === "s")).toHaveLength(3);
      expect(own.some((p) => kindOf(p) === "b")).toBe(true);
      expect(own.filter((p) => kindOf(p) === "t").length).toBeGreaterThanOrEqual(2);
    });
  });

  test("stripes, bars and ticks cycle through their variants on a long clip", () => {
    const stripeSpans = new Set<string>();
    const barKinds = new Set<string>();
    const tickAngles = new Set<number>();
    all.forEach((_cue, at) => {
      const own = beats(ofCue(many, at));
      const s0 = own.find((p) => p.id.endsWith(":s0"))!;
      stripeSpans.add(`${evaluatePiece(s0, s0.toMs - 400).clip!.x1 < evaluatePiece(s0, s0.toMs - 400).x ? "L" : "R"}${Math.round((s0.path as readonly [string, number, number][])[1]![1] / 40)}`);
      const bars = own.filter((p) => kindOf(p) === "b");
      barKinds.add(`${bars.length}${bars[0]!.fill?.colour}`);
      for (const tick of own.filter((p) => kindOf(p) === "t")) tickAngles.add(Math.round(evaluatePiece(tick, tick.fromMs).rz / 10));
    });
    expect(stripeSpans.size).toBeGreaterThan(3);
    expect(barKinds.size).toBeGreaterThanOrEqual(3);
    expect(tickAngles.size).toBeGreaterThan(5);
  });

  test("counts on a 24+ cue clip: every cue draws the three decoration families", () => {
    const counts = { s: 0, b: 0, t: 0 };
    for (let at = 0; at < 30; at++) for (const p of beats(ofCue(many, at))) counts[kindOf(p) as "s" | "b" | "t"]++;
    expect(counts.s).toBe(90);
    expect(counts.b).toBeGreaterThanOrEqual(30);
    expect(counts.t).toBeGreaterThanOrEqual(90);
  });

  test("the decoration lands around the words and ends with the cue's exit", () => {
    for (let at = 0; at < 30; at++) {
      const own = ofCue(many, at);
      const exit = Math.max(...texts(own).map((p) => p.toMs));
      for (const piece of beats(own)) expect(piece.toMs).toBeLessThanOrEqual(exit);
    }
  });

  test("every cue stays inside the piece budget", () => {
    for (let at = 0; at < all.length; at++) {
      const count = ofCue(many, at).reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0);
      expect(count).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
    }
  });
});

describe("Trail with real speech timing", () => {
  test.each([60, 0])("cueGap %d: every word stays visible 150 ms after it lands", (cueGap) => {
    const pieces = buildFor({ ...TRAIL_DEMO, options: { ...TRAIL_DEMO.options, cueGap } });
    for (const piece of texts(pieces)) {
      const landed = [...Array(piece.toMs - piece.fromMs).keys()].map((at) => piece.fromMs + at).find((t) => evaluatePiece(piece, t).o > 0.9);
      expect(landed).toBeDefined();
      for (let t = landed!; t <= landed! + 150; t += 5) {
        const pose = evaluatePiece(piece, t);
        expect(pose.visible).toBe(true);
        expect(pose.o).toBeGreaterThan(0.9);
        if (t >= landed! + 60) expect(pose.sx).toBeGreaterThan(0.2);
      }
    }
  });

  test("the last word of a cue gets 300 ms to rise before the exit starts, even with a 60 ms gap", () => {
    const pieces = buildFor({ ...TRAIL_DEMO, options: { ...TRAIL_DEMO.options, cueGap: 60 } });
    for (const piece of texts(pieces).filter((p) => layerOf(p) === 0)) expect(piece.toMs - piece.fromMs).toBeGreaterThanOrEqual(300);
  });
});

describe("Trail in other scripts and frames", () => {
  test("Urdu words are whole pieces with their text, the hero too, and the stripes mirror to the right", () => {
    const own = ofCue(trailProgram.build(sceneInput(sceneEdgeDemo("urdu").cues, { anchor: ANCHOR, colours: COLOURS })).pieces, 0);
    expect(texts(own).filter((p) => layerOf(p) === 0).map((p) => p.text).sort()).toEqual(["یہ", "بہت", "اچھا", "ہے"].sort());
  });

  test("the key word is not forgotten: every spoken word appears on the nine-word and no-hero edge demos", () => {
    for (const kind of ["nine-words", "no-hero", "one-word", "two-speakers"] as const) {
      const demo = sceneEdgeDemo(kind);
      const out = trailProgram.build(sceneInput(demo.cues, { anchor: ANCHOR, colours: COLOURS })).pieces;
      demo.cues.forEach((cue, at) => {
        const shown = texts(ofCue(out, at)).filter((p) => layerOf(p) === 0).map((p) => p.text).join("").replaceAll(" ", "");
        expect(shown).toBe(cue.words.map((w) => w.text.toUpperCase()).join("").replaceAll(" ", ""));
      });
    }
  });

  test("edge demos stay inside the safe area in 9:16, 1:1 and 16:9, decoration included", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const kind of ["long-word", "nine-words", "one-word", "urdu", "no-hero", "two-speakers"] as const) {
        const pieces = trailProgram.build(sceneInput(sceneEdgeDemo(kind).cues, { canvas, anchor: ANCHOR, colours: COLOURS })).pieces;
        for (let t = 0; t < 9000; t += 33) {
          const box = sceneBoundsAt(pieces, t, fakeMeasure);
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
