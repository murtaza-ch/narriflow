import { expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { type Box, type TextPiece, pieceBounds } from "./scene";
import { bubbleProgram } from "./templates/bubble";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("bubble", bubbleProgram, { anchorLineY: 1300 });

test("the pill centres the painted letters in its body, clear of the tail", () => {
  const { cues } = demoCues({ lines: ["wait:h@500", "yes:h@500", "slowly:h@700"], options: { cueGap: 300 } });
  const measure: typeof fakeMeasure = (text, face, size, spacing) => {
    const metrics = fakeMeasure(text, face, size, spacing);
    return { ...metrics, advance: metrics.advance - (text.includes("LY") ? 0.08 * size : 0) };
  };
  const { pieces } = bubbleProgram.build(sceneInput(cues, { measure }));
  const letters = pieces.filter((piece): piece is TextPiece => piece.kind === "text" && piece.id.startsWith("bubble:2:w0l"));
  expect(letters.map((piece) => piece.text).join("")).toBe("SLOWLY");
  const left = Math.min(...letters.map((piece) => -piece.origin!.dx));
  const right = Math.max(...letters.map((piece) =>
    -piece.origin!.dx + measure(piece.text, piece.face, piece.sizePx, piece.letterSpacingEm).advance));
  expect(left + right).toBeCloseTo(0, 5);

  const pill = pieces.find(({ id }) => id === "bubble:2:tb");
  if (pill?.kind !== "shape") throw new Error("Expected the pill outline");
  const ys = pill.path.flatMap(([op, , y]) => op === "M" || op === "L" ? [y] : []);
  const bodyTop = Math.min(...ys);
  // The two tail vertices below the straight bottom edge have distinct y coordinates.
  const bodyBottom = Math.max(...ys.filter((y, index) => ys.indexOf(y) !== index));
  const inkTop = Math.min(...letters.map((piece) =>
    -piece.origin!.dy + measure(piece.text, piece.face, piece.sizePx, piece.letterSpacingEm).inkTop));
  const inkBottom = Math.max(...letters.map((piece) =>
    -piece.origin!.dy + measure(piece.text, piece.face, piece.sizePx, piece.letterSpacingEm).inkBottom));
  expect((inkTop + inkBottom) / 2).toBeCloseTo((bodyTop + bodyBottom) / 2, 5);
});

test("the tilted bubble's box stays above the plain line and its twinkle off the label's letters", () => {
  // Gallery review 2026-11-25: the tilted starburst's bounding box lay over every word of the line below it, and a pill's twinkle
  // sat on the label's last letter.
  const { cues } = demoCues({
    lines: ["wait:h@450 you:m did:b what:b", "no_way:h@620 it:m works:b", "all:b of:m them:b are:m unplugged.:h@480", "the:m battery:b might:b be:m dead.:h@400", "is:m it:m dead?:h@380"],
    options: { lead: 400, gap: 30, cueGap: 120, tail: 500 },
  });
  const input = sceneInput(cues);
  const { pieces } = bubbleProgram.build(input);
  const core = (box: Box): Box => {
    const dx = (box.x2 - box.x1) * 0.06;
    const dy = (box.y2 - box.y1) * 0.18;
    return { x1: box.x1 + dx, x2: box.x2 - dx, y1: box.y1 + dy, y2: box.y2 - dy };
  };
  const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
  for (const cue of cues) {
    const own = pieces.filter((piece) => piece.id.startsWith(`bubble:${cue.index}:`));
    const words = own.filter((piece) => /^bubble:\d+:w\d+$/.test(piece.id));
    const letters = own.filter((piece) => /^bubble:\d+:w\d+l\d+$/.test(piece.id));
    const frames = exportFrameTimes(cue.startMs, cue.endMs, 30);
    for (const outline of own.filter((piece) => /:(?:co|tb|gl)$/.test(piece.id))) {
      for (const t of frames) {
        const box = pieceBounds(outline, t, fakeMeasure);
        if (!box) continue;
        for (const word of words) {
          const ink = pieceBounds(word, t, fakeMeasure);
          if (ink) expect(meets(box, core(ink)), `${outline.id} over ${word.id} at ${t}`).toBe(false);
        }
      }
    }
    const twinkle = own.find((piece) => piece.id.endsWith(":twinkle"));
    if (!twinkle) continue;
    for (const t of frames) {
      const box = pieceBounds(twinkle, t, fakeMeasure);
      if (!box) continue;
      for (const letter of letters) {
        const ink = pieceBounds(letter, t, fakeMeasure);
        if (ink) expect(meets(box, ink), `${twinkle.id} over ${letter.id} at ${t}`).toBe(false);
      }
    }
  }
  // Every cue with a bubble keeps a twinkle on these phrases.
  expect(pieces.filter((piece) => piece.id.endsWith(":twinkle"))).toHaveLength(5);
});
