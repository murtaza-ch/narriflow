import { describe, expect, test } from "bun:test";
import { CAPTION_DECORATION, CAPTION_SHAPES, captionShapeAssDrawing, captionShapeSvgPath } from "./caption-decoration";
import { CAPTION_DYNAMIC_STYLES, captionHeroGradient, captionStyleUsesAccent } from "./caption-dynamic";
import { captionPresetSchema, getCaptionPresetById } from "./caption-preset";
import { CAPTION_MOTIONS } from "./caption-style";

/** Every coordinate of a serialised path, with its command letter, normalised to the SVG letters. */
function parse(path: string, letters: Record<string, string>): { op: string; points: number[] }[] {
  const commands: { op: string; points: number[] }[] = [];
  for (const token of path.trim().split(/\s+/)) {
    if (token in letters) commands.push({ op: letters[token]!, points: [] });
    else commands[commands.length - 1]!.points.push(Number(token));
  }
  return commands;
}

const SVG = { M: "M", L: "L", C: "C" };
const ASS = { m: "M", l: "L", b: "C" };

describe("decoration shapes", () => {
  for (const [name, shape] of Object.entries(CAPTION_SHAPES)) {
    test(`${name}: the SVG path and the ASS drawing carry identical points`, () => {
      for (const [width, height] of [[1, 1], [312.4, 14.6], [43.25, 41.13], [800, 33]] as const) {
        const svg = parse(captionShapeSvgPath(shape, width, height), SVG);
        const ass = parse(captionShapeAssDrawing(shape, width, height), ASS);
        expect(ass).toEqual(svg);
        expect(svg.length).toBe(shape.commands.length);
        // Nothing but the one path: no close or other commands sneak in.
        expect(captionShapeSvgPath(shape, width, height)).toMatch(/^M [-\d. ]+( (L|C) [-\d. ]+)*$/);
        expect(captionShapeAssDrawing(shape, width, height)).toMatch(/^m [-\d. ]+( (l|b) [-\d. ]+)*$/);
      }
    });

    test(`${name}: M, L and C only; every point, control points included, in the unit box, touching all four edges`, () => {
      expect(shape.commands[0]!.op).toBe("M");
      expect(shape.commands.slice(1).every((command) => command.op === "L" || command.op === "C")).toBe(true);
      const xs = shape.commands.flatMap((command) => (command.op === "C" ? [command.x1, command.x2, command.x] : [command.x]));
      const ys = shape.commands.flatMap((command) => (command.op === "C" ? [command.y1, command.y2, command.y] : [command.y]));
      for (const value of [...xs, ...ys]) {
        expect(value).toBeGreaterThanOrEqual(-1e-9);
        expect(value).toBeLessThanOrEqual(1 + 1e-9);
      }
      expect(Math.min(...xs)).toBeCloseTo(0, 9);
      expect(Math.max(...xs)).toBeCloseTo(1, 9);
      expect(Math.min(...ys)).toBeCloseTo(0, 9);
      expect(Math.max(...ys)).toBeCloseTo(1, 9);
    });
  }

  test("the squiggle is point-symmetric about its box centre, so ink and control box centre alike", () => {
    const points = CAPTION_SHAPES.squiggle.commands.flatMap((command) =>
      command.op === "C" ? [[command.x1, command.y1], [command.x2, command.y2], [command.x, command.y]] : [[command.x, command.y]]);
    const key = (x: number, y: number) => `${x.toFixed(6)},${y.toFixed(6)}`;
    const set = new Set(points.map(([x, y]) => key(x!, y!)));
    for (const [x, y] of points) expect(set.has(key(1 - x!, 1 - y!))).toBe(true);
    // The ribbon is the thickness tall at its ends: 0.04 of a 0.10 em box.
    const first = CAPTION_SHAPES.squiggle.commands[0]!;
    const { thicknessEm, heightEm } = CAPTION_DECORATION.underline;
    expect(first).toEqual({ op: "M", x: 0, y: 0.5 - thicknessEm / heightEm / 2 });
  });

  test("the star is a ten-point polygon, wider than tall like a regular star", () => {
    expect(CAPTION_SHAPES.star.commands).toHaveLength(10);
    expect(CAPTION_SHAPES.star.commands.every((command) => command.op !== "C")).toBe(true);
    expect(CAPTION_SHAPES.star.aspect).toBeCloseTo(1.0515, 3);
  });
});

describe("hero gradient", () => {
  const headline = getCaptionPresetById("headline")!.preset;
  const style = CAPTION_DYNAMIC_STYLES.headline;

  test("Headline's catalog preset draws the gradient", () => {
    expect(captionHeroGradient(headline, style)).toEqual({ top: "#A5EBC5", bottom: "#36B780" });
    // Case of the stored colour does not matter.
    expect(captionHeroGradient({ ...headline, highlightColor: "#36b780" }, style)).not.toBeNull();
  });

  test("a motion that scales or turns the hero falls back to the flat hero colour", () => {
    const scaling = ["slam", "punch", "bounce"] as const;
    const turning = ["drop", "flip"] as const;
    for (const animation of [...scaling, ...turning]) {
      const motion = CAPTION_MOTIONS[animation];
      const frames = [...motion.word, ...("hero" in motion && motion.hero ? motion.hero : [])];
      expect(frames.some((frame) => "scaleX" in frame || "rotateZDeg" in frame || "rotateXDeg" in frame), animation).toBe(true);
      expect(captionHeroGradient(captionPresetSchema.parse({ ...headline, animation }), style), animation).toBeNull();
    }
    // Travel, blur and fade keep it.
    for (const animation of ["slide", "rise", "blur", "fade"] as const) {
      expect(captionHeroGradient(captionPresetSchema.parse({ ...headline, animation }), style), animation).not.toBeNull();
    }
  });

  test("another hero colour wins flat, and styles without a gradient draw none", () => {
    expect(captionHeroGradient({ ...headline, highlightColor: "#FF0000" }, style)).toBeNull();
    for (const id of ["editorial", "marker", "stack", "groove"] as const) {
      expect(captionHeroGradient(getCaptionPresetById(id)!.preset, CAPTION_DYNAMIC_STYLES[id])).toBeNull();
    }
  });
});

describe("decorations in the colour slots", () => {
  test("Stack's stars use the accent slot, so its accent colour control has something to act on", () => {
    expect(captionStyleUsesAccent(CAPTION_DYNAMIC_STYLES.stack)).toBe(true);
    expect(captionStyleUsesAccent(CAPTION_DYNAMIC_STYLES.headline)).toBe(false);
    expect(captionStyleUsesAccent(CAPTION_DYNAMIC_STYLES.groove)).toBe(false);
  });
});
