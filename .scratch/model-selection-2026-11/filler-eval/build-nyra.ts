// Builds labelled units from the Nyra verbatim benchmark: Scribe's real outputs, each token labelled
// FILLER when it aligns to a gold [UH]/[UM], via word-level edit-distance alignment.
const dir = import.meta.dir;
const LANGS = ["de", "en", "es", "fr", "it", "nl", "pl", "pt", "ru", "sv"];
const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}']/gu, "");
const units: any[] = [];
const stats: Record<string, { items: number; goldFillers: number; written: number; dataset: string }> = {};

function align(pred: string[], gold: string[]) {
  // gold tokens: normalized words or "<F>" for a filler. Substituting a pred token for "<F>" costs 0.6,
  // so a written hesitation aligns to the filler slot; matching words cost 0, other substitutions 1.
  const n = pred.length, m = gold.length;
  const d = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 0; i <= n; i++) d[i]![0] = i;
  for (let j = 0; j <= m; j++) d[0]![j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const sub = gold[j - 1] === "<F>" ? 0.6 : norm(pred[i - 1]!) === gold[j - 1] ? 0 : 1;
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + sub);
  }
  const label = new Array<boolean>(n).fill(false);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const sub = gold[j - 1] === "<F>" ? 0.6 : norm(pred[i - 1]!) === gold[j - 1] ? 0 : 1;
    if (d[i]![j] === d[i - 1]![j - 1]! + sub) { if (gold[j - 1] === "<F>") label[i - 1] = true; i--; j--; }
    else if (d[i]![j] === d[i - 1]![j]! + 1) i--;
    else j--;
  }
  return label;
}

for (const lang of LANGS) {
  const items = JSON.parse(await Bun.file(`${dir}/nyra/predictions/raw/elevenlabs/${lang}.json`).text()) as any[];
  const s = { items: 0, goldFillers: 0, written: 0, dataset: items[0]?.dataset ?? "" };
  stats[lang] = s;
  let batch: any[] = [];
  const flush = () => { if (batch.length) units.push({ clipId: `${lang}-${units.length}`, lang, slice: batch }); batch = []; };
  for (const item of items) {
    // Our pipeline runs Scribe with tag_audio_events=false: drop its bracketed sound tags.
    const pred = String(item.raw_verbatim_prediction ?? "").replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter(Boolean);
    const gold = String(item.gold_verbatim ?? "").split(/\s+/).filter(Boolean)
      .filter((t) => !/^\[(?!UH\]|UM\])[^\]]*\]$/i.test(t)) // drop vocal sound tags like [laughter]
      .map((t) => (/^\[(UH|UM)\]/i.test(t) ? "<F>" : norm(t))).filter(Boolean);
    const label = align(pred, gold);
    s.items++;
    s.goldFillers += gold.filter((g) => g === "<F>").length;
    s.written += label.filter(Boolean).length;
    batch.push({ speaker: 0, words: pred.map((w, k) => ({ word: w, startSec: k * 0.3, endSec: k * 0.3 + 0.25, filler: label[k] })) });
    if (batch.length === 10) flush();
  }
  flush();
}
await Bun.write(`${dir}/nyra-units.json`, JSON.stringify(units));
for (const [lang, s] of Object.entries(stats)) console.log(`${lang} (${s.dataset}): ${s.items} sentences, ${s.goldFillers} gold fillers, ${s.written} written by Scribe (${(100 * s.written / Math.max(1, s.goldFillers)).toFixed(0)}%)`);
console.log(`units ${units.length}`);
