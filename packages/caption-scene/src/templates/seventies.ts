import { captionTextClusters } from "@narriflow/caption-fonts/caption-block";
import { captionColourContrast } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { EASES, type Frames, clamp, lerp, prog } from "../ease";
import { SCENE_DEFAULT_FPS, exportFrameAtOrBefore, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { cueDirection, fitScale, greedyRows, rowVisualOrder, rowWidth, sceneSpace, shiftPiece } from "../layout";
import type { Box, PathCmd, Piece, ShapePiece, TextPiece, Track } from "../scene";
import { ellipsePath, pathBounds, polygonPath, sparklePath } from "../shapes";

/**
 * Seventies (gallery 3, m30-seventies). Shrikhand types into a growing cream oval and the first hero
 * lands on a second sticker in DM Serif Display Italic. The four sample die cuts cycle by hero count.
 * Seeded tilts and two small print accents (sunburst and glint) recur on both hero and ordinary cues.
 * Body rows wrap from the measured speech. The oval grows around the visible rows, and fit includes
 * the turned sticker and its hard shadow. Joined scripts type and pop a word at a time, with mirrored
 * RTL layout. The fade waits for speech and yields its window to the next cue. Simultaneous cues stack.
 *
 * Real-cue fix (gallery review, 2026-11-25): the sticker sits `BADGE_DROP` under the oval so that its turned die cut (a few degrees of
 * tilt widen its box by a quarter of its width) never reaches the oval's words; it still tucks over the oval's lower rim.
 */
export const SEVENTIES_DEMO: DemoScript = {
  lines: [
    "this:m recipe:b changed:b my:m life:h@520",
    "three:b simple:b ingredients",
    "no:b oven:b needed:h@520",
    "just:m mix:b and:m smile:h@520",
    "grandma:b was:m right:h@520",
    "sunday:b dinner:b",
  ],
  options: { rate: 255, cueGap: 120 },
};

const ANCHOR = 1290;
const LEAD = 80;
const READ = 150;
const CREAM = "#FBEFE3";
const INK = "#3A1C13";
const CORAL = "#EF5849";
const GOLD = "#F4B33D";
const BODY_FACE = "Shrikhand";
const HERO_FACE = "DM Serif Display Italic";
const TRACKING = 0.005;
/** How far under the oval's centre line the sticker's centre sits, beyond the oval's half height and the sticker's own (sample px). */
const BADGE_DROP = 64;
const STICKERS = [
  { kind: "scallop", fill: GOLD, ink: "#8A2412" },
  { kind: "hexagon", fill: "#2E8C80", ink: CREAM },
  { kind: "tag", fill: CORAL, ink: CREAM },
  { kind: "scallop", fill: "#B9A0E8", ink: "#3A1A5E" },
] as const;

interface Placement {
  cue: SceneCue;
  from: number;
  end: number;
  spoken: number;
  hero: number;
  variant: number;
  lane: number;
}

interface Label {
  at: number;
  x: number;
  y: number;
  size: number;
}

interface Sticker {
  x: number;
  y: number;
  w: number;
  h: number;
  tilt: number;
}

const constant = (n: number): Frames => [[0, n]];
const soft = (p: number) => 0.4 * EASES.out(p) + 0.6 * EASES.spring(p);
const simple = (text: string) => /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{M}\p{N}\p{P}]+$/u.test(text);
const readableOn = (fill: string, on: string, fallback: string) => (captionColourContrast(fill, on) >= 3 ? fill : fallback);

function seeded(key: string): number {
  let hash = 0x811c9dc5;
  for (const ch of key) hash = Math.imul(hash ^ ch.codePointAt(0)!, 0x01000193);
  return (hash >>> 0) / 0x100000000;
}

function cutPath(kind: (typeof STICKERS)[number]["kind"], w: number, h: number, side: number): PathCmd[] {
  if (kind === "scallop") {
    return polygonPath(Array.from({ length: 84 }, (_, i) => {
      const angle = (i * Math.PI * 2) / 84;
      const edge = 1 + 0.065 * Math.cos(14 * angle);
      return [(w / 2) * (1 + Math.cos(angle) * edge), (h / 2) * (1 + Math.sin(angle) * edge)];
    }));
  }
  const cut = Math.min(w * 0.37, h * (kind === "tag" ? 0.5 : 0.46));
  const far = kind === "tag" ? 0 : cut;
  return polygonPath(([[0, h / 2], [cut, 0], [w - far, 0], [w, h / 2], [w - far, h], [cut, h]] as const)
    .map(([x, y]) => [side > 0 ? x : w - x, y]));
}

function makeLayout(plan: Placement, input: SceneInput, u: number, maxWidth: number) {
  const { cue, hero, variant } = plan;
  const space = sceneSpace(input, ANCHOR);
  const direction = cueDirection(cue);
  const side = direction === "rtl" ? -1 : 1;
  const seed = `${cue.index}:${cue.words.map((word) => word.text).join(" ")}`;
  const textWidth = Math.max(1, Math.min(620 * u, (maxWidth - 100 * u) / 1.38));
  const body = cue.words.flatMap((word, at) => {
    if (at === hero) return [];
    const nominal = input.measure(word.text, BODY_FACE, 76 * u, TRACKING);
    const size = 76 * u * fitScale(nominal.advance, textWidth);
    const measure = input.measure(word.text, BODY_FACE, size, TRACKING);
    return [{ at, size, measure, x: 0, y: 0 }];
  });
  const gap = input.measure(" ", BODY_FACE, 76 * u, TRACKING).advance;
  const widths = body.map(({ measure }) => measure.advance);
  const rows = greedyRows(widths, gap, textWidth).map((indices) => ({
    indices,
    w: rowWidth(widths, indices, gap),
    h: Math.max(76 * 1.08 * u, ...indices.map((i) => (body[i]!.measure.inkBottom - body[i]!.measure.inkTop) * 0.94 + 9 * u)),
  }));
  const tw = Math.max(0, ...rows.map((row) => row.w));
  const th = rows.reduce((height, row) => height + row.h, 0);
  const x = space.x(540) - (hero >= 0 && body.length ? 40 * u * side : 0);
  const y = space.y(hero >= 0 && body.length ? 1205 : ANCHOR);
  const oval: Sticker = { x, y, w: tw * 1.3 + 78 * u, h: th * 1.36 + 54 * u, tilt: side * ((variant % 2 === 0 ? -1 : 1) * (2 + 1.5 * seeded(`${seed}:oval`))) };
  let top = -th / 2;
  const positions = rows.map(({ indices, h, w }) => {
    let left = -w / 2;
    const order = rowVisualOrder(indices.map((i) => cue.words[body[i]!.at]!.text), direction);
    for (const index of order) {
      const item = body[indices[index]!]!;
      item.x = left;
      item.y = top + h / 2 - 0.94 * (item.measure.inkTop + item.measure.inkBottom) / 2;
      left += item.measure.advance + gap;
    }
    const row = { top, bottom: top + h, words: indices.map((index) => body[index]!) };
    top += h;
    return row;
  });
  const cut = STICKERS[variant % STICKERS.length]!;
  let label: Label | undefined;
  let badge: Sticker | undefined;
  if (hero >= 0) {
    const word = cue.words[hero]!;
    const nominal = input.measure(word.text, HERO_FACE, 150 * u, 0);
    const pad = cut.kind === "tag" ? 250 : 170;
    const room = Math.max(1, Math.min(730 * u, maxWidth - (pad + 95) * u));
    const size = 150 * u * fitScale(nominal.advance, room);
    const measure = input.measure(word.text, HERO_FACE, size, 0);
    const h = Math.max(size * (cut.kind === "scallop" ? 1.55 : 1.28), (measure.inkBottom - measure.inkTop) * 1.25 + 24 * u);
    const w = Math.max(h * 0.95, measure.advance + pad * u);
    const edge = w * 0.55 + 16 * u;
    badge = {
      x: clamp(body.length ? x + 120 * u * side : x, space.safe.x1 + edge, space.safe.x2 - edge),
      y: body.length ? y + oval.h / 2 + h * 0.23 + BADGE_DROP * u : y,
      w, h, tilt: side * ((variant % 2 === 0 ? -1 : 1) * (4 + 2.5 * seeded(`${seed}:badge`))),
    };
    label = { at: hero, x: -measure.advance / 2 + (cut.kind === "tag" ? h * 0.15 * side : 0), y: -(measure.inkTop + measure.inkBottom) / 2, size };
  }
  // Bounds include the largest pose, the cream edge, the offset shadow and the printed marks.
  const boundsFor = (sticker: Sticker, isBadge: boolean): Box => {
    const scallop = isBadge && cut.kind === "scallop" ? 1.065 : 1;
    const w = sticker.w * scallop / 2;
    const h = sticker.h * scallop / 2;
    const lean = Math.sin((Math.abs(sticker.tilt) + (isBadge ? 7 : 4)) * Math.PI / 180);
    const hx = (w + h * lean) * 1.065 + 25 * u;
    const hy = (h + w * lean) * 1.065 + 25 * u;
    return { x1: sticker.x - hx, y1: sticker.y - hy, x2: sticker.x + hx, y2: sticker.y + hy };
  };
  const bounds = [...(body.length ? [boundsFor(oval, false)] : []), ...(badge ? [boundsFor(badge, true)] : [])];
  const box = {
    x1: Math.min(...bounds.map((b) => b.x1)), y1: Math.min(...bounds.map((b) => b.y1)),
    x2: Math.max(...bounds.map((b) => b.x2)), y2: Math.max(...bounds.map((b) => b.y2)),
  };
  return { body, positions, oval, badge, label, cut, side, seed, box, u };
}

type Layout = ReturnType<typeof makeLayout>;

function fitLayout(plan: Placement, input: SceneInput, maxWidth: number, maxHeight: number): Layout {
  let layout = makeLayout(plan, input, sceneSpace(input, ANCHOR).u, maxWidth);
  for (let attempt = 0; attempt < 6; attempt++) {
    const { box, u } = layout;
    const fit = Math.min(fitScale(box.x2 - box.x1, maxWidth), fitScale(box.y2 - box.y1, maxHeight));
    if (fit >= 1) break;
    layout = makeLayout(plan, input, u * fit * 0.98, maxWidth);
  }
  return layout;
}

function buildCue(plan: Placement, layout: Layout, input: SceneInput): Piece[] {
  const { cue, from, end, spoken, variant } = plan;
  const { body, positions, oval, badge, label, cut, side, seed, u } = layout;
  const fps = input.fps ?? SCENE_DEFAULT_FPS;
  const accent = input.colours.accent;
  const coral = readableOn(input.colours.primary, accent, readableOn(CORAL, accent, captionColourContrast(INK, accent) >= 3 ? INK : CREAM));
  const branded = input.colours.highlight.toUpperCase() !== GOLD;
  const badgeFill = branded ? input.colours.highlight : cut.fill;
  const badgeInk = branded ? readableOn(INK, badgeFill, CREAM) : cut.ink;
  const pieces: Piece[] = [];
  const id = `seventies:${cue.index}:`;
  const exit = Math.max(spoken + READ, end - 130);
  const exitAt = paintedFrameCount(exit, end, fps) >= 2 ? exit : end;
  const leave = (t: number) => exitAt < end ? EASES.in(prog(t, exitAt, end - exitAt)) : 0;
  const fitWindow = (at: number, target: number) => target > at && paintedFrameCount(at, target + 1, fps) >= 2 ? target - at : 0;
  const startFor = (at: number) => Math.max(from, cue.words[at]!.startMs - LEAD);
  const wordLast = (at: number) => exportFrameAtOrBefore(cue.words[at]!.endMs - 1, fps);
  const shapeLives = (at: number) => paintedFrameCount(at, end, fps) >= 2;
  const frames = (fn: (t: number) => number, at: number, edges: readonly number[], tolerance = 0.1, to = end): Frames =>
    sampleFrames(fn, edges, tolerance, { range: [at, to], simplify: true });

  // A sticker's points share its pivot and ease. The body rectangle grows under the letters as they print.
  const motion = (sticker: Sticker, at: number, popMs: number, isBadge: boolean) => (t: number) => {
    const pop = popMs ? soft(prog(t, at, popMs)) : 1;
    const scale = (isBadge ? lerp(0.43, 1, pop) : lerp(0.54, 1, pop)) * (1 - leave(t) * 0.2);
    const rz = sticker.tilt + side * (isBadge ? -14 * (1 - clamp(pop)) - 5 * leave(t) : 4 * leave(t));
    const theta = rz * Math.PI / 180;
    return { scale, rz, cos: Math.cos(theta), sin: Math.sin(theta), opacity: 1 - leave(t) };
  };
  const pointTrack = (sticker: Sticker, pose: ReturnType<typeof motion>, x: (t: number) => number, y: (t: number) => number,
    sx: (t: number) => number, sy: (t: number) => number, at: number, edges: readonly number[], to = end): Track => {
    const marks = [...edges, exitAt];
    return {
      x: frames((t) => { const p = pose(t); return sticker.x + p.scale * (x(t) * p.cos - y(t) * p.sin); }, at, marks, 0.14, to),
      y: frames((t) => { const p = pose(t); return sticker.y + p.scale * (x(t) * p.sin + y(t) * p.cos); }, at, marks, 0.14, to),
      sx: frames((t) => pose(t).scale * sx(t), at, marks, 0.0015, to),
      sy: frames((t) => pose(t).scale * sy(t), at, marks, 0.0015, to),
      rz: frames((t) => pose(t).rz, at, marks, 0.05, to),
      o: frames((t) => pose(t).opacity, at, marks, 0.004, to),
    };
  };
  const addShape = (suffix: string, at: number, z: number, path: readonly PathCmd[], track: Track,
    finish: Pick<ShapePiece, "fill" | "stroke" | "shadows" | "origin">, to = end) => {
    if (paintedFrameCount(at, to, fps) < 2) return;
    // Libass aligns drawings from their bounding box. Rebase the scallops and
    // corner marks to that box, keeping the same sticker pivot in both painters.
    const { x1, y1 } = pathBounds(path);
    const local = path.map((cmd): PathCmd => {
      if (cmd[0] === "Z") return cmd;
      if (cmd[0] === "C") return ["C", cmd[1] - x1, cmd[2] - y1, cmd[3] - x1, cmd[4] - y1, cmd[5] - x1, cmd[6] - y1];
      return [cmd[0], cmd[1] - x1, cmd[2] - y1];
    });
    const origin = { dx: (finish.origin?.dx ?? 0) - x1, dy: (finish.origin?.dy ?? 0) - y1 };
    pieces.push({ id: `${id}${suffix}`, kind: "shape", fromMs: at, toMs: to, z, path: local, track, ...finish, origin });
  };

  // The sunburst is printed above the leading letters. A loose diamond flashes near the trailing edge.
  const accents = (sticker: Sticker, pose: ReturnType<typeof motion>, at: number, popEnd: number, beat: number, z: number,
    wAt: (t: number) => number, hAt: (t: number) => number, xAt: (t: number) => number, yAt: (t: number) => number,
    edges: readonly number[], ink: string, light: string) => {
    const drift = seeded(`${seed}:marks`) * 0.12;
    const markLength = (variant % 2 === 0 ? 13 : 17) * u;
    const ray = polygonPath([[-markLength, 3 * u], [-6 * u, -2 * u], [-10 * u, -9 * u], [0, -5 * u], [8 * u, -11 * u], [6 * u, -2 * u], [markLength, 3 * u], [0, 0]]);
    const mark = (suffix: string, start: number, width: number, path: PathCmd[], colour: string, trailing: boolean) => {
      const to = Math.min(exitAt, start + (trailing ? 290 : 340));
      if (paintedFrameCount(start, to, fps) < 2) return;
      const pulseEnd = Math.min(start + 125, to);
      const pulse = (t: number) => lerp(0.52, 1, soft(prog(t, start, pulseEnd - start)));
      const ySign = trailing ? 1 : -1;
      const track = pointTrack(sticker, pose,
        (t) => xAt(t) + side * ySign * wAt(t) * (0.16 + drift),
        (t) => yAt(t) + ySign * hAt(t) * width,
        pulse, pulse, start, [...edges, popEnd, pulseEnd], to);
      track.o = [[start, 0.9], [pulseEnd, 1, "out"], [to, 0.25, "in"]];
      addShape(suffix, start, z, path, track, { fill: { colour } }, to);
    };
    mark("sunburst", at, 0.365, ray, ink, false);
    mark("glint", beat, 0.38, sparklePath((variant % 2 === 0 ? 14 : 11) * u, 0, 0, 0.25), light, true);
  };

  if (body.length) {
    const at = Math.min(...body.map(({ at }) => startFor(at)));
    const popMs = fitWindow(at, Math.min(at + 230, wordLast(body[0]!.at)));
    const pose = motion(oval, at, popMs, false);
    const typing = body.map((item) => {
      const start = startFor(item.at);
      const count = simple(cue.words[item.at]!.text) ? captionTextClusters(cue.words[item.at]!.text).length : 1;
      const duration = count > 1 ? fitWindow(start, Math.min(start + 225, wordLast(item.at))) : 0;
      const n = duration ? Math.min(count, Math.max(2, paintedFrameCount(start, start + duration + 1, fps))) : 1;
      const steps = Array.from({ length: n - 1 }, (_, i) => Math.round(start + ((i + 1) * duration) / n));
      return { start, steps, fraction: (t: number) => (1 + steps.filter((step) => t >= step).length) / n };
    });
    const show = new Map(body.map((item, i) => [item.at, typing[i]!]));
    const ovalAt = (t: number) => {
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (const row of positions) {
        for (const word of row.words) {
          const type = show.get(word.at)!;
          if (t < type.start) continue;
          const width = word.measure.advance;
          const shown = width * type.fraction(t);
          left = Math.min(left, word.x + (side === 1 ? 0 : width - shown));
          right = Math.max(right, word.x + (side === 1 ? shown : width));
          top = Math.min(top, row.top);
          bottom = Math.max(bottom, row.bottom);
        }
      }
      return { x: (left + right) / 2, y: (top + bottom) / 2, w: (right - left) * 1.3 + 78 * u, h: (bottom - top) * 1.36 + 54 * u };
    };
    const edges = [at + popMs, ...typing.flatMap(({ start, steps }) => [start, ...steps].flatMap((t) => [t - 1, t]))];
    const canDraw = shapeLives(at);
    if (canDraw) {
      const bodyPath = ellipsePath(oval.w / 2, oval.h / 2, oval.w / 2, oval.h / 2);
      const track = pointTrack(oval, pose, (t) => ovalAt(t).x, (t) => ovalAt(t).y, (t) => ovalAt(t).w / oval.w, (t) => ovalAt(t).h / oval.h, at, edges);
      addShape("oval", at, 0, bodyPath, track, {
        origin: { dx: oval.w / 2, dy: oval.h / 2 },
        fill: { colour: accent }, stroke: { colour: coral, widthPx: 5 * u },
        shadows: [{ dx: 8 * u * side, dy: 10 * u, blur: 0, colour: INK, alpha: 1 }],
      });
      const beat = label ? Math.max(at, startFor(label.at)) : Math.min(at + 240, end - 65);
      accents(oval, pose, at, at + popMs, Math.max(at, beat), 1,
        (t) => ovalAt(t).w, (t) => ovalAt(t).h, (t) => ovalAt(t).x, (t) => ovalAt(t).y, edges, coral, coral);
    }
    for (const word of body) {
      const type = show.get(word.at)!;
      const track = pointTrack(oval, pose, () => word.x, () => word.y, () => 1, () => 0.94, type.start, [at + popMs]);
      const piece: TextPiece = {
        kind: "text", id: `${id}w${word.at}`, fromMs: type.start, toMs: end, z: 2, track,
        text: cue.words[word.at]!.text, face: BODY_FACE, sizePx: word.size, letterSpacingEm: TRACKING, fill: canDraw ? coral : CREAM,
        anchor: "baseline-left", language: cue.language,
        ...(!canDraw ? { stroke: { colour: INK, widthPx: 2 * u } } : {}),
      };
      if (canDraw && type.steps.length) {
        const edge = (t: number) => {
          const fraction = type.fraction(t);
          const p = pose(t);
          const localX = word.x + word.measure.advance * (side === 1 ? fraction : 1 - fraction);
          const localY = word.y + 0.47 * (word.measure.inkBottom + word.measure.inkTop);
          return oval.x + p.scale * (localX * p.cos - localY * p.sin) + (fraction === 1 ? 0.28 * word.size * side : 0);
        };
        const moving = frames(edge, type.start, [...type.steps.flatMap((t) => [t - 1, t]), at + popMs, exitAt]);
        const open = input.canvas.width * 2;
        piece.clip = { x1: side === 1 ? constant(-open) : moving, x2: side === 1 ? moving : constant(open), y1: constant(-open), y2: constant(open) };
      }
      pieces.push(piece);
    }
  }

  if (badge && label) {
    const at = startFor(label.at);
    const last = wordLast(label.at);
    const popMs = fitWindow(at, Math.min(at + 270, last));
    const pose = motion(badge, at, popMs, true);
    const edges = [at + popMs];
    const still = () => 0;
    const natural = () => 1;
    const canDraw = shapeLives(at);
    if (canDraw) {
      const track = pointTrack(badge, pose, still, still, natural, natural, at, edges);
      const w = badge.w;
      const h = badge.h;
      const origin = { dx: w / 2, dy: h / 2 };
      const shape = cutPath(cut.kind, w, h, side);
      // The cream die-cut border sits beneath the solid face. An expanded fill draws its hard shadow in one layer.
      addShape("diecut", at, 3, cutPath(cut.kind, w + 16 * u, h + 16 * u, side), track, {
        origin: { dx: origin.dx + 8 * u, dy: origin.dy + 8 * u }, fill: { colour: accent },
        shadows: [{ dx: 8 * u * side, dy: 10 * u, blur: 0, colour: INK, alpha: 1 }],
      });
      addShape(`badge-${cut.kind}`, at, 4, shape, track, { fill: { colour: badgeFill }, origin });
      const rimInset = 13 * u;
      addShape("keyline", at, 5, cutPath(cut.kind, w - 2 * rimInset, h - 2 * rimInset, side), track, {
        origin: { dx: origin.dx - rimInset * (cut.kind === "tag" ? 1 + side : 1), dy: origin.dy - rimInset },
        stroke: { colour: badgeInk, widthPx: 2.5 * u, alpha: 0.35 },
      });
      if (cut.kind === "tag") {
        const x = side * (-w / 2 + h * 0.39);
        const hole = pointTrack(badge, pose, () => x, still, natural, natural, at, edges);
        addShape("tag-hole", at, 5, ellipsePath(0, 0, 12 * u), hole, { fill: { colour: accent }, stroke: { colour: INK, widthPx: 2 * u } });
      }
      if (!body.length) accents(badge, pose, at, at + popMs, Math.min(at + 90, Math.max(at, end - 65)), 5,
        () => w, () => h, still, still, edges, badgeInk, badgeInk);
    }
    const word = cue.words[label.at]!;
    const clusters = simple(word.text) ? captionTextClusters(word.text) : [word.text];
    // Long words still print in chunks. Joined text and emoji stay in one shaped piece.
    const chunk = Math.ceil(clusters.length / 12);
    const parts = Array.from({ length: Math.ceil(clusters.length / chunk) }, (_, i) => {
      const text = clusters.slice(i * chunk, (i + 1) * chunk).join("");
      const previous = clusters.slice(0, i * chunk).join("");
      const advance = input.measure(text, HERO_FACE, label.size, 0).advance;
      const x = previous ? input.measure(previous + text, HERO_FACE, label.size, 0).advance - advance : 0;
      return { text, x: label.x + x, advance };
    });
    const stagger = Math.max(0, Math.min(30, 120 / parts.length, (last - at) / (parts.length * 2)));
    const layers = side === 1 ? parts : [...parts].reverse();
    layers.forEach((part, i) => {
      const start = Math.round(at + i * stagger);
      const duration = fitWindow(start, Math.min(start + 240, last));
      const scale = (t: number) => duration ? lerp(0.5, 1, soft(prog(t, start, duration))) : 1;
      const dx = part.advance / 2;
      const dy = label.size * 0.14;
      pieces.push({ id: `${id}w${label.at}${parts.length === 1 ? "" : `l${i}`}`, kind: "text", z: 6, fromMs: start, toMs: end,
        track: pointTrack(badge, pose, () => part.x + dx, () => label.y + dy, scale, scale, start, [...edges, start + duration]),
        origin: { dx, dy }, text: part.text, face: HERO_FACE, sizePx: label.size, letterSpacingEm: 0,
        fill: canDraw ? badgeInk : CREAM, anchor: "baseline-left", language: cue.language,
        ...(canDraw ? {} : { stroke: { colour: INK, widthPx: 2 * u } }),
      });
    });
  }
  return pieces;
}

export const seventiesProgram: SceneProgram = {
  build(input) {
    const space = sceneSpace(input, ANCHOR);
    const width = space.safe.x2 - space.safe.x1;
    const height = space.safe.y2 - space.safe.y1;
    let spoken = -Infinity;
    let heroes = 0;
    let plain = 0;
    const plans: Placement[] = input.cues.filter((cue) => cue.words.length).map((cue) => {
      const start = cue.words[0]!.startMs;
      const from = Math.max(0, start - LEAD, spoken <= start ? Math.min(start, spoken + READ) : -Infinity);
      const last = Math.max(...cue.words.map((word) => word.endMs));
      spoken = Math.max(spoken, last);
      const hero = cue.words.findIndex((word) => word.role === "hero");
      return { cue, from, end: Math.max(last, cue.endMs), spoken: last, hero, variant: hero < 0 ? plain++ : heroes++, lane: 0 };
    });
    for (const [i, plan] of plans.entries()) {
      // An incoming cue with room for a lead takes over before its spoken start. Overlapping speech gets a lane.
      for (let j = i + 1; j < plans.length; j++) {
        const next = plans[j]!;
        if (next.cue.words[0]!.startMs < plan.spoken) continue;
        plan.end = Math.max(plan.spoken, Math.min(plan.end, next.from));
        break;
      }
    }

    const groups: { plans: Placement[]; release: number[]; end: number }[] = [];
    for (const plan of [...plans].sort((a, b) => a.from - b.from)) {
      let group = groups.at(-1);
      if (!group || plan.from >= group.end) {
        group = { plans: [], release: [], end: plan.end };
        groups.push(group);
      }
      const free = group.release.findIndex((end) => end <= plan.from);
      plan.lane = free < 0 ? group.release.length : free;
      group.release[plan.lane] = plan.end;
      group.end = Math.max(group.end, plan.end);
      group.plans.push(plan);
    }

    const pieces: Piece[] = [];
    for (const group of groups) {
      const lanes = group.release.length;
      const gap = Math.min(15 * space.u, height / (3 * lanes));
      const laneHeight = (height - gap * (lanes - 1)) / lanes;
      const layouts = group.plans.map((plan) => fitLayout(plan, input, width - 36 * space.u, laneHeight));
      const heights = group.release.map((_, lane) => Math.max(...group.plans.flatMap((plan, i) => plan.lane === lane ? [layouts[i]!.box.y2 - layouts[i]!.box.y1] : [])));
      const stack = heights.reduce((sum, h) => sum + h, gap * (lanes - 1));
      const bottom = clamp(layouts[0]!.box.y2, space.safe.y1 + stack, space.safe.y2);
      const laneBottom = heights.map((_, i) => bottom - heights.slice(0, i).reduce((sum, h) => sum + h + gap, 0));
      group.plans.forEach((plan, i) => {
        const layout = layouts[i]!;
        const { box } = layout;
        const dx = clamp(0, space.safe.x1 - box.x1, space.safe.x2 - box.x2);
        const dy = lanes > 1 ? laneBottom[plan.lane]! - box.y2 : clamp(0, space.safe.y1 - box.y1, space.safe.y2 - box.y2);
        for (const piece of buildCue(plan, layout, input)) pieces.push(dx || dy ? shiftPiece(piece, dx, dy) : piece);
      });
    }
    return { pieces };
  },
};
