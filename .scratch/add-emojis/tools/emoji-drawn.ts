// What the Emoji Layer draws of the AI's emojis (ticket 32): per clip file, runs the shipped tagger once
// (`tagCaptionEmojis`), keeps the picks at each density (`selectCaptionEmojiPicks`), stores them as the Studio does
// (`studioEdits.captionEmojis`), plans the clip (`planClipComposition`, 9:16 at 1080 x 1920) and builds its caption track
// with the emoji art loaded (`compileCompositionPlanCaptions`, the export's path; no rendering), and prints, per preset:
// emojis placed, drawn, and left out by the layer's reason (`no-time` is the late-word rule, `no-room` a slot that never
// cleared, `no-cue` a word no cue shows), plus those the plan resolved to no kept word.
//
//   bun .scratch/add-emojis/tools/emoji-drawn.ts --dir <clips dir> --only id,id [--presets default,headline,lyrics] [--out file.json]
//
// A preset is `default` (DEFAULT_CAPTION_PRESET) or a catalog preset id, applied as the Studio does (`applyCaptionPresetLook`).
// The key is OPENAI_API_KEY from the environment, else from apps/api/.dev.vars; it is never printed or written.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const v = await import(join(ROOT, "packages/validators/src/index.ts"));
const { planClipComposition } = await import(join(ROOT, "packages/composition-plan/src/index.ts"));
const { clipEmojiWords } = await import(join(ROOT, "packages/services/src/clip-emoji-suggestion.ts"));
const { tagCaptionEmojis } = await import(join(ROOT, "packages/services/src/clip-emoji-tagging.ts"));
const { loadPlanCaptionEmojiArt } = await import(join(ROOT, "apps/media/src/caption-emoji-ass.ts"));
const { compileCompositionPlanCaptions } = await import(join(ROOT, "apps/media/src/composition-ffmpeg-adapter.ts"));

const args = process.argv.slice(2);
const value = (name: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
const dir = value("dir");
const only = value("only")?.split(",");
if (!dir || !only) throw new Error("usage: emoji-drawn.ts --dir <clips dir> --only id,id [--presets default,headline,lyrics] [--out file.json]");
const presets = (value("presets") ?? "default,headline,lyrics").split(",");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: a local measuring script, not a Turborepo task.
const apiKey = process.env.OPENAI_API_KEY?.trim()
  || (/^OPENAI_API_KEY=(.*)$/m.exec(readFileSync(join(ROOT, "apps/api/.dev.vars"), "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "");
if (!apiKey) throw new Error("OPENAI_API_KEY is not set (environment or apps/api/.dev.vars)");
const DENSITIES = ["light", "balanced", "expressive"] as const;

const rows: Record<string, unknown>[] = [];
for (const id of only) {
  const file = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
  const clip = file.clip;
  const lang: string | null = file.lang ?? null;
  const base = { transcriptSlice: clip.transcriptSlice, clipStartSec: clip.startSec, clipEndSec: clip.endSec, deletedRanges: clip.deletedRanges ?? [], censorSegments: clip.censorSegments ?? [] };
  const { utterances, words } = clipEmojiWords(base);
  const outcome = await tagCaptionEmojis({ utterances, languageCode: lang, title: clip.title ?? null, deadline: Date.now() + 30_000 }, { apiKey });
  for (const density of DENSITIES) {
    const emojis = v.selectCaptionEmojiPicks(outcome.picks, words, density);
    for (const name of presets) {
      const named = name === "default" ? null : v.getCaptionPresetById(name);
      if (name !== "default" && !named) throw new Error(`unknown preset ${name}`);
      const captionPreset = { ...(named ? v.applyCaptionPresetLook(v.DEFAULT_CAPTION_PRESET, named) : v.DEFAULT_CAPTION_PRESET), emojis: true };
      const document = v.editorDocumentSchema.parse({ version: v.EDITOR_DOCUMENT_VERSION, ...base, captionPreset, brollUrl: null,
        studioEdits: v.studioEditsSchema.parse({ framing: { mode: "center" }, captionEmojis: emojis }) });
      const result = planClipComposition({
        document, ...(lang ? { captionLanguage: lang } : {}),
        source: { identity: `drawn:${id}`, kind: "video", width: 1920, height: 1080 },
        evidence: { automaticLayout: { state: "missing" } },
        assets: { backgroundImage: { state: "missing" } },
        capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
        targets: [{ id: "vertical", aspectRatio: "9:16", width: 1080, height: 1920 }],
      });
      if (result.status === "invalid") throw new Error(`plan rejected: ${result.error.code}`);
      const track = compileCompositionPlanCaptions(result.plan, "vertical", undefined, undefined, 30, await loadPlanCaptionEmojiArt(result.plan));
      const placed = Object.keys(emojis).length;
      const dropped = Object.values(track.emojis.dropped as Record<string, number>).reduce((sum, count) => sum + count, 0);
      const row = { clip: id, density, preset: name, placed, drawn: track.emojis.placed, dropped: track.emojis.dropped, unresolved: placed - track.emojis.placed - dropped,
        drawnShare: placed > 0 ? Math.round((1000 * track.emojis.placed) / placed) / 10 : null };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
}
const total = (filter: (row: Record<string, unknown>) => boolean) => {
  const subset = rows.filter(filter);
  const placed = subset.reduce((sum, row) => sum + (row.placed as number), 0);
  const drawn = subset.reduce((sum, row) => sum + (row.drawn as number), 0);
  return `${drawn} of ${placed} drawn (${placed > 0 ? Math.round((1000 * drawn) / placed) / 10 : 0}%)`;
};
console.log("");
for (const density of DENSITIES) console.log(`${density.padEnd(10)} ${total((row) => row.density === density)}`);
for (const name of presets) console.log(`${name.padEnd(10)} ${total((row) => row.preset === name)}`);
const out = value("out");
if (out) writeFileSync(out, `${JSON.stringify(rows, null, 1)}\n`);
