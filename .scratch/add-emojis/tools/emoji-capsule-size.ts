// Selection capsule size with emoji picks (ticket 32): builds a capsule as selection preparation freezes it for a source of
// `--words` words (the clip files' kept words repeated, as emoji-import-replay.ts joins them; the transcript is in the capsule
// twice, as utterances and as full text) with `--picks` emoji picks on its words (ids cycled over the AI vocabulary, each
// with its word, as acceptance stores them), encodes it with the shipped `encodeClipSelectionInput`, and prints its bytes
// with and without the picks beside the encoder's limit. `fitSelectionTags` drops the picks when the capsule is over it.
//
//   bun .scratch/add-emojis/tools/emoji-capsule-size.ts --dir <clips dir> [--words 27000] [--picks 12000]
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const { CAPTION_EMOJI_AI_GLYPHS, emojiRefForGlyph } = await import(join(ROOT, "packages/caption-emoji/src/index.ts"));
const v = await import(join(ROOT, "packages/validators/src/index.ts"));
const { clipEmojiWords } = await import(join(ROOT, "packages/services/src/clip-emoji-suggestion.ts"));
const { encodeClipSelectionInput } = await import(join(ROOT, "packages/services/src/clip-selection-input.ts"));

const args = process.argv.slice(2);
const value = (name: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
const dir = value("dir");
if (!dir) throw new Error("usage: emoji-capsule-size.ts --dir <clips dir> [--words 27000] [--picks 12000]");
const target = Number(value("words") ?? 27_000);
const pickCount = Number(value("picks") ?? 12_000);

type Word = { word: string; startSec: number; endSec: number; confidence: number | null };
type Utterance = { index: number; speaker: number | null; speakerLabel: string; startSec: number; endSec: number; text: string; confidence: number | null; words: Word[] };
const clips = readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => {
  const clip = JSON.parse(readFileSync(join(dir, name), "utf8")).clip;
  return clipEmojiWords({ transcriptSlice: clip.transcriptSlice, clipStartSec: clip.startSec, clipEndSec: clip.endSec, deletedRanges: clip.deletedRanges ?? [], censorSegments: [] }).utterances as Utterance[];
});
const utterances: Utterance[] = [];
let count = 0;
let offset = 0;
for (let at = 0; count < target; at++) {
  const source = clips[at % clips.length]!;
  const first = source[0]?.words[0]?.startSec ?? 0;
  let last = 0;
  for (const utterance of source) {
    if (count >= target) break;
    const words = utterance.words.slice(0, target - count).map((word) => ({ ...word, startSec: Math.round((word.startSec - first + offset) * 1000) / 1000, endSec: Math.round((word.endSec - first + offset) * 1000) / 1000 }));
    if (words.length === 0) continue;
    utterances.push({ ...utterance, index: utterances.length, startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec, text: words.map((word) => word.word).join(" "), words });
    count += words.length;
    last = words.at(-1)!.endSec;
  }
  offset = Math.ceil(last) + 2;
}
const words = utterances.flatMap((utterance) => utterance.words);
const refs = (CAPTION_EMOJI_AI_GLYPHS as string[]).map((glyph) => emojiRefForGlyph(glyph)).filter(Boolean) as { id: string }[];
const step = words.length / pickCount;
const picks = Array.from({ length: Math.min(pickCount, words.length) }, (_, at) => {
  const word = words[Math.floor(at * step)]!;
  return { key: v.captionWordKey(word.startSec), ref: v.captionEmojiRefOnWord({ id: refs[at % refs.length]!.id }, word.word), strength: 1 + (at % 3) };
});
const durationSec = Math.ceil(words.at(-1)!.endSec);
const capsule = (emojiPicks: unknown) => ({ version: 1 as const,
  parent: { id: "00000000-0000-4000-8000-000000000001", projectId: "00000000-0000-4000-8000-000000000002", generation: 1, deploymentEpoch: 1, inputHash: "a".repeat(64) },
  transcript: { id: "00000000-0000-4000-8000-000000000003", generation: 1, attemptId: null, contentHash: "b".repeat(64), sourceRevision: 1, sourceAudioId: null, sourceAudioBindingHash: null },
  planning: { projectTitle: "A three-hour source", contentPack: v.contentPackSchema.parse({ outputTypes: ["short_clip"], clipCountTarget: 10, clipDurationSecTarget: 45, platformPlaybookVersion: "platform-playbook-v1", addEmojis: true }),
    sourceDurationSec: durationSec, sourceProbeDurationSec: durationSec, utterances, fullText: utterances.map((utterance) => utterance.text).join(" "), speakerCount: 2, sourceLanguageCode: "en", audienceDataLine: null },
  editor: { captionPreset: v.DEFAULT_CAPTION_PRESET, studioEdits: v.studioEditsSchema.parse({}), sourceDurationSec: durationSec, wholeSource: false,
    cleanup: { removeSilences: false, removeFillerWords: false, quietRanges: null, languageCode: "en", aiFillers: null }, emojiPicks, title: null },
  provider: { model: "gpt-6-luna", reasoningEffort: "medium", maxOutputTokens: 32000 }, systemPrompt: "x".repeat(20_000), responseSchemaHash: "c".repeat(64) });
const without = await encodeClipSelectionInput(capsule(null));
const withPicks = await encodeClipSelectionInput(capsule(picks));
const limit = 16_777_216;
console.log(JSON.stringify({ words: count, utterances: utterances.length, durationSec, picks: picks.length, bytesWithoutPicks: without.byteLength, bytesWithPicks: withPicks.byteLength,
  pickBytes: withPicks.byteLength - without.byteLength, bytesPerPick: Math.round((withPicks.byteLength - without.byteLength) / picks.length), limit, shareOfLimit: Math.round((1000 * withPicks.byteLength) / limit) / 10 }, null, 1));
