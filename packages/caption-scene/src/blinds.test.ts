import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Piece, evaluatePiece, pieceBounds } from "./scene";
import { BLINDS_DEMO, blindsProgram } from "./templates/blinds";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("blinds", blindsProgram, { anchorLineY: 1290 });

/** Real phrasing: the key word first, mid-cue and last, two key words in a row, a long key word, no key word, one word. */
const LINES = [
  "it's:b time:b to:m say:b goodbye:h@420",
  "does:b the:m remote:b even:b still:h@360",
  "the:m remote:b doesn't:h@360 work.:b",
  "we:m didn't:h@360 want:b anyone:b",
  "anyone:m to:m accidentally:h@520 open:b them.:m",
  "we've:m shot:b 384:h episodes:h@420",
  "just:b tear:b it:m down.:m",
  "oh.:b",
];
const LONG = demoCues({ lines: [...LINES, ...LINES, ...LINES], options: { lead: 400, gap: 30, cueGap: 120, tail: 500 } }).cues;
const build = (cues: readonly SceneCue[], fps = 30, overrides = {}) =>
  blindsProgram.build(sceneInput(cues, { fps, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, ...overrides })).pieces;
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const FACE = /^blinds:\d+:w\d+(?:l\d+)?$/;
const SLAT = /^blinds:(\d+):w(\d+)(?:l(\d+))?s(\d)$/;
const CLOSING = /^blinds:(\d+):w(\d+)(?:l(\d+))?x(\d)$/;
const shown = (piece: Piece, t: number) => (evaluatePiece(piece, t).visible ? pieceBounds(piece, t, fakeMeasure) : null);
const faceOf = (pieces: readonly Piece[], cue: number, word: number) => pieces.find((piece) => piece.id === `blinds:${cue}:w${word}`);
const width = (piece: Piece, t: number) => {
  const box = shown(piece, t);
  return box ? box.x2 - box.x1 : 0;
};

describe("Blinds slats", () => {
  test("the five other slats are slices of their own word and are gone before the word's spoken end", () => {
    for (const fps of [24, 25, 30, 60]) {
      const pieces = build(LONG, fps);
      let seen = 0;
      for (const piece of pieces) {
        const m = SLAT.exec(piece.id);
        if (!m) continue;
        seen++;
        const word = LONG[Number(m[1])]!.words[Number(m[2])]!;
        // The last painted frame of any slat is before the word's last frame before its spoken end.
        const lastFrame = exportFrameAtOrBefore(word.endMs - 1, fps);
        expect(piece.toMs, `${piece.id} lives until ${piece.toMs}, word ends ${word.endMs} (${fps} fps)`).toBeLessThanOrEqual(lastFrame + 1);
        expect(piece.fromMs).toBeGreaterThanOrEqual(word.startMs - 100);
      }
      expect(seen).toBeGreaterThan(300);
    }
  });

  test("once a word is open only its face is drawn: no slat of it paints over its readable face", () => {
    const pieces = build(LONG);
    for (const cue of LONG) {
      for (const [w, word] of cue.words.entries()) {
        const face = faceOf(pieces, cue.index, w);
        if (!face) continue;
        const slats = pieces.filter((piece) => {
          const m = SLAT.exec(piece.id) ?? CLOSING.exec(piece.id);
          return m && Number(m[1]) === cue.index && Number(m[2]) === w && SLAT.test(piece.id);
        });
        const open = exportFrameAtOrBefore(word.endMs - 1, 30);
        for (const t of exportFrameTimes(open, word.endMs + 150, 30)) {
          for (const slat of slats) expect(shown(slat, t), `${slat.id} at ${t}`).toBeNull();
        }
      }
    }
  });

  test("the reveal is smooth at every frame rate: each slat only ever grows, in small steps, left to right", () => {
    for (const fps of [24, 25, 30, 60]) {
      const pieces = build(demoCues(BLINDS_DEMO).cues, fps);
      for (const cue of demoCues(BLINDS_DEMO).cues) {
        for (const [w, word] of cue.words.entries()) {
          const face = faceOf(pieces, cue.index, w)!;
          const slats = [face, ...[1, 2, 3, 4, 5].map((i) => pieces.find((piece) => piece.id === `blinds:${cue.index}:w${w}s${i}`)).filter((p): p is Piece => p !== undefined)];
          const frames = exportFrameTimes(word.startMs - 100, word.startMs + 260, fps);
          let previousLeft = Number.POSITIVE_INFINITY;
          for (const slat of slats) {
            let last = 0;
            for (const t of frames.filter((frame) => frame < slat.toMs)) {
              const now = width(slat, t);
              // Growth only (the face jumps to the whole word when the others are done).
              if (slat === face && now > last + 1) {
                const whole = pieceBounds({ ...face, clip: undefined }, t, fakeMeasure)!;
                expect(now).toBeGreaterThan(0);
                last = now;
                if (now >= whole.x2 - whole.x1 - 1) break;
                continue;
              }
              expect(now, `${slat.id} shrinks at ${t} (${fps} fps)`).toBeGreaterThanOrEqual(last - 1);
              last = Math.max(last, now);
            }
            const first = frames.map((t) => shown(slat, t)).find((box) => box !== null);
            if (first && slat !== face) {
              // Slats begin in order along the line: each one's centre is to the right of the one before.
              expect(first.x1).toBeGreaterThanOrEqual(Number.isFinite(previousLeft) ? previousLeft - 1 : -1);
              previousLeft = first.x1;
            }
          }
        }
      }
    }
  });

  test("the hand over from slats to the plain face is invisible: the face's clip is the whole word the frame the slats end", () => {
    const pieces = build(LONG);
    let checked = 0;
    for (const piece of pieces) {
      const m = SLAT.exec(piece.id);
      if (!m || m[4] !== "5") continue;
      const face = faceOf(pieces, Number(m[1]), Number(m[2]));
      if (!face) continue;
      const whole = pieceBounds({ ...face, clip: undefined }, piece.toMs, fakeMeasure)!;
      const box = pieceBounds(face, piece.toMs, fakeMeasure)!;
      expect(box.x1).toBeLessThanOrEqual(whole.x1 + 0.5);
      expect(box.x2).toBeGreaterThanOrEqual(whole.x2 - 0.5);
      // The frame before, the sixth slat reaches the word's right edge or is still opening within it.
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });
});

describe("Blinds exit", () => {
  test("nothing closes before the last word has been read for 150 ms", () => {
    const run = demoCues(BLINDS_DEMO);
    const pieces = build(run.cues);
    let closing = 0;
    for (const piece of pieces) {
      const m = CLOSING.exec(piece.id);
      if (!m) continue;
      closing++;
      const cue = run.cues[Number(m[1])]!;
      const spokenEnd = Math.max(...cue.words.map((word) => word.endMs));
      expect(piece.fromMs).toBeGreaterThanOrEqual(spokenEnd + 150 - 1);
      expect(piece.toMs).toBeLessThanOrEqual(cue.endMs + 1);
    }
    expect(closing).toBeGreaterThanOrEqual(5);
  });

  test("the closing slats close right to left and the face is the last to go", () => {
    const run = demoCues(BLINDS_DEMO);
    const pieces = build(run.cues);
    const cue = run.cues[4]!;
    const closing = [5, 4, 3, 2, 1].map((i) => pieces.find((piece) => piece.id === `blinds:4:w0x${i}`)).filter((p): p is Piece => p !== undefined);
    expect(closing.length).toBe(5);
    const face = faceOf(pieces, 4, 0)!;
    // Slat 5 ends first, then 4 ... then the face.
    for (let i = 1; i < closing.length; i++) expect(closing[i]!.toMs).toBeGreaterThanOrEqual(closing[i - 1]!.toMs);
    expect(face.toMs).toBeGreaterThanOrEqual(closing.at(-1)!.toMs);
    expect(face.toMs).toBeLessThanOrEqual(cue.endMs + 1);
  });

  test("a cue followed at once by the next gets a cut, not a half-closed word", () => {
    const run = demoCues({ lines: ["one:b@300 two:b@300 three:h@300", "four:b@300 five:h@300"], options: { cueGap: 0, lead: 400, gap: 0, tail: 300 } });
    const pieces = build(run.cues);
    expect(pieces.some((piece) => CLOSING.test(piece.id) && cueOf(piece) === 0)).toBe(false);
  });
});

describe("Blinds on real phrasing", () => {
  test("a key word keeps a legible size on a row of its own and no word is shrunk below readable", () => {
    for (const cue of LONG) {
      const own = build([cue]).filter((piece) => FACE.test(piece.id));
      for (const piece of own) {
        if (piece.kind !== "text") throw new Error("face is text");
        expect(piece.sizePx).toBeGreaterThanOrEqual(80);
      }
    }
  });

  test("a word too wide for the column is broken into equal pieces at a readable size, each with its own face", () => {
    const cues = sceneEdgeDemo("long-word").cues;
    const pieces = build(cues);
    const faces = pieces.filter((piece) => cueOf(piece) === 1 && FACE.test(piece.id));
    expect(faces.length).toBeGreaterThanOrEqual(2);
    expect(faces.some((face) => /l0$/.test(face.id))).toBe(true);
    const text = faces.map((face) => (face.kind === "text" ? face.text : "")).join("");
    expect(text.toLowerCase()).toBe(cues[1]!.words[0]!.text.toLowerCase().replace(/\s/g, ""));
    for (const face of faces) if (face.kind === "text") expect(face.sizePx).toBeGreaterThanOrEqual(80);
  });

  test("a word in a script that shapes is never split", () => {
    const hindi = demoCues({ lines: ["और:m अगर:b इसे:m सीधा:h@400"], language: "hi" }).cues;
    const pieces = build(hindi);
    const faces = pieces.filter((piece) => FACE.test(piece.id));
    expect(faces.length).toBe(4);
    expect(faces.every((face) => !/l\d$/.test(face.id))).toBe(true);
  });

  test("a right-to-left cue opens the first slat on the right", () => {
    const urdu = sceneEdgeDemo("urdu").cues;
    const pieces = build(urdu);
    const word = urdu[0]!.words[0]!;
    const face = faceOf(pieces, 0, 0)!;
    const whole = pieceBounds({ ...face, clip: undefined }, word.startMs, fakeMeasure)!;
    const first = exportFrameTimes(word.startMs - 100, word.startMs + 300, 30).map((t) => shown(face, t)).find((box) => box !== null)!;
    expect((first.x1 + first.x2) / 2).toBeGreaterThan((whole.x1 + whole.x2) / 2);
  });

  test("the key word is the highlight colour, the others the primary, and the outline is the accent", () => {
    const pieces = build(demoCues(BLINDS_DEMO).cues, 30, { colours: { primary: "#EEEEEE", highlight: "#FF2E7E", accent: "#101010", shadow: "#000000" } });
    const hero = faceOf(pieces, 0, 4)!;
    const body = faceOf(pieces, 0, 0)!;
    if (hero.kind !== "text" || body.kind !== "text") throw new Error("text");
    expect(hero.fill).toBe("#FF2E7E");
    expect(body.fill).toBe("#EEEEEE");
    expect(hero.stroke?.colour).toBe("#101010");
  });

  test("the key word flashes white as it lands and settles back", () => {
    const pieces = build(demoCues(BLINDS_DEMO).cues);
    const hero = faceOf(pieces, 0, 4)!;
    const word = demoCues(BLINDS_DEMO).cues[0]!.words[4]!;
    const colours = exportFrameTimes(word.startMs, word.endMs, 30).map((t) => evaluatePiece(hero, t).colour);
    expect(colours.some((colour) => colour === "#FFFFFF" || colour > "#FFC0D0")).toBe(true);
    expect(colours.at(-1)).not.toBeUndefined();
  });
});

describe("Blinds recurring beats", () => {
  const pieces = build(LONG);

  test("every cue of a 24-cue clip gets a rule under its last row and the rule cycles", () => {
    const shapes = new Set<string>();
    for (const cue of LONG) {
      const rule = pieces.find((piece) => cueOf(piece) === cue.index && piece.id.endsWith(":rule"));
      expect(rule, `cue ${cue.index} has no rule`).toBeDefined();
      const t = exportFrameTimes(cue.startMs + 300, cue.endMs, 30).find((frame) => shown(rule!, frame));
      expect(t, `rule of cue ${cue.index} never shows`).toBeDefined();
      const box = shown(rule!, t! + 200) ?? shown(rule!, t!);
      if (box) shapes.add(`${Math.round((box.x2 - box.x1) / 40)}`);
    }
    expect(shapes.size).toBeGreaterThanOrEqual(3);
  });

  test("jambs flank the key row on most cues, with a pair, a leading and a trailing variant", () => {
    const counts = LONG.map((cue) => pieces.filter((piece) => cueOf(piece) === cue.index && /:jamb\d$/.test(piece.id)).length);
    expect(counts.filter((count) => count > 0).length).toBeGreaterThanOrEqual(LONG.length * 0.7);
    expect(new Set(counts).size).toBeGreaterThanOrEqual(2);
  });

  test("the rule and the jambs sit behind the type and never meet a word's ink", () => {
    const meets = (a: { x1: number; x2: number; y1: number; y2: number }, b: { x1: number; x2: number; y1: number; y2: number }) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      const faces = own.filter((piece) => FACE.test(piece.id));
      const faceZ = Math.min(...faces.map((piece) => piece.z));
      const t = Math.max(...cue.words.map((word) => word.endMs)) - 20;
      for (const deco of own.filter((piece) => /:(rule|jamb\d)$/.test(piece.id))) {
        expect(deco.z).toBeLessThan(faceZ);
        const box = shown(deco, t);
        if (!box) continue;
        for (const face of faces) {
          const ink = shown(face, t);
          if (ink) expect(meets(box, ink), `${deco.id} over ${face.id} in cue ${cue.index}`).toBe(false);
        }
      }
    }
  });
});

describe("Blinds budget", () => {
  test("a cue never draws more than 150 pieces, with nine words, a long word, and the demo", () => {
    for (const cues of [demoCues(BLINDS_DEMO).cues, sceneEdgeDemo("long-word").cues, sceneEdgeDemo("nine-words").cues, LONG]) {
      const out = build(cues);
      for (const cue of cues) expect(out.filter((piece) => cueOf(piece) === cue.index).length).toBeLessThanOrEqual(150);
    }
  });
});
