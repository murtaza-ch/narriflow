import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
import type { SceneCue, SceneInput, SceneProgram } from "./input";
import { type Box, type Piece, evaluatePiece, pieceBounds } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";

/**
 * The speech-timing contract every Motion template owes on real cues, as one reusable suite
 * (`.scratch/motion-captions/gallery3-brief.md`, "Cue handoff rule" and "Ship-check additions").
 * Gallery 3's first ports each wrote their own version of these checks and each missed a different
 * clause; a template's test file calls `describeSpeechConformance` instead.
 *
 * Two runs: ordinary speech (150 ms words) and staccato speech (one- and two-word cues of 70 ms words).
 * It reasons in painted frames on the export grid (`frame-grid.ts`) at 24, 25, 30 and 60 fps, with
 * the run shifted by sub-frame offsets, and checks:
 *   1. every spoken word has a readable face piece, and nothing else is text the speaker did not say;
 *   2. a word's face paints on the first frame at or after its spoken start (never late), and no
 *      piece of a cue paints more than `leadMs` before the cue's first word;
 *   3. a face is opaque (≥ 0.9) and unclipped on the last frame before its spoken end;
 *   4. after its spoken end it stays readable for 150 ms, or until a later cue first paints;
 *   5. no piece of a later cue ever overlaps a live face of an earlier cue;
 *   6. no piece paints on exactly one frame;
 *   7. nothing paints after the last cue's end;
 *   8. overlapping speakers both keep every word through its spoken end, uncovered, also at 2x on 16:9;
 *   9. at twice the sample size on 9:16, 1:1 and 16:9, every painted frame stays in the safe area.
 *
 * Face pieces: by default a piece whose id is `<scene>:<cue>:w<word>` (the whole word) or
 * `<scene>:<cue>:w<word>l<part>` (a letter or segment of it; part 0 is the first to paint) is the
 * word's readable face. Shadows, plates, ghosts, copies and decorations use any other id. A template
 * with another convention passes `face`.
 */

export interface FaceRef {
  readonly cue: number;
  readonly word: number;
  /** Letter or segment index; 0 (or a whole-word piece) must paint at the spoken start. */
  readonly part: number;
}

export interface SpeechConformanceOptions {
  /** Maps a piece to the word face it draws, or null for anything else. */
  readonly face?: (piece: Piece) => FaceRef | null;
  /** How early a cue's first piece may paint before its first word (default 100 ms). */
  readonly leadMs?: number;
  /** The anchor line the template lays out on (`CAPTION_SCENES[name].anchorLineY`, default 1290). */
  readonly anchorLineY?: number;
}

const FPS = [24, 25, 30, 60] as const;
const OFFSETS = [0, 7, 23] as const;
const READ_MS = 150;
const OPAQUE = 0.9;
const EPS = 0.5;

function defaultFace(name: string) {
  const pattern = new RegExp(`^${name}:(\\d+):w(\\d+)(?:l(\\d+))?$`);
  return (piece: Piece): FaceRef | null => {
    const m = pattern.exec(piece.id);
    return m ? { cue: Number(m[1]), word: Number(m[2]), part: m[3] ? Number(m[3]) : 0 } : null;
  };
}

const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const meets = (a: Box, b: Box) => a.x1 + EPS < b.x2 && b.x1 + EPS < a.x2 && a.y1 + EPS < b.y2 && b.y1 + EPS < a.y2;

function painted(piece: Piece, t: number): Box | null {
  return pieceBounds(piece, t, fakeMeasure);
}

/** Opaque and not cut by its clip. */
function readable(piece: Piece, t: number): boolean {
  const pose = evaluatePiece(piece, t);
  if (!pose.visible || pose.o < OPAQUE) return false;
  const whole = pieceBounds({ ...piece, clip: undefined }, t, fakeMeasure);
  const clipped = pieceBounds(piece, t, fakeMeasure);
  if (!whole || !clipped) return false;
  return clipped.x1 <= whole.x1 + EPS && clipped.x2 >= whole.x2 - EPS && clipped.y1 <= whole.y1 + EPS && clipped.y2 >= whole.y2 - EPS;
}

function shift(cues: readonly SceneCue[], by: number): SceneCue[] {
  return cues.map((cue) => ({
    ...cue,
    startMs: cue.startMs + by,
    endMs: cue.endMs + by,
    words: cue.words.map((word) => ({ ...word, startMs: word.startMs + by, endMs: word.endMs + by })),
  }));
}

/** A long ordinary run: 12 cues of 150 ms words and 100 ms heroes, the given gap between cues, no gap between words. */
export function fastRun(cueGap: number): SceneCue[] {
  const lines = [
    "so:m here:b is:m the:m thing:h@100",
    "nobody:b tells:b you:m this",
    "you:m have:b to:m start:h@100",
    "before:b you:m feel:b ready",
    "it:m works:b",
    "every:b single:b time:h@100",
    "trust:h@100 me",
    "i:m tried:b it:m for:m a:m whole:b month",
    "and:m the:m results:b were:m insane:h@100",
    "go",
    "try:b it:m today:h@100",
    "thank:b you:m so:m much:b for:m watching",
  ].map((line) => line.split(" ").map((token) => (token.includes("@") ? token : `${token}@150`)).join(" "));
  return demoCues({ lines, options: { lead: 400, gap: 0, cueGap, tail: 400 } }).cues;
}

/** Staccato speech: one- and two-word cues of 70 ms words and 100-120 ms heroes (Sol's Slab probes, 2026-11-24). */
export function staccatoRun(cueGap: number): SceneCue[] {
  const lines = ["go@70", "on@70", "then@120", "we@100 stop:h@120", "we@70 stop:h@100", "one@70 more@70 step@80", "yes:h@100", "no@70", "right@90 now:h@100", "ok@70"];
  return demoCues({ lines, options: { lead: 311, gap: 0, cueGap, tail: 400 } }).cues;
}

export function describeSpeechConformance(name: string, program: SceneProgram, options: SpeechConformanceOptions = {}): void {
  const faceOf = options.face ?? defaultFace(name);
  const leadMs = options.leadMs ?? 100;
  const anchorLineY = options.anchorLineY ?? 1290;
  const build = (cues: readonly SceneCue[], overrides: Partial<SceneInput> = {}) =>
    program.build(sceneInput(cues, { anchor: { xPct: 50, yPct: (anchorLineY / 1920) * 100 }, ...overrides })).pieces;

  describe(`${name}: speech conformance`, () => {
    for (const fps of FPS) {
      for (const [runName, makeRun, cueGap] of [["ordinary", fastRun, 0], ["ordinary", fastRun, 60], ["staccato", staccatoRun, 0], ["staccato", staccatoRun, 60]] as const) {
        test(`${fps} fps, ${runName} speech, cue gap ${cueGap}: words paint on time, stay readable, are never covered or flashed`, () => {
          for (const offset of OFFSETS) {
            const run = shift(makeRun(cueGap), offset);
            const pieces = build(run, { fps });
            const at = `(offset ${offset})`;
            const faces = pieces.flatMap((piece) => {
              const ref = faceOf(piece);
              return ref ? [{ piece, ref }] : [];
            });

            // 1. Every word has a face; every face is a spoken word of its cue.
            for (const cue of run) {
              for (const [w] of cue.words.entries()) {
                expect(faces.some(({ ref }) => ref.cue === cue.index && ref.word === w), `${name}: cue ${cue.index} word ${w} has no face ${at}`).toBe(true);
              }
            }
            for (const { piece, ref } of faces) {
              const word = run[ref.cue]?.words[ref.word];
              expect(word, `${piece.id} names no spoken word`).toBeDefined();
              if (piece.kind === "text") expect(word!.text.toLocaleLowerCase().replace(/\s/g, ""), `${piece.id} draws text that is not its word`).toContain(piece.text.toLocaleLowerCase().replace(/\s/g, ""));
            }

            // The first frame each cue paints anything.
            const firstPaint = new Map<number, number>();
            for (const piece of pieces) {
              const cue = cueOf(piece);
              const t = exportFrameTimes(piece.fromMs, piece.toMs, fps).find((frame) => painted(piece, frame));
              if (t !== undefined) firstPaint.set(cue, Math.min(firstPaint.get(cue) ?? Number.POSITIVE_INFINITY, t));
            }
            const laterPaint = (cue: number) => Math.min(...[...firstPaint].filter(([c]) => c > cue).map(([, t]) => t), Number.POSITIVE_INFINITY);

            for (const cue of run) {
              // 2b. No cue paints more than the lead before its first word.
              const first = firstPaint.get(cue.index);
              expect(first, `${name}: cue ${cue.index} never paints ${at}`).toBeDefined();
              expect(first!, `${name}: cue ${cue.index} paints at ${first}, more than ${leadMs} ms before ${cue.words[0]!.startMs} ${at}`).toBeGreaterThanOrEqual(cue.words[0]!.startMs - leadMs - 1);
            }

            for (const { piece, ref } of faces) {
              const word = run[ref.cue]!.words[ref.word]!;
              // 2a. Never late: the first part paints at the spoken start.
              if (ref.part === 0) {
                const onset = exportFrameAtOrAfter(word.startMs, fps);
                expect(painted(piece, onset), `${piece.id} is not painted at its spoken start ${word.startMs} (frame ${onset}) ${at}`).not.toBeNull();
              }
              // 3. Opaque and whole on the last frame before its spoken end.
              const last = exportFrameAtOrBefore(word.endMs - 1, fps);
              expect(readable(piece, last), `${piece.id} is not readable at ${last}, before its spoken end ${word.endMs} ${at}`).toBe(true);
              // 4. Readable for 150 ms after the spoken end, or until a later cue first paints.
              const until = Math.min(word.endMs + READ_MS, laterPaint(ref.cue));
              for (const t of exportFrameTimes(exportFrameAtOrAfter(word.endMs, fps), until, fps)) {
                if (t >= until) break;
                expect(readable(piece, t), `${piece.id} stops reading at ${t}, ${t - word.endMs} ms after its spoken end ${word.endMs} ${at}`).toBe(true);
              }
            }

            // 5. A later cue never draws over an earlier cue's face.
            const from = run[0]!.words[0]!.startMs - leadMs - 50;
            const to = Math.max(...pieces.map((piece) => piece.toMs));
            for (const t of exportFrameTimes(from, to, fps)) {
              const live = pieces.flatMap((piece) => {
                const box = painted(piece, t);
                return box ? [{ piece, box }] : [];
              });
              for (const face of live) {
                const ref = faceOf(face.piece);
                if (!ref) continue;
                for (const other of live) {
                  if (cueOf(other.piece) <= ref.cue) continue;
                  expect(meets(face.box, other.box), `${other.piece.id} covers ${face.piece.id} at ${t} ${at}`).toBe(false);
                }
              }
            }

            // 6. No piece paints on exactly one frame; 7. nothing paints after the last cue ends.
            const end = run.at(-1)!.endMs;
            for (const piece of pieces) {
              const frames = exportFrameTimes(piece.fromMs, piece.toMs, fps).filter((t) => painted(piece, t));
              // A face may be a static pose on the one frame its word gets; anything else on one frame is a flash.
              if (!faceOf(piece)) expect(frames.length, `${piece.id} paints on a single frame (${frames[0]}) ${at}`).not.toBe(1);
              if (frames.length) expect(frames.at(-1)!, `${piece.id} paints at ${frames.at(-1)}, after the last cue ends at ${end} ${at}`).toBeLessThan(end + 1);
            }
          }
        });
      }

      test(`${fps} fps: overlapping speakers keep every word through its spoken end, uncovered (1x and 2x, 9:16 and 16:9)`, () => {
        for (const look of [{ scale: 1, canvas: { width: 1080, height: 1920 } }, { scale: 2, canvas: { width: 1080, height: 1920 } }, { scale: 2, canvas: { width: 1920, height: 1080 } }])
        for (const scenario of [
          { lines: ["first:b@300 late:b@300", "wait:b@300", "what:b@300"], starts: [357, 887, 1187] },
          { lines: ["first:b@150 second:b@150 third:b@150 fourth:b@150", "other:b@150 speaker:b@150 keeps:b@150 talking:b@150"], starts: [357, 887] },
          { lines: ["some:b@300 fairly:b@300 long:b@300 words:b@300 collide:b@300", "other:b@300 fairly:b@300 long:b@300 words:b@300 interrupt:b@300"], starts: [400, 500] },
        ]) {
          const { cues } = demoCues({ lines: scenario.lines, options: { lead: 357, gap: 0, cueGap: 0 } });
          const run: SceneCue[] = cues.map((cue, i) => {
            const by = scenario.starts[i]! - cue.startMs;
            return { ...shift([cue], by)[0]!, speaker: i % 2 };
          });
          const pieces = build(run, { fps, ...look });
          for (const piece of pieces) {
            const ref = faceOf(piece);
            if (!ref) continue;
            const word = run[ref.cue]!.words[ref.word]!;
            const last = exportFrameAtOrBefore(word.endMs - 1, fps);
            expect(readable(piece, last), `${piece.id} is not readable at ${last}, before its spoken end ${word.endMs}`).toBe(true);
          }
          for (const t of exportFrameTimes(run[0]!.startMs - leadMs, Math.max(...pieces.map((piece) => piece.toMs)), fps)) {
            const live = pieces.flatMap((piece) => {
              const box = painted(piece, t);
              return box ? [{ piece, box }] : [];
            });
            for (const face of live) {
              const ref = faceOf(face.piece);
              if (!ref) continue;
              for (const other of live) {
                if (cueOf(other.piece) <= ref.cue) continue;
                expect(meets(face.box, other.box), `${other.piece.id} covers ${face.piece.id} at ${t}`).toBe(false);
              }
            }
          }
        }
      });
    }

    test("twice the sample size stays in the safe area on every painted frame, 9:16, 1:1 and 16:9", () => {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
        for (const cues of [fastRun(60), sceneEdgeDemo("long-word").cues, sceneEdgeDemo("nine-words").cues, sceneEdgeDemo("urdu").cues]) {
          const pieces = build(cues, { canvas, scale: 2, fps: 30 });
          const safe = { x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 };
          for (const piece of pieces) {
            if (piece.bleed) continue;
            for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
              const box = painted(piece, t);
              if (!box) continue;
              const inside = box.x1 >= safe.x1 && box.y1 >= safe.y1 && box.x2 <= safe.x2 && box.y2 <= safe.y2;
              expect(inside, `${piece.id} at ${t} on ${canvas.width}x${canvas.height}: ${JSON.stringify(box)}`).toBe(true);
            }
          }
        }
      }
    });
  });
}
