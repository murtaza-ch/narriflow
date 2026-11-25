import { describe, expect, test } from "bun:test";
import { type Box, type CaptionSceneName, type Piece, demoCues, evaluatePiece, exportFrameTimes, pieceBounds } from "@narriflow/caption-scene";
import { sceneDemo } from "../scripts/caption-scene-demo";

/**
 * Words of one cue never cover each other, and no decoration is drawn over a readable word, measured with the
 * real HarfBuzz measurer on real phrasing (4-5 words, long words, the hero mid-cue and last). The shared
 * conformance suite measures with a fixed 0.55 em per character, which hides overlaps that real widths cause
 * (gallery 4 real-clip review, 2026-11-25: Crosstape's tapes and Sticky's icons covered spoken words).
 *
 * Styles here name each word's readable face `<scene>:<cue>:w<word>` or `<scene>:<cue>:w<word>l<part>`.
 * A piece whose id names the same word (its plate, copy, fill or spark) may sit over its own word.
 */
const STYLES: readonly CaptionSceneName[] = [
  // Gallery 3, second batch.
  "shuffle", "squash", "slab", "labels", "googly", "bubble", "strike", "seventies", "thermal", "slot", "inkup",
  // Gallery 4.
  "primer", "manifesto", "swipe", "match", "scribble", "barrel", "pills", "pixel", "diecut", "sticky", "brute", "mdrn",
  "crosstape", "gumdrop", "flowing", "trace",
  // Gallery 5.
  "combo",
  "tunnel",
  "chronicle",
  "broadway",
  "ripple",
  "liquid",
  "snipsnap",
  "receipt",
  "anime",
  "bento",
  "blinds",
  "halftone",
  "pixelpop",
  "tilt",
  // Gallery 6.
  "glint",
];

const LINES = [
  "vibes",
  "it's:b time:b to:m say:b goodbye:h@420",
  "does:b the:m remote:b even:b still:h@360",
  "the:m remote:b doesn't:h@360 work.:b",
  "we:m didn't:h@360 want:b anyone:b",
  "all:b of:m them:b are:m unplugged.:h@480",
  "to:m accidentally:b open:b them.:b",
  "just:b tear:b it:m down.:h@380",
  "we:m didn't:h@360 want:b",
  "the:m battery:b might:b be:m dead.:h@400",
  "is:m it:m dead?:h@380",
  "oh.:b",
];

/** Hindi with English, as a real hi clip mixes them: Devanagari ink is taller than a Latin face's line box. */
const HINDI_LINES = [
  "display:b glare:b बहुत:h@420",
  "और:m अगर:b इसे:m सीधा:h@400",
  "देखो:b तो:m इतना:h@380",
  "ही:m कम:b है।:b",
];

const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
/** The ink box less a margin, so touching serifs, tilted corners and descenders into the next row's cap space do not count. */
const core = (box: Box): Box => {
  const dx = (box.x2 - box.x1) * 0.06;
  const dy = (box.y2 - box.y1) * 0.18;
  return { x1: box.x1 + dx, x2: box.x2 - dx, y1: box.y1 + dy, y2: box.y2 - dy };
};

describe("Scene Styles keep every spoken word uncovered on real phrasing", () => {
  test.each([...STYLES])("%s", (scene) => {
    const face = new RegExp(`^${scene}:(\\d+):w(\\d+)(?:l\\d+)?$`);
    const wordOf = (piece: Piece) => Number(face.exec(piece.id)?.[2] ?? -1);
    /** The word a non-face piece belongs to, when its id names one (`w3plate`, `fill3`, `spark3-0`, `icon3`). */
    const ownerOf = (piece: Piece) => {
      const rest = piece.id.split(":").slice(2).join(":");
      const match = /^(?:w)?(\d+)|[a-z]+(\d+)/i.exec(rest);
      return match ? Number(match[1] ?? match[2]) : -1;
    };
    // A pair counts once it overlaps on SUSTAIN consecutive frames: a sweep, sparkle or twinkle crossing a word for a moment is
    // motion, a plate, tape, icon or word sitting on one is a covered word.
    const SUSTAIN = 3;
    const runs = new Map<string, { last: number; count: number }>();
    const problems: string[] = [];
    const note = (pair: string, frame: number) => {
      const run = runs.get(pair);
      const next = run && run.last === frame - 1 ? { last: frame, count: run.count + 1 } : { last: frame, count: 1 };
      runs.set(pair, next);
      if (next.count === SUSTAIN) problems.push(pair);
    };
    for (const [lines, language] of [[LINES, "en"], [HINDI_LINES, "hi"]] as const) {
      const { cues } = demoCues({ lines, language, options: { lead: 400, gap: 30, cueGap: 120, tail: 500 } });
      const demo = sceneDemo(scene, { cues, fps: 30 });
      const measure = demo.measurer.measure;
      const painted = (piece: Piece, t: number) => pieceBounds(piece, t, measure);
      const readable = (piece: Piece, t: number) => {
        const pose = evaluatePiece(piece, t);
        return pose.visible && pose.o >= 0.9 && painted(piece, t) !== null;
      };
      for (const cue of cues) {
        const own = demo.scene.pieces.filter((piece) => cueOf(piece) === cue.index);
        const faces = own.filter((piece) => face.test(piece.id));
        for (const [frame, t] of exportFrameTimes(cue.startMs, cue.endMs, 30).entries()) {
          const live = faces.filter((piece) => readable(piece, t)).map((piece) => ({ piece, box: core(painted(piece, t)!) }));
          for (const [i, a] of live.entries()) {
            for (const b of live.slice(i + 1)) {
              if (wordOf(a.piece) !== wordOf(b.piece) && meets(a.box, b.box)) note(`${language}: ${a.piece.id} and ${b.piece.id} overlap`, frame);
            }
          }
          for (const other of own) {
            if (face.test(other.id)) continue;
            const pose = evaluatePiece(other, t);
            if (!pose.visible || pose.o < 0.5) continue;
            const box = painted(other, t);
            if (!box) continue;
            for (const { piece, box: faceBox } of live) {
              if (other.z <= piece.z || ownerOf(other) === wordOf(piece)) continue;
              if (meets(box, faceBox)) note(`${language}: ${other.id} is drawn over ${piece.id}`, frame);
            }
          }
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });
});
