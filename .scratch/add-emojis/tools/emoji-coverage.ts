// Coverage of AI Caption Emojis on real clips (tickets 30, 32): runs the shipped tagger (`tagCaptionEmojis`) and the
// shipped density rule (`selectCaptionEmojiPicks`) over clip files exported from the dev database, as the Studio
// suggest route does (`suggestClipEmojis`, its 30 s budget), and prints, per set (all; ordinary = all but `ur-7c9d-01`,
// a climber's death; per language; per run): emojis a minute at Light, Balanced and Expressive, the lowest clip at
// Balanced, runs under 10 a minute at Balanced, runs with none, the longest stretch without an emoji, the share of
// requested caption lines left with a candidate, tokens (and the cached share of input) and seconds a clip, and the
// largest reply. Model API only; nothing is written to the app.
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
interface Reply { input: number; cached: number; output: number; status: string; silent: number }

/** Lines a reply marks silent: "X" values and lines inside its `silent` ranges. */
function silentLines(text: string): number {
  try {
    const report = JSON.parse(text) as { silent?: { from: number; to: number }[]; lines?: Record<string, string> };
    const values = Object.values(report.lines ?? {});
    const silent: Set<number> = v.emojiSilentRangeLines(report.silent ?? [], values.length);
    values.forEach((value, n) => { if (value.trim().toUpperCase() === "X") silent.add(n); });
    return silent.size;
  } catch { return 0; }
}

/** Tokens and status of every reply, read from the stream's final event. */
function recordingFetch(replies: Reply[]): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(url, init);
    if (!response.body) return response;
    const [mine, theirs] = response.body.tee();
    void new Response(mine).text().then((text) => {
      const line = text.split("\n").reverse().find((candidate) => candidate.startsWith("data: ") && /"response\.(completed|incomplete|failed)"/.test(candidate));
      if (!line) { replies.push({ input: 0, cached: 0, output: 0, status: "cut", silent: 0 }); return; }
      const payload = JSON.parse(line.slice(6)).response as { status?: string; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
        output?: { content?: { text?: string }[] }[] };
      const output = payload.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("") ?? "";
      replies.push({ input: payload.usage?.input_tokens ?? 0, cached: payload.usage?.input_tokens_details?.cached_tokens ?? 0, output: payload.usage?.output_tokens ?? 0, status: payload.status ?? "?", silent: silentLines(output) });
    }).catch(() => undefined);
    return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}

interface Row {
  clip: string; run: number; lang: string; seconds: number; words: number; accepted: number; kept: Record<Density, number>;
  longestGap: number; tokens: number; ms: number; chunks: number; tagged: number; failed: number; retried: number;
  requests: number; input: number; cached: number; output: number; maxOutput: number; notCompleted: number; balanced: string[];
  /** Caption lines requested (they have an anchor), and those left with an accepted pick. */
  requested: number; withCandidate: number;
  /** Lines the last reply marked silent (before the 6-line carry). */
  silent: number;
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
    const { lines } = v.emojiTaggingBlocks(utterances, lang, clip.title ?? null);
    const pickedKeys = new Set(outcome.picks.map((pick: { key: string }) => pick.key));
    const requestedLines = lines.filter((line: { words: { anchor: string | null }[] }) => line.words.some((each) => each.anchor !== null));
    const withCandidate = requestedLines.filter((line: { words: { word: { startSec: number } }[] }) => line.words.some((each) => pickedKeys.has(v.captionWordKey(each.word.startSec)))).length;
    const kept = Object.fromEntries(DENSITIES.map((density) => [density, v.selectCaptionEmojiPicks(outcome.picks, words, density)])) as Record<Density, Record<string, { id: string }>>;
    const balancedKeys = Object.keys(kept.balanced).sort((left, right) => atByKey.get(left)! - atByKey.get(right)!);
    const times = [0, ...balancedKeys.map((key) => atByKey.get(key)!), seconds];
    rows.push({
      clip: job.clip, run: job.run, lang, seconds, words: words.length, accepted: outcome.picks.length,
      kept: Object.fromEntries(DENSITIES.map((density) => [density, Object.keys(kept[density]).length])) as Record<Density, number>,
      longestGap: Math.max(...times.slice(1).map((time, index) => time - times[index]!)),
      tokens: outcome.tokensUsed, ms, chunks: outcome.chunks, tagged: outcome.tagged, failed: outcome.failed, retried: outcome.retried,
      requests: replies.length, input: replies.reduce((sum, reply) => sum + reply.input, 0), cached: replies.reduce((sum, reply) => sum + reply.cached, 0),
      output: replies.reduce((sum, reply) => sum + reply.output, 0), requested: requestedLines.length, withCandidate, silent: replies.at(-1)?.silent ?? 0,
      maxOutput: Math.max(0, ...replies.map((reply) => reply.output)), notCompleted: replies.filter((reply) => reply.status !== "completed").length,
      balanced: balancedKeys.map((key) => `${captionEmojiById(kept.balanced[key]!.id)?.glyph ?? kept.balanced[key]!.id} "${wordByKey.get(key) ?? "?"}" ${atByKey.get(key)!.toFixed(1)}s s${strengthByKey.get(key)}`),
    });
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, work));
rows.sort((left, right) => left.clip.localeCompare(right.clip) || left.run - right.run);

const pad = (text: string | number, width: number) => String(text).padStart(width);
console.log("clip           run  sec words lines silent acc  L  B  E  gap(B)  tokens     s  retried failed");
for (const row of rows) {
  console.log(`${row.clip.padEnd(14)} ${pad(row.run, 3)} ${pad(row.seconds.toFixed(0), 4)} ${pad(row.words, 5)} ${pad(row.requested, 5)} ${pad(row.silent, 6)} ${pad(row.accepted, 3)} ${pad(row.kept.light, 2)} ${pad(row.kept.balanced, 2)} ${pad(row.kept.expressive, 2)}  ${pad(row.longestGap.toFixed(1), 5)} s ${pad(row.tokens, 7)} ${pad((row.ms / 1000).toFixed(1), 5)}  ${pad(row.retried, 7)} ${pad(row.failed, 6)}`);
}
for (const row of rows.filter((candidate) => show.has(candidate.clip))) console.log(`${row.clip} run ${row.run} Balanced: ${row.balanced.join("  ") || "none"}`);

const summary = (label: string, subset: Row[]) => {
  if (subset.length === 0) return;
  const minutes = subset.reduce((sum, row) => sum + row.seconds, 0) / 60;
  const per = (density: Density) => (subset.reduce((sum, row) => sum + row.kept[density], 0) / minutes).toFixed(1);
  const balancedRate = (row: Row) => row.kept.balanced / (row.seconds / 60);
  const lowest = subset.slice().sort((left, right) => balancedRate(left) - balancedRate(right))[0]!;
  const under = subset.filter((row) => balancedRate(row) < 10).length;
  const none = subset.filter((row) => row.kept.balanced === 0).length;
  const gaps = subset.map((row) => row.longestGap).sort((left, right) => left - right);
  const total = (pick: (row: Row) => number) => subset.reduce((sum, row) => sum + pick(row), 0);
  const words = total((row) => row.words) / 1000;
  const cost = total((row) => row.input * PRICE.input + row.output * PRICE.output) / 1e6;
  console.log(`${label.padEnd(8)} runs ${pad(subset.length, 3)} | per minute L/B/E ${per("light")} / ${per("balanced")} / ${per("expressive")} | lowest at B ${balancedRate(lowest).toFixed(1)} (${lowest.clip} run ${lowest.run}) | under 10/min at B ${under} | none at B ${none} | longest gap at B median ${gaps[Math.floor(gaps.length / 2)]!.toFixed(1)} s, worst ${gaps.at(-1)!.toFixed(1)} s | lines with a candidate ${Math.round((100 * total((row) => row.withCandidate)) / Math.max(1, total((row) => row.requested)))}% | tokens/clip ${Math.round(total((row) => row.tokens) / subset.length)}, cached ${Math.round((100 * total((row) => row.cached)) / Math.max(1, total((row) => row.input)))}% of input | s/clip ${(total((row) => row.ms) / subset.length / 1000).toFixed(1)} (max ${(Math.max(...subset.map((row) => row.ms)) / 1000).toFixed(1)}) | retried ${total((row) => row.retried)}, failed ${total((row) => row.failed)} of ${total((row) => row.chunks)} requests | largest reply ${Math.max(...subset.map((row) => row.maxOutput))} tokens, not completed ${total((row) => row.notCompleted)} | per 1,000 words ${(total((row) => row.requests) / words).toFixed(1)} requests, ${Math.round(total((row) => row.input) / words)} input and ${Math.round(total((row) => row.output) / words)} output tokens, $${(cost / words).toFixed(4)}`);
};
console.log("");
const ordinary = rows.filter((row) => row.clip !== "ur-7c9d-01");
summary("all", rows);
summary("ordinary", ordinary);
for (const lang of [...new Set(rows.map((row) => row.lang))].sort()) summary(lang, ordinary.filter((row) => row.lang === lang));
for (const run of [...new Set(rows.map((row) => row.run))]) summary(`run ${run}`, ordinary.filter((row) => row.run === run));
const out = value("out");
if (out) writeFileSync(out, `${JSON.stringify(rows, null, 1)}\n`);
