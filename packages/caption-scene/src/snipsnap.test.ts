import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Box, type Measure, type Piece, evaluatePiece, pieceBounds } from "./scene";
import { SNIPSNAP_DEMO, snipsnapProgram } from "./templates/snipsnap";
import { sceneInput } from "./test-support";

describeSpeechConformance("snipsnap", snipsnapProgram, { anchorLineY: 1285 });

/** Londrina Solid Black is narrow: about 0.42 em a capital, ink 0.72 em up and 0.01 down. */
const fakeMeasure: Measure = (text, _face, sizePx, letterSpacingEm) => ({
  advance: [...text].length * (0.42 + letterSpacingEm) * sizePx - letterSpacingEm * sizePx,
  inkTop: -0.72 * sizePx,
  inkBottom: 0.02 * sizePx,
  ascent: 0.94 * sizePx,
  descent: 0.22 * sizePx,
});

/** Real phrasing: the key word first, mid-cue and last, two key words in a row, a long key word, no key word. */
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
/** Three runs of the lines make 24 cues, so the cycling counters go past any demo. */
const LONG = demoCues({ lines: [...LINES, ...LINES, ...LINES], options: { lead: 400, gap: 30, cueGap: 120, tail: 500 } }).cues;
const build = (cues: readonly SceneCue[], fps = 30) => snipsnapProgram.build(sceneInput(cues, { fps, measure: fakeMeasure, anchor: { xPct: 50, yPct: (1285 / 1920) * 100 } })).pieces;
const pieces = build(LONG);
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const FACE = /^snipsnap:\d+:w\d+$/;
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
const shown = (piece: Piece, t: number) => (evaluatePiece(piece, t).visible ? pieceBounds(piece, t, fakeMeasure) : null);
const settledAt = (cue: SceneCue) => Math.max(...cue.words.map((word) => word.endMs)) - 20;

describe("Snip Snap on real phrasing", () => {
  test("a doodle never sits on a spoken word, on any frame of the cue", () => {
    let doodles = 0;
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      const faces = own.filter((piece) => FACE.test(piece.id));
      for (const t of exportFrameTimes(cue.startMs, cue.endMs, 30)) {
        const ink = faces.flatMap((piece) => shown(piece, t) ?? []);
        for (const doodle of own.filter((piece) => /:doodle\d/.test(piece.id))) {
          const box = shown(doodle, t);
          if (!box) continue;
          doodles++;
          for (const word of ink) expect(meets(box, word), `${doodle.id} over a word at ${t}`).toBe(false);
        }
      }
    }
    expect(doodles).toBeGreaterThan(200);
  });

  test("tape and scraps sit under the type and clear of it", () => {
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      const faceZ = Math.min(...own.filter((piece) => FACE.test(piece.id)).map((piece) => piece.z));
      for (const piece of own.filter((candidate) => /:(tape|scrap\d)$/.test(candidate.id))) expect(piece.z).toBeLessThan(faceZ);
      const t = settledAt(cue);
      for (const extra of own.filter((candidate) => /:(tape|scrap\d)$/.test(candidate.id))) {
        const box = shown(extra, t);
        if (!box) continue;
        for (const face of own.filter((candidate) => FACE.test(candidate.id))) {
          const ink = shown(face, t);
          if (ink) expect(meets(box, ink), `${extra.id} over ${face.id} in cue ${cue.index}`).toBe(false);
        }
      }
    }
  });

  test("every cue of a 24-cue clip gets a doodle, tape and scraps, and the doodle kind cycles through all six", () => {
    const kinds = new Set<string>();
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      expect(own.some((piece) => /:doodle0-0$/.test(piece.id)), `cue ${cue.index} has no doodle`).toBe(true);
      expect(own.some((piece) => piece.id.endsWith(":tape")), `cue ${cue.index} has no tape`).toBe(true);
      expect(own.filter((piece) => /:scrap\d$/.test(piece.id)).length, `cue ${cue.index} scraps`).toBeGreaterThanOrEqual(2);
      const parts = own.filter((piece) => /:doodle\d-\d$/.test(piece.id));
      kinds.add(`${parts.length}:${parts[0]?.kind === "shape" ? JSON.stringify(parts[0].path.slice(0, 3)).length : 0}`);
    }
    expect(kinds.size).toBeGreaterThanOrEqual(3);
    const heroCue = LONG.findIndex((cue) => cue.words.some((word) => word.role === "hero"));
    expect(pieces.some((piece) => cueOf(piece) === LONG[heroCue]!.index && /:doodle1-0$/.test(piece.id))).toBe(true);
  });

  test("a doodle's tilt does not grow with the cue number (the sample added 4 degrees a cue)", () => {
    const tilt = (index: number) => {
      const doodle = pieces.find((piece) => cueOf(piece) === index && /:doodle0-0$/.test(piece.id))!;
      return Math.abs(evaluatePiece(doodle, settledAt(LONG[index]!)).rz);
    };
    for (const index of [0, 12, 23]) expect(tilt(index)).toBeLessThan(40);
  });

  test("a key word keeps a legible size and a row of its own; words wrap into even rows", () => {
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index && FACE.test(piece.id));
      for (const face of own) {
        if (face.kind !== "text") throw new Error("face is text");
        expect(face.sizePx).toBeGreaterThanOrEqual(68);
      }
      cue.words.forEach((word, at) => {
        if (word.role !== "hero") return;
        const mine = own.find((piece) => piece.id.endsWith(`:w${at}`))!;
        const y = evaluatePiece(mine, settledAt(cue)).y;
        for (const other of own.filter((piece) => piece !== mine)) expect(Math.abs(evaluatePiece(other, settledAt(cue)).y - y)).toBeGreaterThan(60);
      });
    }
  });

  test("every word sits inside a label of its own row, and no two words of a cue meet", () => {
    for (const cue of LONG) {
      const own = pieces.filter((piece) => cueOf(piece) === cue.index);
      const t = settledAt(cue);
      const faces = own.filter((piece) => FACE.test(piece.id));
      const plates = own.filter((piece) => /:p\d+s\d+$/.test(piece.id));
      for (const face of faces) {
        const ink = shown(face, t)!;
        const cx = (ink.x1 + ink.x2) / 2;
        const cy = (ink.y1 + ink.y2) / 2;
        expect(plates.some((plate) => {
          const box = shown(plate, t);
          return box !== null && box.x1 <= cx && box.x2 >= cx && box.y1 <= cy && box.y2 >= cy;
        }), `${face.id} has no label under it`).toBe(true);
      }
      for (const [i, a] of faces.entries()) {
        for (const b of faces.slice(i + 1)) {
          const x = shown(a, t)!;
          const y = shown(b, t)!;
          expect(meets({ x1: x.x1 + 4, x2: x.x2 - 4, y1: x.y1 + 14, y2: x.y2 - 14 }, { x1: y.x1 + 4, x2: y.x2 - 4, y1: y.y1 + 14, y2: y.y2 - 14 }), `${a.id} meets ${b.id}`).toBe(false);
        }
      }
    }
  });

  test("the label grows by whole words as they are said, never narrower than the words shown", () => {
    const cue = LONG[1]!;
    const own = pieces.filter((piece) => cueOf(piece) === cue.index);
    const label = own.filter((piece) => /:p0s\d+$/.test(piece.id));
    expect(label.length).toBeGreaterThanOrEqual(2);
    const widths = label.sort((a, b) => a.fromMs - b.fromMs).map((piece) => {
      const box = pieceBounds(piece, exportFrameTimes(piece.fromMs, piece.toMs, 30).at(-1)! - 1, fakeMeasure) ?? pieceBounds(piece, piece.fromMs + 40, fakeMeasure)!;
      return box.x2 - box.x1;
    });
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThan(widths[i - 1]! - 1);
  });

  test("a right-to-left cue runs right to left and mirrors the stagger", () => {
    const urdu = sceneEdgeDemo("urdu").cues;
    const out = build(urdu);
    const first = urdu[0]!;
    const t = settledAt(first);
    const xs = first.words.map((_, at) => evaluatePiece(out.find((piece) => piece.id === `snipsnap:0:w${at}`)!, t).x);
    const row = [...xs].slice(0, 2);
    expect(row[0]! > row[1]!).toBe(true);
  });

  test("the demo builds inside the piece budget with a long word and nine words", () => {
    for (const cues of [demoCues(SNIPSNAP_DEMO).cues, sceneEdgeDemo("long-word").cues, sceneEdgeDemo("nine-words").cues]) {
      const out = build(cues);
      for (const cue of cues) expect(out.filter((piece) => cueOf(piece) === cue.index).length).toBeLessThanOrEqual(150);
    }
  });
});
