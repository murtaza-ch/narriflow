import { describe, expect, test } from "bun:test";
import { describeSpeechConformance, fastRun, staccatoRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes, paintedFrameCount } from "./frame-grid";
import type { SceneCue } from "./input";
import { type Box, evaluatePiece, type Piece, pieceBounds } from "./scene";
import { SPLAT_DEMO, splatProgram } from "./templates/splat";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("splat", splatProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFFFFF", highlight: "#FFE11A", accent: "#FF4FC3", shadow: "#000000" };
const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };

const build = (lines: string[], options: Record<string, number> = {}, language?: string, extra: Record<string, unknown> = {}) => {
  const { cues } = demoCues({ lines, language, options: { lead: 400, gap: 30, cueGap: 140, tail: 800, ...options } });
  return { cues, pieces: splatProgram.build(sceneInput(cues, { fps: 30, colours, anchor, ...extra })).pieces };
};
const isFace = (cue: number) => new RegExp(`^splat:${cue}:w\\d+(l\\d+)?$`);
const wordOf = (piece: Piece) => Number(/:w(\d+)/.exec(piece.id)![1]);
const meets = (a: Box, b: Box) => a.x1 + 0.5 < b.x2 && b.x1 + 0.5 < a.x2 && a.y1 + 0.5 < b.y2 && b.y1 + 0.5 < a.y2;
const box = (piece: Piece, t: number) => pieceBounds(piece, t, fakeMeasure);
const unionOf = (boxes: readonly Box[]): Box => ({
  x1: Math.min(...boxes.map((b) => b.x1)), y1: Math.min(...boxes.map((b) => b.y1)),
  x2: Math.max(...boxes.map((b) => b.x2)), y2: Math.max(...boxes.map((b) => b.y2)),
});
const safe = { x1: 54, y1: 96, x2: 1026, y2: 1824 };
const inside = (b: Box) => b.x1 >= safe.x1 - 1 && b.y1 >= safe.y1 - 1 && b.x2 <= safe.x2 + 1 && b.y2 <= safe.y2 + 1;

/** At the cue's rest (its last word settled), its words' painted boxes and its decorations' boxes. */
function restOf(pieces: readonly Piece[], cue: SceneCue) {
  const t = cue.words.at(-1)!.startMs + 330;
  const own = pieces.filter((piece) => piece.id.startsWith(`splat:${cue.index}:`) && piece.fromMs <= t && piece.toMs > t);
  const faces = own.filter((piece) => isFace(cue.index).test(piece.id));
  const decorations = own.filter((piece) => piece.kind === "shape");
  return { t, faces, decorations };
}

/** No two words of a cue overlap at rest, and no doodle or spatter dot touches any word at rest. */
function expectClear(pieces: readonly Piece[], cues: readonly SceneCue[]) {
  for (const cue of cues) {
    const { t, faces, decorations } = restOf(pieces, cue);
    const words = [...new Set(faces.map(wordOf))].map((w) => ({ w, box: unionOf(faces.filter((f) => wordOf(f) === w).map((f) => box(f, t)!)) }));
    for (const [i, a] of words.entries()) {
      expect(inside(a.box), `cue ${cue.index} word ${a.w} inside ${JSON.stringify(a.box)}`).toBe(true);
      for (const b of words.slice(i + 1)) expect(meets(a.box, b.box), `cue ${cue.index}: words ${a.w} and ${b.w} overlap`).toBe(false);
    }
    for (const piece of decorations) {
      const b = box(piece, t);
      if (!b) continue;
      expect(inside(b), `${piece.id} inside`).toBe(true);
      if (/:blob/.test(piece.id)) continue;
      for (const word of words) expect(meets(b, word.box), `${piece.id} touches word ${word.w}`).toBe(false);
    }
  }
}

describe("splat", () => {
  test("every word paints whole and opaque on its spoken start, and the key word's letters all paint at its onset", () => {
    const { cues, pieces } = build(SPLAT_DEMO.lines);
    for (const cue of cues) {
      for (const [w, word] of cue.words.entries()) {
        const faces = pieces.filter((piece) => new RegExp(`^splat:${cue.index}:w${w}(l\\d+)?$`).test(piece.id));
        expect(faces.length, `cue ${cue.index} word ${w}`).toBeGreaterThan(0);
        for (const face of faces) {
          expect(face.fromMs).toBe(faces[0]!.fromMs);
          expect(face.fromMs).toBeGreaterThanOrEqual(word.startMs);
          const pose = evaluatePiece(face, face.fromMs);
          expect(pose.o).toBe(1);
          expect(pose.sx).toBeGreaterThanOrEqual(0.55);
        }
      }
    }
    // INSANE pops letter by letter: six letters, each with an outline copy drawn under every face.
    const letters = pieces.filter((piece) => /^splat:0:w3l\d$/.test(piece.id));
    const outlines = pieces.filter((piece) => /^splat:0:w3l\do$/.test(piece.id));
    expect(letters).toHaveLength(6);
    expect(outlines).toHaveLength(6);
    expect(Math.max(...outlines.map((piece) => piece.z))).toBeLessThan(Math.min(...letters.map((piece) => piece.z)));
    expect(letters.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe("INSANE");
  });

  test("the key word's letters pop out of order and settle into a crooked lockup", () => {
    const { cues, pieces } = build(["game:b day:h@520", "absolutely:h@700"]);
    const letters = pieces.filter((piece) => /^splat:1:w0l\d+$/.test(piece.id));
    expect(letters).toHaveLength(10);
    const start = cues[1]!.words[0]!.startMs;
    // The pops are staggered: at 40 ms the letters are at different stages, and not in reading order.
    const scales = letters.map((piece) => evaluatePiece(piece, start + 40).sx);
    expect(new Set(scales.map((v) => v.toFixed(3))).size).toBeGreaterThan(3);
    const sorted = [...scales].sort((a, b) => b - a);
    expect(scales).not.toEqual(sorted);
    // At rest: different sizes and turns, all near full size.
    const rest = letters.map((piece) => evaluatePiece(piece, start + 600));
    expect(new Set(rest.map((pose) => Math.round(pose.rz))).size).toBeGreaterThan(2);
    for (const pose of rest) {
      expect(pose.sx).toBeGreaterThan(0.94);
      expect(pose.sx).toBeLessThan(1.06);
      expect(Math.abs(pose.rz)).toBeLessThanOrEqual(4.01);
    }
  });

  test("a row's first word sits centred until the next lands, then the row eases into its final slots", () => {
    const { cues, pieces } = build(["no:b way:b"]);
    const [no, way] = cues[0]!.words;
    const centreX = (id: string, t: number) => {
      const b = box(pieces.find((piece) => piece.id === id)!, t)!;
      return (b.x1 + b.x2) / 2;
    };
    expect(Math.abs(centreX("splat:0:w0", no!.startMs + 150) - 540)).toBeLessThan(12);
    const settled = way!.startMs + 400;
    const left = centreX("splat:0:w0", settled);
    const right = centreX("splat:0:w1", settled);
    expect(left).toBeLessThan(540);
    expect(Math.abs((left + right) / 2 - 540)).toBeLessThan(40);
  });

  test("every key word gets two splats of two colours behind it, cycling looks by key-word count; plain cues get none", () => {
    const { cues, pieces } = build(SPLAT_DEMO.lines);
    const heroCues = cues.filter((cue) => cue.words.some((word) => word.role === "hero"));
    const fronts: string[] = [];
    for (const cue of cues) {
      const blobs = pieces.filter((piece) => piece.id.startsWith(`splat:${cue.index}:blob`));
      if (!cue.words.some((word) => word.role === "hero")) {
        expect(blobs, `cue ${cue.index}`).toHaveLength(0);
        continue;
      }
      expect(blobs.map((piece) => piece.id.split(":")[2]).sort()).toEqual(["blobB", "blobF"]);
      const [back, front] = ["blobB", "blobF"].map((id) => blobs.find((piece) => piece.id.endsWith(id))!);
      expect(back!.z).toBeLessThan(front!.z);
      const colourOf = (piece: Piece) => (piece.kind === "shape" ? piece.fill!.colour : "");
      expect(colourOf(back!)).not.toBe(colourOf(front!));
      fronts.push(colourOf(front!));
      // Behind every face, and the front starts with the key word, never before it.
      const hero = cue.words.find((word) => word.role === "hero")!;
      expect(front!.fromMs).toBeGreaterThanOrEqual(hero.startMs);
      expect(back!.fromMs).toBeGreaterThan(front!.fromMs);
      for (const face of pieces.filter((piece) => isFace(cue.index).test(piece.id))) expect(face.z).toBeGreaterThan(front!.z);
    }
    expect(heroCues).toHaveLength(4);
    expect(fronts[0]).toBe("#FF4FC3");
    expect(fronts[1]).toBe("#2F7CFF");
    expect(fronts[3]).toBe(fronts[0]);
  });

  test("a splat is one path of round lobes; a wide key word gets more lobes, not stretched ones", () => {
    const { pieces } = build(["day:h@600", "incredible:h@600"]);
    const lobes = (cue: number) => {
      const front = pieces.find((piece) => piece.id === `splat:${cue}:blobF`)!;
      return front.kind === "shape" ? front.path.filter((cmd) => cmd[0] === "M").length : 0;
    };
    expect(lobes(0)).toBeGreaterThanOrEqual(7);
    expect(lobes(1)).toBeGreaterThan(lobes(0));
  });

  test("doodles boil in three poses swapped every 125 ms on the export grid, capped, inside their cue, never on a word", () => {
    const { cues, pieces } = build(["wait:b this:m is:m insane:h@520", "no:b way:b", "game:b day:h@3000"]);
    for (const cue of cues) {
      const doodles = pieces.filter((piece) => new RegExp(`^splat:${cue.index}:dd\\d+p\\d+$`).test(piece.id));
      expect(doodles.length, `cue ${cue.index}`).toBeGreaterThan(0);
      const cueEnd = Math.max(...pieces.filter((piece) => isFace(cue.index).test(piece.id)).map((piece) => piece.toMs));
      const byDoodle = new Map<string, Piece[]>();
      for (const piece of doodles) {
        const key = piece.id.replace(/p\d+$/, "");
        byDoodle.set(key, [...(byDoodle.get(key) ?? []), piece]);
        expect(piece.toMs).toBeLessThanOrEqual(cueEnd);
        expect(paintedFrameCount(piece.fromMs, piece.toMs, 30)).toBeGreaterThanOrEqual(2);
        expect(piece.kind === "shape" && piece.stroke?.colour).toBe("#FFFFFF");
      }
      for (const list of byDoodle.values()) {
        expect(list.length).toBeLessThanOrEqual(16);
        list.sort((a, b) => a.fromMs - b.fromMs);
        for (let j = 1; j < list.length; j++) {
          expect(list[j]!.fromMs).toBe(list[j - 1]!.toMs);
          // 125 ms snapped to the 30 fps grid: three or four frames each, eight swaps a second on average.
          if (j < list.length - 1) expect(list[j]!.fromMs - list[j - 1]!.fromMs).toBeGreaterThanOrEqual(99);
        }
        if (list.length >= 6) expect((list[5]!.fromMs - list[0]!.fromMs) / 5).toBeCloseTo(125, -1);
        const paths = new Set(list.map((piece) => (piece.kind === "shape" ? JSON.stringify(piece.path) : "")));
        if (list.length >= 3) expect(paths.size).toBe(3);
      }
    }
    expect(pieces.filter((piece) => /^splat:0:dd\d+p0$/.test(piece.id)).length).toBeGreaterThanOrEqual(2);
    expect(pieces.filter((piece) => /^splat:1:dd\d+p0$/.test(piece.id))).toHaveLength(1);
    // The long hold caps its swaps: 16, the last one holding still to the end.
    const long = pieces.filter((piece) => /^splat:2:dd0p\d+$/.test(piece.id));
    expect(long).toHaveLength(16);
    expectClear(pieces, cues);
  });

  test("every cue flicks paint spatter and squishes: the recurring beats fire on ordinary speech", () => {
    const { cues, pieces } = build(SPLAT_DEMO.lines);
    let squishes = 0;
    for (const cue of cues) {
      const dots = pieces.filter((piece) => new RegExp(`^splat:${cue.index}:dot\\d$`).test(piece.id));
      expect(dots.length, `cue ${cue.index}`).toBeGreaterThanOrEqual(2);
      const shaped = pieces.filter((piece) => piece.id.startsWith(`splat:${cue.index}:`));
      const squished = shaped.some((piece) => {
        const sx = piece.track.sx ?? [];
        const sy = piece.track.sy ?? [];
        return sx.some((frame, k) => Math.abs(frame[1] - (sy[k]?.[1] ?? frame[1])) > 0.03);
      });
      if (squished) squishes++;
    }
    expect(squishes).toBeGreaterThanOrEqual(cues.length - 1);
    expectClear(pieces, cues);
  });

  test("the words stay opaque to the end and shrink into the block while the paint recoils; nothing outlives the cue", () => {
    const { cues, pieces } = build(["game:b day:h@520", "very:b nice:h@480"], { cueGap: 700 });
    const own = pieces.filter((piece) => piece.id.startsWith("splat:0:"));
    const end = Math.max(...own.map((piece) => piece.toMs));
    expect(end).toBeLessThanOrEqual(cues[1]!.words[0]!.startMs);
    const face = own.find((piece) => piece.id === "splat:0:w0")!;
    expect(evaluatePiece(face, end - 5).o).toBe(1);
    expect(evaluatePiece(face, end - 5).sx).toBeLessThan(0.97);
    const front = own.find((piece) => piece.id === "splat:0:blobF")!;
    const scales = exportFrameTimes(end - 110, end, 60).map((t) => evaluatePiece(front, t).sx);
    expect(Math.max(...scales)).toBeGreaterThan(1.03);
    expect(scales.at(-1)!).toBeLessThan(0.5);
  });

  test("brand colours replace white, yellow and pink, and a colour too dark for the outline falls back", () => {
    const run = (primary: string, highlight: string) => {
      const { pieces } = build(["just:b start:b now:h@500"], {}, undefined, { colours: { ...colours, primary, highlight } });
      return pieces;
    };
    const fillOf = (pieces: Piece[], id: string) => evaluatePiece(pieces.find((piece) => piece.id === id)!, 5000).colour;
    const bright = run("#7CFFB2", "#FFB347");
    expect(fillOf(bright, "splat:0:w2l0")).toBe("#FFB347");
    const dark = run("#1A0A40", "#220022");
    expect(fillOf(dark, "splat:0:w2l0")).toBe("#FFE11A");
    expect([fillOf(dark, "splat:0:w0"), fillOf(dark, "splat:0:w1")]).toContain("#FFFFFF");
  });

  test("a Devanagari cue with a key word pops it whole, rows inside the band and clear of the splat's doodles", () => {
    const { cues, pieces } = build(["यह:b बहुत:m ज़रूरी:h@600 है:b"], {}, "hi");
    expect(pieces.filter((piece) => /^splat:0:w2l\d+$/.test(piece.id))).toHaveLength(0);
    expect(pieces.some((piece) => piece.id === "splat:0:w2")).toBe(true);
    expect(pieces.some((piece) => piece.id === "splat:0:blobF")).toBe(true);
    expectClear(pieces, cues);
  });

  test("an Urdu cue runs right to left with its key word whole and backed by the splat", () => {
    const { cues, pieces } = build(["یہ:b بہت:m زبردست:h@600 ہے:b"], {}, "ur");
    const t = cues[0]!.words.at(-1)!.startMs + 330;
    const centre = (w: number) => {
      const b = box(pieces.find((piece) => piece.id === `splat:0:w${w}`)!, t)!;
      return { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
    };
    // The first two words share a row, read right to left.
    expect(Math.abs(centre(0).y - centre(1).y)).toBeLessThan(5);
    expect(centre(0).x).toBeGreaterThan(centre(1).x);
    expect(pieces.filter((piece) => /^splat:0:w2l\d+$/.test(piece.id))).toHaveLength(0);
    expect(pieces.some((piece) => piece.id === "splat:0:blobF")).toBe(true);
    expectClear(pieces, cues);
  });

  test("a CJK cue with no spaces wraps into rows at a readable size instead of shrinking", () => {
    const text = "今日は本当に素晴らしい一日でしたね皆さんありがとうございました";
    const { cues, pieces } = build([`${text}:b@2400`], {}, "ja");
    const parts = pieces.filter((piece) => /^splat:0:w0(l\d+)?$/.test(piece.id) && piece.kind === "text");
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(text);
    for (const piece of parts) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(0.66 * 138 - 0.5);
    expectClear(pieces, cues);
  });

  test("accented Latin with digits keeps its accents in caps, pops letter by letter as a key word, and stays clear", () => {
    const { cues, pieces } = build(["à:m 20h:b café:b déjà:h@600"], {}, "fr");
    const letters = pieces.filter((piece) => /^splat:0:w3l\d$/.test(piece.id));
    expect(letters.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe("DÉJÀ");
    expect(pieces.find((piece) => piece.id === "splat:0:w1")!.kind === "text" && (pieces.find((piece) => piece.id === "splat:0:w1") as { text: string }).text).toBe("20H");
    expectClear(pieces, cues);
  });

  test("doodles placed at the frame's edge never make the cue shrink to fit (a long key word with a lane-wide splat)", () => {
    for (const line of ["of:m them:m are:m unplugged.:h@480", "to:m accidentally:b open:b them.:b", "is:m it:m incredible:h@600"]) {
      const { pieces } = build([line]);
      // The key words here pop letter by letter, so the whole-word faces are the body words.
      const body = pieces.filter((piece) => piece.kind === "text" && /^splat:0:w\d+$/.test(piece.id));
      expect(body.length).toBeGreaterThanOrEqual(2);
      for (const piece of body) expect(piece.kind === "text" && piece.sizePx, `${line}: ${piece.id}`).toBeGreaterThanOrEqual(0.85 * 118);
      expectClear(pieces, demoCues({ lines: [line], options: { lead: 400, gap: 30, cueGap: 140, tail: 800 } }).cues);
    }
  });

  test("a long word and nine words fit the band at a readable size, on 9:16 and 16:9", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      for (const name of ["long-word", "nine-words"] as const) {
        const { cues } = sceneEdgeDemo(name);
        const pieces = splatProgram.build(sceneInput(cues, { fps: 30, colours, anchor, canvas })).pieces;
        const sizes = pieces.filter((piece) => piece.kind === "text" && /:w\d+(l\d+)?$/.test(piece.id)).map((piece) => (piece.kind === "text" ? piece.sizePx : 0));
        expect(Math.min(...sizes), `${name} ${canvas.width}`).toBeGreaterThanOrEqual(canvas.width > canvas.height ? 40 : 60);
      }
    }
  });

  test("a whole run of cues keeps cycling: the doodle kinds and splat looks change, and no cue repeats the previous one's doodles", () => {
    const lines = Array.from({ length: 12 }, (_, i) => (i % 2 ? `so:b here:m it:b is:h@400` : `we:m keep:b going:b`));
    const { pieces } = build(lines, { cueGap: 80 });
    const fronts = new Set(pieces.filter((piece) => piece.id.endsWith(":blobF")).map((piece) => (piece.kind === "shape" ? piece.fill!.colour : "")));
    expect(fronts.size).toBe(3);
    const firstPoses = (cue: number) => pieces.filter((piece) => new RegExp(`^splat:${cue}:dd\\d+p0$`).test(piece.id)).map((piece) => JSON.stringify(piece.kind === "shape" ? piece.path : "")).join("|");
    for (let cue = 1; cue < 12; cue++) expect(firstPoses(cue)).not.toBe(firstPoses(cue - 1));
  });
});

describe("splat: wave 7 review checks", () => {
  const facesOf = (pieces: readonly Piece[], cue: number) => pieces.filter((piece) => isFace(cue).test(piece.id));

  test("entrance poses keep clear: on every export frame no two words of a cue meet, and no doodle or dot touches a word", () => {
    for (const cues of [demoCues({ lines: SPLAT_DEMO.lines, options: SPLAT_DEMO.options }).cues, fastRun(0), fastRun(60)]) {
      for (const fps of [25, 30, 60]) {
        const pieces = splatProgram.build(sceneInput(cues, { fps, colours, anchor })).pieces;
        for (const cue of cues) {
          const faces = facesOf(pieces, cue.index);
          const shapes = pieces.filter((piece) => piece.id.startsWith(`splat:${cue.index}:`) && piece.kind === "shape" && !/:blob/.test(piece.id));
          const from = Math.min(...faces.map((piece) => piece.fromMs));
          const to = Math.max(...faces.map((piece) => piece.toMs));
          for (const t of exportFrameTimes(from, to, fps)) {
            const words = new Map<number, Box[]>();
            for (const face of faces) {
              const b = box(face, t);
              if (b) words.set(wordOf(face), [...(words.get(wordOf(face)) ?? []), b]);
            }
            const list = [...words].map(([w, boxes]) => ({ w, box: unionOf(boxes) }));
            for (const [i, a] of list.entries()) {
              for (const b of list.slice(i + 1)) expect(meets(a.box, b.box), `fps ${fps} cue ${cue.index} t ${t}: words ${a.w} and ${b.w}`).toBe(false);
            }
            for (const shape of shapes) {
              const b = box(shape, t);
              if (!b) continue;
              for (const word of list) expect(meets(b, word.box), `fps ${fps} cue ${cue.index} t ${t}: ${shape.id} on word ${word.w}`).toBe(false);
            }
          }
        }
      }
    }
  });

  test("a one-frame key word is drawn whole with its own outline, so the two-frame filter cannot strip its edge", () => {
    let oneFrameHeroes = 0;
    for (const fps of [24, 25, 30]) {
      for (const offset of [0, 7, 23]) {
        const cues = staccatoRun(0).map((cue) => ({ ...cue, startMs: cue.startMs + offset, endMs: cue.endMs + offset, words: cue.words.map((word) => ({ ...word, startMs: word.startMs + offset, endMs: word.endMs + offset })) }));
        const pieces = splatProgram.build(sceneInput(cues, { fps, colours, anchor })).pieces;
        for (const face of pieces.filter((piece) => /^splat:\d+:w\d+(l\d+)?$/.test(piece.id))) {
          const frames = exportFrameTimes(face.fromMs, face.toMs, fps).filter((t) => box(face, t));
          if (frames.length >= 2) continue;
          // A face that paints once must carry its outline itself.
          expect(face.kind === "text" && face.stroke?.widthPx, `${face.id} at ${fps} fps`).toBeGreaterThan(0);
          expect(/l\d+$/.test(face.id), `${face.id} is a lone letter`).toBe(false);
        }
        // A 40 ms key word cut by the next cue paints once: it is one whole piece with its outline.
        const { cues: blip } = demoCues({ lines: ["wow:h@40", "next:b@300"], options: { lead: 400 + offset, gap: 0, cueGap: 0, tail: 300 } });
        const blipPieces = splatProgram.build(sceneInput(blip, { fps, colours, anchor })).pieces;
        const wow = blipPieces.filter((piece) => /^splat:0:w0(l\d+)?$/.test(piece.id));
        if (wow.some((piece) => exportFrameTimes(piece.fromMs, piece.toMs, fps).filter((t) => box(piece, t)).length < 2)) {
          expect(wow.map((piece) => piece.id)).toEqual(["splat:0:w0"]);
          expect(wow[0]!.kind === "text" && wow[0]!.stroke?.widthPx).toBeGreaterThan(0);
          oneFrameHeroes++;
        }
        // Every letter of a lettered key word has its outline copy, painting as long as the letter.
        for (const face of pieces.filter((piece) => /^splat:\d+:w\d+l\d+$/.test(piece.id))) {
          const outline = pieces.find((piece) => piece.id === `${face.id}o`);
          expect(outline, `${face.id} outline`).toBeDefined();
          expect(outline!.fromMs).toBe(face.fromMs);
          expect(outline!.toMs).toBe(face.toMs);
        }
      }
    }
    expect(oneFrameHeroes).toBeGreaterThan(0);
  });

  test("colours are static and checked as drawn: a mid grey passes 3:1 on the outline, a darker grey falls back", () => {
    const run = (primary: string) => build(["just:b start:b now:h@500"], {}, undefined, { colours: { ...colours, primary, highlight: primary, accent: primary } }).pieces;
    const faceColours = (pieces: Piece[]) => pieces.filter((piece) => isFace(0).test(piece.id)).map((piece) => evaluatePiece(piece, 5000).colour);
    expect(faceColours(run("#858585"))).toContain("#858585");
    expect(faceColours(run("#666666"))).not.toContain("#666666");
    // No piece animates its colour.
    for (const piece of run("#858585")) expect(piece.track.colour).toBeUndefined();
  });

  test("a single-word cue hands off without a blank frame: it paints up to the next cue's first frame", () => {
    for (const fps of [25, 30]) {
      const { cues } = demoCues({ lines: ["wow:h@300", "next:b one:b"], options: { lead: 400, gap: 0, cueGap: 0, tail: 400 } });
      const pieces = splatProgram.build(sceneInput(cues, { fps, colours, anchor })).pieces;
      const word = pieces.find((piece) => /^splat:0:w0(l0)?$/.test(piece.id))!;
      const next = cues[1]!.words[0]!.startMs;
      const lastBefore = exportFrameTimes(word.fromMs, next, fps).at(-1)!;
      expect(box(word, lastBefore), `fps ${fps}`).not.toBeNull();
      expect(evaluatePiece(word, lastBefore).o).toBe(1);
    }
  });

  test("long tokens keep the size floor after the fit, and a pathological token stays bounded and whole", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1080, height: 1080 }]) {
      for (const line of ["contemporaneousness:h@900", "it's:m contemporaneousness:b@900"]) {
        const { cues } = demoCues({ lines: [line], options: { lead: 400, tail: 600 } });
        const pieces = splatProgram.build(sceneInput(cues, { fps: 30, colours, anchor, canvas })).pieces;
        const word = pieces.filter((piece) => piece.kind === "text" && /^splat:0:w\d+(l\d+)?$/.test(piece.id) && /CONTEM|ANEOUS|NESS|[A-Z]{5,}/.test(piece.kind === "text" ? piece.text : ""));
        expect(word.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toContain("CONTEMPORANEOUSNESS".slice(0, 4));
        const floor = line.includes(":h") ? 100 : 0.66 * 118;
        for (const piece of word) expect(piece.kind === "text" && piece.sizePx, `${line} ${canvas.height}`).toBeGreaterThanOrEqual(floor * 0.98);
      }
    }
    const cjk = "今日は本当に素晴らしい一日でしたね".repeat(6).slice(0, 90);
    const long = build([`${cjk}:b@3000`], {}, "ja");
    const parts = long.pieces.filter((piece) => piece.kind === "text" && /^splat:0:w0(l\d+)?$/.test(piece.id));
    expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(cjk);
    for (const piece of parts) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(0.66 * 138 * 0.98);
    expectClear(long.pieces, long.cues);
    const huge = "x".repeat(400);
    const crazy = build([`${huge}:b@3000`]);
    const own = crazy.pieces.filter((piece) => piece.id.startsWith("splat:0:"));
    expect(own.length).toBeLessThanOrEqual(150);
    expect(own.filter((piece) => piece.kind === "text").map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(huge.toUpperCase());
    for (const piece of own) {
      for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30).filter((_, k) => k % 5 === 0)) {
        const b = box(piece, t);
        if (b) expect(inside(b), `${piece.id} at ${t}`).toBe(true);
      }
    }
  });

  test("in speaker lanes at 2x on 16:9 every decoration moves with its cue: near its own words, never on the other speaker's", () => {
    const { cues: pair } = demoCues({ lines: ["some:b@300 fairly:b@300 long:h@300 words:b@300", "other:b@300 speaker:b@300 cuts:h@300 in:b@300"], options: { lead: 357, gap: 0, cueGap: 0 } });
    const by = 500 - pair[1]!.startMs;
    const cues: SceneCue[] = [{ ...pair[0]!, speaker: 0 }, { ...pair[1]!, speaker: 1, startMs: pair[1]!.startMs + by, endMs: pair[1]!.endMs + by, words: pair[1]!.words.map((word) => ({ ...word, startMs: word.startMs + by, endMs: word.endMs + by })) }];
    const canvas = { width: 1920, height: 1080 };
    const pieces = splatProgram.build(sceneInput(cues, { fps: 30, colours, anchor, canvas, scale: 2 })).pieces;
    const t = 1700;
    const area = { x1: 96, y1: 54, x2: 1824, y2: 1026 };
    for (const cue of cues) {
      const words = unionOf(facesOf(pieces, cue.index).flatMap((piece) => box(piece, t) ?? []));
      const other = unionOf(facesOf(pieces, 1 - cue.index).flatMap((piece) => box(piece, t) ?? []));
      for (const shape of pieces.filter((piece) => piece.id.startsWith(`splat:${cue.index}:`) && piece.kind === "shape")) {
        const b = box(shape, t);
        if (!b) continue;
        expect(b.x1 >= area.x1 - 1 && b.x2 <= area.x2 + 1 && b.y1 >= area.y1 - 1 && b.y2 <= area.y2 + 1, `${shape.id} inside`).toBe(true);
        // Within its own block's reach: a shape left behind by the lane shift would sit far from its words.
        const near = { x1: words.x1 - 420, y1: words.y1 - 300, x2: words.x2 + 420, y2: words.y2 + 300 };
        expect(b.x1 >= near.x1 && b.x2 <= near.x2 && b.y1 >= near.y1 && b.y2 <= near.y2, `${shape.id} near its cue`).toBe(true);
        if (!/:blob/.test(shape.id)) expect(meets(b, other), `${shape.id} on the other speaker`).toBe(false);
        expect(shape.track.x && shape.track.y, `${shape.id} has position tracks`).toBeTruthy();
      }
    }
  });
});
