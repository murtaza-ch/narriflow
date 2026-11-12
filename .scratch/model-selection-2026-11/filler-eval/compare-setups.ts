// Compares filler-tagging setups with the production acceptance and key rules
// (acceptFillerTags per model, agreement intersection, collectFillerKeys guards).
// usage: bun compare-setups.ts
import { acceptFillerTags, collectFillerKeys, fillerWordKey } from "../../../packages/validators/src/index.ts";
const dir = import.meta.dir;
const PRICE: Record<string, [number, number]> = { "gpt-5.6-luna": [0.2, 1.2], "gpt-5.4": [2.5, 15], "gpt-6-luna": [0.1, 0.5], "gpt-6.1-terra": [1, 5] };
const runs: Record<string, Record<string, string>> = {
  "5.6-luna low": { nyra: "ny-luna-low.json", fleurs: "fl-luna-low.json", dev: "luna-v2-low.json" },
  "5.4 none": { nyra: "ny-full-none.json", fleurs: "fl-full-none.json", dev: "full-v2-none.json" },
  "6-luna none": { nyra: "ny-l6n.json", fleurs: "fl-l6n.json", dev: "dev-l6n.json" },
  "6-luna low": { nyra: "ny-l6l.json", fleurs: "fl-l6l.json", dev: "dev-l6l.json" },
  "6.1-terra none": { nyra: "ny-t61n.json", fleurs: "fl-t61n.json", dev: "dev-t61n.json" },
  "6-luna none (run 2)": { nyra: "ny-l6n-b.json", fleurs: "fl-l6n-b.json", dev: "dev-l6n-b.json" },
};
const setups: string[][] = [["6-luna none (run 2)"], ["6-luna none", "6-luna none (run 2)"], ["5.6-luna low", "5.4 none"], ["6-luna none"], ["6-luna low"], ["6.1-terra none"], ["6-luna none", "6.1-terra none"],
  ["6-luna low", "6.1-terra none"], ["6-luna none", "5.6-luna low"], ["6-luna low", "6-luna none"], ["6-luna none", "5.4 none"]];
const cache = new Map<string, Map<string, any>>();
const load = (f: string) => { if (!cache.has(f)) cache.set(f, new Map((JSON.parse(require("node:fs").readFileSync(`${dir}/${f}`, "utf8")).results as any[]).map((r) => [r.clipId, r]))); return cache.get(f)!; };
const nyra = new Map((JSON.parse(await Bun.file(`${dir}/nyra-units.json`).text()) as any[]).map((u) => [u.clipId, u]));
const wordsByUnit = (r: any) => r.tokens.map((t: any) => ({ word: t.word, startSec: t.startSec, endSec: t.endSec, confidence: null }));

function keysFor(setup: string[], set: string, clipId: string): { tokens: any[]; keys: Set<string>; usage: { model: string; i: number; o: number }[] } | null {
  const rs = setup.map((s) => ({ r: load(runs[s]![set]!).get(clipId), model: s }));
  if (rs.some((x) => !x.r || !x.r.raw)) return null;
  const words = wordsByUnit(rs[0]!.r);
  // Unique per-unit timing so keys are distinct (eval units carry synthetic times).
  const tokens = words.map((w: any, i: number) => ({ speaker: 0, word: { ...w, startSec: i, endSec: i + 0.5 } }));
  const chunk = { tokens, prompt: "x" } as any;
  const sets = rs.map((x) => new Set(acceptFillerTags(chunk, { fillers: x.r.raw })));
  const agreed = [...sets[0]!].filter((id) => sets.every((s) => s.has(id))).sort((a, b) => a - b);
  const keys = new Set(collectFillerKeys([chunk], [agreed]));
  const usage = rs.map((x) => ({ model: x.r.model ?? "", i: x.r.usage?.input_tokens ?? 0, o: x.r.usage?.output_tokens ?? 0 }));
  return { tokens, keys, usage };
}
const fileModel = (s: string) => JSON.parse(require("node:fs").readFileSync(`${dir}/${runs[s]!.nyra}`, "utf8")).model as string;
const models = Object.fromEntries(Object.keys(runs).map((s) => [s, fileModel(s)]));

for (const setup of setups) {
  let fleursTags = 0, fleursTokens = 0;
  for (const id of load(runs[setup[0]!]!.fleurs!).keys()) { const k = keysFor(setup, "fleurs", id); if (!k) continue; fleursTokens += k.tokens.length; fleursTags += k.keys.size; }
  let tp = 0, fn = 0, unl = 0, words = 0, cost = 0; const unlTexts = new Map<string, number>();
  for (const id of load(runs[setup[0]!]!.nyra!).keys()) {
    const k = keysFor(setup, "nyra", id); if (!k) continue;
    const gold = nyra.get(id).slice.flatMap((s: any) => s.words);
    words += k.tokens.length;
    k.usage.forEach((u, idx) => { const p = PRICE[models[setup[idx]!]!]!; cost += (u.i * p[0] + u.o * p[1]) / 1e6; });
    k.tokens.forEach((t: any, i: number) => { const tagged = k.keys.has(fillerWordKey(0, t.word)); const label = Boolean(gold[i]?.filler);
      if (tagged && label) tp++; else if (tagged) { unl++; if (!id.startsWith("en-")) { const l = t.word.word.toLowerCase().replace(/[^\p{L}]/gu, ""); unlTexts.set(l, (unlTexts.get(l) ?? 0) + 1); } } else if (label) fn++; });
  }
  let devEn = 0, devEnTagged = 0, devHiUr = 0;
  for (const [id, r] of load(runs[setup[0]!]!.dev!)) { const k = keysFor(setup, "dev", id); if (!k) continue;
    if (r.lang === "en") { devEnTagged += k.keys.size; } else devHiUr += k.keys.size; void devEn; }
  const odd = [...unlTexts].filter(([t]) => !/^(e+h*m*|ä+h*m*|ö+h*|u+h*m*|y+|m+h*|h+m+|э+м*|м+|а+|e+m+|a+h*|euh|ehm|hum|hã+|hm|mm+|ee+|ehh|ahum|uhm)$/u.test(t));
  console.log(`${setup.join(" ∧ ").padEnd(28)} | FLEURS wrong ${fleursTags}/${fleursTokens} | Nyra recall ${(100 * tp / (tp + fn)).toFixed(1)}% unlabelled ${unl} | dev en tags ${devEnTagged}, hi/ur tags ${devHiUr} | $/1M words ${(cost / words * 1e6).toFixed(2)} | non-hesitation-shaped unlabelled: ${odd.map(([t, n]) => `${t}:${n}`).join(" ") || "none"}`);
}
