import { contentPackSchema, DEFAULT_CAPTION_PRESET, studioEditsSchema, type ClipSelectionInput } from "@narriflow/validators";
import { clipSelectionBytesHash } from "@narriflow/services/clip-selection-input";
import { CLIP_DETECTION_JSON_SCHEMA, SYSTEM_PROMPT } from "@narriflow/services/clip-selection-policy";

/** Fixed synthetic text, never user data. Both local and deployed gates use it. */
export async function createSyntheticSelectionCapsule(): Promise<ClipSelectionInput> {
  const parent = { id: crypto.randomUUID(), projectId: crypto.randomUUID(), generation: 1, deploymentEpoch: 1, inputHash: "a".repeat(64) };
  const utterances = Array.from({ length: 960 }, (_, index) => {
    const words = Array.from({ length: 30 }, (_, word) => ({ word: `story_${word}${word === 29 ? "." : ""}`, startSec: index * 11.25 + word * 0.375, endSec: index * 11.25 + word * 0.375 + 0.32, confidence: 0.99 }));
    return { index, speaker: index % 2, speakerLabel: `Speaker ${index % 2 + 1}`, startSec: index * 11.25, endSec: (index + 1) * 11.25, text: words.map(word => word.word).join(" "), confidence: 0.99, words };
  });
  return { version: 1, parent, transcript: { id: crypto.randomUUID(), generation: 1, attemptId: crypto.randomUUID(), contentHash: "b".repeat(64), sourceRevision: 1,
    sourceAudioId: crypto.randomUUID(), sourceAudioBindingHash: "c".repeat(64) }, planning: { projectTitle: "Synthetic three-hour source", contentPack: contentPackSchema.parse({
      outputTypes: ["short_clip"], clipCountTarget: 30, clipDurationSecTarget: 45, platformPlaybookVersion: "platform-playbook-v1" }), sourceDurationSec: 10800, sourceProbeDurationSec: 10800,
      utterances, fullText: utterances.map(utterance => utterance.text).join(" "), speakerCount: 2, sourceLanguageCode: "en", audienceDataLine: "Frozen synthetic audience guidance" },
    editor: { captionPreset: DEFAULT_CAPTION_PRESET, studioEdits: studioEditsSchema.parse({}), sourceDurationSec: 10800, wholeSource: false },
    provider: { model: "gpt-5.4-mini", reasoningEffort: "medium", maxOutputTokens: 32000 }, systemPrompt: SYSTEM_PROMPT,
    responseSchemaHash: await clipSelectionBytesHash(new TextEncoder().encode(JSON.stringify(CLIP_DETECTION_JSON_SCHEMA))) };
}

export function syntheticSelectionProviderReply(): string {
  const clips = Array.from({ length: 8 }, (_, index) => ({ title: `Synthetic story ${index}`, start_time: index * 60, end_time: index * 60 + 45, hook_text: "A synthetic hook ".repeat(16),
    payoff_text: "A synthetic payoff ".repeat(16), reasoning: "A measured synthetic story. ".repeat(300), category: "story", platform_fit: ["tiktok"], hook_strength: 80, emotional_intensity: 80,
    story_completeness_score: 95, broll_cues: Array.from({ length: 8 }, (_, cue) => ({ at_sec: cue, query: "synthetic query ".repeat(8), reason: "synthetic reason ".repeat(8) })) }));
  return JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ clips }) }] }], usage: { total_tokens: 24000 } });
}
