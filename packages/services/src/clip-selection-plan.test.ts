import { expect, test } from "bun:test";
import { contentPackSchema, type TranscriptUtterance } from "@narriflow/validators";
import { buildClipSelectionPlan, finalizeClipSelectionCandidates } from "./clip-selection-plan";

const pack = contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 45, platformPlaybookVersion: "platform-playbook-v1" });
function utterances(seconds: number): TranscriptUtterance[] {
  return Array.from({ length: Math.ceil(seconds / 3) }, (_, index) => ({ index, speaker: 0, speakerLabel: "Speaker 1", startSec: index * 3,
    endSec: Math.min(seconds, index * 3 + 3), text: `A complete thought ${index}.`, confidence: null,
    words: [{ word: "thought.", startSec: index * 3, endSec: Math.min(seconds, index * 3 + 3), confidence: null }] }));
}
const input = (seconds: number) => ({ projectTitle: "Frozen source", contentPack: pack, sourceDurationSec: seconds, sourceProbeDurationSec: seconds,
  utterances: utterances(seconds), fullText: "A completed transcript", speakerCount: 1, sourceLanguageCode: "en", audienceDataLine: null });

test("one/two/three hour sources always plan two/four/six absolute half-hour windows with the existing overlap", () => {
  for (const [seconds, count] of [[3600, 2], [7200, 4], [10800, 6]]) {
    const plan = buildClipSelectionPlan(input(seconds!));
    if (plan.kind !== "selection") throw new Error("Expected selection windows");
    expect(plan.windows.length).toBe(count!);
    expect(plan.windows[0]).toMatchObject({ windowIndex: 0, startSec: 0, endSec: 1920 });
    expect(plan.windows.at(-1)).toMatchObject({ startSec: seconds! - 1800, endSec: seconds! });
    expect(plan.windows[1]!.utterances[0]!.startSec).toBe(1800);
    expect(plan.windows[1]!.userPrompt).toContain("start_sec=1800.000");
    expect(plan.windows[1]!.userPrompt).not.toContain("start_sec=0.000");
  }
});
test("deep processing windows preserve absolute times and frozen prompt guidance and skip empty provider calls", () => {
  const source = input(10800);
  const configured = { ...source, contentPack: { ...pack, processingStartSec: 7200, processingEndSec: 10800 }, audienceDataLine: "Audience data: frozen hint" };
  const plan = buildClipSelectionPlan(configured);
  if (plan.kind !== "selection") throw new Error("Expected selection");
  expect(plan.windows.map(window => [window.startSec, window.endSec])).toEqual([[7200, 9120], [9000, 10800]]);
  expect(plan.windows[0]!.userPrompt?.split("Audience data: frozen hint").length).toBe(2);
  expect(plan.windows[0]!.userPrompt).toContain("Processing window: 7200s to 10800s");
  const sparse = buildClipSelectionPlan({ ...input(3600), utterances: utterances(60) });
  if (sparse.kind !== "selection") throw new Error("Expected selection");
  expect(sparse.windows[1]).toMatchObject({ userPrompt: null, utterances: [] });
});
test("caption-only mode uses the same whole-source policy without a model request", () => {
  const source = input(120);
  const plan = buildClipSelectionPlan({ ...source, contentPack: { ...pack, mode: "caption_only", processingStartSec: 5, processingEndSec: 65 } });
  expect(plan.kind).toBe("caption_only");
  if (plan.kind !== "caption_only") throw new Error("Expected caption-only clip");
  expect(plan.clips[0]).toMatchObject({ startSec: 5, endSec: 65, title: "Frozen source", reasoning: "Caption-only mode: full-length captioned render", storyCompletenessScore: 100 });
});
test("the first processing-window sentence keeps its original boundary timing", () => {
  const plan = buildClipSelectionPlan({ ...input(60), contentPack: { ...pack, processingStartSec: 10, processingEndSec: 50 } });
  if (plan.kind !== "selection") throw new Error("Expected selection");
  expect(plan.windows[0]!.utterances[0]!.startSec).toBe(9);
  expect(plan.windows[0]!.userPrompt).toContain("start_sec=9.000");
});
test("the global pass deduplicates shared boundary candidates once before ranking to the requested count", () => {
  const plan = buildClipSelectionPlan(input(1200));
  if (plan.kind !== "selection") throw new Error("Expected selection");
  const candidate = (startSec: number) => ({ startSec, endSec: startSec + 45, title: "A moment", hookText: "A hook", payoffText: "A payoff", reasoning: "A complete story",
    category: "story", platformFit: ["tiktok" as const], hookStrength: 80, emotionalIntensity: 80, storyCompleteness: 95, brollCues: [] });
  const result = finalizeClipSelectionCandidates(plan, [candidate(0), candidate(0), candidate(600), candidate(1000)]);
  expect(result.clips.length).toBe(3);
  expect(new Set(result.clips.map(clip => `${clip.startSec}:${clip.endSec}`)).size).toBe(3);
  expect(result.rawClipCount).toBe(4);
  expect(result.dedupedCandidateCount).toBe(3);
});
