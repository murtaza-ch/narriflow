import { captionTextClusters } from "@narriflow/caption-fonts/caption-block";
import { toCaptionUpperCase } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { type Ease, type Frames } from "../ease";
import { exportFrameAtOrBefore, exportFrameTimes, paintedFrameCount } from "../frame-grid";
import type { SceneProgram } from "../input";
import { cueDirection, sceneSpace } from "../layout";
import { type Clip, type Piece, type TextPiece, pieceBounds } from "../scene";
import { rectPath } from "../shapes";
import { layoutSpeechWords, renderWithReadingHolds, speechWindows } from "./speech-layout";

/** Slot rolls Anton caps through fixed windows. The key word's upper and lower reels use
 * its own glyphs. Complex scripts roll as a whole, and short words settle on their spoken frame. */
export const SLOT_DEMO: DemoScript = {
  lines: [
    "this:m trick:b saves:b you:m hours:h@540",
    "every:m single:b week",
    "stop:b doing:b it:m manually:h@560",
    "just:m automate:h@600 it:m",
    "and:m go:b outside",
  ],
  options: { rate: 255, cueGap: 130 },
};

const ANCHOR = 1280;
const LEAD = 80;
const HOLD = 150;
const FACE = "Anton";
const TRACKING = 0.012;
const SIMPLE = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}\p{P}]+$/u;

const rectClip = (from: number, x1: number, y1: number, x2: number, y2: number): Clip => ({
  x1: [[from, x1]], x2: [[from, x2]], y1: [[from, y1]], y2: [[from, y2]],
});

export const slotProgram: SceneProgram = {
  build(input) {
    const { colours, fps } = input;
    const { safe } = sceneSpace(input, ANCHOR);
    const windows = speechWindows(input, safe, LEAD, HOLD);
    const pieces = renderWithReadingHolds(windows, input, HOLD, (window) => {
      const pieces: Piece[] = [];
      const { cue, index, to } = window;
      const rtl = cueDirection(cue) === "rtl";
      const heroCue = cue.words.some((word) => word.role === "hero");
      const groups: number[][] = [];
      const specs = cue.words.map((word, at) => {
        const hero = word.role === "hero";
        if (hero || at === 0 || cue.words[at - 1]?.role === "hero") groups.push([]);
        groups.at(-1)!.push(at);
        const text = toCaptionUpperCase(word.text, cue.language);
        return { text, size: hero ? 270 : heroCue ? 106 : 150, face: FACE, spacing: SIMPLE.test(text) ? TRACKING : 0 } as const;
      });
      const { cells, box, unit } = layoutSpeechWords(input, window, { anchor: ANCHOR, column: 910, gap: heroCue ? 22 : 30, padding: 42, words: specs, groups });
      const exitStart = Math.max(window.spokenEnd + HOLD, to - 130);
      const exit = paintedFrameCount(exitStart, to, fps) >= 2;
      let letterRoom = 22;
      for (const cell of cells) {
        const word = cue.words[cell.at]!;
        const hero = word.role === "hero";
        const clusters = hero && SIMPLE.test(cell.text) ? captionTextClusters(cell.text) : [cell.text];
        const parts = clusters.length > 1 && clusters.length <= letterRoom ? clusters : [cell.text];
        if (parts.length > 1) letterRoom -= parts.length;
        const base = `slot:${index}:w${cell.at}`;
        const start = Math.max(window.from, word.startMs - LEAD);
        const last = exportFrameAtOrBefore(word.endMs - 1, fps);
        const size = cell.size;
        const colour = hero ? colours.highlight : colours.primary;
        const direction = rtl ? -1 : 1;
        const top = cell.baseline + cell.inkTop - 0.08 * size;
        const bottom = cell.baseline + cell.inkBottom + 0.08 * size;
        const travel = (bottom - top) * 0.61;
        const stagger = Math.min(22, Math.max(0, last - word.startMs) / Math.max(parts.length, 1));
        parts.forEach((part, i) => {
          const rank = direction > 0 ? i : parts.length - i - 1;
          const from = start + rank * stagger;
          const landed = Math.min(last, from + (hero ? 195 : 160));
          const prefix = parts.slice(0, i).join("");
          const through = prefix + part;
          const measure = (text: string) => input.measure(text, FACE, size, cell.spacing).advance;
          const partW = measure(part);
          const left = cell.x - cell.width / 2 + (prefix ? measure(through) - partW : 0);
          const x = left + partW / 2;
          const clip = rectClip(from, window.bounds.x1, top, window.bounds.x2, bottom);
          const y: [number, number, Ease?][] = landed > from
            ? [[from, cell.baseline + travel], [landed, cell.baseline, "outExpo"]]
            : [[from, cell.baseline]];
          if (exit) y.push([exitStart, cell.baseline], [to, cell.baseline - travel * 2, "in"]);
          const face: TextPiece = {
            id: parts.length > 1 ? `${base}l${rank}` : base, kind: "text", z: 3, fromMs: from, toMs: to,
            track: { x: [[from, x]], y }, text: part, face: FACE, sizePx: size, letterSpacingEm: cell.spacing,
            fill: colour, anchor: "baseline-center", language: cue.language, clip,
            shadows: [{ dx: 0, dy: 4 * unit, blur: 4 * unit, colour: colours.shadow, alpha: 0.6 }],
          };
          // The full face must already paint at onset even when it shares that frame with a reel.
          const onset = Math.max(from, word.startMs);
          if (rank === 0 && !pieceBounds(face, onset, input.measure)) {
            y[0] = [from, cell.baseline + travel / 2];
          }
          pieces.push(face);
          if (!hero || paintedFrameCount(from, landed, fps) < 3) return;
          const middle = (top + bottom) / 2;
          for (const [half, side] of [[0, -1], [1, 1]] as const) {
            const end = landed - Math.min(14, (landed - from) * 0.12);
            const alternate = parts.length > 1 ? parts[(i + (half ? parts.length - 1 : 1)) % parts.length]! : part;
            const reel: TextPiece = {
              ...face, id: `${base}reel${rank}-${half}`, z: 2, toMs: end, shadows: undefined,
              text: alternate,
              clip: rectClip(from, Math.max(window.bounds.x1, left - 2 * unit), half ? middle - unit : top, Math.min(window.bounds.x2, left + partW + 2 * unit), half ? bottom : middle + unit),
              track: {
                x: [[from, x]],
                y: [[from, cell.baseline - side * travel * 0.2], [end, cell.baseline + side * travel * 0.85, "inOut"]],
                o: [[from, 0.75], [end, 0, "in"]],
              },
            };
            let visible = 0;
            for (const t of exportFrameTimes(from, end, fps)) {
              if (pieceBounds(reel, t, input.measure) && ++visible === 2) break;
            }
            if (visible >= 2) pieces.push(reel);
          }
        });
      }

      if (paintedFrameCount(window.from, to, fps) < 2) return pieces;
      const from = window.from;
      const ruleEnd = Math.min(to, from + 300);
      const rule: Frames = [[from, 0.08], [ruleEnd, 1, "outExpo"]];
      const y = box.y2 + 12 * unit;
      const width = box.x2 - box.x1;
      const x = rtl ? box.x2 : box.x1;
      pieces.push({
        id: `slot:${index}:rule`, kind: "shape", z: 1, fromMs: from, toMs: to,
        path: rectPath(0, 0, width, 5 * unit), origin: { dx: rtl ? width : 0, dy: 0 }, fill: { colour: colours.primary },
        track: { x: [[from, x]], y: [[from, y]], sx: rule, ...(exit ? { o: [[exitStart, 1], [to, 0, "in"]] } : {}) },
      });
      // An accent cap follows the rule and the second tick rises behind it like a reel index.
      const side = rtl ? -1 : 1;
      const cap = width * (index % 2 === 0 ? 0.12 : 0.17);
      for (let i = 0; i < 2; i++) {
        const offset = (i === 0 ? cap * 0.3 : cap) * side;
        pieces.push({
          id: `slot:${index}:tick${i}`, kind: "shape", z: 2, fromMs: from, toMs: to,
          path: rectPath(0, 0, (i === 0 ? 12 : 6) * unit, 7 * unit), origin: { dx: 3 * unit, dy: 0 }, fill: { colour: colours.highlight },
          track: { x: [[from, x + (side * width - offset) * 0.08], [ruleEnd, x + side * width - offset, "outExpo"]], y: [[from, y + (5 + 3 * i) * unit], [ruleEnd, y + 2 * unit, "outExpo"]], ...(exit ? { o: [[exitStart, 1], [to, 0, "in"]] } : {}) },
        });
      }
      return pieces;
    });
    return { pieces };
  },
};
