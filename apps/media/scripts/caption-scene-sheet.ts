/**
 * The primitives sheet (spec 5.1, calibration): `primitivesSheet()` drawn by libass (through the real
 * ASS writer) and by the Studio painter (`/prototype/caption-parity?sheet=1`), at several times, over
 * the same flat grey, and compared cell by cell.
 *
 *   bun apps/media/scripts/caption-scene-sheet.ts [--studio http://localhost:3290] [--times 0,350,...] [--only cell,cell]
 *
 * Prints, per cell and time, the mean absolute difference (0..255) over the pixels either frame inked,
 * and writes `<out>/sheet-<t>.png` (export | Studio) under `.scratch/motion-captions/out/sheet/`.
 * The largest difference among the cells that are meant to agree is the threshold the template
 * tickets are held to (recorded in the spec, section 5).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { SHEET_CANVAS, SHEET_TIMES_MS, primitivesSheet } from "@narriflow/caption-scene";
import { DEFAULT_CAPTION_PRESET } from "@narriflow/validators";
import { assScript } from "../src/caption-ass";
import { SceneMeasurer, sceneEvents } from "../src/caption-scene-ass";
import { renderAssRaw, type RawFrame } from "./caption-scene-probe";
import { studioShot } from "./caption-scene-triptych";

const FLAT = 0x70;
const ROOT = new URL("../../../", import.meta.url).pathname;

export interface CellResult {
  readonly id: string;
  readonly t: number;
  readonly mae: number;
  readonly pixels: number;
}

async function decode(path: string): Promise<RawFrame> {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

function cellDifference(a: RawFrame, b: RawFrame, rect: { x1: number; y1: number; x2: number; y2: number }, ink = 8) {
  let total = 0;
  let pixels = 0;
  for (let y = Math.max(0, Math.floor(rect.y1)); y < Math.min(a.height, Math.ceil(rect.y2)); y++) {
    for (let x = Math.max(0, Math.floor(rect.x1)); x < Math.min(a.width, Math.ceil(rect.x2)); x++) {
      const at = (y * a.width + x) * 3;
      let diff = 0;
      let inked = false;
      for (let c = 0; c < 3; c++) {
        diff += Math.abs(a.data[at + c]! - b.data[at + c]!);
        if (Math.abs(a.data[at + c]! - FLAT) > ink || Math.abs(b.data[at + c]! - FLAT) > ink) inked = true;
      }
      if (inked) {
        total += diff / 3;
        pixels++;
      }
    }
  }
  return { mae: pixels ? total / pixels : 0, pixels };
}

export async function runSheet(options: { studioUrl: string; times: readonly number[]; only?: readonly string[] }): Promise<CellResult[]> {
  const sheet = primitivesSheet();
  const measurer = new SceneMeasurer({ notices: new Map(), omitted: new Map() }, new Set(), null);
  const events = sceneEvents(sheet.scene, measurer, { canvas: SHEET_CANVAS });
  const ass = assScript(events, SHEET_CANVAS, DEFAULT_CAPTION_PRESET);
  const out = join(ROOT, ".scratch/motion-captions/out/sheet");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "sheet.ass"), ass);
  const work = mkdtempSync(join(tmpdir(), "scene-sheet-"));
  const results: CellResult[] = [];
  for (const t of options.times) {
    const exported = renderAssRaw({ ass, width: SHEET_CANVAS.width, height: SHEET_CANVAS.height, tMs: t, background: `0x${FLAT.toString(16).repeat(3)}` });
    const studioPng = join(work, `studio-${t}.png`);
    studioShot({ url: `${options.studioUrl}/prototype/caption-parity?sheet=1&t=${t}`, output: studioPng, width: SHEET_CANVAS.width, height: SHEET_CANVAS.height });
    const studio = await decode(studioPng);
    for (const cell of sheet.cells) {
      if (options.only && !options.only.includes(cell.id)) continue;
      const { mae, pixels } = cellDifference(exported, studio, cell.rect);
      results.push({ id: cell.id, t, mae, pixels });
    }
    const exportPng = await sharp(Buffer.from(exported.data), { raw: { width: exported.width, height: exported.height, channels: 3 } }).png().toBuffer();
    await sharp({ create: { width: SHEET_CANVAS.width * 2 + 8, height: SHEET_CANVAS.height, channels: 3, background: "#f0f" } })
      .composite([{ input: exportPng, left: 0, top: 0 }, { input: studioPng, left: SHEET_CANVAS.width + 8, top: 0 }])
      .png()
      .toFile(join(out, `sheet-${t}.png`));
  }
  return results;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const take = (flag: string) => {
    const at = args.indexOf(flag);
    return at < 0 ? undefined : args.splice(at, 2)[1];
  };
  const studioUrl = take("--studio") ?? "http://localhost:3290";
  const times = take("--times")?.split(",").map(Number) ?? [...SHEET_TIMES_MS];
  const only = take("--only")?.split(",");
  const results = await runSheet({ studioUrl, times, ...(only ? { only } : {}) });
  const ids = [...new Set(results.map((result) => result.id))];
  console.log(["cell".padEnd(30), ...times.map((t) => String(t).padStart(7))].join(" "));
  for (const id of ids) {
    console.log([id.padEnd(30), ...times.map((t) => (results.find((result) => result.id === id && result.t === t)?.mae.toFixed(1) ?? "-").padStart(7))].join(" "));
  }
}
