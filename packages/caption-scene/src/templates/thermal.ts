import { captionTextClusters } from "@narriflow/caption-fonts/caption-block";
import type { DemoScript } from "../demo";
import type { Frames } from "../ease";
import { SCENE_DEFAULT_FPS, exportFrameAtOrBefore, paintedFrameCount } from "../frame-grid";
import type { SceneCue, SceneInput, SceneProgram } from "../input";
import { type SceneSpace, cueDirection, fitScale, greedyRows, rowVisualOrder, sceneSpace } from "../layout";
import { type Box, type ColourFrames, type Piece, SCENE_PIECE_BUDGET, type ShapePiece, type TextPiece, mixColour } from "../scene";
import { centredRect } from "../shapes";

/**
 * Thermal (m31-thermal.js). Inter Tight Bold heats from blue through orange to a white core.
 * Hero letters sweep in and hold an amber-orange halo. One colour-changing halo replaces the
 * sample's three animated copies. Ordinary words cool to a faint blue fringe, with a wider static
 * blue fringe behind each whole hero once the letters land.
 * Rows wrap and fit the safe area. Simultaneous speakers stack, entrances compress around speech,
 * and cooling only uses spare tail time. Joined scripts stay whole and the sweep follows cue direction.
 * An ignition streak and a rising ember recur on both hero and plain cues, with seeded changes in
 * position and a counter that swaps the accent temperature.
 */
export const THERMAL_DEMO: DemoScript = {
  lines: [
    "turn:b up:m the:m heat:h@520",
    "stay:b cool:b under:m pressure",
    "the:m best:b ideas:b come:b at:m night:h@560",
    "burn:b brighter:h@560",
    "don't:b cool:b down",
  ],
  options: { rate: 270, cueGap: 140 },
};

const ANCHOR = 1290;
const FACE = "Inter Tight Bold";
const BODY = 124;
const HERO_BODY = 112;
const HERO = 250;
const TRACKING = -0.025;
const LEAD = 95;
const READ_MS = 150;
const AMBER = "#FFC24A";
const SIMPLE_WORD = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{M}\p{P}0-9]+$/u;
const SIMPLE_LETTER = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u;

interface WordBox {
  at: number;
  text: string;
  hero: boolean;
  size: number;
  spacing: number;
  simple: boolean;
  width: number;
  above: number;
  below: number;
  x: number;
  y: number;
}

interface CueLayout {
  words: WordBox[];
  width: number;
  height: number;
  padding: number;
  rtl: boolean;
}

interface CuePlan {
  cue: SceneCue;
  number: number;
  first: number;
  last: number;
  from: number;
  end: number;
  layout: CueLayout;
  box: Box;
}

function layoutCue(cue: SceneCue, input: SceneInput, space: SceneSpace, heightLimit: number): CueLayout {
  const { safe, u } = space;
  const direction = cueDirection(cue);
  const availableWidth = safe.x2 - safe.x1;
  const hasHero = cue.words.some((word) => word.role === "hero");

  function measureRows(scale: number) {
    const unit = u * scale;
    const padding = Math.min(36 * unit, availableWidth * 0.14, heightLimit * 0.19);
    const maxWidth = Math.min(900 * unit, availableWidth - 2 * padding);
    const bodySize = hasHero ? HERO_BODY : BODY;
    const gap = (hasHero ? 30 : 32) * unit;
    const words = cue.words.map((word, at): WordBox => {
      const hero = word.role === "hero";
      const simple = SIMPLE_WORD.test(word.text) && SIMPLE_LETTER.test(word.text);
      const spacing = simple ? TRACKING : 0;
      const nominal = (hero ? HERO : bodySize) * unit;
      const widthLimit = hero ? Math.min(860 * unit, maxWidth) : maxWidth;
      const size = nominal * fitScale(input.measure(word.text, FACE, nominal, spacing).advance, widthLimit);
      const metrics = input.measure(word.text, FACE, size, spacing);
      return {
        at, text: word.text, hero, size, spacing, simple,
        width: Math.max(1, metrics.advance),
        above: Math.max(size * 0.903, -metrics.inkTop),
        below: Math.max(size * 0.117, metrics.inkBottom),
        x: 0, y: 0,
      };
    });

    const rows: WordBox[][] = [];
    let runStart = 0;
    for (const [at, word] of words.entries()) {
      if (!word.hero) continue;
      wrapBody(runStart, at);
      rows.push([word]);
      runStart = at + 1;
    }
    wrapBody(runStart, words.length);
    function wrapBody(from: number, to: number) {
      const run = words.slice(from, to);
      for (const row of greedyRows(run.map((word) => word.width), gap, maxWidth)) {
        rows.push(row.map((at) => run[at]!));
      }
    }

    let width = 0;
    let top = padding;
    for (const row of rows) {
      const rowW = row.reduce((sum, word) => sum + word.width, gap * (row.length - 1));
      const above = Math.max(...row.map((word) => word.above));
      const below = Math.max(...row.map((word) => word.below));
      width = Math.max(width, rowW);
      let x = -rowW / 2;
      for (const index of rowVisualOrder(row.map((word) => word.text), direction)) {
        const word = row[index]!;
        word.x = x;
        word.y = top + above;
        x += word.width + gap;
      }
      top += above + below;
    }
    return { words, width: width + 2 * padding, height: top + padding, padding, rtl: direction === "rtl" };
  }

  let scale = 1;
  let layout = measureRows(scale);
  while (layout.height > heightLimit + 0.01) {
    scale *= heightLimit / layout.height;
    layout = measureRows(scale);
  }
  return layout;
}

/** Reserve separate rows for the whole time that speakers are simultaneously active. */
function planCues(input: SceneInput, space: SceneSpace): CuePlan[] {
  const speech = input.cues.flatMap((cue, number) => cue.words.length ? [{
    cue, number,
    first: Math.min(...cue.words.map((word) => word.startMs)),
    last: Math.max(...cue.words.map((word) => word.endMs)),
  }] : []);
  const { safe } = space;
  const plans: CuePlan[] = [];
  for (let at = 0; at < speech.length;) {
    const groupStart = at;
    let groupEnd = speech[at]!.last;
    const laneEnds: number[] = [];
    const lanes: number[] = [];
    do {
      const { first, last } = speech[at]!;
      const free = laneEnds.findIndex((end) => end <= first);
      const lane = free < 0 ? laneEnds.length : free;
      laneEnds[lane] = last;
      lanes.push(lane);
      groupEnd = Math.max(groupEnd, last);
      at++;
    } while (at < speech.length && speech[at]!.first < groupEnd);

    const safeHeight = safe.y2 - safe.y1;
    const gutter = Math.min(10 * space.u, safeHeight / (4 * laneEnds.length));
    const limit = (safeHeight - gutter * (laneEnds.length - 1)) / laneEnds.length;
    const group = speech.slice(groupStart, at);
    const layouts = group.map(({ cue }) => layoutCue(cue, input, space, limit));
    const heights = laneEnds.map(() => 0);
    layouts.forEach((layout, i) => {
      const lane = lanes[i]!;
      heights[lane] = Math.max(heights[lane]!, layout.height);
    });
    const total = heights.reduce((sum, height) => sum + height, gutter * (heights.length - 1));
    let top = Math.max(safe.y1, Math.min(space.y(ANCHOR) - heights[0]! / 2, safe.y2 - total));
    const centers = heights.map((height) => {
      const center = top + height / 2;
      top += height + gutter;
      return center;
    });
    for (const [i, item] of group.entries()) {
      const layout = layouts[i]!;
      const x1 = Math.max(safe.x1, Math.min(space.x(540) - layout.width / 2, safe.x2 - layout.width));
      const y1 = centers[lanes[i]!]! - layout.height / 2;
      const box = { x1, y1, x2: x1 + layout.width, y2: y1 + layout.height };
      plans.push({ ...item, layout, box, from: Math.max(0, item.first - LEAD), end: Math.max(item.last, item.cue.endMs) });
    }
  }

  let active: CuePlan[] = [];
  for (const plan of plans) {
    active = active.filter((previous) => previous.end > plan.from);
    const { box } = plan;
    const collisions = active.filter(({ box: previous }) =>
      previous.x1 < box.x2 && previous.x2 > box.x1 && previous.y1 < box.y2 && previous.y2 > box.y1,
    );
    for (const previous of collisions) plan.from = Math.max(plan.from, Math.min(plan.first, previous.last + READ_MS));
    for (const previous of collisions) previous.end = Math.min(previous.end, plan.from);
    active.push(plan);
  }
  return plans;
}

function heatText(plan: CuePlan, input: SceneInput, fps: number, exit: number): Piece[] {
  const { cue, layout, box, from, end, number } = plan;
  const { primary, highlight, accent } = input.colours;
  const center = (box.x1 + box.x2) / 2;
  const words = layout.words;
  const heroCount = words.filter((word) => word.hero).length;
  let extraParts = Math.max(0, Math.floor((SCENE_PIECE_BUDGET - 2 - heroCount) / 2) - words.length);
  const hotColour = mixColour(highlight, AMBER, 0.24);

  return words.flatMap((wordBox): TextPiece[] => {
    const { at, text, hero, size, spacing, simple } = wordBox;
    const word = cue.words[at]!;
    const start = Math.max(from, word.startMs - LEAD);
    const faceStart = Math.max(start, word.startMs - 30);
    const lastFrame = exportFrameAtOrBefore(Math.ceil(word.endMs) - 1, fps);
    const land = Math.max(faceStart, Math.min(word.startMs + 82, lastFrame));
    const clusters = hero && simple ? captionTextClusters(text) : [text];
    // Keep the heat wave on very long words without spending two pieces per letter.
    const partCount = Math.min(clusters.length, 18, 1 + extraParts);
    const step = Math.ceil(clusters.length / partCount);
    const parts = Array.from({ length: Math.ceil(clusters.length / step) }, (_, part) => {
      const offset = part * step;
      const text = clusters.slice(offset, offset + step).join("");
      const prefix = clusters.slice(0, offset).join("");
      const advance = prefix ? input.measure(prefix + text, FACE, size, spacing).advance - input.measure(text, FACE, size, spacing).advance : 0;
      return { text, advance };
    });
    extraParts -= parts.length - 1;
    if (layout.rtl) parts.reverse();
    const sweep = Math.min((parts.length - 1) * 16, (land - faceStart) * 0.65);

    const heated = parts.flatMap(({ text, advance }, part): TextPiece[] => {
      const atMs = parts.length === 1 ? 0 : sweep * part / (parts.length - 1);
      const on = faceStart + atMs;
      const haloStart = Math.min(on, start + atMs);
      const id = `thermal:${number}:w${at}${parts.length > 1 ? `l${part}` : ""}`;
      const x = center + wordBox.x + advance;
      const y = box.y1 + wordBox.y;
      const coreBlur = Math.min(layout.padding * 0.20, size * 0.035);
      const common = { kind: "text", text, face: FACE, sizePx: size, letterSpacingEm: spacing, language: cue.language, anchor: "baseline-left" } as const;
      const core: TextPiece = {
        ...common, id, z: 2, fromMs: on, toMs: end, fill: primary,
        track: { x: [[on, x]], y: [[on, y]] },
      };
      const entering = land > on && paintedFrameCount(on, land + 1, fps) >= 2;
      if (entering || exit < end) {
        core.track.o = [...(entering ? [[on, 0.38], [land, 1, "out"]] as const : [[on, 1]] as const),
          ...(exit < end ? [[exit, 1], [end, 0, "inOut"]] as const : [])];
        core.track.blur = [...(entering ? [[on, coreBlur], [land, 0, "out"]] as const : [[on, 0]] as const),
          ...(exit < end ? [[exit, 0], [end, coreBlur * 1.3, "in"]] as const : [])];
      }

      if (paintedFrameCount(haloStart, end, fps) < 2) return [core];
      const warm = haloStart + (land - haloStart) * 0.62;
      const initialBlur = Math.min(layout.padding * 0.53, size * 0.16);
      const restBlur = Math.min(initialBlur * 0.65, size * (hero ? 0.043 : 0.052));
      const haloY = y + Math.min(layout.padding * 0.44, size * 0.067);
      const restColour = hero ? hotColour : accent;
      const restOpacity = hero ? 0.9 : 0.38;
      const haloSettled = hero ? land : Math.min(land + 160, exit);
      const opacity: Frames[number][] = [[haloStart, 0.76]];
      const colour: ColourFrames[number][] = [[haloStart, accent]];
      if (warm > haloStart) {
        opacity.push([warm, 0.96, "out"]);
        colour.push([warm, highlight, "out"]);
      }
      if (haloSettled > haloStart) {
        opacity.push([haloSettled, restOpacity, "out"]);
        colour.push([haloSettled, restColour, hero ? "out" : "in"]);
      }
      if (hero && exit - haloSettled > 1500) {
        for (let t = haloSettled + 1300; t + 500 < exit; t += 2600) {
          opacity.push([t, 0.95, "inOut"], [t + 500, restOpacity, "inOut"]);
        }
      }
      if (exit < end) {
        opacity.push([exit, restOpacity], [end, 0, "inOut"]);
        colour.push([exit, restColour], [end, accent, "in"]);
      }
      const halo: TextPiece = {
        ...common, id: `${id}:halo`, z: 1, fromMs: haloStart, toMs: end, fill: accent,
        track: {
          x: [[haloStart, x]], y: [[haloStart, haloY]],
          o: opacity,
          blur: land > haloStart ? [[haloStart, initialBlur], [land, restBlur, "out"]] : [[haloStart, restBlur]],
          colour,
        },
      };
      return [halo, core];
    });
    if (hero && paintedFrameCount(land, exit, fps) >= 2) {
      const ambient: TextPiece = {
        kind: "text", id: `thermal:${number}:ambient${at}`, z: 0, fromMs: land, toMs: end,
        text, face: FACE, sizePx: size, letterSpacingEm: spacing, language: cue.language, anchor: "baseline-left", fill: accent,
        stroke: { colour: accent, widthPx: Math.min(layout.padding * 0.13, size * 0.028) },
        track: {
          x: [[land, center + wordBox.x]], y: [[land, box.y1 + wordBox.y + size * 0.035]],
          blur: [[land, Math.min(layout.padding * 0.47, size * 0.08)]],
          o: exit < end ? [[land, 0.60], [exit, 0.60], [end, 0, "inOut"]] : [[land, 0.60]],
        },
      };
      heated.unshift(ambient);
    }
    return heated;
  });
}

function accents(plan: CuePlan, input: SceneInput, fps: number, exit: number, variant: number): ShapePiece[] {
  const { cue, layout, box, number } = plan;
  const { highlight, accent } = input.colours;
  const first = layout.words[0]!;
  const key = layout.words.find((word) => word.hero) ?? layout.words.at(-1)!;
  let hash = cue.index;
  for (const word of cue.words) for (const char of word.text) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  const nudge = ((hash >>> 0) % 17) / 17;
  const direction = layout.rtl ? -1 : 1;
  const center = (box.x1 + box.x2) / 2;

  return (["ignition", "ember"] as const).flatMap((kind): ShapePiece[] => {
    const spark = kind === "ember";
    const word = spark ? key : first;
    const from = spark ? Math.max(plan.from, cue.words[word.at]!.startMs) : plan.from;
    const to = Math.min(exit, from + (spark ? 220 : 190));
    if (paintedFrameCount(from, to, fps) < 2) return [];
    const side = spark ? direction : -direction;
    const wordEdge = word.x + (side > 0 ? word.width : 0);
    const room = layout.words.reduce((available, neighbour) => {
      if (neighbour === word || neighbour.y !== word.y) return available;
      const facingEdge = neighbour.x + (side < 0 ? neighbour.width : 0);
      const distance = (facingEdge - wordEdge) * side;
      return distance >= 0 ? Math.min(available, distance) : available;
    }, layout.padding);
    const scale = Math.min(word.size, room * 2);
    const x = center + wordEdge + side * room * (0.46 + nudge * 0.09);
    const y = box.y1 + word.y - word.above * 0.28;
    const middle = from + (to - from) * 0.45;
    const pulse: Frames = [[from, 0.35], [middle, spark ? 0.76 : 0.58, "out"], [to, 0, "inOut"]];
    return [{
      kind: "shape", id: `thermal:${number}:${kind}`, z: 1, fromMs: from, toMs: to,
      path: spark ? centredRect(scale * 0.054, scale * 0.054) : centredRect(scale * (0.12 + nudge * 0.05), scale * 0.025),
      fill: { colour: spark ? (variant ? highlight : AMBER) : (variant ? accent : highlight) },
      track: {
        x: [[from, x + (spark ? 0 : side * scale * 0.12)], [to, x + (spark ? side * scale * 0.08 : 0), "out"]],
        y: spark ? [[from, y], [to, y - scale * 0.23, "out"]] : [[from, y]],
        sx: [[from, 0.65], [middle, 1, "out"], [to, spark ? 0.45 : 0.2, "in"]],
        rz: [[from, spark ? 45 : 0]], o: pulse,
      },
    }];
  });
}

export const thermalProgram: SceneProgram = {
  build(input) {
    const fps = input.fps ?? SCENE_DEFAULT_FPS;
    const space = sceneSpace(input, ANCHOR);
    let heroCount = 0;
    let plainCount = 0;
    return { pieces: planCues(input, space).flatMap((plan) => {
      const exitStart = Math.max(plan.last + READ_MS, plan.end - 140);
      const exit = paintedFrameCount(exitStart, plan.end, fps) >= 2 ? exitStart : plan.end;
      const variant = (plan.layout.words.some((word) => word.hero) ? heroCount++ : plainCount++) % 2;
      return [...heatText(plan, input, fps, exit), ...accents(plan, input, fps, exit, variant)];
    }) };
  },
};
