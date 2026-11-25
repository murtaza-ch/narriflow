import { describe, expect, test } from "bun:test";
import { captionFontFilePath, shapeCaptionRun } from "@narriflow/caption-fonts";
import { captionColourContrast, captionFontFace } from "@narriflow/validators";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
import { type Box, type Measure, type Piece, type TextPiece, evaluatePiece, pieceBounds } from "./scene";
import { funkyProgram } from "./templates/funky";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("funky", funkyProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFFFFF", highlight: "#FFE11A", accent: "#FF3DA8", shadow: "#000000" };
const FILLS = ["#FFE11A", "#FF3DA8", "#B05CFF", "#19D68A", "#33D3FF", "#FFFFFF", "#FF8A1F"];
const build = (lines: string[], opts: { gap?: number; cueGap?: number; language?: string; fps?: number; canvas?: { width: number; height: number }; scale?: number; colours?: typeof colours } = {}) => {
  const { cues } = demoCues({ lines, language: opts.language, options: { lead: 400, gap: opts.gap ?? 30, cueGap: opts.cueGap ?? 140, tail: 900 } });
  return { cues, pieces: funkyProgram.build(sceneInput(cues, { fps: opts.fps ?? 30, colours: opts.colours ?? colours, ...(opts.canvas ? { canvas: opts.canvas } : {}), ...(opts.scale ? { scale: opts.scale } : {}) })).pieces };
};
const wordRe = (cue: number) => new RegExp(`^funky:${cue}:w\\d+(?:l\\d+)?$`);
const faces = (pieces: Piece[], cue: number) => pieces.filter((piece): piece is TextPiece => piece.kind === "text" && wordRe(cue).test(piece.id));
const meets = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
/** The real glyph measurements (HarfBuzz on the bundled font files), as the export measures them. */
const capMeasure: Measure = (text, face, sizePx, spacing) => {
  const info = captionFontFace(face);
  const run = shapeCaptionRun(captionFontFilePath(info.file), text);
  return {
    advance: (run.advanceEm + spacing * ([...text].length - 1)) * sizePx,
    inkTop: -run.inkTopEm * sizePx,
    inkBottom: run.inkBottomEm * sizePx,
    ascent: info.ascent * sizePx,
    descent: info.descent * sizePx,
  };
};
/** The letters grouped into the rows they stand in at `t`: a new row starts where the next letter sits more than half a cap lower. */
const rowsOfLetters = (letters: TextPiece[], t: number): TextPiece[][] => {
  const sorted = letters.map((piece) => ({ piece, y: evaluatePiece(piece, t).y })).sort((a, b) => a.y - b.y);
  const rows: TextPiece[][] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const { piece, y } of sorted) {
    if (y - last > 0.5 * piece.sizePx * captionFontFace(piece.face).capHeight) rows.push([]);
    rows[rows.length - 1]!.push(piece);
    last = y;
  }
  return rows;
};
/** Cue texts as real speech reads them: key words of every width, short and long, the ones the review frames showed. */
const SPEECH = [
  "of:m them:m are:m unplugged.:h@900", "anyone:m to:m accidentally:h@1000", "episodes:h@800", "wouldn't:h@500 have:m done:b", "any:m other:m audience:h@700",
  "a:m little:b graduation.:h@800", "out:m for:m waveform:h@700", "and:m the:m new:b episodes,:h@800", "to:m the:m waveform:b studio.:h@600",
  "so:b the:m real:b reason:h@700 most:b people:b never:b get:b there:b", "missing:b features:h@700", "whole:b gorgeous:h@800 display:b",
];
const LINES = ["this:m is:m so:b funky:h@720", "keep:b it:m simple:b", "good:b vibes:h@660", "do:m what:b you:m love:h@680", "easy:b come:b go:h@600"];

describe("funky", () => {
  test("a letter never repeats either of the two letters before it, across words too, and a word shows at least four faces", () => {
    const { cues, pieces } = build(LINES);
    for (const cue of cues) {
      const letters = faces(pieces, cue.index).sort((a, b) => Number(a.id.split(":w")[1]!.replace("l", ".")) - Number(b.id.split(":w")[1]!.replace("l", ".")));
      letters.forEach((letter, i) => {
        if (i >= 1) expect(letter.face, `${letter.id} repeats the face before it`).not.toBe(letters[i - 1]!.face);
        if (i >= 2) expect(letter.face, `${letter.id} repeats the face two before it`).not.toBe(letters[i - 2]!.face);
      });
    }
    const hero = faces(pieces, 0).filter((piece) => piece.id.startsWith("funky:0:w3"));
    expect(new Set(hero.map((piece) => piece.face)).size).toBeGreaterThanOrEqual(4);
    // Only the six bundled stand-ins ever appear.
    expect([...new Set(faces(pieces, 1).concat(faces(pieces, 2)).map((piece) => piece.face))].every((face) => ["Chango", "Luckiest Guy", "Titan One", "Dela Gothic One", "Alfa Slab One", "Caprasimo"].includes(face))).toBe(true);
  });

  test("every letter of a word stands on one cap height: its size times its face's cap height is the same", () => {
    const { pieces } = build(["so:b funky:h@720"]);
    for (const prefix of ["funky:0:w0", "funky:0:w1"]) {
      const letters = faces(pieces, 0).filter((piece) => piece.id.startsWith(prefix));
      const caps = letters.map((piece) => piece.sizePx * captionFontFace(piece.face).capHeight);
      expect(letters.length).toBeGreaterThan(1);
      for (const cap of caps) expect(cap).toBeCloseTo(caps[0]!, 3);
    }
  });

  test("every letter is painted on the word's first spoken frame, opaque and whole, hero included", () => {
    for (const fps of [24, 30, 60]) {
      const { cues, pieces } = build(LINES, { fps });
      for (const cue of cues) {
        for (const [w, word] of cue.words.entries()) {
          const onset = exportFrameAtOrAfter(word.startMs, fps);
          const letters = faces(pieces, cue.index).filter((piece) => new RegExp(`^funky:${cue.index}:w${w}(?:l\\d+)?$`).test(piece.id));
          expect(letters.length).toBeGreaterThan(0);
          for (const letter of letters) {
            expect(letter.fromMs, `${letter.id} starts early`).toBeGreaterThanOrEqual(word.startMs - 1);
            expect(pieceBounds(letter, onset, fakeMeasure), `${letter.id} at ${fps} fps`).not.toBeNull();
            expect(evaluatePiece(letter, onset).o).toBeGreaterThanOrEqual(0.99);
          }
        }
      }
    }
  });

  test("the key word's tumble stays inside 24 degrees and 0.2 cap, the stagger inside 45 ms and the settle inside 145 ms", () => {
    const { cues, pieces } = build(["so:b funky:h@720"], { fps: 60 });
    const word = cues[0]!.words[1]!;
    const letters = faces(pieces, 0).filter((piece) => piece.id.startsWith("funky:0:w1l"));
    expect(letters.length).toBe(5);
    const onset = exportFrameAtOrAfter(word.startMs, 60);
    for (const letter of letters) {
      const rest = evaluatePiece(letter, word.startMs + 900);
      const sizeCap = letter.sizePx * captionFontFace(letter.face).capHeight;
      for (const t of exportFrameTimes(onset, word.startMs + 190, 60)) {
        const pose = evaluatePiece(letter, t);
        expect(Math.abs(pose.rz - rest.rz)).toBeLessThanOrEqual(24.01);
        expect(Math.abs(pose.x - rest.x)).toBeLessThanOrEqual(0.25 * sizeCap);
        expect(Math.abs(pose.y - rest.y)).toBeLessThanOrEqual(0.2 * sizeCap);
      }
      // Whole again within 190 ms of the onset: 45 ms of stagger and a 145 ms settle.
      const done = evaluatePiece(letter, word.startMs + 192);
      expect(Math.abs(done.x - rest.x)).toBeLessThan(0.5);
      expect(Math.abs(done.rz - rest.rz)).toBeLessThan(0.1);
      expect(Math.abs(done.sx - 1)).toBeLessThan(0.01);
    }
  });

  test("a key word of more than eight letters and an ordinary word pop as one: the letters share one scale and one turn", () => {
    const { cues, pieces } = build(["a:m wonderful:h@900 day:b"]);
    const word = cues[0]!.words[1]!;
    const letters = faces(pieces, 0).filter((piece) => piece.id.startsWith("funky:0:w1l"));
    expect(letters.length).toBe(9);
    const rest = letters.map((piece) => evaluatePiece(piece, word.startMs + 900));
    for (const t of exportFrameTimes(word.startMs, word.startMs + 160, 30)) {
      const poses = letters.map((piece) => evaluatePiece(piece, t));
      const turns = poses.map((pose, i) => pose.rz - rest[i]!.rz);
      for (const turn of turns) expect(turn).toBeCloseTo(turns[0]!, 1);
      for (const pose of poses) expect(pose.sx).toBeCloseTo(poses[0]!.sx, 3);
    }
  });

  test("a short word settles by its last painted frame: no overshoot and settle share a frame", () => {
    for (const fps of [24, 30, 60]) {
      const { cues, pieces } = build(["go:h@90 now:b@90"], { fps, cueGap: 0, gap: 0 });
      for (const word of cues[0]!.words) {
        const w = cues[0]!.words.indexOf(word);
        const last = exportFrameAtOrBefore(word.endMs - 1, fps);
        for (const letter of faces(pieces, 0).filter((piece) => new RegExp(`^funky:0:w${w}(?:l\\d+)?$`).test(piece.id))) {
          const rest = evaluatePiece(letter, word.startMs + 800);
          const at = evaluatePiece(letter, last);
          expect(Math.abs(at.sx - rest.sx), `${letter.id} at ${fps} fps`).toBeLessThan(0.02);
          const frames = exportFrameTimes(word.startMs, last + 1, fps).map((t) => evaluatePiece(letter, t).sx);
          // Monotone toward rest: never past it and back.
          for (let i = 1; i < frames.length; i++) expect(frames[i]!).toBeGreaterThanOrEqual(frames[i - 1]! - 1e-6);
        }
      }
    }
  });

  test("confetti sits in free space clear of every word's measured box (the claim keeps 16 px from the painted ink), behind the faces, four to six per cue", () => {
    const cues = demoCues({ lines: LINES, options: { lead: 400, gap: 30, cueGap: 140, tail: 900 } }).cues;
    const pieces = funkyProgram.build(sceneInput(cues, { fps: 30, colours, measure: capMeasure })).pieces;
    for (const cue of cues) {
      const confetti = pieces.filter((piece) => piece.id.startsWith(`funky:${cue.index}:conf`));
      const heroed = cue.words.some((word) => word.role === "hero");
      expect(confetti.length, `confetti on cue ${cue.index}`).toBeGreaterThanOrEqual(3);
      expect(confetti.length).toBeLessThanOrEqual(heroed ? 6 : 4);
      const words = faces(pieces, cue.index);
      for (const piece of confetti) {
        expect(piece.z).toBeLessThan(words[0]!.z);
        for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
          // A spinning star stays inside the circle of its own radius: measure it unturned.
          const box = pieceBounds({ ...piece, track: { ...piece.track, rz: [[0, 0]] } }, t, capMeasure);
          if (!box) continue;
          for (const word of words) {
            const ink = pieceBounds(word, t, capMeasure);
            if (ink) expect(meets(box, ink), `${piece.id} touches ${word.id} at ${t}`).toBe(false);
          }
        }
      }
    }
  });

  test("nothing of a cue is left under the next cue's words: every piece of an earlier cue stays clear of later faces", () => {
    for (const cueGap of [0, 60, 150]) {
      const { cues, pieces } = build(LINES, { cueGap, gap: 0 });
      const end = Math.max(...pieces.map((piece) => piece.toMs));
      for (const t of exportFrameTimes(cues[0]!.startMs, end, 30)) {
        for (const cue of cues) {
          const later = faces(pieces, cue.index).flatMap((piece) => pieceBounds(piece, t, fakeMeasure) ?? []);
          for (const piece of pieces.filter((p) => Number(p.id.split(":")[1]) < cue.index)) {
            const box = pieceBounds(piece, t, fakeMeasure);
            if (box) for (const ink of later) expect(meets(box, ink), `${piece.id} is under cue ${cue.index} at ${t} (gap ${cueGap})`).toBe(false);
          }
        }
      }
    }
  });

  test("the confetti ends at its last twinkle: nothing restarts during the exit", () => {
    const { cues, pieces } = build(["hold:h@4200"]);
    const cue = cues[0]!;
    for (const piece of pieces.filter((p) => p.id.startsWith("funky:0:conf"))) {
      const sx = piece.track.sx!;
      const lastKey = sx[sx.length - 1]!;
      expect(lastKey[1]).toBe(1);
      expect(lastKey[0]).toBeLessThan(cue.endMs - 150);
      const frames = exportFrameTimes(cue.endMs - 200, piece.toMs, 30).map((t) => evaluatePiece(piece, t).sx);
      for (const value of frames) expect(value).toBeCloseTo(1, 3);
    }
  });

  test("a hop runs across the key word's letters on a long hold, and on the last word of a cue without a key word; it is done before the exit", () => {
    const { cues, pieces } = build(["so:b funky:h@3000", "just:b plain:b words:b"]);
    for (const [cue, id] of [[0, "funky:0:w1l"], [1, "funky:1:w2l"]] as const) {
      const letters = faces(pieces, cue).filter((piece) => piece.id.startsWith(id));
      expect(letters.length).toBeGreaterThan(1);
      const rest = letters.map((piece) => evaluatePiece(piece, cues[cue]!.startMs + 300).y);
      const times = exportFrameTimes(cues[cue]!.startMs + 300, cues[cue]!.endMs, 30);
      const lifted = times.filter((t) => letters.some((piece, i) => evaluatePiece(piece, t).y < rest[i]! - 2));
      expect(lifted.length, `hop on cue ${cue}`).toBeGreaterThan(2);
      // At rest again for the last 160 ms of the cue.
      for (const t of exportFrameTimes(cues[cue]!.endMs - 160, cues[cue]!.endMs - 30, 30)) {
        for (const [i, piece] of letters.entries()) expect(Math.abs(evaluatePiece(piece, t).y - rest[i]!)).toBeLessThan(0.25 * piece.sizePx);
      }
    }
  });

  test("a long word breaks across rows at a readable size, balanced, and never repeats a face between rows", () => {
    const { cues, pieces } = build(["pneumonoultramicroscopicsilicovolcanoconiosis:h@1200"]);
    const letters = faces(pieces, 0);
    expect(letters.map((piece) => piece.text).join("")).toBe("PNEUMONOULTRAMICROSCOPICSILICOVOLCANOCONIOSIS");
    const t = cues[0]!.endMs - 400;
    const counts = rowsOfLetters(letters, t).map((row) => row.length);
    expect(counts.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(6);
    for (const letter of letters) expect(letter.sizePx * captionFontFace(letter.face).capHeight).toBeGreaterThanOrEqual(0.6 * 142 * 0.74);
  });

  test("a long word takes the fewest rows whose real breakpoints keep the size floor, at 16:9 too, with the real glyph widths", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      for (const word of ["contemporaneousness", "abdominohysterectomy", "unbelievable"]) {
        const cues = demoCues({ lines: [`${word}:h@1200`], options: { lead: 400, gap: 30, cueGap: 140, tail: 900 } }).cues;
        const pieces = funkyProgram.build(sceneInput(cues, { fps: 30, colours, canvas, measure: capMeasure })).pieces;
        const letters = faces(pieces, 0);
        const t = cues[0]!.endMs - 400;
        const rowsAt = rowsOfLetters(letters, t);
        const counts = rowsAt.map((row) => row.length);
        // 12 to 20 letters never need more than three rows at a readable size, and two rows beat three when they fit.
        expect(counts.length, `${word} at ${canvas.width}x${canvas.height}`).toBeLessThanOrEqual(3);
        expect(Math.min(...counts), `${word} leaves a one-letter row`).toBeGreaterThanOrEqual(3);
        for (const row of rowsAt) {
          const box = row.map((letter) => pieceBounds(letter, t, capMeasure)!);
          expect(Math.max(...box.map((b) => b.x2)) - Math.min(...box.map((b) => b.x1)), `${word} row wider than the column`).toBeLessThanOrEqual(canvas.width * 0.9);
        }
      }
    }
  });

  test("a common key word that is wide at its own size shrinks to fit and stays one row; only a word below 62 % of body size breaks", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      for (const word of ["episodes", "unbelievable", "wouldn't", "features", "audience", "unplugged.", "accidentally", "waveform"]) {
        const cues = demoCues({ lines: [`so:b ${word}:h@1100`], options: { lead: 400, gap: 30, cueGap: 140, tail: 900 } }).cues;
        const pieces = funkyProgram.build(sceneInput(cues, { fps: 30, colours, canvas, measure: capMeasure })).pieces;
        const key = faces(pieces, 0).filter((piece) => piece.id.startsWith("funky:0:w1"));
        const t = cues[0]!.endMs - 400;
        expect(rowsOfLetters(key, t).length, `${word} at ${canvas.width}x${canvas.height}`).toBe(1);
        // Shrunk at most to 62 % of the body size.
        for (const letter of key) expect(letter.sizePx * captionFontFace(letter.face).capHeight).toBeGreaterThanOrEqual(0.62 * 142 * 0.74 - 0.5);
      }
    }
  });

  test("16:9 packs a cue into the fewest rows that keep the size: two rows for the short cues, four for nine words, nothing below 60 % of its size", () => {
    const wide = { width: 1920, height: 1080 };
    for (const scale of [1, 2]) {
      const canvas = wide;
      for (const [line, most] of [["easy:b come:b go:h@600", 2], ["do:m what:b you:m love:h@680", 2], ["so:b the:m real:b reason:h@700 most:b people:b never:b get:b there:b", 4]] as const) {
        const cues = demoCues({ lines: [line], options: { lead: 400, gap: 30, cueGap: 140, tail: 900 } }).cues;
        const pieces = funkyProgram.build(sceneInput(cues, { fps: 30, colours, canvas, scale, measure: capMeasure })).pieces;
        const letters = faces(pieces, 0);
        const rows = rowsOfLetters(letters, cues[0]!.endMs - 300);
        expect(rows.length, `${line} at ${canvas.width}x${canvas.height}`).toBeLessThanOrEqual(most);
        for (const letter of letters) expect(letter.sizePx * captionFontFace(letter.face).capHeight).toBeGreaterThanOrEqual(0.6 * 0.8 * 142 * 0.74 - 0.5);
      }
    }
  });

  test("the hop shows on ordinary fast speech: after its word settles, on three painted frames at least, on most short cues", () => {
    const lines = [
      "it's:m time:h@240", "to:m say:b goodbye:h@260", "does:b the:m remote:b even:b still:h@230", "work:h@200", "the:m remote:b doesn't:h@220 work:b@160",
      "is:m it:b dead:h@240", "the:m battery:h@260", "it's:m been:b that:b long:h@200", "just:b tear:b it:m down:h@240", "who:b cares:h@200",
      "that's:b fine:h@220", "the:m next:b tenant:h@240", "we:m will:b catch:b you:m guys:h@180", "you:m see:b these:h@180", "break:h@140",
    ];
    for (const fps of [30, 60]) {
      const { cues, pieces } = build(lines, { fps, cueGap: 40, gap: 20 });
      let lifted = 0;
      for (const cue of cues) {
        const letters = faces(pieces, cue.index);
        const shown = letters.some((piece) => {
          const o = piece.track.o;
          const end = o && o.length > 2 ? o[1]![0] : piece.toMs;
          const ys = exportFrameTimes(piece.fromMs + 190, end, fps).map((t) => evaluatePiece(piece, t).y);
          return ys.some((y, i) => i > 0 && Math.abs(y - ys[i - 1]!) > 2);
        });
        if (shown) lifted++;
      }
      expect(lifted, `${lifted} of ${cues.length} cues hop at ${fps} fps`).toBeGreaterThanOrEqual(Math.ceil(cues.length * 0.7));
    }
  });

  test("rows keep clear of each other: no row's painted box (face, outline and offset shadow) meets the next row's on any painted frame, 9:16 and 16:9", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      for (const scale of [1, 2]) {
        const cues = demoCues({ lines: SPEECH, options: { lead: 400, gap: 30, cueGap: 140, tail: 900 } }).cues;
        const pieces = funkyProgram.build(sceneInput(cues, { fps: 30, colours, canvas, scale, measure: capMeasure })).pieces;
        for (const cue of cues) {
          const letters = faces(pieces, cue.index);
          const rest = cue.endMs - 300;
          const rows = rowsOfLetters(letters, rest);
          if (rows.length < 2) continue;
          const settled = Math.max(...letters.map((letter) => letter.fromMs)) + 200;
          for (const t of exportFrameTimes(settled, letters[0]!.toMs, 30)) {
            const boxes = rows.map((row) => {
              const painted = row.flatMap((letter) => {
                const box = pieceBounds(letter, t, capMeasure);
                if (!box) return [];
                const reachX = Math.max(...(letter.shadows ?? []).map((shadow) => shadow.dx));
                const reachY = Math.max(...(letter.shadows ?? []).map((shadow) => shadow.dy));
                return [{ x1: box.x1, y1: box.y1, x2: box.x2 + reachX, y2: box.y2 + reachY }];
              });
              if (painted.length === 0) return null;
              return { x1: Math.min(...painted.map((b) => b.x1)), y1: Math.min(...painted.map((b) => b.y1)), x2: Math.max(...painted.map((b) => b.x2)), y2: Math.max(...painted.map((b) => b.y2)) };
            });
            for (let i = 1; i < boxes.length; i++) {
              if (boxes[i - 1] && boxes[i]) expect(meets(boxes[i - 1]!, boxes[i]!), `cue ${cue.index} rows ${i - 1} and ${i} meet at ${t} (${canvas.width}x${canvas.height}, ${scale}x)`).toBe(false);
            }
          }
        }
      }
    }
  });

  test("no letter's face or outline covers a neighbour's face: each face (ink box, turned as drawn) stays clear of the next letter's outline, at 9:16 and 16:9, key words and all", () => {
    const corners = (piece: TextPiece, t: number, grow = 0): [number, number][] => {
      const info = captionFontFace(piece.face);
      const run = shapeCaptionRun(captionFontFilePath(info.file), piece.text);
      const cluster = run.clusters[0]!;
      const pose = evaluatePiece(piece, t);
      const size = piece.sizePx * pose.sx;
      const cap = info.capHeight * size;
      const left = (cluster.inkLeftEm ?? 0) * size - (run.advanceEm * size) / 2 - grow;
      const right = (cluster.inkRightEm ?? 0) * size - (run.advanceEm * size) / 2 + grow;
      const angle = (pose.rz * Math.PI) / 180;
      return ([[left, -cap / 2 - grow], [right, -cap / 2 - grow], [right, cap / 2 + grow], [left, cap / 2 + grow]] as const).map(([x, y]) => [pose.x + x * Math.cos(angle) - y * Math.sin(angle), pose.y + x * Math.sin(angle) + y * Math.cos(angle)] as [number, number]);
    };
    const apart = (a: [number, number][], b: [number, number][]) => {
      for (const shape of [a, b]) {
        for (let i = 0; i < 4; i++) {
          const [x1, y1] = shape[i]!;
          const [x2, y2] = shape[(i + 1) % 4]!;
          const axis = [y1 - y2, x2 - x1] as const;
          const project = (points: [number, number][]) => points.map(([x, y]) => x * axis[0] + y * axis[1]);
          const pa = project(a);
          const pb = project(b);
          if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return true;
        }
      }
      return false;
    };
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      const cues = demoCues({ lines: SPEECH, options: { lead: 400, gap: 30, cueGap: 140, tail: 900 } }).cues;
      const pieces = funkyProgram.build(sceneInput(cues, { fps: 30, colours, canvas, measure: capMeasure })).pieces;
      let pairs = 0;
      for (const cue of cues) {
        const rest = cue.endMs - 300;
        const letters = faces(pieces, cue.index).filter((piece) => /l\d+$/.test(piece.id));
        const byWord = new Map<string, TextPiece[]>();
        for (const letter of letters) byWord.set(letter.id.replace(/l\d+$/, ""), [...(byWord.get(letter.id.replace(/l\d+$/, "")) ?? []), letter]);
        for (const word of byWord.values()) {
          word.sort((a, b) => Number(a.id.split("l")[1]) - Number(b.id.split("l")[1]));
          for (let i = 1; i < word.length; i++) {
            // Letters of one row only: a broken word's rows are apart already.
            const [a, b] = [word[i - 1]!, word[i]!];
            if (Math.abs(evaluatePiece(a, rest).y - evaluatePiece(b, rest).y) > 0.5 * a.sizePx * captionFontFace(a.face).capHeight) continue;
            pairs++;
            // Each face stays clear of the other's outline, so neither stroke paints over a face.
            const outline = (piece: TextPiece) => piece.stroke!.widthPx * evaluatePiece(piece, rest).sx;
            expect(apart(corners(a, rest), corners(b, rest, outline(b))), `${b.id}'s outline reaches ${a.id}'s face (${canvas.width}x${canvas.height})`).toBe(true);
            expect(apart(corners(a, rest, outline(a)), corners(b, rest)), `${a.id}'s outline reaches ${b.id}'s face (${canvas.width}x${canvas.height})`).toBe(true);
          }
        }
      }
      expect(pairs).toBeGreaterThan(100);
    }
  });

  test("colours the Studio sends straight, with no Brand Kit mapping, fall back below 3:1 against the outline or when they match their own shadow", () => {
    const fillsOf = (primary: string, highlight: string, accent: string) => {
      const { pieces } = build(LINES, { colours: { primary, highlight, accent, shadow: "#000000" } });
      return new Set(pieces.filter((piece): piece is TextPiece => piece.kind === "text").map((piece) => piece.fill));
    };
    // Near-black on every slot: none of them may reach the screen.
    for (const fill of fillsOf("#000000", "#050505", "#10101A")) expect(FILLS).toContain(fill);
    // The white slot's own shadow is pink: a pink primary would vanish into it.
    const pink = fillsOf("#FF3DA8", "#FFE11A", "#FF3DA8");
    expect(pink.has("#FFFFFF")).toBe(true);
    // A good colour is kept.
    expect(fillsOf("#C8F7FF", "#FFE11A", "#FF3DA8").has("#C8F7FF")).toBe(true);
  });

  test("Devanagari and Urdu words are one whole piece each, in one colour, with the same outline and shadow", () => {
    const hindi = build(["यह:b बहुत:h@700"], { language: "hi" });
    const parts = hindi.pieces.filter((piece): piece is TextPiece => piece.kind === "text" && /^funky:0:w\d+(?:l\d+)?$/.test(piece.id));
    expect(parts.map((piece) => piece.id)).toEqual(["funky:0:w0", "funky:0:w1"]);
    expect(parts.map((piece) => piece.text)).toEqual(["यह", "बहुत"]);
    for (const piece of parts) {
      expect(FILLS).toContain(piece.fill);
      expect(piece.stroke?.colour).toBe("#1B0F3B");
      expect(piece.shadows?.length).toBe(2);
    }
    expect(parts[0]!.fill).not.toBe(parts[1]!.fill);
    const urdu = build(["یہ:b بہت:h@700"], { language: "ur" });
    const [a, b] = ["funky:0:w0", "funky:0:w1"].map((id) => evaluatePiece(urdu.pieces.find((piece) => piece.id === id)!, 1500).x);
    expect(b!).toBeGreaterThan(0);
    // Right to left: the first word sits right of the second.
    expect(a!).toBeGreaterThan(b!);
  });

  test("a row that is too tall for the band is fitted by height, in portrait, square and landscape, at twice the size", () => {
    for (const edge of ["urdu", "nine-words", "long-word", "no-hero"] as const) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
        const { cues } = sceneEdgeDemo(edge);
        const pieces = funkyProgram.build(sceneInput(cues, { fps: 30, colours, scale: 2, canvas })).pieces;
        for (const piece of pieces) {
          for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
            const box = pieceBounds(piece, t, fakeMeasure);
            if (!box) continue;
            expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
            expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
            expect(box.y1).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
            expect(box.y2).toBeLessThanOrEqual(0.95 * canvas.height + 1);
          }
        }
      }
    }
  });

  test("the piece count of a cue, every shadow layer counted, stays inside the budget on every edge demo", () => {
    for (const edge of ["one-word", "nine-words", "long-word", "no-hero", "urdu", "two-speakers"] as const) {
      const { cues } = sceneEdgeDemo(edge);
      const pieces = funkyProgram.build(sceneInput(cues, { fps: 30, colours })).pieces;
      for (const cue of cues) {
        const own = pieces.filter((piece) => piece.id.startsWith(`funky:${cue.index}:`));
        expect(own.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0), `${edge} cue ${cue.index}`).toBeLessThanOrEqual(150);
      }
    }
  });

  test("a brand colour that cannot reach 3:1 against the dark outline falls back to the style's own; the default palette reaches it", () => {
    for (const fill of FILLS) expect(captionColourContrast(fill, "#1B0F3B")).toBeGreaterThanOrEqual(3);
    const { pieces } = build(LINES, { colours: { ...colours, primary: "#241A5E", highlight: "#1B1052" } });
    const fills = new Set(pieces.filter((piece): piece is TextPiece => piece.kind === "text").map((piece) => piece.fill));
    expect([...fills].every((fill) => FILLS.includes(fill))).toBe(true);
    const washed = build(LINES, { colours: { ...colours, primary: "#F6F3EA" } });
    expect(washed.pieces.some((piece) => piece.kind === "text" && piece.fill === "#F6F3EA")).toBe(true);
  });

  test("every face has a thin dark outline and two hard shadow copies, and the bounds include the outline", () => {
    const { pieces } = build(["so:b funky:h@720"]);
    for (const piece of faces(pieces, 0)) {
      expect(piece.stroke?.colour).toBe("#1B0F3B");
      expect(piece.stroke!.widthPx).toBeGreaterThan(2);
      expect(piece.shadows).toHaveLength(2);
      expect(piece.shadows![0]!.blur).toBe(0);
      const t = piece.fromMs + 600;
      const plain = pieceBounds({ ...piece, stroke: undefined }, t, fakeMeasure)!;
      expect(pieceBounds(piece, t, fakeMeasure)!.x1).toBeLessThan(plain.x1);
    }
  });
});
