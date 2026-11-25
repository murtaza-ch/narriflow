import { toCaptionUpperCase } from "@narriflow/validators";
import { exportFrameAtOrBefore, exportFrameTimes, paintedFrameCount, SCENE_DEFAULT_FPS } from "../frame-grid";
import type { SceneCue, SceneInput, SceneProgram, SceneWord } from "../input";
import { cueDirection, sceneSpace, shiftPiece } from "../layout";
import { type Box, type Clip, type Frames, type PathCmd, type Piece, type ShapePiece, type TextPiece, type Track, sceneBoundsAt } from "../scene";
import { ellipsePath, roundedRectPath } from "../shapes";
import { hasTwoPaintedFrames, layoutSpeechWords, renderWithReadingHolds, type SpeechCell, type SpeechWindow, speechLaneSpace, speechWindows } from "./speech-layout";

const HOLD = 150;
const LEAD = 80;

export const caps = (word: SceneWord, cue: SceneCue) => toCaptionUpperCase(word.text, cue.language);

export function roleRows(cue: SceneCue, bodyWords: number): number[][] {
  const rows: number[][] = [];
  for (const [at, word] of cue.words.entries()) {
    const previous = rows.at(-1);
    if (!previous || previous.length >= bodyWords || word.role === "hero" || cue.words[at - 1]?.role === "hero") rows.push([at]);
    else previous.push(at);
  }
  return rows;
}

export function rowsOf(cells: readonly SpeechCell[]): SpeechCell[][] {
  const rows = new Map<number, SpeechCell[]>();
  for (const cell of cells) {
    const row = rows.get(cell.baseline);
    if (row) row.push(cell);
    else rows.set(cell.baseline, [cell]);
  }
  return [...rows.values()];
}

export function inkCentre(cell: SpeechCell): number {
  return cell.baseline + (cell.inkTop + cell.inkBottom) / 2;
}

export function rowBounds(row: readonly SpeechCell[]): Box {
  return {
    x1: Math.min(...row.map((cell) => cell.x - cell.width / 2)),
    x2: Math.max(...row.map((cell) => cell.x + cell.width / 2)),
    y1: Math.min(...row.map((cell) => cell.baseline + cell.inkTop)),
    y2: Math.max(...row.map((cell) => cell.baseline + cell.inkBottom)),
  };
}

export function rotatePoint(x: number, y: number, angle: number): readonly [number, number] {
  const radians = angle * Math.PI / 180;
  return [x * Math.cos(radians) - y * Math.sin(radians), x * Math.sin(radians) + y * Math.cos(radians)];
}

export const rectClip = (at: number, box: Box): Clip => ({
  x1: [[at, box.x1]], x2: [[at, box.x2]], y1: [[at, box.y1]], y2: [[at, box.y2]],
});

interface Entrance {
  readonly from: number;
  readonly settled: number;
  readonly motion: boolean;
}

interface GalleryContext {
  readonly input: SceneInput;
  readonly window: SpeechWindow;
  readonly id: string;
  readonly rtl: boolean;
  readonly side: number;
  readonly fps: number;
  readonly exitAt: number;
  readonly exit: boolean;
  readonly space: ReturnType<typeof sceneSpace>;
  enter(word: SceneWord, duration: number, lead?: number): Entrance;
  layout(config: Omit<Parameters<typeof layoutSpeechWords>[2], "anchor">): ReturnType<typeof layoutSpeechWords>;
  face(cell: SpeechCell, from: number, fill: string, track?: Track): TextPiece;
  shape(id: string, from: number, path: readonly PathCmd[], track: Track, fill?: string): ShapePiece;
  rect(id: string, from: number, x: number, y: number, w: number, h: number, radius: number, fill: string, track?: Track): ShapePiece;
  dot(id: string, from: number, x: number, y: number, r: number, fill: string, track?: Track): ShapePiece;
  drift(from: number, rest: number, offset: number, settled: number, exitOffset?: number): Frames;
}

/** `region` is the box the cues' lanes are cut from; a style with a fixed strip at one edge keeps its captions clear of it (default: the safe area). */
export function galleryScene(name: string, anchor: number, draw: (ctx: GalleryContext) => Piece[], region?: Box): SceneProgram {
  return {
    build(input) {
      const space = sceneSpace(input, anchor);
      const fps = input.fps ?? SCENE_DEFAULT_FPS;
      const windows = speechWindows(input, region ?? space.safe, LEAD, HOLD);
      const pieces = renderWithReadingHolds(windows, input, HOLD, (window) => {
        const { cue, index, to, bounds } = window;
        const id = `${name}:${index}`;
        const rtl = cueDirection(cue) === "rtl";
        const exitAt = Math.max(window.spokenEnd + HOLD, to - 160);
        const exit = paintedFrameCount(exitAt, to, fps) >= 2;
        const fade = (from: number): Frames | undefined => exit ? [[from, 1], [exitAt, 1], [to, 0, "in"]] : undefined;
        const drawAt = (scale: number) => {
          const scaled = { ...input, scale };
          return draw({
            input: scaled, window, id, rtl, side: rtl ? -1 : 1, fps, exitAt, exit,
            space: speechLaneSpace(sceneSpace(scaled, anchor), bounds, anchor),
            enter(word, duration, lead = LEAD) {
              const from = Math.max(window.from, word.startMs - lead);
              const settled = Math.max(from, Math.min(from + duration, exportFrameAtOrBefore(word.endMs - 1, fps)));
              return { from, settled, motion: paintedFrameCount(from, settled, fps) >= 2 };
            },
            layout(config) {
              return layoutSpeechWords(scaled, window, { ...config, anchor });
            },
            face(cell, from, fill, track) {
              return {
                id: `${id}:w${cell.at}`, kind: "text", z: 6, fromMs: from, toMs: to,
                text: cell.text, face: cell.face, sizePx: cell.size, letterSpacingEm: cell.spacing, fill,
                anchor: "baseline-center", language: cue.language,
                track: { x: [[from, cell.x]], y: [[from, cell.baseline]], ...(exit ? { o: fade(from) } : {}), ...track },
              };
            },
            shape(suffix, from, path, track, fill) {
              return {
                id: `${id}:${suffix}`, kind: "shape", z: 2, fromMs: from, toMs: to, path,
                ...(fill ? { fill: { colour: fill } } : {}),
                track: { ...(exit ? { o: fade(from) } : {}), ...track },
              };
            },
            rect(suffix, from, x, y, w, h, radius, fill, track) {
              return this.shape(suffix, from, roundedRectPath(-w / 2, -h / 2, w, h, radius), { x: [[from, x]], y: [[from, y]], ...track }, fill);
            },
            dot(suffix, from, x, y, radius, fill, track) {
              return this.shape(suffix, from, ellipsePath(0, 0, radius), { x: [[from, x]], y: [[from, y]], ...track }, fill);
            },
            drift(from, rest, offset, settled, exitOffset = 0) {
              const track: [number, number, ("outExpo" | "in")?][] = settled > from ? [[from, rest + offset], [settled, rest, "outExpo"]] : [[from, rest]];
              if (exit && exitOffset) track.push([exitAt, rest], [to, rest + exitOffset, "in"]);
              return track;
            },
          });
        };
        const safe = { x1: bounds.x1 + 3, x2: bounds.x2 - 3, y1: bounds.y1 + 3, y2: bounds.y2 - 3 };
        let scale = input.scale;
        let drawn = drawAt(scale);
        let ink = motionBounds(drawn, window, input, fps);
        for (let tries = 0; tries < 8; tries++) {
          const fit = Math.min(1, (safe.x2 - safe.x1) / Math.max(1, ink.x2 - ink.x1), (safe.y2 - safe.y1) / Math.max(1, ink.y2 - ink.y1));
          if (fit >= 1) break;
          scale *= Math.min(fit * 0.98, 0.9);
          drawn = drawAt(scale);
          ink = motionBounds(drawn, window, input, fps);
        }
        const dx = Math.min(Math.max(0, safe.x1 - ink.x1), safe.x2 - ink.x2);
        const dy = Math.min(Math.max(0, safe.y1 - ink.y1), safe.y2 - ink.y2);
        const faceId = new RegExp(`^${id}:w\\d+(?:l\\d+)?$`);
        return drawn.map((piece) => shiftPiece(piece, dx, dy)).filter((piece) =>
          faceId.test(piece.id) || hasTwoPaintedFrames(piece, input));
      });
      return { pieces };
    },
  };
}

function motionBounds(pieces: readonly Piece[], window: SpeechWindow, input: SceneInput, fps: number): Box {
  const { from, to } = window;
  // Capture entrances and step changes between frames as well as the export grid.
  const times = new Set(exportFrameTimes(from, to, fps));
  for (let t = from; t < to; t += 16) times.add(t);
  for (const piece of pieces) {
    times.add(piece.fromMs);
    times.add(piece.toMs - 0.001);
    for (const track of Object.values(piece.track)) {
      if (!track) continue;
      for (const [at] of track) if (at >= from && at < to) times.add(at);
    }
  }
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const t of times) {
    const box = sceneBoundsAt(pieces, t, input.measure);
    if (!box) continue;
    x1 = Math.min(x1, box.x1);
    y1 = Math.min(y1, box.y1);
    x2 = Math.max(x2, box.x2);
    y2 = Math.max(y2, box.y2);
  }
  return { x1, y1, x2, y2 };
}

/** Individual letters for effects that need them. Joined scripts and long words stay intact. */
export function letterCells(cell: SpeechCell, input: SceneInput, limit = 18): SpeechCell[] {
  const letters = [...cell.text];
  if (letters.length > limit || !/^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}]+$/u.test(cell.text)) return [cell];
  let prefix = "";
  return letters.map((text) => {
    const start = prefix ? input.measure(prefix, cell.face, cell.size, cell.spacing).advance + cell.spacing * cell.size : 0;
    prefix += text;
    const { advance: width, inkTop, inkBottom } = input.measure(text, cell.face, cell.size, 0);
    return { ...cell, text, width, inkTop, inkBottom, spacing: 0, x: cell.x - cell.width / 2 + start + width / 2 };
  });
}
