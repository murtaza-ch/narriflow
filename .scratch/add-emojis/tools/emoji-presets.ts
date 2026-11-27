// Every preset's export (ASS through libass) with one 🧠 on "I still remember the commercial", a pixel gap between the
// emoji and the nearest caption row in each frame, and contact sheets. Two scenarios:
//   late:  the emoji on "remember" with the preset's own cue split (most presets end a 3-word cue there: a late word),
//          frames 200 and 450 ms after its pop;
//   stack: one 5-word cue (wordsPerCue 5) with the emoji on "still", frames 200 ms after its pop and 1,100 ms after
//          it (when a stack has revealed its later rows).
// Both also measure `pop`: the emoji at rest (200 ms after it starts) against the caption pixels on its first painted
// frame (its real start, after any wait for its slot), the frame the closeness rule judges.
//
//   bun .scratch/add-emojis/tools/emoji-presets.ts <outDir> [positionY|default] [ids,comma,separated] [label] [late|stack]
//
// Writes <outDir>/sheet-<label>-<scenario>-<pos>-<n>.png and <outDir>/pixel-gaps-<label>-<scenario>-<pos>.json. About 2 minutes for every preset.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spyOn } from "bun:test";

const R = resolve(import.meta.dir, "../../..");
const v = await import(`${R}/packages/validators/src/index.ts`);
const cs = await import(`${R}/packages/caption-scene/src/index.ts`);
const fx = await import(`${R}/apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/caption-emoji-fixture.ts`);
const media = await import(`${R}/apps/media/src/caption-ass.ts`);
const { CAPTION_FONTS_DIRECTORY } = await import(`${R}/packages/caption-fonts/src/index.ts`);
const art = await (await import(`${R}/packages/caption-emoji/src/art.ts`)).loadCaptionEmojiArt(["brain"]);
const sharp = (await import(Bun.resolveSync("sharp", `${R}/apps/media`))).default;

const outDir = resolve(process.argv[2] ?? ".");
const posArg = process.argv[3] && process.argv[3] !== "default" ? Number(process.argv[3]) : null;
const ids: string[] = process.argv[4] ? process.argv[4].split(",") : v.CAPTION_PRESETS.map((p: { id: string }) => p.id);
const label = process.argv[5] ?? "run";
const scenario = process.argv[6] === "stack" ? "stack" : "late";
// Optional 7th argument: the Style → Size multiple (0.8, 1 or 1.25).
const sizeArg = process.argv[7] ? Number(process.argv[7]) : null;
const frames = join(outDir, `frames-${label}-${scenario}`);
mkdirSync(frames, { recursive: true });
const W = 1080;
const H = 1920;
const SAMPLES_MS: (number | "pop")[] = scenario === "stack" ? ["pop", 200, 1100] : ["pop", 200, 450];

const line = "I still remember the commercial";
let t0 = 0.4;
const words = line.split(" ").map((word) => {
  const w = { word, startSec: +t0.toFixed(3), endSec: +(t0 + 0.32).toFixed(3), confidence: 1 };
  t0 += 0.36;
  return w;
});
const target = words[scenario === "stack" ? 1 : 2]!;

const render = (ass: string, at: number, name: string) => {
  const file = join(frames, `${name}.ass`);
  writeFileSync(file, ass);
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x2b3040:s=${W}x${H}:r=30:d=4`, "-vf", `ass='${file}':fontsdir='${CAPTION_FONTS_DIRECTORY}',format=rgb24`, "-ss", String(at), "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 1 << 27 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return r.stdout as Buffer;
};
const rowsOf = (hit: (i: number) => boolean) => {
  const rows = new Uint16Array(H);
  let y1 = H;
  let y2 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (hit((y * W + x) * 3)) rows[y]!++;
  for (let y = 0; y < H; y++) if (rows[y]! > 3) { y1 = Math.min(y1, y); y2 = Math.max(y2, y); }
  return y2 < 0 ? null : { y1, y2, rows };
};

const results: Record<string, unknown>[] = [];
const thumbs: Buffer[] = [];
for (const id of ids) {
  const base = fx.emojiFixtureDocument({ presetId: id });
  const doc = {
    ...base,
    clipEndSec: t0 + 1,
    transcriptSlice: [{ index: 0, speaker: 0, speakerLabel: "S", startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec, confidence: 1, text: line, words }],
    captionPreset: { ...base.captionPreset, ...(posArg === null ? {} : { positionY: posArg }), ...(scenario === "stack" ? { wordsPerCue: 5 } : {}), ...(sizeArg === null ? {} : { emojiSize: sizeArg }) },
    studioEdits: { ...base.studioEdits, captionEmojis: { [v.captionWordKey(target.startSec)]: v.captionEmojiRefOnWord({ id: "brain" }, target.word) } },
  };
  const layers = fx.emojiFixtureLayersFor(doc, {});
  const spy = spyOn(cs, "placeCaptionEmojis");
  let full: ReturnType<typeof media.renderCaptionTrack>;
  let startMs = Number.NaN;
  try {
    full = media.renderCaptionTrack({ layers, canvas: { width: W, height: H }, fps: 30, emojiArt: art });
    for (const result of spy.mock.results) for (const o of result.value as { placed: boolean; pieces?: { fromMs: number }[] }[]) if (o.placed) startMs = o.pieces![0]!.fromMs;
  } finally {
    spy.mockRestore();
  }
  const bare = media.renderCaptionTrack({ layers, canvas: { width: W, height: H }, fps: 30, emojiArt: new Map() });
  if (full.emojis.placed === 0) {
    results.push({ id, dropped: full.emojis.dropped });
    continue;
  }
  for (const dt of SAMPLES_MS) {
    const at = dt === "pop" ? (startMs + 200) / 1000 : target.startSec + dt / 1000;
    const a = render(full.ass, at, id);
    const b = render(bare.ass, at, `${id}-bare`);
    // The caption on the emoji's first painted frame (the first export frame at or after its start).
    const b0 = dt === "pop" ? render(bare.ass, cs.exportFrameAtOrAfter(startMs, 30) / 1000, `${id}-bare-first`) : b;
    const emo = rowsOf((i) => Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 40);
    const cap = rowsOf((i) => Math.abs(b0[i]! - 0x2b) + Math.abs(b0[i + 1]! - 0x30) + Math.abs(b0[i + 2]! - 0x40) > 90);
    if (!emo || !cap) results.push({ id, dt, note: !emo ? "emoji invisible at sample" : "no caption pixels" });
    else {
      // Empty pixel rows between the emoji and the nearest caption row.
      let gap = 0;
      let overlapRows = 0;
      for (let y = emo.y1; y <= emo.y2; y++) if (cap.rows[y]! > 3) overlapRows++;
      if (!overlapRows) {
        let up = 1e9;
        let down = 1e9;
        for (let y = emo.y1 - 1; y >= 0; y--) if (cap.rows[y]! > 3) { up = emo.y1 - y; break; }
        for (let y = emo.y2 + 1; y < H; y++) if (cap.rows[y]! > 3) { down = y - emo.y2; break; }
        gap = Math.min(up, down);
      }
      const h = emo.y2 - emo.y1;
      results.push({ id, dt, gapPx: gap, emojiH: h, ratio: +(gap / h).toFixed(2), sharesRows: overlapRows > 0, side: (emo.y1 + emo.y2) / 2 < (cap.y1 + cap.y2) / 2 ? "above" : "below", emojiY: [emo.y1, emo.y2], captionY: [cap.y1, cap.y2] });
    }
    if (dt === "pop") continue;
    const tag = Buffer.from(`<svg width="270" height="480"><rect width="270" height="22" fill="#000"/><text x="5" y="16" font-size="14" fill="#fff" font-family="Helvetica">${id} +${dt}ms</text></svg>`);
    thumbs.push(await sharp(await sharp(a, { raw: { width: W, height: H, channels: 3 } }).resize(270, 480).png().toBuffer()).composite([{ input: tag, left: 0, top: 0 }]).png().toBuffer());
  }
}

const pos = posArg ?? "default";
const cols = 8;
const perSheet = 48;
for (let s = 0, n = 1; s < thumbs.length; s += perSheet, n++) {
  const part = thumbs.slice(s, s + perSheet);
  await sharp({ create: { width: cols * 274, height: Math.ceil(part.length / cols) * 484, channels: 3, background: "#fff" } })
    .composite(part.map((input, i) => ({ input, left: (i % cols) * 274, top: Math.floor(i / cols) * 484 })))
    .png()
    .toFile(join(outDir, `sheet-${label}-${scenario}-${pos}-${n}.png`));
}
await Bun.write(join(outDir, `pixel-gaps-${label}-${scenario}-${pos}.json`), JSON.stringify(results, null, 1));
const measured = results.filter((r) => r.ratio !== undefined) as { id: string; dt: number | "pop"; ratio: number; gapPx: number; side: string; sharesRows: boolean }[];
for (const dt of SAMPLES_MS) {
  const at = measured.filter((r) => r.dt === dt).map((r) => r.ratio).sort((a, b) => a - b);
  console.log(`${dt === "pop" ? "first frame" : `+${dt}ms`}: measured ${at.length}, gap/h p50 ${at[at.length >> 1]} p90 ${at[Math.floor(at.length * 0.9)]} max ${at.at(-1)}, >0.5h: ${at.filter((r) => r > 0.5).length}`);
}
console.log("worst first frame", measured.filter((r) => r.dt === "pop").sort((a, b) => b.ratio - a.ratio).slice(0, 16).map((r) => `${r.id}:${r.gapPx}px=${r.ratio}h ${r.side}`).join(", "));
console.log("worst +200", measured.filter((r) => r.dt === 200).sort((a, b) => b.ratio - a.ratio).slice(0, 16).map((r) => `${r.id}:${r.gapPx}px=${r.ratio}h ${r.side}`).join(", "));
console.log("shares rows (beside or touching)", measured.filter((r) => r.sharesRows).map((r) => `${r.id}+${r.dt}`).join(","));
console.log("other", JSON.stringify(results.filter((r) => r.ratio === undefined)));
