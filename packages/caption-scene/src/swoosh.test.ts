import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { evaluatePiece, pieceBounds } from "./scene";
import { swooshProgram } from "./templates/swoosh";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("swoosh", swooshProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFFFFF", highlight: "#FFE21A", accent: "#FF4672", shadow: "#000000" };
const build = (lines: string[], options: Record<string, number> = {}, language?: string, fps = 30) => {
  const { cues } = demoCues({ lines, language, options: { lead: 400, gap: 30, cueGap: 160, tail: 600, ...options } });
  return { cues, pieces: swooshProgram.build(sceneInput(cues, { fps, colours })).pieces };
};

describe("swoosh", () => {
  test("smoke", () => {
    const { pieces } = build(["so:m I:m built:h@500 it:m myself:b", "never:b stop:b"]);
    expect(pieces.length).toBeGreaterThan(5);
    const hero = pieces.find((piece) => piece.id === "swoosh:0:w2")!;
    expect(evaluatePiece(hero, hero.toMs - 200).colour).toBe("#FFE21A");
    expect(pieceBounds(hero, hero.toMs - 200, fakeMeasure)).not.toBeNull();
  });
});

const faces = (pieces: ReturnType<typeof build>["pieces"], cue: number) => pieces.filter((piece) => new RegExp(`^swoosh:${cue}:w\\d+(l\\d+)?$`).test(piece.id));
const decorations = (pieces: ReturnType<typeof build>["pieces"], cue: number) => pieces.filter((piece) => piece.id.startsWith(`swoosh:${cue}:`) && piece.kind === "shape");
const overlap = (a: { x1: number; y1: number; x2: number; y2: number }, b: typeof a) => Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 0.5 && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 0.5;
const settledAt = (cue: { words: readonly { endMs: number }[] }) => cue.words.at(-1)!.endMs + 120;

/** Rows inside the safe area, no two words of a cue overlapping, no decoration on any word, once the cue has settled. */
function expectClean(lines: string[], language: string, canvas = { width: 1080, height: 1920 }) {
  const { cues } = demoCues({ lines, language, options: { lead: 400, gap: 30, cueGap: 600, tail: 600 } });
  const pieces = swooshProgram.build(sceneInput(cues, { fps: 30, colours, canvas })).pieces;
  const safe = { x1: 0.05 * canvas.width, y1: 0.05 * canvas.height, x2: 0.95 * canvas.width, y2: 0.95 * canvas.height };
  for (const cue of cues) {
    const own = faces(pieces, cue.index);
    expect(new Set(own.map((piece) => piece.id.match(/w(\d+)/)![1])).size, `${language} cue ${cue.index}`).toBe(cue.words.length);
    for (const t of [settledAt(cue), settledAt(cue) + 80]) {
      const boxes = own.map((piece) => ({ id: piece.id, box: pieceBounds(piece, t, fakeMeasure)! }));
      for (const { id, box } of boxes) {
        expect(box, `${id} at ${t}`).not.toBeNull();
        expect(box.x1 >= safe.x1 && box.x2 <= safe.x2 && box.y1 >= safe.y1 && box.y2 <= safe.y2, `${id} inside the safe area`).toBe(true);
      }
      for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(overlap(a.box, b.box), `${a.id} and ${b.id} overlap at ${t}`).toBe(false);
      for (const shape of decorations(pieces, cue.index)) {
        const box = pieceBounds(shape, t, fakeMeasure);
        if (!box) continue;
        for (const face of boxes) expect(overlap(box, face.box), `${shape.id} on ${face.id} at ${t}`).toBe(false);
      }
    }
  }
  return { cues, pieces };
}

describe("swoosh layout", () => {
  test("a key word mid-cue starts the second line, stepped in and below the first", () => {
    const { cues, pieces } = build(["so:m I:m built:h@500 it:m myself:b"]);
    const t = settledAt(cues[0]!);
    const at = (w: number) => pieceBounds(pieces.find((piece) => piece.id === `swoosh:0:w${w}`)!, t, fakeMeasure)!;
    expect(at(2).y1).toBeGreaterThan(at(0).y2 - 1);
    expect(at(2).x1).toBeGreaterThan(at(0).x1 + 40);
    expect(Math.abs((at(3).y1 + at(3).y2) / 2 - (at(2).y1 + at(2).y2) / 2)).toBeLessThan(at(2).y2 - at(2).y1);
  });

  test("a cue without a key word splits in halves; a key word first sits alone on top", () => {
    const { cues, pieces } = build(["nobody:b believed:b in:m me:m", "dream:h@540 bigger:b"]);
    const box = (cue: number, w: number) => pieceBounds(pieces.find((piece) => piece.id === `swoosh:${cue}:w${w}`)!, settledAt(cues[cue]!), fakeMeasure)!;
    expect(box(0, 2).y1).toBeGreaterThan(box(0, 1).y2 - 1);
    expect(box(0, 1).y2).toBeGreaterThan(box(0, 0).y1);
    expect(box(1, 1).y1).toBeGreaterThan(box(1, 0).y2 - 1);
  });

  test("right-to-left cues step in from the right: the second line sits further left", () => {
    const { cues, pieces } = build(["یہ:m بہت:b ضروری:h@520 ہے"], {}, "ur");
    const t = settledAt(cues[0]!);
    const at = (w: number) => pieceBounds(pieces.find((piece) => piece.id === `swoosh:0:w${w}`)!, t, fakeMeasure)!;
    expect(at(2).x2).toBeLessThan(at(0).x2 - 30);
    expect(at(0).x1).toBeGreaterThan(at(1).x2 - 1); // یہ reads first, on the right
    expect(at(3).x2).toBeLessThan(at(2).x1 + 1); // ہے after the key word, to its left
  });
});

describe("swoosh languages", () => {
  test("Devanagari with a key word: whole words, rows inside, nothing covered", () => {
    const { pieces } = expectClean(["यह:m बहुत:h@520 ज़रूरी:b है", "और:m अगर:b इसे:m सीधा:h@400"], "hi");
    expect(pieces.some((piece) => /^swoosh:\d+:w\d+l\d+$/.test(piece.id))).toBe(false);
  });

  test("Urdu with a key word: whole words, rows inside, nothing covered, the swoosh mirrored", () => {
    const { cues, pieces } = expectClean(["یہ:m بہت:b ضروری:h@520 ہے"], "ur");
    const sw = pieces.find((piece) => piece.id === "swoosh:0:sw2")!;
    const hero = pieces.find((piece) => piece.id === "swoosh:0:w2")!;
    const t = cues[0]!.words[2]!.startMs - 40;
    const swBox = pieceBounds(sw, t, fakeMeasure)!;
    expect((swBox.x1 + swBox.x2) / 2).toBeLessThan(evaluatePiece(hero, t + 400).x);
  });

  test("a CJK cue with no spaces wraps into rows at a readable size, never below the floor", () => {
    const { pieces } = expectClean(["我们今天一起学习如何制作非常好看的短视频字幕效果:h@900", "今天我们一起学习如何制作短视频字幕"], "zh");
    const parts = pieces.filter((piece) => /^swoosh:0:w0l\d+$/.test(piece.id));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe("我们今天一起学习如何制作非常好看的短视频字幕效果");
    for (const piece of parts) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(96);
    for (const piece of pieces.filter((p) => /^swoosh:1:w0l\d+$/.test(p.id))) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(64);
  });

  test("mixed Latin and digits, and accented Latin: rows inside, nothing covered, text as spoken", () => {
    expectClean(["Top:b 10:h@500 tips:b for:m 2026"], "en");
    const { pieces } = expectClean(["Ça:b déménage:h@500 très:b vite"], "fr");
    expect(pieces.find((piece) => piece.id === "swoosh:0:w1")!.kind === "text" && (pieces.find((piece) => piece.id === "swoosh:0:w1") as { text: string }).text).toBe("déménage");
  });

  test("16:9 keeps every language clean", () => {
    const wide = { width: 1920, height: 1080 };
    expectClean(["यह:m बहुत:h@520 ज़रूरी:b है"], "hi", wide);
    expectClean(["یہ:m بہت:b ضروری:h@520 ہے"], "ur", wide);
    expectClean(["so:m I:m built:h@500 it:m myself:b", "never:b stop:b"], "en", wide);
  });
});

describe("swoosh motion", () => {
  test("an ordinary word is settled and opaque at its spoken start when it has a lead, and slides only as far as its neighbour allows", () => {
    const { cues, pieces } = build(["so:m I:m built:h@500 it:m myself:b"]);
    for (const w of [0, 1, 3, 4]) {
      const face = pieces.find((piece) => piece.id === `swoosh:0:w${w}`)!;
      const s = cues[0]!.words[w]!.startMs;
      const rest = evaluatePiece(face, s + 300);
      const at = evaluatePiece(face, s);
      expect(at.o).toBe(1);
      expect(Math.abs(at.x - rest.x)).toBeLessThan(0.01);
      expect(face.fromMs).toBeGreaterThanOrEqual(s - 90);
    }
    // A sliding word never starts inside an earlier word of its cue (the key word's coral offset included).
    for (const line of [["so:m I:m built:h@500 it:m myself:b"], ["the:m remote:b doesn't:h@360 work.:b"], ["we:m didn't:h@200 want:b"]]) {
      const run = build(line);
      const own = run.pieces.filter((piece) => /^swoosh:0:w\d+o?$/.test(piece.id));
      for (const face of own.filter((piece) => /w\d+$/.test(piece.id))) {
        for (let t = face.fromMs + 1; t < face.fromMs + 100; t += 10) {
          const box = pieceBounds(face, t, fakeMeasure);
          if (!box) continue;
          for (const other of own) {
            if (other.id.startsWith(face.id) || other.fromMs >= face.fromMs) continue;
            const ob = pieceBounds(other, t, fakeMeasure);
            if (ob) expect(overlap(box, ob), `${face.id} meets ${other.id} at ${t}`).toBe(false);
          }
        }
      }
    }
  });

  test("words land tinted with the brush colour and dry to their own colour", () => {
    const { cues, pieces } = build(["never:b stop:b"]);
    const face = pieces.find((piece) => piece.id === "swoosh:0:w0")!;
    expect(evaluatePiece(face, face.fromMs).colour).not.toBe("#FFFFFF");
    expect(evaluatePiece(face, cues[0]!.words[0]!.startMs + 260).colour).toBe("#FFFFFF");
  });

  test("the key word swings: sheared, squeezed and leaning at first, upright and full size once settled, yellow", () => {
    const { cues, pieces } = build(["so:m I:m built:h@500 it:m myself:b"]);
    const hero = pieces.find((piece) => piece.id === "swoosh:0:w2")!;
    const s = cues[0]!.words[2]!.startMs;
    const early = evaluatePiece(hero, hero.fromMs + 5);
    expect(Math.abs(early.skx)).toBeGreaterThan(20);
    expect(early.sx).toBeLessThan(0.7);
    const late = evaluatePiece(hero, s + 400);
    expect(Math.abs(late.skx)).toBeLessThan(0.01);
    expect(late.sx).toBeCloseTo(1, 3);
    expect(late.colour).toBe("#FFE21A");
    expect(evaluatePiece(hero, s - 5).o).toBeGreaterThan(0.9);
  });

  test("every key-word cue gets a swoosh that is gone soon after the key word; no piece paints more than 100 ms before the cue", () => {
    const { cues, pieces } = build(["dream:h@540 bigger:b", "so:m I:m built:h@500 it:m myself:b", "you:m got:h@480 this:b"], { cueGap: 60 });
    for (const cue of cues) {
      const hero = cue.words.findIndex((word) => word.role === "hero");
      const strokes = pieces.filter((piece) => piece.id.startsWith(`swoosh:${cue.index}:sw${hero}`));
      expect(strokes.length, `cue ${cue.index}`).toBe(4);
      for (const piece of strokes) {
        expect(piece.toMs).toBeLessThanOrEqual(cue.words[hero]!.startMs + 160);
        expect(piece.z).toBeLessThan(5);
      }
      for (const piece of pieces.filter((p) => p.id.startsWith(`swoosh:${cue.index}:`))) expect(piece.fromMs).toBeGreaterThanOrEqual(cue.words[0]!.startMs - 100);
    }
  });

  test("bristles fly on key-word cues and a brush flick holds under cues without one, across a long clip", () => {
    const lines = Array.from({ length: 24 }, (_, i) => (i % 3 === 2 ? "never:b stop:b now:b" : `so:m I:m built:h@400 it${i}:b`));
    const { cues, pieces } = build(lines, { cueGap: 120 });
    let sprays = 0;
    let flicks = 0;
    for (const cue of cues) {
      const heroed = cue.words.some((word) => word.role === "hero");
      const own = pieces.filter((piece) => piece.id.startsWith(`swoosh:${cue.index}:`));
      if (heroed && own.some((piece) => piece.id.includes(":sp"))) sprays++;
      if (!heroed) {
        const flick = own.find((piece) => /:fl\d+$/.test(piece.id));
        if (flick) {
          flicks++;
          expect(evaluatePiece(flick, cue.words.at(-1)!.endMs + 200).sx).toBeCloseTo(1, 2);
        }
      }
    }
    expect(sprays).toBeGreaterThanOrEqual(15);
    expect(flicks).toBe(8);
  });

  test("a brand colour that cannot read on the dark edge falls back; a brand highlight also colours the swoosh", () => {
    const { cues } = demoCues({ lines: ["so:m I:m built:h@500 it:m"], options: { lead: 400 } });
    const run = (own: Partial<typeof colours>) => swooshProgram.build(sceneInput(cues, { fps: 30, colours: { ...colours, ...own } })).pieces;
    const dark = run({ primary: "#101010", highlight: "#202020" });
    expect(evaluatePiece(dark.find((piece) => piece.id === "swoosh:0:w0")!, 3000).colour).toBe("#FFFFFF");
    expect(evaluatePiece(dark.find((piece) => piece.id === "swoosh:0:w2")!, 3000).colour).toBe("#FFE21A");
    const brand = run({ highlight: "#3CE0FF" });
    const stroke = brand.find((piece) => piece.id === "swoosh:0:sw2")!;
    expect(stroke.kind === "shape" && stroke.fill?.colour).toBe("#3CE0FF");
    expect(evaluatePiece(brand.find((piece) => piece.id === "swoosh:0:w2")!, 3000).colour).toBe("#3CE0FF");
  });

  test("a long word breaks into even rows at a readable size; edge demos stay under the piece budget at twice the size", () => {
    const word = "pneumonoultramicroscopicsilicovolcanoconiosis";
    const { pieces } = build([`${word}:h@900`]);
    const parts = pieces.filter((piece) => /^swoosh:0:w0l\d+$/.test(piece.id));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(word);
    const lengths = parts.map((piece) => (piece.kind === "text" ? piece.text.length : 0));
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(0.6 * Math.max(...lengths));
    for (const edge of ["urdu", "nine-words", "long-word"] as const) {
      const { cues } = sceneEdgeDemo(edge);
      const built = swooshProgram.build(sceneInput(cues, { fps: 30, colours, scale: 2 })).pieces;
      for (const cue of cues) expect(built.filter((piece) => piece.id.startsWith(`swoosh:${cue.index}:`)).length).toBeLessThanOrEqual(150);
    }
  });
});
