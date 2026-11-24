import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrBefore, exportFrameTimes } from "./frame-grid";
import { type Box, SCENE_PIECE_BUDGET, evaluatePiece, pieceBounds, sceneBoundsAt } from "./scene";
import { SEVENTIES_DEMO, seventiesProgram } from "./templates/seventies";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("seventies", seventiesProgram, { anchorLineY: 1290 });

const colours = { primary: "#EF5849", highlight: "#F4B33D", accent: "#FBEFE3", shadow: "#3A1C13" };
const build = (cues: ReturnType<typeof demoCues>["cues"], overrides: Parameters<typeof sceneInput>[1] = {}) =>
  seventiesProgram.build(sceneInput(cues, { colours, ...overrides })).pieces;

describe("Seventies stickers", () => {
  test("cycles die cuts by hero count and repeats both print accents across 28 cues", () => {
    const { cues } = demoCues({ lines: Array.from({ length: 28 }, (_, i) => i % 2 === 0 ? "what:b a:m life:h@650" : "fresh:b from:m the:m oven:b") });
    const pieces = build(cues);
    expect(build(cues)).toEqual(pieces);
    let hero = 0;
    for (const cue of cues) {
      const prefix = `seventies:${cue.index}:`;
      const group = pieces.filter(({ id }) => id.startsWith(prefix));
      expect(group.some(({ id }) => id === `${prefix}oval`)).toBe(true);
      expect(group.some(({ id }) => id === `${prefix}sunburst`)).toBe(true);
      expect(group.some(({ id }) => id === `${prefix}glint`)).toBe(true);
      expect(group.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0)).toBeLessThan(SCENE_PIECE_BUDGET);
      const badge = group.find((piece) => piece.kind === "shape" && piece.id.startsWith(`${prefix}badge-`));
      if (cue.index % 2 !== 0) {
        expect(badge).toBeUndefined();
        continue;
      }
      const variants = [["scallop", "#F4B33D"], ["hexagon", "#2E8C80"], ["tag", "#EF5849"], ["scallop", "#B9A0E8"]];
      const [shape, fill] = variants[hero++ % variants.length]!;
      expect(badge?.id).toBe(`${prefix}badge-${shape}`);
      expect(badge?.kind === "shape" && badge.fill?.colour).toBe(fill);
    }
  });

  test("the oval follows the printed words and the hero letters pop in speech order", () => {
    const { cues } = demoCues(SEVENTIES_DEMO);
    const pieces = build(cues);
    const oval = pieces.find(({ id }) => id === "seventies:0:oval")!;
    expect(evaluatePiece(oval, 430).sx).toBeLessThan(evaluatePiece(oval, 1400).sx);
    expect(evaluatePiece(oval, 430).sy).toBeLessThan(evaluatePiece(oval, 1400).sy);
    const parts = pieces.filter((piece) => piece.kind === "text" && piece.id.startsWith("seventies:0:w4l"));
    expect(parts.map((piece) => piece.kind === "text" && piece.text)).toEqual(["l", "i", "f", "e"]);
    expect(parts.map((piece) => piece.fromMs)).toEqual([...new Set(parts.map((piece) => piece.fromMs))].sort((a, b) => a - b));
    expect(evaluatePiece(parts[0]!, parts[0]!.fromMs).sx).toBeLessThan(evaluatePiece(parts[0]!, 1900).sx);
  });

  test("a 150 ms opening word still types in over multiple painted frames with a 60 ms cue gap", () => {
    const { cues } = demoCues({ lines: ["quickly:b@150", "really:b@150"], options: { cueGap: 60 } });
    const pieces = build(cues);
    const face = pieces.find(({ id }) => id === "seventies:1:w0")!;
    const word = cues[1]!.words[0]!;
    const frames = exportFrameTimes(word.startMs, word.endMs);
    const widths = frames.map((frame) => {
      const bounds = pieceBounds(face, frame, fakeMeasure)!;
      return bounds.x2 - bounds.x1;
    });
    expect(new Set(widths).size).toBeGreaterThanOrEqual(2);
    expect(widths.at(-1)!).toBeGreaterThan(widths[0]!);
  });

  test("Urdu stays shaped in whole words and mirrors the oval and hero placement", () => {
    const { cues } = sceneEdgeDemo("urdu");
    const pieces = build(cues);
    const hero = pieces.filter((piece) => piece.id.startsWith("seventies:0:w2"));
    expect(hero).toHaveLength(1);
    expect(hero[0]).toMatchObject({ kind: "text", text: "اچھا", face: "DM Serif Display Italic", language: "ur" });
    expect(pieces.find((piece) => piece.id === "seventies:0:w0")?.clip).toBeUndefined();
    const sampleAt = cues[0]!.words[2]!.startMs + 300;
    const oval = pieceBounds(pieces.find((piece) => piece.id === "seventies:0:oval")!, sampleAt, fakeMeasure)!;
    const badge = pieceBounds(pieces.find((piece) => piece.id === "seventies:0:badge-scallop")!, sampleAt, fakeMeasure)!;
    expect(badge.x1 + badge.x2).toBeLessThan(oval.x1 + oval.x2);
    const [leading, next] = [0, 1].map((at) => pieceBounds(pieces.find((piece) => piece.id === `seventies:0:w${at}`)!, sampleAt, fakeMeasure)!);
    expect(leading!.x1).toBeGreaterThan(next!.x1);
  });

  test("a third overlapping cue can lead while the first speaker is still finishing", () => {
    const { cues } = demoCues({ lines: ["A> almost:b@300 there:b@300", "B> wait:b@550", "C> sorry:b@320"], options: { gap: 0 } });
    const starts = [400, 700, 1010];
    const shifted = cues.map((cue, i) => {
      const offset = starts[i]! - cue.startMs;
      return { ...cue, startMs: cue.startMs + offset, endMs: cue.endMs + offset, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + offset, endMs: word.endMs + offset })) };
    });
    const canvas = { width: 1920, height: 1080 };
    const pieces = build(shifted, { canvas, scale: 2 });
    const last = exportFrameAtOrBefore(shifted[0]!.words[1]!.endMs - 1);
    expect(pieceBounds(pieces.find((p) => p.id === "seventies:0:w1")!, last, fakeMeasure)).not.toBeNull();
    for (const t of exportFrameTimes(900, 1220)) {
      const groups = shifted.flatMap((cue) => sceneBoundsAt(pieces.filter(({ id }) => id.startsWith(`seventies:${cue.index}:`)), t, fakeMeasure) ?? []);
      for (const [i, box] of groups.entries()) {
        expect(box.y1).toBeGreaterThanOrEqual(canvas.height * 0.05);
        expect(box.y2).toBeLessThanOrEqual(canvas.height * 0.95);
        for (const other of groups.slice(i + 1)) expect(box.y2 < other.y1 || other.y2 < box.y1).toBe(true);
      }
    }
  });

  test("brand colours tint the oval lettering and the die cut with legible hero ink", () => {
    const { cues } = demoCues({ lines: ["hey:b honey:h@600"] });
    const pieces = build(cues, { colours: { ...colours, primary: "#522366", highlight: "#61B0A8" } });
    expect(pieces.find(({ id }) => id === "seventies:0:w0")).toMatchObject({ fill: "#522366" });
    expect(pieces.find(({ id }) => id === "seventies:0:badge-scallop")).toMatchObject({ fill: { colour: "#61B0A8" } });
    expect(pieces.find(({ id }) => id === "seventies:0:w1l0")).toMatchObject({ fill: "#3A1C13" });
  });
});

test("Seventies' die-cut sticker, even turned, stays clear of the words in the oval above it", () => {
  // Gallery review 2026-11-25: the turned die cut's box reached the oval's last row on every cue with a one-row or two-row oval.
  const { cues } = demoCues({
    lines: ["it's:b time:b to:m say:b goodbye:h@420", "all:b of:m them:b are:m unplugged.:h@480", "we:m want:b anyone:b didn't:h@360", "does:b the:m remote:b even:b still:h@360", "just:b tear:b it:m down.:h@380"],
    options: { lead: 400, gap: 30, cueGap: 120, tail: 500 },
  });
  const pieces = build(cues);
  const core = (box: Box): Box => {
    const dx = (box.x2 - box.x1) * 0.06;
    const dy = (box.y2 - box.y1) * 0.18;
    return { x1: box.x1 + dx, x2: box.x2 - dx, y1: box.y1 + dy, y2: box.y2 - dy };
  };
  const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
  let checked = 0;
  for (const cue of cues) {
    const own = pieces.filter(({ id }) => id.startsWith(`seventies:${cue.index}:`));
    const words = own.filter(({ id }) => /^seventies:\d+:w\d+$/.test(id));
    for (const sticker of own.filter(({ id }) => /:(?:diecut|badge-.+)$/.test(id))) {
      for (const t of exportFrameTimes(cue.startMs, cue.endMs, 30)) {
        const box = pieceBounds(sticker, t, fakeMeasure);
        if (!box) continue;
        for (const word of words) {
          if (cue.words[Number(word.id.split(":w")[1])]!.role === "hero") continue;
          const ink = pieceBounds(word, t, fakeMeasure);
          if (!ink) continue;
          checked++;
          expect(meets(box, core(ink)), `${sticker.id} over ${word.id} at ${t}`).toBe(false);
        }
      }
    }
  }
  expect(checked).toBeGreaterThan(100);
});
