import { exportFrameTimes } from "../frame-grid";
import type { SceneCue, SceneInput } from "../input";
import { type SceneSpace, balancedRows, cueDirection, rowVisualOrder, rowWidth, sceneSpace } from "../layout";
import { type Box, type Piece, type TextPiece, pieceBounds } from "../scene";

export interface SpeechWindow {
  readonly cue: SceneCue;
  readonly index: number;
  readonly start: number;
  readonly spokenEnd: number;
  from: number;
  to: number;
  lane: number;
  bounds: Box;
}

/** Fit simultaneous lines into distinct vertical lanes. A following line in the same lane
 * may use whatever lead remains after the previous line has had time to read. */
export function speechWindows(input: SceneInput, safe: Box, lead: number, hold: number): SpeechWindow[] {
  const windows: SpeechWindow[] = [];
  let group: SpeechWindow[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const placeGroup = () => {
    if (laneEnds.length < 2) return;
    const laneHeight = (safe.y2 - safe.y1) / laneEnds.length;
    for (const w of group) {
      w.bounds = { ...safe, y1: safe.y1 + w.lane * laneHeight, y2: safe.y1 + (w.lane + 1) * laneHeight };
    }
  };
  const lastInLane: SpeechWindow[] = [];
  input.cues.forEach((cue, index) => {
    if (!cue.words.length) return;
    const start = Math.min(...cue.words.map((word) => word.startMs));
    const spokenEnd = Math.max(...cue.words.map((word) => word.endMs));
    if (start >= groupEnd) {
      placeGroup();
      // Other lanes from the prior group also need to clear before the next cue can span them.
      for (const w of lastInLane) w.to = Math.min(w.to, start);
      group = [];
      laneEnds = [];
      groupEnd = -Infinity;
    }
    const free = laneEnds.findIndex((end) => end <= start);
    const lane = free < 0 ? laneEnds.length : free;
    laneEnds[lane] = spokenEnd;
    groupEnd = Math.max(groupEnd, spokenEnd);
    let from = Math.max(0, start - lead);
    const predecessors = group.length ? [lastInLane[lane]] : lastInLane;
    for (const previous of predecessors) {
      if (previous && previous.to > from) from = Math.max(from, Math.min(start, previous.spokenEnd + hold));
    }
    for (const previous of predecessors) {
      if (previous) previous.to = Math.min(previous.to, from);
    }
    const to = Math.max(cue.endMs, spokenEnd);
    const w = { cue, index, start, spokenEnd, from, to, lane, bounds: safe };
    group.push(w);
    windows.push(w);
    lastInLane[lane] = w;
  });
  placeGroup();
  return windows;
}

export function speechLaneSpace(space: SceneSpace, bounds: Box, anchor: number): SceneSpace {
  if (bounds.y1 === space.safe.y1 && bounds.y2 === space.safe.y2) return space;
  const shift = (bounds.y1 + bounds.y2) / 2 - space.y(anchor);
  return { ...space, safe: bounds, y: (y) => space.y(y) + shift };
}

/** Decorations that only reach one painted frame would flash during very fast speech. */
export function hasTwoPaintedFrames(piece: Piece, input: SceneInput): boolean {
  let visible = 0;
  for (const t of exportFrameTimes(piece.fromMs, piece.toMs, input.fps)) {
    if (pieceBounds(piece, t, input.measure) && ++visible === 2) return true;
  }
  return false;
}

/** A short handoff can keep the outgoing hold if the next cue paints in free space. */
export function renderWithReadingHolds(
  windows: readonly SpeechWindow[],
  input: SceneInput,
  hold: number,
  render: (window: SpeechWindow) => Piece[],
): Piece[] {
  const drawn = windows.map(render);
  const clipEnd = Math.max(...windows.map(({ to }) => to));
  const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  for (let at = windows.length - 2; at >= 0; at--) {
    const w = windows[at]!;
    const desired = Math.min(w.spokenEnd + hold, clipEnd);
    if (w.to >= desired) continue;
    const others = drawn.flatMap((pieces, i) => i === at ? [] : pieces.filter((piece) => piece.fromMs < desired && piece.toMs > w.to));
    if (!others.length) continue;
    const extended = render({ ...w, to: desired });
    const collision = exportFrameTimes(w.to, desired, input.fps).find((t) => {
      const later = others.flatMap((piece) => pieceBounds(piece, t, input.measure) ?? []);
      return extended.some((piece) => {
        const box = pieceBounds(piece, t, input.measure);
        return box !== null && later.some((other) => overlaps(box, other));
      });
    });
    if (collision === undefined) drawn[at] = extended;
  }
  return drawn.flat();
}

interface WordSpec {
  readonly text: string;
  readonly size: number;
  readonly face: TextPiece["face"];
  readonly spacing: number;
}

export interface SpeechCell extends WordSpec {
  readonly at: number;
  readonly x: number;
  readonly baseline: number;
  readonly width: number;
  readonly inkTop: number;
  readonly inkBottom: number;
}

interface WordLayout {
  readonly cells: SpeechCell[];
  readonly box: Box;
  readonly unit: number;
}

export function layoutSpeechWords(
  input: SceneInput,
  window: SpeechWindow,
  config: {
    readonly anchor: number;
    readonly column: number;
    readonly gap: number;
    readonly padding: number;
    readonly align?: "leading";
    readonly words: readonly WordSpec[];
    /** Split before/after special words that should sit on their own row. */
    readonly groups?: readonly number[][];
  },
): WordLayout {
  const { bounds, cue } = window;
  const space = sceneSpace(input, config.anchor);
  const direction = cueDirection(cue);
  const safeW = bounds.x2 - bounds.x1;
  const safeH = bounds.y2 - bounds.y1;
  const groups = config.groups ?? [config.words.map((_, at) => at)];
  const minWidth = Math.max(1, Math.min(config.column * space.u, safeW - 2 * config.padding * space.u));
  const measured = config.words.map((word) => input.measure(word.text, word.face, word.size * space.u, word.spacing));
  let unit = Math.min(space.u, space.u * minWidth / Math.max(...measured.map((word) => word.advance)));
  const measureRows = (u: number) => {
    const ratio = u / space.u;
    const widths = measured.map((word) => word.advance * ratio);
    const maxWidth = Math.min(config.column * space.u, safeW - 2 * config.padding * u);
    const gap = config.gap * u;
    const rows = groups.flatMap((group) => balancedRows(group.map((at) => widths[at]!), gap, maxWidth).map((row) => row.map((at) => group[at]!)));
    const metrics = rows.map((row) => ({
      above: Math.max(...row.map((at) => Math.max(config.words[at]!.size * u * 0.83, -measured[at]!.inkTop * ratio))),
      below: Math.max(...row.map((at) => Math.max(config.words[at]!.size * u * 0.27, measured[at]!.inkBottom * ratio))),
    }));
    return { widths, gap, rows, metrics, height: metrics.reduce((sum, row) => sum + row.above + row.below, 0) };
  };
  let layout = measureRows(unit);
  const need = layout.height + 2 * config.padding * unit;
  if (need > safeH) {
    unit *= safeH / need * 0.995;
    layout = measureRows(unit);
  }
  const { widths, gap, rows, metrics, height } = layout;
  const padding = config.padding * unit;
  const wide = Math.max(...rows.map((row) => rowWidth(widths, row, gap)));
  const cx = Math.min(bounds.x2 - padding - wide / 2, Math.max(bounds.x1 + padding + wide / 2, space.x(540)));
  const targetY = speechLaneSpace(space, bounds, config.anchor).y(config.anchor);
  const top = Math.min(bounds.y2 - padding - height, Math.max(bounds.y1 + padding, targetY - height / 2));
  const cells: SpeechCell[] = [];
  let y = top;
  rows.forEach((row, r) => {
    const { above, below } = metrics[r]!;
    const width = rowWidth(widths, row, gap);
    let x = cx - width / 2;
    if (config.align === "leading") x = direction === "rtl" ? cx + wide / 2 - width : cx - wide / 2;
    for (const i of rowVisualOrder(row.map((at) => config.words[at]!.text), direction)) {
      const at = row[i]!;
      const word = config.words[at]!;
      const width = widths[at]!;
      const ink = measured[at]!;
      cells.push({ ...word, at, size: word.size * unit, x: x + width / 2, baseline: y + above, width, inkTop: ink.inkTop * unit / space.u, inkBottom: ink.inkBottom * unit / space.u });
      x += width + gap;
    }
    y += above + below;
  });
  return { cells, box: { x1: cx - wide / 2, x2: cx + wide / 2, y1: top, y2: top + height }, unit };
}
