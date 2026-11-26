import {
  captionEmojiRefOnWord,
  captionPresetSchema,
  captionWordKey,
  editorDocumentSchema,
  getCaptionPresetById,
  studioEditsSchema,
  type EditorDocument,
  type TranscriptUtterance,
} from "@narriflow/validators";

// A podcast-like clip for the subtitle panel's tests and measurements: two speakers,
// natural word lengths and pauses, about 180 s in English (or a shorter Urdu passage).

const ENGLISH = [
  "Of course.",
  "Um, and I've assured them that I think the whole point is the foundation.",
  "It's a springboard.",
  "Like, once you take your eye off your content on YouTube, you lose all of the advantages you have for being a creator.",
  "Right.",
  "Because you have no way to get people to see your show or to keep them interested in you.",
  "So my plan is to keep making weekly uploads.",
  "It's gonna be hard, but that's my plan.",
  "Do you think YouTube would ever bring back its own originals to combat this?",
  "I don't know.",
  "I think the fact that creators are making these shows reflects well on the platform.",
  "The money is real now, and the audience follows the person, not the channel.",
  "We threw a huge party for the whole team when we hit a million.",
  "Honestly it felt like magic, the first idea that really worked.",
  "Then the next month was the hardest of my life.",
];

const URDU = [
  "یہ ایک خیال میرے کاروبار کے لیے سب کچھ بدل گیا",
  "ہم نے ایک مہینے میں سال سے زیادہ پیسے کمائے",
  "پوری ٹیم کو یہ بہت پسند آیا",
  "سچ کہوں تو یہ جادو جیسا لگا",
  "اگلا مہینہ میری زندگی کا سب سے مشکل وقت تھا",
];

/** Words that carry an emoji in the fixture, with the design each one shows. */
const EMOJI_WORDS: Readonly<Record<string, string>> = {
  "springboard.": "rocket",
  "money": "money-bag",
  "party": "party",
  "magic,": "sparkles",
  "idea": "bulb",
  "خیال": "bulb",
  "پیسے": "money-bag",
  "جادو": "sparkles",
};

export interface TranscriptFixtureOptions {
  readonly presetId?: string;
  readonly rtl?: boolean;
  /** Speech to fill, in seconds (the English script repeats); default one pass of the script. */
  readonly seconds?: number;
  /** none: no emojis; some: one per chosen word; two: also a second emoji on one caption. */
  readonly emojis?: "none" | "some" | "two";
  readonly emojisOn?: boolean;
}

function timed(sentences: readonly string[], seconds: number | undefined): TranscriptUtterance[] {
  let t = 0.2;
  const lines: TranscriptUtterance[] = [];
  for (let pass = 0; ; pass++) {
    for (const [at, sentence] of sentences.entries()) {
      if (seconds !== undefined ? t >= seconds : pass > 0) return lines;
      const speaker = Math.floor((pass * sentences.length + at) / 3) % 2;
      const words = sentence.split(" ").map((word, index) => {
        const duration = 0.16 + 0.04 * word.replace(/[^\p{L}]/gu, "").length + (index % 5 === 3 ? 0.06 : 0);
        const entry = { word, startSec: Math.round(t * 1000) / 1000, endSec: Math.round((t + duration) * 1000) / 1000, confidence: 0.98 };
        t += duration + (/[,.]$/.test(word) ? 0.16 : 0.04);
        return entry;
      });
      lines.push({
        index: lines.length,
        speaker,
        speakerLabel: `Speaker ${speaker + 1}`,
        startSec: words[0]!.startSec,
        endSec: words.at(-1)!.endSec,
        text: sentence,
        confidence: 0.98,
        words,
      });
      t += at % 4 === 3 ? 0.9 : 0.3;
    }
  }
}

export function transcriptFixtureDocument(options: TranscriptFixtureOptions = {}): EditorDocument {
  const slice = timed(options.rtl ? URDU : ENGLISH, options.seconds);
  const emojis = options.emojis ?? "some";
  const words = slice.flatMap((line) => line.words);
  const placed = emojis === "none" ? [] : words.filter((word) => EMOJI_WORDS[word.word] !== undefined);
  const captionEmojis = Object.fromEntries(placed.map((word) => [captionWordKey(word.startSec), captionEmojiRefOnWord({ id: EMOJI_WORDS[word.word]! }, word.word)]));
  if (emojis === "two") {
    // "huge" shares its caption with "party".
    const huge = words.find((word) => word.word === "huge");
    if (huge) captionEmojis[captionWordKey(huge.startSec)] = captionEmojiRefOnWord({ id: "flame" }, huge.word);
  }
  return editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: Math.ceil(slice.at(-1)!.endSec + 1),
    captionPreset: captionPresetSchema.parse({ ...getCaptionPresetById(options.presetId ?? "bold-pop")!.preset, emojis: options.emojisOn ?? emojis !== "none" }),
    transcriptSlice: slice,
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" }, captionEmojis }),
    brollUrl: null,
    deletedRanges: [],
  });
}
