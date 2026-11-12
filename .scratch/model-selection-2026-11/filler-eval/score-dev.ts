// Score AI tags on real dev clips. English: the shipped list detector is the reference; every
// disagreement is printed with context for adjudication. Hindi/Urdu: print every tag with context.
import { isFillerWord } from "../../../packages/validators/src/filler-words.ts";
const file = process.argv[2]!;
const { model, effort, results } = JSON.parse(await Bun.file(file).text());
const ctx = (tokens: any[], i: number) => `…${tokens.slice(Math.max(0, i - 6), i).map((t) => t.word).join(" ")} [[${tokens[i].word}]] ${tokens.slice(i + 1, i + 7).map((t) => t.word).join(" ")}…`;
// Standard prices per 1M tokens, https://developers.openai.com/api/docs/pricing (fetched 2026-11-12).
const PRICE: Record<string, [number, number]> = { "gpt-5.4-nano": [0.2, 1.25], "gpt-5.4-mini": [0.75, 4.5], "gpt-5.4": [2.5, 15], "gpt-5.5": [5, 30],
  "gpt-5.6-luna": [0.2, 1.2], "gpt-6-luna": [0.1, 0.5], "gpt-6.1-terra": [1, 5], "gpt-5.6-terra": [2, 12], "gpt-5.6-sol": [4, 20] };
const letters = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}]/gu, "");
// v2: accept only explicit non-word hesitation sounds whose letters match the token.
for (const r of results) if (r.raw) r.ids = r.raw.filter((f: any) => f.kind === "hesitation_sound" && f.is_dictionary_word === false &&
  r.tokens[f.id] && letters(r.tokens[f.id].word) === letters(f.text) && letters(f.text) !== "").map((f: any) => f.id);
let tp = 0, fp: string[] = [], fn: string[] = [], invalid = 0;
const other: string[] = [];
for (const r of results) {
  const tagged = new Set<number>();
  for (const id of r.ids ?? []) { if (!Number.isInteger(id) || id < 0 || id >= r.tokens.length) invalid++; else tagged.add(id); }
  if (r.lang === "en") {
    r.tokens.forEach((t: any, i: number) => {
      const ref = isFillerWord(t, "en");
      if (ref && tagged.has(i)) tp++;
      else if (ref) fn.push(`${t.word} ${ctx(r.tokens, i)}`);
      else if (tagged.has(i)) fp.push(`${t.word} ${ctx(r.tokens, i)}`);
    });
  } else for (const i of tagged) other.push(`${r.lang} ${r.tokens[i].word} (${(r.tokens[i].endSec - r.tokens[i].startSec).toFixed(2)}s) ${ctx(r.tokens, i)}`);
}
const inTok = results.reduce((s: number, r: any) => s + (r.usage?.input_tokens ?? 0), 0), outTok = results.reduce((s: number, r: any) => s + (r.usage?.output_tokens ?? 0), 0);
const [pi, po] = PRICE[model]!;
console.log(`== ${model}/${effort}: cost $${((inTok * pi + outTok * po) / 1e6).toFixed(4)} for ${results.length} clips; invalid ids ${invalid}`);
console.log(`English vs list: agree ${tp}, AI-only ${fp.length}, list-only ${fn.length}`);
console.log("AI-only (English):\n " + fp.join("\n "));
console.log("list-only (English, AI missed):\n " + fn.slice(0, 40).join("\n ") + (fn.length > 40 ? `\n … ${fn.length - 40} more` : ""));
console.log(`Hindi/Urdu tags (${other.length}):\n ` + other.join("\n "));
