// Evaluation harness: AI tagging of hesitation fillers on real dev clip transcripts.
// usage: bun run.ts <model> <effort> <outFile> [langs=en,hi,ur]
const [model, effort, outFile, langsArg] = process.argv.slice(2) as [string, string, string, string?];
const langs = new Set((langsArg ?? "en,hi,ur").split(","));
const dir = import.meta.dir;
const key = (await Bun.file(new URL("../../../apps/api/.dev.vars", import.meta.url)).text()).match(/^OPENAI_API_KEY=(.*)$/m)![1]!.replace(/"/g, "").trim();
const clips = (JSON.parse(await Bun.file(`${dir}/${Bun.env.INPUT ?? "clips-unique.json"}`).text()) as any[]).filter((c) => Bun.env.INPUT ? true : langs.has(c.lang));

const VARIANT = Bun.env.VARIANT ?? "v1";
export const SYSTEM_V1 = `You find hesitation fillers in a speech transcript.
A hesitation filler is a vocalized pause: a non-lexical sound a speaker makes while thinking, such as English "um", "uh", "er".
Mark a token only when it is such a sound in this language and this context.
Never mark:
- real words of the language, however short, including particles, linking particles, conjunctions and articles;
- discourse markers or loosely used words ("like", "you know", "so", "well", "actually", "basically", and their equivalents in any language);
- interjections or replies that carry meaning ("oh", "wow", "yes", "no", "hmm" used as a reply);
- backchannels ("uh-huh", "mm-hmm");
- repeated words, cut-off words, names, numbers.
If you are not sure, do not mark it. Return the ids of the marked tokens only.`;

export const SYSTEM_V2 = `You find hesitation sounds in a speech transcript, in any language.
A hesitation sound is a vocalized pause with no dictionary meaning, like English "um", "uh", "er": a sound, not a word.
For each token you consider, decide whether it is a dictionary word of the transcript's language (or of any language the speaker mixes in).
Report a token only if it is a pure hesitation sound and NOT a dictionary word.
Words never count, even when used as filler: particles, linking particles, conjunctions, articles, pronouns, honorifics, terms of address,
discourse markers ("like", "you know", "so", "well", "actually", "maybe"), interjections with meaning, replies ("yes", "no"),
backchannels ("uh-huh", "mm-hmm"), repeated or cut-off words, names and numbers.
If you are not certain, leave it out. Most transcripts contain few or no hesitation sounds; returning none is normal.`;
// v3: judge meaning in context, not dictionary membership. Only English examples, so other-language scores are not tuned to the test data.
export const SYSTEM_V3 = `You find hesitation sounds in a speech transcript, in any language.
A hesitation sound is a vocalized pause: a sound a speaker makes while thinking, with no meaning in the sentence (like English "um", "uh", "er", or "hmm" while thinking).
Some hesitation sounds are also listed in dictionaries as interjections. They still count when, in this context, they are only a pause.
A token does not count when it carries meaning here: when it is a word doing its normal job (a verb, a conjunction such as "and" or "but", a particle, an article, a pronoun),
a lengthened real word, an interjection with meaning (surprise, agreement, a question tag like "right?", a reply), a backchannel ("uh-huh", "mm-hmm"),
a discourse marker ("like", "you know", "so", "well"), a repeated or cut-off word, a name or a number.
Report a token only if it is a hesitation sound with no meaning in this context. If you are not certain, leave it out.`;
const SYSTEM = VARIANT === "v3" ? SYSTEM_V3 : VARIANT === "v2" ? SYSTEM_V2 : SYSTEM_V1;

const SCHEMA_V1 = { type: "object", additionalProperties: false, required: ["fillers"], properties: { fillers: { type: "array", items: { type: "integer" } } } };
// v2: every reported token states what it is; code accepts only explicit non-word hesitation sounds whose text matches.
const SCHEMA_V2 = { type: "object", additionalProperties: false, required: ["fillers"], properties: { fillers: { type: "array", items: {
  type: "object", additionalProperties: false, required: ["id", "text", "is_dictionary_word", "kind"],
  properties: { id: { type: "integer" }, text: { type: "string" }, is_dictionary_word: { type: "boolean" },
    kind: { type: "string", enum: ["hesitation_sound", "discourse_word", "other_word", "unsure"] } } } } } };
const SCHEMA_V3 = { type: "object", additionalProperties: false, required: ["fillers"], properties: { fillers: { type: "array", items: {
  type: "object", additionalProperties: false, required: ["id", "text", "has_meaning_here", "kind"],
  properties: { id: { type: "integer" }, text: { type: "string" }, has_meaning_here: { type: "boolean" },
    kind: { type: "string", enum: ["hesitation_sound", "meaningful_word", "unsure"] } } } } } };
const SCHEMA = VARIANT === "v3" ? SCHEMA_V3 : VARIANT === "v2" ? SCHEMA_V2 : SCHEMA_V1;

function render(c: any) {
  const lines: string[] = [];
  let id = 0;
  const tokens: { id: number; word: string; startSec: number; endSec: number }[] = [];
  for (const u of c.slice) {
    const parts: string[] = [];
    for (const w of u.words ?? []) { parts.push(`${id}:${w.word}`); tokens.push({ id, word: w.word, startSec: w.startSec, endSec: w.endSec }); id++; }
    if (parts.length) lines.push(`S${u.speaker}: ${parts.join(" ")}`);
  }
  return { prompt: `Language: ${c.lang}\nTokens:\n${lines.join("\n")}`, tokens };
}

async function call(prompt: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const t0 = performance.now();
    let res: Response;
    // Network failures (DNS, reset) retry with backoff like 429/5xx.
    try { res = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, reasoning: { effort }, max_output_tokens: 4000, input: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
        text: { format: { type: "json_schema", name: "fillers", strict: true, schema: SCHEMA } } }) }); }
    catch { await Bun.sleep(3000 * (attempt + 1)); continue; }
    const body: any = await res.json();
    if (res.status === 429 || res.status >= 500) { await Bun.sleep(2000 * (attempt + 1)); continue; }
    if (body.error) throw new Error(JSON.stringify(body.error));
    const text = body.output?.flatMap((o: any) => o.content ?? []).find((c: any) => c.type === "output_text")?.text;
    return { status: body.status, text, usage: body.usage, ms: performance.now() - t0 };
  }
  throw new Error("retries exhausted");
}

// RESUME=<file>: keep that run's successful results and only re-run the rest.
const previous = Bun.env.RESUME ? (JSON.parse(await Bun.file(Bun.env.RESUME).text()).results as any[]).filter((r) => r.raw || r.ids) : [];
const done = new Set(previous.map((r) => r.clipId));
const results: any[] = [...previous];
const todo = clips.filter((c) => !done.has(c.clipId));
clips.length = 0; clips.push(...todo);
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < clips.length) {
    const c = clips[next++]!;
    const { prompt, tokens } = render(c);
    try {
      const r = await call(prompt);
      let ids: number[] | null = null;
      try {
        const fillers = JSON.parse(r.text).fillers;
        ids = VARIANT === "v1" ? fillers : [];
        // v3 records "has_meaning_here" under the v2 field name, so every scorer applies one acceptance rule.
        if (VARIANT !== "v1") (globalThis as any).__raw = VARIANT === "v3" ? fillers.map((f: any) => ({ ...f, is_dictionary_word: f.has_meaning_here })) : fillers;
      } catch { ids = null; }
      results.push({ clipId: c.clipId, lang: c.lang, tokens, ids, raw: VARIANT !== "v1" ? (globalThis as any).__raw : undefined, status: r.status, usage: r.usage, ms: r.ms });
    } catch (e) { results.push({ clipId: c.clipId, lang: c.lang, tokens, ids: null, error: String(e) }); }
  }
}));
await Bun.write(outFile, JSON.stringify({ model, effort, results }));
const inTok = results.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0), outTok = results.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0);
console.log(`${model}/${effort}: ${results.length} clips, failures ${results.filter((r) => !r.ids).length}, input ${inTok}, output ${outTok}, p50 latency ${results.map((r) => r.ms ?? 0).sort((a, b) => a - b)[Math.floor(results.length / 2)]?.toFixed(0)} ms`);
