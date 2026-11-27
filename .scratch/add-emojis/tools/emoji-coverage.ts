// Coverage of AI Caption Emojis on real clips (ticket 30): runs the shipped tagger (`tagCaptionEmojis`) and the
// shipped density rule (`selectCaptionEmojiPicks`) over clip files exported from the dev database, as the Studio
// suggest route does (`suggestClipEmojis`, its 30 s budget), and prints, per run and per language: emojis a minute at Light,
// Balanced and Expressive, runs with none at Balanced, the longest stretch without an emoji at Balanced, tokens
// and seconds a clip, and the largest reply. Model API only; nothing is written to the app.
//
//   bun .scratch/add-emojis/tools/emoji-coverage.ts --dir <clips dir> [--runs N] [--only id,id] [--show id,id]
//       [--concurrency 8] [--out file.json]
//
// A clip file is `{ lang, clip: { title, startSec, endSec, transcriptSlice, deletedRanges, censorSegments } }`.
// --show prints the Balanced emojis (glyph, word, edited second, strength) of the named clips on every run.
// The key is OPENAI_API_KEY from the environment, else from apps/api/.dev.vars; it is never printed or written.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const { captionEmojiById } = await import(join(ROOT, "packages/caption-emoji/src/index.ts"));
const v = await import(join(ROOT, "packages/validators/src/index.ts"));
const { clipEmojiWords } = await import(join(ROOT, "packages/services/src/clip-emoji-suggestion.ts"));
const { tagCaptionEmojis } = await import(join(ROOT, "packages/services/src/clip-emoji-tagging.ts"));

const args = process.argv.slice(2);
const value = (name: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
const dir = value("dir");
if (!dir) throw new Error("usage: emoji-coverage.ts --dir <clips dir> [--runs N] [--only id,id] [--show id,id] [--out file.json]");
const runs = Number(value("runs") ?? 1);
const only = value("only")?.split(",");
const show = new Set(value("show")?.split(",") ?? []);
const concurrency = Number(value("concurrency") ?? 8);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: a local measuring script, not a Turborepo task.
const apiKey = process.env.OPENAI_API_KEY?.trim()
  || (/^OPENAI_API_KEY=(.*)$/m.exec(readFileSync(join(ROOT, "apps/api/.dev.vars"), "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "");
if (!apiKey) throw new Error("OPENAI_API_KEY is not set (environment or apps/api/.dev.vars)");

const DENSITIES = ["light", "balanced", "expressive"] as const;
type Density = (typeof DENSITIES)[number];

/** gpt-6-luna list price, US dollars per million tokens, before cache discounts (as the eval script). */
const PRICE = { input: 0.1, output: 0.5 };
interface Reply { input: number; output: number; status: string }

/** Tokens and status of every reply, read from the stream's final event. */
function recordingFetch(replies: Reply[]): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(url, init);
    if (!response.body) return response;
    const [mine, theirs] = response.body.tee();
    void new Response(mine).text().then((text) => {
      const line = text.split("\n").reverse().find((candidate) => candidate.startsWith("data: ") && /"response\.(completed|incomplete|failed)"/.test(candidate));
      if (!line) { replies.push({ input: 0, output: 0, status: "cut" }); return; }
      const payload = JSON.parse(line.slice(6)).response as { status?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      replies.push({ input: payload.usage?.input_tokens ?? 0, output: payload.usage?.output_tokens ?? 0, status: payload.status ?? "?" });
    }).catch(() => undefined);
    return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}

interface Row {
  clip: string; run: number; lang: string; seconds: number; words: number; accepted: number; kept: Record<Density, number>;
  longestGap: number; tokens: number; ms: number; chunks: number; tagged: number; failed: number; retried: number;
  requests: number; input: number; output: number; maxOutput: number; notCompleted: number; balanced: string[];
}

const files = readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, ""))
  .filter((name) => !only || only.includes(name)).sort();
const jobs = files.flatMap((clip) => Array.from({ length: runs }, (_, run) => ({ clip, run: run + 1 })));
const rows: Row[] = [];
let next = 0;
async function work(): Promise<void> {
  for (let job = jobs[next++]; job; job = jobs[next++]) {
    const file = JSON.parse(readFileSync(join(dir!, `${job.clip}.json`), "utf8"));
    const clip = file.clip;
    const lang: string = file.lang ?? "unknown";
    const { utterances, words } = clipEmojiWords({ transcriptSlice: clip.transcriptSlice, clipStartSec: clip.startSec, clipEndSec: clip.endSec,
      deletedRanges: clip.deletedRanges ?? [], censorSegments: clip.censorSegments ?? [] });
    const replies: Reply[] = [];
    const started = performance.now();
    const outcome = await tagCaptionEmojis({ utterances, languageCode: lang, title: clip.title ?? null, deadline: Date.now() + 30_000 },
      { apiKey, fetch: recordingFetch(replies) });
    const ms = performance.now() - started;
    await new Promise((done) => setTimeout(done, 50));
    const atByKey = new Map<string, number>(words.map((word: { key: string; editedStartSec: number }) => [word.key, word.editedStartSec]));
    const wordByKey = new Map<string, string>(utterances.flatMap((utterance: { words: { word: string; startSec: number }[] }) =>
      utterance.words.map((word) => [v.captionWordKey(word.startSec), word.word] as const)));
    const strengthByKey = new Map<string, number>(outcome.picks.map((pick: { key: string; strength: number }) => [pick.key, pick.strength]));
    const seconds = Math.max(0, ...words.map((word: { editedStartSec: number }) => word.editedStartSec)) + 0.5;
    const kept = Object.fromEntries(DENSITIES.map((density) => [density, v.selectCaptionEmojiPicks(outcome.picks, words, density)])) as Record<Density, Record<string, { id: string }>>;
    const balancedKeys = Object.keys(kept.balanced).sort((left, right) => atByKey.get(left)! - atByKey.get(right)!);
    const times = [0, ...balancedKeys.map((key) => atByKey.get(key)!), seconds];
    rows.push({
      clip: job.clip, run: job.run, lang, seconds, words: words.length, accepted: outcome.picks.length,
      kept: Object.fromEntries(DENSITIES.map((density) => [density, Object.keys(kept[density]).length])) as Record<Density, number>,
      longestGap: Math.max(...times.slice(1).map((time, index) => time - times[index]!)),
      tokens: outcome.tokensUsed, ms, chunks: outcome.chunks, tagged: outcome.tagged, failed: outcome.failed, retried: outcome.retried,
      requests: replies.length, input: replies.reduce((sum, reply) => sum + reply.input, 0), output: replies.reduce((sum, reply) => sum + reply.output, 0),
      maxOutput: Math.max(0, ...replies.map((reply) => reply.output)), notCompleted: replies.filter((reply) => reply.status !== "completed").length,
      balanced: balancedKeys.map((key) => `${captionEmojiById(kept.balanced[key]!.id)?.glyph ?? kept.balanced[key]!.id} "${wordByKey.get(key) ?? "?"}" ${atByKey.get(key)!.toFixed(1)}s s${strengthByKey.get(key)}`),
    });
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, work));
rows.sort((left, right) => left.clip.localeCompare(right.clip) || left.run - right.run);

const pad = (text: string | number, width: number) => String(text).padStart(width);
console.log("clip           run  sec words acc  L  B  E  gap(B)  tokens     s  retried failed");
for (const row of rows) {
  console.log(`${row.clip.padEnd(14)} ${pad(row.run, 3)} ${pad(row.seconds.toFixed(0), 4)} ${pad(row.words, 5)} ${pad(row.accepted, 3)} ${pad(row.kept.light, 2)} ${pad(row.kept.balanced, 2)} ${pad(row.kept.expressive, 2)}  ${pad(row.longestGap.toFixed(1), 5)} s ${pad(row.tokens, 7)} ${pad((row.ms / 1000).toFixed(1), 5)}  ${pad(row.retried, 7)} ${pad(row.failed, 6)}`);
}
for (const row of rows.filter((candidate) => show.has(candidate.clip))) console.log(`${row.clip} run ${row.run} Balanced: ${row.balanced.join("  ") || "none"}`);

const summary = (label: string, subset: Row[]) => {
  if (subset.length === 0) return;
  const minutes = subset.reduce((sum, row) => sum + row.seconds, 0) / 60;
  const per = (density: Density) => (subset.reduce((sum, row) => sum + row.kept[density], 0) / minutes).toFixed(1);
  const none = subset.filter((row) => row.kept.balanced === 0).length;
  const gaps = subset.map((row) => row.longestGap).sort((left, right) => left - right);
  const mean = (pick: (row: Row) => number) => subset.reduce((sum, row) => sum + pick(row), 0) / subset.length;
  const words = subset.reduce((sum, row) => sum + row.words, 0) / 1000;
  const cost = subset.reduce((sum, row) => sum + row.input * PRICE.input + row.output * PRICE.output, 0) / 1e6;
  console.log(`${label.padEnd(4)} runs ${pad(subset.length, 3)} | per minute L/B/E ${per("light")} / ${per("balanced")} / ${per("expressive")} | none at B ${none} (${Math.round((100 * none) / subset.length)}%) | longest gap at B median ${gaps[Math.floor(gaps.length / 2)]!.toFixed(1)} s, worst ${gaps.at(-1)!.toFixed(1)} s | tokens/clip ${Math.round(mean((row) => row.tokens))} | s/clip ${(mean((row) => row.ms) / 1000).toFixed(1)} (max ${(Math.max(...subset.map((row) => row.ms)) / 1000).toFixed(1)}) | retried ${subset.reduce((sum, row) => sum + row.retried, 0)}, failed ${subset.reduce((sum, row) => sum + row.failed, 0)} of ${subset.reduce((sum, row) => sum + row.chunks, 0)} chunks | largest reply ${Math.max(...subset.map((row) => row.maxOutput))} tokens, not completed ${subset.reduce((sum, row) => sum + row.notCompleted, 0)} | per 1,000 words ${(subset.reduce((sum, row) => sum + row.requests, 0) / words).toFixed(1)} requests, ${Math.round(subset.reduce((sum, row) => sum + row.input, 0) / words)} input and ${Math.round(subset.reduce((sum, row) => sum + row.output, 0) / words)} output tokens, $${(cost / words).toFixed(4)}`);
};
console.log("");
summary("all", rows);
for (const lang of [...new Set(rows.map((row) => row.lang))].sort()) summary(lang, rows.filter((row) => row.lang === lang));
const out = value("out");
if (out) writeFileSync(out, `${JSON.stringify(rows, null, 1)}\n`);
