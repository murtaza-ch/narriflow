// Geometry of every preset's emojis on a 4-line script with 8 picks, through the export's own feeders (the plan, the
// classic/Dynamic/Scene cue boxes): sides, the gap from each emoji (at rest, 200 ms after it starts) to the nearest of its
// cue's text that reads on the emoji's first painted frame (Scene: its own text pieces then, and the plates they are written
// on, or the first frame of its pop that shows some; classic and Dynamic: `captionEmojiShownAtPop`), overlap with that text,
// drops per family, the shortest opaque time.
//
//   bun .scratch/add-emojis/tools/emoji-closeness.ts [positionY|default] [out.json]
import { spyOn } from "bun:test";
import { resolve } from "node:path";

const R = resolve(import.meta.dir, "../../..");
const cs = await import(`${R}/packages/caption-scene/src/index.ts`);
const v = await import(`${R}/packages/validators/src/index.ts`);
const sc = await import(`${R}/packages/caption-scene/src/scene.ts`);
const sup = await import(`${R}/packages/caption-scene/src/emoji/placement-support.ts`);
const fx = await import(`${R}/apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/emoji/caption-emoji-fixture.ts`);
const media = await import(`${R}/apps/media/src/caption-ass.ts`);
const art = await (await import(`${R}/packages/caption-emoji/src/art.ts`)).loadCaptionEmojiArt(["brain"]);

const W = 1080;
const H = 1920;
const posArg = process.argv[2] && process.argv[2] !== "default" ? Number(process.argv[2]) : null;
const script = ["I still remember the commercial", "my brain never forgot that one jingle", "it played every single night", "honestly it was pure genius"];
let t0 = 0.4;
const slice = script.map((text, index) => {
  const words = text.split(" ").map((word) => {
    const w = { word, startSec: +t0.toFixed(3), endSec: +(t0 + 0.32).toFixed(3), confidence: 1 };
    t0 += 0.36;
    return w;
  });
  t0 += 0.35;
  return { index, speaker: 0, speakerLabel: "S", startSec: words[0]!.startSec, endSec: words.at(-1)!.endSec, confidence: 1, text, words };
});
const all = slice.flatMap((u) => u.words);
const picks = ["remember", "commercial", "brain", "jingle", "played", "night", "honestly", "genius"].map((w) => all.find((x) => x.word === w)!);

type Box = { x1: number; y1: number; x2: number; y2: number };
const gapOf = (a: Box, b: Box) => Math.hypot(Math.max(0, b.x1 - a.x2, a.x1 - b.x2), Math.max(0, b.y1 - a.y2, a.y1 - b.y2));
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
const union = (boxes: Box[]): Box | null => (boxes.length ? { x1: Math.min(...boxes.map((b) => b.x1)), y1: Math.min(...boxes.map((b) => b.y1)), x2: Math.max(...boxes.map((b) => b.x2)), y2: Math.max(...boxes.map((b) => b.y2)) } : null);

const rows: Record<string, unknown>[] = [];
const placements: { id: string; kind: string; side: string; gap: number; overlap: boolean; opaqueMs: number; windowMs: number; safe: boolean }[] = [];
for (const p of v.CAPTION_PRESETS) {
  const kind = p.preset.scene ? "scene" : p.preset.dynamic ? "dynamic" : "classic";
  const base = fx.emojiFixtureDocument({ presetId: p.id });
  const doc = {
    ...base,
    clipEndSec: t0 + 1,
    transcriptSlice: slice,
    captionPreset: { ...base.captionPreset, ...(posArg === null ? {} : { positionY: posArg }) },
    studioEdits: { ...base.studioEdits, captionEmojis: Object.fromEntries(picks.map((w) => [v.captionWordKey(w.startSec), v.captionEmojiRefOnWord({ id: "brain" }, w.word)])) },
  };
  const layers = fx.emojiFixtureLayersFor(doc, {});
  const placeSpy = spyOn(cs, "placeCaptionEmojis");
  const sceneSpy = spyOn(cs, "captionSceneEmojiCueBoxes");
  let track: { emojis: { placed: number; dropped: Record<string, number> } };
  let calls: { input: Parameters<typeof cs.placeCaptionEmojis>[0]; output: ReturnType<typeof cs.placeCaptionEmojis> }[];
  let scene: { pieces: readonly any[] } | null = null;
  let measure: any = null;
  try {
    track = media.renderCaptionTrack({ layers, canvas: { width: W, height: H }, fps: 30, emojiArt: art });
    calls = placeSpy.mock.calls.map((call, at) => ({ input: call[0], output: placeSpy.mock.results[at]!.value }));
    if (sceneSpy.mock.calls[0]) [scene, , measure] = sceneSpy.mock.calls[0] as any;
  } finally {
    placeSpy.mockRestore();
    sceneSpy.mockRestore();
  }
  const picksN = layers.reduce((n: number, l: { emojis: unknown[] }) => n + l.emojis.length, 0);
  const sides: Record<string, number> = {};
  const noMeasure = () => ({ advance: 0, inkTop: 0, inkBottom: 0, ascent: 0, descent: 0 });
  for (const { input, output } of calls) {
    for (const o of output) {
      if (!o.placed) continue;
      if (input.cueBoxes[0] && !input.cueBoxes.some((b: { cueIndex: number }) => b.cueIndex === o.emoji.cueIndex)) continue;
      const pc = o.pieces[0]!;
      const t = Math.min(pc.fromMs + 200, pc.toMs - 1);
      const parts = o.pieces.map((q: any) => sup.emojiInkBounds(q, t, measure ?? noMeasure)).filter(Boolean) as Box[];
      const ink = union(parts)!;
      const h = ink.y2 - ink.y1;
      let visible: Box[];
      if (scene && measure) {
        // The cue's own text that reads on the emoji's first painted frame (else the first of its pop that shows some), and
        // any plate it is written on.
        visible = [];
        for (const at of cs.exportFrameTimes(pc.fromMs, pc.fromMs + 180, 30)) {
          if (visible.length > 0) break;
          const live = scene.pieces.filter((q: any) => at >= q.fromMs && at < q.toMs);
          const texts = live.flatMap((q: any) => {
            if (q.kind !== "text" || q.id.split(":")[1] !== String(o.emoji.cueIndex)) return [];
            if ((q.track.o ? cs.kf(at, q.track.o) : 1) < 0.1) return [];
            const b = sc.pieceBounds(q, at, measure);
            return b ? [{ x1: Math.max(0, b.x1), y1: Math.max(0, b.y1), x2: Math.min(W, b.x2), y2: Math.min(H, b.y2) }] : [];
          });
          const plates = live.flatMap((q: any) => {
            if (q.kind !== "shape" || q.bleed || (q.track.o ? cs.kf(at, q.track.o) : 1) < 0.5) return [];
            const b = sc.pieceBounds(q, at, measure);
            return b && texts.some((t: Box) => { const x = (t.x1 + t.x2) / 2, y = (t.y1 + t.y2) / 2; return x > b.x1 && x < b.x2 && y > b.y1 && y < b.y2; }) ? [b] : [];
          });
          visible.push(...texts, ...plates);
        }
      } else {
        // Classic: the line box. Dynamic: the words drawn by then (each from its onset), as the block's box reports them.
        const cue = input.cueBoxes.find((b: { cueIndex: number }) => b.cueIndex === o.emoji.cueIndex)!;
        visible = [...cs.captionEmojiShownAtPop(cue, pc.fromMs, 30)];
      }
      const texts = visible;
      const gap = texts.length ? Math.min(...texts.map((b) => gapOf(ink, b))) / h : 9;
      const opaqueMs = pc.track.o![0]![0] - pc.fromMs;
      const safe = ink.x1 >= 0.05 * W - 0.5 && ink.y1 >= 0.05 * H - 0.5 && ink.x2 <= 0.95 * W + 0.5 && ink.y2 <= 0.95 * H + 0.5;
      sides[o.side] = (sides[o.side] ?? 0) + 1;
      // Overlap: the emoji at t against the cue's text that reads at t (Scene), or its box.
      const now = scene && measure
        ? scene.pieces.flatMap((q: any) => {
            if (q.kind !== "text" || q.id.split(":")[1] !== String(o.emoji.cueIndex) || t < q.fromMs || t >= q.toMs || (q.track.o ? cs.kf(t, q.track.o) : 1) < 0.1) return [];
            const b = sc.pieceBounds(q, t, measure);
            return b ? [b] : [];
          })
        : visible;
      placements.push({ id: p.id, kind, side: o.side, gap: +gap.toFixed(3), overlap: now.some((b: Box) => meets(ink, b)), opaqueMs: Math.round(opaqueMs), windowMs: Math.round(pc.toMs - pc.fromMs), safe });
    }
  }
  rows.push({ id: p.id, kind, picks: picksN, placed: track!.emojis.placed, dropped: track!.emojis.dropped, sides });
}
const pct = (a: number[], q: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))]! : null);
const pos = posArg ?? "default";
console.log(`position ${pos}`);
for (const k of ["classic", "dynamic", "scene"]) {
  const g = rows.filter((r) => r.kind === k) as any[];
  const pl = placements.filter((x) => x.kind === k);
  const sides: Record<string, number> = {};
  for (const x of pl) sides[x.side] = (sides[x.side] ?? 0) + 1;
  const dropped = g.reduce((a: Record<string, number>, r) => { for (const [why, n] of Object.entries(r.dropped)) a[why] = (a[why] ?? 0) + (n as number); return a; }, {});
  const gaps = pl.map((x) => x.gap);
  console.log(`${k}: placed ${g.reduce((a, r) => a + r.placed, 0)} of ${g.reduce((a, r) => a + r.picks, 0)}, dropped ${JSON.stringify(dropped)}, sides ${JSON.stringify(sides)}, gap/h p50 ${pct(gaps, 0.5)} p90 ${pct(gaps, 0.9)} max ${pct(gaps, 1)}, >0.5h ${gaps.filter((g) => g > 0.5).length}, overlap ${pl.filter((x) => x.overlap).length}, outside safe ${pl.filter((x) => !x.safe).length}, min opaque ${Math.min(...pl.map((x) => x.opaqueMs))} ms, min window ${Math.min(...pl.map((x) => x.windowMs))} ms`);
}
const far = placements.filter((x) => x.gap > 0.5);
const byId: Record<string, number> = {};
for (const x of far) byId[x.id] = (byId[x.id] ?? 0) + 1;
console.log("far (>0.5h) by preset", JSON.stringify(byId));
console.log("dropping presets", rows.filter((r: any) => Object.keys(r.dropped).length).map((r: any) => `${r.id} ${JSON.stringify(r.dropped)}`).join(", "));
console.log("opaque <250 ms", placements.filter((x) => x.opaqueMs < 250).length, "of", placements.length);
if (process.argv[3]) await Bun.write(process.argv[3], JSON.stringify({ rows, placements }, null, 1));
