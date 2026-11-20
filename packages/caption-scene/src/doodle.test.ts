import { describe, expect, test } from "bun:test";
import { demoCues } from "./demo";
import { EASES, clamp, prog } from "./ease";
import { evaluatePiece, type ShapePiece, type TextPiece } from "./scene";
import { DOODLE_DEMO, arrowPoints, doodleProgram, doodleWriteWindow, loopPoints, smoothPath, tickPoints } from "./templates/doodle";
import { fakeMeasure, sceneInput } from "./test-support";
import type { PathCmd } from "./scene";

const input = (cues: ReturnType<typeof demoCues>["cues"]) => sceneInput(cues, { anchor: { xPct: 50, yPct: (1290 / 1920) * 100 } });
const { cues } = demoCues(DOODLE_DEMO);
const scene = doodleProgram.build(input(cues));
const texts = scene.pieces.filter((piece): piece is TextPiece => piece.kind === "text");
const shapes = scene.pieces.filter((piece): piece is ShapePiece => piece.kind === "shape");
const cueNumber = (piece: { id: string }) => Number(piece.id.split(":")[1]);
const marksOf = (cue: number) => shapes.filter((piece) => cueNumber(piece) === cue).map((piece) => piece.id.split(":")[2]);
const textOf = (cue: number, text: string) => texts.find((piece) => cueNumber(piece) === cue && piece.text === text)!;
const markOf = (cue: number, name: string) => shapes.find((piece) => piece.id === `doodle:${cue}:${name}`)!;
const advanceOf = (piece: TextPiece) => fakeMeasure(piece.text, piece.face, piece.sizePx, 0).advance;

/** The sample's path text (`d`), one decimal. */
const d = (cmds: readonly PathCmd[]) =>
  cmds
    .map((cmd, at) => {
      const values = cmd.slice(1) as number[];
      const pairs = values.filter((_, i) => i % 2 === 0).map((value, i) => `${value.toFixed(1)},${values[2 * i + 1]!.toFixed(1)}`);
      return cmd[0] === "M" ? `${at === 0 ? "" : " "}M${pairs.join(" ")}` : `${cmd[0]}${pairs.join(" ")}`;
    })
    .join("");

describe("Doodle: the hand-drawn paths are the sample's", () => {
  // Read from the sample in Chrome (cue 4: `promise` alone; cue 1: `motivation is a myth`). The sample takes
  // widths and offsets from `offsetWidth`/`offsetLeft`, which round to whole px: the fixtures use those integers
  // (the program itself uses the measured widths, which differ from them by under half a pixel).
  const rx = 725 / 2 + 66;
  const ry = (190 * 0.78) / 2 + 58;
  const loop = loopPoints(540, 1290 - 8, rx, ry, 1.3 + 4 * 0.9);

  test("the pen loop: top half and bottom half", () => {
    expect(d(smoothPath(loop.top))).toBe(
      "M128.5,1286.1C131.4,1281.6 135.9,1267.8 145.6,1258.9C155.4,1250.0 170.3,1241.0 187.0,1232.6C203.6,1224.2 224.0,1216.2 245.5,1208.7C266.9,1201.1 290.5,1194.0 315.5,1187.5C340.5,1181.0 367.3,1174.8 395.3,1169.8C423.4,1164.7 453.7,1160.1 483.7,1157.1C513.7,1154.1 545.6,1152.2 575.4,1151.8C605.2,1151.3 635.2,1152.5 662.4,1154.4C689.6,1156.4 714.9,1159.8 738.6,1163.4C762.4,1167.0 783.7,1171.5 804.9,1176.0C826.1,1180.6 846.2,1185.3 865.7,1190.6C885.2,1196.0 905.1,1201.5 921.9,1208.0C938.8,1214.6 955.6,1221.8 966.6,1230.0C977.7,1238.2 984.5,1252.8 988.1,1257.3",
    );
    expect(d(smoothPath(loop.bottom))).toBe(
      "M988.1,1257.3C986.3,1262.8 986.3,1279.2 977.6,1290.0C969.0,1300.8 953.5,1311.9 936.2,1322.0C918.9,1332.1 896.7,1341.7 874.0,1350.7C851.2,1359.6 826.0,1367.9 799.8,1375.6C773.6,1383.3 745.8,1390.7 716.7,1396.9C687.5,1403.1 656.3,1408.9 624.8,1413.1C593.3,1417.2 559.7,1420.3 527.7,1421.8C495.7,1423.3 463.2,1423.2 432.8,1422.1C402.5,1421.1 373.5,1418.5 345.7,1415.6C317.9,1412.6 291.9,1408.8 266.1,1404.6C240.4,1400.3 214.9,1395.8 191.3,1390.1C167.7,1384.4 143.4,1378.1 124.3,1370.5C105.1,1362.8 87.0,1353.9 76.6,1344.2C66.1,1334.4 60.4,1323.1 61.6,1312.1C62.7,1301.0 71.4,1289.0 83.5,1278.0C95.7,1267.0 126.0,1251.5 134.5,1246.1",
    );
  });

  test("the three ticks", () => {
    expect(tickPoints(540, 1290, rx, ry).map((pts) => d(smoothPath(pts)))).toEqual([
      "M864.2,1157.8C866.3,1154.2 873.5,1142.7 877.2,1136.2C880.9,1129.6 884.8,1121.5 886.3,1118.5",
      "M950.9,1187.9C954.6,1184.6 966.5,1174.2 973.4,1168.4C980.2,1162.5 988.8,1155.4 991.9,1152.8",
      "M997.5,1225.6C1000.9,1224.2 1011.6,1219.3 1017.6,1217.1C1023.6,1214.9 1031.0,1213.4 1033.6,1212.6",
    ]);
  });

  test("the hooked arrow: shaft and head", () => {
    const heroRy = (190 * 0.78) / 2 + 58;
    const leadEnd = 747 + 83 - 20;
    const hy = 1290 + (heroRy + 210 - (heroRy + 8)) / 2;
    const { shaft, head } = arrowPoints(leadEnd, -(heroRy + 160), hy, heroRy, 509 - 76);
    expect(d(smoothPath(shaft))).toBe("M828.0,1110.9C833.0,1116.3 872.2,1131.8 858.0,1143.5C843.8,1155.2 782.6,1170.7 743.0,1181.1C703.4,1191.5 645.5,1197.0 620.3,1206.2C595.1,1215.4 596.7,1231.2 592.0,1236.3");
    expect(`M${head[0][0].toFixed(1)},${head[0][1].toFixed(1)} L${head[1][0].toFixed(1)},${head[1][1].toFixed(1)} L${head[2][0].toFixed(1)},${head[2][1].toFixed(1)}`).toBe("M625.2,1229.0 L592.0,1236.3 L595.7,1208.5");
  });
});

describe("Doodle", () => {
  test("a word per piece; marks follow the cue's shape", () => {
    expect(texts).toHaveLength(cues.reduce((sum, cue) => sum + cue.words.length, 0));
    expect(marksOf(0)).toEqual(["underline"]);
    expect(marksOf(1)).toEqual(["loopTop", "loopBottom", "tick0", "tick1", "tick2", "arrow"]);
    // No lead-in, no arrow.
    expect(marksOf(2)).toEqual(["loopTop", "loopBottom", "tick0", "tick1", "tick2"]);
    expect(marksOf(3)).toContain("arrow");
    expect(marksOf(4)).toEqual(["loopTop", "loopBottom", "tick0", "tick1", "tick2"]);
  });

  test("handwriting is Caveat Brush, the hero Permanent Marker in the highlight colour, with the sample's shadows", () => {
    expect(textOf(1, "motivation")).toMatchObject({ face: "Caveat Brush", sizePx: 100, fill: "#FFFFFF", letterSpacingEm: 0 });
    expect(textOf(0, "nobody")).toMatchObject({ face: "Caveat Brush", sizePx: 112 });
    const myth = textOf(1, "myth");
    expect(myth).toMatchObject({ face: "Permanent Marker", sizePx: 190, fill: "#FFE9A8" });
    expect(myth.shadows).toEqual([
      { dx: 0, dy: 4, blur: 7, colour: "#000000", alpha: 0.6 },
      { dx: 0, dy: 2, blur: 1.5, colour: "#000000", alpha: 0.45 },
    ]);
  });

  test("marks are 9 px round strokes in the primary colour with the drop shadow, no fill", () => {
    for (const mark of shapes) {
      expect(mark.stroke).toEqual({ widthPx: 9, colour: "#FFFFFF" });
      expect(mark.fill).toBeUndefined();
      expect(mark.shadows).toEqual([{ dx: 0, dy: 3, blur: 2.5, colour: "#000000", alpha: 0.55 }]);
    }
  });

  test("a no-hero cue is two rows 1.05 em apart, the pair centred 10 px above the anchor line", () => {
    const baseline = (piece: TextPiece) => evaluatePiece(piece, piece.fromMs).y;
    const first = textOf(0, "nobody");
    const second = textOf(0, "you");
    expect(textOf(0, "tells")).toMatchObject({ sizePx: 112 });
    expect(baseline(textOf(0, "tells"))).toBeCloseTo(baseline(first), 6);
    expect(baseline(textOf(0, "this"))).toBeCloseTo(baseline(second), 6);
    // Row centres: 1290 - 58.8 - 10 and 1290 + 58.8 - 10; the baseline is 0.83 em below the line box's top.
    expect(baseline(first)).toBeCloseTo(1290 - 58.8 - 10 - 56 + 0.83 * 112, 6);
    expect(baseline(second) - baseline(first)).toBeCloseTo(117.6, 6);
  });

  test("a word is written left to right over 85 % of its spoken time (the sample's wipe), then shows whole", () => {
    for (const piece of texts.filter((p) => p.face === "Caveat Brush")) {
      const cue = cues[cueNumber(piece)]!;
      const word = cue.words[Number(piece.id.split(":w")[1])]!;
      const [ws, wd] = doodleWriteWindow(word.startMs, word.endMs);
      expect(wd).toBe(clamp(0.85 * (word.endMs - word.startMs), 120, 550));
      const left = evaluatePiece(piece, ws).x;
      const adv = advanceOf(piece);
      const pad = 0.2 * piece.sizePx;
      for (const p of [0, 0.25, 0.5, 0.9, 1]) {
        const pose = evaluatePiece(piece, ws + p * wd);
        expect(pose.clip!.x2).toBeCloseTo(left + p * adv, 6);
        expect(pose.clip!.x1).toBeCloseTo(left - pad, 6);
      }
      const done = evaluatePiece(piece, ws + wd + 5).clip!;
      expect(done.x2).toBeCloseTo(left + adv + pad, 6);
      expect(done.y2 - done.y1).toBeCloseTo(piece.sizePx * 1.4, 6);
      expect(piece.fromMs).toBe(Math.max(cue.startMs - 60, ws));
    }
  });

  test("the hero is tipped -3 degrees about its row's centre and its wipe runs along the row", () => {
    const myth = textOf(1, "myth");
    expect(evaluatePiece(myth, 3000).rz).toBe(-3);
    const pose = evaluatePiece(myth, 3000);
    expect(pose.x).toBeCloseTo(540, 6);
    expect(pose.y).toBeCloseTo(1391, 0);
    const [ws, wd] = doodleWriteWindow(2804, 3364);
    const a = evaluatePiece(myth, ws + 0.25 * wd).clip!.x2;
    const b = evaluatePiece(myth, ws + 0.75 * wd).clip!.x2;
    expect(b - a).toBeCloseTo(0.5 * advanceOf(myth) * Math.cos((3 * Math.PI) / 180), 6);
  });

  test("the loop is wiped in after the hero is written: top 180 ms left to right, bottom 180 ms right to left", () => {
    const [hs, hd] = doodleWriteWindow(2804, 3364);
    const written = hs + hd;
    const top = markOf(1, "loopTop");
    const bottom = markOf(1, "loopBottom");
    expect(top.fromMs).toBeCloseTo(written + 20, 6);
    expect(bottom.fromMs).toBeCloseTo(written + 200, 6);
    const pad = 15;
    const topEnd = evaluatePiece(top, written + 200).clip!;
    const topStart = evaluatePiece(top, written + 20).clip!;
    expect(topStart.x2 - topStart.x1).toBeCloseTo(pad, 6);
    const mid = evaluatePiece(top, written + 20 + 90).clip!;
    expect(mid.x2 - mid.x1).toBeCloseTo(pad + EASES.inOut(0.5) * (topEnd.x2 - topEnd.x1 - pad), 6);
    // Right to left: the clip's left edge travels from pad inside the right edge to the left edge of the box.
    const botStart = evaluatePiece(bottom, written + 200).clip!;
    const botEnd = evaluatePiece(bottom, written + 380).clip!;
    expect(botStart.x2 - botStart.x1).toBeCloseTo(pad, 6);
    expect(botEnd.x2 - botEnd.x1).toBeGreaterThan(300);
    expect(evaluatePiece(bottom, written + 290).clip!.x1).toBeCloseTo(botStart.x1 + (botEnd.x1 - botStart.x1) * EASES.inOut(0.5), 6);
  });

  test("three ticks pop 50 ms apart about their first point with the spring", () => {
    const [hs, hd] = doodleWriteWindow(2804, 3364);
    const written = hs + hd;
    [0, 1, 2].forEach((i) => {
      const tick = markOf(1, `tick${i}`);
      const start = written + 380 + i * 50;
      expect(tick.fromMs).toBeCloseTo(start, 6);
      expect(evaluatePiece(tick, start).sx).toBe(0);
      expect(evaluatePiece(tick, start + 75).sx).toBeCloseTo(EASES.spring(0.5), 6);
      expect(evaluatePiece(tick, start + 75).sy).toBeCloseTo(EASES.spring(0.5), 6);
      expect(evaluatePiece(tick, start + 150).sx).toBe(1);
      // The pivot is the first point of the path.
      expect(tick.path[0]).toEqual(["M", 0, 0]);
      expect(tick.clip).toBeUndefined();
    });
  });

  test("the arrow is wiped downward over 210 ms, ending just before the hero is written", () => {
    const arrow = markOf(1, "arrow");
    expect(arrow.fromMs).toBe(2804 - 230);
    const a = evaluatePiece(arrow, arrow.fromMs).clip!;
    const b = evaluatePiece(arrow, arrow.fromMs + 210).clip!;
    expect(a.y2 - a.y1).toBeCloseTo(15, 6);
    expect(b.y2 - b.y1).toBeGreaterThan(100);
    expect(evaluatePiece(arrow, arrow.fromMs + 105).clip!.y2 - a.y1).toBeCloseTo(15 + EASES.inOut(0.5) * (b.y2 - a.y1 - 15), 6);
    // The shaft and the head are one mark of two sub-paths.
    expect(arrow.path.filter((cmd) => cmd[0] === "M")).toHaveLength(2);
  });

  test("a cue without a hero is underlined once its last word is written", () => {
    const underline = markOf(0, "underline");
    const [ws, wd] = doodleWriteWindow(1275, 1540);
    expect(underline.fromMs).toBeCloseTo(ws + wd + 20, 6);
    const a = evaluatePiece(underline, underline.fromMs).clip!;
    const b = evaluatePiece(underline, underline.fromMs + 220).clip!;
    expect(a.x2 - a.x1).toBeCloseTo(15, 6);
    expect(b.x2 - b.x1).toBeGreaterThan(150);
    // It sits under the last word's baseline row.
    const last = textOf(0, "this");
    expect(evaluatePiece(underline, underline.fromMs).y).toBeGreaterThan(evaluatePiece(last, 1500).y);
  });

  test("the whole cue fades in 120 ms and is gone 40 ms before the next cue", () => {
    const cue = cues[1]!;
    for (const piece of scene.pieces.filter((p) => cueNumber(p) === 1)) {
      expect(piece.toMs).toBe(cue.endMs - 40);
      expect(evaluatePiece(piece, cue.endMs - 171).o).toBe(1);
      expect(evaluatePiece(piece, cue.endMs - 110).o).toBeCloseTo(1 - prog(cue.endMs - 110, cue.endMs - 170, 120), 6);
      expect(evaluatePiece(piece, cue.endMs - 50).o).toBe(0);
    }
  });

  test("a hero too wide for the row shrinks to 760 px, a lead too wide for a row wraps", () => {
    const long = demoCues({ lines: ["so:m the:m real:b reason:b most:b people:b never:b get:b there:b antidisestablishmentarianism:h@900"], options: DOODLE_DEMO.options }).cues;
    const built = doodleProgram.build(input(long));
    const hero = built.pieces.find((p): p is TextPiece => p.kind === "text" && p.text === "antidisestablishmentarianism")!;
    expect(hero.sizePx).toBeLessThan(190);
    expect(advanceOf(hero)).toBeLessThanOrEqual(760.5);
    const leadY = new Set(built.pieces.filter((p): p is TextPiece => p.kind === "text" && p.face === "Caveat Brush").map((p) => Math.round(evaluatePiece(p, p.fromMs).y)));
    expect(leadY.size).toBeGreaterThan(1);
  });

  test("right-to-left cues lay out from the right and are written from the right", () => {
    const urdu = demoCues({ lines: ["یہ:m بہت:b اچھا:h@600 ہے:m"], language: "ur", options: DOODLE_DEMO.options }).cues;
    const built = doodleProgram.build(input(urdu));
    const body = built.pieces.filter((p): p is TextPiece => p.kind === "text" && p.face === "Caveat Brush");
    const x = (text: string) => evaluatePiece(body.find((p) => p.text === text)!, 400).x;
    expect(x("یہ")).toBeGreaterThan(x("بہت"));
    const piece = body.find((p) => p.text === "یہ")!;
    const [ws, wd] = doodleWriteWindow(urdu[0]!.words[0]!.startMs, urdu[0]!.words[0]!.endMs);
    const start = evaluatePiece(piece, ws).clip!;
    const end = evaluatePiece(piece, ws + wd).clip!;
    expect(end.x1).toBeLessThan(start.x1);
    expect(start.x1).toBeCloseTo(start.x2 - 0.2 * piece.sizePx, 6);
  });

  test("one word is a hero alone: no rows, a loop and ticks, centred on the anchor line", () => {
    const one = demoCues({ lines: ["wait:h@600"], options: DOODLE_DEMO.options }).cues;
    const built = doodleProgram.build(input(one));
    expect(built.pieces.filter((p) => p.kind === "text")).toHaveLength(1);
    expect(built.pieces.filter((p) => p.kind === "shape").map((p) => p.id.split(":")[2])).toEqual(["loopTop", "loopBottom", "tick0", "tick1", "tick2"]);
    expect(evaluatePiece(built.pieces[0]!, built.pieces[0]!.fromMs).y).toBeCloseTo(1290, 0);
  });
});
