import type { DemoScript } from "../demo";
import { clamp, EASES, prog } from "../ease";
import { paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import { evaluatePiece, mixColour, type Piece, pieceLocalBox, SCENE_PERSPECTIVE_PX, type TextPiece } from "../scene";
import { caps, galleryScene, rectClip, rotatePoint } from "./gallery-layout";
import type { SpeechCell } from "./speech-layout";

export const BARREL_DEMO: DemoScript = {
  lines: ["never:b stop:b learning:h@660", "even:m when:m it's:m boring:b", "especially:b then:b", "one:b percent:b better:h@640 every:b day:b", "that's:m how:m you:m win:h@580"],
  options: { rate: 305, cueGap: 140, tail: 480, lead: 380 },
};

export const barrelProgram = galleryScene("barrel", 1290, (ctx) => {
  const { cue, index, from, to } = ctx.window;
  const c = ctx.input.colours;
  const u = ctx.space.u;
  const cx = ctx.space.x(540);
  const cy = ctx.space.y(1290);
  const face = "Archivo Black";
  const outlineWidth = 3 * u;
  const words = cue.words.map((word, at) => {
    const previous = cue.words[at - 1];
    const lead = previous ? clamp((word.startMs - previous.startMs) / 2, 0, 90) : 60;
    return { word, text: caps(word, cue), entry: ctx.enter(word, at === 0 ? 220 : 200, lead) };
  });
  const tilt = (index % 2 ? 1.6 : -2.2) * ctx.side;
  const [cos, sin] = rotatePoint(1, 0, tilt);
  const clip = rectClip(from, { x1: cx - 430 * u, x2: cx + 430 * u, y1: cy - 265 * u, y2: cy + 250 * u });
  const drum = ctx.rect("drum", from, cx, cy, 900 * u, 560 * u, 34 * u, c.accent, { rz: [[from, tilt]] });
  drum.fill = { colour: c.accent, alpha: 0.93 };
  const pieces: Piece[] = [drum];
  const spoken: TextPiece[] = [];
  const echoes: TextPiece[] = [];
  const previews: TextPiece[] = [];
  for (const [j, side] of [-1, 1].entries()) {
    const y = 98 * u * side;
    pieces.push(ctx.rect(`rule${j}`, from, cx - y * sin, cy + y * cos, 812 * u, 4 * u, 0, "#2C2C2C", { rz: [[from, tilt]] }));
  }
  // Short speech compresses the roll to fit before the next one starts.
  const rolls = words.map(({ word, entry }, i) => {
    // A cue with no lead joins the first roll in progress when the previous cue clears.
    const start = i === 0 ? Math.max(0, word.startMs - 60) : entry.from;
    return {
      from: start,
      to: entry.motion ? Math.min(entry.settled, start + (i === 0 ? 220 : 200), words[i + 1]?.entry.from ?? to) : entry.from,
    };
  });
  const pos = (t: number) => rolls.reduce((a, roll, i) =>
    a + (i === 0 ? 0.9 : 1) * EASES.out(prog(t, roll.from, roll.to - roll.from)), -0.9)
    + (ctx.exit ? 0.85 * EASES.in(prog(t, ctx.exitAt, to - ctx.exitAt)) : 0);
  const keys = [...rolls.flatMap((roll) => [roll.from, roll.to]), ctx.exitAt, to];
  const frames = (fn: (t: number) => number, a: number, b: number, error = 0.24) => sampleFrames(fn, keys, error, { range: [a, b] });
  const angle = (row: number, t: number) => clamp((row - pos(t)) * 52, -88, 88) * Math.PI / 180;
  const radius = 236;
  const camera = 1100;
  const cameraRatio = SCENE_PERSPECTIVE_PX / (camera * u);
  const rowScale = (row: number, t: number) => camera / (camera + radius * (1 - Math.cos(angle(row, t))));
  const rowY = (row: number, t: number) => radius * u * Math.sin(angle(row, t)) * rowScale(row, t);
  const pose = (row: number, a: number, b: number) => {
    const tiltComponent = (t: number) => cameraRatio * Math.sin(angle(row, t));
    const heightComponent = (t: number) => Math.cos(angle(row, t));
    return {
      x: frames((t) => cx - rowY(row, t) * sin, a, b),
      y: frames((t) => cy + rowY(row, t) * cos, a, b),
      sx: frames((t) => rowScale(row, t), a, b, 0.003),
      // Preserve both the demo's foreshortening and its perspective with the renderer's fixed camera.
      sy: frames((t) => Math.hypot(heightComponent(t), tiltComponent(t)) * rowScale(row, t), a, b, 0.003),
      rx: frames((t) => -Math.atan2(tiltComponent(t), heightComponent(t)) * 180 / Math.PI, a, b, 0.18),
      rz: [[a, tilt]] as const,
    };
  };
  const frontFacing = (row: number, t: number) => EASES.inOut(prog(88 - Math.abs(row - pos(t)) * 52, 0, 14));
  for (const [at, { word, text, entry }] of words.entries()) {
    const size = Math.min(156 * u, 780 * u / Math.max(0.1, ctx.input.measure(text, face, 100, -0.01).advance / 100));
    const m = ctx.input.measure(text, face, size, -0.01);
    const cell: SpeechCell = { at, face, text, spacing: -0.01, size, width: m.advance, x: cx, baseline: cy, inkTop: m.inkTop, inkBottom: m.inkBottom };
    const hero = word.role === "hero";
    const fill = hero ? c.highlight : c.primary;
    const next = words[at + 1];
    const exit = next?.word.role === "hero" ? next.entry.settled + 50 : words[at + 2]?.entry.from ?? to;
    const end = Math.min(to, Math.max(word.endMs + 150, exit));
    const previous = words[at - 1]?.entry.from ?? entry.from;
    const roll = pose(at, previous, end);
    const current = ctx.face(cell, entry.from, fill, roll);
    current.toMs = end;
    current.origin = { dx: 0, dy: (m.inkTop + m.inkBottom) / 2 };
    const solidEnd = Math.min(end, (words[at + 1]?.entry.settled ?? to) + 25);
    if (paintedFrameCount(entry.from, solidEnd, ctx.fps) >= 2) {
      const solid = { ...current, id: `${current.id}solid`, z: 6, toMs: solidEnd, stroke: { colour: fill, widthPx: 1.5 * u }, track: {
        ...current.track, o: frames((t) => clamp(1 - Math.abs(at - pos(t)) * 1.7) * evaluatePiece(current, t).o, entry.from, solidEnd, 0.008),
      } };
      if (hero) solid.shadows = [{ dx: 0, dy: 0, blur: 9 * u, colour: c.highlight, alpha: 0.42 }];
      current.fillAlpha = 0;
      current.stroke = { colour: hero ? c.highlight : "#8D8D8D", widthPx: 1.5 * u, alpha: 0.9 };
      current.z = 5;
      const foldedStroke = { ...current.stroke, widthPx: outlineWidth };
      const awayFromCenter = (t: number) => EASES.inOut(prog(Math.abs(at - pos(t)) * 52, 30, 12));
      // Reinforce the foreshortened outline without adding weight to the flat, filled word.
      pieces.push({ ...current, id: `${current.id}rim`, stroke: foldedStroke, track: {
        ...roll, o: frames((t) => awayFromCenter(t) * frontFacing(at, t) * evaluatePiece(current, t).o, entry.from, end, 0.008),
      } });
      pieces.push(solid);
      if (paintedFrameCount(previous, entry.from, ctx.fps) >= 2) {
        previews.push({ ...current, id: `${current.id}next`, fromMs: previous, toMs: entry.from, clip, stroke: foldedStroke,
          track: { ...roll, o: frames((t) => frontFacing(at, t) * clamp(Math.abs(at - pos(t)) * 1.7), previous, entry.from, 0.008) } });
      }
    }
    pieces.push(current);
    spoken.push(current);
    if (hero) {
      for (const [j, d] of [-2, -1, 1, 2].entries()) {
        const echoEnd = Math.min(to, next?.entry.settled ?? to);
        const echo = ctx.face(cell, entry.from, c.highlight, pose(at + d, entry.from, echoEnd));
        const opacity = frames((t) => clamp(1 - Math.abs(at - pos(t)) * 1.15) * frontFacing(at + d, t) * evaluatePiece(echo, t).o, entry.from, echoEnd, 0.008);
        echoes.push({ ...echo, id: `${ctx.id}:echo${at}-${j}`, clip, z: 4, fillAlpha: 0,
          toMs: echoEnd, track: { ...echo.track, o: opacity },
          origin: current.origin, stroke: { widthPx: outlineWidth, colour: c.highlight, alpha: Math.abs(d) === 2 ? 0.38 : 0.72 } });
      }
    }
  }
  // All text shares the drum's tilt. Compare ink along its vertical axis and reserve spoken rows first.
  const drumRow = (piece: TextPiece) => {
    const box = pieceLocalBox(piece, ctx.input.measure);
    const pivot = piece.origin?.dy ?? 0;
    return {
      piece,
      band(t: number) {
        const pose = evaluatePiece(piece, t);
        if (!pose.visible || pose.o <= 0.02) return null;
        const centre = (pose.y - cy) * cos - (pose.x - cx) * sin;
        const heightScale = pose.sy * Math.cos(pose.rx * Math.PI / 180);
        return [centre + (box.y1 - pivot) * heightScale, centre + (box.y2 - pivot) * heightScale] as const;
      },
    };
  };
  const occupied = spoken.map(drumRow);
  for (const piece of [...echoes, ...previews]) {
    const { band } = drumRow(piece);
    const blockers = occupied.filter(({ piece: other }) => other.fromMs < piece.toMs && piece.fromMs < other.toMs);
    const boundaries = blockers.flatMap(({ piece: other }) => [other.fromMs - 1, other.fromMs, other.toMs - 1, other.toMs]);
    const opacity = sampleFrames((t) => {
      const ink = band(t);
      if (!ink) return 0;
      let visible = evaluatePiece(piece, t).o;
      for (const other of blockers) {
        const blocked = other.band(t);
        if (!blocked) continue;
        const gap = Math.max(ink[0] - blocked[1], blocked[0] - ink[1]);
        visible = Math.min(visible, prog(gap, 2 * u, 10 * u));
      }
      return visible;
    }, [...keys, ...boundaries, ...(piece.track.o?.map(([t]) => t) ?? [])], 0.008,
    { range: [piece.fromMs, piece.toMs], simplify: true });
    const separated = { ...piece, track: { ...piece.track, o: opacity } };
    occupied.push(drumRow(separated));
    pieces.push(separated);
  }
  // Lay the expanding dots out as a centered row, using the same position as the words.
  const grey = "#454545";
  const dotY = 248 * u;
  const dotDistance = (at: number, t: number) => Math.abs(at - Math.min(words.length - 1, pos(t)));
  const extension = (at: number, t: number) => 30 * u * clamp(1 - dotDistance(at, t) * 1.4);
  const dotWidth = (at: number, t: number) => 12 * u + extension(at, t);
  const dotCentre = (at: number, t: number) => {
    let x = (at - (words.length - 1) / 2) * 10 * u;
    for (let i = 0; i < words.length; i++) {
      if (i !== at) x += dotWidth(i, t) / 2 * (i < at ? 1 : -1);
    }
    return x * ctx.side;
  };
  for (const at of words.keys()) {
    const colour = frames((t) => clamp((0.55 - dotDistance(at, t)) / 0.1), from, to, 0.005)
      .map(([t, amount]) => [t, mixColour(grey, c.highlight, amount)] as const);
    const placement = (cap: number) => {
      const x = (t: number) => dotCentre(at, t) + cap * extension(at, t) / 2;
      return {
        x: frames((t) => cx + x(t) * cos - dotY * sin, from, to, 0.12),
        y: frames((t) => cy + x(t) * sin + dotY * cos, from, to, 0.12),
        colour,
      };
    };
    pieces.push(ctx.rect(`dot${at}`, from, cx, cy, 30 * u, 12 * u, 0, grey, {
      ...placement(0), rz: [[from, tilt]], sx: frames((t) => Math.max(0.01, extension(at, t) / (30 * u)), from, to, 0.004),
    }));
    for (const cap of [-1, 1]) {
      const dot = ctx.dot(`dot${at}cap${cap}`, from, cx, cy, 6 * u, grey);
      pieces.push({ ...dot, track: { ...dot.track, ...placement(cap) } });
    }
  }
  return pieces;
});
