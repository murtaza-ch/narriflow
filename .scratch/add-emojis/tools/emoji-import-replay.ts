// Import budget of AI Caption Emojis (ticket 32): joins the clip files' kept words into one long source (30,000 words by
// default, the clips repeated in order, every word shifted so times stay increasing and Word Keys unique), runs the
// shipped tagger (`tagCaptionEmojis`) on it once under the import's deadline (selection preparation's 60 s), and prints
// wall time, requests (blocks), retried, failed, skipped, picks, tokens (and the cached share), 429 replies and cost.
// Model API only; nothing is written to the app.
//
//   bun .scratch/add-emojis/tools/emoji-import-replay.ts --dir <clips dir> [--words 30000] [--deadline 60] [--concurrency N]
//       [--language code] [--out file.json]
//
// `--concurrency` overrides `EMOJI_TAGGING_DEFAULTS.concurrency` for this run only. `--language` is the source's language
// (default none: the clips are English, Hindi and Urdu). The key is OPENAI_API_KEY from the environment, else from
// apps/api/.dev.vars; it is never printed or written.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const { clipEmojiWords } = await import(join(ROOT, "packages/services/src/clip-emoji-suggestion.ts"));
const { EMOJI_TAGGING_DEFAULTS, tagCaptionEmojis } = await import(join(ROOT, "packages/services/src/clip-emoji-tagging.ts"));
const v = await import(join(ROOT, "packages/validators/src/index.ts"));

const args = process.argv.slice(2);
const value = (name: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
const dir = value("dir");
if (!dir) throw new Error("usage: emoji-import-replay.ts --dir <clips dir> [--words 30000] [--deadline 60] [--concurrency N] [--language code] [--out file.json]");
const target = Number(value("words") ?? 30_000);
const deadlineSec = Number(value("deadline") ?? 60);
const concurrency = Number(value("concurrency") ?? EMOJI_TAGGING_DEFAULTS.concurrency);
const language = value("language") ?? null;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: a local measuring script, not a Turborepo task.
const apiKey = process.env.OPENAI_API_KEY?.trim()
  || (/^OPENAI_API_KEY=(.*)$/m.exec(readFileSync(join(ROOT, "apps/api/.dev.vars"), "utf8"))?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "");
if (!apiKey) throw new Error("OPENAI_API_KEY is not set (environment or apps/api/.dev.vars)");

/** gpt-6-luna list price, US dollars per million tokens, before cache discounts (as the eval script). */
const PRICE = { input: 0.1, output: 0.5 };
type Word = { word: string; startSec: number; endSec: number; confidence: number | null };
type Utterance = { index: number; speaker: number | null; speakerLabel: string; startSec: number; endSec: number; text: string; confidence: number | null; words: Word[] };

const clips = readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => {
  const clip = JSON.parse(readFileSync(join(dir, name), "utf8")).clip;
  return clipEmojiWords({ transcriptSlice: clip.transcriptSlice, clipStartSec: clip.startSec, clipEndSec: clip.endSec,
    deletedRanges: clip.deletedRanges ?? [], censorSegments: clip.censorSegments ?? [] }).utterances as Utterance[];
});
const source: Utterance[] = [];
let count = 0;
let offset = 0;
for (let at = 0; count < target; at++) {
  const utterances = clips[at % clips.length]!;
  const first = utterances[0]?.words[0]?.startSec ?? 0;
  let last = 0;
  for (const utterance of utterances) {
    if (count >= target) break;
    const words = utterance.words.slice(0, target - count).map((word) => ({ ...word, startSec: word.startSec - first + offset, endSec: word.endSec - first + offset }));
    if (words.length === 0) continue;
    source.push({ ...utterance, index: source.length, startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec, text: words.map((word) => word.word).join(" "), words });
    count += words.length;
    last = words.at(-1)!.endSec;
  }
  offset = Math.ceil(last) + 2;
}

interface Reply { status: number; input: number; cached: number; output: number; done: string }
const replies: Reply[] = [];
const pending: Promise<void>[] = [];
const recordingFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const response = await fetch(url, init);
  if (!response.body || response.status !== 200) { replies.push({ status: response.status, input: 0, cached: 0, output: 0, done: "-" }); return response; }
  const [mine, theirs] = response.body.tee();
  pending.push(new Response(mine).text().then((text) => {
    const line = text.split("\n").reverse().find((candidate) => candidate.startsWith("data: ") && /"response\.(completed|incomplete|failed)"/.test(candidate));
    const payload = line ? JSON.parse(line.slice(6)).response as { status?: string; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } } : null;
    replies.push({ status: 200, input: payload?.usage?.input_tokens ?? 0, cached: payload?.usage?.input_tokens_details?.cached_tokens ?? 0, output: payload?.usage?.output_tokens ?? 0, done: payload?.status ?? "cut" });
  }).catch(() => undefined));
  return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
}) as typeof fetch;

const { lines, blocks } = v.emojiTaggingBlocks(source, language, null);
const started = performance.now();
const outcome = await tagCaptionEmojis({ utterances: source, languageCode: language, title: null, deadline: Date.now() + deadlineSec * 1000 }, { apiKey, concurrency, fetch: recordingFetch });
const wallSec = (performance.now() - started) / 1000;
await Promise.all(pending);
const sum = (pick: (reply: Reply) => number) => replies.reduce((total, reply) => total + pick(reply), 0);
const cost = (sum((reply) => reply.input) * PRICE.input + sum((reply) => reply.output) * PRICE.output) / 1e6;
const result = {
  words: count, utterances: source.length, lines: lines.length, requestedLines: blocks.reduce((total: number, block: { lines: unknown[] }) => total + block.lines.length, 0),
  concurrency, deadlineSec, wallSec: Math.round(wallSec * 10) / 10,
  blocks: outcome.chunks, tagged: outcome.tagged, retried: outcome.retried, failed: outcome.failed, skipped: outcome.skipped, unsafe: outcome.unsafe, rateLimitedBlocks: outcome.rateLimited,
  picks: outcome.picks.length, requests: replies.length, http429: replies.filter((reply) => reply.status === 429).length, notCompleted: replies.filter((reply) => reply.status === 200 && reply.done !== "completed").length,
  tokens: { total: outcome.tokensUsed, input: sum((reply) => reply.input), cached: sum((reply) => reply.cached), output: sum((reply) => reply.output), largestReply: Math.max(0, ...replies.map((reply) => reply.output)) },
  cachedShare: Math.round((1000 * sum((reply) => reply.cached)) / Math.max(1, sum((reply) => reply.input))) / 10,
  costUsd: Math.round(cost * 10_000) / 10_000, costPer1000Words: Math.round((cost * 1_000_000) / count) / 1000,
};
console.log(JSON.stringify(result, null, 1));
const out = value("out");
if (out) writeFileSync(out, `${JSON.stringify({ ...result, replies, picks: outcome.picks }, null, 1)}\n`);
