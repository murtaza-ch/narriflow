import { describe, expect, test } from "bun:test";
import { type SceneCue, demoCues, exportFrameAtOrAfter, pieceBounds } from "@narriflow/caption-scene";
import { sceneDemo } from "../scripts/caption-scene-demo";

/**
 * Drip writes words on under a moving clip. Measured with the real HarfBuzz measurer (Knewave and the fallback faces as
 * drawn), every word is whole on its first spoken frame in continuous speech, at several frame phases (Sol's review of
 * b339f6635: "goodbye" read "goo" at 733 ms, "बहुत" lost its last character, "remember" read "remem" at 25 fps).
 */
const RUNS: readonly { readonly lines: string[]; readonly language: string }[] = [
  { lines: ["it's:b time:b to:m say:b", "goodbye:h@420 to:m the:m waveform:b", "I:m still:b remember:h@300 the:m", "commercial:b"], language: "en" },
  { lines: ["display:b glare:b बहुत:h@420", "और:m अगर:b इसे:m सीधा:h@400", "देखो:b तो:m इतना:h@380"], language: "hi" },
  { lines: ["ہم:m studio:b دیکھیں:b گے:m", "یہ:m بہت:b اچھا:h@600 ہے:m"], language: "ur" },
];

const shifted = (cues: readonly SceneCue[], by: number): SceneCue[] =>
  cues.map((cue) => ({ ...cue, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + by, endMs: word.endMs + by })) }));

describe("Drip writes every word whole by its first spoken frame (real measure)", () => {
  for (const fps of [25, 30]) {
    test(`${fps} fps, zero gaps, frame phases`, () => {
      for (const run of RUNS) {
        for (const by of [0, 9, 21]) {
          const { cues } = demoCues({ lines: run.lines, language: run.language, options: { lead: 333, gap: 0, cueGap: 0, tail: 400 } });
          const moved = shifted(cues, by);
          const demo = sceneDemo("drip", { cues: moved, fps });
          const measure = demo.measurer.measure;
          for (const face of demo.scene.pieces.filter((piece) => piece.kind === "text" && /^drip:\d+:w\d+(l\d+)?$/.test(piece.id))) {
            const [, cue, word] = face.id.split(":");
            const spoken = moved[Number(cue)]!.words[Number(word!.slice(1).replace(/l\d+$/, ""))]!;
            const onset = exportFrameAtOrAfter(spoken.startMs, fps);
            expect(pieceBounds(face, onset, measure), `${run.language} ${face.id} at ${onset} (+${by})`).toEqual(pieceBounds({ ...face, clip: undefined }, onset, measure));
          }
        }
      }
    });
  }
});
