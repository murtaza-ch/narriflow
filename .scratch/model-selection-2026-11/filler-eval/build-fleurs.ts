const langs = (await (await fetch("https://huggingface.co/api/datasets/google/fleurs/tree/main/data")).json()).map((x: any) => x.path.replace("data/", "")).filter((l: string) => l !== "metadata.zip");
const PER_CHAR = new Set(["cmn_hans_cn", "ja_jp", "yue_hant_hk"]);
const units: any[] = [];
await Promise.all(langs.map(async (lang: string) => {
  const tsv = await (await fetch(`https://huggingface.co/datasets/google/fleurs/resolve/main/data/${lang}/test.tsv`)).text();
  await Bun.write(`${import.meta.dir}/fleurs/${lang}.tsv`, tsv);
  const sentences = [...new Set(tsv.split("\n").filter(Boolean).map((line) => line.split("\t")[2]!))].slice(0, 40);
  for (let u = 0; u < 5; u++) {
    const words: any[] = []; let t = 0;
    for (const s of sentences.slice(u * 8, u * 8 + 8)) for (const tok of PER_CHAR.has(lang) ? [...s.replace(/\s+/g, "")] : s.split(/\s+/).filter(Boolean)) { words.push({ word: tok, startSec: t, endSec: t + 0.3 }); t += 0.35; }
    if (words.length) units.push({ clipId: `${lang}-${u}`, lang: lang.split("_")[0], fleurs: lang, slice: [{ speaker: 0, words }] });
  }
}));
await Bun.write(`${import.meta.dir}/fleurs-units.json`, JSON.stringify(units));
console.log(`languages ${new Set(units.map((u) => u.fleurs)).size}, clips ${units.length}, tokens ${units.reduce((s, u) => s + u.slice[0].words.length, 0)}`);
