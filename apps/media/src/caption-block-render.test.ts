import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_FONTS_DIRECTORY, shapeCaptionRun } from "@narriflow/caption-fonts";
import type { CompositionCaptionBlock, CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import {
  CAPTION_MOTIONS,
  captionBlockAnimation,
  captionDynamicStyle,
  captionEntranceKeyframes,
  captionFontFace,
  captionKeyframeValue,
  captionPresetSchema,
  getCaptionPresetById,
  textDirection,
} from "@narriflow/validators";
import { CANVAS, dynamicCaptionFixtures, dynamicCaptionLayers } from "../scripts/dynamic-caption-fixtures";
import type { CaptionBlockWord } from "./caption-block-geometry";
import { captionBlockGeometry, renderCaptionTrack } from "./caption-ass";

/**
 * Caption Block words over the real ffmpeg/libass (spec section 11). Every
 * word of every fixture case must be drawn where the shared geometry put it,
 * settled and 100 ms into its entrance. The method is the ticket 02 parity
 * method (`.scratch/dynamic-captions/references/proof/parity.ts`):
 *
 * - Baseline, from the event and the pose, not from pixels. libass's baseline
 *   comes from the word's text event alone: `\an5` centres the line box on
 *   `\pos` (or on `\move` at libass's integer-ms clock), and the line box is
 *   the tallest winAscent and deepest winDescent among the faces drawing the
 *   word, read from the font files' OS/2 tables and scaled so each face's pair
 *   spans its `\fs`. The model is calibrated once against libass renders of a
 *   flat-bottomed "H" at known sub-pixel `\pos`. It is compared with the
 *   geometry's `baselineY` plus the shared entrance pose at that time.
 * - Ink bounds, from solid masks. The word's text event is rendered alone on
 *   black, solid white at full opacity, without fade or blur. Ink is every
 *   pixel at 50 % coverage or more. Empty, tiny or frame-filling masks are
 *   rejected. The expected box is HarfBuzz glyph ink placed at the geometry's
 *   advance box, moved by the pose.
 *
 * Tolerances (1080 wide): baselines 2 px, left edges 4 px, ink bounds 4 px.
 * `CAPTION_BLOCK_PARITY=1` prints the measured table.
 */
const { width: WIDTH, height: HEIGHT } = CANVAS;
const TOLERANCE = { baseline: 2, left: 4, bounds: 4 } as const;
const COVERAGE = 128;
const MASK_MIN_PIXELS = 50;
const MASK_MAX_FRACTION = 0.5;
/** The block painter's text layer (`LAYER.text` in caption-ass.ts). */
const TEXT_LAYER = 5;
/** A frame at 30 fps. */
const FRAME_SEC = 1 / 30;
const ENTRANCE_PROBE_MS = 100;
// One libass render per word and moment plus calibration; a loaded machine can exceed the 5 s default.
const RENDER_TEST_TIMEOUT_MS = 120_000;

type BlockLayer = CompositionCaptionVisualLayer & { readonly block: CompositionCaptionBlock };

function render(script: string, atSec: number): Buffer {
  const directory = mkdtempSync(join(tmpdir(), "caption-block-"));
  try {
    const ass = join(directory, "captions.ass");
    writeFileSync(ass, script);
    const run = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=black:s=${WIDTH}x${HEIGHT}:d=1`,
      "-vf", `format=rgb24,settb=1/1000000,setpts=${atSec}/TB,ass='${ass}':fontsdir='${CAPTION_FONTS_DIRECTORY}'`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ], { maxBuffer: WIDTH * HEIGHT * 3 * 2 });
    if (run.status !== 0) throw new Error(run.stderr.toString());
    return run.stdout;
  } finally {
    rmSync(directory, { recursive: true });
  }
}

/** The ms clock libass sees for `setpts=${at}/TB` after `settb=1/1000000`: setpts and the ass filter both truncate. */
const libassNowMs = (atSec: number) => Math.trunc(Math.trunc(atSec * 1_000_000) / 1000);

interface MaskBox {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Solid-mask ink box: pixels at >= 50 % coverage, right and bottom exclusive. Rejects empty and implausible renders. */
function maskBox(rgb: Buffer, label: string): MaskBox {
  if (rgb.length !== WIDTH * HEIGHT * 3) throw new Error(`${label}: expected ${WIDTH}x${HEIGHT} rgb24, got ${rgb.length} bytes`);
  let peak = 0;
  let pixels = 0;
  const box = { left: WIDTH, right: -1, top: HEIGHT, bottom: -1 };
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const at = (y * WIDTH + x) * 3;
      const value = Math.max(rgb[at]!, rgb[at + 1]!, rgb[at + 2]!);
      if (value > peak) peak = value;
      if (value < COVERAGE) continue;
      pixels++;
      if (x < box.left) box.left = x;
      if (x + 1 > box.right) box.right = x + 1;
      if (y < box.top) box.top = y;
      if (y + 1 > box.bottom) box.bottom = y + 1;
    }
  }
  if (peak === 0) throw new Error(`${label}: empty render (peak 0)`);
  if (pixels < MASK_MIN_PIXELS) throw new Error(`${label}: mask has ${pixels} pixels at >= 50 % coverage, under ${MASK_MIN_PIXELS}`);
  if (pixels > MASK_MAX_FRACTION * WIDTH * HEIGHT) throw new Error(`${label}: mask covers more than ${100 * MASK_MAX_FRACTION} % of the frame`);
  return box;
}

/** Sub-pixel bottom edge of a flat-bottomed glyph: per full-height stem column, last full row plus the next row's coverage. */
function flatBottomEdge(rgb: Buffer, label: string): number {
  const box = maskBox(rgb, label);
  const value = (x: number, y: number) => rgb[(y * WIDTH + x) * 3 + 1]!;
  const edges: number[] = [];
  for (let x = box.left; x < box.right; x++) {
    let full = -1;
    for (let y = box.bottom - 1; y >= box.top; y--) {
      if (value(x, y) >= 250) {
        full = y;
        break;
      }
    }
    let run = 0;
    for (let y = full; y >= box.top && value(x, y) >= 250; y--) run++;
    if (full < 0 || run < 0.6 * (box.bottom - box.top)) continue;
    edges.push(full + 1 + (full + 1 < HEIGHT ? value(x, full + 1) / 255 : 0));
  }
  if (edges.length === 0) throw new Error(`${label}: no stem columns`);
  edges.sort((left, right) => left - right);
  return edges[Math.floor(edges.length / 2)]!;
}

// Font metrics as libass reads them: OS/2 usWinAscent / usWinDescent, matched by full name (name ID 4) as `\fn` is.
interface WinMetrics {
  readonly winAscent: number;
  readonly winDescent: number;
}
function readWinMetrics(path: string): { fullName: string | null; metrics: WinMetrics } {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map<string, number>();
  for (let index = 0; index < view.getUint16(4); index++) {
    const record = 12 + 16 * index;
    tables.set(bytes.toString("latin1", record, record + 4), view.getUint32(record + 8));
  }
  const os2 = tables.get("OS/2")!;
  const name = tables.get("name")!;
  const strings = name + view.getUint16(name + 4);
  let fullName: string | null = null;
  for (let index = 0; index < view.getUint16(name + 2); index++) {
    const record = name + 6 + 12 * index;
    if (view.getUint16(record) !== 3 || view.getUint16(record + 6) !== 4) continue;
    const start = strings + view.getUint16(record + 10);
    const raw = bytes.subarray(start, start + view.getUint16(record + 8));
    fullName = Array.from({ length: raw.length / 2 }, (_, at) => String.fromCharCode(raw.readUInt16BE(2 * at))).join("");
    break;
  }
  return { fullName, metrics: { winAscent: view.getInt16(os2 + 74), winDescent: view.getInt16(os2 + 76) } };
}
const FACE_METRICS = new Map<string, WinMetrics>();
for (const file of readdirSync(CAPTION_FONTS_DIRECTORY).filter((name) => /\.(ttf|otf)$/.test(name))) {
  const { fullName, metrics } = readWinMetrics(join(CAPTION_FONTS_DIRECTORY, file));
  if (fullName) FACE_METRICS.set(fullName, metrics);
}

const assSeconds = (time: string) => time.split(":").reduce((total, part) => total * 60 + Number(part), 0);

/** The `\fn`/`\fs` state of every drawn text run of an event, in order. */
function drawnRuns(text: string): { fontName: string; fs: number }[] {
  const runs: { fontName: string; fs: number }[] = [];
  let fontName: string | null = null;
  let fs = Number.NaN;
  for (const [, block, drawn] of text.matchAll(/\{([^}]*)\}|([^{]+)/g)) {
    if (block !== undefined) {
      for (const [, tag, value] of block.matchAll(/\\(fn|fs)([^\\]*)/g)) {
        if (tag === "fn") fontName = value!;
        else if (/^[\d.]+$/.test(value!)) fs = Number(value);
      }
    } else if (drawn) {
      if (!fontName || !Number.isFinite(fs)) throw new Error(`text drawn without a known \\fn and \\fs: ${text.slice(0, 120)}`);
      runs.push({ fontName, fs });
    }
  }
  return runs;
}

/** The baseline libass draws for one `\an5` Dialogue line at libass time `nowMs`, before calibration. */
function eventBaseline(line: string, nowMs: number): { baselineY: number; x: number } {
  const fields = line.split(",");
  const startMs = Math.round(assSeconds(fields[1]!) * 100) * 10;
  const text = fields.slice(9).join(",");
  const tags = text.slice(1, text.indexOf("}"));
  if (!/^\\an5/.test(tags)) throw new Error(`the model covers \\an5 events only: ${line.slice(0, 120)}`);
  let ascent = 0;
  let descent = 0;
  for (const run of drawnRuns(text)) {
    const face = FACE_METRICS.get(run.fontName);
    if (!face) throw new Error(`no font file with the full name "${run.fontName}"`);
    // FT_SIZE_REQUEST_TYPE_REAL_DIM: winAscent + winDescent spans exactly \fs.
    ascent = Math.max(ascent, (run.fs * face.winAscent) / (face.winAscent + face.winDescent));
    descent = Math.max(descent, (run.fs * face.winDescent) / (face.winAscent + face.winDescent));
  }
  const move = /\\move\(([^)]*)\)/.exec(tags);
  const pos = /\\pos\(([^)]*)\)/.exec(tags);
  let x: number;
  let y: number;
  if (move) {
    const [x1, y1, x2, y2, t1, t2] = move[1]!.split(",").map(Number) as number[];
    const t = nowMs - startMs;
    const k = t <= t1! ? 0 : t >= t2! ? 1 : (t - t1!) / (t2! - t1!);
    x = x1! + (x2! - x1!) * k;
    y = y1! + (y2! - y1!) * k;
  } else if (pos) {
    [x, y] = pos[1]!.split(",").map(Number) as [number, number];
  } else {
    throw new Error(`event without \\pos or \\move: ${line.slice(0, 120)}`);
  }
  return { baselineY: y + (ascent - descent) / 2, x };
}

function header(ass: string): string {
  return ass.slice(0, ass.indexOf("[Events]")) + "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
}

const assTime = (seconds: number) => {
  const cs = Math.round(seconds * 100);
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, "0")}:${String(Math.floor((cs % 6000) / 100)).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** The word's text event drawn as a solid white mask: no fade, no blur, full opacity; position and timing untouched. */
function solidMask(line: string): string {
  return line
    .replace(/\\fade\([^)]*\)/g, "")
    .replace(/\\t\([^()]*\\blur[\d.]+\)/g, "")
    .replace(/\\blur[\d.]+/g, "")
    .replace(/\\1c&H[0-9A-Fa-f]+&/g, "\\1c&HFFFFFF&")
    .replace(/\\alpha&H[0-9A-Fa-f]+&/g, "\\alpha&H00&");
}

/** HarfBuzz ink of a word, laid out as libass draws it (letter spacing after every cluster), in em from its advance box's left edge. */
function inkExtentEm(word: CaptionBlockWord): { left: number; right: number } {
  const parts = textDirection(word.text, "ltr") === "rtl" ? [...word.parts].reverse() : word.parts;
  let cursor = 0;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    const run = shapeCaptionRun(part.face.path, part.text, textDirection(part.text, "ltr") === "rtl");
    const spacing = part.spaced ? word.look.letterSpacing : 0;
    run.clusters.forEach((cluster, index) => {
      if (cluster.inkLeftEm === null || cluster.inkRightEm === null) return;
      left = Math.min(left, cursor + cluster.inkLeftEm + index * spacing);
      right = Math.max(right, cursor + cluster.inkRightEm + index * spacing);
    });
    cursor += run.advanceEm + run.clusters.length * spacing;
  }
  return { left, right };
}

interface ParityRow {
  readonly fixture: string;
  readonly word: string;
  readonly moment: string;
  readonly geometryBaseline: number;
  readonly libassBaseline: number;
  readonly expected: MaskBox;
  readonly ink: MaskBox;
}
const parity: ParityRow[] = [];

describe.skipIf(!Bun.which("ffmpeg"))("Caption Block words over the real libass", () => {
  const fixtures = dynamicCaptionFixtures();
  let baselineOffset = Number.NaN;

  test("calibration: libass draws an event's baseline where the line-box model puts it", () => {
    const anyAss = renderCaptionTrack({ layers: dynamicCaptionLayers(fixtures[0]!), canvas: CANVAS }).ass;
    const residuals: number[] = [];
    for (const fontName of ["Inter SemiBold", "Inter"] as const) {
      const face = captionFontFace(fontName);
      for (const emPx of [80, 272]) {
        const fs = Math.round(emPx * (face.ascent + face.descent) * 100) / 100;
        for (const y of [1000, 1000.25, 1000.5, 1000.75]) {
          const line = `Dialogue: 0,0:00:00.00,0:00:02.00,Caption,,0,0,0,,{\\an5\\fn${face.assName}\\fs${fs}\\fsp0\\bord0\\shad0\\pos(540,${y})\\1c&HFFFFFF&}H`;
          const measured = flatBottomEdge(render(`${header(anyAss)}${line}\n`, 0.5), `calibration ${fontName} ${emPx}px y ${y}`);
          residuals.push(measured - eventBaseline(line, 500).baselineY);
        }
      }
    }
    baselineOffset = residuals.reduce((total, residual) => total + residual, 0) / residuals.length;
    for (const residual of residuals) expect(Math.abs(residual - baselineOffset)).toBeLessThan(0.1);
    expect(Math.abs(baselineOffset)).toBeLessThan(0.25);
  }, RENDER_TEST_TIMEOUT_MS);

  for (const fixture of fixtures) {
    test(`${fixture.id}: every word's baseline and ink sit where the geometry says, settled and mid-entrance`, () => {
      expect(Number.isFinite(baselineOffset), "calibration ran first").toBe(true);
      const layers = dynamicCaptionLayers(fixture);
      const { ass } = renderCaptionTrack({ layers, canvas: CANVAS });
      const lines = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
      for (const cue of layers) {
        expect(cue.block, `${fixture.id}: cue ${cue.cueIndex} has a block`).toBeDefined();
        const layer = cue as BlockLayer;
        const geometry = captionBlockGeometry({ cue: layer, canvas: CANVAS });
        const motion = CAPTION_MOTIONS[captionBlockAnimation(layer.preset, captionDynamicStyle(layer.block.style))];
        const end = layer.activeRange.endSec;
        geometry.words.forEach((word, index) => {
          const placed = geometry.layout.words[index]!;
          const startSec = layer.words[index]!.startSec;
          expect(placed.rotationDeg, "Headline words are upright; turned words need a rotated ink model").toBe(0);
          const keyframes = captionEntranceKeyframes(motion, layer.block.roles[index] === "hero");
          for (const frame of keyframes) {
            const modelled = ["at", "ease", "opacity", "blurEm", "offsetXEm", "offsetYEm"];
            const extra = Object.keys(frame).filter((key) => !modelled.includes(key));
            expect(extra, "the pose model covers travel, opacity and blur only").toEqual([]);
          }
          const text = lines.filter((line) => line.startsWith(`Dialogue: ${TEXT_LAYER},${assTime(startSec)},`));
          expect(text, `${fixture.id} "${word.text}": one text event`).toHaveLength(1);
          const moments = [
            ...(startSec + ENTRANCE_PROBE_MS / 1000 < end - FRAME_SEC ? [{ name: `+${ENTRANCE_PROBE_MS} ms`, atSec: startSec + ENTRANCE_PROBE_MS / 1000 }] : []),
            // One frame before the cue ends: every (duration-capped) entrance has finished.
            { name: "settled", atSec: end - FRAME_SEC },
          ];
          for (const moment of moments) {
            const label = `${fixture.id} "${word.text}" ${moment.name}`;
            // The shared pose at this time (what the Studio draws), from the geometry's own time scale.
            const tMs = (moment.atSec - startSec) * 1000;
            const sample = (property: "offsetXEm" | "offsetYEm") =>
              placed.entranceTimeScale === 0 ? 0 : (captionKeyframeValue(keyframes, property, tMs / placed.entranceTimeScale) ?? 0);
            const dx = sample("offsetXEm") * placed.px * placed.motionSign;
            const dy = sample("offsetYEm") * placed.px;
            const geometryBaseline = placed.baselineY + dy;
            const libassBaseline = eventBaseline(text[0]!, libassNowMs(moment.atSec)).baselineY + baselineOffset;
            const ink = maskBox(render(`${header(ass)}${solidMask(text[0]!)}\n`, moment.atSec), label);
            const extent = inkExtentEm(word);
            const expected = {
              left: placed.baselineX + dx + extent.left * placed.px,
              right: placed.baselineX + dx + extent.right * placed.px,
              top: geometryBaseline - word.measured.inkTopEm * placed.px,
              bottom: geometryBaseline + word.measured.inkBottomEm * placed.px,
            };
            parity.push({ fixture: fixture.id, word: word.text, moment: moment.name, geometryBaseline, libassBaseline, expected, ink });
            expect(Math.abs(libassBaseline - geometryBaseline), `${label}: baseline ${libassBaseline} vs ${geometryBaseline}`).toBeLessThanOrEqual(TOLERANCE.baseline);
            expect(Math.abs(ink.left - expected.left), `${label}: left ${ink.left} vs ${expected.left}`).toBeLessThanOrEqual(TOLERANCE.left);
            expect(Math.abs(ink.right - expected.right), `${label}: right ${ink.right} vs ${expected.right}`).toBeLessThanOrEqual(TOLERANCE.bounds);
            expect(Math.abs(ink.top - expected.top), `${label}: top ${ink.top} vs ${expected.top}`).toBeLessThanOrEqual(TOLERANCE.bounds);
            expect(Math.abs(ink.bottom - expected.bottom), `${label}: bottom ${ink.bottom} vs ${expected.bottom}`).toBeLessThanOrEqual(TOLERANCE.bounds);
          }
        });
      }
    }, RENDER_TEST_TIMEOUT_MS);
  }

  test("a letter-spaced classic line keeps its kerning (Kerning: yes, one \\fsp, Encoding -1)", () => {
    const [cue] = dynamicCaptionLayers(fixtures[0]!);
    const { block: _block, ...rest } = cue!;
    const preset = captionPresetSchema.parse({
      ...getCaptionPresetById("bold-pop")!.preset,
      animation: "none", outlineWidth: 0, shadow: "none", textTransform: "none", letterSpacing: -0.03, fontName: "Inter",
    });
    const classic: CompositionCaptionVisualLayer = {
      ...rest,
      preset,
      words: [{ text: "AVAVAV", emoji: null, startSec: 1, endSec: 2 }],
      activeRange: { startSec: 1, endSec: 2 },
    };
    const { ass } = renderCaptionTrack({ layers: [classic], canvas: CANVAS });
    const text = ass.split("\n").filter((line) => line.startsWith(`Dialogue: ${TEXT_LAYER},`));
    expect(text).toHaveLength(1);
    const px = Number(/\\fs([\d.]+)/.exec(text[0]!)![1]) / (captionFontFace("Inter").ascent + captionFontFace("Inter").descent);
    const ink = maskBox(render(`${header(ass)}${solidMask(text[0]!)}\n`, 1.5), "AVAVAV");
    const run = shapeCaptionRun(join(CAPTION_FONTS_DIRECTORY, captionFontFace("Inter").file), "AVAVAV");
    const last = run.clusters.length - 1;
    // Kerned HarfBuzz ink width with the tracking between clusters. Unkerned, libass draws it about 80 px wider here.
    const expectedWidth = (run.clusters[last]!.inkRightEm! + last * -0.03 - run.clusters[0]!.inkLeftEm!) * px;
    expect(Math.abs(ink.right - ink.left - expectedWidth)).toBeLessThanOrEqual(TOLERANCE.bounds);
  }, RENDER_TEST_TIMEOUT_MS);

  test("parity table", () => {
    if (!process.env.CAPTION_BLOCK_PARITY) return;
    const f = (value: number) => (Math.round(value * 100) / 100).toFixed(2);
    const lines = [
      "| Case | Word | Moment | Geometry baseline | libass baseline | Δ baseline | Geometry ink x / y | libass ink x / y | Δ left | Δ right | Δ top | Δ bottom |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...parity.map((row) =>
        `| ${row.fixture} | ${row.word} | ${row.moment} | ${f(row.geometryBaseline)} | ${f(row.libassBaseline)} | ${f(row.libassBaseline - row.geometryBaseline)} | ` +
        `${Math.round(row.expected.left)}-${Math.round(row.expected.right)} / ${Math.round(row.expected.top)}-${Math.round(row.expected.bottom)} | ` +
        `${row.ink.left}-${row.ink.right} / ${row.ink.top}-${row.ink.bottom} | ` +
        `${f(row.ink.left - row.expected.left)} | ${f(row.ink.right - row.expected.right)} | ${f(row.ink.top - row.expected.top)} | ${f(row.ink.bottom - row.expected.bottom)} |`,
      ),
    ];
    console.log(lines.join("\n"));
  });

  test("a rejected mask fails loudly instead of passing", () => {
    expect(() => maskBox(Buffer.alloc(WIDTH * HEIGHT * 3), "black")).toThrow(/empty render/);
    expect(() => maskBox(Buffer.alloc(WIDTH * HEIGHT * 3, 255), "white")).toThrow(/more than 50 %/);
    expect(() => maskBox(Buffer.alloc(10), "short")).toThrow(/rgb24/);
    const dot = Buffer.alloc(WIDTH * HEIGHT * 3);
    dot.fill(255, 0, 3 * 10);
    expect(() => maskBox(dot, "dot")).toThrow(/under 50/);
  });
});
