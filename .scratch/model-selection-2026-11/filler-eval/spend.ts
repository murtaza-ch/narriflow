// Total spend recorded in result files (input/output tokens from OpenAI usage x official standard prices).
const PRICE: Record<string, [number, number]> = { "gpt-5.4-nano": [0.2, 1.25], "gpt-5.4-mini": [0.75, 4.5], "gpt-5.4": [2.5, 15], "gpt-5.6-luna": [0.2, 1.2], "gpt-6-luna": [0.1, 0.5], "gpt-6.1-terra": [1, 5], "gpt-6.1-sol": [2, 10] };
const skip = new Set(["clips.json", "clips-unique.json", "fleurs-units.json", "nyra-units.json"]);
let total = 0;
const rows: string[] = [];
for (const f of new Bun.Glob("*.json").scanSync(import.meta.dir)) {
  if (skip.has(f)) continue;
  let d: any;
  try { d = JSON.parse(await Bun.file(`${import.meta.dir}/${f}`).text()); } catch { continue; }
  if (!d?.results || !PRICE[d.model]) continue;
  const i = d.results.reduce((s: number, r: any) => s + (r.usage?.input_tokens ?? 0), 0);
  const o = d.results.reduce((s: number, r: any) => s + (r.usage?.output_tokens ?? 0), 0);
  const cost = (i * PRICE[d.model]![0] + o * PRICE[d.model]![1]) / 1e6;
  total += cost;
  rows.push(`${f.padEnd(22)} ${String(d.model).padEnd(13)} $${cost.toFixed(3)}`);
}
console.log(rows.sort().join("\n"));
console.log(`TOTAL recorded spend: $${total.toFixed(2)}`);
