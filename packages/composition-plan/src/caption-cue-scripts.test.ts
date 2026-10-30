import { describe, expect, test } from "bun:test";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import { captionCueText, captionCueVisibleRange, deriveCaptionCues, planClipComposition } from "./clip-composition-plan";
import { formatSubtitles } from "./subtitles";

type Token = [word: string, spaceBefore?: boolean];

/** One token per `0.3s`, back to back, the way Scribe times per-character scripts. */
function document(tokens: Token[], preset: Record<string, unknown> = {}) {
  const words = tokens.map(([word, spaceBefore], index) => ({
    word, startSec: index * 0.3, endSec: (index + 1) * 0.3, confidence: 0.9,
    ...(spaceBefore === undefined ? {} : { spaceBefore }),
  }));
  return editorDocumentSchema.parse({
    version: 1, clipStartSec: 0, clipEndSec: Math.ceil(words.length * 0.3 + 1),
    captionPreset: captionPresetSchema.parse({ textTransform: "none", wordsPerCue: 3, ...preset }),
    transcriptSlice: [{
      index: 0, speaker: 0, speakerLabel: "Speaker 1", confidence: 0.9,
      startSec: 0, endSec: words.at(-1)!.endSec, text: words.map((w) => w.word).join(" "), words,
    }],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null, deletedRanges: [],
  });
}

const chars = (text: string): Token[] => Array.from(text).map((char) => [char]);

const FIXTURES: Record<string, { tokens: Token[]; cues: string[]; preset?: Record<string, unknown> }> = {
  zh: { tokens: chars("今天天气很好，我们去公园玩。"), cues: ["今天天气很好，", "我们去公园玩。"] },
  ja: {
    tokens: [["私", undefined], ["は"], ["Google", false], ["を", false], ["使"], ["う"], ["。"]],
    cues: ["私はGoogleを使", "う。"],
  },
  th: {
    tokens: [["สวัสดี"], ["ครับ", false], ["วันนี้", true], ["อากาศดี", false]],
    cues: ["สวัสดีครับ วันนี้", "อากาศดี"],
    // Each Thai word costs one spaced word, so three fill a cue.
    preset: { wordsPerCue: 3 },
  },
  mixed: {
    tokens: [["Hello"], ["你"], ["好"], ["world"], ["再"], ["见"]],
    cues: ["Hello 你好 world", "再见"],
  },
};

function plannedCues(doc: ReturnType<typeof document>) {
  const result = planClipComposition({
    document: doc, captionLanguage: "zh",
    source: { identity: "source:scripts", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }, { id: "square", aspectRatio: "1:1", width: 1080, height: 1080 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan.targets.map((target) => target.visualLayers.flatMap((layer) => layer.kind === "caption"
    ? [{ ...captionCueVisibleRange(layer, result.plan.editedDurationSec), text: captionCueText(layer.words), language: layer.language }] : []));
}

describe("caption cues in no-space scripts", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    test(`${name}: burn-in layers and subtitle cues are one derivation, with no spurious spaces`, () => {
      const doc = document(fixture.tokens, fixture.preset);
      const exported = deriveCaptionCues(doc, { language: "zh" });
      expect(exported.map((cue) => cue.text)).toEqual(fixture.cues);
      for (const burned of plannedCues(doc)) expect(burned).toEqual(exported);
      const srt = formatSubtitles(exported, "srt");
      for (const cue of fixture.cues) expect(srt).toContain(`\n${cue}\n`);
    });
  }

  test("grouping is deterministic across runs", () => {
    const doc = document(FIXTURES.zh!.tokens);
    expect(deriveCaptionCues(doc)).toEqual(deriveCaptionCues(doc));
  });

  test("wordsPerCue scales the character budget", () => {
    const cues = deriveCaptionCues(document(chars("今天天气很好我们去公园玩"), { wordsPerCue: 2 }));
    expect(cues.map((cue) => cue.text)).toEqual(["今天天气", "很好我们", "去公园玩"]);
  });

  test("an utterance without word timing is not split on whitespace", () => {
    const doc = document(chars("你好"));
    const bare = { ...doc, transcriptSlice: [{ ...doc.transcriptSlice[0]!, text: "今天  天气很好。", words: [] }] };
    expect(deriveCaptionCues(bare).map((cue) => cue.text)).toEqual(["今天 天气很好。"]);
  });
});

describe("effective caption language", () => {
  test("rides on every cue and caption layer", () => {
    const doc = document([["istanbul"]], { textTransform: "uppercase" });
    expect(deriveCaptionCues(doc, { language: "tr" })).toMatchObject([{ text: "İSTANBUL", language: "tr" }]);
    expect(deriveCaptionCues(doc)).toMatchObject([{ text: "ISTANBUL", language: null }]);
    expect(deriveCaptionCues(doc, { language: "en" })).toMatchObject([{ text: "ISTANBUL", language: "en" }]);
  });

  test("Turkish and German casing", () => {
    const tr = document([["ılık"], ["iyi"]], { textTransform: "uppercase" });
    expect(deriveCaptionCues(tr, { language: "tr" })[0]!.text).toBe("ILIK İYİ");
    const de = document([["straße"]], { textTransform: "uppercase" });
    expect(deriveCaptionCues(de, { language: "de" })[0]!.text).toBe("STRASSE");
  });

  test("the plan carries the language onto its caption layers", () => {
    for (const burned of plannedCues(document(FIXTURES.zh!.tokens))) {
      expect(burned.every((cue) => cue.language === "zh")).toBe(true);
    }
  });
});
