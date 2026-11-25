import { describe, expect, test } from "bun:test";
import { describeSpeechConformance, fastRun, staccatoRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
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
const shown = (piece: Piece, t: number) => (evaluatePiece(piece, t).visible ? pieceBounds(piece, t, fakeMeasure) : null);
const faceOf = (pieces: readonly Piece[], cue: number, word: number) => pieces.find((piece) => piece.id === `blinds:${cue}:w${word}`);
const width = (piece: Piece, t: number) => {
  const box = shown(piece, t);
  return box ? box.x2 - box.x1 : 0;
};

describe("Blinds slats", () => {
  test("the five other slats are slices of their own word: painted only while it opens and after the last word has been read", () => {
    for (const fps of [24, 25, 30, 60]) {
      const pieces = build(LONG, fps);
      let seen = 0;
      for (const piece of pieces) {
        const m = SLAT.exec(piece.id);
        if (!m) continue;
        seen++;
        const cue = LONG[Number(m[1])]!;
        const word = cue.words[Number(m[2])]!;
        const spokenEnd = Math.max(...cue.words.map((w) => w.endMs));
        const lastFrame = exportFrameAtOrBefore(word.endMs - 1, fps);
        expect(piece.fromMs).toBeGreaterThanOrEqual(word.startMs - 100);
        expect(piece.toMs).toBeLessThanOrEqual(cue.endMs + 1);
        for (const t of exportFrameTimes(piece.fromMs, piece.toMs, fps)) {
          if (!shown(piece, t)) continue;
          expect(t <= lastFrame || t >= spokenEnd + 150 - 1, `${piece.id} paints at ${t}, word ends ${word.endMs}, line read until ${spokenEnd + 150} (${fps} fps)`).toBe(true);
        }
      }
      expect(seen).toBeGreaterThan(100);
    }
  });

  test("once a word is open only its face is drawn: no slat of it paints over its readable face", () => {
    const pieces = build(LONG);
    for (const cue of LONG) {
      for (const [w, word] of cue.words.entries()) {
        const face = faceOf(pieces, cue.index, w);
        if (!face) continue;
        const slats = pieces.filter((piece) => {
          const m = SLAT.exec(piece.id);
          return m && Number(m[1]) === cue.index && Number(m[2]) === w;
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
              // A slat that has opened hands over to the plain face and is empty from then on.
              if (slat !== face && now === 0 && last > 0) break;
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

  test("a word is whole one frame before its spoken end: no slat is still opening a moment before it", () => {
    let checked = 0;
    for (const fps of [24, 25, 30, 60]) {
      const frame = 1000 / fps;
      for (const run of [fastRun(0), fastRun(60), staccatoRun(0), staccatoRun(60)]) {
        const pieces = build(run, fps);
        for (const cue of run) {
          const own = pieces.filter((piece) => cueOf(piece) === cue.index);
          for (const [w, word] of cue.words.entries()) {
            const face = faceOf(pieces, cue.index, w);
            const t = exportFrameAtOrBefore(word.endMs - 1 - frame, fps);
            if (!face || t < face.fromMs) continue;
            checked++;
            const whole = pieceBounds({ ...face, clip: undefined }, t, fakeMeasure)!;
            const box = shown(face, t);
            expect(box && box.x1 <= whole.x1 + 0.5 && box.x2 >= whole.x2 - 0.5, `${face.id} is not whole at ${t}, ${word.endMs - t} ms before its end (${fps} fps)`).toBe(true);
            for (const slat of own.filter((piece) => SLAT.test(piece.id) && piece.id.startsWith(`${face.id}s`))) expect(shown(slat, t), `${slat.id} still paints at ${t} (${fps} fps)`).toBeNull();
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(400);
  });

  test("the hand over from slats to the plain face is invisible: the face's clip is the whole word the frame the slats end", () => {
    const pieces = build(LONG);
    let checked = 0;
    for (const piece of pieces) {
      const m = SLAT.exec(piece.id);
      if (!m || m[4] !== "5") continue;
      const face = faceOf(pieces, Number(m[1]), Number(m[2]));
      if (!face) continue;
      const frames = exportFrameTimes(piece.fromMs, piece.toMs, 30);
      const first = frames.findIndex((t) => shown(piece, t));
      const handOver = first < 0 ? undefined : (frames.slice(first).find((t) => !shown(piece, t)) ?? piece.toMs);
      if (handOver === undefined) continue;
      const whole = pieceBounds({ ...face, clip: undefined }, handOver, fakeMeasure)!;
      const box = pieceBounds(face, handOver, fakeMeasure)!;
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
      const m = SLAT.exec(piece.id);
      if (!m) continue;
      const cue = run.cues[Number(m[1])]!;
      const word = cue.words[Number(m[2])]!;
      const spokenEnd = Math.max(...cue.words.map((w) => w.endMs));
      for (const t of exportFrameTimes(exportFrameAtOrBefore(word.endMs - 1, 30) + 1, piece.toMs, 30)) {
        if (!shown(piece, t)) continue;
        closing++;
        expect(t).toBeGreaterThanOrEqual(spokenEnd + 150 - 1);
      }
      expect(piece.toMs).toBeLessThanOrEqual(cue.endMs + 1);
    }
    expect(closing).toBeGreaterThan(5);
  });

  test("the closing slats close right to left and the face is the last to go", () => {
    const run = demoCues(BLINDS_DEMO);
    const pieces = build(run.cues);
    const cue = run.cues[4]!;
    const closing = [5, 4, 3, 2, 1].map((i) => pieces.find((piece) => piece.id === `blinds:4:w0s${i}`)).filter((p): p is Piece => p !== undefined);
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
    const cue = run.cues[0]!;
    const spokenEnd = Math.max(...cue.words.map((word) => word.endMs));
    for (const piece of pieces.filter((candidate) => cueOf(candidate) === 0 && SLAT.test(candidate.id))) {
      for (const t of exportFrameTimes(spokenEnd, piece.toMs, 30)) expect(shown(piece, t), `${piece.id} closes at ${t}`).toBeNull();
    }
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

describe("Blinds draws no lines", () => {
  const pieces = build(LONG);

  test("no rule, jamb or other shape exists: every piece is a word face or one of its slats", () => {
    expect(pieces.every((piece) => piece.kind === "text")).toBe(true);
    for (const piece of pieces) expect(/^blinds:\d+:w\d+(?:l\d+)?(?:s\d)?$/.test(piece.id), `${piece.id} is not a face or a slat`).toBe(true);
    expect(pieces.some((piece) => /rule|jamb|lintel|bar/.test(piece.id))).toBe(false);
  });

  test("a settled word paints as a single plain face: one piece, one whole clip, no slat painted, on every frame between landing and closing", () => {
    for (const fps of [24, 30, 60]) {
      const out = build(LONG, fps);
      let rested = 0;
      for (const cue of LONG) {
        const spokenEnd = Math.max(...cue.words.map((word) => word.endMs));
        for (const [w, word] of cue.words.entries()) {
          const own = out.filter((piece) => cueOf(piece) === cue.index && new RegExp(`^blinds:\\d+:w${w}(?:s\\d)?$`).test(piece.id));
          const face = own.find((piece) => piece.id === `blinds:${cue.index}:w${w}`)!;
          // From one frame before the spoken end (the word is whole by then) to the end of the reading hold.
          for (const t of exportFrameTimes(exportFrameAtOrBefore(word.endMs - 1 - 1000 / fps, fps), spokenEnd + 150, fps)) {
            if (t < face.fromMs || t >= face.toMs) continue;
            const painted = own.filter((piece) => evaluatePiece(piece, t).visible && evaluatePiece(piece, t).o > 0 && pieceBounds(piece, t, fakeMeasure));
            expect(painted.map((piece) => piece.id), `word ${w} of cue ${cue.index} at ${t} (${fps} fps)`).toEqual([face.id]);
            const whole = pieceBounds({ ...face, clip: undefined }, t, fakeMeasure)!;
            const box = pieceBounds(face, t, fakeMeasure)!;
            expect(box.x1 <= whole.x1 + 0.5 && box.x2 >= whole.x2 - 0.5).toBe(true);
            rested++;
          }
        }
      }
      expect(rested).toBeGreaterThan(300);
    }
  });

  test("a slat is handed over to the face the moment it is open: later slats outlive earlier ones, and the face covers each finished slat", () => {
    const out = build(LONG);
    let handedOver = 0;
    for (const cue of LONG) {
      for (const [w, word] of cue.words.entries()) {
        const face = faceOf(out, cue.index, w);
        const slats = [1, 2, 3, 4, 5].map((i) => out.find((piece) => piece.id === `blinds:${cue.index}:w${w}s${i}`));
        if (!face || slats.some((slat) => !slat || slat.toMs >= word.endMs)) continue;
        const own = slats as Piece[];
        for (let i = 1; i < own.length; i++) expect(own[i]!.toMs, `${own[i]!.id} ends before ${own[i - 1]!.id}`).toBeGreaterThanOrEqual(own[i - 1]!.toMs);
        if (own[4]!.fromMs - own[0]!.fromMs >= 5) expect(own[0]!.toMs, `${own[0]!.id} is held until the last slat is open`).toBeLessThan(own[4]!.toMs);
        for (const slat of own) {
          const lastPainted = exportFrameTimes(slat.fromMs, slat.toMs, 30).filter((t) => shown(slat, t)).at(-1);
          if (lastPainted === undefined) continue;
          const part = shown(slat, lastPainted)!;
          const after = exportFrameAtOrAfter(slat.toMs, 30);
          const covering = shown(face, after)!;
          expect(covering.x1 <= part.x1 + 3 && covering.x2 >= part.x2 - 3, `${face.id} does not cover ${slat.id} once it is open (${after})`).toBe(true);
          handedOver++;
        }
      }
    }
    expect(handedOver).toBeGreaterThan(300);
  });

  test("a slat is fully transparent while its word rests", () => {
    const run = demoCues(BLINDS_DEMO);
    const out = build(run.cues);
    const cue = run.cues[4]!;
    const spokenEnd = Math.max(...cue.words.map((word) => word.endMs));
    const slats = out.filter((piece) => cueOf(piece) === 4 && SLAT.test(piece.id));
    expect(slats.length).toBe(5);
    for (const slat of slats) {
      for (const t of exportFrameTimes(spokenEnd - 100, spokenEnd + 140, 30)) {
        if (t < slat.fromMs || t >= slat.toMs) continue;
        expect(evaluatePiece(slat, t).o, `${slat.id} at ${t}`).toBe(0);
      }
    }
  });
});

describe("Blinds budget", () => {
  /** A piece costs one, plus one per shadow layer it draws. */
  const cost = (own: readonly Piece[]) => own.reduce((sum, piece) => sum + 1 + (piece.kind === "text" ? (piece.shadows?.length ?? 0) : 0), 0);

  test("a cue never costs more than 150 pieces and shadow layers, with nine words, a long word, a long final hold and the demo", () => {
    const held = demoCues({ lines: ["so:m the:m real:b reason:b most:b people:h@520 never:b get:b there:m"], options: { tail: 720 } }).cues;
    for (const fps of [24, 25, 30, 60]) {
      for (const cues of [demoCues(BLINDS_DEMO).cues, sceneEdgeDemo("long-word").cues, sceneEdgeDemo("nine-words").cues, held, LONG]) {
        const out = build(cues, fps);
        for (const cue of cues) expect(cost(out.filter((piece) => cueOf(piece) === cue.index)), `cue ${cue.index} at ${fps} fps`).toBeLessThanOrEqual(150);
      }
    }
  });
});

describe("Blinds in a shared lane, a long word and a tight frame", () => {
  const wide = { canvas: { width: 1920, height: 1080 }, scale: 2 };
  const sizeOf = (out: readonly Piece[], cue: number, word: number) => {
    const face = out.find((piece) => piece.id === `blinds:${cue}:w${word}`);
    if (!face || face.kind !== "text") throw new Error("no face");
    return face.sizePx;
  };

  test("two overlapping speakers come out at comparable sizes at twice the sample size on 16:9", () => {
    const { cues } = demoCues({ lines: ["so:m the:m real:b reason:b most:b people:h@520 never:b get:b there:m", "wait:m for:m it:h@300"], options: { lead: 357, gap: 0, cueGap: 0 } });
    const run: SceneCue[] = cues.map((cue, i) => ({ ...cue, startMs: 400 + i * 300, endMs: cue.endMs + 400 + i * 300 - cue.startMs, speaker: i % 2, words: cue.words.map((word) => ({ ...word, startMs: word.startMs - cue.startMs + 400 + i * 300, endMs: word.endMs - cue.startMs + 400 + i * 300 })) }));
    const out = build(run, 30, wide);
    // Body words and key words of the two lanes: the ratio between the lanes stays near one.
    const body = [sizeOf(out, 0, 0), sizeOf(out, 1, 0)];
    const hero = [sizeOf(out, 0, 5), sizeOf(out, 1, 2)];
    expect(Math.max(...body) / Math.min(...body)).toBeLessThan(1.35);
    expect(Math.max(...hero) / Math.min(...hero)).toBeLessThan(1.35);
  });

  test("the 45-letter word keeps inside the caption band on 9:16 and 16:9 and breaks only between whole letters", () => {
    for (const [canvas, scale] of [[{ width: 1080, height: 1920 }, 1], [{ width: 1920, height: 1080 }, 2], [{ width: 1920, height: 1080 }, 1]] as const) {
      const cues = sceneEdgeDemo("long-word").cues;
      const out = build(cues, 30, { canvas, scale });
      const faces = out.filter((piece) => cueOf(piece) === 1 && FACE.test(piece.id));
      expect(faces.length).toBeGreaterThanOrEqual(2);
      const t = Math.max(...cues[1]!.words.map((word) => word.endMs)) - 20;
      const boxes = faces.flatMap((face) => shown(face, t) ?? []);
      const top = Math.min(...boxes.map((box) => box.y1));
      const bottom = Math.max(...boxes.map((box) => box.y2));
      // The band is the sample's 860..1650 of 1920 around the anchor line, at the natural size, inside the safe area.
      const natural = Math.min(canvas.width, canvas.height) / 1080;
      const anchorY = (1290 / 1920) * canvas.height;
      expect(top).toBeGreaterThanOrEqual(Math.max(0.05 * canvas.height, anchorY - 430 * natural) - 3);
      expect(bottom).toBeLessThanOrEqual(Math.min(0.95 * canvas.height, anchorY + 360 * natural) + 3);
    }
  });

  test("a combining mark stays with its letter when a word is broken", () => {
    const word = "pneumonoul\u0301tramicroscopicsilicovolcanoconiosisxyz";
    const cues = demoCues({ lines: [`${word}:b@1400`] }).cues;
    const faces = build(cues).filter((piece) => FACE.test(piece.id));
    expect(faces.length).toBeGreaterThanOrEqual(2);
    for (const face of faces) if (face.kind === "text") expect(face.text.startsWith("\u0301")).toBe(false);
    const text = faces.map((face) => (face.kind === "text" ? face.text : "")).join("");
    expect(text).toBe(word.toLocaleUpperCase());
  });
});
