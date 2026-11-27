/**
 * Emoji relevance evaluation (Add Emojis ticket 20): runs the real tagger and the real density rule
 * over the real clips and written transcripts in four languages, and writes a report of every pick
 * (sentence, word, glyph, catalog name, strength, which densities keep it), every glyph the catalog
 * lacks, malformed picks, picks per minute, tokens, cost and time. Calls the model API only; never
 * part of the test suite.
 *
 *   bun packages/services/scripts/emoji-tagging-eval.ts --out <dir> [--label name] [--only id,id]
 *       [--runs N] [--labels a.json,b.json] [--judge]
 *   bun packages/services/scripts/emoji-tagging-eval.ts --out <dir> --rejudge <report.json> [--labels ...]
 *   bun packages/services/scripts/emoji-tagging-eval.ts --out <dir> --rescore <report.json> --labels ... (no model call)
 *
 * Grades: A the emoji depicts the word it sits on, in the right tone; B right picture, wrong word;
 * C does not fit; D fits the word, wrong tone. `--labels` reads hand grades keyed
 * `transcript|wordKey|emojiId` (A to D; the first agent's `word`/`sentence`/`miss` read as A/B/C).
 * `--judge` asks a second model pass for a grade per pick (`EMOJI_JUDGE_PROMPT`) and reports how
 * often it agrees with the hand grades; hand grades win in the rates. `--rejudge` grades an existing
 * report's picks without tagging again (to check the judge on old hand labels); `--rescore` re-reads
 * the hand grades into a report and writes it again.
 *
 * The key is OPENAI_API_KEY from the environment, else from `apps/api/.dev.vars`; it is never
 * printed or written. Everything but the model's answers is deterministic (synthesised word times,
 * fixed order).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { captionEmojiById, emojiRefForGlyph } from "@narriflow/caption-emoji/index";
import {
  acceptEmojiPicks,
  CAPTION_EMOJI_DENSITIES,
  CAPTION_EMOJI_NEGATION_IDS,
  captionWordComparable,
  captionWordKey,
  chunkTranscriptForEmojiTagging,
  selectCaptionEmojiPicks,
  type CaptionEmojiDensity,
} from "@narriflow/validators";
import { clipEmojiWords } from "../src/clip-emoji-suggestion";
import { EMOJI_TAGGING_MODEL, EMOJI_TAGGING_SYSTEM_PROMPT, tagCaptionEmojis } from "../src/clip-emoji-tagging";
import { requestTaggingReport } from "../src/transcript-tagging-request";
import { REAL_CLIPS, realTranscript, WRITTEN_SCRIPTS, writtenTranscript, type EvalTranscript } from "./emoji-tagging-eval/fixtures";
import { NEGATION_TARGETS } from "./emoji-tagging-eval/fixtures-negation";

const ROOT = resolve(import.meta.dir, "../../..");
/** gpt-6-luna list price, US dollars per million tokens; cached input is reported, not discounted. */
const PRICE = { input: 0.1, output: 0.5 };
const DENSITIES = Object.keys(CAPTION_EMOJI_DENSITIES) as CaptionEmojiDensity[];
const GRADES = ["A", "B", "C", "D"] as const;
export type Grade = (typeof GRADES)[number];

export interface EvalPick {
  run: number;
  key: string;
  word: string;
  sentence: string;
  /** The sentences before and after, for the judge. */
  before: string;
  after: string;
  glyph: string;
  id: string;
  name: string;
  strength: number;
  /** Whether each density keeps it. */
  kept: Record<CaptionEmojiDensity, boolean>;
  hand: Grade | null;
  judge: { grade: Grade; serious: boolean } | null;
}

export interface EvalRun {
  run: number;
  chunks: number;
  failed: number;
  retried: number;
  wallMs: number;
  tokens: { input: number; cached: number; output: number; reasoning: number };
  /** Model picks before acceptance: how many, and how many were dropped for each reason (`rule`: a number, filler or
   *  function word, or a second pick on a word that kept a stronger or earlier one). */
  raw: number;
  dropped: { malformed: number; unknownGlyph: number; serious: number; absent: number; loose?: number; rule: number };
  /** Well-formed picks the model itself marked absent (`p: "no"`, unless the emoji pictures "no") or only related (`s: 1`), which acceptance drops. */
  absentDrops?: { key: string; word: string; glyph: string; sentence: string }[];
  looseDrops?: { key: string; word: string; glyph: string; sentence: string }[];
  /** Glyphs the catalog has no design for, with the word each sat on. */
  unknown: { glyph: string; word: string }[];
  serious: string[];
  perMinute: Record<CaptionEmojiDensity, number>;
}

export interface EvalTranscriptReport {
  id: string;
  language: string;
  genre: string;
  words: number;
  minutes: number;
  runs: EvalRun[];
  picks: EvalPick[];
}

export interface EvalReport {
  label: string;
  model: string;
  reasoning: string;
  systemPrompt: { chars: number; sha256: string };
  judge: { model: string; reasoning: string; tokens: { input: number; output: number } } | null;
  transcripts: EvalTranscriptReport[];
}

interface Captured {
  user: string;
  report: unknown;
  usage: { input: number; cached: number; output: number; reasoning: number };
}

/** A fetch that records each request's user message, its parsed report and its token usage. */
function recordingFetch(captured: Captured[], pending: Promise<void>[], base: typeof fetch): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const response = await base(url, init);
    if (!response.body) return response;
    const user = (JSON.parse(String(init?.body ?? "{}")) as { input?: { role: string; content: string }[] }).input?.find((item) => item.role === "user")?.content ?? "";
    const [mine, theirs] = response.body.tee();
    pending.push(new Response(mine).text().then((text) => {
      const line = text.split("\n").find((candidate) => candidate.startsWith("data: ") && candidate.includes('"response.completed"'));
      if (!line) return;
      const payload = JSON.parse(line.slice(6)).response as {
        usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
        output?: { content?: { text?: string }[] }[];
      };
      const outputText = payload.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("") ?? "";
      let report: unknown = null;
      try { report = JSON.parse(outputText); } catch { /* counted as a failed chunk by the tagger */ }
      const usage = payload.usage;
      captured.push({ user, report, usage: { input: usage?.input_tokens ?? 0, cached: usage?.input_tokens_details?.cached_tokens ?? 0, output: usage?.output_tokens ?? 0, reasoning: usage?.output_tokens_details?.reasoning_tokens ?? 0 } });
    }).catch(() => undefined));
    return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}

const labelKey = (transcript: string, key: string, id: string) => `${transcript}|${key}|${id}`;

/** One tagging run of one transcript: the picks (graded by hand where a label exists) and the run's numbers. */
async function tagOnce(transcript: EvalTranscript, run: number, apiKey: string, hand: Record<string, Grade>, base: typeof fetch): Promise<{ run: EvalRun; picks: EvalPick[]; words: number; minutes: number }> {
  const { utterances, words } = clipEmojiWords(transcript.document as Parameters<typeof clipEmojiWords>[0]);
  const chunks = chunkTranscriptForEmojiTagging(utterances, transcript.languageCode, transcript.title);
  const captured: Captured[] = [];
  const pending: Promise<void>[] = [];
  const started = performance.now();
  const outcome = await tagCaptionEmojis({ utterances, languageCode: transcript.languageCode, title: transcript.title, deadline: Date.now() + 90_000 },
    { apiKey, fetch: recordingFetch(captured, pending, base) });
  const wallMs = Math.round(performance.now() - started);
  await Promise.all(pending);

  const sentences: { text: string; keys: string[] }[] = [];
  const at = new Map<string, number>();
  const wordByKey = new Map<string, string>();
  const dropped = { malformed: 0, unknownGlyph: 0, serious: 0, absent: 0, loose: 0, rule: 0 };
  const absentDrops: NonNullable<EvalRun["absentDrops"]> = [];
  const looseDrops: NonNullable<EvalRun["looseDrops"]> = [];
  const unknown: EvalRun["unknown"] = [];
  const serious: string[] = [];
  let raw = 0;
  const accepted = new Set(outcome.picks.map((pick) => pick.key));
  for (const chunk of chunks) {
    const lines = new Map<number, typeof chunk.tokens>();
    for (const token of chunk.tokens) lines.set(token.line, [...(lines.get(token.line) ?? []), token]);
    for (const tokens of lines.values()) {
      const keys = tokens.map((token) => captionWordKey(token.word.startSec));
      keys.forEach((key, index) => { at.set(key, sentences.length); wordByKey.set(key, tokens[index]!.word.word); });
      sentences.push({ text: tokens.map((token) => token.word.word).join(" "), keys });
    }
    if (chunk.prompt === null) continue;
    // The reply the tagger used: the last one it could accept (a failed retry after an empty reply keeps the first).
    const reply = captured.findLast((item) => item.user === chunk.prompt && acceptEmojiPicks(chunk, item.report, emojiRefForGlyph, transcript.languageCode) !== null)?.report as { serious?: { from: number; to: number }[]; picks?: { k: number; w: string; p?: string; e: string; s: number }[] } | null | undefined;
    const ranges = (reply?.serious ?? []).map((range) => [range.from, range.to].sort((a, b) => a - b) as [number, number]);
    for (const [from, to] of ranges) serious.push(chunk.tokens.slice(from, to + 1).map((token) => token.word.word).join(" "));
    for (const pick of reply?.picks ?? []) {
      raw++;
      const token = Number.isInteger(pick.k) ? chunk.tokens[pick.k] : undefined;
      if (!token || captionWordComparable(pick.w) !== captionWordComparable(token.word.word) || captionWordComparable(pick.w) === "") dropped.malformed++;
      else if (ranges.some(([from, to]) => pick.k >= from && pick.k <= to)) dropped.serious++;
      else if (pick.p === "no" && !CAPTION_EMOJI_NEGATION_IDS.has(emojiRefForGlyph(pick.e)?.id ?? "")) {
        dropped.absent++;
        const key = captionWordKey(token.word.startSec);
        absentDrops.push({ key, word: token.word.word, glyph: pick.e, sentence: sentences[at.get(key) ?? -1]?.text ?? "" });
      } else if (pick.s === 1) {
        dropped.loose++;
        const key = captionWordKey(token.word.startSec);
        looseDrops.push({ key, word: token.word.word, glyph: pick.e, sentence: sentences[at.get(key) ?? -1]?.text ?? "" });
      }
      else if (!emojiRefForGlyph(pick.e)) { dropped.unknownGlyph++; unknown.push({ glyph: pick.e, word: token.word.word }); }
      else if (!accepted.has(captionWordKey(token.word.startSec))) dropped.rule++;
    }
  }

  const kept = Object.fromEntries(DENSITIES.map((density) => [density, selectCaptionEmojiPicks(outcome.picks, words, density)])) as Record<CaptionEmojiDensity, Record<string, unknown>>;
  const span = words.length > 0 ? words.at(-1)!.editedStartSec - words[0]!.editedStartSec + 0.5 : 0;
  const minutes = Math.round((span / 60) * 100) / 100;
  const picks = outcome.picks.map((pick): EvalPick => {
    const entry = captionEmojiById(pick.ref.id)!;
    const index = at.get(pick.key) ?? -1;
    return {
      run, key: pick.key, word: wordByKey.get(pick.key) ?? "", sentence: sentences[index]?.text ?? "", before: sentences[index - 1]?.text ?? "", after: sentences[index + 1]?.text ?? "",
      glyph: entry.glyph, id: entry.id, name: entry.name, strength: pick.strength,
      kept: Object.fromEntries(DENSITIES.map((density) => [density, pick.key in kept[density]])) as Record<CaptionEmojiDensity, boolean>,
      hand: hand[labelKey(transcript.id, pick.key, entry.id)] ?? null, judge: null,
    };
  });
  const tokens = captured.reduce((sum, item) => ({ input: sum.input + item.usage.input, cached: sum.cached + item.usage.cached, output: sum.output + item.usage.output, reasoning: sum.reasoning + item.usage.reasoning }), { input: 0, cached: 0, output: 0, reasoning: 0 });
  return {
    words: words.length, minutes, picks,
    run: { run, chunks: outcome.chunks, failed: outcome.failed, retried: outcome.retried, wallMs, tokens, raw, dropped, absentDrops, looseDrops, unknown, serious,
      perMinute: Object.fromEntries(DENSITIES.map((density) => [density, minutes > 0 ? Math.round((Object.keys(kept[density]).length / minutes) * 10) / 10 : 0])) as Record<CaptionEmojiDensity, number> },
  };
}

// ─── Judge ───────────────────────────────────────────────────────────────────

export const EMOJI_JUDGE_MODEL = { model: EMOJI_TAGGING_MODEL.model, reasoningEffort: "medium" };
export const EMOJI_JUDGE_PROMPT = `You check emojis that were placed on single words of a video's captions, in any language.
Each item gives the sentence, the sentences before and after it, the word the emoji sits on, the emoji and the name of its design. Grade each item:
A: the picture plainly depicts that exact word as it is meant in this sentence (a thing, an action or a feeling the word names, or the concrete meaning of a short fixed expression containing it), or plainly shows what the short phrase around the word says and sits on the word that completes that meaning (❌ on "work" in "it doesn't work", 🤷 on "know" in "nobody knew", 🐢 on "slowly" in "it moves so slowly", 📈 on "growing" in "sales keep growing"), and its tone suits the moment. A viewer who reads the phrase sees at once why it has this emoji.
B: the picture fits another word of the same sentence, not the word it sits on.
C: it fits neither the word nor what its phrase says: a topic association, a loose metaphor or pun, a literal picture of an idiom, a similar object standing in for the one named, a thing the phrase says is absent shown as present, a face on a word that names no feeling, or a name, number, filler or function word.
A face that shows the feeling or reaction a word names is A on that word (😕 on "strange", 😠 on "fight", 😍 on "beautiful"). When the feeling is named by a describing word, a face on the verb before it is B (a face on "felt" in "I felt nervous").
An object on the word that names it is A even when the word is part of a longer description (🔌 on "unplugged", 📱 on "screen" of a phone).
D: it depicts the word, but its tone is wrong for the moment (playful about something serious, celebrating something sad).
Also say whether the sentence itself is about death, an accident, injury, illness, grief, violence, abuse, disaster, war or crime, or about how people felt about such an event ("serious"); a neighbouring sentence on such a subject does not make it serious.
Be strict: when you hesitate between A and another grade, do not give A.`;
const JUDGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["grades"],
  properties: { grades: { type: "array", items: { type: "object", additionalProperties: false, required: ["i", "g", "serious"],
    properties: { i: { type: "integer" }, g: { type: "string", enum: [...GRADES] }, serious: { type: "boolean" } } } } },
} as const;

/** Grades `picks` in place, 30 per request; returns the tokens used. */
async function judgePicks(picks: readonly EvalPick[], apiKey: string, base: typeof fetch): Promise<{ input: number; output: number }> {
  const tokens = { input: 0, output: 0 };
  const batches = Array.from({ length: Math.ceil(picks.length / 30) }, (_, at) => picks.slice(at * 30, at * 30 + 30));
  await Promise.all(batches.map(async (batch) => {
    const user = batch.map((pick, i) => `Item ${i}\nBefore: ${pick.before || "(none)"}\nSentence: ${pick.sentence}\nAfter: ${pick.after || "(none)"}\nWord: ${pick.word}\nEmoji: ${pick.glyph} (${pick.name})`).join("\n\n");
    const captured: Captured[] = [];
    const pending: Promise<void>[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await requestTaggingReport({ apiKey, deadline: Date.now() + 120_000, maxOutputTokens: 16_000, fetch: recordingFetch(captured, pending, base) }, EMOJI_JUDGE_MODEL,
        { system: EMOJI_JUDGE_PROMPT, user, schemaName: "emoji_grades", schema: JUDGE_SCHEMA });
      await Promise.all(pending);
      if (result.kind !== "ok") continue;
      for (const grade of (result.report as { grades: { i: number; g: Grade; serious: boolean }[] }).grades) {
        const pick = batch[grade.i];
        if (pick) pick.judge = { grade: grade.g, serious: grade.serious };
      }
      break;
    }
    for (const item of captured) { tokens.input += item.usage.input; tokens.output += item.usage.output; }
  }));
  return tokens;
}

// ─── Running ─────────────────────────────────────────────────────────────────

function allTranscripts(): EvalTranscript[] {
  return [...REAL_CLIPS.map((clip) => realTranscript(ROOT, clip)).filter((found) => found !== null), ...WRITTEN_SCRIPTS.map(writtenTranscript)];
}

/** Every transcript (or the `only` ones), `runs` times each, at most `concurrency` runs at a time, in a fixed order. */
export async function runEmojiTaggingEval(options: { apiKey: string; label: string; only?: readonly string[]; runs?: number; hand?: Record<string, Grade>; judge?: boolean; fetch?: typeof fetch; concurrency?: number }): Promise<EvalReport> {
  const chosen = allTranscripts().filter((transcript) => !options.only || options.only.includes(transcript.id));
  const runs = options.runs ?? 1;
  const jobs = chosen.flatMap((transcript, index) => Array.from({ length: runs }, (_, run) => ({ transcript, index, run: run + 1 })));
  const results: Awaited<ReturnType<typeof tagOnce>>[] = new Array(jobs.length);
  let next = 0;
  const work = async () => {
    for (let at = next++; at < jobs.length; at = next++) {
      const job = jobs[at]!;
      results[at] = await tagOnce(job.transcript, job.run, options.apiKey, options.hand ?? {}, options.fetch ?? fetch);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 8, jobs.length) }, work));
  const transcripts = chosen.map((transcript, index): EvalTranscriptReport => {
    const mine = jobs.flatMap((job, at) => (job.index === index ? [results[at]!] : []));
    return { id: transcript.id, language: transcript.language, genre: transcript.genre, words: mine[0]?.words ?? 0, minutes: mine[0]?.minutes ?? 0, runs: mine.map((result) => result.run), picks: mine.flatMap((result) => result.picks) };
  });
  const judgeTokens = options.judge ? await judgePicks(transcripts.flatMap((transcript) => transcript.picks), options.apiKey, options.fetch ?? fetch) : null;
  return {
    label: options.label, model: EMOJI_TAGGING_MODEL.model, reasoning: EMOJI_TAGGING_MODEL.reasoningEffort,
    systemPrompt: { chars: EMOJI_TAGGING_SYSTEM_PROMPT.length, sha256: createHash("sha256").update(EMOJI_TAGGING_SYSTEM_PROMPT).digest("hex").slice(0, 16) },
    judge: judgeTokens ? { model: EMOJI_JUDGE_MODEL.model, reasoning: EMOJI_JUDGE_MODEL.reasoningEffort, tokens: judgeTokens } : null,
    transcripts,
  };
}

/**
 * The first agent's baseline report (`transcripts[].picks[]` with `key`, `word`, `sentence`,
 * `glyph`, `id`, `name`, `strength`, `kept`) as this script's picks, with neighbouring sentences
 * from the fixtures, so the judge can grade it.
 */
function picksFromOldReport(report: { transcripts: { id: string; picks: Omit<EvalPick, "run" | "before" | "after" | "hand" | "judge">[] }[] }, hand: Record<string, Grade>): EvalReport["transcripts"] {
  const byId = new Map(allTranscripts().map((transcript) => [transcript.id, transcript]));
  return report.transcripts.map((old) => {
    const transcript = byId.get(old.id)!;
    const lines = transcript.document.transcriptSlice.map((utterance) => utterance.words.map((word) => word.word).join(" "));
    const picks = old.picks.map((pick): EvalPick => {
      const line = lines.findIndex((text) => text === pick.sentence || text.includes(pick.sentence) || pick.sentence.includes(text));
      return { ...pick, run: 1, before: lines[line - 1] ?? "", after: lines[line + 1] ?? "", hand: hand[labelKey(old.id, pick.key, pick.id)] ?? null, judge: null };
    });
    return { id: old.id, language: transcript.language, genre: transcript.genre, words: 0, minutes: 0, runs: [], picks };
  });
}

// ─── Negation (ticket 27) ────────────────────────────────────────────────────

type NegationKind = "absent" | "advised" | "present";
const NINE = ["en-tech", "ur-business", "ur-comedy", "ur-fitness", "hi-business", "hi-tech", "hi-fitness", "ar-business", "ar-tech"];
let negationIndex: Map<string, NegationKind> | null = null;

/** What the line says about the word at `key` (NEGATION_TARGETS), or null; throws on a target that names no word. */
function negationOf(transcript: string, key: string): NegationKind | null {
  if (!negationIndex) {
    const index = new Map<string, NegationKind>();
    const byId = new Map(allTranscripts().map((found) => [found.id, found]));
    for (const [id, targets] of Object.entries(NEGATION_TARGETS)) {
      const found = byId.get(id);
      if (!found) continue; // a real clip that is not on this machine
      for (const kind of ["absent", "advised", "present"] as const) for (const target of targets[kind] ?? []) {
        const [, line, text, nth] = /^(\d+):(.+?)(?:#(\d+))?$/.exec(target) ?? [];
        const matches = found.document.transcriptSlice[Number(line)]?.words.filter((word) => captionWordComparable(word.word) === captionWordComparable(text ?? "")) ?? [];
        const chosen = nth ? matches.slice(Number(nth) - 1, Number(nth)) : matches;
        if (chosen.length === 0) throw new Error(`negation target ${id} ${target} names no word`);
        for (const word of chosen) index.set(`${id}|${captionWordKey(word.startSec)}`, kind);
      }
    }
    negationIndex = index;
  }
  return negationIndex.get(`${transcript}|${key}`) ?? null;
}

function negationMarkdown(report: EvalReport): string[] {
  const sets: [string, EvalTranscriptReport[]][] = [
    ["ticket 21's nine", report.transcripts.filter((transcript) => NINE.includes(transcript.id))],
    ["negation fixtures (new)", report.transcripts.filter((transcript) => transcript.genre.includes("(negation)"))],
    ["real clips", report.transcripts.filter((transcript) => transcript.genre.includes("(real)"))],
  ];
  const out = ["", "## Negation: picks kept on a word the line says is absent", "",
    "| Set | Absent kept L/B/E | Absent kept at B per run | Of those, an emoji of \"no\" | Advised kept L/B/E | Present targets kept at B | Other B picks: A of graded |", "| --- | --- | --- | --- | --- | --- | --- |"];
  const listed: string[] = [];
  for (const [name, transcripts] of sets) {
    if (transcripts.length === 0) continue;
    const runs = Math.max(0, ...transcripts.map((transcript) => transcript.runs.length));
    const on = (kind: NegationKind, density: CaptionEmojiDensity) => transcripts.flatMap((transcript) =>
      transcript.picks.filter((pick) => pick.kept[density] && negationOf(transcript.id, pick.key) === kind).map((pick) => ({ transcript, pick })));
    const absentByRun = Array.from({ length: runs }, (_, run) => on("absent", "balanced").filter(({ pick }) => pick.run === run + 1).length);
    let presentTargets = 0;
    let presentKept = 0;
    for (const transcript of transcripts) {
      const keys = new Set(transcript.picks.map((pick) => pick.key).concat(Object.keys(transcriptWordKeys(transcript.id))));
      for (const key of keys) {
        if (negationOf(transcript.id, key) !== "present") continue;
        presentTargets += transcript.runs.length;
        presentKept += new Set(transcript.picks.filter((pick) => pick.key === key && pick.kept.balanced).map((pick) => pick.run)).size;
      }
    }
    const others = transcripts.flatMap((transcript) => transcript.picks.filter((pick) => pick.kept.balanced && negationOf(transcript.id, pick.key) === null));
    const graded = others.filter((pick) => gradeOf(pick) !== null);
    const pictured = on("absent", "balanced").filter(({ pick }) => CAPTION_EMOJI_NEGATION_IDS.has(pick.id)).length;
    out.push(`| ${name} | ${DENSITIES.map((density) => on("absent", density).length).join(" / ")} | ${absentByRun.join(", ")} | ${pictured} | ${DENSITIES.map((density) => on("advised", density).length).join(" / ")} | ${presentTargets > 0 ? `${presentKept} of ${presentTargets}` : "-"} | ${graded.filter((pick) => gradeOf(pick) === "A").length} of ${graded.length} (${others.length} picks) |`);
    for (const kind of ["absent", "advised"] as const) for (const { transcript, pick } of on(kind, "balanced")) {
      listed.push(`- ${kind} r${pick.run} ${transcript.id} **${pick.word}** → ${pick.glyph} (s${pick.strength}) · ${pick.sentence}`);
    }
  }
  if (listed.length > 0) out.push("", "Kept at Balanced on an absent or advised word:", "", ...listed);
  const drops = report.transcripts.flatMap((transcript) => transcript.runs.flatMap((run) => (run.absentDrops ?? []).map((drop) => ({ transcript, run: run.run, drop }))));
  out.push("", `Picks the model marked absent and acceptance dropped: ${drops.length}.`);
  if (drops.length > 0) {
    out.push("");
    for (const { transcript, run, drop } of drops) out.push(`- [${negationOf(transcript.id, drop.key) ?? "not a target"}] r${run} ${transcript.id} **${drop.word}** → ${drop.glyph} · ${drop.sentence}`);
  }
  const loose = report.transcripts.flatMap((transcript) => transcript.runs.flatMap((run) => (run.looseDrops ?? []).map((drop) => ({ transcript, run: run.run, drop }))));
  if (loose.length > 0) {
    out.push("", `Picks the model marked only related (s1) and acceptance dropped: ${loose.length}.`, "");
    for (const { transcript, run, drop } of loose) out.push(`- r${run} ${transcript.id} **${drop.word}** → ${drop.glyph} · ${drop.sentence}`);
  }
  return out;
}

/** Every Word Key of a transcript's words, so present targets with no pick still count. */
function transcriptWordKeys(id: string): Record<string, true> {
  const found = allTranscripts().find((transcript) => transcript.id === id);
  return Object.fromEntries((found?.document.transcriptSlice ?? []).flatMap((utterance) => utterance.words.map((word) => [captionWordKey(word.startSec), true as const])));
}

// ─── Report ──────────────────────────────────────────────────────────────────

const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : "-");
const gradeOf = (pick: EvalPick): Grade | null => pick.hand ?? pick.judge?.grade ?? null;

/** Grade shares over `picks` (hand grade, else the judge's), and how many had neither. */
function rates(picks: readonly EvalPick[]): string {
  const graded = picks.filter((pick) => gradeOf(pick) !== null);
  return `${GRADES.map((grade) => percent(graded.filter((pick) => gradeOf(pick) === grade).length, graded.length)).join(" / ")} (${graded.length} of ${picks.length})`;
}

export function emojiTaggingEvalMarkdown(report: EvalReport): string {
  const out: string[] = [`# Emoji relevance: ${report.label}`, "",
    `Tagger ${report.model}, reasoning ${report.reasoning}; system prompt ${report.systemPrompt.chars} chars, sha256 ${report.systemPrompt.sha256}.${report.judge ? ` Judge ${report.judge.model}, reasoning ${report.judge.reasoning}.` : ""}`, ""];
  const languages = [...new Set(report.transcripts.map((transcript) => transcript.language))];
  const isMoments = (transcript: EvalTranscriptReport) => transcript.genre.includes("(badges)");
  const isNegation = (transcript: EvalTranscriptReport) => transcript.genre.includes("(negation)");
  // The badge-moment transcripts are reported apart, so the written and all rows compare with runs that had none.
  const groups: [string, EvalTranscriptReport[]][] = [
    ["real clips", report.transcripts.filter((transcript) => transcript.genre.includes("(real)"))],
    ...languages.map((language): [string, EvalTranscriptReport[]] => [`written ${language}`, report.transcripts.filter((transcript) => transcript.language === language && !transcript.genre.includes("(real)") && !isMoments(transcript) && !isNegation(transcript))]),
    ["all", report.transcripts.filter((transcript) => !isMoments(transcript) && !isNegation(transcript))],
    ["badge moments", report.transcripts.filter(isMoments)],
    ["negation (new)", report.transcripts.filter(isNegation)],
  ];
  out.push("## Rates: A depicts the word / B wrong word / C does not fit / D wrong tone", "",
    "| Set | Light | Balanced | Expressive | Per minute L/B/E | Malformed | Unknown glyph | Serious leaks at E (judge) | Failed chunks |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [name, transcripts] of groups) {
    if (transcripts.length === 0) continue;
    const picks = transcripts.flatMap((transcript) => transcript.picks);
    const runs = transcripts.flatMap((transcript) => transcript.runs);
    const perMinute = DENSITIES.map((density) => {
      const minutes = transcripts.reduce((sum, transcript) => sum + transcript.minutes * transcript.runs.length, 0);
      return minutes > 0 ? (picks.filter((pick) => pick.kept[density]).length / minutes).toFixed(1) : "-";
    }).join(" / ");
    const raw = runs.reduce((sum, run) => sum + run.raw, 0);
    const malformed = runs.reduce((sum, run) => sum + run.dropped.malformed, 0);
    const unknown = runs.reduce((sum, run) => sum + run.dropped.unknownGlyph, 0);
    const leaks = picks.filter((pick) => pick.judge?.serious && pick.kept.expressive).length;
    out.push(`| ${name} | ${rates(picks.filter((pick) => pick.kept.light))} | ${rates(picks.filter((pick) => pick.kept.balanced))} | ${rates(picks.filter((pick) => pick.kept.expressive))} | ${perMinute} | ${malformed} of ${raw} | ${unknown} of ${raw} (${percent(unknown, raw)}) | ${leaks} | ${runs.reduce((sum, run) => sum + run.failed, 0)} of ${runs.reduce((sum, run) => sum + run.chunks, 0)} |`);
  }
  const badgeShare = (picks: readonly EvalPick[]) => {
    const kept = picks.filter((pick) => pick.kept.balanced);
    const badges = kept.filter((pick) => captionEmojiById(pick.id)?.kind === "phrase");
    return `${badges.length} of ${kept.length} (${percent(badges.length, kept.length)}), ${rates(badges)} A/B/C/D`;
  };
  const real = report.transcripts.filter((transcript) => transcript.genre.includes("(real)")).flatMap((transcript) => transcript.picks);
  const moments = report.transcripts.filter(isMoments).flatMap((transcript) => transcript.picks);
  out.push("", `Phrase badges kept at Balanced: real clips ${badgeShare(real)}; all ${badgeShare(report.transcripts.filter((transcript) => !isMoments(transcript) && !isNegation(transcript)).flatMap((transcript) => transcript.picks))}; badge moments ${badgeShare(moments)}.`);
  out.push(...negationMarkdown(report));
  const judged = report.transcripts.flatMap((transcript) => transcript.picks).filter((pick) => pick.hand && pick.judge);
  if (judged.length > 0) {
    const same = judged.filter((pick) => pick.hand === pick.judge!.grade).length;
    const sameA = judged.filter((pick) => (pick.hand === "A") === (pick.judge!.grade === "A")).length;
    const falseA = judged.filter((pick) => pick.hand !== "A" && pick.judge!.grade === "A").length;
    out.push("", `Judge against hand grades: ${judged.length} picks, same grade ${percent(same, judged.length)}, same A-or-not ${percent(sameA, judged.length)}; the judge said A where the hand grade was not: ${falseA}.`);
  }
  const runs = report.transcripts.flatMap((transcript) => transcript.runs);
  if (runs.length > 0) {
    const tokens = runs.reduce((sum, run) => ({ input: sum.input + run.tokens.input, cached: sum.cached + run.tokens.cached, output: sum.output + run.tokens.output, reasoning: sum.reasoning + run.tokens.reasoning }), { input: 0, cached: 0, output: 0, reasoning: 0 });
    const words = report.transcripts.reduce((sum, transcript) => sum + transcript.words * transcript.runs.length, 0);
    const cost = (tokens.input * PRICE.input + tokens.output * PRICE.output) / 1e6;
    const walls = runs.map((run) => run.wallMs).sort((a, b) => a - b);
    out.push("", `Tagger tokens over ${words} words: ${tokens.input} input (${tokens.cached} cached), ${tokens.output} output (${tokens.reasoning} reasoning). At list price before cache discounts $${cost.toFixed(4)}, **$${((cost * 1000) / Math.max(1, words)).toFixed(4)} per 1,000 words**. Wall per transcript: median ${walls[Math.floor(walls.length / 2)]} ms, max ${walls.at(-1)} ms.`);
  }
  if (report.judge) out.push("", `Judge tokens: ${report.judge.tokens.input} input, ${report.judge.tokens.output} output.`);
  const glyphs = new Map<string, string[]>();
  for (const run of runs) for (const item of run.unknown) glyphs.set(item.glyph, [...(glyphs.get(item.glyph) ?? []), item.word]);
  if (glyphs.size > 0) {
    out.push("", "## Glyphs the catalog lacks", "", "| Glyph | Count | Words |", "| --- | --- | --- |");
    for (const [glyph, on] of [...glyphs].sort((left, right) => right[1].length - left[1].length)) out.push(`| ${glyph} | ${on.length} | ${on.join(", ")} |`);
  }
  for (const transcript of report.transcripts) {
    out.push("", `## ${transcript.id} (${transcript.language}, ${transcript.genre})`, "", `${transcript.words} words, ${transcript.minutes} min.`);
    for (const run of transcript.runs) {
      out.push(`- Run ${run.run}: ${run.chunks} chunk(s), ${run.failed} failed, ${run.retried} retried, ${run.wallMs} ms; per minute L ${run.perMinute.light} / B ${run.perMinute.balanced} / E ${run.perMinute.expressive}; ${run.raw} raw picks, dropped ${run.dropped.malformed} malformed, ${run.dropped.unknownGlyph} unknown glyph, ${run.dropped.serious} serious, ${run.dropped.absent ?? 0} marked absent, ${run.dropped.loose ?? 0} marked loose, ${run.dropped.rule} by rule.${run.serious.length > 0 ? ` Serious: ${run.serious.map((text) => `"${text}"`).join("; ")}` : ""}`);
    }
    out.push("");
    for (const pick of transcript.picks) {
      const densities = DENSITIES.filter((density) => pick.kept[density]).map((density) => density[0]!.toUpperCase()).join("");
      const grade = pick.hand ? `${pick.hand}${pick.judge ? `/j${pick.judge.grade}` : ""}` : pick.judge ? `j${pick.judge.grade}` : "?";
      const negation = negationOf(transcript.id, pick.key);
      out.push(`- [${grade}]${negation ? ` [${negation}]` : ""} r${pick.run} **${pick.word}** → ${pick.glyph} ${pick.name} (s${pick.strength}, ${densities || "-"}) · \`${labelKey(transcript.id, pick.key, pick.id)}\` · ${pick.sentence}`);
    }
  }
  return `${out.join("\n")}\n`;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** OPENAI_API_KEY from the environment, else from the API's local env file. Never logged. */
export function evalApiKey(): string {
  const fromEnv = process.env.OPENAI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = join(ROOT, "apps/api/.dev.vars");
  const line = existsSync(file) ? /^OPENAI_API_KEY=(.*)$/m.exec(readFileSync(file, "utf8"))?.[1] : undefined;
  return line?.trim().replace(/^["']|["']$/g, "") ?? "";
}

/** Hand grades from label files; the first agent's word/sentence/miss read as A/B/C. */
function readHandGrades(paths: readonly string[]): Record<string, Grade> {
  const legacy: Record<string, Grade> = { word: "A", sentence: "B", miss: "C" };
  const grades: Record<string, Grade> = {};
  for (const path of paths) {
    for (const [key, value] of Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, string>)) {
      const grade = (GRADES as readonly string[]).includes(value) ? (value as Grade) : legacy[value];
      if (grade) grades[key] = grade;
    }
  }
  return grades;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const out = option(args, "--out");
  if (!out) throw new Error("usage: emoji-tagging-eval.ts --out <dir> [--label name] [--only id,id] [--runs N] [--labels a.json,b.json] [--judge] | --rejudge <report.json> | --rescore <report.json>");
  const apiKey = evalApiKey();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set (environment or apps/api/.dev.vars)");
  const hand = readHandGrades(option(args, "--labels")?.split(",") ?? []);
  const label = option(args, "--label") ?? "report";
  const rejudge = option(args, "--rejudge");
  const rescore = option(args, "--rescore");
  let report: EvalReport;
  if (rescore) {
    report = JSON.parse(readFileSync(rescore, "utf8")) as EvalReport;
    for (const transcript of report.transcripts) for (const pick of transcript.picks) pick.hand = hand[labelKey(transcript.id, pick.key, pick.id)] ?? null;
  } else if (rejudge) {
    const transcripts = picksFromOldReport(JSON.parse(readFileSync(rejudge, "utf8")), hand);
    const tokens = await judgePicks(transcripts.flatMap((transcript) => transcript.picks), apiKey, fetch);
    report = { label, model: "(from report)", reasoning: "-", systemPrompt: { chars: 0, sha256: "-" }, judge: { model: EMOJI_JUDGE_MODEL.model, reasoning: EMOJI_JUDGE_MODEL.reasoningEffort, tokens }, transcripts };
  } else {
    report = await runEmojiTaggingEval({ apiKey, label, only: option(args, "--only")?.split(","), runs: Number(option(args, "--runs") ?? 1), hand, judge: args.includes("--judge") });
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(out, `${label}.md`), emojiTaggingEvalMarkdown(report));
  console.log(join(out, `${label}.md`));
}

if (import.meta.main) await main();
