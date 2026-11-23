import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, prog } from "../ease";
import { paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { clampToSafeArea, cueDirection, greedyRows, rowVisualOrder, sceneSpace } from "../layout";
import type { PathCmd, Piece, ShapePiece, TextPiece } from "../scene";
import { ellipsePath, pathBounds, polylinePath, starPath } from "../shapes";

/**
 * Orbit, gallery-3's m21-mood: cream grotesk, closing tracking, an orange ellipse and moving
 * planet, three cycling flat stickers, pink sparkles, then a squash exit about the block centre.
 * Whole-word spacing steps preserve shaping and match Aura's shared-renderer approach. Joined
 * scripts keep their natural spacing. Wrapping uses the final word widths, as the sample does.
 * Unlike the sample's fixed exit, the squash waits until the last spoken word has finished.
 */
export const ORBIT_DEMO: DemoScript = {
  lines: ["nobody:m talks:b about:m this:m part", "the:m boring:h@560 middle", "where:m you:m just:b keep:b going", "that's:m where:m the:m magic:h@600 is", "trust:h@560 it"],
  options: { rate: 270 },
};

const BODY = 124;
const ANCHOR = 1290;
const REST = -0.03;
const SIMPLE = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}\p{P}\p{S}]+$/u;
const SPACING_STEPS = [0, 0.07, 0.18, 0.36, 0.64, 1] as const;
const INK = "#1C1B1F";

interface WordBox {
  at: number;
  x: number;
  y: number;
  top: number;
  width: number;
  height: number;
  size: number;
  face: TextPiece["face"];
  spacing: number;
}

function buildCue(cue: SceneCue, number: number, heroNumber: number, end: number, input: SceneInput): Piece[] {
  if (!cue.words.length || end <= cue.startMs - 80) return [];
  const space = sceneSpace(input, ANCHOR);
  const rtl = cueDirection(cue) === "rtl";
  // Leave room for the ring, sticker overshoot and a word's tracking beyond the final row.
  const maxWidth = Math.max(1, Math.min(880 * space.u, (space.safe.x2 - space.safe.x1) - 160 * space.u));
  const measureAt = (at: number, size: number) => {
    const word = cue.words[at]!;
    const face: TextPiece["face"] = word.role === "hero" ? "Inter Tight Medium" : "Inter Tight Regular";
    const spacing = SIMPLE.test(word.text) ? REST : 0;
    const m = input.measure(word.text, face, size, spacing);
    return { at, size, face, spacing, width: Math.max(1, m.advance + spacing * size), height: Math.max(size * 1.06, m.inkBottom - m.inkTop), m };
  };
  let sizes = cue.words.map((word) => BODY * (word.role === "hero" ? 1.3 : 1) * space.u);
  const widest = Math.max(...sizes.map((size, at) => measureAt(at, size).width));
  if (widest > maxWidth - 12 * space.u) sizes = sizes.map((size) => size * (maxWidth - 12 * space.u) / widest);
  let measured = sizes.map((size, at) => measureAt(at, size));
  let gap = BODY * space.u * 0.24 * (sizes[0]! / (BODY * (cue.words[0]!.role === "hero" ? 1.3 : 1) * space.u));
  let rows = greedyRows(measured.map((word) => word.width), gap, maxWidth);
  const rowHeight = (row: readonly number[]) => Math.max(...row.map((at) => measured[at]!.height));
  // Very tall cues fit vertically as a unit, including the decorations above and below them.
  const naturalHeight = rows.reduce((sum, row) => sum + rowHeight(row), 0);
  const fit = Math.min(1, (space.safe.y2 - space.safe.y1 - 180 * space.u) / naturalHeight);
  if (fit < 1) {
    measured = sizes.map((size, at) => measureAt(at, size * fit));
    gap *= fit;
    rows = greedyRows(measured.map((word) => word.width), gap, maxWidth);
  }
  const height = rows.reduce((sum, row) => sum + rowHeight(row), 0);
  const px = space.x(540);
  const py = space.y(ANCHOR);
  const left = space.x(110);
  const boxes: WordBox[] = [];
  let top = py - height / 2;
  for (const row of rows) {
    const h = rowHeight(row);
    const order = rowVisualOrder(row.map((at) => cue.words[at]!.text), rtl ? "rtl" : "ltr").map((at) => row[at]!);
    const width = row.reduce((sum, at) => sum + measured[at]!.width, 0) + gap * (row.length - 1);
    let x = rtl ? left + maxWidth - width : left;
    // Inter Tight's baseline in a 1.06em line box; fallback ink can enlarge that box.
    const baseline = top + Math.max(...row.map((at) => Math.max(0.92285 * measured[at]!.size, -measured[at]!.m.inkTop)));
    for (const at of order) {
      const word = measured[at]!;
      boxes.push({ ...word, x, y: baseline, top, height: h });
      x += word.width + gap;
    }
    top += h;
  }

  const spokenEnd = Math.max(...cue.words.map((word) => word.endMs));
  const exitAt = Math.min(end, Math.max(end - 150, spokenEnd + 80));
  const squash = (t: number) => EASES.in(prog(t, exitAt, end - exitAt));
  const sx = (t: number) => 1 + 0.04 * squash(t);
  const sy = (t: number) => Math.max(0.02, 1 - squash(t));
  const sample = (fn: (t: number) => number, from: number, edges: readonly number[] = [], tolerance = 0.1): Frames =>
    sampleFrames(fn, [exitAt, end, ...edges], tolerance, { range: [from, end] });
  const position = (x: number, y: number, from: number) => ({
    x: sample((t) => px + (x - px) * sx(t), from),
    y: sample((t) => py + (y - py) * sy(t), from),
    sx: sample(sx, from, [], 0.001), sy: sample(sy, from, [], 0.001),
  });
  const pieces: Piece[] = [];
  for (const box of boxes) {
    const word = cue.words[box.at]!;
    const from = word.startMs - 80;
    if (from >= end) continue;
    const focus = Math.min(520, Math.max(1, end - from));
    const fade = Math.min(150, Math.max(1, word.startMs + Math.min(40, (word.endMs - word.startMs) / 3) - from));
    const room = rtl ? box.x - left : left + maxWidth + 10 * space.u - box.x - box.width;
    const extra = box.spacing === REST ? clamp(room / Math.max(1, [...word.text].length - 1) / box.size, 0, 0.34) : 0;
    const steps = extra > 0 ? SPACING_STEPS : [0];
    steps.forEach((share, step) => {
      const a = from + share * focus;
      const b = step === steps.length - 1 ? end : Math.min(end, from + steps[step + 1]! * focus);
      if (b <= a) return;
      const middle = step === steps.length - 1 ? 1 : (share + steps[step + 1]!) / 2;
      const spacing = box.spacing + extra * (1 - EASES.outExpo(middle));
      const advance = input.measure(word.text, box.face, box.size, spacing).advance;
      const x = rtl ? box.x + box.width - advance : box.x;
      pieces.push({
        id: `orbit:${number}:w${box.at}s${step}`, kind: "text", z: 2,
        fromMs: a, toMs: b, track: { ...position(x, box.y, a), o: sampleFrames((t) => EASES.out(prog(t, from, fade)), [from + fade], 0.003, { range: [a, b] }) },
        text: word.text, face: box.face, sizePx: box.size, letterSpacingEm: spacing,
        fill: input.colours.primary, anchor: "baseline-left", language: cue.language,
        shadows: [{ dx: 0, dy: 3 * space.u, blur: 8 * space.u, colour: input.colours.shadow, alpha: 0.55 }],
      });
    });
  }

  // Drawings are anchored by their top-left in libass. Keep the pivot at the path's original zero.
  const shape = (id: string, path: readonly PathCmd[], x: number, y: number, from: number, z: number, fill?: string, stroke?: ShapePiece["stroke"]) => {
    if (from >= end || paintedFrameCount(from + 1, end, input.fps) < 2) return null;
    const bounds = pathBounds(path);
    const moved = path.map((cmd): PathCmd => cmd[0] === "Z" ? cmd : cmd[0] === "C"
      ? ["C", cmd[1] - bounds.x1, cmd[2] - bounds.y1, cmd[3] - bounds.x1, cmd[4] - bounds.y1, cmd[5] - bounds.x1, cmd[6] - bounds.y1]
      : [cmd[0], cmd[1] - bounds.x1, cmd[2] - bounds.y1]);
    const piece: ShapePiece = { id: `orbit:${number}:${id}`, kind: "shape", z, fromMs: from, toMs: end, path: moved,
      origin: { dx: -bounds.x1, dy: -bounds.y1 }, track: position(x, y, from), ...(fill ? { fill: { colour: fill } } : {}), ...(stroke ? { stroke } : {}) };
    pieces.push(piece);
    return piece;
  };
  const u = space.u * fit;
  const hero = boxes.find((box) => cue.words[box.at]!.role === "hero");
  let sparkBase: number;
  let sparks: [number, number, number][];
  if (hero) {
    const hs = cue.words[hero.at]!.startMs;
    const cx = hero.x + hero.width / 2;
    const cy = hero.top + hero.height * 0.55;
    const rx = hero.width / 2 + 46 * u;
    const ry = hero.height / 2 + 22 * u;
    const tilt = (rtl ? 9 : -9) * Math.PI / 180;
    const rotate = (x: number, y: number): [number, number] => [x * Math.cos(tilt) - y * Math.sin(tilt), x * Math.sin(tilt) + y * Math.cos(tilt)];
    const path = ellipsePath(0, 0, rx, ry).map((cmd): PathCmd => cmd[0] === "Z" ? cmd : cmd[0] === "C"
      ? ["C", ...rotate(cmd[1], cmd[2]), ...rotate(cmd[3], cmd[4]), ...rotate(cmd[5], cmd[6])]
      : [cmd[0], ...rotate(cmd[1], cmd[2])]);
    const ring = shape("ring", path, cx, cy, hs + 60, 1, undefined, { widthPx: 3.5 * u, colour: input.colours.highlight });
    const wipeMs = Math.min(560, Math.max(1, end - hs - 60));
    const x1 = cx - rx - 10 * u;
    const x2 = cx + rx + 10 * u;
    if (ring) ring.clip = {
      x1: rtl ? sample((t) => x2 - (x2 - x1) * EASES.inOut(prog(t, hs + 60, wipeMs)), ring.fromMs, [hs + 60 + wipeMs]) : [[ring.fromMs, x1]],
      x2: rtl ? [[ring.fromMs, x2]] : sample((t) => x1 + (x2 - x1) * EASES.inOut(prog(t, hs + 60, wipeMs)), ring.fromMs, [hs + 60 + wipeMs]),
      y1: [[ring.fromMs, cy - rx - 20 * u]], y2: [[ring.fromMs, cy + rx + 20 * u]],
    };
    const planet = shape("planet", ellipsePath(0, 0, 9 * u), cx, cy, hs + 520, 1, input.colours.highlight);
    if (planet) {
      const planetAt = (t: number) => {
        const a = ((t - hs) / 5200) * Math.PI * 2 + Math.PI * 0.85;
        return rotate(Math.cos(a) * rx, Math.sin(a) * ry);
      };
      // Quarter-turn edges prevent a long hold from aliasing an entire revolution into a straight line.
      const edges = Array.from({ length: Math.ceil((end - hs) / 1300) + 1 }, (_, i) => hs + i * 1300);
      planet.track.x = sample((t) => px + (cx + planetAt(t)[0] - px) * sx(t), planet.fromMs, edges);
      planet.track.y = sample((t) => py + (cy + planetAt(t)[1] - py) * sy(t), planet.fromMs, edges);
      planet.track.o = sample((t) => EASES.out(prog(t, hs + 520, 200)), planet.fromMs, [hs + 720], 0.003);
    }
    const kind = heroNumber % 3;
    const size = [140, 150, 104][kind]! * u;
    const firstRow = hero.top < py - height / 2 + 10 * u;
    const stickerX = rtl ? Math.max(left + size * 0.42, hero.x - 6 * u) : Math.min(left + maxWidth - size * 0.42, firstRow ? hero.x + hero.width + 6 * u : cx + rx * 0.72);
    const stickerY = firstRow ? hero.top - size * 0.1 : cy + ry * 0.92;
    const r = size / 120;
    const stickerFrom = hs + 140;
    const sticker = shape("sticker", kind === 0 ? starPath(16, 58 * r, 42 * r) : ellipsePath(0, 0, (kind === 1 ? 58 : 56) * r, (kind === 1 ? 30 : 56) * r), stickerX, stickerY, stickerFrom, 1,
      [input.colours.highlight, "#F6E926", "#39E75F"][kind]);
    const stickerPieces = sticker ? [sticker] : [];
    const ink = (id: string, p: PathCmd[]) => {
      const piece = shape(id, p, stickerX, stickerY, stickerFrom, 1, undefined, { widthPx: (kind === 1 ? 3.5 : 3) * r, colour: INK });
      if (piece) stickerPieces.push(piece);
    };
    if (sticker) {
      if (kind === 0) ink("sticker-eye", ellipsePath(0, 0, 14 * r));
      else if (kind === 1) {
        ink("sticker-line0", polylinePath([[-26 * r, -4 * r], [26 * r, -4 * r]]));
        ink("sticker-line1", polylinePath([[-16 * r, 8 * r], [16 * r, 8 * r]]));
      } else {
        // Round dots reproduce the sample's dashed circle without a renderer-specific dash primitive.
        for (let i = 0; i < 24; i++) {
          const a = i * Math.PI / 12;
          const dot = shape(`sticker-dot${i}`, ellipsePath(Math.cos(a) * 42 * r, Math.sin(a) * 42 * r, 1.5 * r), stickerX, stickerY, stickerFrom, 1, INK);
          if (dot) stickerPieces.push(dot);
        }
      }
      const duration = Math.min(320, Math.max(1, end - stickerFrom));
      const pop = (t: number) => { const p = prog(t, stickerFrom, duration) - 1; return Math.max(0, 1 + 2.5 * p ** 3 + 1.5 * p ** 2); };
      for (const piece of stickerPieces) {
        piece.track.sx = sample((t) => pop(t) * sx(t), stickerFrom, [stickerFrom + duration * 0.6, stickerFrom + duration], 0.002);
        piece.track.sy = sample((t) => pop(t) * sy(t), stickerFrom, [stickerFrom + duration * 0.6, stickerFrom + duration], 0.002);
        piece.track.rz = sample((t) => (1 - pop(t)) * -110 + (kind === 1 ? -16 : 0), stickerFrom, [stickerFrom + duration * 0.6, stickerFrom + duration]);
      }
    }
    sparkBase = hs + 120;
    sparks = [[cx - rx + 8 * u, cy + ry * 0.55, 20 * u], [cx + rx * 0.55, cy + ry + 6 * u, 12 * u]];
  } else {
    const last = boxes.find((box) => box.at === cue.words.length - 1)!;
    const x = rtl ? Math.max(left + 20 * u, last.x - 34 * u) : Math.min(left + maxWidth - 20 * u, last.x + last.width + 34 * u);
    sparkBase = cue.words.at(-1)!.startMs + 120;
    sparks = [[x, last.top + BODY * u * 0.22, 22 * u], [x + (rtl ? -30 : 30) * u, last.top + BODY * u * 0.62, 13 * u]];
  }
  sparks.forEach(([x, y, radius], i) => {
    const k = radius * 0.18;
    const path: PathCmd[] = [["M", 0, -radius], ["C", k, -k, k, -k, radius, 0], ["C", k, k, k, k, 0, radius], ["C", -k, k, -k, k, -radius, 0], ["C", -k, -k, -k, -k, 0, -radius], ["Z"]];
    const from = sparkBase + (hero ? 200 + i * 100 : i * 90);
    const piece = shape(`spark${i}`, path, x, y, from, 3, input.colours.accent);
    if (!piece) return;
    const duration = Math.min(380, end - from);
    const pop = (t: number) => Math.max(0, EASES.spring(prog(t, from, duration)));
    const edges = [from + duration * 0.25, from + duration * 0.5, from + duration];
    piece.track.sx = sample((t) => pop(t) * sx(t), from, edges, 0.002);
    piece.track.sy = sample((t) => pop(t) * sy(t), from, edges, 0.002);
    piece.track.rz = sample((t) => (1 - pop(t)) * 90, from, edges);
  });
  // The shared union samples every 16 ms; leave room for a step edge or the squash's final frame.
  const margin = 12 * space.u;
  return clampToSafeArea(pieces, { x1: space.safe.x1 + margin, y1: space.safe.y1 + margin, x2: space.safe.x2 - margin, y2: space.safe.y2 - margin }, input.measure);
}

export const orbitProgram: SceneProgram = {
  build(input) {
    let heroNumber = 0;
    return { pieces: input.cues.flatMap((cue, number) => {
      const hero = cue.words.some((word) => word.role === "hero");
      return buildCue(cue, number, hero ? heroNumber++ : heroNumber, Math.min(cue.endMs, input.cues[number + 1]?.startMs ?? cue.endMs), input);
    }) };
  },
};
