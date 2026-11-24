import { expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import type { TextPiece } from "./scene";
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
