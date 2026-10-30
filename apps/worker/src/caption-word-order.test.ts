import { describe, expect, test } from "bun:test";
import { captionWordVisualOrder } from "@narriflow/caption-fonts/bidi-order";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { captionPresetSchema, hasSpaceBefore, textDirection, languageDirection } from "@narriflow/validators";
import { renderCaptionTrack } from "./caption-ass";

/**
 * The burn-in and the Studio order a cue's words with the same bidi functions (`captionWordVisualOrder`).
 * The word overlay of the burn-in is an event per active word whose `\pos` is the word's centre on the
 * canvas, so the words sorted by that x are the line as the viewer sees it from the left.
 */
function burnedOrder(words: readonly string[], language: string | null): number[] {
  const layer: CompositionCaptionVisualLayer = {
    id: "caption:0", kind: "caption", cueIndex: 0, activeRange: { startSec: 0, endSec: words.length * 0.5 },
    anchor: { xPct: 50, yPct: 50 }, destination: { x: 0, y: 0, width: 1080, height: 400 },
    rotationDeg: 0, opacity: 1, zIndex: 40, preset: captionPresetSchema.parse({ animation: "pop" }),
    words: words.map((text, index) => ({ text, emoji: null, startSec: index * 0.5, endSec: (index + 1) * 0.5 })),
    language,
  };
  const { ass } = renderCaptionTrack({ layers: [layer], canvas: { width: 1080, height: 400 } });
  const centres = words.map((_, index) => {
    const start = `0:00:0${Math.floor(index / 2)}.${index % 2 === 0 ? "00" : "50"}`;
    const event = ass.split("\n").find((line) => line.startsWith(`Dialogue: 11,${start},`));
    return Number(/\\pos\(([\d.]+),/.exec(event ?? "")?.[1]);
  });
  return centres.map((x, index) => ({ x, index })).sort((a, b) => a.x - b.x).map((entry) => entry.index);
}

function studioOrder(words: readonly string[], language: string | null): readonly number[] {
  const direction = textDirection(words.join(" "), languageDirection(language));
  return captionWordVisualOrder(
    words.map((text, index) => ({ text, space: index > 0 && hasSpaceBefore(words[index - 1]!, { word: text }) })),
    direction,
  ).wordOrder;
}

describe("burn-in and Studio order a cue's words alike", () => {
  const cases: [string, string[], string | null][] = [
    ["Urdu with an English phrase", ["لیے", "Extended", "Family"], "ur"],
    ["Urdu", ["آپ", "کو", "بتایا"], "ur"],
    ["Arabic with a number and a name", ["عام", "2026", "Narriflow", "الجديد"], "ar"],
    ["Hebrew with numbers", ["שלום", "12", "34", "עולם"], "he"],
    ["English with an Arabic phrase", ["say", "مرحبا", "بالعالم", "now"], "en"],
    ["English", ["hello", "big", "world"], "en"],
  ];
  for (const [name, words, language] of cases) {
    test(name, () => {
      expect(burnedOrder(words, language)).toEqual([...studioOrder(words, language)]);
    });
  }
});
