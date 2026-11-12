// Accuracy through the PRODUCTION module (chunking, streaming, acceptance, agreement).
// usage: bun prod-eval.ts <units.json> <out.json>   (RESUME=<out.json> keeps finished units)
import { FILLER_TAGGING_MODELS, tagTranscriptFillers } from "../../../packages/services/src/clip-filler-tagging.ts";
const [inFile, outFile] = process.argv.slice(2) as [string, string];
const key = (await Bun.file(new URL("../../../apps/api/.dev.vars", import.meta.url)).text()).match(/^OPENAI_API_KEY=(.*)$/m)![1]!.replace(/"/g, "").trim();
const units = JSON.parse(await Bun.file(inFile).text()) as any[];
const prev: any[] = Bun.env.RESUME && await Bun.file(Bun.env.RESUME).exists() ? JSON.parse(await Bun.file(Bun.env.RESUME).text()).results : [];
const keep = prev.filter((r) => r.outcome && r.outcome.failed === 0 && r.outcome.skipped === 0);
const done = new Set(keep.map((r) => r.clipId));
const results: any[] = [...keep];
const todo = units.filter((u) => !done.has(u.clipId));
let next = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: 10 }, async () => {
  while (next < todo.length) {
    const u = todo[next++]!;
    const utterances = u.slice.filter((s: any) => (s.words ?? []).length).map((s: any, i: number) => ({ index: i, speaker: s.speaker ?? null, speakerLabel: "S", startSec: s.words[0].startSec,
      endSec: s.words.at(-1).endSec, text: s.words.map((w: any) => w.word).join(" "), confidence: null, words: s.words.map((w: any) => ({ word: w.word, startSec: w.startSec, endSec: w.endSec, confidence: null })) }));
    const outcome = await tagTranscriptFillers(utterances, u.lang, { apiKey: key, models: FILLER_TAGGING_MODELS, deadline: Date.now() + 600_000, concurrency: 24, maxOutputTokens: 4000 });
    results.push({ clipId: u.clipId, lang: u.lang, outcome });
  }
}));
await Bun.write(outFile, JSON.stringify({ models: FILLER_TAGGING_MODELS, results }));
const sum = (k: string) => results.reduce((s, r) => s + r.outcome[k], 0);
console.log(`${results.length} units in ${((Date.now() - t0) / 1000).toFixed(0)} s; chunks ${sum("chunks")} tagged ${sum("tagged")} failed ${sum("failed")} skipped ${sum("skipped")} unsafe ${sum("unsafe")} tokens ${sum("tokensUsed")} keys ${results.reduce((s, r) => s + r.outcome.keys.length, 0)}`);
