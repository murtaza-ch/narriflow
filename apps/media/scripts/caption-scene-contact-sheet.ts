// Contact sheet of the final triptychs: one row per Scene Style, one cell per key moment (each cell a
// triptych: sample | export | Studio, scaled down), with the template name and the mae under each cell.
//
//   bun apps/media/scripts/caption-scene-contact-sheet.ts [dir]   (default .scratch/motion-captions/out/final)
//
// Reads `<dir>/triptych/<scene>-<t>.png` and `<dir>/moments.json` ({ scene: [t, ...] }, written by caption-scene-final.ts) and
// `<dir>/mae.json` ({ "<scene>-<t>": mae }); writes `<dir>/contact.png`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp, { type OverlayOptions } from "sharp";

const dir = process.argv[2] ?? new URL("../../../.scratch/motion-captions/out/final", import.meta.url).pathname;
const moments: Record<string, number[]> = JSON.parse(readFileSync(join(dir, "moments.json"), "utf8"));
const mae: Record<string, number | null> = JSON.parse(readFileSync(join(dir, "mae.json"), "utf8"));
const CELL = { width: 540, height: 320 };
const LABEL = 22;
const GAP = 4;
const scenes = Object.keys(moments);
const columns = Math.max(...Object.values(moments).map((times) => times.length));
const composites: OverlayOptions[] = [];
for (const [row, scene] of scenes.entries()) {
  for (const [column, t] of moments[scene]!.entries()) {
    const key = `${scene}-${t}`;
    const left = column * (CELL.width + GAP);
    const top = row * (CELL.height + LABEL + GAP);
    const image = await sharp(join(dir, "triptych", `${key}.png`)).resize(CELL.width, CELL.height, { fit: "fill" }).toBuffer();
    composites.push({ input: image, left, top: top + LABEL });
    const value = mae[key];
    const text = `${scene} ${t} ms   mae ${value === null || value === undefined ? "-" : value.toFixed(1)}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL.width}" height="${LABEL}"><rect width="100%" height="100%" fill="#111"/><text x="6" y="16" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="${value !== null && value !== undefined && value > 18 ? "#ff8a80" : "#e6e6e6"}">${text}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left, top });
  }
}
const width = columns * (CELL.width + GAP) - GAP;
const height = scenes.length * (CELL.height + LABEL + GAP) - GAP;
await sharp({ create: { width, height, channels: 3, background: "#000" } }).composite(composites).png().toFile(join(dir, "contact.png"));
console.log(`${join(dir, "contact.png")} ${width}x${height}`);
