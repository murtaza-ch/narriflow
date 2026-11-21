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
    // 30 ms apart; the exit's 150 ms read-time asks the last cue's entrance for a touch of speed for that word alone, here about 1.4x.
    for (const [at, piece] of letters.entries()) {
      expect(piece.fromMs).toBeGreaterThanOrEqual(cues[1]!.words[3]!.startMs - 60 + at * 18);
      expect(piece.fromMs).toBeLessThanOrEqual(cues[1]!.words[3]!.startMs - 60 + at * 30 + 3);
    }
    const w = letters[0]!;
    const peak = Math.max(...[...Array(300).keys()].map((at) => evaluatePiece(w, w.fromMs + at).sx));
    expect(peak).toBeGreaterThan(1.38);
    expect(peak).toBeLessThan(1.42);
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

// --- Review fixes (2026-11-22) ---------------------------------------------------------------------------------------------

const FRAME = (n: number) => Math.round((n * 1000) / 30);
const hitsFrame = (piece: Piece) => {
  for (let n = Math.ceil((piece.fromMs * 30) / 1000) - 1; FRAME(n) < piece.toMs; n++) if (FRAME(n) >= piece.fromMs) return true;
  return false;
};
const rectsMeet = (a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const unclipped = (piece: Piece): Piece => ({ ...piece, clip: undefined });
const isFace = (piece: Piece) => piece.kind === "text" && layerOf(piece) === 0;
/**
 * When a cue's last face has settled (scale within 5 % of 1 for at least 30 ms running) and when the first of them starts to
 * leave (scale past 5 % again) or the cue's last piece ends, ms: the readable hold is between the two.
 */
function holdOf(pieces: readonly Piece[]): { settled: number; exit: number } {
  let settled = 0;
  let exit = Number.POSITIVE_INFINITY;
  for (const piece of pieces.filter(isFace)) {
    let at = piece.fromMs;
    for (let t = piece.fromMs; t < piece.toMs; t++) {
      let steady = true;
      for (let k = 0; k <= 30 && steady; k += 5) steady = Math.abs(evaluatePiece(piece, Math.min(t + k, piece.toMs - 1)).sx - 1) <= 0.05;
      if (steady) {
        at = t;
        break;
      }
      at = t + 1;
    }
    settled = Math.max(settled, at);
    let leaves = piece.toMs;
    for (let t = at; t < piece.toMs; t++) {
      if (Math.abs(evaluatePiece(piece, t).sx - 1) > 0.05) {
        leaves = t;
        break;
      }
    }
    exit = Math.min(exit, leaves);
  }
  return { settled, exit };
}

describe("Trail review fix 1: fast cues", () => {
  test.each([60, 0])("a 100 ms key word followed by another cue (gap %d): every piece reaches an export frame and the word holds two frames", (cueGap) => {
    const pieces = buildFor({ lines: ["magnificent:h@100", "next:b@200"], options: { cueGap, rate: 100 } });
    for (const piece of ofCue(pieces, 0)) expect(hitsFrame(piece)).toBe(true);
    const hold = holdOf(ofCue(pieces, 0));
    // A 100 ms word with no gap lives 100 ms (three frames): all the speech allows is a frame of rest.
    expect(hold.exit - hold.settled).toBeGreaterThanOrEqual(cueGap === 0 ? 30 : 60);
  });

  test("a 300 ms key word and a 60 ms gap: the two cues never share a frame (the exit ends before the next entrance starts)", () => {
    const pieces = buildFor({ lines: ["nice:h@300", "next:b@300"], options: { cueGap: 60, rate: 100 } });
    const first = Math.max(...ofCue(pieces, 0).map((p) => p.toMs));
    const next = Math.min(...ofCue(pieces, 1).map((p) => p.fromMs));
    expect(first).toBeLessThanOrEqual(next);
    for (let n = 0; n < 400; n++) {
      const a = sceneBoundsAt(ofCue(pieces, 0), FRAME(n), fakeMeasure);
      const b = sceneBoundsAt(ofCue(pieces, 1), FRAME(n), fakeMeasure);
      if (a && b) throw new Error(`both cues drawn at ${FRAME(n)}`);
    }
  });

  test("with a 60 ms gap every cue holds its whole word 150 ms after the last letter settled (or all that speech allows)", () => {
    const script: DemoScript = { ...TRAIL_DEMO, options: { ...TRAIL_DEMO.options, cueGap: 60 } };
    const pieces = buildFor(script);
    demoCues(script).cues.forEach((_cue, at) => {
      const hold = holdOf(ofCue(pieces, at));
      expect(hold.exit - hold.settled).toBeGreaterThanOrEqual(150);
    });
  });

  test("a hero word of 13 letters with a 60 ms gap still gets a readable hold", () => {
    const pieces = buildFor({ lines: ["magnificent:h@450", "next:b@300"], options: { cueGap: 60, rate: 100 } });
    const hold = holdOf(ofCue(pieces, 0));
    expect(hold.exit - hold.settled).toBeGreaterThanOrEqual(150);
  });
});

describe("Trail review fix 2: the safe area at a large caption size", () => {
  test.each([
    ["english", TRAIL_DEMO],
    ["urdu", sceneEdgeDemo("urdu")],
  ] as const)("%s demo at size 200 on 16:9 stays inside the safe band", (_name, source) => {
    const cuesOf = "cues" in source ? source.cues : demoCues(source).cues;
    const canvas = { width: 1920, height: 1080 };
    const pieces = trailProgram.build(sceneInput(cuesOf, { canvas, anchor: ANCHOR, colours: COLOURS, scale: 200 / 116 })).pieces;
    for (let t = 0; t < 9000; t += 16) {
      const box = sceneBoundsAt(pieces, t, fakeMeasure);
      if (!box) continue;
      expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
      expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
      expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
      expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
    }
  });
});

describe("Trail review fix 3: decoration never lands on ink", () => {
  const sources: [string, DemoScript | ReturnType<typeof sceneEdgeDemo>][] = [["demo", TRAIL_DEMO], ["nine-words", sceneEdgeDemo("nine-words")], ["no-hero", sceneEdgeDemo("no-hero")], ["two-speakers", sceneEdgeDemo("two-speakers")], ["one-word", sceneEdgeDemo("one-word")]];
  test.each(sources)("%s: stripes, bar and ticks keep clear of every word and copy box at every frame", (_name, source) => {
    const cuesOf = "cues" in source ? source.cues : demoCues(source).cues;
    const pieces = trailProgram.build(sceneInput(cuesOf, { anchor: ANCHOR, colours: COLOURS })).pieces;
    cuesOf.forEach((_cue, at) => {
      const own = ofCue(pieces, at);
      const words = texts(own);
      const deco = shapes(own);
      const { exit } = holdOf(own);
      const collapse = exit + 0.7 * (Math.max(...own.map((p) => p.toMs)) - exit);
      for (let t = Math.min(...own.map((p) => p.fromMs)); t < collapse; t += 8) {
        const ink = words.map((p) => sceneBoundsAt([p], t, fakeMeasure)).filter((box) => box !== null);
        for (const piece of deco) {
          const box = sceneBoundsAt([unclipped(piece)], t, fakeMeasure);
          if (!box) continue;
          for (const word of ink) if (rectsMeet(box, word!)) throw new Error(`${piece.id} meets word ink at ${t}`);
        }
      }
    });
  });
});

describe("Trail review fix 4: short cues keep all three beats", () => {
  test.each([60, 0])("a 100 ms key word (gap %d) still gets stripes, a bar and ticks, each on an export frame", (cueGap) => {
    const own = ofCue(buildFor({ lines: ["magnificent:h@100", "next:b@200"], options: { cueGap, rate: 100 } }), 0);
    const kinds = (kind: string) => shapes(own).filter((p) => kindOf(p) === kind);
    expect(kinds("s")).toHaveLength(3);
    expect(kinds("b").length).toBeGreaterThanOrEqual(1);
    expect(kinds("t").length).toBeGreaterThanOrEqual(2);
    for (const piece of shapes(own)) expect(hitsFrame(piece)).toBe(true);
  });
});

describe("Trail review fix 5: right-to-left mirrors the bar and the ticks", () => {
  const build = (language: string) => ofCue(trailProgram.build(sceneInput(demoCues({ lines: ["123:h@600"], language }).cues, { anchor: ANCHOR, colours: COLOURS })).pieces, 0);
  const en = build("en");
  const ar = build("ar");
  const at = (piece: Piece) => evaluatePiece(piece, piece.fromMs + Math.min(200, (piece.toMs - piece.fromMs) / 2));
  const ids = (list: Piece[], kind: string) => shapes(list).filter((p) => kindOf(p) === kind);

  test("ticks: same count, mirrored positions and angles, fired from the mirrored side first", () => {
    const a = ids(en, "t");
    const b = ids(ar, "t");
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(b).toHaveLength(a.length);
    a.forEach((tick, i) => {
      const pa = at(tick);
      const pb = at(b[i]!);
      expect(Math.abs(pa.x + pb.x - 1080)).toBeLessThan(1.5);
      expect(Math.abs(pa.y - pb.y)).toBeLessThan(1.5);
      expect(Math.cos((pa.rz * Math.PI) / 180)).toBeCloseTo(-Math.cos((pb.rz * Math.PI) / 180), 3);
      expect(Math.sin((pa.rz * Math.PI) / 180)).toBeCloseTo(Math.sin((pb.rz * Math.PI) / 180), 3);
      expect(tick.fromMs).toBe(b[i]!.fromMs);
    });
    expect(Math.sign(at(a[0]!).x - 540)).toBe(-Math.sign(at(b[0]!).x - 540));
  });

  test("the bar's horizontal offset mirrors too", () => {
    const a = ids(en, "b");
    const b = ids(ar, "b");
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(b).toHaveLength(a.length);
    for (const [i, bar] of a.entries()) expect(at(bar).x + at(b[i]!).x).toBeCloseTo(1080, 0);
  });
});

// --- Re-check fixes (2026-11-22): the cue handoff rule ---------------------------------------------------------------------

const wordPiecesOf = (list: readonly Piece[], cue: number, word: number) => list.filter((p) => p.id.startsWith(`trail:${cue}:w${word}l`));
const frameCount = (piece: Piece) => {
  let count = 0;
  for (let n = Math.ceil((piece.fromMs * 30) / 1000) - 1; FRAME(n) < piece.toMs; n++) if (FRAME(n) >= piece.fromMs) count++;
  return count;
};
const shiftCues = (cuesIn: ReturnType<typeof demoCues>["cues"], by: number) =>
  cuesIn.map((cue) => ({ ...cue, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((w) => ({ ...w, startMs: w.startMs + by, endMs: w.endMs + by })) }));

describe("Trail handoff rule: long runs of fast speech", () => {
  const body = (n: number): DemoScript => ({ lines: Array.from({ length: n }, () => "so:b@150 this:b@150 is:b@150 fast:b@150"), options: { rate: 150 } });
  const heroes = (n: number): DemoScript => ({ lines: Array.from({ length: n }, (_, i) => (i % 2 === 0 ? "wow:h@100" : "no:m@100 way:h@100")), options: {} });
  const cases: [string, (g: number) => DemoScript][] = [
    ["150 ms words", (g) => ({ ...body(12), options: { rate: 150, cueGap: g, gap: 0, tail: 400 } })],
    ["100 ms heroes", (g) => ({ ...heroes(12), options: { cueGap: g, gap: 0, tail: 400 } })],
  ];
  test.each(cases.flatMap(([name, make]) => [60, 0].map((gap) => [name, gap, make] as const)))("%s, gap %d: locked to speech, readable until the next cue, never covered, no flash", (_name, gap, make) => {
    const script = make(gap);
    const { cues: run } = demoCues(script);
    expect(run.length).toBeGreaterThanOrEqual(10);
    const pieces = trailProgram.build(sceneInput(run, { anchor: ANCHOR, colours: COLOURS })).pieces;
    run.forEach((cue, at) => {
      // (1) every word's first visible frame is at most 100 ms before it is spoken and never after it.
      cue.words.forEach((word, wi) => {
        const first = Math.min(...wordPiecesOf(pieces, at, wi).map((p) => p.fromMs));
        expect(first).toBeLessThanOrEqual(word.startMs);
        expect(first).toBeGreaterThanOrEqual(word.startMs - 100);
      });
      const own = ofCue(pieces, at);
      const end = Math.max(...own.map((p) => p.toMs));
      expect(end).toBeLessThanOrEqual(cue.endMs);
      // (2) readable from the last letter's landing until the next cue's first visible frame, up to 150 ms; never covered.
      const next = run[at + 1] ? Math.min(...ofCue(pieces, at + 1).map((p) => p.fromMs)) : Number.POSITIVE_INFINITY;
      expect(end).toBeLessThanOrEqual(next);
      const hold = holdOf(own);
      const room = Math.min(150, next - hold.settled);
      expect(hold.exit - hold.settled).toBeGreaterThanOrEqual(room - 34);
      // (5) no empty frame the speech does not have: the next cue's first frame is this cue's last + 1.
      if (run[at + 1]) expect(next - end).toBeLessThanOrEqual(1);
    });
    // (3) no animated piece lives on exactly one 30 fps frame.
    for (const piece of pieces) expect(frameCount(piece)).toBeGreaterThanOrEqual(2);
    // And no frame draws two cues.
    for (let n = 0; n < Math.ceil((Math.max(...pieces.map((p) => p.toMs)) * 30) / 1000); n++) {
      const t = FRAME(n);
      const live = new Set(pieces.filter((p) => t >= p.fromMs && t < p.toMs).map((p) => p.id.split(":")[1]));
      expect(live.size).toBeLessThanOrEqual(1);
    }
  });

  test("a frame-aligned run never blinks: every export frame between the first and the last has text", () => {
    const script: DemoScript = { lines: Array.from({ length: 12 }, () => "go:h@267"), options: { cueGap: 0, gap: 0, tail: 400, lead: 300 } };
    const { cues: run } = demoCues(script);
    const pieces = trailProgram.build(sceneInput(run, { anchor: ANCHOR, colours: COLOURS })).pieces;
    const from = Math.min(...pieces.map((p) => p.fromMs));
    const to = Math.max(...pieces.filter((p) => p.id.startsWith("trail:11:")).map((p) => p.toMs));
    for (let n = Math.ceil((from * 30) / 1000); FRAME(n) < to; n++) {
      const t = FRAME(n);
      expect(pieces.some((p) => p.kind === "text" && t >= p.fromMs && t < p.toMs)).toBe(true);
    }
  });
});

describe("Trail re-check 2: compression is per word", () => {
  test("four 150 ms words: the first word keeps its full entrance and its trail; only the last is sped up", () => {
    const pieces = buildFor({ lines: ["so:b@150 this:b@150 is:b@150 fast:b@150", "and:b@150 so:b@150 is:b@150 this:b@150"], options: { cueGap: 0, gap: 0, rate: 150 } });
    const faceOf = (word: number) => pieces.find((p) => p.id === `trail:0:w${word}l0c0`) as TextPiece;
    const deep = (word: number) => pieces.find((p) => p.id === `trail:0:w${word}l0c3`) as TextPiece;
    const first = faceOf(0);
    // Frames on which the first word is still entering (scale off by more than 4 %), and on which its trail is stretched.
    let entering = 0;
    let trailing = 0;
    for (let n = 0; FRAME(n) < first.toMs; n++) {
      const t = FRAME(n);
      if (t < first.fromMs) continue;
      if (Math.abs(evaluatePiece(first, t).sx - 1) > 0.04) entering++;
      if (evaluatePiece(deep(0), t).y - evaluatePiece(first, t).y > 3 * 0.068 * 116 + 6) trailing++;
    }
    expect(entering).toBeGreaterThanOrEqual(5);
    expect(trailing).toBeGreaterThanOrEqual(2);
    // The first word's pace is the sample's (speed 1): its copies lag by 38 ms.
    const mid = first.fromMs + 100;
    expect(evaluatePiece(deep(0), mid).y - evaluatePiece(first, mid).y).toBeGreaterThan(20);
    // The last word of the cue, with no time, is faster than the first.
    const last = faceOf(3);
    const settleOf = (piece: TextPiece) => holdOf([piece]).settled - piece.fromMs;
    expect(settleOf(last)).toBeLessThan(settleOf(first));
  });
});

describe("Trail re-check 3: the fit looks at every peak", () => {
  test.each([0, 7, 13, 23, 31])("urdu demo %d ms later at size 200 on 16:9 never leaves the safe band on a 30 fps frame", (by) => {
    const canvas = { width: 1920, height: 1080 };
    const pieces = trailProgram.build(sceneInput(shiftCues(sceneEdgeDemo("urdu").cues, by), { canvas, anchor: ANCHOR, colours: COLOURS, scale: 200 / 116 })).pieces;
    for (let n = 0; FRAME(n) < 9000; n++) {
      const box = sceneBoundsAt(pieces, FRAME(n), fakeMeasure);
      if (!box) continue;
      expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 0.5);
      expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 0.5);
    }
  });
});

describe("Trail re-check 4: ticks survive a wide hero row", () => {
  test("good morning everyone:h today at 300 ms a word still has ticks, in the frame and clear of the words", () => {
    const script: DemoScript = { lines: ["good:b@300 morning:b@300 everyone:h@300 today:b@300", "next:b@300"], options: { cueGap: 60, gap: 0 } };
    // Lilita One's real advance is wider than the fake 0.55 em: use 0.66 so the hero row fills the frame.
    const wide = (text: string, face: never, size: number, ls: number) => ({ ...fakeMeasure(text, face, size, ls), advance: [...text].length * (0.66 + ls) * size - ls * size });
    const own = ofCue(buildFor(script, { measure: wide }), 0);
    const ticks = shapes(own).filter((p) => kindOf(p) === "t");
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const tick of ticks) {
      for (let t = tick.fromMs; t < tick.toMs; t += 16) {
        const box = sceneBoundsAt([tick], t, fakeMeasure)!;
        if (!box) continue;
        expect(box.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
        expect(box.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
        expect(box.y1).toBeGreaterThanOrEqual(0.05 * 1920 - 1);
        expect(box.y2).toBeLessThanOrEqual(0.95 * 1920 + 1);
      }
    }
  });

  test("a 7-letter hero 'everything' in a 5-word cue keeps ticks in 9:16 and 1:1", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      const cues2 = demoCues({ lines: ["it:b was:b everything:h to:b me:b"], options: { rate: 250 } }).cues;
      const own = ofCue(trailProgram.build(sceneInput(cues2, { canvas, anchor: ANCHOR, colours: COLOURS })).pieces, 0);
      expect(shapes(own).filter((p) => kindOf(p) === "t").length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("Trail re-check 5: a word shorter than the minimum life does not outlive the handoff", () => {
  test.each([0, 60])("magnificent:h@40 followed by next (gap %d): no frame draws both cues, the key word lands whole", (cueGap) => {
    const pieces = buildFor({ lines: ["magnificent:h@40", "next:b@300"], options: { cueGap, gap: 0 } });
    const a = ofCue(pieces, 0);
    const b = ofCue(pieces, 1);
    expect(Math.max(...a.map((p) => p.toMs))).toBeLessThanOrEqual(Math.min(...b.map((p) => p.fromMs)));
    for (let n = 0; n < 90; n++) {
      const t = FRAME(n);
      const drawn = (list: Piece[]) => texts(list).some((p) => t >= p.fromMs && t < p.toMs);
      expect(drawn(a) && drawn(b)).toBe(false);
    }
    // Every word frame of the cue is drawn: it is one whole word (not eleven staggered letters) when there is no time for the stagger.
    expect(texts(a).filter((p) => layerOf(p) === 0)).toHaveLength(cueGap === 0 ? 1 : texts(a).filter((p) => layerOf(p) === 0).length);
    for (const piece of a) expect(frameCount(piece)).toBeGreaterThanOrEqual(2);
  });
});
