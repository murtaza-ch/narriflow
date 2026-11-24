import { expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { type Box, type Piece, pieceBounds } from "./scene";
import { googlyProgram } from "./templates/googly";
import { fakeMeasure, sceneInput } from "./test-support";

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

test("Googly's small sparkles and twinkles never reach a spoken word's ink on real phrasing", () => {
  // Gallery review 2026-11-25: the label's bottom-left sparkle lay on the next row's first word, and a twinkle on a word's top corner
  // reached the next word's caps. A sparkle with no free corner is left out.
  const { cues } = demoCues({
    lines: ["we:m didn't:h@360 want:b anyone:b", "all:b of:m them:b are:m unplugged.:h@480", "to:m accidentally:b open:b them.:b", "we:m didn't:h@360 want:b", "the:m battery:b might:b be:m dead.:h@400"],
    options: { lead: 400, gap: 30, cueGap: 120, tail: 500 },
  });
  const input = sceneInput(cues);
  const { pieces } = googlyProgram.build(input);
  const core = (box: Box): Box => {
    const dx = (box.x2 - box.x1) * 0.06;
    const dy = (box.y2 - box.y1) * 0.18;
    return { x1: box.x1 + dx, x2: box.x2 - dx, y1: box.y1 + dy, y2: box.y2 - dy };
  };
  const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
  const small = (piece: Piece) => /^googly:\d+:(?:w\d+spark2|twinkle\d)$/.test(piece.id);
  const faces = (cue: number) => pieces.filter((piece) => piece.kind === "text" && new RegExp(`^googly:${cue}:w\\d+$`).test(piece.id));
  let kept = 0;
  for (const cue of cues) {
    const words = faces(cue.index);
    for (const piece of pieces.filter((candidate) => candidate.id.startsWith(`googly:${cue.index}:`) && small(candidate))) {
      kept++;
      // Like the real-measure occlusion test, a pair counts once it overlaps on three consecutive frames: a sparkle crossing a
      // word's box for a frame or two at its largest is motion, a sparkle sitting on one is a covered word.
      const runs = new Map<string, number>();
      for (const t of exportFrameTimes(cue.startMs, cue.endMs, 30)) {
        const box = pieceBounds(piece, t, fakeMeasure);
        if (!box) continue;
        for (const word of words) {
          // The label's own sparkle sits on its own corner; a twinkle belongs to the first or last plain word, whose caps it is lifted over.
          const at = Number(word.id.split(":w")[1]);
          const plain = cue.words.flatMap((w, k) => (w.role === "hero" ? [] : [k]));
          const twinkle = /twinkle(\d)/.exec(piece.id);
          if (piece.id.includes("spark2") ? piece.id.startsWith(`${word.id}`) : twinkle && at === (twinkle[1] === "0" ? plain[0] : plain.at(-1))) continue;
          const ink = pieceBounds(word, t, fakeMeasure);
          const run = ink && meets(box, core(ink)) ? (runs.get(word.id) ?? 0) + 1 : 0;
          runs.set(word.id, run);
          expect(run, `${piece.id} over ${word.id} at ${t}`).toBeLessThan(3);
        }
      }
    }
  }
  // The sparkles still come on most cues: each cue keeps its twinkle, and at least one label keeps its small sparkle.
  expect(pieces.filter((piece) => /twinkle/.test(piece.id)).length).toBeGreaterThanOrEqual(cues.length);
  expect(kept).toBeGreaterThan(cues.length);
});
