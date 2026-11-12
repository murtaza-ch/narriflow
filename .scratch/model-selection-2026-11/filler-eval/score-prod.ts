// Scores prod-eval output by source key. usage: bun score-prod.ts <units.json> <prod.json> <nyra|fleurs|dev>
import { fillerWordKey, isFillerWord } from "../../../packages/validators/src/index.ts";
const [inFile, prodFile, set] = process.argv.slice(2) as [string, string, string];
const units = new Map((JSON.parse(await Bun.file(inFile).text()) as any[]).map((u) => [u.clipId, u]));
const prod = JSON.parse(await Bun.file(prodFile).text()).results as any[];
const per: Record<string, { tp: number; fp: number; fn: number; tags: number; tokens: number; ctx: string[] }> = {};
for (const r of prod) {
  const keys = new Set<string>(r.outcome.keys);
  const u = units.get(r.clipId);
  const words = u.slice.flatMap((s: any) => (s.words ?? []).map((w: any) => ({ ...w, speaker: s.speaker ?? null })));
  per[r.lang] ??= { tp: 0, fp: 0, fn: 0, tags: 0, tokens: 0, ctx: [] };
  const p = per[r.lang]!;
  words.forEach((w: any, i: number) => {
    const tagged = keys.has(fillerWordKey(w.speaker, w));
    const label = set === "nyra" ? Boolean(w.filler) : set === "fleurs" ? false : r.lang === "en" ? isFillerWord(w, "en") : null;
    p.tokens++; if (tagged) p.tags++;
    if (label === null) { if (tagged) p.ctx.push(`${r.clipId} …${words.slice(Math.max(0, i - 6), i).map((x: any) => x.word).join(" ")} [[${w.word}]] ${words.slice(i + 1, i + 6).map((x: any) => x.word).join(" ")}…`); return; }
    if (tagged && label) p.tp++; else if (tagged) { p.fp++; p.ctx.push(`${r.clipId} …${words.slice(Math.max(0, i - 6), i).map((x: any) => x.word).join(" ")} [[${w.word}]] ${words.slice(i + 1, i + 6).map((x: any) => x.word).join(" ")}…`); } else if (label) p.fn++;
  });
}
const T = { tp: 0, fp: 0, fn: 0, tags: 0, tokens: 0 };
for (const [lang, p] of Object.entries(per).sort()) {
  T.tp += p.tp; T.fp += p.fp; T.fn += p.fn; T.tags += p.tags; T.tokens += p.tokens;
  console.log(`${lang} | tokens ${p.tokens} | tags ${p.tags} | recall ${(100 * p.tp / Math.max(1, p.tp + p.fn)).toFixed(1)}% | unlabelled tags ${p.fp}`);
  if (Bun.env.CTX) for (const c of p.ctx) console.log("   ", c);
}
console.log(`all | tokens ${T.tokens} | tags ${T.tags} | recall ${(100 * T.tp / Math.max(1, T.tp + T.fn)).toFixed(1)}% | unlabelled tags ${T.fp}`);
