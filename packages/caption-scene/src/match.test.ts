import { expect, test } from "bun:test";
import { demoCues } from "./demo";
import { CAPTION_SCENE_PROGRAMS } from "./registry";
import { pieceBounds } from "./scene";
import { sceneInput } from "./test-support";

const build = (lines: string[]) => {
  const { cues } = demoCues({ lines, options: { lead: 400, cueGap: 140, tail: 500 } });
  const input = sceneInput(cues, { fps: 30 });
  return { cues, input, pieces: CAPTION_SCENE_PROGRAMS.match.program.build(input).pieces };
};

test("Match keeps the sample's word gap outside the yellow box", () => {
  const { cues, input, pieces } = build(["we:m didn't:h@900 want:b", "it's:b time:b to:m say:b goodbye:h@900", "does:b the:m even:m still:h@900"]);
  for (const cue of cues) {
    const heroAt = cue.words.findIndex((word) => word.role === "hero");
    const t = cue.endMs - 150;
    const box = pieceBounds(pieces.find((piece) => piece.id === `match:${cue.index}:box${heroAt}`)!, t, input.measure)!;
    const faces = cue.words.map((_, at) => pieceBounds(pieces.find((piece) => piece.id === `match:${cue.index}:w${at}`)!, t, input.measure)!);
    for (const [at, face] of faces.entries()) {
      if (at === heroAt) continue;
      const sameRow = face.y1 < box.y2 && box.y1 < face.y2;
      if (!sameRow) continue;
      const gap = face.x2 <= box.x1 ? box.x1 - face.x2 : face.x1 - box.x2;
      expect(gap, `word ${at} of cue ${cue.index} touches the box`).toBeGreaterThanOrEqual(20);
    }
    // The box still pads the key word and holds it.
    expect(box.x1).toBeLessThan(faces[heroAt]!.x1);
    expect(box.x2).toBeGreaterThan(faces[heroAt]!.x2);
  }
});
