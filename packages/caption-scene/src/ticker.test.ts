import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { TICKER_DEMO, TICKER_SPEED, tickerProgram } from "./templates/ticker";
import { fakeMeasure, sceneInput } from "./test-support";

const { cues } = demoCues(TICKER_DEMO);
const colours = { primary: "#FFFFFF", highlight: "#FFD400", accent: "#0A0A0A", shadow: "#000000" };
const build = (list = cues, overrides = {}) => tickerProgram.build(sceneInput(list, { colours, ...overrides })).pieces;
const scene = build();
const texts = scene.filter((piece): piece is TextPiece => piece.kind === "text");
const shapes = scene.filter((piece): piece is ShapePiece => piece.kind === "shape");
const piece = (id: string) => scene.find((p) => p.id === id)!;
const withPrefix = (prefix: string) => scene.filter((p) => p.id.startsWith(prefix));
const cueNo = (p: Piece) => Number(p.id.split(":")[1]);
/** The piece of a word that is on screen at `t` (a word is its pop, then its rest and exit: `w4`, `w4s`). */
const wordAt = (id: string, t: number) => texts.find((p) => (p.id === id || p.id === `${id}s`) && t >= p.fromMs && t < p.toMs)!;
const heroCopies = (cue: number) => texts.filter((p) => p.id.startsWith(`ticker:${cue}:hero`));
const stars = (cue: number) => shapes.filter((p) => p.id.startsWith(`ticker:${cue}:star`));

const COS = Math.cos((4 * Math.PI) / 180);
const SIN = Math.sin((4 * Math.PI) / 180);
/** Sample px from the band's centre in the tape's frame (tilt degrees) of a canvas point (u = 1, centre 540, 1300). */
const local = (x: number, y: number, tiltDeg: number) => {
  const a = (tiltDeg * Math.PI) / 180;
  const dx = x - 540;
  const dy = y - 1300;
  return { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) };
};
const anchorLocal = (p: TextPiece, t: number, tiltDeg: number) => {
  const pose = evaluatePiece(p, t);
  const at = local(pose.x, pose.y, tiltDeg);
  return { x: at.x - (p.origin?.dx ?? 0), y: at.y - (p.origin?.dy ?? 0) };
};
/** The hero cue "resale is DEAD and nobody cares" (cue 1): the hero starts at 2390. */
const HERO_CUE = 1;
const heroStart = cues[HERO_CUE]!.words[2]!.startMs;
const bandStart = heroStart - 60;
const landing = bandStart + 240;
const cueEnd = cues[HERO_CUE]!.endMs;
const wipeIn = (t: number) => EASES.outExpo(prog(t, bandStart, 240));
const wipeOut = (t: number) => EASES.inOut(prog(t, cueEnd - 160, 160));

describe("Ticker", () => {
  test("a tape with a shadow strip and two keylines per cue, copies and stars only for a hero, bleed on all of them", () => {
    for (const number of [0, 1, 2, 3, 4]) {
      expect(piece(`ticker:${number}:band`)).toBeDefined();
      expect(withPrefix(`ticker:${number}:shadow`).length).toBeGreaterThanOrEqual(4);
      expect(withPrefix(`ticker:${number}:key0s`).length).toBeGreaterThanOrEqual(4);
      expect(withPrefix(`ticker:${number}:key1s`).length).toBeGreaterThanOrEqual(4);
    }
    expect(heroCopies(0)).toHaveLength(0);
    expect(heroCopies(3)).toHaveLength(0);
    for (const number of [1, 2, 4]) {
      expect(heroCopies(number).length).toBeGreaterThanOrEqual(3);
      expect(stars(number).length).toBeGreaterThanOrEqual(2);
    }
    for (const p of scene) {
      const decoration = /:(band|shadow\d+|key\ds\d+|hero\d+|star\d+)$/.test(p.id);
      expect(p.bleed === true).toBe(decoration);
    }
    // The shadow is the tape moved 12 px down in its own frame, so only a 12 px strip under the lower edge shows.
    for (const strip of withPrefix("ticker:1:shadow") as ShapePiece[]) {
      expect(strip.fill).toEqual({ colour: "#000000", alpha: 0.55 });
      const ys = strip.path.flatMap((cmd) => (cmd[0] === "L" || cmd[0] === "M" ? [cmd[2]] : []));
      expect(Math.max(...ys) - Math.min(...ys)).toBe(12);
      expect(Math.min(...ys)).toBe(-6);
      expect(evaluatePiece(strip, strip.fromMs + 1).rz).toBe(-4);
    }
  });

  test("the hero tape is 155 px tall (1.5 cap heights of 150 px Archivo Black), tilted -4 degrees, 1420 px wide at 1080", () => {
    const band = piece("ticker:1:band") as ShapePiece;
    const ys = band.path.flatMap((cmd) => (cmd[0] === "L" || cmd[0] === "M" ? [cmd[2]] : []));
    const xs = band.path.flatMap((cmd) => (cmd[0] === "L" || cmd[0] === "M" ? [cmd[1]] : []));
    expect(Math.max(...ys) - Math.min(...ys)).toBe(155);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(1420);
    expect(evaluatePiece(band, landing + 100).rz).toBe(-4);
    // Fully wiped in, its left end is 710 px along the tape from the centre; the tape's centre is the anchor line.
    const pose = evaluatePiece(band, landing + 100);
    expect(pose.sx).toBeCloseTo(1, 4);
    expect(pose.x).toBeCloseTo(540 - 710 * COS, 1);
    expect(pose.y).toBeCloseTo(1300 + 710 * SIN, 1);
    expect(band.fill).toEqual({ colour: "#FFD400" });
    // Keylines: 4 px, 9 px inside each edge; each a row of static segments, together as wide as the visible frame needs.
    const upper = withPrefix("ticker:1:key0s") as ShapePiece[];
    expect(upper[0]!.fill).toEqual({ colour: "#0A0A0A" });
    const key = local(evaluatePiece(upper[0]!, landing).x, evaluatePiece(upper[0]!, landing).y, -4);
    expect(key.y).toBeCloseTo(9 + 2 - 77.5, 1);
    const keyYs = upper[0]!.path.flatMap((cmd) => (cmd[0] === "L" || cmd[0] === "M" ? [cmd[2]] : []));
    expect(Math.max(...keyYs) - Math.min(...keyYs)).toBe(4);
    const lower = local(evaluatePiece(withPrefix("ticker:1:key1s")[0]!, landing).x, evaluatePiece(withPrefix("ticker:1:key1s")[0]!, landing).y, -4);
    expect(lower.y).toBeCloseTo(77.5 - 9 - 2, 1);
    // Segments overlap by a pixel and a half so no seam shows, and they cover the frame.
    const spans = upper.map((strip) => {
      const xs = strip.path.flatMap((cmd) => (cmd[0] === "L" || cmd[0] === "M" ? [cmd[1]] : []));
      return { from: local(evaluatePiece(strip, landing).x, evaluatePiece(strip, landing).y, -4).x, to: local(evaluatePiece(strip, landing).x, evaluatePiece(strip, landing).y, -4).x + Math.max(...xs) };
    });
    for (let at = 1; at < spans.length; at++) expect(spans[at]!.from).toBeLessThanOrEqual(spans[at - 1]!.to);
    expect(spans[0]!.from).toBeLessThanOrEqual(-540 - 60 + 1);
    expect(spans[spans.length - 1]!.to).toBeGreaterThanOrEqual(540 + 60 - 1);
  });

  test("the tape wipes in over 240 ms outExpo from the left and out over 160 ms inOut, both ends following the sample", () => {
    // The tape is one long rectangle scaled about its left end.
    const band = piece("ticker:1:band");
    const sxAt = (t: number) => evaluatePiece(band, t).sx;
    for (const t of [bandStart, bandStart + 33, bandStart + 80, bandStart + 160, landing + 1, cueEnd - 160, cueEnd - 120, cueEnd - 60, cueEnd - 10]) {
      expect(sxAt(t)).toBeCloseTo(wipeIn(t) - wipeOut(t), 3);
    }
    // The left end rides the right edge's chase: at the end of the exit the tape has no width.
    expect(sxAt(cueEnd - 1)).toBeLessThan(0.01);
    // The pivot (the left end) follows the exit along the tape: 1420 x wipeOut px from where it started.
    for (const t of [cueEnd - 140, cueEnd - 100, cueEnd - 40]) {
      const pose = evaluatePiece(band, t);
      expect(pose.x).toBeCloseTo(540 + COS * (1420 * wipeOut(t) - 710), 1);
    }
    // Cut at a time, the copies' clip edges are the tape's ends at the centre line.
    const copy = heroCopies(HERO_CUE)[0]!;
    for (const t of [bandStart + 40, bandStart + 120, landing]) {
      const clip = evaluatePiece(copy, Math.max(t, copy.fromMs)).clip!;
      if (t >= copy.fromMs) expect(clip.x2).toBeCloseTo(540 + COS * (1420 * wipeIn(t) - 710), 1);
    }
    for (const t of [cueEnd - 150, cueEnd - 100, cueEnd - 40]) {
      const live = heroCopies(HERO_CUE).find((p) => t >= p.fromMs && t < p.toMs)!;
      expect(evaluatePiece(live, t).clip!.x1).toBeCloseTo(540 + COS * (1420 * wipeOut(t) - 710), 1);
    }
  });

  test("the hero repeats as a marquee at 200 px/s along the tape, one copy centred when the wipe lands", () => {
    const copies = heroCopies(HERO_CUE);
    expect(TICKER_SPEED).toBe(0.2);
    const live = copies.filter((p) => landing >= p.fromMs && landing < p.toMs);
    // "DEAD": box = 4 x (0.55 - 0.01) x 150 = 324 px under the fake measure.
    const box = 4 * (0.55 - 0.01) * 150;
    const centred = live.find((p) => Math.abs(anchorLocal(p, landing, -4).x + box / 2) < 0.7)!;
    expect(centred).toBeDefined();
    // Baseline half a cap height (0.688 x 150 / 2) under the centre.
    expect(anchorLocal(centred, landing, -4).y).toBeCloseTo(51.6, 0);
    // A second apart, it has moved 200 px left along the tape.
    const a = anchorLocal(centred, landing, -4);
    const b = anchorLocal(centred, landing + 1000, -4);
    expect(a.x - b.x).toBeCloseTo(200, 1);
    expect(b.y).toBeCloseTo(a.y, 1);
    // Copies are a word, a star, a word: the star sits 46 + 29 px past the word's end, centred on the tape.
    const star = stars(HERO_CUE).find((p) => landing >= p.fromMs && landing < p.toMs)!;
    const starAt = local(evaluatePiece(star, landing).x, evaluatePiece(star, landing).y, -4);
    expect(starAt.y).toBeCloseTo(0, 1);
    const unit = box + 58 + 92;
    const gaps = live.map((p) => anchorLocal(p, landing, -4).x).sort((x, y) => x - y);
    expect(gaps[1]! - gaps[0]!).toBeCloseTo(unit, 1);
  });

  test("copies are only alive while some of them is inside the tape", () => {
    for (const number of [1, 2, 4]) {
      const band = piece(`ticker:${number}:band`);
      for (const copy of heroCopies(number)) {
        expect(copy.fromMs).toBeGreaterThanOrEqual(band.fromMs);
        expect(copy.toMs).toBeLessThanOrEqual(band.toMs);
        // Mid-life the copy overlaps the 1420 px tape.
        const mid = (copy.fromMs + copy.toMs) / 2;
        const x = anchorLocal(copy, mid, -4).x;
        expect(x).toBeLessThan(710);
        const box = [...copy.text].length * (0.55 - 0.01) * 150;
        expect(x + box).toBeGreaterThan(-710);
      }
    }
  });

  test("lead words ride above the tape's left half, tail words below its right half, with a hard shadow and a 7 px outline", () => {
    const resale = texts.find((p) => p.id === "ticker:1:w0")!;
    const nobody = texts.find((p) => p.id === "ticker:1:w4")!;
    const cares = texts.find((p) => p.id === "ticker:1:w5")!;
    const at = (p: TextPiece) => anchorLocal(p, p.fromMs + 300, -4);
    // Lead row: starts 440 px left of the tape's centre, baseline 31 px above the tape's top edge (probe: -31).
    expect(at(resale).x).toBeCloseTo(-440, 0);
    expect(at(resale).y).toBeCloseTo(-31 - 77.5, 0);
    // Tail row: ends 422 px right of centre, baseline 246 px under the tape's top edge (probe: 246).
    const boxOf = (p: TextPiece) => [...p.text].length * (0.55 - 0.01) * 66;
    expect(at(cares).x + boxOf(cares)).toBeCloseTo(422, 0);
    expect(at(cares).y).toBeCloseTo(246 - 77.5, 0);
    expect(at(nobody).y).toBeCloseTo(at(cares).y, 1);
    for (const p of [resale, nobody, cares]) {
      expect(p).toMatchObject({ face: "Inter Tight ExtraBold", sizePx: 66, letterSpacingEm: -0.01, fill: "#FFFFFF", stroke: { widthPx: 3.5, colour: "#0A0A0A" }, shadows: [{ dx: 5, dy: 7, blur: 0, colour: "#0A0A0A", alpha: 1 }] });
      expect(p.clip).toBeUndefined();
      expect(evaluatePiece(p, p.fromMs + 600).rz).toBe(-4);
    }
    expect(texts.find((p) => p.id === "ticker:1:w2")).toBeUndefined();
  });

  test("a word pops 0.8 to 1 on a 260 ms spring from 60 ms before it is spoken and fades in over 50 ms", () => {
    const word = cues[HERO_CUE]!.words[4]!;
    const p = texts.find((t) => t.id === "ticker:1:w4")!;
    const wf = word.startMs - 60;
    for (const dt of [0, 25, 50, 90, 140, 200, 260, 400]) {
      const pose = evaluatePiece(p, wf + dt);
      expect(pose.sx).toBeCloseTo(0.8 + 0.2 * EASES.spring(prog(wf + dt, wf, 260)), 3);
      expect(pose.sy).toBeCloseTo(pose.sx, 6);
      expect(pose.o).toBeCloseTo(Math.min(1, dt / 50), 3);
    }
  });

  test("a word's rest never changes: the pop settles into a piece with no scale, no fade and no drift until the exit", () => {
    const pop = texts.find((p) => p.id === "ticker:1:w4")!;
    const rest = texts.find((p) => p.id === "ticker:1:w4s")!;
    expect(rest.fromMs).toBe(pop.toMs);
    expect(rest.toMs).toBe(cueEnd);
    expect(rest.track.sx).toBeUndefined();
    const a = evaluatePiece(rest, rest.fromMs);
    const b = evaluatePiece(rest, cueEnd - 161);
    expect(a).toMatchObject({ x: b.x, y: b.y, o: 1 });
    // The pop's last pose is the rest's pose: the hand-over cannot show.
    const last = evaluatePiece(pop, pop.toMs - 0.001);
    expect(last.sx).toBeCloseTo(1, 2);
    expect(last.x).toBe(a.x);
    expect(last.y).toBe(a.y);
  });

  test("on exit the words fade over 80 ms and drift 28 px along the tape while the tape wipes away", () => {
    const outStart = cueEnd - 160;
    const pose = (t: number) => evaluatePiece(wordAt("ticker:1:w4", t), t);
    expect(pose(outStart).o).toBeCloseTo(1, 3);
    expect(pose(outStart + 40).o).toBeCloseTo(0.5, 3);
    expect(pose(outStart + 80).o).toBeCloseTo(0, 3);
    const before = pose(outStart);
    const after = pose(outStart + 80);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeCloseTo(28, 1);
    const mid = pose(outStart + 40);
    expect(Math.hypot(mid.x - before.x, mid.y - before.y)).toBeCloseTo(28 * EASES.in(0.5), 1);
    expect(after.x - before.x).toBeCloseTo(28 * COS, 1);
  });

  test("a cue without a hero is a slim black tape tilted +3 with yellow keylines and the words in white, no marquee", () => {
    const band = piece("ticker:0:band") as ShapePiece;
    const ys = band.path.flatMap((cmd) => (cmd[0] === "L" || cmd[0] === "M" ? [cmd[2]] : []));
    expect(Math.max(...ys) - Math.min(...ys)).toBe(102);
    expect(band.fill).toEqual({ colour: "#0A0A0A" });
    expect(evaluatePiece(band, 800).rz).toBe(3);
    expect((withPrefix("ticker:0:key1s")[0] as ShapePiece).fill).toEqual({ colour: "#FFD400" });
    const words = texts.filter((p) => cueNo(p) === 0 && !p.id.endsWith("s"));
    expect(words).toHaveLength(4);
    for (const w of words) {
      expect(w).toMatchObject({ fill: "#FFFFFF", sizePx: 66, face: "Inter Tight ExtraBold" });
      expect(w.stroke).toBeUndefined();
      expect(w.shadows).toBeUndefined();
      expect(w.clip).toBeDefined();
      // Baseline 24 px under the tape's centre (probe: 75 of 102).
      expect(anchorLocal(w, 1500, 3).y).toBeCloseTo(24, 0);
    }
    // The row is centred on the tape: its first word starts at -width / 2.
    const boxes = words.map((w) => [...w.text].length * (0.55 - 0.01) * 66);
    const width = boxes.reduce((s, b) => s + b, 0) + 3 * 0.26 * 66;
    expect(anchorLocal(words[0]!, 1500, 3).x).toBeCloseTo(-width / 2, 0);
  });

  test("the tape wipes in from the left even when it starts as the last cue's tape leaves (a hero 60 ms after the cue starts)", () => {
    const last = cues[4]!;
    const previous = cues[3]!;
    const heroBand = piece("ticker:4:band");
    const plainBand = piece("ticker:3:band");
    // The new tape starts 60 ms before 7157 while the old one is still wiping out until 7157.
    expect(heroBand.fromMs).toBe(last.words[0]!.startMs - 60);
    expect(plainBand.toMs).toBe(previous.endMs);
    expect(evaluatePiece(heroBand, heroBand.fromMs + 33).sx).toBeGreaterThan(0.3);
    expect(evaluatePiece(plainBand, previous.endMs - 33).sx).toBeLessThan(0.15);
    // Later cue paints over the earlier one.
    expect(heroBand.z).toBeGreaterThan(plainBand.z);
  });

  test("a hero wider than the safe width shrinks the whole tape; the support rows wrap and shrink instead of leaving the frame", () => {
    const long = demoCues({ lines: ["it's:m extraordinarilyexuberantly:h@900 hard:b"] }).cues;
    const pieces = build(long);
    const band = pieces.find((p) => p.id === "ticker:0:band") as ShapePiece;
    const ys = band.path.flatMap((cmd) => (cmd[0] === "L" || cmd[0] === "M" ? [cmd[2]] : []));
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(155);
    const copy = pieces.find((p) => p.id.startsWith("ticker:0:hero")) as TextPiece;
    const box = fakeMeasure(copy.text, copy.face, copy.sizePx, copy.letterSpacingEm).advance + copy.letterSpacingEm * copy.sizePx;
    expect(box).toBeLessThanOrEqual(0.9 * 1080 + 0.5);
    // A very long word in a plain cue shrinks the row to the safe width.
    const plain = demoCues({ lines: ["pneumonoultramicroscopicsilicovolcanoconiosis:b@1400"] }).cues;
    const word = build(plain).find((p): p is TextPiece => p.kind === "text")!;
    expect(fakeMeasure(word.text, word.face, word.sizePx, word.letterSpacingEm).advance).toBeLessThanOrEqual(0.9 * 1080 + 0.5);
    // A nine-word cue wraps its lead row above the tape instead of running off the frame.
    const nine = sceneEdgeDemo("nine-words").cues;
    const leadYs = new Set(build(nine).filter((p): p is TextPiece => p.kind === "text" && cueNo(p) === 0 && p.sizePx === 66 && p.stroke !== undefined && evaluatePiece(p, p.fromMs + 700).y < 1200).map((p) => Math.round(p.track.y![0]![1] / 10)));
    expect(leadYs.size).toBeGreaterThanOrEqual(1);
  });

  test("a right-to-left cue mirrors the rows: lead on the right half, tail on the left", () => {
    const { cues: urdu } = demoCues({ lines: ["یہ:m بہت:b اچھا:h@600 ہے:m نہیں:b"], language: "ur" });
    const pieces = build(urdu);
    const words = pieces.filter((p): p is TextPiece => p.kind === "text" && p.id.includes(":w"));
    const x = (index: number) => evaluatePiece(words.find((w) => w.id === `ticker:0:w${index}`)!, urdu[0]!.words[index]!.startMs + 600).x;
    // Logical order is lead (0, 1), hero (2), tail (3, 4): the first lead word is the rightmost of its row.
    expect(x(0)).toBeGreaterThan(x(1));
    expect(x(3)).toBeGreaterThan(x(4));
    expect(x(0)).toBeGreaterThan(540);
    expect(x(4)).toBeLessThan(540);
  });

  test("it builds without a flaw: finite frames in order, windows that are not empty, words inside the safe area", () => {
    const lists = [cues, ...(["one-word", "nine-words", "long-word", "no-hero", "urdu", "two-speakers"] as const).map((kind) => sceneEdgeDemo(kind).cues)];
    for (const list of lists) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
        const pieces = build(list, { canvas, anchor: { xPct: 50, yPct: (1300 / 1920) * 100 } });
        for (const p of pieces) {
          expect(p.toMs).toBeGreaterThan(p.fromMs);
          for (const frames of [p.track.x, p.track.y, p.track.sx, p.track.o, p.clip?.x1, p.clip?.x2]) {
            if (!frames) continue;
            for (let at = 0; at < frames.length; at++) {
              expect(Number.isFinite(frames[at]![1])).toBe(true);
              if (at > 0) expect(frames[at]![0]).toBeGreaterThanOrEqual(frames[at - 1]![0]);
            }
          }
        }
        // The words (not the tape) stay inside the 5 % margin: the tape bleeds and `sceneBoundsAt` leaves it out.
        for (let t = 0; t < 9000; t += 100) {
          const box = sceneBoundsAt(pieces, t, fakeMeasure);
          if (!box) continue;
          expect(box.x1).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
          expect(box.x2).toBeLessThanOrEqual(0.95 * canvas.width + 1);
        }
      }
    }
  });

  test("on a 16:9 canvas the tape still runs past both edges", () => {
    const pieces = build(cues, { canvas: { width: 1920, height: 1080 }, anchor: { xPct: 50, yPct: (1300 / 1920) * 100 } });
    const band = pieces.find((p) => p.id === "ticker:1:band") as ShapePiece;
    const xs = band.path.flatMap((cmd) => (cmd[0] === "L" || cmd[0] === "M" ? [cmd[1]] : []));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(1920 + 340 - 1);
  });

  test("a cue shorter than both wipes keeps the tape's scale inside 0..1 and its frames in order", () => {
    const quick = demoCues({ lines: ["a:b b:h@80", "c:b"], options: { cueGap: 0, lead: 400 } }).cues;
    const pieces = build(quick);
    for (const p of pieces.filter((q) => /:band$/.test(q.id))) {
      for (let t = p.fromMs; t < p.toMs; t += 11) {
        const sx = evaluatePiece(p, t).sx;
        expect(sx).toBeGreaterThanOrEqual(-1e-6);
        expect(sx).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  });
});
