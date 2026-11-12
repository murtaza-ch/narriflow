// FLEURS read speech has no hesitations: every accepted tag is a false positive (each printed for inspection).
const PRICE: Record<string, [number, number]> = { "gpt-5.4-nano": [0.2, 1.25], "gpt-5.4-mini": [0.75, 4.5], "gpt-5.4": [2.5, 15], "gpt-5.6-luna": [0.2, 1.2], "gpt-6-luna": [0.1, 0.5], "gpt-6.1-terra": [1, 5] };
const letters = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}]/gu, "");
const { model, effort, results } = JSON.parse(await Bun.file(process.argv[2]!).text());
let tokens = 0;
let falsePositives = 0;
const perLang = new Map<string, number>();
const examples: string[] = [];
for (const r of results) {
  tokens += r.tokens.length;
  const ids = (r.raw ?? []).filter((f: any) => f.kind === "hesitation_sound" && f.is_dictionary_word === false && r.tokens[f.id] &&
    letters(r.tokens[f.id].word) === letters(f.text) && letters(f.text) !== "").map((f: any) => f.id);
  for (const id of ids) {
    falsePositives++;
    perLang.set(r.lang, (perLang.get(r.lang) ?? 0) + 1);
    examples.push(`${r.clipId} [[${r.tokens[id].word}]] …${r.tokens.slice(Math.max(0, id - 5), id).map((t: any) => t.word).join(" ")} | ${r.tokens.slice(id + 1, id + 6).map((t: any) => t.word).join(" ")}…`);
  }
}
const inTok = results.reduce((s: number, r: any) => s + (r.usage?.input_tokens ?? 0), 0);
const outTok = results.reduce((s: number, r: any) => s + (r.usage?.output_tokens ?? 0), 0);
const [pi, po] = PRICE[model]!;
console.log(`== ${model}/${effort}: ${new Set(results.map((r: any) => r.lang)).size} languages, ${tokens} tokens, false positives ${falsePositives} (${(1e4 * falsePositives / tokens).toFixed(2)} per 10k tokens) in ${perLang.size} languages, cost $${((inTok * pi + outTok * po) / 1e6).toFixed(3)}`);
if (examples.length) console.log("  " + examples.slice(0, 25).join("\n  ") + (examples.length > 25 ? `\n  … ${examples.length - 25} more` : ""));
