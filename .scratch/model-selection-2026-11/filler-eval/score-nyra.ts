// Per-language precision/recall of accepted tags against gold-aligned filler labels.
const dir = import.meta.dir;
const letters = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}]/gu, "");
const units = new Map((JSON.parse(await Bun.file(`${dir}/nyra-units.json`).text()) as any[]).map((u) => [u.clipId, u]));
const stats: Record<string, { gold: number }> = {};
for (const line of (await Bun.file(`${dir}/nyra-build.log`).text()).split("\n")) {
  const m = line.match(/^(\w+) \(.*\): \d+ sentences, (\d+) gold fillers/);
  if (m) stats[m[1]!] = { gold: Number(m[2]) };
}
const { model, effort, results } = JSON.parse(await Bun.file(process.argv[2]!).text());
const per: Record<string, { tp: number; fp: number; fn: number; fps: string[] }> = {};
for (const r of results) {
  const labels = units.get(r.clipId)!.slice.flatMap((s: any) => s.words.map((w: any) => Boolean(w.filler)));
  const accepted = new Set<number>((r.raw ?? []).filter((f: any) => f.kind === "hesitation_sound" && f.is_dictionary_word === false && r.tokens[f.id] &&
    letters(r.tokens[f.id].word) === letters(f.text) && letters(f.text) !== "").map((f: any) => f.id));
  per[r.lang] ??= { tp: 0, fp: 0, fn: 0, fps: [] };
  const p = per[r.lang]!;
  labels.forEach((isFiller: boolean, i: number) => {
    if (accepted.has(i) && isFiller) p.tp++;
    else if (accepted.has(i)) { p.fp++; p.fps.push(`[[${r.tokens[i].word}]] …${r.tokens.slice(Math.max(0, i - 4), i).map((t: any) => t.word).join(" ")} | ${r.tokens.slice(i + 1, i + 5).map((t: any) => t.word).join(" ")}`); }
    else if (isFiller) p.fn++;
  });
}
console.log(`== ${model}/${effort}`);
console.log("lang | precision | recall of written | end-to-end recall (of all real hesitations) | wrong tags");
const T = { tp: 0, fp: 0, fn: 0, gold: 0 };
for (const [lang, p] of Object.entries(per).sort()) {
  const gold = stats[lang]?.gold ?? NaN;
  T.tp += p.tp; T.fp += p.fp; T.fn += p.fn; T.gold += gold;
  console.log(`${lang} | ${(100 * p.tp / (p.tp + p.fp)).toFixed(1)}% | ${(100 * p.tp / (p.tp + p.fn)).toFixed(1)}% | ${(100 * p.tp / gold).toFixed(1)}% | ${p.fp}`);
}
console.log(`all | ${(100 * T.tp / (T.tp + T.fp)).toFixed(1)}% | ${(100 * T.tp / (T.tp + T.fn)).toFixed(1)}% | ${(100 * T.tp / T.gold).toFixed(1)}% | ${T.fp}`);
for (const [lang, p] of Object.entries(per).sort()) if (p.fps.length) console.log(`\n${lang} wrong tags (${p.fps.length}):\n  ` + p.fps.slice(0, 12).join("\n  "));
