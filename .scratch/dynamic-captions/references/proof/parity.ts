/**
 * Throwaway look proof (ticket 02): numeric ASS vs HTML parity for the first cue.
 *
 *   bun .scratch/dynamic-captions/references/proof/parity.ts [workDir]   (from the worktree root, after build.ts)
 *
 * For each moment (onset, +100 ms, settled) and each word already spoken, it renders that word alone, without
 * its shadow, on flat black: libass through ffmpeg (Layer 1 events of that word only), the page through headless
 * Chrome (`&flat&noshadow&only=N`). The ink box is every pixel whose brightest channel reaches half of that
 * image's peak, so a word mid-fade is thresholded against its own opacity. Both painters draw the same glyphs,
 * so the ink-bottom delta is the baseline delta. Tolerances: baseline 2 px, left edge 4 px, ink bounds 4 px.
 * Intermediate files go to workDir (default os.tmpdir()/narriflow-parity), never into this folder.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HERE = import.meta.dir;
const ROOT = resolve(HERE, "../../../..");
const FONTS = join(ROOT, "packages/caption-fonts/fonts");
const WORK = Bun.argv[2] ?? join(tmpdir(), "narriflow-parity");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTH = 1080;
const HEIGHT = 1920;
const MOMENTS = [
  { name: "onset", at: 0.266667 },
  { name: "+100 ms", at: 0.35 },
  { name: "settled", at: 1.2 },
] as const;
const TOLERANCE = { baseline: 2, left: 4, bounds: 4 };
mkdirSync(WORK, { recursive: true });

interface Word { text: string; startSec: number; baselineX: number; baselineY: number; inkTop: number; inkBottom: number }
const cue = (JSON.parse(readFileSync(join(HERE, "cues.json"), "utf8")) as { cues: { endSec: number; words: Word[] }[] }).cues[0]!;

// Static server for the page, its module, fonts and cues.json (file:// blocks fonts and modules).
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const file = Bun.file(join(ROOT, path));
    return file.size > 0 ? new Response(file) : new Response("not found", { status: 404 });
  },
});

const assLines = readFileSync(join(HERE, "headline.ass"), "utf8").split("\n");
const assHeader = assLines.filter((line) => !line.startsWith("Dialogue:"));
const assSeconds = (time: string) => {
  const [h, m, s] = time.split(":").map(Number);
  return h! * 3600 + m! * 60 + s!;
};

// Async on purpose: Chrome fetches from this process's server, which a synchronous spawn would block.
async function run(command: string[]): Promise<Buffer> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${stderr}`);
  return Buffer.from(stdout);
}

/** Ink box of a frame: pixels whose brightest channel is at least half the frame's peak. */
function inkBox(rgb: Buffer) {
  let peak = 0;
  for (let at = 0; at < rgb.length; at += 3) peak = Math.max(peak, rgb[at]!, rgb[at + 1]!, rgb[at + 2]!);
  const threshold = peak / 2;
  const box = { left: WIDTH, right: -1, top: HEIGHT, bottom: -1 };
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const at = (y * WIDTH + x) * 3;
      if (Math.max(rgb[at]!, rgb[at + 1]!, rgb[at + 2]!) < threshold) continue;
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x + 1);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y + 1);
    }
  }
  return { ...box, peak };
}

function libassWord(word: Word, at: number): Promise<Buffer> {
  const lines = assLines.filter((line) => {
    if (!line.startsWith("Dialogue: 1,")) return false;
    const fields = line.split(",");
    return assSeconds(fields[1]!) < cue.endSec && line.replace(/\{[^}]*\}/g, "").endsWith(`,${word.text}`);
  });
  const script = join(WORK, `ass-${word.text}.ass`);
  writeFileSync(script, [...assHeader, ...lines, ""].join("\n"));
  return run([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=${WIDTH}x${HEIGHT}:d=1`,
    "-vf", `format=rgb24,settb=1/1000000,setpts=${at}/TB,ass=${script}:fontsdir=${FONTS}`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
}

async function htmlWord(index: number, at: number): Promise<Buffer> {
  const png = join(WORK, `html-${index}-${at}.png`);
  await run([
    CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${WIDTH},${HEIGHT}`,
    "--virtual-time-budget=4000", `--screenshot=${png}`,
    `http://127.0.0.1:${server.port}/.scratch/dynamic-captions/references/proof/headline.html?shot&flat&noshadow&only=${index}&t=${at}`,
  ]);
  return run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
}

const rows: string[] = [];
const fails: string[] = [];
for (const moment of MOMENTS) {
  for (const [index, word] of cue.words.entries()) {
    if (word.startSec > moment.at) continue;
    const a = inkBox(await libassWord(word, moment.at));
    const h = inkBox(await htmlWord(index, moment.at));
    const d = { left: h.left - a.left, right: h.right - a.right, top: h.top - a.top, bottom: h.bottom - a.bottom };
    const bounds = Math.max(...Object.values(d).map(Math.abs));
    const ok = Math.abs(d.bottom) <= TOLERANCE.baseline && Math.abs(d.left) <= TOLERANCE.left && bounds <= TOLERANCE.bounds;
    if (!ok) fails.push(`${moment.name} ${word.text}`);
    const box = (b: typeof a) => `${b.left}-${b.right} x ${b.top}-${b.bottom}`;
    rows.push(
      `| ${moment.name} | ${word.text} | ${box(a)} | ${box(h)} | ${d.bottom} | ${d.left} | ${d.right} | ${d.top} | ${bounds} | ${ok ? "yes" : "**no**"} |`,
    );
  }
}
server.stop(true);

console.log("| Moment | Word | libass ink x / y | HTML ink x / y | Δ baseline | Δ left | Δ right | Δ top | max |Δ| | Within |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const row of rows) console.log(row);
console.log(fails.length ? `Outside tolerance: ${fails.join(", ")}` : "All words within tolerance (baseline 2 px, left 4 px, bounds 4 px).");
