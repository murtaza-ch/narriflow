import { expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { pieceBounds } from "./scene";
import { googlyProgram } from "./templates/googly";
import { sceneInput } from "./test-support";

describeSpeechConformance("googly", googlyProgram);

test("Googly centres the visible text vertically inside each hero card", () => {
  const { cues } = demoCues({ lines: ["promises:b of:b accelerated:h@700 timelines:h@700"] });
  const input = sceneInput(cues);
  const { pieces } = googlyProgram.build(input);
  const at = cues[0]!.words[3]!.endMs - 1;

  for (const id of ["googly:0:w2", "googly:0:w3"]) {
    const text = pieceBounds(pieces.find((piece) => piece.id === id)!, at, input.measure)!;
    const pill = pieceBounds(pieces.find((piece) => piece.id === `${id}pill`)!, at, input.measure)!;
    expect(text.y1 - pill.y1).toBeCloseTo(pill.y2 - text.y2, 5);
  }
});
