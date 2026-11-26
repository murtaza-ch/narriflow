import {
  buildEditedTimeMap,
  captionPresetSchema,
  editorDocumentSchema,
  getCaptionPresetById,
  studioEditsSchema,
  type EditorDocument,
  type TranscriptUtterance,
} from "@narriflow/validators";
import type { StudioFields } from "../../studio-shell";
import type { StudioUpgradePrompts } from "../../studio-upgrade";
import { silenceCuts } from "../../cleanup-cuts";
import type { CaptionEmojiRun } from "../../emoji/caption-emoji-runs";
import type { CaptionEmojiWord } from "../../emoji/caption-emoji-words";
import type { CaptionEmojiEditor } from "../../emoji/use-caption-emojis";

// Mock Studio state for the AI tools panel: its static-markup tests and its prototype page
// (`/prototype/ai-tools`) render the real rows over the same scenarios.

export type AiToolsScenario =
  /** A fresh English clip: everything to offer, Auto-censor gated on Free, speaker analysis running. */
  | "fresh"
  /** Everything applied: emojis exist, pauses and hesitations cut, the whole clip Auto, a cutaway. */
  | "applied"
  /** An Urdu audio clip on a classic style: no filler list, nothing to frame, no hero word. */
  | "urdu-audio"
  /** Another tab holds the write lease. */
  | "readonly";

/** Words as `[text, startSec, endSec]`. */
function utterance(index: number, words: readonly (readonly [string, number, number])[]): TranscriptUtterance {
  return {
    index,
    speaker: 0,
    speakerLabel: "Speaker 1",
    startSec: words[0]![1],
    endSec: words.at(-1)![2],
    text: words.map(([word]) => word).join(" "),
    confidence: 0.95,
    words: words.map(([word, startSec, endSec]) => ({ word, startSec, endSec, confidence: 0.95 })),
  };
}

const ENGLISH = [
  utterance(0, [["So", 0.2, 0.5], ["um,", 0.6, 1.1], ["this", 1.3, 1.6], ["one", 1.6, 1.9], ["idea", 1.9, 2.4], ["changed", 2.4, 2.9], ["everything.", 2.9, 3.6]]),
  utterance(1, [["Uh", 5.6, 6.0], ["we", 6.2, 6.4], ["made", 6.4, 6.7], ["more", 6.7, 7.0], ["money", 7.0, 7.5], ["in", 7.5, 7.6], ["a", 7.6, 7.7], ["month.", 7.7, 8.4]]),
  utterance(2, [["Damn,", 10.9, 11.3], ["that", 11.3, 11.6], ["was", 11.6, 11.8], ["a", 11.8, 11.9], ["good", 11.9, 12.2], ["year.", 12.2, 13.0]]),
  utterance(3, [["Hell", 13.4, 13.7], ["yes,", 13.7, 14.0], ["um,", 14.1, 14.5], ["let's", 14.7, 15.0], ["go.", 15.0, 15.6]]),
];

const URDU = [
  utterance(0, [["یہ", 0.2, 0.5], ["ایک", 0.5, 0.8], ["خیال", 0.8, 1.3], ["سب", 1.3, 1.6], ["بدل", 1.6, 2.0], ["گیا", 2.0, 2.6]]),
  utterance(1, [["ہم", 3.0, 3.3], ["نے", 3.3, 3.5], ["بہت", 3.5, 3.9], ["کمایا", 3.9, 4.6]]),
];

function fixtureDocument(scenario: AiToolsScenario): EditorDocument {
  const urdu = scenario === "urdu-audio";
  const utterances = urdu ? URDU : ENGLISH;
  const clipEndSec = utterances.at(-1)!.endSec + 0.4;
  const applied = scenario === "applied";
  const deletedRanges = applied
    ? silenceCuts({ utterances, clipWindow: { startSec: 0, endSec: clipEndSec }, deletedRanges: [], quietRanges: null }).ranges.concat([
        { startSec: 0.55, endSec: 1.2 },
        { startSec: 5.5, endSec: 6.1 },
        { startSec: 14.05, endSec: 14.6 },
      ])
    : [];
  return editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec,
    captionPreset: captionPresetSchema.parse({ ...getCaptionPresetById(urdu ? "bold-pop" : "headline")!.preset, emojis: applied }),
    transcriptSlice: utterances,
    studioEdits: studioEditsSchema.parse({ framing: { mode: applied ? "auto" : "center" } }),
    brollUrl: applied ? "https://example.com/cutaway.mp4" : null,
    deletedRanges,
  });
}

const noop = () => undefined;

/** The Studio fields the AI tools rows read; callbacks are no-ops unless `actions` are given. */
export function aiToolsFixtureFields(
  scenario: AiToolsScenario,
  options: {
    readonly upgradePrompts: StudioUpgradePrompts;
    readonly openTool?: StudioFields["openTool"];
    readonly applyDetectedCuts?: StudioFields["applyDetectedCuts"];
  },
): StudioFields {
  const document = fixtureDocument(scenario);
  const clipWindow = { startSec: document.clipStartSec, endSec: document.clipEndSec };
  const editedTimeMap = buildEditedTimeMap(document.deletedRanges, clipWindow);
  const urdu = scenario === "urdu-audio";
  return {
    clipInfo: { id: `clip-ai-tools-${scenario}`, projectId: "project-ai-tools", captionLanguage: urdu ? "ur" : "en", sourceKind: urdu ? "audio" : "video" },
    editorDocument: document,
    editorRevision: 1,
    utterances: document.transcriptSlice,
    clipWindow,
    deletedRanges: document.deletedRanges,
    quietRanges: null,
    editedTimeMap,
    aspectRatio: "9:16",
    studioEdits: document.studioEdits,
    captionPreset: document.captionPreset,
    brollUrl: document.brollUrl,
    autoLayoutAnalysisStatus: scenario === "fresh" ? "pending" : "available",
    autoCensorPolicy: {
      locale: urdu ? "ur" : "en",
      workspaceTerms: ["damn", "hell"],
      workspaceTermsCustomized: true,
      canEditWorkspaceTerms: true,
      brandTerms: [],
      projectTerms: [],
      canApply: scenario !== "fresh",
      planTier: scenario === "fresh" ? "free" : "pro",
    },
    censorWords: { workspace: { words: ["damn", "hell"], customized: true }, project: [] },
    upgradePrompts: options.upgradePrompts,
    editingElsewhere: scenario === "readonly",
    openTool: options.openTool ?? noop,
    applyDetectedCuts: options.applyDetectedCuts ?? (() => true),
    setStudioEdits: () => ({ accepted: true }),
  } as unknown as StudioFields;
}

const WORD: CaptionEmojiWord = { key: "w-1.9", text: "idea", line: 0, editedStartSec: 1.9, editedEndSec: 2.4, masked: false };

/** An emoji editor in a given run state, with `shown` emojis on the video. */
export function aiToolsFixtureEmojiEditor(input: { readonly run: CaptionEmojiRun; readonly shown?: number; readonly enabled?: boolean; readonly hasWords?: boolean; readonly generate?: CaptionEmojiEditor["generate"] }): CaptionEmojiEditor {
  return {
    enabled: input.enabled ?? (input.shown ?? 0) > 0,
    model: { words: input.hasWords === false ? [] : [WORD], byKey: new Map([[WORD.key, 0]]), lines: [[0, 1]], anchors: [] },
    placement: { byWord: new Map(), shown: input.shown ?? 0 },
    readOnly: false,
    run: input.run,
    density: "balanced",
    confirmRegenerate: false,
    generate: input.generate ?? noop,
    setEnabled: noop,
    dismissRun: noop,
  } as unknown as CaptionEmojiEditor;
}
