import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import type { CompositionCaptionVisualLayer } from "@narriflow/composition-plan";
import { getCaptionPresetById } from "@narriflow/validators";
import { renderCaptionTrack } from "./caption-ass";

/**
 * The active-word pill (and the overlay that draws the word over it) is placed from HarfBuzz word boxes, so it
 * only lands on the word if those boxes are where libass draws it. libass anchors a `\pos` event by the middle of
 * a bbox that starts each cluster at its first glyph's `x_offset` (`compute_string_bbox`), which moved Nastaliq
 * lines up to 4% of the frame off the geometry. These frames come from the real ffmpeg/libass.
 */
const WIDTH = 1080;
const HEIGHT = 400;
const PILL = [0x3b, 0x82, 0xf6] as const; // electric preset's highlightBoxColor
const TOLERANCE = 0.02 * WIDTH;

interface Sample {
  readonly name: string;
  readonly language: string;
  readonly words: readonly string[];
}

const SAMPLES: readonly Sample[] = [
  { name: "Urdu (Nastaliq, marks)", language: "ur", words: ["مُحَبَّتُوں", "اُردُو", "اِنتِہائی", "خُوبصُورَت"] },
  { name: "Urdu (Nastaliq, plain)", language: "ur", words: ["پاکستان", "میں", "کی", "زبان"] },
  { name: "Arabic, numbers and Latin", language: "ar", words: ["مرحبا", "بالعالم", "2026", "Narriflow", "رائع"] },
  { name: "Arabic with harakat", language: "ar", words: ["مَرْحَبًا", "بِالْعَالَمِ", "جَمِيلٌ"] },
  { name: "Hebrew", language: "he", words: ["שלום", "עולם", "טוב", "מאוד"] },
  { name: "English", language: "en", words: ["READY", "TO", "GO", "NOW"] },
];

function cue(sample: Sample): CompositionCaptionVisualLayer {
  return {
    id: "caption:0", kind: "caption", cueIndex: 0, activeRange: { startSec: 0, endSec: sample.words.length * 0.5 },
    anchor: { xPct: 50, yPct: 50 }, destination: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    rotationDeg: 0, opacity: 1, zIndex: 40, preset: getCaptionPresetById("electric")!.preset,
    words: sample.words.map((text, index) => ({ text, emoji: null, startSec: index * 0.5, endSec: (index + 1) * 0.5 })),
    language: sample.language,
  };
}

function render(assText: string, atSec: number): Buffer {
  const directory = mkdtempSync(join(tmpdir(), "caption-pill-"));
  try {
    const ass = join(directory, "captions.ass");
    writeFileSync(ass, assText);
    const run = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `color=c=black:s=${WIDTH}x${HEIGHT}:d=4:r=25`,
      "-vf", `ass='${ass}':fontsdir='${CAPTION_FONTS_DIRECTORY}'`,
      "-ss", String(atSec), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ], { maxBuffer: WIDTH * HEIGHT * 3 * 2 });
    if (run.status !== 0) throw new Error(run.stderr.toString());
    return run.stdout;
  } finally {
    rmSync(directory, { recursive: true });
  }
}

/** Horizontal centre of the pixels `hit` accepts, or null when none. */
function centerOf(pixels: Buffer, hit: (r: number, g: number, b: number) => boolean): number | null {
  let left = WIDTH;
  let right = -1;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 3;
      if (hit(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!)) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  return right < 0 ? null : (left + right) / 2;
}

const isPill = (r: number, g: number, b: number) =>
  Math.abs(r - PILL[0]) < 12 && Math.abs(g - PILL[1]) < 12 && Math.abs(b - PILL[2]) < 12;
const isInk = (r: number, g: number, b: number) => Math.max(r, g, b) > 60;

interface Event {
  readonly layer: number;
  readonly start: string;
  readonly style: string;
  readonly text: string;
  readonly raw: string;
}

function events(ass: string): Event[] {
  return ass
    .split("\n")
    .filter((line) => line.startsWith("Dialogue:"))
    .map((raw) => {
      const fields = raw.slice("Dialogue:".length).split(",");
      return { layer: Number(fields[0]), start: fields[1]!, style: fields[3]!, text: fields.slice(9).join(","), raw };
    });
}

/**
 * The ASS with only the base line of the window `index` is active in, drawn plain (no outline) with
 * every word hidden but `index`. It does not use the overlay, so it is what libass really draws for that word.
 */
function isolatedWord(ass: string, index: number, windowStart: string): string {
  const header = ass.slice(0, ass.indexOf("[Events]"));
  const line = events(ass).find((event) => event.style === "Caption" && event.start === windowStart && event.layer === 5)!;
  const head = line.text.match(/^\{[^}]*\}/)![0];
  const gap = /\{\\fsp[\d.]+\} \{\\fsp[\d.]+\}/g;
  const gaps = line.text.slice(head.length).match(gap) ?? [];
  const chunks = line.text.slice(head.length).split(gap);
  const body = chunks
    .map((chunk, position) => {
      const visible = position === index ? "00" : "FF";
      const text = chunk.replace(/\\alpha&H[0-9A-Fa-f]+&/g, "");
      return `{\\alpha&H${visible}&}${text}${gaps[position] ?? ""}`;
    })
    .join("");
  const flat = head.replace(/\\fad\([^)]*\)/, "").replace(/\\bord[\d.]+/, "\\bord0");
  return `${header}[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 1,0:00:00.00,0:00:04.00,Caption,,0,0,0,,${flat}${body}\n`;
}

// Two real ffmpeg renders per word; a loaded machine can exceed the 5 s default.
const RENDER_TEST_TIMEOUT_MS = 30_000;

describe.skipIf(!Bun.which("ffmpeg"))("active-word pill over the real libass", () => {
  for (const sample of SAMPLES) {
    test(`${sample.name}: the pill centres on the word libass draws`, () => {
      const { ass } = renderCaptionTrack({ layers: [cue(sample)], canvas: { width: WIDTH, height: HEIGHT } });
      const starts = [...new Set(events(ass).filter((event) => event.style === "Shape").map((event) => event.start))];
      expect(starts.length).toBe(sample.words.length);
      sample.words.forEach((word, index) => {
        const at = index * 0.5 + 0.42;
        const pill = centerOf(render(ass, at), isPill);
        const ink = centerOf(render(isolatedWord(ass, index, starts[index]!), 1), isInk);
        expect(pill, `${word}: pill`).not.toBeNull();
        expect(ink, `${word}: ink`).not.toBeNull();
        const offset = Math.abs(pill! - ink!);
        if (process.env.CAPTION_PILL_DEBUG) console.warn(`${sample.name} ${word}: pill ${pill} ink ${ink} off ${offset.toFixed(1)}px`);
        expect(offset, `${word}: pill ${pill} vs ink ${ink}`).toBeLessThan(TOLERANCE);
      });
    }, RENDER_TEST_TIMEOUT_MS);
  }
});
