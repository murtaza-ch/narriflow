"use client";

// PROTOTYPE — throwaway. Same transcript and timing as the worker-side libass
// harness, rendered at half export scale (540 x 960) on the same background.
import { CAPTION_POSITION_Y_DEFAULTS, CAPTION_PRESETS } from "@narriflow/validators";
import { CaptionCue } from "../../(app)/projects/[projectId]/clips/[clipId]/studio/_components/caption-style-engine";

const SCRIPT = [
  "The biggest mistake people make is waiting until they feel ready.",
  "Nobody feels ready.",
  "You start, you learn fast, and momentum does the rest.",
];

function cuesFor(wordsPerCue: number) {
  let t = 0.4;
  const cues: { words: { text: string; start: number; end: number }[]; index: number }[] = [];
  for (const sentence of SCRIPT) {
    const words = sentence.split(" ").map((text) => {
      const duration = 0.16 + 0.04 * text.replace(/[^a-z]/gi, "").length;
      const word = { text, start: t, end: t + duration };
      t += duration + (/,$/.test(text) ? 0.18 : 0.03);
      return word;
    });
    for (let index = 0; index < words.length; index += wordsPerCue) {
      cues.push({ words: words.slice(index, index + wordsPerCue), index: cues.length });
    }
    t += 0.35;
  }
  return cues;
}

export function CaptionParity({ presetId, time }: { presetId: string; time: number }) {
  const named = CAPTION_PRESETS.find((candidate) => candidate.id === presetId) ?? CAPTION_PRESETS[0];
  const preset = { ...named.preset, punctuation: false };
  const cues = cuesFor(preset.wordsPerCue);
  const cue = cues.find((candidate, index) => time >= candidate.words[0]!.start && time < (cues[index + 1]?.words[0]?.start ?? Number.POSITIVE_INFINITY));
  const width = 540;
  return (
    <div style={{ position: "relative", width, height: 960, background: "#2a3346", overflow: "hidden" }} data-parity-frame>
      {cue && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: `${CAPTION_POSITION_Y_DEFAULTS[preset.position]}%`,
            transform: "translate(-50%, -50%)",
            width: "max-content",
          }}
        >
          <CaptionCue
            preset={preset}
            words={cue.words.map((word, index) => ({
              word: word.text,
              isActive: time >= word.start && time < (cue.words[index + 1]?.start ?? Number.POSITIVE_INFINITY),
              durationMs: 400,
            }))}
            scale={width / 1080}
            frameWidth={width}
            cueKey={cue.index}
            cueIndex={cue.index}
            reducedMotion
          />
        </div>
      )}
    </div>
  );
}
