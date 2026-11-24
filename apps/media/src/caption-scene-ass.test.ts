import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { SCENE_PERSPECTIVE_PX, SHEET_CANVAS, evaluatePiece, exportFrameTimes, primitivesSheet, type Piece } from "@narriflow/caption-scene";
import { CAPTION_SCENE_NAMES, DEFAULT_CAPTION_PRESET } from "@narriflow/validators";
import { ASS_HEADER, inkBounds, renderAssRaw } from "../scripts/caption-scene-probe";
import { sceneDemo } from "../scripts/caption-scene-demo";
import { assScript } from "./caption-ass";
import { assStateAt } from "./caption-scene-ass-eval";
import { SCENE_ASS, SCENE_TOLERANCE, SceneMeasurer, sceneEvents } from "./caption-scene-ass";

/**
 * The Scene Style writer (ADR 0021): at every rendered frame the tags it wrote imply what
 * `evaluatePiece` says, and the constants measured against real libass stay measured.
 */

const FPS = 30;
const hasLibass = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout?.includes(" ass ") ?? false;

test("scene text pins both mixed paragraph directions to the measured direction", () => {
  const measurer = new SceneMeasurer({ notices: new Map(), omitted: new Map() }, new Set(), "ur");
  const rtl = measurer.metrics("45 degrees ہو یا 90 فون", "Inter Tight Bold", 0);
  expect(rtl.direction).toBe("rtl");
  expect(rtl.clusters[0]!.text).toBe("\u200F");
  const ltr = measurer.metrics("پھر verdict first win ہے", "Inter Tight Bold", 0);
  expect(ltr.direction).toBe("ltr");
  expect(ltr.clusters[0]!.text).toBe("\u200E");
});

function eventsOf(pieces: readonly Piece[], canvas = SHEET_CANVAS) {
  const measurer = new SceneMeasurer({ notices: new Map(), omitted: new Map() }, new Set(), null);
  const events = sceneEvents({ pieces }, measurer, { canvas, fps: FPS });
  return events.map((event) => ({ ...event, startMs: Math.round(event.startSec * 1000), endMs: Math.round(event.endSec * 1000) }));
}

describe("frame times", () => {
  test("libass is handed rounded milliseconds of the 30 fps grid, inside the window only", () => {
    expect(exportFrameTimes(0, 140, 30)).toEqual([0, 33, 67, 100, 133]);
    expect(exportFrameTimes(50, 120, 30)).toEqual([67, 100]);
    expect(exportFrameTimes(10, 20, 30)).toEqual([]);
    expect(exportFrameTimes(0, 100, 240).length).toBe(exportFrameTimes(0, 100, 60).length);
  });
});

describe("the tags imply the evaluator's values at every frame (spec 5.4)", () => {
  const sheet = primitivesSheet();
  // Pieces that do not turn, shear or scale unevenly: position is checked as a constant offset from the pivot.
  const plain = (id: string) => sheet.scene.pieces.filter((piece) => piece.id === id);

  test("every sheet piece, every frame: scale, turn, shear, blur, opacity, colour and clip", () => {
    for (const piece of sheet.scene.pieces) {
      const events = eventsOf([piece]);
      expect(events.length).toBeGreaterThan(0);
      for (const t of exportFrameTimes(piece.fromMs, Math.min(piece.toMs, 1100), FPS)) {
        const pose = evaluatePiece(piece, t);
        const active = events.filter((event) => event.startMs <= t && t < event.endMs && event.layer % 10 >= 5);
        const drawn = pose.o > 0.002 && Math.abs(pose.sx) > 1e-4 && Math.abs(pose.sy) > 1e-4 && !(pose.clip && !pose.clip.inverse && (pose.clip.x2 <= pose.clip.x1 || pose.clip.y2 <= pose.clip.y1));
        if (!drawn) {
          expect(active).toHaveLength(0);
          continue;
        }
        expect(active.length).toBeGreaterThan(0);
        for (const event of active) {
          const state = assStateAt(event.text.replace(/^[^{]*/, ""), t - event.startMs);
          expect(Math.abs(state.fscx - pose.sx * 100)).toBeLessThanOrEqual(SCENE_TOLERANCE.scalePercent);
          expect(Math.abs(state.fscy - pose.sy * 100)).toBeLessThanOrEqual(SCENE_TOLERANCE.scalePercent);
          expect(Math.abs(state.frz + pose.rz)).toBeLessThanOrEqual(SCENE_TOLERANCE.degrees);
          expect(Math.abs(state.frx - SCENE_ASS.rxSign * pose.rx)).toBeLessThanOrEqual(SCENE_TOLERANCE.degrees);
          expect(Math.abs(state.fry - SCENE_ASS.rySign * pose.ry)).toBeLessThanOrEqual(SCENE_TOLERANCE.degrees);
          expect(Math.abs(state.blur - pose.blur / 0.849)).toBeLessThanOrEqual(SCENE_TOLERANCE.blur);
          if (piece.kind === "text" && (piece.fillAlpha ?? 1) > 0 && !piece.track.colour) expect(state.c1).toBe(pose.colour);
          if (piece.track.colour) {
            for (const channel of [0, 1, 2]) {
              const got = Number.parseInt(state.c1.slice(1 + 2 * channel, 3 + 2 * channel), 16);
              const want = Number.parseInt(pose.colour.slice(1 + 2 * channel, 3 + 2 * channel), 16);
              expect(Math.abs(got - want)).toBeLessThanOrEqual(SCENE_TOLERANCE.colour);
            }
          }
          if (piece.kind === "text" && (piece.fillAlpha ?? 1) > 0 && event.layer % 10 === 5) {
            expect(Math.abs(255 - state.a1 - pose.o * 255)).toBeLessThanOrEqual(SCENE_TOLERANCE.alphaByte);
          }
          if (pose.clip) {
            expect(state.clip).not.toBeNull();
            expect(Math.abs(state.clip!.x1 - Math.min(pose.clip.x1, pose.clip.x2))).toBeLessThanOrEqual(SCENE_TOLERANCE.px);
            expect(Math.abs(state.clip!.x2 - Math.max(pose.clip.x1, pose.clip.x2))).toBeLessThanOrEqual(SCENE_TOLERANCE.px);
            expect(state.clip!.inverse).toBe(pose.clip.inverse);
          }
        }
      }
    }
  });

  test("position follows the pivot to within half a pixel at every frame, the eases included", () => {
    for (const id of ["ease-x-linear", "ease-x-out", "ease-x-outQuint", "ease-x-outExpo", "ease-x-in", "ease-x-inOut", "ease-x-outBack", "ease-x-spring"]) {
      const [piece] = plain(id);
      const events = eventsOf([piece!]);
      let offset: number | null = null;
      for (const t of exportFrameTimes(piece!.fromMs, 1000, FPS)) {
        const event = events.find((candidate) => candidate.startMs <= t && t < candidate.endMs)!;
        const state = assStateAt(event.text, t - event.startMs);
        const pose = evaluatePiece(piece!, t);
        offset ??= state.x - pose.x;
        expect(Math.abs(state.x - pose.x - offset)).toBeLessThanOrEqual(SCENE_TOLERANCE.px);
        expect(Math.abs(state.y - pose.y - (events[0] ? assStateAt(events[0].text, 0).y - evaluatePiece(piece!, exportFrameTimes(piece!.fromMs, 1000, FPS)[0]!).y : 0))).toBeLessThanOrEqual(SCENE_TOLERANCE.px);
      }
    }
  });

  test("events of one paint layer never overlap and cover each drawn frame once", () => {
    const events = eventsOf(plain("ease-x-outExpo"));
    for (const t of exportFrameTimes(0, 1000, FPS)) expect(events.filter((event) => event.startMs <= t && t < event.endMs)).toHaveLength(1);
  });

  test("a piece that draws nothing (opacity 0, scale 0, an empty clip) writes no event for those frames", () => {
    const [piece] = plain("anim-scale");
    const hidden: Piece = { ...piece!, track: { ...piece!.track, o: [[0, 0]] } };
    expect(eventsOf([hidden])).toHaveLength(0);
  });
});

describe("a Scene Style target through renderCaptionTrack's writer", () => {
  test("Pills writes the same moving rounded mask for the plate and its ink on each frame", () => {
    const demo = sceneDemo("pills");
    const plate = demo.scene.pieces.find((piece) => piece.id === "pills:0:fill1")!;
    const ink = demo.scene.pieces.find((piece) => piece.id === "pills:0:w1flood")!;
    const clips = (piece: Piece) => {
      const events = eventsOf([piece], demo.canvas);
      return [633, 667, 700].map((t) => events.find((event) => event.startMs <= t && t < event.endMs)?.text.match(/\\clip\(4,([^)]*)\)/)?.[1]);
    };
    const masks = clips(plate);
    expect(masks.every((mask) => mask?.startsWith("m ") && mask.includes(" b "))).toBe(true);
    expect(new Set(masks).size).toBe(3);
    expect(clips(ink)).toEqual(masks);
  });

  test("Orbit's continuous tracking reaches the ASS writer at every export frame", () => {
    for (const fps of [24, 25, 30, 60]) {
      const demo = sceneDemo("orbit", { fps });
      const piece = demo.scene.pieces.find((item) => item.id === "orbit:0:w0c5")!;
      expect(piece).toBeDefined();
      const events = sceneEvents({ pieces: [piece] }, demo.measurer, { canvas: demo.canvas, fps })
        .filter((event) => event.layer % 10 === 5)
        .map((event) => ({ ...event, startMs: Math.round(event.startSec * 1000), endMs: Math.round(event.endSec * 1000) }));
      let alignmentOffset: number | undefined;
      for (const t of exportFrameTimes(piece.fromMs + 80, piece.fromMs + 520, fps)) {
        const active = events.filter((event) => event.startMs <= t && t < event.endMs);
        expect(active).toHaveLength(1);
        const state = assStateAt(active[0]!.text, t - active[0]!.startMs);
        const pose = evaluatePiece(piece, t);
        alignmentOffset ??= state.x - pose.x;
        expect(Math.abs(state.x - pose.x - alignmentOffset)).toBeLessThanOrEqual(SCENE_TOLERANCE.px);
      }
    }
  });

  test("every template's demo writes valid ASS: no NaN, ordered layers, events inside the scene's life", () => {
    for (const name of CAPTION_SCENE_NAMES) {
      const demo = sceneDemo(name);
      expect(demo.ass).not.toMatch(/NaN|Infinity|undefined/);
      expect(demo.events.length).toBeGreaterThan(0);
      const layers = demo.events.map((event) => event.layer);
      expect(layers).toEqual([...layers].sort((a, b) => a - b));
      for (const event of demo.events) expect(event.endSec).toBeGreaterThan(event.startSec);
    }
  });

  test("Reveal's demo stays inside its event budget (a minute loops to a few thousand events at most)", () => {
    const demo = sceneDemo("reveal");
    expect(demo.events.length).toBeLessThan(900);
  });
});

describe.skipIf(!hasLibass)("against real libass (the primitives sheet's calibration, pinned)", () => {
  const draw = (events: string, width = 1080, height = 1200, t = 1000) =>
    renderAssRaw({ ass: `${ASS_HEADER(width, height)}\n${events}\n`, width, height, tMs: t, background: "black" });
  const dialogue = (text: string, style = "Shape") => `Dialogue: 0,0:00:00.00,0:00:05.00,${style},,0,0,0,,${text}`;

  test("a drawing is aligned as a box of its bounding box's size, its own (0, 0) at the box's corner", () => {
    const frame = draw(dialogue("{\\an5\\pos(540,500)\\p1}m 100 50 l 400 50 l 400 70 l 100 70{\\p0}"));
    expect(inkBounds(frame, 40)).toEqual({ x1: 490, y1: 540, x2: 790, y2: 560 });
  });

  test("the camera of \\frx and \\fry: perspective of 326 px, rotating the way CSS rotateX and rotateY do", () => {
    const rect = "m 0 0 l 240 0 l 240 80 l 0 80";
    const row = (frame: ReturnType<typeof draw>, y: number) => {
      let x1 = frame.width;
      let x2 = -1;
      for (let x = 0; x < frame.width; x++) if (frame.data[(y * frame.width + x) * 3]! > 120) [x1, x2] = [Math.min(x1, x), x];
      return x2 - x1 + 1;
    };
    const tilted = draw(dialogue(`{\\an5\\pos(540,600)\\org(540,600)\\frx${SCENE_ASS.rxSign * 50}\\p1}${rect}{\\p0}`));
    const bounds = inkBounds(tilted, 40)!;
    const topWidth = row(tilted, bounds.y1 + 1);
    const bottomWidth = row(tilted, bounds.y2 - 2);
    // CSS rotateX(50deg): the top edge recedes (narrower), as with perspective(326).
    const z = 40 * Math.sin((50 * Math.PI) / 180);
    expect(topWidth).toBeLessThan(bottomWidth);
    expect(Math.abs(topWidth - (240 * SCENE_PERSPECTIVE_PX) / (SCENE_PERSPECTIVE_PX + z))).toBeLessThan(3);
    expect(Math.abs(bottomWidth - (240 * SCENE_PERSPECTIVE_PX) / (SCENE_PERSPECTIVE_PX - z))).toBeLessThan(3);
  });

  test("\\fax shears about the top of the aligned box: the writer's pos compensation puts a sheared drawing where the model says", () => {
    const [piece] = primitivesSheet().scene.pieces.filter((candidate) => candidate.id === "shape-tilt-x-50");
    expect(piece).toBeDefined();
    // The same drawing sheared 20 degrees about its own centre by the model.
    const sheared: Piece = { ...piece!, track: { ...piece!.track, rx: undefined, skx: [[0, 20]] } };
    const events = eventsOf([sheared]);
    const frame = renderAssRaw({ ass: assScript(sceneEvents({ pieces: [sheared] }, new SceneMeasurer({ notices: new Map(), omitted: new Map() }, new Set(), null), { canvas: SHEET_CANVAS, fps: FPS }), SHEET_CANVAS, DEFAULT_CAPTION_PRESET), width: SHEET_CANVAS.width, height: SHEET_CANVAS.height, tMs: 33, background: "black" });
    const bounds = inkBounds(frame, 40)!;
    const pose = evaluatePiece(sheared, 33);
    // 240 x 80 centred on the pivot; skewX(20) moves the top edge left and the bottom edge right by 40 * tan(20) about the middle.
    const shift = 40 * Math.tan((20 * Math.PI) / 180);
    expect(events.length).toBeGreaterThan(0);
    expect(Math.abs(bounds.x1 - (pose.x - 120 - shift))).toBeLessThan(2);
    expect(Math.abs(bounds.x2 - (pose.x + 120 + shift))).toBeLessThan(2);
  });

  test("a stroked open path is one centred band with round joins: a retraced drawing's border", () => {
    const piece = primitivesSheet().scene.pieces.find((candidate) => candidate.id === "shape-polyline-round")!;
    const events = eventsOf([piece]);
    const stroke = events.find((event) => event.layer % 10 === 6);
    expect(stroke).toBeDefined();
    expect(stroke!.text).toContain("\\bord6");
    expect(stroke!.text).toContain("\\1a&HFF&");
  });
});
