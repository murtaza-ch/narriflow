/**
 * Proof of fidelity: rasterises every source SVG and the same design rebuilt from its compiled
 * layers (default palette) at 128 px with resvg (supersampled, see `fidelity.ts`) and compares them. With `--pack <dir>` (the
 * extracted emoji pack) it also checks the 900 skin-tone variant files against the compiled art at
 * each tone; designs the pack does not have (drawn for Narriflow later) have no variant files to
 * check and are listed instead, their tones being the plain skin swap. Every sticker outline is checked against an exact raster dilation of its silhouette
 * (`outline-check.ts`). With `--out <dir>` it writes contact sheets, a sheet of the worst cases,
 * and sticker sheets (white outline and hard offset shadow) on a dark and a light background.
 *
 *   bun run --cwd packages/caption-emoji verify -- --pack /path/to/pack --out /path/to/sheets
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { CAPTION_EMOJI_BOX, type CaptionEmojiArt, loadCaptionEmojiArt } from "../src/art";
import {
  CAPTION_EMOJI_DEFAULT_PALETTE,
  CAPTION_EMOJI_GROUPS,
  CAPTION_EMOJI_INDEX,
  type CaptionEmojiPalette,
  resolveCaptionEmojiColour,
} from "../src/index";
import { readCatalog } from "./catalog";
import { compare, compiledSvg, MAX_WRONG_SHARE, PIXEL_TOLERANCE, render, type Score } from "./fidelity";
import { scoreOutline } from "./outline-check";

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const packDir = option("--pack");
/** Outlines worth a close look: tiny round parts in a wide band, notches, thin strokes, holes. */
const OUTLINE_CLOSEUPS = ["sun-behind-large-cloud", "police-car-light", "person-raising-hand", "snowflake", "roller-coaster", "recycle", "woman-astronaut", "hundred", "heart-hands", "link", "chains", "safety-pin"];
const outDir = option("--out");
const root = fileURLToPath(new URL("..", import.meta.url));
const sourceDir = join(root, "source");

const catalog = readCatalog(sourceDir);
const arts = await loadCaptionEmojiArt(CAPTION_EMOJI_INDEX.map((entry) => entry.id));
const scores: { id: string; score: Score }[] = [];
for (const design of catalog.designs) {
  const art = arts.get(design.id);
  if (!art) throw new Error(`no art for ${design.id}`);
  const source = render(readFileSync(join(sourceDir, design.file), "utf8"));
  scores.push({ id: design.id, score: compare(source, render(compiledSvg(art, CAPTION_EMOJI_DEFAULT_PALETTE))) });
}
scores.sort((x, y) => y.score.wrongShare - x.score.wrongShare || y.score.maxError - x.score.maxError);
const over = scores.filter((s) => s.score.wrongShare > MAX_WRONG_SHARE);
const meanErrors = scores.map((s) => s.score.meanError).sort((x, y) => x - y);

let toneReport: { checked: number; notInPack: string[]; over: { file: string; score: Score }[]; worst: { file: string; score: Score }[] } | null = null;
if (packDir) {
  const toneScores: { file: string; score: Score }[] = [];
  const notInPack: string[] = [];
  for (const [id, variants] of catalog.variants) {
    const art = arts.get(id)!;
    if (!existsSync(join(packDir, catalog.designs.find((design) => design.id === id)!.file))) {
      notInPack.push(id);
      continue;
    }
    for (const { tone, file } of variants) {
      const path = join(packDir, file);
      if (!existsSync(path)) throw new Error(`missing variant ${path}`);
      toneScores.push({ file, score: compare(render(readFileSync(path, "utf8")), render(compiledSvg(art, CAPTION_EMOJI_DEFAULT_PALETTE, tone))) });
    }
  }
  toneScores.sort((x, y) => y.score.wrongShare - x.score.wrongShare || y.score.maxError - x.score.maxError);
  toneReport = {
    checked: toneScores.length,
    notInPack,
    over: toneScores.filter((s) => s.score.wrongShare > MAX_WRONG_SHARE),
    worst: toneScores.slice(0, 5),
  };
}

const outlines = [...arts.values()].map((art) => ({ id: art.id, score: scoreOutline(art.layers.map((layer) => layer.d), art.outline) }));
const outlineFaults = outlines.filter(({ score }) => score.missing > 0 || score.uncovered > 0 || score.slivers > 0 || score.holes > 0);
const keptHoles = outlines.filter(({ score }) => score.kept > 0);
const mostFilled = [...outlines].sort((x, y) => y.score.filled - x.score.filled).slice(0, 8);

const fmt = (s: Score) => ({ maxError: +s.maxError.toFixed(1), wrongPct: +(s.wrongShare * 100).toFixed(3), wrongPx: s.wrong, meanError: +s.meanError.toFixed(3) });
console.log(
  JSON.stringify(
    {
      designs: scores.length,
      tolerance: { pixel: PIXEL_TOLERANCE, maxWrongPct: MAX_WRONG_SHARE * 100 },
      overThreshold: over.map((s) => s.id),
      worst: scores.slice(0, 12).map((s) => ({ id: s.id, ...fmt(s.score) })),
      meanError: { median: +meanErrors[Math.floor(meanErrors.length / 2)]!.toFixed(3), max: +meanErrors[meanErrors.length - 1]!.toFixed(3) },
      outlines: {
        checked: outlines.length,
        faults: outlineFaults.map(({ id, score }) => ({ id, ...score })),
        keptHoles: keptHoles.map(({ id, score }) => `${id} ${score.kept}`),
        mostFilled: mostFilled.map(({ id, score }) => `${id} ${score.filled}px`),
      },
      tones: toneReport && { checked: toneReport.checked, notInPack: toneReport.notInPack, over: toneReport.over.map((s) => s.file), worst: toneReport.worst.map((s) => ({ file: s.file, ...fmt(s.score) })) },
    },
    null,
    2,
  ),
);

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  const cell = 96;
  const sheet = (ids: string[], columns: number, draw: (id: string, x: number, y: number) => string, extraWidth = 0) => {
    const rows = Math.ceil(ids.length / columns);
    const width = columns * cell + extraWidth;
    const body = ids.map((id, i) => draw(id, (i % columns) * cell, Math.floor(i / columns) * cell)).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${rows * cell}" viewBox="0 0 ${width} ${rows * cell}"><rect width="100%" height="100%" fill="#3a3f4b"/>${body}</svg>`;
  };
  const nested = (svg: string, x: number, y: number, size: number) =>
    svg.replace(/^<svg ([^>]*?)width="\d+" height="\d+"/, `<svg $1x="${x}" y="${y}" width="${size}" height="${size}"`);
  const artAt = (palette: CaptionEmojiPalette, tone = 0) => (id: string, x: number, y: number) =>
    nested(compiledSvg(arts.get(id)!, palette, tone), x + 8, y + 8, cell - 16);

  // 13 per group (fewer in small groups), spread through each group: 120+ designs.
  const picks: string[] = [];
  for (const group of CAPTION_EMOJI_GROUPS) {
    const ids = CAPTION_EMOJI_INDEX.filter((e) => e.group === group.id).map((e) => e.id);
    const take = Math.min(13, ids.length);
    for (let k = 0; k < take; k += 1) picks.push(ids[Math.floor((k * ids.length) / take)]!);
  }
  const alternate: CaptionEmojiPalette = { a: "#5cd1ff", b: "#3b4cca", c: "#fff4c2" };
  const png = (svg: string) => new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
  writeFileSync(join(outDir, "contact-default.png"), png(sheet(picks, 13, artAt(CAPTION_EMOJI_DEFAULT_PALETTE))));
  writeFileSync(join(outDir, "contact-alternate.png"), png(sheet(picks, 13, artAt(alternate))));
  const toned = CAPTION_EMOJI_INDEX.filter((e) => e.hasTones).filter((_, i) => i % 15 === 0).map((e) => e.id);
  const toneSheet = toned.flatMap((id) => [0, 1, 2, 3, 4, 5].map((tone) => `${id}@${tone}`));
  writeFileSync(
    join(outDir, "contact-tones.png"),
    png(sheet(toneSheet, 6, (key, x, y) => {
      const [id, tone] = key.split("@");
      return artAt(CAPTION_EMOJI_DEFAULT_PALETTE, Number(tone))(id!, x, y);
    })),
  );
  // Worst cases: source (left) and compiled (right), at 3x the cell size.
  const worstIds = scores.slice(0, 16).map((s) => s.id);
  const big = 192;
  const pairs = worstIds
    .map((id, i) => {
      const file = catalog.designs.find((d) => d.id === id)!.file;
      const source = readFileSync(join(sourceDir, file), "utf8").replace(/<title>.*?<\/title>/, "");
      const y = i * big;
      return nested(source, 0, y, big) + nested(compiledSvg(arts.get(id)!, CAPTION_EMOJI_DEFAULT_PALETTE), big + 8, y, big);
    })
    .join("");
  writeFileSync(
    join(outDir, "worst-cases.png"),
    png(`<svg xmlns="http://www.w3.org/2000/svg" width="${big * 2 + 8}" height="${worstIds.length * big}"><rect width="100%" height="100%" fill="#3a3f4b"/>${pairs}</svg>`),
  );

  // Stickers: hard offset shadow (the outline moved down and right by the renderers' 0.04 of the
  // size, 2.56 grid units), white outline, then the layers, every piece in the one drawing box and
  // tilted 7 degrees about its centre, alternating.
  const box = CAPTION_EMOJI_BOX;
  const sticker = (art: CaptionEmojiArt, palette: CaptionEmojiPalette, shadow: string, tilt: number, x: number, y: number, size: number) => {
    const paths = art.layers
      .map((layer) => {
        const colour = resolveCaptionEmojiColour(layer.colour, palette, 0);
        return colour ? `<path d="${layer.d}" fill="${colour}"${layer.alpha === undefined ? "" : ` fill-opacity="${layer.alpha}"`}/>` : "";
      })
      .join("");
    const pieces = `<g transform="rotate(${-tilt} 32 32) translate(2.56 2.56) rotate(${tilt} 32 32)"><path d="${art.outline}" fill="${shadow}"/></g><path d="${art.outline}" fill="#ffffff"/>${paths}`;
    return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${box.x - 2} ${box.y - 2} ${box.width + 4} ${box.height + 4}"><g transform="rotate(${tilt} 32 32)">${pieces}</g></svg>`;
  };
  const stickerSheet = (ids: string[], columns: number, size: number, background: string, shadow: string, palette: CaptionEmojiPalette) => {
    const rows = Math.ceil(ids.length / columns);
    const body = ids.map((id, i) => sticker(arts.get(id)!, palette, shadow, i % 2 === 0 ? -7 : 7, (i % columns) * size, Math.floor(i / columns) * size, size)).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * size}" height="${rows * size}"><rect width="100%" height="100%" fill="${background}"/>${body}</svg>`;
  };
  writeFileSync(join(outDir, "sticker-dark.png"), png(stickerSheet(picks, 13, cell, "#1d2230", "#000000", CAPTION_EMOJI_DEFAULT_PALETTE)));
  writeFileSync(join(outDir, "sticker-light.png"), png(stickerSheet(picks, 13, cell, "#eef0f4", "#271e35", alternate)));
  // Close-ups: the outlines that were hard to get right and those the closing filled most.
  const closeups = [...new Set([...OUTLINE_CLOSEUPS, ...mostFilled.map((m) => m.id)])];
  writeFileSync(join(outDir, "sticker-closeups.png"), png(stickerSheet(closeups, 4, 256, "#1d2230", "#000000", CAPTION_EMOJI_DEFAULT_PALETTE)));
  console.log(`sheets written to ${outDir} (${picks.length} designs on the contact sheets)`);
}

if (over.length > 0 || outlineFaults.length > 0 || (toneReport && toneReport.over.length > 0)) process.exit(1);
