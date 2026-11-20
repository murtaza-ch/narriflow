import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import { EASES, kf, lerp, prog } from "./ease";
import { type Measure, type ShapePiece, type TextPiece, evaluatePiece, sceneBoundsAt } from "./scene";
import { DOSSIER_DEMO, dossierEdges, dossierNudge, dossierProgram, dossierTear, dossierTilt } from "./templates/dossier";
import { sceneInput } from "./test-support";

/** Courier Prime: 0.5996 em per character, ink 0.58 em tall from 0.708 em above the baseline. */
const courier: Measure = (text, _face, sizePx, letterSpacingEm) => ({
  advance: [...text].length * (0.5996 + letterSpacingEm) * sizePx - letterSpacingEm * sizePx,
  inkTop: -0.58 * sizePx,
  inkBottom: 0.0 * sizePx,
  ascent: 1.1 * sizePx,
  descent: 0.3 * sizePx,
});

const { cues } = demoCues(DOSSIER_DEMO);
const colours = { primary: "#111111", highlight: "#D7263D", accent: "#F4EFE6", shadow: "#000000" };
const build = (list = cues, overrides = {}) => dossierProgram.build(sceneInput(list, { measure: courier, colours, ...overrides })).pieces;
const scene = build();
const texts = scene.filter((piece): piece is TextPiece => piece.kind === "text");
const shapes = scene.filter((piece): piece is ShapePiece => piece.kind === "shape");
const papers = shapes.filter((piece) => /:r\d+$/.test(piece.id));
const bars = shapes.filter((piece) => /:b\d+$/.test(piece.id));
const stamps = shapes.filter((piece) => /:s\d+$/.test(piece.id));
const cueOf = (piece: { id: string }) => cues[Number(piece.id.split(":")[1])]!;
const wordOf = (piece: { id: string }) => cueOf(piece).words[Number(piece.id.split(":")[2]!.slice(1))]!;
const textFor = (cue: number, word: number, suffix = "") => texts.find((piece) => piece.id === `dossier:${cue}:t${word}${suffix}`)!;
const barFor = (cue: number, word: number) => bars.find((piece) => piece.id === `dossier:${cue}:b${word}`)!;

describe("Dossier", () => {
  test("a strip per row, a bar per word, a stamp and a second ink only for the hero", () => {
    expect(papers.map((piece) => piece.id)).toEqual(["dossier:0:r0", "dossier:0:r1", "dossier:1:r0", "dossier:2:r0", "dossier:2:r1", "dossier:3:r0"]);
    expect(bars).toHaveLength(cues.reduce((sum, cue) => sum + cue.words.length, 0));
    expect(stamps.map((piece) => piece.id)).toEqual(["dossier:2:s3"]);
    expect(texts.filter((piece) => piece.id.endsWith("h")).map((piece) => piece.id)).toEqual(["dossier:2:t3h"]);
  });

  test("words sit where the sample's flex rows put them (probe of 51-dossier.js at u = 1)", () => {
    const at = (cue: number, word: number) => evaluatePiece(textFor(cue, word), cues[cue]!.startMs);
    // Anchor of a word = pivot minus the piece's origin; the strips are tilted, so read the rest layout.
    const rest = (cue: number, word: number) => {
      const piece = textFor(cue, word);
      return { x: at(cue, word).x - piece.origin!.dx, y: at(cue, word).y - piece.origin!.dy };
    };
    // Row 1 of cue 0: x 109, 241.42, 373.84 and baseline 1262; row 2: x 131, 397.25, 529.67 and baseline 1368.
    for (const [word, x] of [[0, 109], [1, 241.42], [2, 373.84]] as const) {
      expect(Math.abs(rest(0, word).x - x)).toBeLessThan(0.6);
      expect(Math.abs(rest(0, word).y - 1262)).toBeLessThan(0.6);
    }
    for (const [word, x] of [[3, 131], [4, 397.25], [5, 529.67]] as const) {
      expect(Math.abs(rest(0, word).x - x)).toBeLessThan(0.6);
      expect(Math.abs(rest(0, word).y - 1368)).toBeLessThan(0.6);
    }
    // A one-row cue is centred on the anchor line: baseline 1315 for "shuts the door".
    expect(Math.abs(rest(1, 0).y - 1315)).toBeLessThan(0.6);
    expect(Math.abs(rest(1, 0).x - 109)).toBeLessThan(0.6);
  });

  test("the words are typed in upper case Courier Prime Bold 72 px with 0.02 em tracking", () => {
    expect(textFor(0, 0)).toMatchObject({ text: "SO", face: "Courier Prime", sizePx: 72, letterSpacingEm: 0.02, fill: "#111111" });
    expect(textFor(2, 2).text).toBe("YOU'RE");
  });

  test("a strip is the paper colour, 94 px tall, with the sample's two box shadows, tilted by the sample's angles", () => {
    const paper = papers[0]!;
    expect(paper.fill).toEqual({ colour: "#F4EFE6", alpha: 1 });
    expect(paper.shadows).toEqual([
      { dx: 0, dy: 10, blur: 11, colour: "#281C0A", alpha: 0.3 },
      { dx: 0, dy: 2, blur: 2, colour: "#281C0A", alpha: 0.3 },
    ]);
    expect(evaluatePiece(paper, 1000).rz).toBeCloseTo(-1.0, 6);
    expect(evaluatePiece(papers[1]!, 1000).rz).toBeCloseTo(0.6, 6);
    expect(evaluatePiece(papers[2]!, 3000).rz).toBeCloseTo(0.7, 6);
    expect(dossierTilt(5, 1)).toBe(0.6 * 0 + -0.5);
    // Rows are 94 px tall: the second strip's pivot is 94 + 12 below the first's.
    const a = evaluatePiece(papers[0]!, 1000).y;
    const b = evaluatePiece(papers[1]!, 1000).y;
    expect(b - a).toBeCloseTo(106, 6);
  });

  test("the strips roll in over 200 ms and out over 160 ms behind one shared vertical edge, as the sample's inset() does", () => {
    const cue = cues[0]!;
    const blockLeft = 92;
    const first = papers[0]!;
    // Row 1 of cue 0 is 475.85 px wide at the block's left; the clip's right edge is the entering edge clamped to this strip and
    // its 70 px margin, its left edge the leaving edge, both from the block's left.
    const width = 475.85;
    const widthOf = (strip: ShapePiece) => Math.max(...strip.path.flatMap((command) => (command[0] === "Z" ? [] : [command[1] as number])));
    // The shared edge runs over the widest strip's far end: row 2 (indent 22) is the cue's widest.
    const reach = Math.max(...papers.slice(0, 2).map((strip) => evaluatePiece(strip, 1000).x - blockLeft + widthOf(strip)));
    const piece = textFor(0, 0);
    const clamp = (value: number) => Math.min(Math.max(value, -70), width + 70);
    for (const t of [cue.startMs - 140, cue.startMs - 100, cue.startMs - 40, cue.startMs + 20, cue.startMs + 60, 1000, cue.endMs - 160, cue.endMs - 120, cue.endMs - 60, cue.endMs - 1]) {
      const clip = evaluatePiece(piece, t).clip!;
      const { enter, exit } = dossierEdges(t, cue.startMs, cue.endMs, reach, 70);
      expect(Math.abs(clip.x2 - (blockLeft + Math.max(clamp(enter), clamp(exit)))) < 1.2).toBe(true);
      expect(Math.abs(clip.x1 - (blockLeft + Math.min(clamp(exit), clamp(enter)))) < 1.2).toBe(true);
    }
    // Before the roll starts nothing shows, once it is done the strip is whole, and at the end it is gone again.
    expect(evaluatePiece(piece, cue.startMs - 140).clip!.x2).toBeLessThanOrEqual(blockLeft - 70 + 1);
    const rest = evaluatePiece(piece, 1000).clip!;
    expect(rest.x1).toBeLessThan(blockLeft);
    expect(rest.x2).toBeGreaterThan(blockLeft + width);
    expect(evaluatePiece(piece, cue.endMs - 1).clip!.x1).toBeGreaterThan(blockLeft + width - 5);
    // The second strip of the cue shares the edge: it is the same canvas rectangle in x.
    expect(evaluatePiece(papers[1]!, cue.startMs - 40).clip!.x2).toBeLessThanOrEqual(evaluatePiece(first, cue.startMs - 40).clip!.x2 + 1);
  });

  test("each bar is wiped from its left edge exactly as the sample's tear: 120 ms from 70 ms before the word", () => {
    for (const bar of bars) {
      const word = wordOf(bar);
      const pose = (t: number) => evaluatePiece(bar, t);
      // The bar is whole before the tear starts, and its clip edge follows prog(t, ws - 70, 120) across the bar.
      const whole = pose(word.startMs - 70).clip!;
      const gone = pose(word.startMs + 49).clip!;
      const barWidth = (courier(word.text.toUpperCase(), "Courier Prime", 72, 0.02).advance + 0.02 * 72 + 6) | 0;
      for (const t of [word.startMs - 40, word.startMs, word.startMs + 30]) {
        const clip = pose(t).clip!;
        const tear = dossierTear(t, word.startMs);
        // Distance wiped from the bar's left edge, in the bar's own width (it is tilted by under 1 degree).
        const wiped = clip.x1 - whole.x1;
        expect(Math.abs(wiped - tear * barWidth)).toBeLessThan(2.5);
      }
      expect(gone.x1 - whole.x1).toBeGreaterThan(barWidth * 0.97 - 2.5);
      // After the tear the bar is gone (the sample sets `display: none`).
      expect(bar.toMs).toBe(word.startMs + 50);
    }
  });

  test("a bar is 3 px wider than its word each side, 0.78 em tall, and tilted by the sample's jitter", () => {
    const bar = barFor(0, 2);
    const pose = evaluatePiece(bar, 1000);
    const strip = evaluatePiece(papers[0]!, 1000).rz;
    const jitter = ((Math.sin(2 * 127.1 + 311.7) * 43758.5453) % 1 + 1) % 1;
    expect(pose.rz - strip).toBeCloseTo((jitter - 0.5) * 1.2, 4);
    expect(bar.fill).toEqual({ colour: "#0D0D0D", alpha: 1 });
    const xs = bar.path.flatMap((command) => (command[0] === "Z" ? [] : [command[1] as number]));
    const ys = bar.path.flatMap((command) => (command[0] === "Z" ? [] : [command[2] as number]));
    const wordWidth = courier("BOSS", "Courier Prime", 72, 0.02).advance + 0.02 * 72 - 0.02 * 72 + 0.02 * 72;
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(wordWidth + 6, 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(0.78 * 72, 6);
  });

  test("a pause of 600 ms or more before a word makes its bar blink twice; other bars never do", () => {
    const fired = barFor(2, 3);
    const gapStart = 4457;
    const sample = (t: number) => {
      const g = gapStart + 120;
      return Math.min(kf(t, [[g, 1], [g + 60, 0.3], [g + 240, 0.3], [g + 300, 1]]), kf(t, [[g + 420, 1], [g + 480, 0.3], [g + 660, 0.3], [g + 720, 1]]));
    };
    for (const t of [4500, 4577, 4607, 4637, 4700, 4817, 4850, 4877, 4950, 5010, 5057, 5100, 5237, 5290, 5300]) {
      expect(Math.abs(evaluatePiece(fired, t).o - sample(t))).toBeLessThan(0.001);
    }
    expect(evaluatePiece(fired, 4700).o).toBeCloseTo(0.3, 6);
    expect(evaluatePiece(fired, 5150).o).toBeCloseTo(0.3, 6);
    expect(evaluatePiece(fired, 4950).o).toBe(1);
    for (const bar of bars) if (bar !== fired) expect(bar.track.o).toBeUndefined();
  });

  test("a word shows from the moment its bar starts to go; a body word keeps the ink colour", () => {
    const boss = textFor(0, 2);
    const word = cues[0]!.words[2]!;
    expect(boss.fromMs).toBe(word.startMs - 70);
    expect(boss.toMs).toBe(cues[0]!.endMs);
    expect(boss.fill).toBe("#111111");
  });

  test("the stamp lands 90 ms after the hero is spoken: 1.6x down to 0.94x then 1x, -10 to -4 degrees, 0.94 opaque", () => {
    const stamp = stamps[0]!;
    const hero = cues[2]!.words[3]!;
    const s0 = hero.startMs + 90;
    const tilt = dossierTilt(2, 1);
    const pose = (t: number) => evaluatePiece(stamp, t);
    expect(stamp.fromMs).toBe(s0);
    expect(pose(s0 - 1).visible).toBe(false);
    expect(pose(s0).sx).toBeCloseTo(1.6, 6);
    expect(pose(s0).o).toBe(0);
    expect(pose(s0 + 40).o).toBeCloseTo(0.94, 6);
    expect(pose(s0 + 90).sx).toBeCloseTo(0.94, 6);
    expect(pose(s0 + 160).sx).toBeCloseTo(1, 6);
    expect(pose(s0 + 45).sx).toBeCloseTo(lerp(1.6, 0.94, EASES.in(prog(s0 + 45, s0, 90))), 3);
    expect(pose(s0 + 125).sx).toBeCloseTo(lerp(0.94, 1, EASES.out(prog(s0 + 125, s0 + 90, 70))), 3);
    for (const t of [s0, s0 + 30, s0 + 60, s0 + 100, s0 + 160, s0 + 220, s0 + 400]) {
      const expected = tilt + dossierNudge(t, hero.startMs) + lerp(-10, -4, EASES.out(prog(t, s0, 160)));
      expect(Math.abs(pose(t).rz - expected)).toBeLessThan(0.06);
    }
    expect(pose(s0 + 160).rz).toBeCloseTo(tilt - 4 + dossierNudge(s0 + 160, hero.startMs), 1);
    expect(stamp.fill).toEqual({ colour: "#D7263D", alpha: 1 });
  });

  test("the hero's ink turns the highlight colour when the stamp lands, and the stamp's strip is nudged once", () => {
    const hero = cues[2]!.words[3]!;
    const s0 = hero.startMs + 90;
    const ink = textFor(2, 3);
    const lit = textFor(2, 3, "h");
    expect(ink.toMs).toBe(s0);
    expect(lit.fromMs).toBe(s0);
    expect(lit.fill).toBe("#D7263D");
    const strip = papers.find((piece) => piece.id === "dossier:2:r1")!;
    const tilt = dossierTilt(2, 1);
    for (const t of [s0, s0 + 60, s0 + 80, s0 + 100, s0 + 150, s0 + 260, s0 + 500]) {
      expect(Math.abs(evaluatePiece(strip, t).rz - (tilt + dossierNudge(t, hero.startMs)))).toBeLessThan(1e-6);
    }
    expect(evaluatePiece(strip, s0 + 100).rz - tilt).toBeCloseTo(0.7, 6);
    // The other strip of the cue is not nudged.
    expect(papers.find((piece) => piece.id === "dossier:2:r0")!.track.rz).toHaveLength(1);
  });

  test("the stamp stays on its word through the nudge: its pivot follows the strip's tilt about the strip's pivot", () => {
    const stamp = stamps[0]!;
    const strip = papers.find((piece) => piece.id === "dossier:2:r1")!;
    const hero = cues[2]!.words[3]!;
    const s0 = hero.startMs + 90;
    const rest = evaluatePiece(stamp, s0 + 400);
    const pivot = evaluatePiece(strip, s0 + 400);
    const peak = evaluatePiece(stamp, s0 + 100);
    const peakPivot = evaluatePiece(strip, s0 + 100);
    // Rotating the offset (stamp - pivot) by the nudge's 0.7 degrees moves the stamp by the same amount here.
    const dx = rest.x - pivot.x;
    const dy = rest.y - pivot.y;
    const a = (0.7 * Math.PI) / 180;
    expect(peak.x - peakPivot.x).toBeCloseTo(dx * Math.cos(a) - dy * Math.sin(a), 0);
    expect(peak.y - peakPivot.y).toBeCloseTo(dx * Math.sin(a) + dy * Math.cos(a), 0);
  });

  test("a cue with no hero draws no stamp and no second ink", () => {
    const plain = demoCues({ lines: ["so:m this:b is:m plain:b"], options: DOSSIER_DEMO.options }).cues;
    const pieces = build(plain);
    expect(pieces.some((piece) => piece.kind === "shape" && piece.id.includes(":s"))).toBe(false);
    expect(pieces.some((piece) => piece.id.endsWith("h"))).toBe(false);
  });

  test("a cue that does not fit wraps in two even strips, the second 22 px to the right", () => {
    const long = demoCues({ lines: ["and:b then:b we:b all:b went:b home:b together:b happily:b"], options: DOSSIER_DEMO.options }).cues;
    const pieces = build(long);
    const strips = pieces.filter((piece): piece is ShapePiece => piece.kind === "shape" && /:r\d+$/.test(piece.id));
    expect(strips.length).toBeGreaterThanOrEqual(2);
    const widths = strips.map((piece) => Math.max(...piece.path.flatMap((c) => (c[0] === "Z" ? [] : [c[1] as number]))));
    for (const width of widths) expect(width).toBeLessThanOrEqual(880 + 0.01);
    const left = (piece: ShapePiece) => evaluatePiece(piece, 1000).x - piece.origin!.dx;
    expect(left(strips[1]!) - left(strips[0]!)).toBeCloseTo(22, 4);
  });

  test("a word wider than a strip shrinks the cue to fit, and nothing leaves the safe area", () => {
    const wide = demoCues({ lines: ["so:m antidisestablishmentarianism:b@900 and:m more:b"], options: DOSSIER_DEMO.options }).cues;
    const pieces = build(wide);
    const sizes = new Set(pieces.filter((piece): piece is TextPiece => piece.kind === "text").map((piece) => piece.sizePx));
    expect(Math.max(...sizes)).toBeLessThan(72);
    for (let t = wide[0]!.startMs - 140; t < wide[0]!.endMs; t += 40) {
      const box = sceneBoundsAt(pieces, t, courier);
      if (!box) continue;
      expect(box.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
      expect(box.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
    }
  });

  test("a right-to-left cue is right-aligned and its bars tear from the right", () => {
    const urdu = demoCues({ lines: ["یہ:b ایک:b سادہ:b جملہ:h"], options: DOSSIER_DEMO.options, language: "ur" }).cues;
    const pieces = build(urdu);
    const strip = pieces.find((piece): piece is ShapePiece => piece.kind === "shape" && /:r0$/.test(piece.id))!;
    const right = evaluatePiece(strip, 1000).x - strip.origin!.dx + Math.max(...strip.path.flatMap((c) => (c[0] === "Z" ? [] : [c[1] as number])));
    expect(right).toBeCloseTo(988, 0);
    const bar = pieces.find((piece) => piece.kind === "shape" && /:b0$/.test(piece.id))!;
    const word = urdu[0]!.words[0]!;
    const early = evaluatePiece(bar, word.startMs - 70).clip!;
    const late = evaluatePiece(bar, word.startMs + 49).clip!;
    // The leading edge of an RTL strip is its right one: the clip's right edge retreats.
    expect(late.x2).toBeLessThan(early.x2 - 20);
  });

  test("the whole demo builds within the sample's own numbers: every piece draws and ends after it starts", () => {
    for (const piece of scene) {
      expect(piece.toMs).toBeGreaterThan(piece.fromMs);
      expect(Number.isFinite(evaluatePiece(piece, piece.fromMs).x)).toBe(true);
    }
  });
});
