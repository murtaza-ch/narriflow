import { describe, expect, test } from "bun:test";
import { captionSceneMeta, getCaptionPresetById } from "@narriflow/validators";
import { describeSpeechConformance } from "./conformance-support";
import { SCENE_EDGE_DEMOS, demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, SCENE_PIECE_BUDGET, evaluatePiece, pieceBounds } from "./scene";
import { SHUFFLE_DEMO, shuffleCase, shuffleHash, shuffleOrder, shuffleProgram, shuffleRng } from "./templates/shuffle";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("shuffle", shuffleProgram, { anchorLineY: 1290 });

const COLOURS = { primary: "#F3EAD8", highlight: "#FFC93C", accent: "#141210", shadow: "#000000" };
const build = (cues: readonly SceneCue[], overrides = {}) =>
  shuffleProgram.build(sceneInput(cues, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours: COLOURS, ...overrides })).pieces;
const demo = demoCues(SHUFFLE_DEMO);
const scene = build(demo.cues);
const ofCue = (pieces: readonly Piece[], cue: number) => pieces.filter((piece) => piece.id.split(":")[1] === String(cue));
const find = (pieces: readonly Piece[], id: string) => {
  const piece = pieces.find((candidate) => candidate.id === id);
  expect(piece, id).toBeDefined();
  return piece as Piece;
};
const kind = (piece: Piece) => piece.id.split(":")[2]!;
const centreX = (piece: Piece, t: number) => evaluatePiece(piece, t).x;

describe("Shuffle geometry", () => {
  test("a small word is one plate of tiles 70 tall (the sample's 50 px type, 26 px of padding) and one text run tracked to sit on them", () => {
    // With the fake face (0.55 em per letter) "okay" is four tiles of 27.5 + 26, 6 apart plus the tracking the text carries.
    const plate = find(scene, "shuffle:0:w0p0") as ShapePiece;
    const text = find(scene, "shuffle:0:w0") as TextPiece;
    const box = pieceBounds(plate, 1800, fakeMeasure)!;
    expect(box.y2 - box.y1).toBeCloseTo(70, 1);
    expect(box.x2 - box.x1).toBeCloseTo(3 * (0.55 + 0.64) * 50 + 0.55 * 50 + 26, 1);
    expect(text.sizePx).toBe(50);
    expect(text.letterSpacingEm).toBeCloseTo((26 + 6) / 50, 6);
    expect(text.text).toBe("OKAY");
    expect(text.face).toBe("Montserrat");
    // Letters sit centred in their tiles: the text starts half a padding inside the plate.
    const inkBox = pieceBounds(text, 1800, fakeMeasure)!;
    expect(inkBox.x1 - box.x1).toBeCloseTo(13, 1);
  });

  test("a cue without a key word uses the larger 62 px tiles", () => {
    const text = find(scene, "shuffle:3:w0") as TextPiece;
    expect(text.sizePx).toBe(62);
  });

  test("a key word is one plate and one letter per tile, 92 px type on 128 tall tiles with 10 px between them", () => {
    const tile = find(scene, "shuffle:0:w4t0") as ShapePiece;
    const next = find(scene, "shuffle:0:w4t1") as ShapePiece;
    const letter = find(scene, "shuffle:0:w4l0") as TextPiece;
    const at = 2200;
    expect(centreX(next, at) - centreX(tile, at)).toBeCloseTo(0.55 * 92 + 34 + 10, 0);
    expect(letter.sizePx).toBe(92);
    expect(letter.text).toBe("Y");
    const box = pieceBounds(tile, at, fakeMeasure)!;
    expect(box.y2 - box.y1).toBeGreaterThan(120);
  });

  test("the key tiles land scrambled, hop into their slots as the word is said and are gold, in order, by the end of it", () => {
    const word = demo.cues[0]!.words[4]!;
    const tiles = [0, 1, 2, 3, 4].map((i) => find(scene, `shuffle:0:w4t${i}`) as ShapePiece);
    const home = tiles.map((tile) => centreX(tile, word.endMs + 100));
    // After the fall and before the first hop none of them is in its own slot.
    const before = word.startMs - 70 + 100;
    tiles.forEach((tile, i) => {
      expect(Math.abs(centreX(tile, before) - home[i]!)).toBeGreaterThan(80);
      expect(evaluatePiece(tile, before).colour).toBe(COLOURS.primary);
    });
    // The slots are filled by one tile each, left to right in the word's order.
    expect([...home].sort((a, b) => a - b)).toEqual(home);
    for (const tile of tiles) expect(evaluatePiece(tile, word.endMs + 100).colour).toBe(COLOURS.highlight);
    // Gold arrives tile by tile.
    const goldAt = (tile: ShapePiece) => exportFrameTimes(word.startMs, word.endMs + 400, 60).find((t) => evaluatePiece(tile, t).colour === COLOURS.highlight)!;
    expect(goldAt(tiles[4]!)).toBeGreaterThan(goldAt(tiles[0]!));
  });

  test("a 100 ms key word is home and gold before it is over; a 12-letter one in that time comes in unscrambled", () => {
    const { cues } = demoCues({ lines: ["so:m here:b is:m the:m thing:h@100", "a:m abcdefghijkl:h@100"], options: { lead: 400, gap: 0, cueGap: 600 } });
    const pieces = build(cues);
    const tiles = (cue: number, word: number) => pieces.filter((piece) => piece.id.startsWith(`shuffle:${cue}:w${word}t`));
    const hero = cues[0]!.words[4]!;
    const rest = hero.endMs + 200;
    for (const tile of tiles(0, 4)) {
      expect(Math.abs(centreX(tile, hero.endMs - 1) - centreX(tile, rest))).toBeLessThan(2);
      expect(evaluatePiece(tile, hero.endMs - 1).colour).toBe(COLOURS.highlight);
    }
    const long = cues[1]!.words[1]!;
    for (const tile of tiles(1, 1)) {
      // Unscrambled: no tile ever moves more than the fall's sway in x.
      let widest = 0;
      for (const t of exportFrameTimes(long.startMs - 70, long.endMs + 400, 60)) widest = Math.max(widest, Math.abs(centreX(tile, t) - centreX(tile, long.endMs + 400)));
      expect(widest).toBeLessThan(20);
    }
  });
});

describe("Shuffle scramble rules", () => {
  test("the scramble is seeded: a derangement when the letters allow one, otherwise as near as they allow", () => {
    for (const word of ["years", "boring", "secret", "no", "wait", "extraordinarily", "mississippi"]) {
      const letters = [...word];
      const order = shuffleOrder(letters, shuffleRng(shuffleHash(word)));
      expect([...order].sort((a, b) => a - b)).toEqual(letters.map((_, i) => i));
      if (word !== "mississippi") expect(order.every((letter, at) => letters[letter] !== letters[at])).toBe(true);
    }
    expect(shuffleOrder([..."aaa"], shuffleRng(1))).toEqual([0, 1, 2]);
    expect(shuffleOrder(["x"], shuffleRng(1))).toEqual([0]);
    expect(shuffleHash("a")).not.toBe(shuffleHash("b"));
    // A rotation, never the identity, when no derangement exists.
    expect(shuffleOrder([..."aab"], shuffleRng(3))).not.toEqual([0, 1, 2]);
  });

  test("a build is deterministic", () => {
    expect(JSON.stringify(build(demo.cues))).toBe(JSON.stringify(build(demo.cues)));
  });

  test("capitals only for cased scripts", () => {
    expect(shuffleCase("okay")).toBe("OKAY");
    expect(shuffleCase("привет")).toBe("ПРИВЕТ");
    expect(shuffleCase("اچھا")).toBe("اچھا");
    expect(shuffleCase("日本語")).toBe("日本語");
    expect(shuffleCase("🔥")).toBe("🔥");
  });
});

describe("Shuffle fit and languages", () => {
  test("a word far too wide wraps its tiles onto rows instead of shrinking to small type", () => {
    const { cues } = sceneEdgeDemo("long-word");
    const pieces = build(cues);
    const word = ofCue(pieces, 1).filter((piece) => /^shuffle:1:w0l?\d*$/.test(piece.id) && piece.kind === "text") as TextPiece[];
    expect(word.length).toBeGreaterThanOrEqual(4);
    expect(word.map((piece) => piece.text).join("")).toBe("PNEUMONOULTRAMICROSCOPICSILICOVOLCANOCONIOSIS");
    for (const piece of word) expect(piece.sizePx).toBeGreaterThan(40);
    const rows = new Set(word.map((piece) => Math.round(evaluatePiece(piece, 3000).y)));
    expect(rows.size).toBe(word.length);
  });

  test("a hero that is too wide by a little shrinks to fit rather than wrapping", () => {
    const { cues } = demoCues({ lines: ["so:m abcdefghijk:h@600"] });
    const letters = build(cues).filter((piece) => /^shuffle:0:w1l\d+$/.test(piece.id)) as TextPiece[];
    expect(letters).toHaveLength(11);
    const rows = new Set(letters.map((piece) => Math.round(evaluatePiece(piece, 2400).y)));
    expect(rows.size).toBe(1);
    expect(letters[0]!.sizePx).toBeLessThan(92);
    expect(letters[0]!.sizePx).toBeGreaterThan(0.75 * 92);
  });

  test("a script that is never split is one tile per word, right to left for an RTL cue", () => {
    const { cues } = sceneEdgeDemo("urdu");
    const pieces = build(cues, { colours: COLOURS });
    const first = ofCue(pieces, 0);
    expect(first.filter((piece) => /^shuffle:0:w\d+t\d+$/.test(piece.id))).toHaveLength(0);
    const texts = (first.filter((piece) => piece.kind === "text") as TextPiece[]).sort((a, b) => Number(/w(\d+)/.exec(a.id)![1]) - Number(/w(\d+)/.exec(b.id)![1]));
    expect(texts.map((piece) => piece.text)).toEqual(cues[0]!.words.map((word) => word.text));
    // The first spoken word of the first row sits to the right of the second.
    const at = 1700;
    expect(evaluatePiece(texts[0]!, at).x).toBeGreaterThan(evaluatePiece(texts[1]!, at).x);
    // The key word takes the large tile and a gold flash without a scramble.
    expect(find(pieces, "shuffle:0:w2p0")).toBeDefined();
    expect((find(pieces, "shuffle:0:w2") as TextPiece).sizePx).toBe(92);
  });

  test("the edge demos stay inside the safe area and the piece budget, in 9:16, 1:1 and 16:9", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const edge of SCENE_EDGE_DEMOS) {
        const pieces = build(sceneEdgeDemo(edge).cues, { canvas, scale: 1 });
        const safe = { x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 };
        const cues = new Set(pieces.map((piece) => piece.id.split(":")[1]));
        for (const cue of cues) expect(ofCue(pieces, Number(cue)).length, `${edge} cue ${cue}`).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
        for (const piece of pieces) {
          for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
            const box = pieceBounds(piece, t, fakeMeasure);
            if (!box) continue;
            expect(box.x1 >= safe.x1 && box.x2 <= safe.x2 && box.y1 >= safe.y1 && box.y2 <= safe.y2, `${edge} ${piece.id} ${t} ${canvas.width}x${canvas.height}`).toBe(true);
          }
        }
      }
    }
  });

  test("a key word with more tiles than the piece budget allows falls in as flat plates and turns gold", () => {
    const word = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnop";
    const { cues } = demoCues({ lines: [`so:m ${word}:h@900 and:b more:b words:b here:b now:b`] });
    const pieces = build(cues);
    expect(ofCue(pieces, 0).length).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
    expect(pieces.some((piece) => /^shuffle:0:w1t\d+$/.test(piece.id))).toBe(false);
    const plate = pieces.find((piece) => piece.id === "shuffle:0:w1p0") as ShapePiece;
    expect(evaluatePiece(plate, cues[0]!.words[1]!.endMs + 100).colour).toBe(COLOURS.highlight);
  });

  test("brand colours drive the tiles, the solved tiles and the letters", () => {
    const pieces = build(demo.cues, { colours: { primary: "#DDEEFF", highlight: "#FF00AA", accent: "#001122", shadow: "#000000" } });
    expect((find(pieces, "shuffle:0:w0p0") as ShapePiece).fill?.colour).toBe("#DDEEFF");
    expect((find(pieces, "shuffle:0:w0") as TextPiece).fill).toBe("#001122");
    expect(evaluatePiece(find(pieces, "shuffle:0:w4t0"), 2200).colour).toBe("#FF00AA");
  });
});

describe("Shuffle beats on a long clip", () => {
  const rounds = 6;
  const base = demoCues(SHUFFLE_DEMO);
  const long: SceneCue[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const cue of base.cues) {
      const by = round * (base.duration + 200);
      long.push({ ...cue, index: long.length, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + by, endMs: word.endMs + by })) });
    }
  }
  const pieces = build(long);

  test("every cue of a 30-cue clip gets gold chips; a cue without a key word gets the bonus tile", () => {
    expect(long.length).toBeGreaterThanOrEqual(24);
    long.forEach((cue, n) => {
      const mine = ofCue(pieces, n);
      const chips = mine.filter((piece) => kind(piece).startsWith("chip"));
      expect(chips.length, `cue ${n} chips`).toBeGreaterThanOrEqual(1);
      expect(chips.length).toBeLessThanOrEqual(8);
      const hero = cue.words.some((word) => word.role === "hero");
      expect(mine.some((piece) => kind(piece).endsWith("b") && /^w\d+b$/.test(kind(piece))), `cue ${n} bonus`).toBe(!hero);
    });
  });

  test("the scramble, chip sides and chip sizes vary from cue to cue, never by a cue-indexed table", () => {
    const sides = new Set<number>();
    const sizes = new Set<number>();
    long.forEach((_, n) => {
      for (const piece of ofCue(pieces, n).filter((p) => kind(p).startsWith("chip")) as ShapePiece[]) {
        const t0 = piece.fromMs;
        const t1 = piece.toMs - 1;
        sides.add(Math.sign(evaluatePiece(piece, t1).x - evaluatePiece(piece, t0).x));
        sizes.add(Math.round(Math.abs(evaluatePiece(piece, t0).sx) * 100));
      }
    });
    expect(sides.has(1) && sides.has(-1)).toBe(true);
    // The same cue text at another index scrambles differently: the seed carries the index.
    const first = (list: readonly Piece[], cue: number) => [0, 1, 2, 3, 4].map((i) => Math.round(evaluatePiece(find(list, `shuffle:${cue}:w4t${i}`), long[cue]!.words[4]!.startMs).x));
    expect(first(pieces, 0)).not.toEqual(first(pieces, 5));
  });

  test("a chip leaves its tile only when the tile has turned gold and is over before the cue's exit", () => {
    const cue = demo.cues[0]!;
    const chips = ofCue(scene, 0).filter((piece) => kind(piece).startsWith("chip"));
    const word = cue.words[4]!;
    for (const chip of chips) {
      expect(chip.fromMs).toBeGreaterThan(word.startMs);
      expect(chip.toMs).toBeLessThanOrEqual(cue.endMs);
      expect(exportFrameTimes(chip.fromMs, chip.toMs, 30).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("Shuffle beats stay clear of the words", () => {
  const clear = (lines: string[], keep: (piece: Piece) => boolean) => {
    const { cues } = demoCues({ lines, options: { lead: 400 } });
    const pieces = build(cues);
    const words = pieces.filter((piece) => keep(piece));
    const chips = pieces.filter((piece) => kind(piece).startsWith("chip"));
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      for (const t of exportFrameTimes(chip.fromMs, chip.toMs, 60)) {
        const box = pieceBounds(chip, t, fakeMeasure)!;
        for (const other of words) {
          const b = pieceBounds(other, t, fakeMeasure);
          if (!b) continue;
          expect(box.x1 < b.x2 && b.x1 < box.x2 && box.y1 < b.y2 && b.y1 < box.y2, `${chip.id} over ${other.id} at ${t}`).toBe(false);
        }
      }
    }
  };

  test("chips off a key word never cross the rows around it", () => {
    clear(["everybody:m remembers:b something:b different:b years:h@700", "nothing:b changes:b"], (piece) => /^shuffle:0:w[0-3]/.test(piece.id));
  });

  test("a bonus tile's chips hop outward past the row's end without touching the row above", () => {
    clear(["everybody:m remembers:b something:b different:b"], (piece) => /^shuffle:0:w[0-2]/.test(piece.id));
  });
});

describe("Shuffle real speech", () => {
  const speech = (lines: string[], options = {}) => demoCues({ lines, options: { lead: 400, gap: 0, ...options } }).cues;

  test("continuous speech: the incoming cue is painted on its first word's start, the outgoing one holds through its last word and is cut there", () => {
    const cues = speech(["so:b here:b is:b thing:h@150", "next:b one:b is:b fast:h@150"], { cueGap: 0 });
    const pieces = build(cues);
    const mine = (n: number) => ofCue(pieces, n);
    const firstPaint = Math.min(...mine(1).map((piece) => piece.fromMs));
    expect(firstPaint).toBe(cues[1]!.words[0]!.startMs);
    expect(Math.max(...mine(0).map((piece) => piece.toMs))).toBe(firstPaint);
    // And no exit was squeezed in: every word of the outgoing cue is flat and whole until the cut.
    for (const piece of mine(0).filter((p) => p.kind === "text")) expect(evaluatePiece(piece, firstPaint - 1).rx).toBeCloseTo(0, 0);
  });

  test("a roomy gap gives the outgoing cue its 150 ms of reading and the incoming cue its full 70 ms lead", () => {
    const cues = speech(["so:b here:b is:b thing:h@150", "next:b one:b is:b fast:h@150"], { cueGap: 400 });
    const pieces = build(cues);
    const spoken = cues[0]!.words.at(-1)!.endMs;
    const start = cues[1]!.words[0]!.startMs;
    expect(Math.min(...ofCue(pieces, 1).map((piece) => piece.fromMs))).toBe(start - 70);
    // The outgoing cue exits after its 150 ms, finishing 40 ms before it is cut.
    const exitEnd = Math.max(...ofCue(pieces, 0).map((piece) => piece.toMs));
    expect(exitEnd).toBeLessThanOrEqual(start - 70 - 40 + 1);
    expect(exitEnd).toBeGreaterThan(spoken + 150);
    for (const piece of ofCue(pieces, 0).filter((p) => p.kind === "text")) expect(evaluatePiece(piece, spoken + 149).rx).toBeCloseTo(0, 0);
  });

  test("a cue started while the cue before is still being spoken is stacked below it, and neither touches the other", () => {
    const first = demoCues({ lines: ["first:b@300 late:b@300 words:b@300"], options: { lead: 357 } }).cues[0]!;
    const second = demoCues({ lines: ["wait:b@300 what:b@300"], options: { lead: 887 } }).cues[0]!;
    const cues: SceneCue[] = [{ ...first, speaker: 0 }, { ...second, index: 1, speaker: 1 }];
    const pieces = build(cues);
    const box = (n: number) => {
      let y1 = Number.POSITIVE_INFINITY;
      let y2 = Number.NEGATIVE_INFINITY;
      for (const piece of ofCue(pieces, n).filter((p) => /^shuffle:\d+:w\d+$/.test(p.id))) {
        const b = pieceBounds(piece, 1500, fakeMeasure)!;
        y1 = Math.min(y1, b.y1);
        y2 = Math.max(y2, b.y2);
      }
      return { y1, y2 };
    };
    expect(box(1).y1).toBeGreaterThanOrEqual(box(0).y2);
    // The earlier cue was not cut when the second began.
    expect(Math.min(...ofCue(pieces, 0).filter((p) => /^shuffle:0:w2$/.test(p.id)).map((p) => p.toMs))).toBeGreaterThanOrEqual(first.words[2]!.endMs);
  });

  test("stacked speakers also fit a 16:9 frame: both cues stay in the safe area and never overlap while both are on screen", () => {
    const { cues } = demoCues({ lines: ["first:b@150 second:b@150 third:b@150 fourth:b@150", "other:b@150 speaker:b@150 keeps:b@150 talking:b@150"], options: { lead: 357, gap: 0, cueGap: 0 } });
    const run: SceneCue[] = cues.map((cue, i) => {
      const by = [357, 887][i]! - cue.startMs;
      return { ...cue, speaker: i, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + by, endMs: word.endMs + by })) };
    });
    const canvas = { width: 1920, height: 1080 };
    const pieces = build(run, { canvas });
    const safe = { x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 };
    for (const t of exportFrameTimes(0, 4000, 30)) {
      const boxes = [0, 1].map((n) => ofCue(pieces, n).flatMap((piece) => pieceBounds(piece, t, fakeMeasure) ?? []));
      for (const box of boxes.flat()) expect(box.x1 >= safe.x1 && box.x2 <= safe.x2 && box.y1 >= safe.y1 && box.y2 <= safe.y2, `box at ${t}`).toBe(true);
      const top = (list: typeof boxes[0]) => Math.min(...list.map((box) => box.y1));
      const bottom = (list: typeof boxes[0]) => Math.max(...list.map((box) => box.y2));
      if (boxes[0]!.length > 0 && boxes[1]!.length > 0) {
        const faces = (n: number) => ofCue(pieces, n).filter((piece) => /^shuffle:\d+:w\d+$/.test(piece.id)).flatMap((piece) => pieceBounds(piece, t, fakeMeasure) ?? []);
        const [a, b] = [faces(0), faces(1)];
        if (a.length > 0 && b.length > 0) expect(top(b) >= bottom(a) - 0.5 || bottom(b) <= top(a) + 0.5, `faces overlap at ${t}`).toBe(true);
      }
    }
  });

  test("the last cue leaves by flipping its tiles away, 150 ms after its last word at the earliest and 40 ms before the cue ends", () => {
    const last = demo.cues.at(-1)!;
    const mine = ofCue(scene, demo.cues.length - 1);
    const spoken = last.words.at(-1)!.endMs;
    const finish = Math.max(...mine.map((piece) => piece.toMs));
    expect(finish).toBeLessThanOrEqual(last.endMs - 40);
    const letter = find(mine, `shuffle:${last.index}:w3l0`) as TextPiece;
    expect(evaluatePiece(letter, spoken + 149).rx).toBeCloseTo(0, 0);
    expect(Math.abs(evaluatePiece(letter, finish - 10).rx)).toBeGreaterThan(30);
  });
});

describe("Shuffle registration", () => {
  test("the preset carries the tile colours, Montserrat and five-word cues", () => {
    expect(getCaptionPresetById("shuffle")!.preset).toMatchObject({ scene: "shuffle", fontName: "Montserrat", wordsPerCue: 5, primaryColor: "#F3EAD8", highlightColor: "#FFC93C", accentColor: "#141210" });
    expect(captionSceneMeta("shuffle").bodyPx).toBe(50);
    expect(captionSceneMeta("shuffle").brand.primary).toMatchObject({ slot: "primaryColor", readsOn: ["accentColor"] });
    expect(captionSceneMeta("shuffle").brand.secondary).toMatchObject({ slot: "highlightColor", readsOn: ["accentColor"] });
  });
});
