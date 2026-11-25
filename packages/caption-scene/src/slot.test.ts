import { expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { evaluatePiece } from "./scene";
import { slotProgram } from "./templates/slot";
import { sceneInput } from "./test-support";

describeSpeechConformance("slot", slotProgram, { anchorLineY: 1280 });

test("Slot follows the Studio position and rolls its own glyphs through the reels", () => {
  const { cues } = demoCues({ lines: ["CO-OP:h@550"] });
  const at = cues[0]!.words[0]!.endMs - 1;
  const build = (yPct: number) => slotProgram.build(sceneInput(cues, { anchor: { xPct: 50, yPct } })).pieces;
  const upper = build(42);
  const lower = build(72);
  expect(evaluatePiece(lower.find(({ id }) => id === "slot:0:w0l0")!, at).y
    - evaluatePiece(upper.find(({ id }) => id === "slot:0:w0l0")!, at).y).toBeGreaterThan(500);
  expect(upper.find((piece) => piece.id === "slot:0:w0reel0-0")).toMatchObject({ text: "O" });
  expect(upper.find((piece) => piece.id === "slot:0:w0l2")).toMatchObject({ text: "-" });
});

test("a word below the incoming reels gives up its reading hold, so the screen never reads out of order", () => {
  const { cues } = demoCues({
    lines: ["go@200", "so:m@330 then:m@330 over:h@550 soon:m@270"],
    options: { lead: 350, cueGap: 30, gap: 0 },
  });
  const { pieces } = slotProgram.build(sceneInput(cues, { anchor: { xPct: 50, yPct: 67 }, fps: 30 }));
  // GO sits below SO THEN: holding it to 700 ms would read "so then … go". It ends as SO paints.
  expect(pieces.find(({ id }) => id === "slot:0:w0")!.toMs).toBe(pieces.find(({ id }) => id === "slot:1:w0")!.fromMs);
});
