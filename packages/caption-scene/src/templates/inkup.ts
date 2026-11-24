import type { DemoScript } from "../demo";
import { type Frames, EASES, prog } from "../ease";
import { exportFrameAtOrBefore, paintedFrameCount } from "../frame-grid";
import { sampleFrames } from "../frames";
import type { SceneProgram } from "../input";
import { sceneSpace } from "../layout";
import { SCENE_PIECE_BUDGET, type Piece, type TextPiece } from "../scene";
import { layoutSpeechWords, speechWindows } from "./speech-layout";

/** Inkup holds the layout at the heavy weights' widths. Light and medium faces cross-fade
 * into those widths, with italic violet on the key word. */
export const INKUP_DEMO: DemoScript = {
  lines: [
    "most:b people:b quit:b right:m before:b it:m works:h@560",
    "nobody:b remembers:b your:m plan",
    "ship:h@520 it:m ugly:b",
    "consistency:h@760 beats:b talent",
    "start:b before:b you're:m ready:h@520",
  ],
  options: { rate: 235, gap: 22, cueGap: 150, tail: 700, lead: 350 },
};

const ANCHOR = 1300;
const LEAD = 70;
const HOLD = 150;
const BODY = 86;
const WEIGHTED_SCRIPT = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{M}\p{N}\p{P}\s]+$/u;

export const inkupProgram: SceneProgram = {
  build(input) {
    const { colours, fps } = input;
    const { safe } = sceneSpace(input, ANCHOR);
    const pieces: Piece[] = [];
    for (const window of speechWindows(input, safe, LEAD, HOLD)) {
      const { cue, index, from, to } = window;
      const words = cue.words.map((word) => ({
        text: word.text,
        size: BODY * (word.role === "hero" ? 1.16 : 1),
        face: word.role === "hero" ? "Inter Tight ExtraBold Italic" : "Inter Tight ExtraBold",
        spacing: 0,
      }) as const);
      const { cells, unit } = layoutSpeechWords(input, window, { anchor: ANCHOR, column: 840, gap: 23, padding: 52, align: "leading", words });
      const exitAt = Math.max(window.spokenEnd + HOLD, to - 170);
      const exit = paintedFrameCount(exitAt, to, fps) >= 2;
      const leave = (t: number) => exit ? EASES.in(prog(t, exitAt, to - exitAt)) : 0;
      const enter = (t: number) => 1 - EASES.outExpo(prog(t, from, 130));
      const dy = (t: number) => unit * (14 * enter(t) - 12 * leave(t));
      const samples = (f: (t: number) => number, a: number, b: number, keys: number[], tolerance: number): Frames =>
        sampleFrames(f, [...keys, from + 130, exitAt], tolerance, { range: [a, b] });
      let blendBudget = Math.max(0, SCENE_PIECE_BUDGET - 2 * cells.length);
      for (const cell of cells) {
        const word = cue.words[cell.at]!;
        const hero = word.role === "hero";
        const colour = hero ? colours.highlight : colours.primary;
        // Fallback families can resolve all three requested weights to the same face.
        const fallbackStroke = WEIGHTED_SCRIPT.test(cell.text) ? 0 : 0.014 * cell.size;
        const name = `inkup:${index}:w${cell.at}`;
        const change = Math.max(from, word.startMs - 60);
        const settled = Math.max(change, Math.min(change + 150, exportFrameAtOrBefore(word.endMs - 1, fps)));
        const boldAt = Math.min(word.startMs, change + 36);
        const rise = (t: number) => settled > boldAt ? 0.17 + 0.83 * EASES.out(prog(t, boldAt, settled - boldAt)) : 1;
        const shared = (a: number, b: number) => ({
          x: [[a, cell.x]] as Frames,
          y: samples((t) => cell.baseline + dy(t), a, b, [], 0.16),
        });
        const face: TextPiece = {
          id: name, kind: "text", z: 4, fromMs: boldAt, toMs: to,
          track: {
            ...shared(boldAt, to),
            o: samples((t) => rise(t) * (1 - leave(t)), boldAt, to, [settled], 0.006),
            ...(hero ? { sx: [[boldAt, 1.05], [Math.min(to, boldAt + 600), 1, "out"]] } : {}),
          },
          text: cell.text, face: cell.face, sizePx: cell.size, letterSpacingEm: 0, fill: colour,
          anchor: "baseline-center", language: cue.language,
          ...(fallbackStroke ? { stroke: { colour, widthPx: fallbackStroke } } : {}),
          shadows: [{ dx: 0, dy: hero ? 0 : 3 * unit, blur: (hero ? 9 : 6) * unit, colour: hero ? colours.accent : colours.shadow, alpha: 0.65 }],
        };
        pieces.push(face);
        const mixAt = Math.min(settled, change + 65);
        const addWeight = (weight: TextPiece["face"], id: string, a: number, b: number, opacity: (t: number) => number) => {
          if (blendBudget <= 0 || paintedFrameCount(a, b, fps) < 2) return;
          const width = input.measure(cell.text, weight, cell.size, 0).advance;
          pieces.push({
            ...face, id: name + id, face: weight, z: 3, fromMs: a, toMs: b, shadows: undefined,
            stroke: id === "mid" && fallbackStroke ? { colour, widthPx: fallbackStroke * 0.35 } : undefined,
            track: { ...shared(a, b), sx: [[a, width > 0 ? cell.width / width : 1]], o: samples(opacity, a, b, [change, mixAt, boldAt], 0.006) },
          });
          blendBudget--;
        };
        const light = hero ? "Inter Tight Light Italic" : "Inter Tight Light";
        const medium = hero ? "Inter Tight Medium Italic" : "Inter Tight Medium";
        addWeight(light, "light", from, mixAt, (t) => (hero ? 0.78 : 0.7) * (1 - EASES.out(prog(t, change, mixAt - change))));
        addWeight(medium, "mid", change, settled, (t) => (0.2 + 0.8 * EASES.out(prog(t, change, mixAt - change))) * (t >= boldAt ? 1 - rise(t) : 1));
      }
    }
    return { pieces };
  },
};
