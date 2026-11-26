import { describe, expect, test } from "bun:test";
import { contentPackSchema, DEFAULT_BRAND_TITLE, DEFAULT_CAPTION_PRESET, studioEditsSchema, type ClipSelectionInput } from "@narriflow/validators";
import { encodeClipSelectionInput } from "./clip-selection-input";
import { requireStagedCapsuleCurrent } from "./clip-selection-preparation";
import { WorkflowFailure } from "./workflow-attempt-contract";

const capsule = (title: ClipSelectionInput["editor"]["title"]): ClipSelectionInput => ({
  version: 1,
  parent: { id: "00000000-0000-4000-8000-000000000001", projectId: "00000000-0000-4000-8000-000000000002", generation: 1, deploymentEpoch: 1, inputHash: "a".repeat(64) },
  transcript: { id: "00000000-0000-4000-8000-000000000003", generation: 1, attemptId: null, contentHash: "b".repeat(64), sourceRevision: 1, sourceAudioId: null, sourceAudioBindingHash: null },
  planning: { projectTitle: "Lisbon weekend", contentPack: contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 3, clipDurationSecTarget: 45, platformPlaybookVersion: "platform-playbook-v1" }),
    sourceDurationSec: 300, sourceProbeDurationSec: 300, utterances: [], fullText: "x", speakerCount: 1, sourceLanguageCode: "en", audienceDataLine: null },
  editor: { captionPreset: DEFAULT_CAPTION_PRESET, studioEdits: studioEditsSchema.parse({}), sourceDurationSec: 300, wholeSource: false,
    cleanup: { removeSilences: false, removeFillerWords: false, quietRanges: null, languageCode: "en", aiFillers: null }, emojiPicks: null, title },
  provider: { model: "gpt-6-luna", reasoningEffort: "medium", maxOutputTokens: 32000 }, systemPrompt: "p", responseSchemaHash: "c".repeat(64),
});

describe("a staged selection capsule at commit", () => {
  test("an unchanged capsule commits", async () => {
    const staged = await encodeClipSelectionInput(capsule(null));
    expect(() => requireStagedCapsuleCurrent(staged.sha256, staged.sha256)).not.toThrow();
  });

  test("inputs that changed while it was staged (here the brand title) retry instead of superseding the run", async () => {
    const staged = await encodeClipSelectionInput(capsule(null));
    const current = await encodeClipSelectionInput(capsule({ ...DEFAULT_BRAND_TITLE, durationSec: 8 }));
    expect(current.sha256).not.toBe(staged.sha256);
    let thrown: unknown;
    try { requireStagedCapsuleCurrent(staged.sha256, current.sha256); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(WorkflowFailure);
    expect(thrown).toMatchObject({ code: "selection_input_changed", disposition: "retryable" });
  });
});
