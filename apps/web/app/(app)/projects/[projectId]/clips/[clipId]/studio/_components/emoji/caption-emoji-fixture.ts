import { planClipComposition, type CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import {
  type CaptionPreset,
  captionEmojiRefOnWord,
  captionPresetSchema,
  captionWordKey,
  editorDocumentSchema,
  type EditorDocument,
  getCaptionPresetById,
  studioEditsSchema,
} from "@narriflow/validators";

/**
 * A fixed clip with Caption Emojis, planned by the real composition plan: the emoji layer's tests read
 * the same layers the Studio would.
 */

const LTR_SCRIPT = [
  "This one idea changed everything for my business.",
  "We made more money in a month than in a year.",
  "The whole team loved it, and the customers did too.",
  "Honestly it felt like magic.",
];

const RTL_SCRIPT = [
  "یہ ایک خیال میرے کاروبار کے لیے سب کچھ بدل گیا",
  "ہم نے ایک مہینے میں سال سے زیادہ پیسے کمائے",
  "پوری ٹیم کو یہ بہت پسند آیا",
  "سچ کہوں تو یہ جادو جیسا لگا",
];

/**
 * The emojis each sentence carries, chosen by hand so every one illustrates the word it sits on
 * (a rendered test frame must never show an emoji that does not fit its word): the first pair
 * of a sentence is its emoji, the second is used only by the 20-emoji `long` run.
 */
const LTR_EMOJIS: readonly (readonly (readonly [word: string, id: string])[])[] = [
  [["idea", "bulb"], ["business.", "briefcase"]],
  [["money", "money-bag"], ["month", "calendar"]],
  [["team", "busts-in-silhouette"], ["loved", "heart-eyes"]],
  [["magic.", "sparkles"]],
];

const RTL_EMOJIS: readonly (readonly (readonly [word: string, id: string])[])[] = [
  [["خیال", "bulb"], ["کاروبار", "briefcase"]],
  [["پیسے", "money-bag"], ["مہینے", "calendar"]],
  [["ٹیم", "busts-in-silhouette"], ["پسند", "heart-eyes"]],
  [["جادو", "sparkles"]],
];

export interface EmojiFixtureOptions {
  readonly presetId: string;
  readonly rtl?: boolean;
  /** About 60 s of speech with 20 emojis (the layer's build budget), instead of four sentences. */
  readonly long?: boolean;
  /** Fields set over the named preset (an emoji palette, size, position). */
  readonly preset?: Partial<CaptionPreset>;
  readonly canvas?: { readonly width: number; readonly height: number };
  /** Ids that replace the hand-chosen ones in turn (an edit: the same anchors, other emojis). */
  readonly emojiIds?: readonly string[];
}

interface FixtureWord {
  readonly word: string;
  readonly startSec: number;
  readonly endSec: number;
}

function timedScript(sentences: readonly string[]): FixtureWord[][] {
  let t = 0.4;
  return sentences.map((sentence) => {
    const words = sentence.split(" ").map((word) => {
      const duration = 0.18 + 0.035 * word.replace(/[^\p{L}]/gu, "").length;
      const timed = { word, startSec: Math.round(t * 1000) / 1000, endSec: Math.round((t + duration) * 1000) / 1000 };
      t += duration + (/,$/.test(word) ? 0.18 : 0.04);
      return timed;
    });
    t += 0.4;
    return words;
  });
}

/** The fixture's editor document: timed sentences, the preset with emojis on, and the placed emojis. */
export function emojiFixtureDocument(options: EmojiFixtureOptions): EditorDocument {
  const base = options.rtl ? RTL_SCRIPT : LTR_SCRIPT;
  // 17 sentences are 60 s of speech.
  const sentences = options.long ? Array.from({ length: 17 }, (_, at) => base[at % base.length]!) : base;
  const utterances = timedScript(sentences);
  const chosen = options.rtl ? RTL_EMOJIS : LTR_EMOJIS;
  // Keyed by source start: each sentence's own emoji on its word, or 20 of all the pairs spread
  // evenly over the long run.
  const pairs = utterances.flatMap((words, at) => {
    const sentencePairs = chosen[at % chosen.length]!;
    return (options.long ? sentencePairs : sentencePairs.slice(0, 1)).map(([text, id]) => ({ word: words.find((word) => word.word === text)!, id }));
  });
  const anchors = options.long ? Array.from({ length: 20 }, (_, at) => pairs[Math.floor(((at + 0.5) * pairs.length) / 20)]!) : pairs;
  const captionEmojis = Object.fromEntries(anchors.map(({ word, id }, at) => [captionWordKey(word.startSec), captionEmojiRefOnWord({ id: options.emojiIds ? options.emojiIds[at % options.emojiIds.length]! : id }, word.word)]));
  const endSec = utterances.at(-1)!.at(-1)!.endSec + 1;
  return editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: endSec,
    captionPreset: captionPresetSchema.parse({ ...getCaptionPresetById(options.presetId)!.preset, ...options.preset, emojis: true }),
    transcriptSlice: utterances.map((words, index) => ({
      index,
      speaker: 0,
      speakerLabel: "Speaker 1",
      startSec: words[0]!.startSec,
      endSec: words.at(-1)!.endSec,
      confidence: 1,
      text: words.map((word) => word.word).join(" "),
      words: words.map((word) => ({ ...word, confidence: 1 })),
    })),
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, captionEmojis }),
    brollUrl: null,
    deletedRanges: [],
  });
}

/** `lines` subtitle lines of `wordsPerLine` words each, 0.3 s a word, no emojis: the transcript panel's scale. */
export function emojiFixtureManyLines(options: { readonly presetId: string; readonly lines: number; readonly wordsPerLine: number }): EditorDocument {
  const vocabulary = LTR_SCRIPT.join(" ").split(" ");
  let t = 0.4;
  const transcriptSlice = Array.from({ length: options.lines }, (_, index) => {
    const words = Array.from({ length: options.wordsPerLine }, (_, at) => {
      const word = { word: vocabulary[(index * options.wordsPerLine + at) % vocabulary.length]!, startSec: Math.round(t * 1000) / 1000, endSec: Math.round((t + 0.26) * 1000) / 1000, confidence: 1 };
      t += 0.3;
      return word;
    });
    t += 0.4;
    return { index, speaker: 0, speakerLabel: "Speaker 1", startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec, confidence: 1, text: words.map((word) => word.word).join(" "), words };
  });
  const document = emojiFixtureDocument({ presetId: options.presetId });
  return { ...document, clipEndSec: t + 1, transcriptSlice, studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }) };
}

/** The caption layers the real composition plan builds for a document. */
export function emojiFixtureLayersFor(document: EditorDocument, options: Pick<EmojiFixtureOptions, "rtl" | "canvas">): CompositionCaptionVisualLayer[] {
  const canvas = options.canvas ?? { width: 1080, height: 1920 };
  const result = planClipComposition({
    document,
    captionLanguage: options.rtl ? "ur" : "en",
    source: { identity: "source:caption-emojis", kind: "video", width: 1920, height: 1080 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" }, music: {} },
    capabilities: { automaticSpeakerLayout: false, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "target", aspectRatio: canvas.width === canvas.height ? "1:1" : canvas.width > canvas.height ? "16:9" : "9:16", width: canvas.width, height: canvas.height }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan.targets[0]!.visualLayers.filter((layer): layer is CompositionCaptionVisualLayer => layer.kind === "caption");
}

export function emojiFixtureLayers(options: EmojiFixtureOptions): CompositionCaptionVisualLayer[] {
  return emojiFixtureLayersFor(emojiFixtureDocument(options), options);
}
