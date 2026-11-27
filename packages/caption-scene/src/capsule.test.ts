import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Box, evaluatePiece, type Piece, pieceBounds } from "./scene";
import { pathBounds } from "./shapes";
import { capsuleProgram } from "./templates/capsule";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("capsule", capsuleProgram, { anchorLineY: 1290 });

const colours = { primary: "#16286E", highlight: "#F2472F", accent: "#FFD42E", shadow: "#000000" };
const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };

const build = (lines: string[], options: { language?: string; canvas?: { width: number; height: number }; colours?: typeof colours; cueGap?: number } = {}) => {
  const { cues } = demoCues({ lines, language: options.language, options: { lead: 400, gap: 30, cueGap: options.cueGap ?? 300, tail: 800 } });
  const pieces = capsuleProgram.build(sceneInput(cues, { fps: 30, anchor, colours: options.colours ?? colours, ...(options.canvas ? { canvas: options.canvas } : {}) })).pieces;
  return { cues, pieces };
};
const own = (pieces: readonly Piece[], cue: number) => pieces.filter((piece) => piece.id.startsWith(`capsule:${cue}:`));
const isFace = (piece: Piece) => /:w\d+(l\d+)?$/.test(piece.id);
const meets = (a: Box, b: Box) => a.x1 < b.x2 - 0.5 && b.x1 < a.x2 - 0.5 && a.y1 < b.y2 - 0.5 && b.y1 < a.y2 - 0.5;
const safe = (canvas = { width: 1080, height: 1920 }): Box => ({ x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 });
const within = (box: Box, room: Box) => box.x1 >= room.x1 && box.y1 >= room.y1 && box.x2 <= room.x2 && box.y2 <= room.y2;

/** A capsule's real outline at `t`: its rounded path sampled into a convex polygon, posed like the renderers pose it. */
function outlineAt(piece: Piece, t: number): [number, number][] {
  if (piece.kind !== "shape") return [];
  const pose = evaluatePiece(piece, t);
  const points: [number, number][] = [];
  let at: [number, number] = [0, 0];
  for (const cmd of piece.path) {
    if (cmd[0] === "M" || cmd[0] === "L") {
      at = [cmd[1], cmd[2]];
      points.push(at);
    } else if (cmd[0] === "C") {
      const [, x1, y1, x2, y2, x3, y3] = cmd;
      for (let k = 1; k <= 6; k++) {
        const q = k / 6;
        const a = (1 - q) ** 3;
        const b = 3 * (1 - q) ** 2 * q;
        const c = 3 * (1 - q) * q ** 2;
        const d = q ** 3;
        points.push([a * at[0] + b * x1 + c * x2 + d * x3, a * at[1] + b * y1 + c * y2 + d * y3]);
      }
      at = [x3, y3];
    }
  }
  const angle = (pose.rz * Math.PI) / 180;
  return points.map(([x, y]) => [pose.x + x * pose.sx * Math.cos(angle) - y * pose.sy * Math.sin(angle), pose.y + x * pose.sx * Math.sin(angle) + y * pose.sy * Math.cos(angle)]);
}

/** Separating axes: a convex polygon against a box, the box grown by `pad`. */
function polygonMeetsBox(points: readonly [number, number][], box: Box, pad: number): boolean {
  const b = { x1: box.x1 - pad, y1: box.y1 - pad, x2: box.x2 + pad, y2: box.y2 + pad };
  if (Math.max(...points.map((p) => p[0])) <= b.x1 || Math.min(...points.map((p) => p[0])) >= b.x2) return false;
  if (Math.max(...points.map((p) => p[1])) <= b.y1 || Math.min(...points.map((p) => p[1])) >= b.y2) return false;
  const corners: [number, number][] = [[b.x1, b.y1], [b.x2, b.y1], [b.x1, b.y2], [b.x2, b.y2]];
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i]!;
    const [bx, by] = points[(i + 1) % points.length]!;
    const nx = by - ay;
    const ny = ax - bx;
    if (Math.hypot(nx, ny) < 1e-6) continue;
    const proj = (p: readonly [number, number]) => p[0] * nx + p[1] * ny;
    const poly = points.map(proj);
    const rect = corners.map(proj);
    if (Math.max(...poly) <= Math.min(...rect) || Math.max(...rect) <= Math.min(...poly)) return false;
  }
  return true;
}

/** The settled frame of a cue: after its last word, before it leaves. */
const settledAt = (cue: SceneCue) => cue.words.at(-1)!.endMs + 60;

/** Every painted frame of a cue: words inside the safe area, never touching each other or a decoration of their cue. */
function expectClean(pieces: readonly Piece[], cue: SceneCue, canvas?: { width: number; height: number }) {
  const mine = own(pieces, cue.index);
  for (let t = cue.words[0]!.startMs; t < settledAt(cue); t += 33) {
    const live = mine.flatMap((piece) => {
      const box = pieceBounds(piece, t, fakeMeasure);
      return box ? [{ piece, box }] : [];
    });
    for (const { piece, box } of live) {
      expect(within(box, safe(canvas)), `${piece.id} at ${t} leaves the safe area ${JSON.stringify(box)}`).toBe(true);
      if (!isFace(piece)) continue;
      for (const other of live) {
        // The key word rides its own capsule, and its burst is drawn behind that opaque capsule; anything else stays off a word.
        const word = piece.id.replace(/l\d+$/, "");
        if (other.piece === piece || other.piece.id === `${word}cap` || other.piece.id === `${word}burst` || other.piece.id.startsWith(`${word}l`)) continue;
        // A capsule is checked by its real outline (rim included), not by the box of its turned rectangle.
        if (/(cap|l80)$/.test(other.piece.id) && other.piece.kind === "shape") {
          const rim = other.piece.stroke?.widthPx ?? 0;
          expect(polygonMeetsBox(outlineAt(other.piece, t), box, rim / 2), `${other.piece.id} meets ${piece.id} at ${t}`).toBe(false);
          continue;
        }
        // A burst is round: its points stay inside the circle of its pose's scale.
        if (/burst$/.test(other.piece.id) && other.piece.kind === "shape") {
          const pose = evaluatePiece(other.piece, t);
          const r = pathBounds(other.piece.path).x2 * pose.sx;
          const dx = Math.max(0, box.x1 - pose.x, pose.x - box.x2);
          const dy = Math.max(0, box.y1 - pose.y, pose.y - box.y2);
          expect(Math.hypot(dx, dy), `${other.piece.id} reaches ${piece.id} at ${t}`).toBeGreaterThanOrEqual(r);
          continue;
        }
        expect(meets(box, other.box), `${other.piece.id} meets ${piece.id} at ${t}`).toBe(false);
      }
    }
  }
}

describe("capsule", () => {
  test("plain words are navy with a white keyline, the key word is white on its own capsule, one capsule per key-word cue", () => {
    const { cues, pieces } = build(["so:m build:b it:m now:h@480", "not:m someday:b"]);
    const t = settledAt(cues[0]!);
    for (const w of [0, 1, 2]) {
      const face = pieces.find((piece) => piece.id === `capsule:0:w${w}`)!;
      expect(face.kind === "text" && face.fill).toBe("#16286E");
      expect(face.kind === "text" && face.stroke?.colour).toBe("#FFFFFF");
      expect(evaluatePiece(face, t).o).toBe(1);
    }
    const label = pieces.find((piece) => piece.id === "capsule:0:w3")!;
    const capsule = pieces.find((piece) => piece.id === "capsule:0:w3cap")!;
    expect(label.kind === "text" && label.fill).toBe("#FFFFFF");
    expect(label.z).toBeGreaterThan(capsule.z);
    // The word rides the capsule: one pivot, one pose.
    expect(label.track).toEqual(capsule.track);
    expect(own(pieces, 1).some((piece) => /cap$/.test(piece.id))).toBe(false);
    expect(own(pieces, 1).filter((piece) => /:spark$/.test(piece.id))).toHaveLength(1);
  });

  test("the capsule swings up from near vertical about its near end, overshoots past level and settles tilted 4-8 degrees", () => {
    const { cues, pieces } = build(["so:m build:b it:m now:h@480"]);
    const capsule = pieces.find((piece) => piece.id === "capsule:0:w3cap")!;
    const s = cues[0]!.words[3]!.startMs;
    const first = evaluatePiece(capsule, capsule.fromMs).rz;
    expect(first).toBeGreaterThan(60);
    const angles = Array.from({ length: 40 }, (_, k) => evaluatePiece(capsule, s - 80 + k * 20).rz);
    const settled = evaluatePiece(capsule, s + 900).rz;
    expect(Math.min(...angles)).toBeLessThan(settled - 2);
    expect(settled).toBeLessThanOrEqual(-4);
    expect(settled).toBeGreaterThanOrEqual(-8);
    // The hinge never moves while the cue is on screen.
    expect(capsule.track.x).toHaveLength(1);
    expect(evaluatePiece(capsule, s + 900).y).toBe(evaluatePiece(capsule, capsule.fromMs).y);
  });

  test("the burst, smiley and sparkles recur on every key-word cue and the capsule colours cycle", () => {
    const lines = Array.from({ length: 8 }, (_, k) => (k % 2 ? "and:m it:m works:b" : `you:m have:b to:m go${k}:h@420`));
    const { cues, pieces } = build(lines);
    const fills = new Set<string>();
    for (const cue of cues) {
      const mine = own(pieces, cue.index);
      const hero = cue.words.findIndex((word) => word.role === "hero");
      if (hero < 0) {
        expect(mine.some((piece) => /:spark$/.test(piece.id)), `cue ${cue.index}`).toBe(true);
        continue;
      }
      for (const part of ["cap", "burst", "smile", "eyes", "mouth", "spark0", "spark1"]) {
        expect(mine.some((piece) => piece.id === `capsule:${cue.index}:w${hero}${part}`), `cue ${cue.index} ${part}`).toBe(true);
      }
      const cap = mine.find((piece) => /cap$/.test(piece.id))!;
      fills.add(cap.kind === "shape" ? cap.fill!.colour : "");
    }
    expect(fills.size).toBe(2);
  });

  test("the extra beats (speed dashes, a navy blob) fire on most cues of a long run of ordinary speech", () => {
    const lines = Array.from({ length: 24 }, (_, k) => [
      "so:m here:b is:m the:m thing:h@300", "nobody:b tells:b you:m this", "you:m have:b to:m start:h@300", "before:b you:m feel:b ready",
    ][k % 4]!.replace(/^(\w+)/, (word) => `${word}${k}`));
    const { cues, pieces } = build(lines, { cueGap: 60 });
    const dashes = cues.filter((cue) => own(pieces, cue.index).some((piece) => /:dash$/.test(piece.id))).length;
    const blobs = cues.filter((cue) => own(pieces, cue.index).some((piece) => /:blob$/.test(piece.id))).length;
    expect(dashes).toBeGreaterThanOrEqual(20);
    expect(blobs).toBeGreaterThanOrEqual(18);
  });

  test("words before the key word sit above the capsule, words after it below, in reading order, never crossed by the swing", () => {
    const { cues, pieces } = build(["we:b didn't:b want:h@200 to:m go:b", "the:m remote:b doesn't:h@120 work.:b"]);
    for (const cue of cues) {
      const hero = cue.words.findIndex((word) => word.role === "hero");
      const t = settledAt(cue);
      const y = (w: number) => pieceBounds(pieces.find((piece) => piece.id === `capsule:${cue.index}:w${w}`)!, t, fakeMeasure)!;
      const hinge = evaluatePiece(pieces.find((piece) => piece.id === `capsule:${cue.index}:w${hero}cap`)!, t).y;
      for (let w = 0; w < hero; w++) expect(y(w).y2).toBeLessThan(hinge);
      for (let w = hero + 1; w < cue.words.length; w++) expect(y(w).y1).toBeGreaterThan(hinge);
      expectClean(pieces, cue);
    }
  });

  test("Hindi: a Devanagari cue with a key word keeps its words whole, inside the band, uncovered", () => {
    const { cues, pieces } = build(["यह:b बहुत:h@400 अच्छा:b है:m", "मुझे:b यह:m पसंद:b है:m"], { language: "hi" });
    for (const cue of cues) {
      expect(own(pieces, cue.index).filter(isFace).every((piece) => !/l\d+$/.test(piece.id))).toBe(true);
      expectClean(pieces, cue);
    }
  });

  test("Urdu (RTL): rows run right to left and the capsule hinges on its right end, swinging the mirrored way", () => {
    const { cues, pieces } = build(["یہ:m بہت:b اچھا:h@600 ہے:m"], { language: "ur" });
    const cue = cues[0]!;
    const t = settledAt(cue);
    const x = (w: number) => evaluatePiece(pieces.find((piece) => piece.id === `capsule:0:w${w}`)!, t).x;
    expect(x(0)).toBeGreaterThan(x(1));
    const cap = pieces.find((piece) => piece.id === "capsule:0:w2cap")!;
    const box = pieceBounds(cap, t, fakeMeasure)!;
    // The pivot (hinge) is at the right end, the capsule reaches left of it; the hang turns the other way.
    expect(evaluatePiece(cap, t).x).toBeGreaterThan((box.x1 + box.x2) / 2);
    expect(evaluatePiece(cap, cap.fromMs).rz).toBeLessThan(-60);
    expect(evaluatePiece(cap, t + 300).rz).toBeGreaterThanOrEqual(4);
    expectClean(pieces, cue);
  });

  test("CJK: one long token with no spaces wraps into even rows, never below the size floor", () => {
    const token = "我们今天要学习如何做一个很好吃的蛋糕然后分享给我们的朋友们一起吃";
    const { cues, pieces } = build([`${token}:b@1600`], { language: "zh" });
    const parts = own(pieces, 0).filter((piece) => /:w0l\d+$/.test(piece.id));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(token);
    for (const piece of parts) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(114 * 0.62 - 0.01);
    expectClean(pieces, cues[0]!);
  });

  test("mixed Latin and digits: a cue with numbers and a key word stays inside the band, uncovered", () => {
    const { cues, pieces } = build(["we've:b shot:b 384:h@500 episodes:b", "since:m 2019:b"]);
    for (const cue of cues) expectClean(pieces, cue);
  });

  test("an overlong key word holds its floor on one or two lines inside its capsule", () => {
    const { pieces } = build(["it's:m extraordinarily:h@900 hard:b"]);
    const label = pieces.filter((piece) => /^capsule:0:w1(l\d)?$/.test(piece.id) && piece.kind === "text");
    expect(label.length).toBeGreaterThanOrEqual(1);
    expect(label.length).toBeLessThanOrEqual(2);
    for (const line of label) expect(line.kind === "text" && line.sizePx).toBeGreaterThanOrEqual(106 * 0.7 - 0.01);
    expect(pieces.some((piece) => piece.id === "capsule:0:w1cap")).toBe(true);
  });

  test("16:9: the hang starts shallower so the whole swing stays inside the band without shrinking the caption", () => {
    const canvas = { width: 1920, height: 1080 };
    const { cues, pieces } = build(["so:m build:b it:m everything:h@500"], { canvas });
    const cap = pieces.find((piece) => piece.id === "capsule:0:w3cap")!;
    expect(evaluatePiece(cap, cap.fromMs).rz).toBeLessThan(80);
    const label = pieces.find((piece) => piece.id === "capsule:0:w3")!;
    expect(label.kind === "text" && label.sizePx).toBeGreaterThan(80);
    expectClean(pieces, cues[0]!, canvas);
  });

  test("a brand colour that cannot carry white text falls back to the style's navy and coral", () => {
    const { pieces } = build(["so:m build:b it:m now:h@480"], { colours: { ...colours, primary: "#FFF27A", highlight: "#FFE0E0" } });
    const face = pieces.find((piece) => piece.id === "capsule:0:w0")!;
    expect(face.kind === "text" && face.fill).toBe("#16286E");
    const cap = pieces.find((piece) => piece.id === "capsule:0:w3cap")!;
    expect(cap.kind === "shape" && cap.fill?.colour).toBe("#16286E");
  });
});

describe("capsule review round 1", () => {
  const shift = (cues: readonly SceneCue[], by: number): SceneCue[] => cues.map((cue) => ({
    ...cue, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + by, endMs: word.endMs + by })),
  }));
  const painted = (piece: Piece, t: number) => pieceBounds(piece, t, fakeMeasure) !== null && evaluatePiece(piece, t).o > 0;
  const pieceCount = (pieces: readonly Piece[]) => pieces.reduce((sum, piece) => sum + 1 + (piece.shadows?.length ?? 0), 0);

  test("a key word that paints on one frame at 25 fps keeps its capsule on that frame, whole and opaque", () => {
    const lines = ["go:h@70", "on:b@70", "again:h@70", "here:h@70", "we@70 stop:h@100", "now:h@80", "ok@70"];
    let checked = 0;
    for (const offset of [0, 7, 13, 23, 31]) {
      const cues = shift(demoCues({ lines, options: { lead: 81, gap: 0, cueGap: 0, tail: 400 } }).cues, offset);
      const pieces = capsuleProgram.build(sceneInput(cues, { fps: 25, anchor })).pieces;
      for (const cue of cues) {
        const hero = cue.words.findIndex((word) => word.role === "hero");
        if (hero < 0) continue;
        const label = pieces.find((piece) => piece.id === `capsule:${cue.index}:w${hero}`)!;
        const frames = exportFrameTimes(label.fromMs, label.toMs, 25).filter((t) => painted(label, t));
        for (const t of frames) {
          const plate = pieces.find((piece) => new RegExp(`^capsule:${cue.index}:w${hero}(cap|l80)$`).test(piece.id) && painted(piece, t));
          expect(plate, `cue ${cue.index} key word at ${t} (offset ${offset}) has no capsule`).toBeDefined();
          expect(evaluatePiece(plate!, t).o).toBe(1);
        }
        if (frames.length === 1) checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("the capsule and its word are opaque on every frame of the entrance, so a grey brand colour keeps 3:1 as drawn", () => {
    for (const primary of ["#949494", "#858585"]) {
      const { cues, pieces } = build(["so:m build:b it:m now:h@480", "today:h@560"], { colours: { ...colours, primary } });
      for (const cue of cues) {
        const hero = cue.words.findIndex((word) => word.role === "hero");
        const cap = pieces.find((piece) => piece.id === `capsule:${cue.index}:w${hero}cap`)!;
        const label = pieces.find((piece) => piece.id === `capsule:${cue.index}:w${hero}`)!;
        for (const t of exportFrameTimes(cap.fromMs, cue.words[hero]!.endMs, 30)) {
          expect(evaluatePiece(cap, t).o, `${cap.id} at ${t}`).toBe(1);
          expect(evaluatePiece(label, t).o, `${label.id} at ${t}`).toBe(1);
        }
      }
    }
  });

  test("the row above sits just over the capsule's real outline: a small gap at rest that stays open through the swing", () => {
    for (const line of ["so:m build:b it:m now:h@480", "the:m remote:b doesn't:h@300 work.:b", "still:b work?:h@300"]) {
      const { cues, pieces } = build([line]);
      const cue = cues[0]!;
      const hero = cue.words.findIndex((word) => word.role === "hero");
      const cap = pieces.find((piece) => piece.id === `capsule:0:w${hero}cap`)!;
      const rows = Array.from({ length: hero }, (_, w) => pieces.find((piece) => piece.id === `capsule:0:w${w}`)!);
      const gapAt = (t: number) => {
        const boxes = rows.map((row) => pieceBounds(row, t, fakeMeasure)!);
        const bottom = Math.max(...boxes.map((box) => box.y2));
        const x1 = Math.min(...boxes.map((box) => box.x1));
        const x2 = Math.max(...boxes.map((box) => box.x2));
        const under = outlineAt(cap, t).filter(([x]) => x >= x1 && x <= x2);
        let top = Math.min(...under.map(([, y]) => y)) - (cap.stroke?.widthPx ?? 0) / 2;
        // The burst's tip counts where it lies under the row (it is round: its points stay inside the circle of its scale).
        const burst = pieces.find((piece) => piece.id === `capsule:0:w${hero}burst` && painted(piece, t));
        if (burst?.kind === "shape") {
          const pose = evaluatePiece(burst, t);
          const r = pathBounds(burst.path).x2 * pose.sx;
          const dx = Math.max(0, x1 - pose.x, pose.x - x2);
          if (dx < r) top = Math.min(top, pose.y - Math.sqrt(r ** 2 - dx ** 2));
        }
        return top - bottom;
      };
      const rest = gapAt(settledAt(cue));
      expect(rest, line).toBeGreaterThan(0);
      expect(rest, line).toBeLessThan(0.45 * 86);
      for (let t = cap.fromMs; t < settledAt(cue); t += 10) expect(gapAt(t), `${line} at ${t}`).toBeGreaterThan(0);
    }
  });

  test("CONTEMPORANEOUSNESS and Abdominohysterectomy as a lone key word hold the floor after the fit, at 9:16 and 1:1", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      for (const word of ["CONTEMPORANEOUSNESS", "Abdominohysterectomy"]) {
        const { cues, pieces } = build([`${word}:h@900`], { canvas });
        const label = pieces.filter((piece) => /^capsule:0:w0(l\d+)?$/.test(piece.id) && piece.kind === "text");
        expect(label.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(word);
        for (const piece of label) expect(piece.kind === "text" && piece.sizePx, `${word} on ${canvas.width}x${canvas.height}`).toBeGreaterThanOrEqual(132 * 0.7 - 0.01);
        expectClean(pieces, cues[0]!, canvas);
      }
    }
  });

  test("a no-space CJK key word too long for a capsule is written on readable coral rows; a pathological one is bounded", () => {
    const token = "我们今天要学习如何做一个很好吃的蛋糕然后分享给我们的朋友们一起吃".repeat(3).slice(0, 90);
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }, { width: 1920, height: 1080 }]) {
      for (const role of ["h", "b"]) {
        const { cues, pieces } = build([`${token}:${role}@2000`], { language: "zh", canvas });
        const parts = own(pieces, 0).filter((piece) => /:w0(l\d+)?$/.test(piece.id) && piece.kind === "text");
        expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(token);
        for (const piece of parts) expect(piece.kind === "text" && piece.sizePx, `${role} on ${canvas.width}x${canvas.height}`).toBeGreaterThanOrEqual(136 * 0.62 * Math.min(1, canvas.width / 1080, canvas.height / 1080) - 0.01);
        if (role === "h") for (const piece of parts) expect(piece.kind === "text" && piece.fill).toBe("#F2472F");
        expectClean(pieces, cues[0]!, canvas);
      }
    }
    for (const length of [360, 768]) {
      const long = "我们今天要学习如何做一个很好吃的蛋糕".repeat(50).slice(0, length);
      for (const role of ["h", "b"]) {
        const { pieces } = build([`${long}:${role}@3000`], { language: "zh" });
        const parts = own(pieces, 0).filter((piece) => /:w0(l\d+)?$/.test(piece.id));
        expect(parts.length).toBeLessThanOrEqual(8);
        expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(long);
        expect(pieceCount(own(pieces, 0))).toBeLessThanOrEqual(150);
      }
    }
  });

  test("ordinary input with a long key word stays far under 150 drawn layers a cue, shadows counted", () => {
    const { pieces } = build(["so the real reason most people never get there:m extraordinarily:h@900"]);
    expect(pieceCount(own(pieces, 0))).toBeLessThanOrEqual(150);
    const nine = build(["so:m the:m real:b reason:b most:b people:h@520 never:b get:b there:m"]);
    expect(pieceCount(own(nine.pieces, 0))).toBeLessThanOrEqual(150);
  });

  test("words never move sideways once they paint, so neighbours never touch on a first frame", () => {
    const { cues, pieces } = build(["we:b will:b see:b", "so:m we:b will:b win:h@300"]);
    for (const cue of cues) {
      for (const [w] of cue.words.entries()) {
        const face = pieces.find((piece) => piece.id === `capsule:${cue.index}:w${w}`)!;
        if (face.kind !== "text") continue;
        expect(face.track.x, `${face.id}`).toHaveLength(1);
      }
      expectClean(pieces, cue);
    }
  });

  test("a word is opaque and in its slot on its spoken frame, even with its lead cut short", () => {
    const { cues, pieces } = build(["nobody:b is:m coming:b", "so:m build:b it:m now:h@480"], { cueGap: 0 });
    for (const cue of cues) {
      for (const [w, word] of cue.words.entries()) {
        const face = pieces.find((piece) => piece.id === `capsule:${cue.index}:w${w}`)!;
        if (face.kind !== "text" || face.origin) continue;
        const onset = exportFrameTimes(word.startMs, word.startMs + 100, 30)[0]!;
        const pose = evaluatePiece(face, onset);
        expect(pose.o, face.id).toBe(1);
        expect(pose.y, face.id).toBe(evaluatePiece(face, word.endMs).y);
      }
    }
  });

  test("a one-word cue hands off to the next without an empty frame; a real pause still fades", () => {
    const { cues, pieces } = build(["before:h@400", "after:b@400"], { cueGap: 400 });
    const start = cues[1]!.words[0]!.startMs;
    for (const t of exportFrameTimes(cues[0]!.words[0]!.startMs, start, 30)) {
      expect(pieces.some((piece) => isFace(piece) && piece.kind === "text" && painted(piece, t) && evaluatePiece(piece, t).o > 0.9), `empty frame at ${t}`).toBe(true);
    }
    // The last cue, with nothing after it, still fades out.
    const label = pieces.find((piece) => piece.id === "capsule:1:w0")!;
    expect(evaluatePiece(label, label.toMs - 1).o).toBeLessThan(0.5);
  });

  test("on a full exit the capsule, its stickers and the words rise together", () => {
    const { cues, pieces } = build(["so:m build:b it:m now:h@480"]);
    const cap = pieces.find((piece) => piece.id === "capsule:0:w3cap")!;
    const word = pieces.find((piece) => piece.id === "capsule:0:w0")!;
    const burst = pieces.find((piece) => piece.id === "capsule:0:w3burst")!;
    const rest = settledAt(cues[0]!);
    for (const piece of [cap, word, burst]) expect(evaluatePiece(piece, piece.toMs - 1).y, piece.id).toBeLessThan(evaluatePiece(piece, rest).y - 5);
  });

  test("two speakers at 2x on 16:9: the plain lane is never far larger than the key-word lane", () => {
    const { cues } = demoCues({ lines: ["so:m I:m quit:h@470 my:m job:b", "wait:b for:m real:b"], options: { lead: 357, gap: 0, cueGap: 0 } });
    const run = cues.map((cue, i) => ({ ...shift([cue], -i * 900)[0]!, speaker: i }));
    const pieces = capsuleProgram.build(sceneInput(run, { fps: 30, anchor, scale: 2, canvas: { width: 1920, height: 1080 } })).pieces;
    const sizes = (cue: number, hero: boolean) => own(pieces, cue).filter((piece) => piece.kind === "text" && (hero || !piece.origin)).map((piece) => (piece.kind === "text" ? piece.sizePx : 0));
    const keyLane = Math.min(...sizes(0, false));
    const plainLane = Math.max(...sizes(1, false));
    expect(plainLane / keyLane).toBeLessThanOrEqual(1.8);
  });

  test("NFC and NFD spell the same layout", () => {
    const nfc = build(["les:m élèves:b café:h@500 ensemble:b"]).pieces;
    const nfd = build(["les:m élèves:b café:h@500 ensemble:b".normalize("NFD")]).pieces;
    const key = (pieces: readonly Piece[]) => pieces.filter(isFace).map((piece) => [piece.id, piece.kind === "text" ? piece.sizePx : 0, evaluatePiece(piece, 3000).x].join());
    expect(key(nfd)).toEqual(key(nfc));
  });
});
