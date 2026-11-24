import { expect, test } from "bun:test";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Box, type Piece, type TextPiece, evaluatePiece, pieceBounds } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";
import { stickyProgram } from "./templates/sticky";

/** Real phrasing: two-word rows, the key word first, mid-cue and last, a long key word and two key words in a row. */
const LINES = [
  "it's:b time:b to:m say:b goodbye:h@420",
  "does:b the:m remote:b even:b still:h@360",
  "the:m remote:b doesn't:h@360 work.:b",
  "we:m didn't:h@360 want:b anyone:b",
  "anyone:m to:m accidentally:h@520 open:b them.:m",
  "the:m battery:b might:b be:m dead.:h@400",
  "is:m it:m dead?:h@380",
  "we've:m shot:b 384:h episodes:h@420",
  "out:m for:m waveform:h studio:h@380 number:b",
  "wouldn't:h have:m done:b",
  "just:b tear:b it:m down.:m",
  "oh.:b",
];

const { cues } = demoCues({ lines: LINES, options: { lead: 400, gap: 30, cueGap: 120, tail: 500 } });
const input = (cue: readonly SceneCue[], fps = 30) => sceneInput(cue, { fps, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } });
const { pieces } = stickyProgram.build(input(cues));
const cueOf = (piece: Piece) => Number(piece.id.split(":")[1]);
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
const shown = (piece: Piece, t: number) => (evaluatePiece(piece, t).visible ? pieceBounds(piece, t, fakeMeasure) : null);
/** The end of each cue's spoken words, when every label has settled and every icon has popped. */
const settledAt = (cue: SceneCue) => Math.max(...cue.words.map((word) => word.endMs)) - 20;

test("an icon sits in free space beside its own label, never on another word or label", () => {
  let icons = 0;
  for (const cue of cues) {
    const own = pieces.filter((piece) => cueOf(piece) === cue.index);
    const t = settledAt(cue);
    const icon = own.filter((piece) => /^sticky:\d+:icon/.test(piece.id));
    const word = (piece: Piece) => Number(/(\d+)/.exec(piece.id.split(":")[2]!)![1]);
    for (const piece of icon) {
      const box = shown(piece, t);
      if (!box) continue;
      icons++;
      for (const other of own) {
        if (/^sticky:\d+:icon/.test(other.id) || word(other) === word(piece)) continue;
        const otherBox = shown(other, t);
        if (otherBox) expect(meets(box, otherBox), `${piece.id} over ${other.id} in cue ${cue.index}`).toBe(false);
      }
    }
  }
  expect(icons).toBeGreaterThan(8);
});

test("every label keeps clear of the other labels of its cue, tilted ends included", () => {
  for (const cue of cues) {
    const tags = pieces.filter((piece) => cueOf(piece) === cue.index && /^sticky:\d+:tag\d+$/.test(piece.id));
    for (const t of exportFrameTimes(settledAt(cue) - 60, settledAt(cue), 30)) {
      const live = tags.flatMap((piece) => shown(piece, t) ?? []);
      for (const [i, a] of live.entries()) {
        for (const b of live.slice(i + 1)) expect(meets(a, b), `labels of cue ${cue.index} overlap at ${t}`).toBe(false);
      }
    }
  }
});

test("a hero's icon sits on the outer side of its row, so a row-mate is never beside it", () => {
  for (const cue of cues) {
    const t = settledAt(cue);
    for (const piece of pieces.filter((candidate) => cueOf(candidate) === cue.index && /:icon\d+-0$/.test(candidate.id))) {
      const at = Number(/icon(\d+)-0$/.exec(piece.id)![1]);
      const hero = pieces.find((candidate) => candidate.id === `sticky:${cue.index}:tag${at}`)!;
      const iconBox = shown(piece, t);
      const heroBox = shown(hero, t);
      if (!iconBox || !heroBox) continue;
      const iconSide = (iconBox.x1 + iconBox.x2) / 2 < (heroBox.x1 + heroBox.x2) / 2 ? -1 : 1;
      for (const other of pieces.filter((candidate) => cueOf(candidate) === cue.index && /^sticky:\d+:tag\d+$/.test(candidate.id) && candidate !== hero)) {
        const box = shown(other, t);
        // Anything on the same line as the icon sits on the far side of the hero's label.
        if (box && box.y1 < iconBox.y2 && box.y2 > iconBox.y1) {
          expect((box.x1 + box.x2) / 2 * -iconSide, `${other.id} shares a row with ${piece.id}`).toBeGreaterThan((heroBox.x1 + heroBox.x2) / 2 * -iconSide);
        }
      }
    }
  }
});

test("minor words are stamped at a readable size and everything stays in the safe area", () => {
  const faces = pieces.filter((piece): piece is TextPiece => piece.kind === "text");
  const minor = new Set(["IT'S", "TO", "THE", "WE", "IS", "IT", "OUT", "FOR", "ANYONE"]);
  const smallest = Math.min(...faces.filter((face) => minor.has(face.text)).map((face) => face.sizePx));
  expect(smallest).toBeGreaterThanOrEqual(40);
  for (const cue of cues) {
    const t = settledAt(cue);
    for (const piece of pieces.filter((candidate) => cueOf(candidate) === cue.index)) {
      const box = shown(piece, t);
      if (!box) continue;
      expect(box.x1, piece.id).toBeGreaterThanOrEqual(54 - 1);
      expect(box.x2, piece.id).toBeLessThanOrEqual(1026 + 1);
      expect(box.y1, piece.id).toBeGreaterThanOrEqual(96 - 1);
      expect(box.y2, piece.id).toBeLessThanOrEqual(1824 + 1);
    }
  }
});
