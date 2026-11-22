import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import { exportFrameAtOrAfter, exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
import type { SceneCue, SceneProgram } from "./input";
import { type Piece, evaluatePiece, pieceBounds } from "./scene";
import { cascadeProgram } from "./templates/cascade";
import { trailProgram } from "./templates/trail";
import { fakeMeasure, sceneInput } from "./test-support";

const programs: Record<string, SceneProgram> = { trail: trailProgram, cascade: cascadeProgram };
const canvasSizes = [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }];
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const faceOf = (name: string, piece: Piece) => name === "trail" ? /:w\d+l\d+c0$/.test(piece.id) : /:(w|h)\d+$/.test(piece.id);
const wordOf = (piece: Piece) => Number(/:(?:w|h)(\d+)/.exec(piece.id)![1]);

for (const [name, program] of Object.entries(programs)) {
  describe(`${name} final handoff regressions`, () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const canvas of canvasSizes) {
        for (const scenario of [
          { name: "third cue", lines: ["FIRST:b@300 LATE:b@300", "WAIT:b@300", "WHAT:b@300"], starts: [357, 887, 1187] },
          { name: "stacked rows", lines: ["first:b@150 second:b@150 third:b@150 fourth:b@150", "other:b@150 speaker:b@150 keeps:b@150 talking:b@150"], starts: [357, 887] },
        ]) {
          test(`${fps} fps, ${canvas.width}x${canvas.height}, ${scenario.name}: overlapping speakers keep every word through its spoken end`, () => {
            const { cues } = demoCues({ lines: scenario.lines, options: { lead: 357, gap: 0, cueGap: 0 } });
            const starts = scenario.starts;
            const run: SceneCue[] = cues.map((cue, i) => {
              const offset = starts[i]! - cue.startMs;
              return { ...cue, startMs: cue.startMs + offset, endMs: cue.endMs + offset, speaker: i % 2, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + offset, endMs: word.endMs + offset })) };
            });
            const pieces = program.build(sceneInput(run, { fps, canvas })).pieces;
            const words = new Set(pieces.filter((piece) => faceOf(name, piece)).map((piece) => `${cueOf(piece)}:${wordOf(piece)}`));
            expect(words.size).toBe(run.reduce((count, cue) => count + cue.words.length, 0));
            for (const face of pieces.filter((piece) => faceOf(name, piece))) {
              const spoken = run[cueOf(face)]!.words[wordOf(face)]!;
              const t = exportFrameAtOrBefore(spoken.endMs - 1, fps);
              const pose = evaluatePiece(face, t);
              expect(pose.visible, `${face.id} leaves before ${spoken.endMs}`).toBe(true);
              expect(pose.o, `${face.id} fades before its spoken end`).toBeGreaterThanOrEqual(0.9);
              const whole = pieceBounds({ ...face, clip: undefined }, t, fakeMeasure);
              const clipped = pieceBounds(face, t, fakeMeasure);
              expect(clipped, `${face.id} clipped away at ${t}`).not.toBeNull();
              expect(clipped!.x1).toBeLessThanOrEqual(whole!.x1 + 0.5);
              expect(clipped!.x2).toBeGreaterThanOrEqual(whole!.x2 - 0.5);
            }
            for (const t of exportFrameTimes(run[0]!.startMs, run.at(-1)!.words.at(-1)!.endMs, fps)) {
              const live = pieces.flatMap((piece) => {
                const box = pieceBounds(piece, t, fakeMeasure);
                return box ? [{ piece, box }] : [];
              });
              for (const { piece: face, box } of live.filter(({ piece }) => faceOf(name, piece))) {
                for (const other of live) {
                  if (cueOf(other.piece) <= cueOf(face)) continue;
                  const meets = box.x1 + 0.5 < other.box.x2 && other.box.x1 + 0.5 < box.x2 && box.y1 + 0.5 < other.box.y2 && other.box.y1 + 0.5 < box.y2;
                  expect(meets, `${other.piece.id} covers ${face.id} at ${t}`).toBe(false);
                }
              }
            }
          });
        }
      }
      test(`${fps} fps: ordinary speech keeps words until their ends and decorations paint twice`, () => {
        const { cues } = demoCues({ lines: ["GO:b@300 NOW:b@300", "TRY:b@300 THIS:b@300", "YES:h@300", "KEEP:b@300 GOING:b@300"], options: { lead: 357, gap: 0, cueGap: 60 } });
        const pieces = program.build(sceneInput(cues, { fps })).pieces;
        for (const face of pieces.filter((piece) => faceOf(name, piece))) {
          const word = cues[cueOf(face)]!.words[wordOf(face)]!;
          // Trail's hero letters retain their sample stagger. The first letter must paint on time.
          if (name !== "trail" || /l0c0$/.test(face.id)) expect(pieceBounds(face, exportFrameAtOrAfter(word.startMs, fps), fakeMeasure), `${face.id} missing at onset`).not.toBeNull();
          const t = exportFrameAtOrBefore(word.endMs - 1, fps);
          expect(evaluatePiece(face, t).visible, `${face.id} leaves before ${word.endMs}`).toBe(true);
        }
        for (const piece of pieces.filter((piece) => !faceOf(name, piece))) {
          const frames = exportFrameTimes(piece.fromMs, piece.toMs, fps).filter((t) => pieceBounds(piece, t, fakeMeasure) !== null && evaluatePiece(piece, t).o > 0);
          expect(frames.length, `${piece.id} flashes`).not.toBe(1);
        }
      });
    }
  });
}
