/**
 * Throwaway look proof (ticket 02): numeric ASS vs HTML parity for the first cue.
 *
 *   bun .scratch/dynamic-captions/references/proof/parity.ts [workDir]   (from the worktree root, after build.ts)
 *
 * Two separate measurements per moment (onset, +100 ms, settled) and per word already spoken:
 *
 * 1. Baseline, from layout and pose, not pixels. Tolerance 2 px.
 *    - HTML: the page as render.sh shoots it (`?shot&t=`), in the same headless Chrome run that takes the
 *      screenshot (`--screenshot` plus `--dump-dom`). Each word's text starts with a zero-size inline-block
 *      baseline anchor; the page writes the anchor's client rect (pose transform included) to <script id="metrics">.
 *    - libass: computed from the word's Layer 1 Dialogue event alone: `\an5` centres the line box
 *      (winAscent + winDescent from the font file's OS/2 table, scaled so they sum to `\fs`) on `\pos`, so the
 *      baseline is y + (ascent - descent) / 2; `\move` is interpolated at libass's integer-ms clock exactly as
 *      ffmpeg feeds it (setpts truncates to the timebase, the ass filter truncates to ms). Calibrated once
 *      against libass renders of a flat-bottomed "H" at known `\pos` (static) and on a 1 px/ms `\move` (clock).
 * 2. Ink bounds, from solid masks. Tolerance 4 px (left edge 4 px too). Each word alone on flat black, solid
 *    white, full opacity, no shadow, no gradient (libass: that word's first Layer 1 event with `\clip`, `\fade`
 *    and colour removed; HTML: `&flat&mask&only=N`). Position and blur still follow the pose. Ink is every pixel
 *    with at least 50 % coverage (value 128 of 255), so gradient brightness and opacity cannot move the contour.
 *
 * Every render is checked before it is compared: a zero-peak image, a mask under 50 pixels, or a mask over
 * 50 % of the frame throws. Intermediate files go to workDir (default os.tmpdir()/narriflow-parity).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HERE = import.meta.dir;
const ROOT = resolve(HERE, "../../../..");
const FONTS = join(ROOT, "packages/caption-fonts/fonts");
const WORK = Bun.argv[2] ?? join(tmpdir(), "narriflow-parity");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE = "/.scratch/dynamic-captions/references/proof/headline.html";
const WIDTH = 1080;
const HEIGHT = 1920;
const MOMENTS = [
  { name: "onset", at: 0.266667 },
  { name: "+100 ms", at: 0.35 },
  { name: "settled", at: 1.2 },
] as const;
const TOLERANCE = { baseline: 2, left: 4, bounds: 4 };
const COVERAGE = 128;
const MASK_MIN_PIXELS = 50;
const MASK_MAX_FRACTION = 0.5;
mkdirSync(WORK, { recursive: true });

interface Word { text: string; startSec: number }
const cue = (JSON.parse(readFileSync(join(HERE, "cues.json"), "utf8")) as { cues: { endSec: number; words: Word[] }[] }).cues[0]!;

// ---------------------------------------------------------------------------------------------------------
// Font metrics as libass reads them: OS/2 usWinAscent / usWinDescent (int16, GDI-style), matched by full name.

interface FaceMetrics { winAscent: number; winDescent: number }
function readFace(path: string): { fullName: string | null; metrics: FaceMetrics } {
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
const faces = new Map<string, FaceMetrics>();
for (const file of readdirSync(FONTS).filter((name) => /\.(ttf|otf)$/.test(name))) {
  const { fullName, metrics } = readFace(join(FONTS, file));
  if (fullName) faces.set(fullName, metrics);
}

// ---------------------------------------------------------------------------------------------------------
// ASS event model: the baseline libass draws for one `\an5` event at a given render time.

const assLines = readFileSync(join(HERE, "headline.ass"), "utf8").split("\n");
const assHeader = assLines.filter((line) => !line.startsWith("Dialogue:"));
const assSeconds = (time: string) => {
  const [h, m, s] = time.split(":").map(Number);
  return h! * 3600 + m! * 60 + s!;
};

/** The ms clock libass sees for `setpts=${at}/TB` after `settb=1/1000000`: setpts and the ass filter both truncate. */
function libassNowMs(at: number): number {
  const tb = 1 / 1000000;
  const pts = Math.trunc(at / tb);
  return Math.trunc(pts * tb * 1000);
}

interface EventPose { baselineY: number; restBaselineY: number; dy: number; dx: number; tMs: number }
function eventBaseline(line: string, nowMs: number, offset = 0): EventPose {
  const fields = line.split(",");
  const startMs = Math.round(assSeconds(fields[1]!) * 100) * 10;
  const endMs = Math.round(assSeconds(fields[2]!) * 100) * 10;
  const tags = line.slice(line.indexOf("{") + 1, line.indexOf("}"));
  const an = Number(/\\an(\d)/.exec(tags)?.[1] ?? 5);
  if (an !== 5) throw new Error(`parity.ts models \\an5 only, got \\an${an}`);
  const fontName = /\\fn([^\\]+)/.exec(tags)?.[1];
  const fs = Number(/\\fs([\d.]+)/.exec(tags)?.[1]);
  const face = fontName ? faces.get(fontName) : undefined;
  if (!face || !Number.isFinite(fs)) throw new Error(`event without a known \\fn and \\fs: ${line.slice(0, 120)}`);
  // FT_SIZE_REQUEST_TYPE_REAL_DIM: winAscent + winDescent spans exactly \fs.
  const ascent = (fs * face.winAscent) / (face.winAscent + face.winDescent);
  const descent = (fs * face.winDescent) / (face.winAscent + face.winDescent);
  const half = (ascent - descent) / 2;

  const t = nowMs - startMs;
  const pos = /\\pos\(([^)]*)\)/.exec(tags);
  const move = /\\move\(([^)]*)\)/.exec(tags);
  let x: number;
  let y: number;
  let restX: number;
  let restY: number;
  if (move) {
    const [x1, y1, x2, y2, a = 0, b = 0] = move[1]!.split(",").map(Number) as number[];
    // libass: no times (or both <= 0) means the whole event; then a linear step at integer ms.
    const [t1, t2] = a! <= 0 && b! <= 0 ? [0, endMs - startMs] : [a!, b!];
    const k = t <= t1 ? 0 : t >= t2 ? 1 : (t - t1) / (t2 - t1);
    x = x1! + (x2! - x1!) * k;
    y = y1! + (y2! - y1!) * k;
    restX = x2!;
    restY = y2!;
  } else if (pos) {
    [x, y] = pos[1]!.split(",").map(Number) as [number, number];
    restX = x;
    restY = y;
  } else {
    throw new Error("event without \\pos or \\move");
  }
  return { baselineY: y + half + offset, restBaselineY: restY + half + offset, dy: y - restY, dx: x - restX, tMs: t };
}

// ---------------------------------------------------------------------------------------------------------
// Rendering and mask checks.

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const file = Bun.file(join(ROOT, path));
    return file.size > 0 ? new Response(file) : new Response("not found", { status: 404 });
  },
});

// Async on purpose: Chrome fetches from this process's server, which a synchronous spawn would block.
async function run(command: string[]): Promise<Buffer> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${stderr}`);
  return Buffer.from(stdout);
}

function libassRender(script: string, at: number): Promise<Buffer> {
  return run([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${WIDTH}x${HEIGHT}:d=1`,
    "-vf", `format=rgb24,settb=1/1000000,setpts=${at}/TB,ass=${script}:fontsdir=${FONTS}`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
}

interface DomWord { cue: number; index: number; text: string; penX: number; baselineY: number; pose: { dx: number; dy: number; blur: number; opacity: number } }
/** One Chrome run: the screenshot plus the DOM metrics the same page instance wrote. */
async function htmlRender(query: string, at: number, png: string): Promise<{ rgb: Buffer; words: DomWord[] }> {
  const dom = (await run([
    CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${WIDTH},${HEIGHT}`,
    "--virtual-time-budget=4000", `--screenshot=${png}`, "--dump-dom",
    `http://127.0.0.1:${server.port}${PAGE}?shot${query}&t=${at}`,
  ])).toString("utf8");
  const json = /<script type="application\/json" id="metrics">([^<]*)<\/script>/.exec(dom)?.[1];
  if (!json) throw new Error(`no metrics in the DOM of ${query} at ${at}`);
  const rgb = await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return { rgb, words: (JSON.parse(json) as { words: DomWord[] }).words.filter((word) => word.cue === 0) };
}

/** Solid-mask ink box: pixels at >= 50 % coverage. Rejects empty and implausible renders. */
function maskBox(rgb: Buffer, label: string) {
  if (rgb.length !== WIDTH * HEIGHT * 3) throw new Error(`${label}: expected ${WIDTH}x${HEIGHT} rgb24, got ${rgb.length} bytes`);
  let peak = 0;
  let pixels = 0;
  const box = { left: WIDTH, right: -1, top: HEIGHT, bottom: -1 };
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const at = (y * WIDTH + x) * 3;
      const value = Math.max(rgb[at]!, rgb[at + 1]!, rgb[at + 2]!);
      peak = Math.max(peak, value);
      if (value < COVERAGE) continue;
      pixels++;
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x + 1);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y + 1);
    }
  }
  if (peak === 0) throw new Error(`${label}: empty render (peak 0)`);
  if (pixels < MASK_MIN_PIXELS) throw new Error(`${label}: mask has ${pixels} pixels at >= 50 % coverage (peak ${peak}), under ${MASK_MIN_PIXELS}`);
  if (pixels > MASK_MAX_FRACTION * WIDTH * HEIGHT) throw new Error(`${label}: mask covers ${((100 * pixels) / (WIDTH * HEIGHT)).toFixed(1)} % of the frame, over ${100 * MASK_MAX_FRACTION} %`);
  return { ...box, pixels, peak };
}

/** Sub-pixel bottom edge of a flat-bottomed glyph: per full-height stem column, last full row plus the partial row's coverage. */
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
    // A stem column is full for most of the glyph's height; crossbar-only columns are skipped.
    let run = 0;
    for (let y = full; y >= box.top && value(x, y) >= 250; y--) run++;
    if (full < 0 || run < 0.6 * (box.bottom - box.top)) continue;
    edges.push(full + 1 + (full + 1 < HEIGHT ? value(x, full + 1) / 255 : 0));
  }
  if (edges.length === 0) throw new Error(`${label}: no stem columns`);
  edges.sort((a, b) => a - b);
  return edges[Math.floor(edges.length / 2)]!;
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const fmt = (value: number, places = 2) => {
  const text = round(value, places).toFixed(places);
  return text === `-${(0).toFixed(places)}` ? (0).toFixed(places) : text;
};

// ---------------------------------------------------------------------------------------------------------
// Calibration: libass baseline model vs libass pixels, once.

const word1 = (word: Word) => assLines.find((line) => line.startsWith("Dialogue: 1,") && line.replace(/\{[^}]*\}/g, "").endsWith(`,${word.text}`))!;
const usedHeads = [...new Set(cue.words.map((word) => /\{(\\an5\\fn[^\\]+\\fs[\d.]+)/.exec(word1(word))![1]!))];
const calibration: { case: string; predicted: number; measured: number }[] = [];
for (const head of usedHeads) {
  for (const y of [1000, 1000.25, 1000.5, 1000.75]) {
    const line = `Dialogue: 0,0:00:00.00,0:00:02.00,Word,,0,0,0,,{${head}\\bord0\\shad0\\pos(540,${y})\\1c&HFFFFFF&}H`;
    const script = join(WORK, "calibrate.ass");
    writeFileSync(script, [...assHeader, line, ""].join("\n"));
    const measured = flatBottomEdge(await libassRender(script, 0.5), `calibration ${head} y ${y}`);
    calibration.push({ case: `${/\\fn([^\\]+)/.exec(head)![1]} \\fs${/\\fs([\d.]+)/.exec(head)![1]} \\pos y ${y}`, predicted: eventBaseline(line, 500).baselineY, measured });
  }
}
const staticOffset = calibration.reduce((total, row) => total + (row.measured - row.predicted), 0) / calibration.length;
// Clock: a 1 px/ms \move, so the measured baseline shift is libass's ms clock at each moment.
const clock: { moment: string; predictedMs: number; measuredMs: number }[] = [];
for (const moment of MOMENTS) {
  const line = `Dialogue: 0,0:00:00.00,0:00:02.00,Word,,0,0,0,,{${usedHeads[0]}\\bord0\\shad0\\move(540,100,540,1700,0,1600)\\1c&HFFFFFF&}H`;
  const script = join(WORK, "clock.ass");
  writeFileSync(script, [...assHeader, line, ""].join("\n"));
  const measured = flatBottomEdge(await libassRender(script, moment.at), `clock ${moment.name}`);
  const atZero = eventBaseline(line, 0).baselineY + staticOffset;
  clock.push({ moment: moment.name, predictedMs: libassNowMs(moment.at), measuredMs: measured - atZero });
}

// ---------------------------------------------------------------------------------------------------------
// Measurement.

interface Row { moment: string; word: string; a: EventPose; h: DomWord; inkA: ReturnType<typeof maskBox>; inkH: ReturnType<typeof maskBox> }
const rows: Row[] = [];
for (const moment of MOMENTS) {
  // The frame exactly as render.sh shoots it; its DOM gives the baselines.
  const frame = await htmlRender("", moment.at, join(WORK, `html-frame-${moment.at}.png`));
  for (const [index, word] of cue.words.entries()) {
    if (word.startSec > moment.at) continue;
    const dom = frame.words.find((entry) => entry.index === index);
    if (!dom) throw new Error(`${moment.name} ${word.text}: not visible in the page's metrics`);
    const event = word1(word);
    const pose = eventBaseline(event, libassNowMs(moment.at), staticOffset);

    // Solid masks.
    const flat = event.replace(/\\clip\([^)]*\)/g, "").replace(/\\fade\([^)]*\)/g, "").replace(/\\1c&H[0-9A-F]+&/g, "\\1c&HFFFFFF&");
    const script = join(WORK, `mask-${word.text}.ass`);
    writeFileSync(script, [...assHeader, flat, ""].join("\n"));
    const inkA = maskBox(await libassRender(script, moment.at), `libass mask ${moment.name} ${word.text}`);
    const mask = await htmlRender(`&flat&mask&only=${index}`, moment.at, join(WORK, `html-mask-${index}-${moment.at}.png`));
    const inkH = maskBox(mask.rgb, `HTML mask ${moment.name} ${word.text}`);
    // The mask page must lay the word out where the frame does.
    const maskDom = mask.words.find((entry) => entry.index === index)!;
    if (Math.abs(maskDom.baselineY - dom.baselineY) > 1 / 64 || Math.abs(maskDom.penX - dom.penX) > 1 / 64) {
      throw new Error(`${moment.name} ${word.text}: mask page baseline ${maskDom.baselineY} differs from the frame's ${dom.baselineY}`);
    }
    rows.push({ moment: moment.name, word: word.text, a: pose, h: dom, inkA, inkH });
  }
}
server.stop(true);

// ---------------------------------------------------------------------------------------------------------
// Report.

console.log("Calibration, libass baseline model vs a libass-rendered flat-bottomed H (sub-pixel bottom edge):");
console.log("| Case | Model baseline y | Rendered H bottom | Residual |");
console.log("| --- | --- | --- | --- |");
for (const row of calibration) console.log(`| ${row.case} | ${fmt(row.predicted, 3)} | ${fmt(row.measured, 3)} | ${fmt(row.measured - row.predicted, 3)} |`);
console.log(`Static offset applied to the model: ${fmt(staticOffset, 3)} px (max |residual - offset| ${fmt(Math.max(...calibration.map((row) => Math.abs(row.measured - row.predicted - staticOffset))), 3)} px).`);
console.log("| Moment | libass clock, modelled ms | libass clock, measured ms |");
console.log("| --- | --- | --- |");
for (const row of clock) console.log(`| ${row.moment} | ${row.predictedMs} | ${fmt(row.measuredMs, 2)} |`);
console.log("");

const fails: string[] = [];
console.log("Baselines from layout and pose (Δ = HTML − libass, px; tolerance 2 px):");
console.log("| Moment | Word | libass t (ms) | libass pose dy | HTML pose dy | libass baseline y | HTML baseline y | Δ baseline | Within |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const row of rows) {
  const delta = row.h.baselineY - row.a.baselineY;
  const ok = Math.abs(delta) <= TOLERANCE.baseline;
  if (!ok) fails.push(`${row.moment} ${row.word} baseline`);
  console.log(`| ${row.moment} | ${row.word} | ${row.a.tMs} | ${fmt(row.a.dy)} | ${fmt(row.h.pose.dy)} | ${fmt(row.a.baselineY)} | ${fmt(row.h.baselineY)} | ${fmt(delta)} | ${ok ? "yes" : "**no**"} |`);
}
console.log("");
console.log("Ink bounds from solid masks (>= 50 % coverage; Δ = HTML − libass, px; tolerance 4 px, left edge 4 px):");
console.log("| Moment | Word | libass ink x / y | HTML ink x / y | Δ left | Δ right | Δ top | Δ bottom | max \\|Δ\\| | Within |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const row of rows) {
  const { inkA: a, inkH: h } = row;
  const d = { left: h.left - a.left, right: h.right - a.right, top: h.top - a.top, bottom: h.bottom - a.bottom };
  const max = Math.max(...Object.values(d).map(Math.abs));
  const ok = Math.abs(d.left) <= TOLERANCE.left && max <= TOLERANCE.bounds;
  if (!ok) fails.push(`${row.moment} ${row.word} ink`);
  const box = (b: typeof a) => `${b.left}-${b.right} / ${b.top}-${b.bottom}`;
  console.log(`| ${row.moment} | ${row.word} | ${box(a)} | ${box(h)} | ${d.left} | ${d.right} | ${d.top} | ${d.bottom} | ${max} | ${ok ? "yes" : "**no**"} |`);
}
console.log(fails.length ? `Outside tolerance: ${fails.join(", ")}` : "All words within tolerance (baseline 2 px from layout and pose; ink bounds and left edge 4 px from solid masks).");
