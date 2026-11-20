import { describe, expect, test } from "bun:test";
import { demoCues, sceneEdgeDemo } from "./demo";
import { EASES, clamp, kf, prog } from "./ease";
import type { SceneCue } from "./input";
import { type Piece, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { pathBounds } from "./shapes";
import { fakeMeasure, sceneInput } from "./test-support";
import { VELOCITY_DEMO, velocityProgram } from "./templates/velocity";

const { cues } = demoCues(VELOCITY_DEMO);
const input = (list: readonly SceneCue[] = cues, canvas = { width: 1080, height: 1920 }) => sceneInput(list, { canvas, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } });
const scene = velocityProgram.build(input());
const find = (id: string, pieces: readonly Piece[] = scene.pieces) => pieces.find((piece) => piece.id === id);
const text = (cue: number, word: number) => find(`velocity:${cue}:w${word}`) as TextPiece;
const shape = (cue: number, name: string) => find(`velocity:${cue}:${name}`) as ShapePiece;

// The sample's own numbers and formulas, written again from `54-velocity.js` (u = 1).
const S = 96;
const CAP = 0.859375;
const EXIT = 130;
const deg = (slope: number) => (Math.atan(slope) * 180) / Math.PI;
const rateOf = (cue: SceneCue) => cue.words.length / ((cue.words[cue.words.length - 1]!.endMs - cue.startMs) / 1000 + 0.15);
const leanOf = (cue: SceneCue) => clamp(-0.1 - 0.05 * (rateOf(cue) - 2.5), -0.32, -0.08);
const linesOf = (cue: SceneCue) => (rateOf(cue) < 2.5 ? 0 : rateOf(cue) < 3.5 ? 2 : 4);
const fadeOf = (t: number, end: number) => 1 - EASES.in(prog(t, end - EXIT - 20, EXIT - 30));

describe("Velocity", () => {
  test("a piece per word, a slab (plate, shadow, letters) only with a hero, and speed lines by speech rate: none, two, four", () => {
    expect(cues.map(rateOf).map((rate) => Math.round(rate * 100) / 100)).toEqual([1.64, 4.17, 2.88, 3.61]);
    for (const cue of cues) {
      const heroes = cue.words.filter((word) => word.role === "hero").length;
      const wordPieces = scene.pieces.filter((piece) => new RegExp(`^velocity:${cue.index}:w\\d+$`).test(piece.id));
      // The hero's letters are drawn on the slab: they are the `hero` piece, not a `w` piece.
      expect(wordPieces).toHaveLength(cue.words.length - heroes);
      expect(scene.pieces.filter((piece) => piece.id.startsWith(`velocity:${cue.index}:`) && /:(slab|slabshadow|hero)$/.test(piece.id))).toHaveLength(heroes * 3);
      expect(scene.pieces.filter((piece) => new RegExp(`^velocity:${cue.index}:line\\d$`).test(piece.id))).toHaveLength(linesOf(cue));
    }
    // Two lines are the second and fourth.
    expect(scene.pieces.filter((piece) => piece.id.startsWith("velocity:2:line")).map((piece) => piece.id)).toEqual(["velocity:2:line1", "velocity:2:line3"]);
  });

  test("support words are 96 px Anton caps (a no-hero cue 115), the hero 178; letters, slab and ink come from the preset colours", () => {
    const colours = { primary: "#EEEEEE", highlight: "#FF4D1A", accent: "#0B0B0B", shadow: "#000000" };
    const coloured = velocityProgram.build(sceneInput(cues, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, colours }));
    const pick = (id: string) => coloured.pieces.find((piece) => piece.id === id)!;
    expect(pick("velocity:0:w0")).toMatchObject({ face: "Anton", sizePx: 96, letterSpacingEm: 0.01, fill: "#EEEEEE", text: "NOBODY'S" });
    expect(pick("velocity:0:hero")).toMatchObject({ face: "Anton", sizePx: 178, letterSpacingEm: 0.01, fill: "#0B0B0B", text: "YOU" });
    expect(pick("velocity:0:slab")).toMatchObject({ fill: { colour: "#FF4D1A" } });
    expect(pick("velocity:0:slabshadow")).toMatchObject({ fill: { colour: "#000000", alpha: 0.45 } });
    // A cue with no hero: 1.2 x the body size.
    const plain = velocityProgram.build(input(sceneEdgeDemo("no-hero").cues));
    expect((plain.pieces.find((piece) => piece.id === "velocity:0:w0") as TextPiece).sizePx).toBe(115);
  });

  test("a word's shadows are the sample's: a hard 0.05 em offset, and a soft glow of 42 % (0.22 em across, not the sample's 0.3: see the template)", () => {
    const shadows = text(0, 0).shadows!;
    expect(shadows[0]!.dx).toBeCloseTo(4.8, 6);
    expect(shadows[0]!.dy).toBeCloseTo(4.8, 6);
    expect(shadows[0]).toMatchObject({ blur: 0, alpha: 1 });
    expect(shadows[1]).toMatchObject({ dx: 0, dy: 0, blur: 10.5, alpha: 0.42 });
  });

  test("the slab is the hero's cap height plus 0.36 body sizes tall, its width plus half a body size wide, 19.2 px from the rows", () => {
    const hero = find("velocity:0:hero") as TextPiece;
    const plate = shape(0, "slab");
    const b = pathBounds(plate.path);
    const heroBox = [...hero.text].length * (0.55 + 0.01) * 178; // fakeMeasure: advance + trailing spacing
    expect(b.x2 - b.x1).toBeCloseTo(heroBox + 48, 3);
    expect(b.y2 - b.y1).toBeCloseTo(CAP * 178 + 0.36 * S, 3);
    // Rest pose: plate centred on the anchor's x; the shadow sits 0.12 body sizes down and right.
    const rest = evaluatePiece(plate, 3000);
    const shadow = evaluatePiece(shape(0, "slabshadow"), 3000);
    expect(rest.x).toBeCloseTo(540, 3);
    expect(shadow.x - rest.x).toBeCloseTo(0.12 * S, 3);
    expect(shadow.y - rest.y).toBeCloseTo(0.12 * S, 3);
    // The last support row's cap bottom sits 0.2 body sizes above the slab; rows are one cap tall, 0.26 em apart.
    const row2 = text(0, 2);
    const row1 = text(0, 0);
    const pose2 = evaluatePiece(row2, 3000);
    const pose1 = evaluatePiece(row1, 3000);
    expect(pose2.y - pose1.y).toBeCloseTo(CAP * S + 0.26 * S, 3);
    expect(rest.y - (b.y2 - b.y1) / 2 - (pose2.y + (CAP * S) / 2)).toBeCloseTo(0.2 * S, 3);
  });

  test("the block is centred on the anchor line (y 1290): rows and slab, top of the first cap to the bottom of the slab", () => {
    const first = evaluatePiece(text(0, 0), 3000);
    const slab = shape(0, "slab");
    const slabPose = evaluatePiece(slab, 3000);
    const b = pathBounds(slab.path);
    const top = first.y - (CAP * S) / 2;
    const bottom = slabPose.y + (b.y2 - b.y1) / 2;
    expect((top + bottom) / 2).toBeCloseTo(1290, 3);
  });

  test("a word skids in from 0.6 body sizes left, with the lean settling from 0.25 more; it fades in over 45 ms from 50 ms early", () => {
    for (const [cue, word] of [[0, 1], [1, 0], [3, 1]] as const) {
      const c = cues[cue]!;
      const piece = text(cue, word);
      const t0 = c.words[word]!.startMs - 50;
      const rest = evaluatePiece(piece, t0 + 400);
      const k = leanOf(c);
      for (const dt of [1, 20, 60, 100, 150, 200]) {
        const t = t0 + dt;
        const pose = evaluatePiece(piece, t);
        expect(pose.x - rest.x).toBeCloseTo(-(1 - EASES.out(prog(t, t0, 150))) * 0.6 * S, 1);
        expect(pose.skx).toBeCloseTo(deg(k - 0.25 * (1 - EASES.out(prog(t, t0, 200)))), 1);
        expect(pose.o).toBeCloseTo(prog(t, t0, 45) * fadeOf(t, c.endMs), 2);
      }
      expect(evaluatePiece(piece, t0 + 400).skx).toBeCloseTo(deg(k), 3);
    }
  });

  test("the lean is the speech rate's: a calm cue barely tilts, a rant leans harder; the gap grows with it", () => {
    const calm = leanOf(cues[0]!);
    const rant = leanOf(cues[1]!);
    expect(calm).toBeCloseTo(-0.08, 6);
    expect(rant).toBeCloseTo(-0.1 - 0.05 * (rateOf(cues[1]!) - 2.5), 6);
    expect(rant).toBeLessThan(calm);
    const rest = (cue: number, word: number) => evaluatePiece(text(cue, word), cues[cue]!.endMs - 400);
    expect(rest(0, 0).skx).toBeCloseTo(deg(calm), 3);
    expect(rest(1, 0).skx).toBeCloseTo(deg(rant), 3);
    // Words of a row are 0.22 em + 0.6 x |k| x cap apart (fakeMeasure: 0.56 em per character incl. spacing).
    const a = text(1, 0);
    const b = text(1, 1);
    const boxA = [...a.text].length * 0.56 * S;
    const gap = evaluatePiece(b, 4100).x - evaluatePiece(a, 4100).x - boxA / 2 - ([...b.text].length * 0.56 * S) / 2;
    expect(gap).toBeCloseTo(S * 0.22 + Math.abs(rant) * CAP * S * 0.6, 3);
  });

  test("the slab slices in left to right over 120 ms from 80 ms early, and leaves to the right: the clip's edges", () => {
    for (const cue of [0, 1, 3]) {
      const c = cues[cue]!;
      const ws = c.words.find((word) => word.role === "hero")!.startMs;
      const plate = shape(cue, "slab");
      const b = pathBounds(plate.path);
      const slabW = b.x2 - b.x1;
      const slabH = b.y2 - b.y1;
      const pad = 0.17 * slabH;
      const off = 0.12 * S;
      const left = 540 - slabW / 2 - pad;
      const width = slabW + 2 * pad + off;
      const end = c.endMs;
      for (const t of [ws - 80, ws - 40, ws, ws + 40, ws + 300, end - 130, end - 100, end - 60, end - 10]) {
        const pose = evaluatePiece(plate, t);
        const enter = prog(t, ws - 80, 120);
        const gone = EASES.in(prog(t, end - EXIT, EXIT - 10));
        expect(pose.clip!.x1).toBeCloseTo(left + gone * width, 1);
        expect(pose.clip!.x2).toBeCloseTo(left + width - (1 - enter) * width, 1);
      }
      // Fully gone by the end of the cue, fully shown between.
      const last = evaluatePiece(plate, end - 10);
      expect(last.clip!.x1).toBeCloseTo(last.clip!.x2, 1);
    }
  });

  test("the plate's shear settles from k - 0.08 to k between 30 and 150 ms; the whole slab rocks 1.2 / -0.8 degrees from 80 ms", () => {
    for (const cue of [0, 1]) {
      const c = cues[cue]!;
      const ws = c.words.find((word) => word.role === "hero")!.startMs;
      const k = leanOf(c);
      for (const piece of [shape(cue, "slab"), shape(cue, "slabshadow")]) {
        for (const t of [ws - 80, ws, ws + 30, ws + 70, ws + 100, ws + 150, ws + 400]) {
          expect(evaluatePiece(piece, t).skx).toBeCloseTo(deg(kf(t, [[ws + 30, k - 0.08], [ws + 150, k, "out"]])), 1);
        }
      }
      const rock = (t: number) => kf(t, [[ws + 80, 0], [ws + 120, 1.2, "out"], [ws + 165, -0.8, "inOut"], [ws + 210, 0, "inOut"]]);
      for (const piece of [shape(cue, "slab"), shape(cue, "slabshadow"), find(`velocity:${cue}:hero`)!]) {
        for (const t of [ws, ws + 80, ws + 100, ws + 120, ws + 140, ws + 165, ws + 190, ws + 210, ws + 300]) expect(evaluatePiece(piece, t).rz).toBeCloseTo(rock(t), 6);
      }
    }
  });

  test("the hero's letters arrive stretched: 1.25 wide settling over 170 ms, 0.8 body sizes left sliding over 130 ms, from 60 ms early", () => {
    const c = cues[0]!;
    const ws = c.words[4]!.startMs;
    const hero = find("velocity:0:hero") as TextPiece;
    const rest = evaluatePiece(hero, ws + 400);
    expect(rest.x).toBeCloseTo(540, 3);
    const k = leanOf(c);
    for (const dt of [0, 20, 40, 70, 130, 170]) {
      const t = ws - 60 + dt;
      const pose = evaluatePiece(hero, t);
      expect(pose.x - rest.x).toBeCloseTo(-(1 - EASES.out(prog(t, ws - 60, 130))) * 0.8 * S, 2);
      expect(pose.sx).toBeCloseTo(1.25 + (1 - 1.25) * EASES.out(prog(t, ws - 60, 170)), 4);
      expect(pose.o).toBeCloseTo(prog(t, ws - 60, 40), 4);
      expect(pose.skx).toBeCloseTo(deg(k), 4);
    }
  });

  test("speed lines: 5 px streaks trailing the slab's slanted edge; each flies 1.1 body sizes, widening from 0.55, 28 ms after the one before", () => {
    const c = cues[1]!;
    const ws = c.words[4]!.startMs;
    const k = leanOf(c);
    const plate = shape(1, "slab");
    const b = pathBounds(plate.path);
    const slabH = b.y2 - b.y1;
    const slabLeft = 540 - (b.x2 - b.x1) / 2;
    const top = evaluatePiece(plate, ws + 400).y - slabH / 2;
    const FRACS = [0.2, 0.4, 0.6, 0.8];
    const LENS = [1.2, 2.0, 1.5, 2.4];
    [0, 1, 2, 3].forEach((j, n) => {
      const line = shape(1, `line${j}`);
      const lb = pathBounds(line.path);
      expect(lb.x2 - lb.x1).toBeCloseTo(LENS[j]! * S, 3);
      expect(lb.y2 - lb.y1).toBeCloseTo(5, 3);
      const t0 = ws - 20 + n * 28;
      expect(line.fromMs).toBe(t0);
      const restX = slabLeft + k * (FRACS[j]! - 0.5) * slabH - 14 + 0.35 * S;
      expect(evaluatePiece(line, t0).x).toBeCloseTo(restX, 2);
      expect(evaluatePiece(line, t0).y).toBeCloseTo(top + FRACS[j]! * slabH + 2.5, 2);
      for (const dt of [0, 30, 70, 140, 200, 300, 339]) {
        const t = t0 + dt;
        const pose = evaluatePiece(line, t);
        expect(pose.x).toBeCloseTo(restX - EASES.out(prog(t, t0, 340)) * 1.1 * S, 2);
        expect(pose.sx).toBeCloseTo(0.55 + 0.45 * EASES.out(prog(t, t0, 140)), 3);
        const a = kf(t, [[t0, 0], [t0 + 50, 1], [t0 + 160, 1], [t0 + 340, 0, "in"]]) * fadeOf(t, c.endMs);
        expect(Math.abs(pose.o - a)).toBeLessThan(0.012);
      }
    });
  });

  test("the cue leaves: words fade over 100 ms from 150 ms before the end, the slab is cut away by its end; nothing is drawn after", () => {
    for (const cue of cues) {
      const end = cue.endMs;
      for (const piece of scene.pieces.filter((p) => p.id.startsWith(`velocity:${cue.index}:`))) expect(piece.toMs).toBeLessThanOrEqual(end);
      for (const word of cue.words.filter((w) => w.role !== "hero")) {
        const piece = text(cue.index, cue.words.indexOf(word));
        expect(evaluatePiece(piece, end - 151).o).toBeCloseTo(1, 3);
        expect(evaluatePiece(piece, end - 100).o).toBeCloseTo(fadeOf(end - 100, end), 3);
        expect(piece.toMs).toBeLessThanOrEqual(end - 50);
      }
    }
  });

  test("later cues paint over earlier ones, and the lines sit behind their own cue's words", () => {
    const zOf = (id: string) => find(id)!.z;
    expect(zOf("velocity:1:w0")).toBeGreaterThan(zOf("velocity:0:hero"));
    expect(zOf("velocity:1:line0")).toBeLessThan(zOf("velocity:1:w0"));
    expect(zOf("velocity:1:line0")).toBeLessThan(zOf("velocity:1:slab"));
    expect(zOf("velocity:0:slab")).toBeGreaterThan(zOf("velocity:0:slabshadow"));
    expect(zOf("velocity:0:hero")).toBeGreaterThan(zOf("velocity:0:slab"));
  });

  test("a right-to-left cue mirrors the template: rows read from the right, skid, shear and wipe come from the right", () => {
    const urdu = sceneEdgeDemo("urdu").cues;
    const built = velocityProgram.build(input(urdu));
    const first = built.pieces.find((piece) => piece.id === "velocity:0:w0") as TextPiece;
    const second = built.pieces.find((piece) => piece.id === "velocity:0:w1") as TextPiece;
    const t0 = urdu[0]!.words[0]!.startMs - 50;
    // The first word read is the one on the right.
    expect(evaluatePiece(first, t0 + 400).x).toBeGreaterThan(evaluatePiece(second, t0 + 400).x);
    // It skids in from the right with the shear mirrored.
    expect(evaluatePiece(first, t0 + 10).x).toBeGreaterThan(evaluatePiece(first, t0 + 400).x);
    expect(evaluatePiece(first, t0 + 400).skx).toBeGreaterThan(0);
    const plate = built.pieces.find((piece) => piece.id === "velocity:0:slab") as ShapePiece;
    const ws = urdu[0]!.words[2]!.startMs;
    const mid = evaluatePiece(plate, ws - 20).clip!;
    const done = evaluatePiece(plate, ws + 100).clip!;
    // The wipe grows from the right edge: x2 stays at the clip's right edge while x1 comes in from the left.
    expect(mid.x2).toBeCloseTo(done.x2, 3);
    expect(mid.x1).toBeGreaterThan(done.x1);
  });

  test("a hero wider than the screen shrinks to fit (the slab and its clip stay inside the safe area), and a word wider than a row shrinks its row", () => {
    for (const kind of ["long-word", "one-word", "nine-words"] as const) {
      const demo = sceneEdgeDemo(kind).cues;
      const built = velocityProgram.build(input(demo));
      for (let t = 0; t < 6000; t += 25) {
        const box = sceneBoundsAt(built.pieces, t, fakeMeasure);
        if (!box) continue;
        expect(box.x1).toBeGreaterThanOrEqual(53);
        expect(box.x2).toBeLessThanOrEqual(1080 - 53);
      }
    }
    const wide: SceneCue[] = [
      { index: 0, startMs: 0, endMs: 1500, speaker: null, language: null, words: [{ text: "pneumonoultramicroscopicsilicovolcanoconiosis", startMs: 100, endMs: 900, role: "hero", key: null }] },
    ];
    const hero = velocityProgram.build(input(wide)).pieces.find((piece) => piece.id === "velocity:0:hero") as TextPiece;
    expect(hero.sizePx).toBeLessThan(178);
  });

  test("a hero that starts within 170 ms of the cue's end still gives a clip that never inverts", () => {
    const tight: SceneCue[] = [
      { index: 0, startMs: 0, endMs: 700, speaker: null, language: null, words: [{ text: "so", startMs: 0, endMs: 100, role: "body", key: null }, { text: "go", startMs: 600, endMs: 690, role: "hero", key: null }] },
    ];
    const plate = velocityProgram.build(input(tight)).pieces.find((piece) => piece.id === "velocity:0:slab") as ShapePiece;
    for (let t = plate.fromMs; t < plate.toMs; t += 5) {
      const clip = evaluatePiece(plate, t).clip!;
      expect(clip.x2).toBeGreaterThanOrEqual(clip.x1 - 1e-6);
    }
  });
});
