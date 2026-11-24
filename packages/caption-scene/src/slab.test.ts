import { describe, expect, test } from "bun:test";
import { captionSceneMeta, getCaptionPresetById } from "@narriflow/validators";
import { describeSpeechConformance, fastRun } from "./conformance-support";
import { type DemoScript, demoCues, sceneEdgeDemo } from "./demo";
import { EASES, prog } from "./ease";
import { exportFrameTimes } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Piece, SCENE_PIECE_BUDGET, evaluatePiece, pieceBounds, sceneBoundsAt } from "./scene";
import { fakeMeasure, sceneInput } from "./test-support";
import { SLAB_DEMO, slabProgram } from "./templates/slab";

describeSpeechConformance("slab", slabProgram, { anchorLineY: 1290 });

const COLOURS = { primary: "#FFFFFF", highlight: "#E8197A", accent: "#F5E642", shadow: "#000000" };
const build = (script: DemoScript | readonly SceneCue[], overrides: Parameters<typeof sceneInput>[1] = {}) => {
  const cues = Array.isArray(script) ? (script as readonly SceneCue[]) : demoCues(script as DemoScript).cues;
  return { cues, pieces: slabProgram.build(sceneInput(cues, { colours: COLOURS, anchor: { xPct: 50, yPct: (1290 / 1920) * 100 }, ...overrides })).pieces };
};
const piece = (pieces: readonly Piece[], id: string) => {
  const found = pieces.find((p) => p.id === id);
  if (!found) throw new Error(`no piece ${id}`);
  return found;
};
const outExpo = EASES.outExpo;
const cell = (text: string, size = 100) => text.length * (0.55 - 0.01) * size + 0.01 * size - 0.01 * size + 32;

describe("Slab", () => {
  test("the preset, the catalogue row and the brand map", () => {
    expect(getCaptionPresetById("slab")!.preset).toMatchObject({ scene: "slab", fontName: "Montserrat ExtraBold", wordsPerCue: 4, highlightColor: "#E8197A", accentColor: "#F5E642" });
    const meta = captionSceneMeta("slab");
    expect(meta.bodyPx).toBe(100);
    expect(meta.brand.primary?.readsOn).toContain("#101014");
    expect(meta.brand.secondary).toEqual({ slot: "highlightColor" });
  });

  test("a row is centred on the anchor: slabs touch, the face sits on the sample's baseline, the key slab is 4 px taller each side", () => {
    const { cues, pieces } = build({ lines: ["so:m start:b ugly:h@480"], options: { tail: 3000 } });
    const widths = ["SO", "START", "UGLY"].map((text) => cell(text));
    const total = widths.reduce((a, b) => a + b, 0);
    const left = 540 - total / 2;
    // The slab has not started to leave: that waits 150 ms after the row's last word.
    const t = cues[0]!.words[2]!.endMs + 100;
    const slabs = [0, 1, 2].map((k) => evaluatePiece(piece(pieces, `slab:0:w${k}s`), t));
    expect(slabs[0]!.x).toBeCloseTo(left, 3);
    expect(slabs[1]!.x).toBeCloseTo(left + widths[0]!, 3);
    // The hero slab pivots on its own centre (the kick), so compare its box edges.
    const heroBox = pieceBounds(piece(pieces, "slab:0:w2s"), t, fakeMeasure)!;
    expect(heroBox.x1).toBeCloseTo(left + widths[0]! + widths[1]!, 1);
    expect(heroBox.x2 - heroBox.x1).toBeCloseTo(widths[2]!, 1);
    const top = 1290 - 47;
    expect(heroBox.y1).toBeCloseTo(top - 4, 1);
    expect(heroBox.y2 - heroBox.y1).toBeCloseTo(94 + 8, 1);
    const firstBox = pieceBounds(piece(pieces, "slab:0:w0s"), t, fakeMeasure)!;
    expect(firstBox.y1).toBeCloseTo(top + 1, 1);
    expect(firstBox.y2 - firstBox.y1).toBeCloseTo(92, 1);
    const ink = evaluatePiece(piece(pieces, "slab:0:w0"), t);
    expect(ink.x).toBeCloseTo(left + 16, 3);
    expect(ink.y).toBeCloseTo(top + 83, 3);
  });

  test("the slab and the ink wipe on with the sample's windows, the ink 15 ms behind", () => {
    const { cues, pieces } = build({ lines: ["hello:b@400 world:b@400"], options: { tail: 3000 } });
    const S = cues[0]!.words[1]!.startMs;
    const slab = piece(pieces, "slab:0:w1s");
    const ink = piece(pieces, "slab:0:w1");
    const lo = evaluatePiece(slab, S + 1000).x;
    const W = cell("WORLD");
    for (const dt of [-60, -20, 20, 60, 95]) {
      expect(evaluatePiece(slab, S + dt).clip!.x2).toBeCloseTo(lo + W * outExpo(prog(S + dt, S - 95, 190)), 0);
      expect(evaluatePiece(ink, S + dt).clip!.x2).toBeCloseTo(lo + W * outExpo(prog(S + dt, S - 80, 170)), 0);
    }
    expect(evaluatePiece(slab, S - 95).clip!.x2 - evaluatePiece(slab, S - 95).clip!.x1).toBeLessThan(0.01);
    expect(evaluatePiece(ink, S + 200).clip!.x2).toBeCloseTo(lo + W, 3);
  });

  test("a line's slab retracts left to right 150 ms after its last word, over 230 ms; the key slab stays", () => {
    const { cues, pieces } = build({ lines: ["so:m start:b ugly:h@480"], options: { tail: 3000 } });
    const E = cues[0]!.words[1]!.endMs;
    const rowEnd = cues[0]!.words[2]!.endMs;
    const first = piece(pieces, "slab:0:w0s");
    const x0 = evaluatePiece(first, 4000).x;
    const widths = ["SO", "START", "UGLY"].map((text) => cell(text));
    const total = widths.reduce((a, b) => a + b, 0);
    const left = 540 - total / 2;
    const margin = 0.5 * 0.05 * total + 1;
    const at = rowEnd + 150;
    expect(E).toBeLessThan(rowEnd);
    // Before the retract the whole slab shows.
    expect(evaluatePiece(first, at - 1).clip!.x1).toBeCloseTo(x0, 3);
    // Halfway (inOut at 0.5) the front is half the row along.
    const half = left - margin + (total + margin) * 0.5;
    expect(evaluatePiece(piece(pieces, "slab:0:w1s"), at + 115).clip!.x1).toBeCloseTo(Math.min(Math.max(half, left + widths[0]!), left + widths[0]! + widths[1]!), 0);
    // The first cell is gone, its pieces have ended.
    expect(piece(pieces, "slab:0:w0s").toMs).toBeLessThan(at + 230);
    // The key slab and its ink are still there until the exit.
    expect(pieceBounds(piece(pieces, "slab:0:w2s"), at + 400, fakeMeasure)).not.toBeNull();
    expect(pieces.some((p) => p.id === "slab:0:w2b")).toBe(false);
    // The white text is under the slab until the front passes it, and it has the sample's two shadows.
    const base = piece(pieces, "slab:0:w0b");
    expect(base.fromMs).toBeCloseTo(at, 3);
    expect(base.shadows!.map((s) => [s.dy, s.blur])).toEqual([[5, 0], [8, 12]]);
  });

  test("the exit starts 200 ms before the cue's end but never before the last word's end plus 150 ms", () => {
    const { cues, pieces } = build({ lines: ["so:m start:b ugly:h@480"], options: { tail: 560 } });
    const E = cues[0]!.words[2]!.endMs;
    const end = cues[0]!.endMs;
    expect(end - 200).toBeGreaterThan(E + 150);
    const key = piece(pieces, "slab:0:w2s");
    const ink = piece(pieces, "slab:0:w2");
    const before = evaluatePiece(ink, end - 201).clip!;
    expect(before.x1).toBeLessThan(before.x2);
    const widths = ["SO", "START", "UGLY"].map((text) => cell(text));
    const left = 540 - widths.reduce((a, b) => a + b, 0) / 2;
    expect(evaluatePiece(ink, end - 201).clip!.x1).toBeLessThan(left + widths[0]! + widths[1]! + 1);
    // 85 ms later the wipe has passed everything.
    expect(pieceBounds(key, end - 200 + 90, fakeMeasure)).toBeNull();
    expect(key.toMs).toBeLessThanOrEqual(end);
    // A short tail: the exit waits for 150 ms of reading, then wipes in what time is left.
    const tight = build({ lines: ["so:m start:b ugly:h@480"], options: { tail: 300 } });
    const tightE = tight.cues[0]!.words[2]!.endMs;
    const tightInk = piece(tight.pieces, "slab:0:w2");
    const probe = evaluatePiece(tightInk, tightE + 149).clip!;
    expect(probe.x1).toBeLessThan(probe.x2);
    expect(tightInk.toMs).toBeLessThanOrEqual(tight.cues[0]!.endMs);
  });

  test("with no gap the next cue cuts the last: no exit, the incoming cue's lead is 0", () => {
    const { cues, pieces } = build({ lines: ["one:b two:b", "three:b four:h@300"], options: { gap: 0, cueGap: 0, lead: 400 } });
    const nextStart = cues[1]!.words[0]!.startMs;
    expect(cues[0]!.endMs).toBe(nextStart);
    const outgoing = pieces.filter((p) => p.id.startsWith("slab:0:"));
    const incoming = pieces.filter((p) => p.id.startsWith("slab:1:"));
    expect(Math.max(...outgoing.map((p) => p.toMs))).toBeLessThanOrEqual(nextStart);
    expect(Math.min(...incoming.map((p) => p.fromMs))).toBeCloseTo(nextStart, 3);
  });

  test("a roomy gap gives the incoming cue its 95 ms lead and the outgoing cue its exit", () => {
    const { cues, pieces } = build({ lines: ["one:b two:b", "three:b four:h@300"], options: { gap: 0, cueGap: 800, lead: 400, tail: 800 } });
    const nextStart = cues[1]!.words[0]!.startMs;
    expect(Math.min(...pieces.filter((p) => p.id.startsWith("slab:1:")).map((p) => p.fromMs))).toBeCloseTo(nextStart - 95, 3);
    const E = cues[0]!.words[1]!.endMs;
    const exiting = piece(pieces, "slab:0:w1");
    expect(exiting.toMs).toBeGreaterThan(E + 150);
    expect(exiting.toMs).toBeLessThan(nextStart - 95 + 1);
  });

  test("the key colour is a counter over highlight, accent, mint and blue; the ink on it comes from contrast", () => {
    const lines = Array.from({ length: 9 }, () => "some:b words:h@300");
    const { pieces } = build({ lines, options: { tail: 700, cueGap: 500 } });
    const fills = lines.map((_, n) => (piece(pieces, `slab:${n}:w1s`) as Extract<Piece, { kind: "shape" }>).fill!.colour);
    const palette = ["#E8197A", "#F5E642", "#7CF0C8", "#4C6CF5"];
    expect(fills).toEqual(lines.map((_, n) => palette[n % 4]!));
    const ink = lines.map((_, n) => (piece(pieces, `slab:${n}:w1`) as Extract<Piece, { kind: "text" }>).fill);
    expect(ink.slice(0, 4)).toEqual(["#FFFFFF", "#101014", "#101014", "#FFFFFF"]);
    // A brand colour in the highlight slot leads the cycle and gets a readable ink.
    const brand = build({ lines: ["some:b words:h@300"] }, { colours: { ...COLOURS, highlight: "#F39A1E" } });
    expect((piece(brand.pieces, "slab:0:w1s") as Extract<Piece, { kind: "shape" }>).fill!.colour).toBe("#F39A1E");
    expect((piece(brand.pieces, "slab:0:w1") as Extract<Piece, { kind: "text" }>).fill).toBe("#101014");
  });

  test("the key slab lands hot and kicks to 105 % and back; slab, flash and ink share one pivot", () => {
    const { cues, pieces } = build({ lines: ["so:m start:b ugly:h@600"], options: { tail: 3000 } });
    const S = cues[0]!.words[2]!.startMs;
    const landing = S + 95;
    const slab = piece(pieces, "slab:0:w2s");
    const ink = piece(pieces, "slab:0:w2");
    const flash = piece(pieces, "slab:0:w2f");
    expect(evaluatePiece(slab, landing - 5).sx).toBe(1);
    const peak = evaluatePiece(slab, landing + 70);
    expect(peak.sx).toBeCloseTo(1.05, 3);
    expect(evaluatePiece(ink, landing + 70).sx).toBeCloseTo(1.05, 3);
    expect(evaluatePiece(flash, landing + 70).sx).toBeCloseTo(1.05, 3);
    expect(evaluatePiece(slab, landing + 250).sx).toBeCloseTo(1, 6);
    expect(evaluatePiece(slab, landing + 70).x).toBe(evaluatePiece(ink, landing + 70).x);
    expect(evaluatePiece(slab, landing + 70).y).toBe(evaluatePiece(flash, landing + 70).y);
    expect(evaluatePiece(flash, landing).o).toBeCloseTo(0.55, 3);
    expect(evaluatePiece(flash, landing + 160 - 1).o).toBeLessThan(0.01);
    expect(flash.toMs).toBeLessThanOrEqual(landing + 161);
  });

  test("a 24-cue clip: every cue keeps its rule, every hero cue its flash, bullets and scan bars recur; no table runs out", () => {
    const lines = Array.from({ length: 24 }, (_, n) => SLAB_DEMO.lines[n % SLAB_DEMO.lines.length]!);
    const { cues, pieces } = build({ lines, options: { rate: 205, gap: 25, cueGap: 700, tail: 800, lead: 300 } });
    const ofKind = (kind: string) => pieces.filter((p) => p.id.split(":")[2]!.startsWith(kind));
    const cuesWith = (kind: string) => new Set(ofKind(kind).map((p) => p.id.split(":")[1]));
    expect(cuesWith("rule").size).toBe(cues.length);
    const heroCues = cues.flatMap((cue, n) => (cue.words.some((word) => word.role === "hero") ? [String(n)] : []));
    const flashed = new Set(pieces.filter((p) => /^slab:\d+:w\d+f$/.test(p.id)).map((p) => p.id.split(":")[1]));
    expect([...flashed].sort()).toEqual([...heroCues].sort());
    expect(cuesWith("bullet").size).toBeGreaterThanOrEqual(cues.length - 4);
    expect(cuesWith("scan").size).toBeGreaterThanOrEqual(cues.length - 4);
    // The rule's width cycles: full, then two short ones on opposite sides.
    const rules = [0, 1, 2].map((n) => pieceBounds(piece(pieces, `slab:${n}:rule`), cues[n]!.endMs - 400, fakeMeasure)!);
    expect(rules[0]!.x2 - rules[0]!.x1).toBeGreaterThan(rules[1]!.x2 - rules[1]!.x1);
    expect(rules[1]!.x2 - rules[1]!.x1).not.toBeCloseTo(rules[2]!.x2 - rules[2]!.x1, 3);
    // The bullet turns into a diamond on every other cue.
    expect(evaluatePiece(piece(pieces, "slab:0:bullet"), cues[0]!.endMs - 400).rz).toBe(0);
    expect(evaluatePiece(piece(pieces, "slab:1:bullet"), cues[1]!.endMs - 400).rz).toBe(45);
  });

  test("the rule wipes in from the side the slabs do not come from; RTL mirrors every wipe", () => {
    const ltr = build({ lines: ["so:m start:b ugly:h@480"], options: { tail: 3000 } });
    const rule = piece(ltr.pieces, "slab:0:rule");
    const c = evaluatePiece(rule, ltr.cues[0]!.words[2]!.startMs + 20).clip!;
    const settled = evaluatePiece(rule, 4000).clip!;
    // Grows from the right: the right edge is fixed, the left edge moves left.
    expect(c.x2).toBeCloseTo(settled.x2, 3);
    expect(c.x1).toBeGreaterThan(settled.x1);
    const urdu = sceneEdgeDemo("urdu");
    const rtl = slabProgram.build(sceneInput(urdu.cues, { colours: COLOURS })).pieces;
    const first = evaluatePiece(piece(rtl, "slab:0:w0s"), 3000);
    const second = evaluatePiece(piece(rtl, "slab:0:w1s"), 3000);
    expect(first.x).toBeGreaterThan(second.x);
    // The staircase grows from the right edge of the first word's cell.
    const midway = evaluatePiece(piece(rtl, "slab:0:w0s"), urdu.cues[0]!.words[0]!.startMs + 20).clip!;
    const full = evaluatePiece(piece(rtl, "slab:0:w0s"), 3000).clip!;
    expect(midway.x2).toBeCloseTo(full.x2, 3);
    expect(midway.x1).toBeGreaterThan(full.x1);
    // Shaped text is never tracked and is drawn whole, one piece per word.
    const faces = rtl.filter((p) => p.kind === "text" && /^slab:\d+:w\d+$/.test(p.id));
    expect(faces).toHaveLength(urdu.cues.reduce((sum, cue) => sum + cue.words.length, 0));
    expect(faces.every((p) => p.kind === "text" && p.letterSpacingEm === 0)).toBe(true);
  });

  test("case follows the cue's language and only cased scripts change", () => {
    const turkish = build({ lines: ["istanbul:h@500"], language: "tr" });
    const face = piece(turkish.pieces, "slab:0:w0");
    expect(face.kind === "text" && face.text).toBe("İSTANBUL");
    const urdu = sceneEdgeDemo("urdu");
    const faces = slabProgram.build(sceneInput(urdu.cues)).pieces.filter((p) => p.kind === "text" && /^slab:0:w\d+$/.test(p.id));
    const byWord = [...faces].sort((a, b) => Number(a.id.split(":w")[1]) - Number(b.id.split(":w")[1]));
    expect(byWord.map((p) => (p.kind === "text" ? p.text : ""))).toEqual(urdu.cues[0]!.words.map((word) => word.text));
  });

  test("a word wider than the safe area, or a tall block, shrinks every row together", () => {
    const long = sceneEdgeDemo("long-word");
    const pieces = slabProgram.build(sceneInput(long.cues, { colours: COLOURS })).pieces;
    const sizes = new Set(pieces.filter((p) => p.kind === "text" && p.id.startsWith("slab:0:w") && /^slab:0:w\d+$/.test(p.id)).map((p) => (p.kind === "text" ? p.sizePx : 0)));
    expect(sizes.size).toBe(1);
    const huge = pieces.filter((p) => p.id.startsWith("slab:1:w") && p.id.endsWith("s"));
    for (const slab of huge) {
      const box = pieceBounds(slab, 3200, fakeMeasure)!;
      expect(box.x1).toBeGreaterThanOrEqual(1080 * 0.05 - 1);
      expect(box.x2).toBeLessThanOrEqual(1080 * 0.95 + 1);
    }
    const nine = sceneEdgeDemo("nine-words");
    const nineSizes = slabProgram.build(sceneInput(nine.cues, { scale: 2 })).pieces.filter((p) => p.kind === "text" && /^slab:0:w\d+$/.test(p.id));
    expect(new Set(nineSizes.map((p) => (p.kind === "text" ? p.sizePx : 0))).size).toBe(1);
  });

  test("overlapping speakers: the later cue stacks in free space and both stay readable", () => {
    const { cues } = demoCues({ lines: ["first:b@400 second:b@400 third:b@400", "other:b@400 speaker:b@400"], options: { lead: 357, gap: 0, cueGap: 0 } });
    const run: SceneCue[] = cues.map((cue, i) => {
      const by = i === 0 ? 0 : 357 + 450 - cue.startMs;
      return { ...cue, speaker: i, startMs: cue.startMs + by, endMs: cue.endMs + by, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + by, endMs: word.endMs + by })) };
    });
    const { pieces } = build(run);
    const a = sceneBoundsAt(pieces.filter((p) => p.id.startsWith("slab:0:")), 357 + 900, fakeMeasure)!;
    const b = sceneBoundsAt(pieces.filter((p) => p.id.startsWith("slab:1:")), 357 + 900, fakeMeasure)!;
    expect(a.y2 <= b.y1 || b.y2 <= a.y1).toBe(true);
    // Neither is cut at the other's start.
    expect(piece(pieces, "slab:0:w2").toMs).toBeGreaterThanOrEqual(run[0]!.words[2]!.endMs);
  });

  test("every cue stays inside the piece budget, shadows included", () => {
    const nine = sceneEdgeDemo("nine-words");
    const { pieces } = build(nine.cues);
    for (let n = 0; n < nine.cues.length; n++) {
      const group = pieces.filter((p) => p.id.split(":")[1] === String(n));
      expect(group.reduce((sum, p) => sum + 1 + (p.shadows?.length ?? 0), 0)).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
    }
  });

  test("a 100 ms hero at 150 ms words still animates its entrance on two painted frames at every rate", () => {
    for (const fps of [24, 30, 60]) {
      const run = fastRun(60);
      const { pieces } = build(run, { fps });
      for (const cue of run) {
        const slab = piece(pieces, `slab:${cue.index}:w0s`);
        const painted = exportFrameTimes(slab.fromMs, slab.toMs, fps).filter((t) => {
          const pose = evaluatePiece(slab, t);
          return pose.visible && pose.clip && pose.clip.x2 - pose.clip.x1 > 0.01;
        });
        const poses = new Set(painted.map((t) => evaluatePiece(slab, t).clip!.x2.toFixed(2)));
        expect(poses.size, `${fps} fps cue ${cue.index}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
