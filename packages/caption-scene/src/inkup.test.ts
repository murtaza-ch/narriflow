import { expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { evaluatePiece } from "./scene";
import { inkupProgram } from "./templates/inkup";
import { sceneInput } from "./test-support";

describeSpeechConformance("inkup", inkupProgram, { anchorLineY: 1300 });

test("Inkup follows vertical position and gives a single-weight fallback an ink-up", () => {
  const { cues } = demoCues({ language: "ur", lines: ["اچھا:h@550"] });
  const build = (yPct: number) => inkupProgram.build(sceneInput(cues, { anchor: { xPct: 50, yPct } })).pieces;
  const upper = build(42);
  const lower = build(72);
  const face = upper.find(({ id }) => id === "inkup:0:w0")!;
  const at = cues[0]!.words[0]!.endMs - 1;
  expect(evaluatePiece(lower.find(({ id }) => id === face.id)!, at).y - evaluatePiece(face, at).y).toBeCloseTo(576, 1);
  const light = upper.find(({ id }) => id === "inkup:0:w0light");
  expect(light).toMatchObject({ text: "اچھا", stroke: undefined });
  expect(face).toMatchObject({ text: "اچھا", stroke: { widthPx: expect.any(Number) } });
});
