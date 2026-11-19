import { captionCueBlock } from "@narriflow/composition-plan";
import {
  assignCaptionRoles,
  captionBlockWordsPerCue,
  captionWordKey,
  type CaptionEmphasisOverride,
  type CaptionEmphasisWord,
  type CaptionPreset,
} from "@narriflow/validators";
import type { CaptionBlockCueInput } from "../projects/[projectId]/clips/[clipId]/studio/_components/caption-block-painter";

/** The phrase every caption style demonstrates, with the timings the thumbnails play. */
export const CAPTION_SAMPLE_WORDS = [
  { text: "make", startSec: 0, endSec: 0.42 },
  { text: "it", startSec: 0.42, endSec: 0.7 },
  { text: "pop", startSec: 0.7, endSec: 1.5 },
] as const;

/** One loop of a playing sample, seconds. */
export const CAPTION_SAMPLE_LOOP_SEC = 2.1;

/** The sample cue stays on screen until just before the loop restarts. */
const SAMPLE_CUE_END_SEC = 2.05;

/**
 * The sample phrase as a Caption Block, built by the plan's own builder
 * (`assignCaptionRoles`, then `captionCueBlock`) so a thumbnail shows what
 * the style renders. When the scorer's confidence gate leaves the phrase
 * without a hero, its last non-minor word is made the hero with an override,
 * so the card always shows the style. Null for a classic preset.
 */
export function captionSampleBlockCue(
  preset: CaptionPreset,
  anchor: { readonly xPct: number; readonly yPct: number },
  language: string | null = "en",
): CaptionBlockCueInput | null {
  if (!preset.dynamic) return null;
  const words = CAPTION_SAMPLE_WORDS.slice(-captionBlockWordsPerCue(preset.wordsPerCue));
  const emphasis = words.map((word, index): CaptionEmphasisWord => ({
    key: captionWordKey(word.startSec),
    raw: word.text,
    sourceStartSec: word.startSec,
    sourceEndSec: word.endSec,
    utteranceIndex: 0,
    utteranceFinal: index === words.length - 1,
    pauseBeforeSec: 0,
    masked: false,
  }));
  const score = (overrides: Readonly<Record<string, CaptionEmphasisOverride>>) =>
    assignCaptionRoles({ cues: [emphasis], language, overrides, policy: "auto" })[0]!;
  let roles = score({});
  if (roles.heroSpan === null) {
    let candidate = roles.roles.length - 1;
    while (candidate > 0 && roles.roles[candidate] === "minor") candidate--;
    roles = score({ [emphasis[candidate]!.key!]: "hero" });
  }
  const block = captionCueBlock(
    words.map((word) => ({ text: word.text, key: captionWordKey(word.startSec) })),
    preset,
    language,
    0,
    roles,
  );
  if (!block) return null;
  return {
    block,
    words: words.map((word) => ({ startSec: word.startSec, endSec: word.endSec })),
    preset,
    language,
    anchor,
    activeRange: { startSec: words[0]!.startSec, endSec: SAMPLE_CUE_END_SEC },
  };
}
