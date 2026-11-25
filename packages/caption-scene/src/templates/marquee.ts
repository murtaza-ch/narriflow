import { CAPTION_SCENE_BRAND_MIN_CONTRAST, type CaptionFontName, captionColourContrast, captionSceneMeta } from "@narriflow/validators";
import type { DemoScript } from "../demo";
import { type Frames, ease } from "../ease";
import { exportFrameAtOrAfter, exportFrameTimes } from "../frame-grid";
import { balancedRows, rowVisualOrder, rowsFromRoles } from "../layout";
import { type Box, type PathCmd, type Piece, type TextPiece, type Track, mixColour } from "../scene";
import { arcPath, ellipsePath, polygonPath, rectPath, roundedRectPath, sparklePath } from "../shapes";
import { caps, galleryScene } from "./gallery-layout";

/**
 * Marquee (`samples/templates/m73-vintage.js`): a 1950s badge. Each cue sits on a rounded poster plate with cream-hairline
 * rim and faint sunburst rays. The key word is a big cream script with a navy extrusion on a round disc; the words
 * before it are small caps arched over the disc, the words after it arched under it. A cue with no key word sets its
 * words in the same script, two to a row, on a smaller disc.
 *
 * Changes from the sample, and why (Sol's gallery 6 review, 2026-11-25, and the real-cue rules):
 * - **Nothing of a cue outlives it.** The sample hid a cue 110 ms early and its disc and plate showed as a ghost under
 *   the next cue's first word. Every piece lives to the cue's window end; the cue fades together (the exit starts after
 *   the last spoken word's reading hold, and is dropped when two painted frames do not fit), so a 60 ms gap never
 *   hides a word before its spoken end.
 * - **The plate is there for the first word.** The sample opened a no-hero plate at the last word, behind text that was
 *   already readable. The plate, its rim, rays and bulbs now open (a rectangular wipe from the middle, three frames) at
 *   the first word's onset; only the disc pop is saved for the key word (about 120 ms, planned on the frame grid).
 * - **Ink at the onset.** Every word is on its first painted frame, in its final place; the arch words swing the last
 *   few degrees along the curve and the key word settles from 80 % with one overshoot, in at most 120 ms, both fitted
 *   to the frames the word has (a short word settles monotonically, a one-frame word is simply there). A word swings
 *   in from the right, where the next word has not arrived, because the sample's swing from the left ran through the
 *   letters before it ("THGOOD" for two frames).
 * - **Tilt per word.** The sample turned each word about its own middle; rows stay level, and a cue with no key word
 *   keeps its rows 680 px wide so the disc stays the badge's centre.
 * - **A plate fitted around the ink.** The sample's 860x600 card dominated the cream script. The plate is the bounding
 *   box of the disc, the arches, the key word with its extrusion and the swoosh, plus 36 px, with a corner radius that
 *   follows its size. The rays are 10 % lighter than the plate (the sample's were about 20 %), trimmed to the rounded
 *   rectangle, and on a long hold step round a few degrees every half second instead of turning every frame.
 * - **A lighter extrusion.** 27 px of navy at 250 px, 0.11 em along its diagonal (the sample's 38 px was 0.15 em), four hard copies whose outline
 *   bridges the gaps, and a thin navy outline around the whole script silhouette, so a brand cream that is washed out
 *   still reads over light footage. The two swoosh arcs became one 7 px cream arc, drawn on (a wipe along it) in free
 *   space beside the disc and kept, instead of two arcs that swept through the arch letters and vanished.
 * - **Arches that measure themselves.** The sample shrank the font to a floor of 30 px and then overflowed. The arch
 *   takes the largest caps size (down to 38 px) whose letters fit a 108 degree span of the ring round the disc; when
 *   even that is too long the ring grows shallower (a flatter arch with the same apex) before the text shrinks, and a
 *   script that cannot be split into letters (Devanagari, Arabic, Hebrew...) sets its words whole in a straight row
 *   above (or below) the disc, as does a cue whose letters would pass the piece budget. Right to left cues read
 *   right to left.
 * - **Reading order.** The sample put every word that was not the key word in the arch above, so words spoken after
 *   the key word read before it. Words before the key word arch over the disc and words after it arch under it.
 * - **Long words.** A key word that would shrink below half its size to fit 780 px is broken across rows (Latin,
 *   Cyrillic and Greek only) into the fewest rows that keep that size, cut where the measured widths come out even,
 *   with no space between the fragments.
 * - **Brand colours.** The face is the preset's primary; the disc and plate are the highlight and accent, which the
 *   cues alternate between two themes (plate teal and disc red, plate red and disc navy). Each pair that is really
 *   drawn (face on navy, on the disc, on the plate) keeps 3:1 or falls back to the style default.
 * - Extra recurring beats, in the badge's language, on every cue: a chase of marquee bulbs along the top and bottom rims
 *   (two phases swapping every 150 ms), and a second small star at the opposite corner that twinkles again on every
 *   1.3 s of a long hold, next to the key word's own star. No cue-indexed table remains: themes and sides cycle on
 *   per-cue counters (key-word cues and plain cues each have their own) and the ray phase is a hash of the cue's words.
 */

export const MARQUEE_DEMO: DemoScript = {
  lines: [
    "the:m good:b old:b days:h@1000",
    "they:m don't:m make:b them:m like:b this:b",
    "legends:h@1050",
    "built:b to:m last:b forever:h@1100",
    "see:b you:m next:b time:b",
  ],
  options: { rate: 245, gap: 30, cueGap: 170, tail: 800, lead: 350 },
};

const SCRIPT: CaptionFontName = "Oleo Script Bold";
const CAPS: CaptionFontName = "Lilita One";
const NAVY = "#222838";
const HERO_SIZE = 250;
const TILT = -6;
const PLAIN_TILT = -4;
/** A cue with no key word keeps its rows narrower, so the disc stays the badge's centre. */
const PLAIN_ROOM = 680;
/** The widest the key word's row may be, and the share of its size it may shrink to before a long word is broken. */
const ROOM = 780;
const MIN_FIT = 0.5;
const PAD = 36;
const HAIR = 18;
const EXT_LEN = 0.09;
const EXT_X = 0.92;
const EXT_Y = 0.78;
const OUTLINE = 0.03;
const SUPPORT = 60;
const SUPPORT_MIN = 38;
const MINOR = 0.82;
const SPAN = 1.89; // 108 degrees of the ring
const SPLITTABLE = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}]+$/u;
const RAYS = 22;

const hash = (text: string) => {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
  return h >>> 0;
};

/** Hard steps: a value holds until 1 ms before its time and jumps there (the exporter samples at frames, so a step lands on one). */
function stairs(points: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  for (const [at, value] of points) {
    const last = out.at(-1);
    if (!last) {
      out.push([at, value]);
      continue;
    }
    if (last[1] === value) continue;
    const jump = Math.max(last[0] + 1, at);
    if (jump - 1 > last[0]) out.push([jump - 1, last[1]]);
    out.push([jump, value]);
  }
  return out;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const turn = (x: number, y: number, deg: number): [number, number] => [x * Math.cos(rad(deg)) - y * Math.sin(rad(deg)), x * Math.sin(rad(deg)) + y * Math.cos(rad(deg))];
const boxOf = (points: readonly (readonly [number, number])[]): Box => ({ x1: Math.min(...points.map((p) => p[0])), x2: Math.max(...points.map((p) => p[0])), y1: Math.min(...points.map((p) => p[1])), y2: Math.max(...points.map((p) => p[1])) });
const union = (boxes: readonly Box[]): Box => boxOf(boxes.flatMap((b) => [[b.x1, b.y1], [b.x2, b.y2]] as const));
const meets = (a: Box, b: Box) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
const inflate = (b: Box, by: number): Box => ({ x1: b.x1 - by, y1: b.y1 - by, x2: b.x2 + by, y2: b.y2 + by });

/** The corners of an upright box turned about its own origin and moved to (x, y). */
function turnedBox(x: number, y: number, local: Box, deg: number): Box {
  return boxOf([[local.x1, local.y1], [local.x2, local.y1], [local.x2, local.y2], [local.x1, local.y2]].map(([px, py]) => {
    const [tx, ty] = turn(px!, py!, deg);
    return [x + tx, y + ty] as const;
  }));
}

/** A convex polygon (the rounded plate) the rays are trimmed to: Sutherland-Hodgman. */
function clipConvex(subject: readonly (readonly [number, number])[], clip: readonly (readonly [number, number])[]): (readonly [number, number])[] {
  let area = 0;
  for (let i = 0; i < clip.length; i++) {
    const [x1, y1] = clip[i]!;
    const [x2, y2] = clip[(i + 1) % clip.length]!;
    area += x1 * y2 - x2 * y1;
  }
  const sign = area >= 0 ? 1 : -1;
  let output = [...subject];
  for (let i = 0; i < clip.length && output.length > 0; i++) {
    const [ax, ay] = clip[i]!;
    const [bx, by] = clip[(i + 1) % clip.length]!;
    const inside = (p: readonly [number, number]) => sign * ((bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax)) >= 0;
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j]!;
      const q = input[(j + 1) % input.length]!;
      if (inside(p)) output.push(p);
      if (inside(p) !== inside(q)) {
        const d1x = q[0] - p[0];
        const d1y = q[1] - p[1];
        const d2x = bx - ax;
        const d2y = by - ay;
        const t = ((ax - p[0]) * d2y - (ay - p[1]) * d2x) / (d1x * d2y - d1y * d2x);
        output.push([p[0] + t * d1x, p[1] + t * d1y]);
      }
    }
  }
  return output;
}

function roundedPolygon(w: number, h: number, r: number): [number, number][] {
  const out: [number, number][] = [];
  const corners = [[w / 2 - r, -h / 2 + r, -90], [w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180]] as const;
  for (const [cx, cy, start] of corners) for (let k = 0; k <= 8; k++) out.push([cx + r * Math.cos(rad(start + (k * 90) / 8)), cy + r * Math.sin(rad(start + (k * 90) / 8))]);
  return out;
}

interface Item {
  readonly word: number;
  readonly part: number;
  readonly parts: number;
  readonly text: string;
  readonly size: number;
}

interface Placed extends Item {
  /** The pivot (baseline centre) in design units, after the tilt. */
  x: number;
  y: number;
  w: number;
  box: Box;
}

interface ArchLetter {
  readonly text: string;
  readonly size: number;
  readonly theta: number;
  readonly top: number;
  readonly bottom: number;
}

interface Arch {
  readonly word: number;
  /** Letters on the ring (empty for a word set whole in a straight row). */
  readonly letters: readonly ArchLetter[];
  /** A whole word in a straight row: its centre, baseline and size. */
  readonly whole: { readonly x: number; readonly y: number; readonly size: number; readonly text: string } | null;
}

interface Ring {
  readonly words: Arch[];
  readonly cx: number;
  readonly cy: number;
  /** Baseline radius of the letters. */
  readonly radius: number;
  readonly below: boolean;
  readonly boxes: Box[];
  readonly box: Box | null;
}

export const marqueeProgram = galleryScene("marquee", 1280, (ctx) => {
  const { cue, index, to, bounds } = ctx.window;
  const { exit, exitAt, fps, side, space, rtl } = ctx;
  const u = space.u;
  const direction = rtl ? "rtl" : "ltr";
  const pieces: Piece[] = [];

  // Colours: the pairs that are really drawn keep 3:1, or fall back to the style default.
  const c = ctx.input.colours;
  const defaults = captionSceneMeta("marquee").colours;
  const reads = (a: string, b: string) => captionColourContrast(a, b) >= CAPTION_SCENE_BRAND_MIN_CONTRAST;
  const cream = reads(c.primary, NAVY) ? c.primary : defaults.primary;
  const red = reads(cream, c.highlight) ? c.highlight : defaults.highlight;
  const teal = reads(cream, c.accent) ? c.accent : defaults.accent;

  const roles = cue.words.map((word) => word.role);
  const { lead, hero, tail } = rowsFromRoles(roles);
  const heroed = hero.length > 0;
  const earlier = ctx.input.cues.slice(0, index).filter((other) => other.words.length > 0);
  const count = earlier.filter((other) => other.words.some((word) => word.role === "hero") === heroed).length;
  const flip = count % 2 === 1;
  const plateColour = flip ? red : teal;
  const discColour = flip ? NAVY : red;
  const rayColour = mixColour(plateColour, "#FFFFFF", 0.1);
  const seed = hash(`${cue.words.map((word) => word.text).join(" ")}|${index}`);

  const meas = (text: string, face: CaptionFontName, size: number, spacing = 0) => {
    const m = ctx.input.measure(text, face, size * u, spacing);
    return { w: m.advance / u, top: m.inkTop / u, bottom: m.inkBottom / u };
  };

  // ---- The script words: the key word's row(s), or every word of a cue without one. ----
  /**
   * A long Latin, Cyrillic or Greek word, broken into the fewest rows whose narrowest real split fits the column at the
   * size floor (half its size), cut where the measured widths come out even (the split that minimises the widest row).
   */
  const chunkOf = (text: string, size: number, room: number): string[] => {
    const letters = [...text];
    const n = letters.length;
    const prefix = [0, ...letters.map((_, at) => meas(letters.slice(0, at + 1).join(""), SCRIPT, size).w)];
    if (!SPLITTABLE.test(text) || prefix[n]! * MIN_FIT <= room || n < 2) return [text];
    for (let rowsCount = 2; rowsCount <= n; rowsCount++) {
      // best[k][i]: the least widest row when the first i letters make k rows; cut[k][i]: where the last of them starts.
      const best = Array.from({ length: rowsCount + 1 }, () => new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY));
      const cut = Array.from({ length: rowsCount + 1 }, () => new Array<number>(n + 1).fill(0));
      best[0]![0] = 0;
      for (let k = 1; k <= rowsCount; k++) {
        for (let i = k; i <= n; i++) {
          for (let j = k - 1; j < i; j++) {
            const widest = Math.max(best[k - 1]![j]!, prefix[i]! - prefix[j]!);
            if (widest < best[k]![i]!) {
              best[k]![i] = widest;
              cut[k]![i] = j;
            }
          }
        }
      }
      if (best[rowsCount]![n]! * MIN_FIT > room && rowsCount < n) continue;
      const out: string[] = [];
      let end = n;
      for (let k = rowsCount; k >= 1; k--) {
        const start = cut[k]![end]!;
        out.unshift(letters.slice(start, end).join(""));
        end = start;
      }
      return out;
    }
    return [text];
  };

  const scriptBlock = (idxs: readonly number[], base: number, minor: number, yMid: number, tilt: number, room: number): { items: Placed[]; box: Box; inkH: number } => {
    const gapOf = (size: number) => 0.22 * size;
    const widthOf = (row: readonly Item[], k: number) => row.reduce((sum, item, at) => sum + meas(item.text, SCRIPT, item.size * k).w + (at > 0 ? gapOf(item.size * k) : 0), 0);
    /** The rows at a pack factor `g` of the nominal sizes: whole words pack (balanced), a broken word gives each fragment its own row; then one shared shrink fits the widest row. */
    const rowsAt = (g: number) => {
      const entries = idxs.map((word) => {
        const size = base * g * (cue.words[word]!.role === "minor" ? minor : 1);
        return { word, size, parts: chunkOf(cue.words[word]!.text, size, room) };
      });
      const rows: Item[][] = [];
      let run: typeof entries = [];
      const flush = () => {
        if (run.length === 0) return;
        const widths = run.map((e) => meas(cue.words[e.word]!.text, SCRIPT, e.size).w);
        for (const row of balancedRows(widths, gapOf(base * g), room)) rows.push(row.map((k) => ({ word: run[k]!.word, part: 0, parts: 1, text: cue.words[run[k]!.word]!.text, size: run[k]!.size })));
        run = [];
      };
      for (const entry of entries) {
        if (entry.parts.length === 1) {
          run.push(entry);
          continue;
        }
        flush();
        for (const [part, text] of entry.parts.entries()) rows.push([{ word: entry.word, part, parts: entry.parts.length, text, size: entry.size }]);
      }
      flush();
      let fit = 1;
      for (const row of rows) fit = Math.min(fit, room / Math.max(1, widthOf(row, 1)));
      return { rows, fit, size: g * fit };
    };
    // Pack two and three rows before accepting four or more: a smaller pack factor (never under 62 % of the nominal size, and the
    // result never under the size floor) that brings the count down wins.
    let chosen = rowsAt(1);
    for (const g of [0.85, 0.72, 0.62]) {
      if (chosen.rows.length <= 3) break;
      const next = rowsAt(g);
      if (next.rows.length < chosen.rows.length && next.size >= MIN_FIT) chosen = next;
    }
    const { rows, fit } = chosen;
    const sized = rows.map((row) => row.map((item) => ({ ...item, size: item.size * fit })));
    const pitch = Math.max(...sized.flat().map((item) => item.size)) * 1.0;
    const placed: Placed[] = [];
    sized.forEach((row, r) => {
      const texts = row.map((item) => item.text);
      const widths = row.map((item) => meas(item.text, SCRIPT, item.size).w);
      const gap = gapOf(row[0]!.size);
      const total = widths.reduce((sum, w) => sum + w, 0) + gap * (row.length - 1);
      let x = -total / 2;
      for (const k of rowVisualOrder(texts, direction)) {
        const item = row[k]!;
        placed.push({ ...item, x: x + widths[k]! / 2, y: r * pitch, w: widths[k]!, box: { x1: 0, y1: 0, x2: 0, y2: 0 } });
        x += widths[k]! + gap;
      }
    });
    // Ink boxes (outline and extrusion included) before the tilt; centre the block, then turn it about its middle.
    const local = (item: Placed): Box => {
      const m = meas(item.text, SCRIPT, item.size);
      const o = OUTLINE * item.size;
      return { x1: -item.w / 2 - o, y1: m.top - o, x2: item.w / 2 + o + EXT_LEN * item.size * EXT_X, y2: m.bottom + o + EXT_LEN * item.size * EXT_Y };
    };
    const flat = union(placed.map((item) => ({ x1: item.x + local(item).x1, y1: item.y + local(item).y1, x2: item.x + local(item).x2, y2: item.y + local(item).y2 })));
    const mid = { x: (flat.x1 + flat.x2) / 2, y: (flat.y1 + flat.y2) / 2 };
    // Rows stay level; each word is turned about its own baseline centre, as the sample's words are.
    for (const item of placed) {
      item.x -= mid.x;
      item.y = item.y - mid.y + yMid;
      item.box = turnedBox(item.x, item.y, local(item), tilt);
    }
    const box = union(placed.map((item) => item.box));
    return { items: placed, box, inkH: box.y2 - box.y1 };
  };

  // ---- The words of the arches ----
  const lettersOf = (text: string) => [...text];
  const ring = (idxs: readonly number[], below: boolean, D: number, extra: number, force: "auto" | "whole"): Ring => {
    if (idxs.length === 0) return { words: [], cx: 0, cy: 0, radius: 0, below, boxes: [], box: null };
    const texts = idxs.map((word) => caps(cue.words[word]!, cue));
    const letterCount = texts.reduce((sum, text) => sum + lettersOf(text).length, 0);
    const whole = force === "whole" || !texts.every((text) => SPLITTABLE.test(text)) || letterCount > 36;
    const sizeOf = (word: number, fs: number) => fs * (cue.words[word]!.role === "minor" ? MINOR : 1);
    const gapAround = D / 2 + 20 + extra;
    if (whole) {
      // Straight rows above (or below) the disc, as wide as the plate allows, the fewest rows, balanced.
      // A script the caps face cannot draw falls back to a face with a smaller x-height: set it larger.
      const fs = texts.every((text) => SPLITTABLE.test(text)) ? SUPPORT * 0.9 : SUPPORT * 1.2;
      const widths = idxs.map((word, k) => meas(texts[k]!, CAPS, sizeOf(word, fs), 0.04).w);
      const rows = balancedRows(widths, 0.5 * fs, ROOM);
      const pitch = fs * 1.02;
      const words: Arch[] = [];
      const boxes: Box[] = [];
      rows.forEach((row, r) => {
        const total = row.reduce((sum, k) => sum + widths[k]!, 0) + 0.5 * fs * (row.length - 1);
        let x = -total / 2;
        // Rows nearest the disc come first for an arch below, last for one above (so reading runs top to bottom).
        const level = below ? r : rows.length - 1 - r;
        const baseline = below ? gapAround + (level + 1) * pitch : -gapAround - level * pitch - 0.1 * fs;
        for (const k of rowVisualOrder(row.map((at) => texts[at]!), direction)) {
          const word = idxs[row[k]!]!;
          const size = sizeOf(word, fs);
          const m = meas(texts[row[k]!]!, CAPS, size, 0.04);
          const entry = { x: x + widths[row[k]!]! / 2, y: baseline, size, text: texts[row[k]!]! };
          // `x` above indexes widths by position in the row; fix after the order is known.
          words.push({ word, letters: [], whole: entry });
          boxes.push({ x1: entry.x - m.w / 2, y1: baseline + m.top, x2: entry.x + m.w / 2, y2: baseline + m.bottom });
          x += widths[row[k]!]! + 0.5 * fs;
        }
      });
      return { words, cx: 0, cy: 0, radius: 0, below, boxes, box: union(boxes) };
    }
    // Letters on a ring: the largest size whose letters fit 108 degrees, else a shallower ring at the floor size.
    const metricsAt = (fs: number) => idxs.map((word, k) => {
      const size = sizeOf(word, fs);
      const letters = lettersOf(texts[k]!).map((ch) => {
        const m = meas(ch, CAPS, size);
        return { text: ch, size, w: m.w + 0.1 * size, top: m.top, bottom: m.bottom };
      });
      return { word, letters, len: letters.reduce((sum, l) => sum + l.w, 0) };
    });
    let fs = SUPPORT;
    let metrics = metricsAt(fs);
    const total = (list: typeof metrics, size: number) => list.reduce((sum, m) => sum + m.len, 0) + 0.55 * size * (list.length - 1);
    const capH = (size: number) => meas("H", CAPS, size).bottom - meas("H", CAPS, size).top;
    const concentric = (size: number) => gapAround + capH(size) / 2;
    while (fs > SUPPORT_MIN && total(metrics, fs) > SPAN * concentric(fs)) {
      fs -= 2;
      metrics = metricsAt(fs);
    }
    const length = total(metrics, fs);
    const cap = capH(fs);
    const mid0 = concentric(fs);
    const midR = Math.max(mid0, length / SPAN);
    // The apex of the mid-height line stays where the concentric ring puts it; a shallower ring has its centre further away.
    const apex = below ? mid0 : -mid0;
    const cy = below ? apex - midR : apex + midR;
    const radius = below ? midR + cap / 2 : midR - cap / 2;
    let at = -length / 2;
    const words: Arch[] = metrics.map((m) => {
      const letters = m.letters.map((l) => {
        const theta = (at + l.w / 2) / midR;
        at += l.w;
        return { text: l.text, size: l.size, theta, top: l.top, bottom: l.bottom };
      });
      at += 0.55 * fs;
      return { word: m.word, letters, whole: null };
    });
    const boxes = words.flatMap((w) => w.letters.map((l) => letterBox({ cx: 0, cy, radius, below } as Ring, l, 0)));
    return { words, cx: 0, cy, radius, below, boxes, box: union(boxes) };
  };

  /** Where a letter's baseline centre sits and how it is turned, `delta` radians along the ring. */
  const letterAt = (r: Pick<Ring, "cx" | "cy" | "radius" | "below">, l: ArchLetter, delta: number): { x: number; y: number; rz: number } => {
    const a = l.theta + delta;
    return r.below
      ? { x: r.cx + r.radius * Math.sin(a), y: r.cy + r.radius * Math.cos(a), rz: (-a * 180) / Math.PI }
      : { x: r.cx + r.radius * Math.sin(a), y: r.cy - r.radius * Math.cos(a), rz: (a * 180) / Math.PI };
  };
  function letterBox(r: Pick<Ring, "cx" | "cy" | "radius" | "below">, l: ArchLetter, delta: number): Box {
    const p = letterAt(r, l, delta);
    return turnedBox(p.x, p.y, { x1: -l.size * 0.3, y1: l.top, x2: l.size * 0.3, y2: l.bottom }, p.rz);
  }

  // ---- The block, in design units, the disc's centre at (0, 0) ----
  let heroBlock: ReturnType<typeof scriptBlock>;
  let D: number;
  let upper: Ring;
  let lower: Ring;
  const yBias = (lead.length > 0 ? 0.04 : 0) - (tail.length > 0 ? 0.04 : 0);
  if (heroed) {
    heroBlock = scriptBlock(hero, HERO_SIZE, 1, 0, TILT, ROOM);
    D = Math.min(440, Math.max(300, 1.85 * heroBlock.inkH));
    heroBlock = scriptBlock(hero, HERO_SIZE, 1, yBias * D, TILT, ROOM);
    // Push the arches out until no letter touches the key word; a ring that still cannot clear it is set whole in straight rows.
    let extra = 0;
    let force: "auto" | "whole" = "auto";
    for (;;) {
      upper = ring(lead, false, D, extra, force);
      lower = ring(tail, true, D, extra, force);
      const hits = [...upper.boxes, ...lower.boxes].some((b) => heroBlock.items.some((item) => meets(inflate(item.box, 8), b)));
      if (!hits) break;
      if (extra < 120) extra += 10;
      else if (force === "auto") {
        force = "whole";
        extra = 0;
      } else break;
    }
  } else {
    const n = cue.words.length;
    const base = n <= 2 ? 170 : n <= 4 ? 150 : 124;
    heroBlock = scriptBlock(cue.words.map((_, k) => k), base, 0.84, 0, PLAIN_TILT, PLAIN_ROOM);
    D = Math.min(440, Math.max(240, 1.25 * heroBlock.inkH + 40));
    upper = ring([], false, D, 0, "auto");
    lower = ring([], true, D, 0, "auto");
  }
  // The swoosh sits where no arch is: below the disc when the words arch above it, above when they arch below, beside it when both do.
  const swooshBase = lead.length > 0 && tail.length > 0 ? 0 : tail.length > 0 ? -60 : 60;
  const swooshAt = flip ? (swooshBase === 0 ? 180 : swooshBase > 0 ? 180 - swooshBase : -180 - swooshBase) : swooshBase;
  const swooshRadius = D / 2 + 16;
  const swooshFrom = swooshAt - 50;
  const swooshTo = swooshAt + 50;
  const swooshPoints: [number, number][] = [];
  for (let a = swooshFrom; a <= swooshTo; a += 10) swooshPoints.push([(swooshRadius + 4) * Math.cos(rad(a)), (swooshRadius + 4) * Math.sin(rad(a))]);
  const discBox: Box = { x1: -D / 2, y1: -D / 2, x2: D / 2, y2: D / 2 };
  const content = union([discBox, heroBlock.box, boxOf(swooshPoints), ...(upper.box ? [upper.box] : []), ...(lower.box ? [lower.box] : [])]);
  const plateW = content.x2 - content.x1 + 2 * PAD;
  const plateH = content.y2 - content.y1 + 2 * PAD;
  const pcx = (content.x1 + content.x2) / 2;
  const pcy = (content.y1 + content.y2) / 2;

  // Scale to the lane: everything shrinks together.
  const lane = { w: bounds.x2 - bounds.x1 - 8, h: bounds.y2 - bounds.y1 - 8 };
  const k = u * Math.min(1, lane.w / (plateW * u), lane.h / (plateH * u));
  const midX = Math.min(Math.max(space.x(540), bounds.x1 + 4 + (plateW * k) / 2), bounds.x2 - 4 - (plateW * k) / 2);
  const midY = Math.min(Math.max(space.y(1280), bounds.y1 + 4 + (plateH * k) / 2), bounds.y2 - 4 - (plateH * k) / 2);
  const X = (dx: number) => midX + (dx - pcx) * k;
  const Y = (dy: number) => midY + (dy - pcy) * k;
  const S = (d: number) => d * k;

  // ---- Time ----
  const fade = (from: number): Frames | undefined => (exit ? [[from, 1], [exitAt, 1], [to, 0, "in"]] : undefined);
  const bandHold = exit ? exitAt : to;
  const onset = (wordIndex: number) => ctx.enter(cue.words[wordIndex]!, 0, 0).from;
  const t0 = onset(0);
  const heroAt = heroed ? onset(hero[0]!) : t0;
  /** The painted frames of a short build starting at `from`, ending on the first frame at or after `settled`. */
  const buildFrames = (word: number, duration: number) => {
    const { from, settled } = ctx.enter(cue.words[word]!, duration, 0);
    const tc = exportFrameAtOrAfter(settled, fps);
    return { from, frames: exportFrameTimes(from, tc + 1, fps) };
  };
  const along = (frames: readonly number[], f: (p: number) => number): [number, number][] => frames.map((t, at) => [t, f(frames.length > 1 ? at / (frames.length - 1) : 1)]);

  const shape = (id: string, from: number, path: readonly PathCmd[], x: number, y: number, fill: string | undefined, z: number, extra: Partial<Piece> = {}): Piece => ({
    ...ctx.shape(id, from, path, { x: [[from, x]], y: [[from, y]] }, fill),
    z,
    ...extra,
  } as Piece);

  // ---- The plate, rim, rays and bulbs: open from the middle on the first word's frames ----
  const open = exportFrameTimes(t0, t0 + 100, fps).slice(0, 3);
  const shares = open.length >= 3 ? [0.55, 0.85, 1] : open.length === 2 ? [0.7, 1] : [1];
  const px1 = midX - (plateW * k) / 2;
  const px2 = midX + (plateW * k) / 2;
  const py1 = midY - (plateH * k) / 2;
  const py2 = midY + (plateH * k) / 2;
  const plateClip = {
    x1: open.length > 1 ? open.map((t, at): [number, number] => [t, midX - (shares[at]! * plateW * k) / 2]) : [[t0, px1] as [number, number]],
    x2: open.length > 1 ? open.map((t, at): [number, number] => [t, midX + (shares[at]! * plateW * k) / 2]) : [[t0, px2] as [number, number]],
    y1: [[t0, py1 - 2]] as [number, number][],
    y2: [[t0, py2 + 2]] as [number, number][],
  };
  const radius = Math.min(46, 0.1 * Math.min(plateW, plateH) + 14);
  pieces.push(shape("plate", t0, roundedRectPath(-S(plateW) / 2, -S(plateH) / 2, S(plateW), S(plateH), S(radius)), midX, midY, plateColour, 1, { clip: plateClip }));

  // Rays: wedges trimmed to the plate, drawn in four strips round the disc (a square inside the disc is left bare: the disc
  // covers it, and a bitmap of the whole plate is what the render budget measures). A pose at rest and, on a long hold, one
  // every half second a few degrees on.
  const wedge = 360 / RAYS;
  const clipPoly = roundedPolygon(plateW - 0.5, plateH - 0.5, radius);
  const reach = Math.hypot(plateW, plateH);
  const hole = 0.35 * D;
  const around = { x: -pcx, y: -pcy };
  const strips: readonly (readonly [string, [number, number][]])[] = [
    ["t", [[-plateW, -plateH], [plateW, -plateH], [plateW, around.y - hole], [-plateW, around.y - hole]]],
    ["b", [[-plateW, around.y + hole], [plateW, around.y + hole], [plateW, plateH], [-plateW, plateH]]],
    ["l", [[-plateW, around.y - hole], [around.x - hole, around.y - hole], [around.x - hole, around.y + hole], [-plateW, around.y + hole]]],
    ["r", [[around.x + hole, around.y - hole], [plateW, around.y - hole], [plateW, around.y + hole], [around.x + hole, around.y + hole]]],
    // The bare square itself: drawn only until the disc has finished popping, so a key word that comes after other words
    // never shows a hole in the rays.
    ["c", [[around.x - hole, around.y - hole], [around.x + hole, around.y - hole], [around.x + hole, around.y + hole], [around.x - hole, around.y + hole]]],
  ];
  const discDone = exportFrameAtOrAfter(heroAt + 130, fps) + 1;
  const rayPaths = (phase: number): [string, PathCmd[]][] => {
    const wedges = Array.from({ length: RAYS }, (_, w) => {
      const a1 = rad(phase + w * wedge);
      const a2 = rad(phase + w * wedge + wedge / 2);
      return clipConvex([[0, 0], [reach * Math.cos(a1), reach * Math.sin(a1)], [reach * Math.cos(a2), reach * Math.sin(a2)]], clipPoly);
    }).filter((poly) => poly.length >= 3);
    return strips.map(([name, area]): [string, PathCmd[]] => [name, wedges.flatMap((poly) => {
      const part = clipConvex(poly, area);
      return part.length >= 3 ? polygonPath(part.map(([x, y]) => [S(x), S(y)] as const)) : [];
    })]);
  };
  const phase0 = ((seed % 1000) / 1000) * wedge;
  const rayStarts = [t0];
  const stepMs = 540;
  const idleFrom = exportFrameAtOrAfter(t0 + 700, fps);
  for (let at = idleFrom; at + stepMs <= bandHold - 60 && rayStarts.length < 5; at += stepMs) rayStarts.push(exportFrameAtOrAfter(at, fps));
  rayStarts.forEach((from, step) => {
    const end = rayStarts[step + 1] ?? to;
    for (const [name, path] of rayPaths(phase0 + step * wedge * 0.3)) {
      const until = name === "c" ? Math.min(end, discDone) : end;
      if (path.length > 0 && until > from) pieces.push(shape(`rays${step}${name}`, from, path, midX, midY, rayColour, 2, { clip: plateClip, toMs: until }));
    }
  });

  // The rim: a cream hairline of four lines and four corner arcs (each a small bitmap), and bulbs on the top and bottom rails.
  const inset = HAIR;
  {
    const rr = Math.max(8, radius - 10);
    const hw = plateW / 2 - inset;
    const hh = plateH / 2 - inset;
    const line = (name: string, x: number, y: number, w: number, h: number) => pieces.push(shape(name, t0, rectPath(-S(w) / 2, -S(h) / 2, S(w), S(h)), midX + S(x), midY + S(y), cream, 3, { clip: plateClip }));
    line("rim-top", 0, -hh, 2 * (hw - rr), 3);
    line("rim-bottom", 0, hh, 2 * (hw - rr), 3);
    line("rim-left", -hw, 0, 3, 2 * (hh - rr));
    line("rim-right", hw, 0, 3, 2 * (hh - rr));
    for (const [name, sx, sy, a0] of [["rim-tl", -1, -1, 180], ["rim-tr", 1, -1, 270], ["rim-br", 1, 1, 0], ["rim-bl", -1, 1, 90]] as const) {
      const piece = shape(name, t0, arcPath(0, 0, S(rr), a0, a0 + 90), midX + S(sx * (hw - rr)), midY + S(sy * (hh - rr)), undefined, 3, { clip: plateClip });
      pieces.push({ ...piece, stroke: { widthPx: S(3), colour: cream } } as Piece);
    }
  }
  const railW = plateW - 2 * inset - 2 * radius;
  const bulbs = Math.max(0, Math.floor(railW / 36));
  const bulbR = S(5);
  const openAt = open.at(-1) ?? t0;
  if (bulbs >= 3) {
    const phaseOf = (list: number[]) => list.flatMap((i) => ellipsePath(S(-railW / 2 + ((i + 0.5) * railW) / bulbs), 0, bulbR));
    const evens = Array.from({ length: bulbs }, (_, i) => i).filter((i) => i % 2 === 0);
    const odds = Array.from({ length: bulbs }, (_, i) => i).filter((i) => i % 2 === 1);
    const steps: number[] = [];
    for (let at = openAt; at + 150 <= bandHold - 60 && steps.length < 40; at += 150) steps.push(exportFrameAtOrAfter(at, fps));
    const animated = steps.length >= 4;
    for (const [rail, y] of [["top", py1 + S(inset)], ["bottom", py2 - S(inset)]] as const) {
      for (const [name, list, first] of [["a", evens, 1], ["b", odds, 0.3]] as const) {
        const o: [number, number][] = animated ? stairs(steps.map((at, n) => [at, n % 2 === 0 ? first : 1.3 - first] as const)) : [[openAt, 1]];
        const track = exit ? ([...o, [exitAt, o.at(-1)![1]], [to, 0, "in"]] as unknown as Frames) : o;
        const piece = shape(`bulbs-${rail}-${name}`, openAt, phaseOf(list), midX, y, cream, 3);
        pieces.push({ ...piece, track: { ...piece.track, o: track } } as Piece);
      }
    }
  }

  // ---- The disc: pops with the key word (with the first word when there is none) ----
  const discFrames = exportFrameTimes(heroAt, heroAt + 130, fps);
  const dr = S(D) / 2;
  const discScale = discFrames.length > 1 ? along(discFrames, (p) => 0.55 + 0.45 * ease("outBack", p)) : [[heroAt, 1] as [number, number]];
  pieces.push({
    ...ctx.shape("disc", heroAt, ellipsePath(dr, dr, dr), { x: [[heroAt, X(0)]], y: [[heroAt, Y(0)]], sx: discScale, sy: discScale }, discColour),
    z: 4,
    origin: { dx: dr, dy: dr },
  });

  // ---- The swoosh: a 7 px cream arc beside the disc, drawn on by a wipe from the edge nearest the horizontal axis ----
  {
    const ext = S(swooshRadius + 12);
    const wipe = exportFrameTimes(heroAt + 40, heroAt + 420, fps);
    const down = swooshAt >= 0;
    const reveal = (p: number) => ({
      x1: X(0) - ext, x2: X(0) + ext,
      y1: down ? Y(0) - ext : Y(0) + ext - 2 * ext * p,
      y2: down ? Y(0) - ext + 2 * ext * p : Y(0) + ext,
    });
    const animated = wipe.length >= 3;
    const clips = animated ? wipe.map((t, n): readonly [number, ReturnType<typeof reveal>] => [t, reveal(ease("out", n / (wipe.length - 1)))]) : [[heroAt, reveal(1)] as const];
    const piece = shape("swoosh", clips[0]![0], arcPath(0, 0, S(swooshRadius), swooshFrom, swooshTo), X(0), Y(0), undefined, 5, {
      clip: {
        x1: clips.map(([t, b]): [number, number] => [t, b.x1]), x2: clips.map(([t, b]): [number, number] => [t, b.x2]),
        y1: clips.map(([t, b]): [number, number] => [t, b.y1]), y2: clips.map(([t, b]): [number, number] => [t, b.y2]),
      },
    });
    pieces.push({ ...piece, stroke: { widthPx: S(7), colour: cream } } as Piece);
  }

  // ---- The words ----
  const text = (id: string, from: number, str: string, face: CaptionFontName, size: number, fill: string, track: Track, z: number, extra: Partial<TextPiece> = {}): TextPiece => ({
    id, kind: "text", z, fromMs: from, toMs: to, text: str, face, sizePx: size, letterSpacingEm: 0, fill, anchor: "baseline-center", language: cue.language,
    track: { ...(exit ? { o: fade(from) } : {}), ...track },
    ...extra,
  });
  const wid = (word: number, part = 0, parts = 1) => (parts > 1 ? `${ctx.id}:w${word}l${part}` : `${ctx.id}:w${word}`);

  // The key word(s): a script on the disc, outline and extrusion in navy, popping to rest tilted.
  for (const item of heroBlock.items) {
    const { from, frames } = buildFrames(item.word, 120);
    const size = S(item.size);
    const n = frames.length;
    const scale: [number, number][] = n >= 4 ? along(frames, (p) => 0.8 + 0.2 * ease("outBack", p)) : n === 3 ? along(frames, (p) => 0.86 + 0.14 * ease("outBack", p)) : n === 2 ? along(frames, (p) => 0.92 + 0.08 * p) : [[from, 1]];
    const tilt = heroed ? TILT : PLAIN_TILT;
    const rz: [number, number][] = n > 1 ? along(frames, (p) => tilt - 8 * (1 - ease("out", p))) : [[from, tilt]];
    const len = EXT_LEN * size;
    pieces.push(text(wid(item.word, item.part, item.parts), from, item.text, SCRIPT, size, cream, {
      x: [[from, X(item.x)]], y: [[from, Y(item.y)]], rz, sx: scale, sy: scale,
    }, 7, {
      stroke: { widthPx: OUTLINE * size, colour: NAVY },
      shadows: [1, 2].map((step) => ({ dx: (len * EXT_X * step) / 2, dy: (len * EXT_Y * step) / 2, blur: 0, colour: NAVY, alpha: 1 })),
    }));
  }

  // The arch words: letters on the ring (or a straight row), swinging the last few degrees in on their word's frames.
  for (const r of [upper, lower]) {
    for (const entry of r.words) {
      const { from, frames } = buildFrames(entry.word, 110);
      const n = frames.length;
      // A word swings in from the side the next word has not reached yet, so it never crosses the one before it.
      const swing = (p: number) => rad(12) * (1 - ease("out", p));
      if (entry.whole) {
        const w = entry.whole;
        const size = S(w.size);
        const dx: [number, number][] = n > 1 ? along(frames, (p) => X(w.x) + S(30 * side) * (1 - ease("out", p))) : [[from, X(w.x)]];
        pieces.push(text(wid(entry.word), from, w.text, CAPS, size, cream, { x: dx, y: [[from, Y(w.y)]] }, 6, {
          letterSpacingEm: 0.04,
          shadows: [{ dx: 0.05 * size, dy: 0.07 * size, blur: 0, colour: NAVY, alpha: 1 }],
        }));
        continue;
      }
      entry.letters.forEach((l, part) => {
        const size = S(l.size);
        const at = (delta: number) => letterAt(r, l, delta);
        const xs: [number, number][] = [];
        const ys: [number, number][] = [];
        const rs: [number, number][] = [];
        if (n > 1) {
          frames.forEach((t, step) => {
            const p = step / (n - 1);
            const pose = at(swing(p));
            xs.push([t, X(pose.x)]);
            ys.push([t, Y(pose.y)]);
            rs.push([t, pose.rz]);
          });
        } else {
          const pose = at(0);
          xs.push([from, X(pose.x)]);
          ys.push([from, Y(pose.y)]);
          rs.push([from, pose.rz]);
        }
        pieces.push(text(wid(entry.word, part, entry.letters.length), from, l.text, CAPS, size, cream, { x: xs, y: ys, rz: rs }, 6, {
          shadows: [{ dx: 0.05 * size, dy: 0.07 * size, blur: 0, colour: NAVY, alpha: 1 }],
        }));
      });
    }
  }

  // ---- Stars, in free space: the key word's own, and a small second one at the opposite corner ----
  const wordBoxes = [...heroBlock.items.map((item) => item.box), ...upper.boxes, ...lower.boxes];
  const inner: Box = { x1: content.x1 - PAD + 34, y1: content.y1 - PAD + 34, x2: content.x2 + PAD - 34, y2: content.y2 + PAD - 34 };
  const taken: Box[] = [];
  const claim = (r: number, spots: readonly (readonly [number, number])[]): [number, number] | null => {
    for (const [x, y] of spots) {
      const box = { x1: x - r, y1: y - r, x2: x + r, y2: y + r };
      if (box.x1 < inner.x1 || box.x2 > inner.x2 || box.y1 < inner.y1 || box.y2 > inner.y2) continue;
      if (wordBoxes.some((word) => meets(inflate(word, 8), box)) || taken.some((other) => meets(inflate(other, 6), box))) continue;
      taken.push(box);
      return [x, y];
    }
    return null;
  };
  const hb = heroBlock.box;
  const east = side > 0 !== flip;
  const corners = (r: number, right: boolean): [number, number][] => [
    [right ? inner.x2 - r : inner.x1 + r, inner.y1 + r],
    [right ? inner.x2 - r : inner.x1 + r, inner.y2 - r],
    [right ? inner.x1 + r : inner.x2 - r, inner.y1 + r],
    [right ? inner.x1 + r : inner.x2 - r, inner.y2 - r],
    [right ? hb.x2 + r + 10 : hb.x1 - r - 10, (hb.y1 + hb.y2) / 2],
  ];
  const star = (name: string, r: number, spot: readonly [number, number], at: number) => {
    const frames = exportFrameTimes(at, at + 130, fps);
    const points: [number, number][] = frames.length > 2 ? along(frames, (p) => 0.3 + 0.7 * ease("outBack", p)) : [[at, 1]];
    const grid = exportFrameTimes(at, bandHold, fps);
    // Twinkle again on every 1.3 s of a long hold, three painted frames each; the last burst ends before the exit.
    for (let burst = 1; at + burst * 1300 + 140 <= bandHold; burst++) {
      const start = exportFrameAtOrAfter(at + burst * 1300, fps);
      const mid = grid.find((t) => t > start);
      const end = grid.find((t) => t > (mid ?? start));
      if (mid !== undefined && end !== undefined) points.push([start, 1], [mid, 0.45], [end, 1]);
    }
    pieces.push({
      ...ctx.shape(name, at, sparklePath(S(r), S(r), S(r), 0.2), { x: [[at, X(spot[0])]], y: [[at, Y(spot[1])]], sx: points, sy: points }, cream),
      z: 8,
      origin: { dx: S(r), dy: S(r) },
      shadows: [{ dx: S(2.5), dy: S(3), blur: 0, colour: NAVY, alpha: 1 }],
    });
  };
  const starA = claim(30, [[east ? hb.x2 + 4 : hb.x1 - 4, hb.y1 - 42], ...corners(30, east)]);
  const starAt = exportFrameAtOrAfter(Math.min(heroAt + 70, Math.max(heroAt, bandHold - 150)), fps);
  if (starA && starAt + 66 < bandHold) star("starA", 30, starA, starAt);
  const starB = claim(19, corners(19, !east));
  const starBt = exportFrameAtOrAfter(Math.min(heroAt + 170, Math.max(heroAt, bandHold - 150)), fps);
  if (starB && starBt + 66 < bandHold) star("starB", 19, starB, starBt);

  return pieces;
}, undefined, 0);
