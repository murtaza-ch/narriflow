// Agreement rule: a token counts only when BOTH runs accept it (v2 rules + letter match + 1..6 letters, no digits).
// usage: bun score-and.ts <set: nyra|fleurs|dev> <runA.json> <runB.json>
import { isFillerWord } from "../../../packages/validators/src/filler-words.ts";
const [set, fileA, fileB] = process.argv.slice(2) as [string, string, string];
const dir = import.meta.dir;
const letters = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}]/gu, "");
const accepted = (r: any) => new Set<number>((r.raw ?? []).filter((f: any) => {
  const t = r.tokens[f.id];
  if (!t || f.kind !== "hesitation_sound" || f.is_dictionary_word !== false) return false;
  const l = letters(t.word), n = [...l].length;
  return l === letters(f.text) && n >= 1 && n <= 6 && !/\p{N}/u.test(t.word);
}).map((f: any) => f.id));
const load = (f: string) => new Map((JSON.parse(Bun.file(f).size ? require("node:fs").readFileSync(f, "utf8") : "{}").results as any[]).map((r) => [r.clipId, r]));
const A = load(fileA), B = load(fileB);
const units = set === "nyra" ? new Map((JSON.parse(await Bun.file(`${dir}/nyra-units.json`).text()) as any[]).map((u) => [u.clipId, u])) : null;
const per: Record<string, { tp: number; fp: number; fn: number; tags: number; tokens: number; errs: Map<string, number> }> = {};
let missingPairs = 0;
for (const [id, a] of A) {
  const b = B.get(id);
  if (!b || !(a.raw && b.raw)) { missingPairs++; continue; }
  const both = new Set([...accepted(a)].filter((i) => accepted(b).has(i)));
  per[a.lang] ??= { tp: 0, fp: 0, fn: 0, tags: 0, tokens: 0, errs: new Map() };
  const p = per[a.lang]!;
  p.tags += both.size; p.tokens += a.tokens.length;
  const label = (i: number) => set === "nyra" ? Boolean(units!.get(id).slice.flatMap((s: any) => s.words)[i]?.filler)
    : set === "dev" && a.lang === "en" ? isFillerWord(a.tokens[i], "en") : set === "fleurs" ? false : null;
  a.tokens.forEach((t: any, i: number) => {
    const l = label(i);
    if (l === null) { if (both.has(i)) p.errs.set(t.word, (p.errs.get(t.word) ?? 0) + 1); return; }
    if (both.has(i) && l) p.tp++;
    else if (both.has(i)) { p.fp++; p.errs.set(letters(t.word), (p.errs.get(letters(t.word)) ?? 0) + 1); }
    else if (l) p.fn++;
  });
}
console.log(`== AND(${fileA}, ${fileB}) on ${set}; unpaired units ${missingPairs}`);
const T = { tp: 0, fp: 0, fn: 0, tags: 0, tokens: 0 };
for (const [lang, p] of Object.entries(per).sort()) {
  T.tp += p.tp; T.fp += p.fp; T.fn += p.fn; T.tags += p.tags; T.tokens += p.tokens;
  if (set === "fleurs") { if (p.fp) console.log(`${lang}: ${p.fp} tags (all false): ${[...p.errs].map(([k, n]) => `${k}:${n}`).join(" ")}`); continue; }
  console.log(`${lang} | tags ${p.tags} | recall ${(100 * p.tp / Math.max(1, p.tp + p.fn)).toFixed(1)}% | label-disagreements ${p.fp} | texts: ${[...p.errs].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k}:${n}`).join(" ")}`);
}
if (set === "fleurs") console.log(`all: ${T.fp} false tags in ${T.tokens} tokens`);
else console.log(`all | tags ${T.tags} | recall ${(100 * T.tp / Math.max(1, T.tp + T.fn)).toFixed(1)}% | label-disagreements ${T.fp}`);
