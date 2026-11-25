import { describe, expect, test } from "bun:test";
import { captionColourContrast } from "@narriflow/validators";
import { describeSpeechConformance, fastRun, staccatoRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { type Box, type Piece, SCENE_PIECE_BUDGET, evaluatePiece, pieceBounds } from "./scene";
import { tiltProgram, tiltRaysPath } from "./templates/tilt";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("tilt", tiltProgram, { anchorLineY: 1290 });

const colours = { primary: "#F4172B", highlight: "#FFD21F", accent: "#FF5CB6", shadow: "#000000" };
const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };
const build = (lines: string[], language: string | null = null, fps = 30) => {
  const { cues } = demoCues({ lines, language: language ?? undefined, options: { lead: 400, gap: 40, cueGap: 140, tail: 800 } });
  return { cues, pieces: tiltProgram.build(sceneInput(cues, { fps, colours, anchor })).pieces };
};
const faces = (pieces: readonly Piece[], cue: number) => pieces.filter((p) => new RegExp(`^tilt:${cue}:w\\d+(l\\d+)?$`).test(p.id));
const text = (piece: Piece) => (piece.kind === "text" ? piece.text : "");

describe("tilt", () => {
  test("a word paints on its spoken start, opaque, swings from a turned pose and is at rest within 140 ms", () => {
    const { cues, pieces } = build(["keep:b it:m loud:b"]);
    for (const [at, word] of cues[0]!.words.entries()) {
      const face = pieces.find((p) => p.id === `tilt:0:w${at}`)!;
      expect(face.fromMs).toBe(word.startMs);
      const first = evaluatePiece(face, word.startMs);
      expect(first.o).toBe(1);
      expect(Math.abs(first.ry)).toBeGreaterThan(5);
      expect(Math.abs(first.ry)).toBeLessThanOrEqual(32.01);
      expect(first.sx).toBeLessThan(0.9 * evaluatePiece(face, word.startMs + 400).sx);
      const rest = evaluatePiece(face, word.startMs + 140);
      expect(rest.ry).toBeCloseTo(0, 1);
      expect(rest.skx).toBe(-9);
    }
  });

  test("a word too short to animate takes its rest pose at once", () => {
    const { pieces } = build(["go@30 on@30 then:h@30"]);
    const face = pieces.find((p) => p.id.startsWith("tilt:0:w0"))!;
    const pose = evaluatePiece(face, face.fromMs);
    expect(pose.ry).toBe(0);
  });

  test("the key word's letters share one pivot and one swing, and its colours roll across them within 45 ms", () => {
    const { cues, pieces } = build(["so:m changer:h@640"]);
    const letters = pieces.filter((p) => /^tilt:0:w1l\d+$/.test(p.id));
    expect(letters.length).toBe(7);
    const start = cues[0]!.words[1]!.startMs;
    for (const letter of letters) expect(letter.fromMs).toBe(start);
    for (const t of [start, start + 40, start + 90]) {
      const poses = letters.map((l) => evaluatePiece(l, t));
      for (const pose of poses) {
        expect(pose.x).toBeCloseTo(poses[0]!.x, 3);
        expect(pose.y).toBeCloseTo(poses[0]!.y, 3);
        expect(pose.ry).toBeCloseTo(poses[0]!.ry, 3);
        expect(pose.sx).toBeCloseTo(poses[0]!.sx, 3);
      }
    }
    const fillAt = (t: number) => letters.map((l) => evaluatePiece(l, t).colour);
    expect(new Set(fillAt(start)).size).toBeLessThan(new Set(fillAt(start + 140)).size);
    expect(new Set(fillAt(start + 140)).size).toBeGreaterThanOrEqual(4);
    expect(fillAt(start + 140)).toEqual(fillAt(start + 300));
  });

  test("the lettering starts from a different fill on each cue", () => {
    const { pieces } = build(Array.from({ length: 4 }, (_, i) => `word${i}:h@500`));
    // The settled fill of each cue's first letter.
    const fills = [0, 1, 2, 3].map((i) => {
      const piece = pieces.find((p) => p.id === `tilt:${i}:w0l0`)!;
      return evaluatePiece(piece, piece.fromMs + 300).colour;
    });
    expect(new Set(fills).size).toBe(4);
  });

  test("depth is one slate copy over an ink rim, 0.12 em deep, every copy below every face", () => {
    const { pieces } = build(["keep:b it:m loud:b", "wait:h@600"]);
    const face = pieces.find((p) => p.id === "tilt:0:w0")!;
    if (face.kind !== "text") throw new Error("face is text");
    const copies = ["d2", "d3"].map((k) => pieces.find((p) => p.id === `tilt:0:w0${k}`)!);
    for (const copy of copies) expect(copy.z).toBeLessThan(face.z);
    const deepest = copies[1]!;
    expect((-(deepest.origin?.dy ?? 0) + (face.origin?.dy ?? 0)) / face.sizePx).toBeCloseTo(0.12, 3);
    expect(deepest.kind === "text" && deepest.fill).toBe("#11112B");
    expect(face.stroke!.colour).toBe("#11112B");
    expect(face.stroke!.widthPx).toBeCloseTo(0.06 * face.sizePx, 3);
    const lowestFace = Math.min(...pieces.filter((p) => /^tilt:\d:w\d+(l\d+)?$/.test(p.id)).map((p) => p.z));
    for (const p of pieces.filter((q) => /d\d$/.test(q.id))) expect(p.z).toBeLessThan(lowestFace);
  });

  test("the sunburst is ten rays at 85 %, centred on the key word's measured box, fading out within 520 ms of the word", () => {
    expect(tiltRaysPath(10, 10, 100, 70).filter((c) => c[0] === "M").length).toBe(10);
    const { cues, pieces } = build(["this:m is:m the:b changer:h@640", "no:b one:b tells:h@560 you:m"]);
    for (const cue of cues) {
      const burst = pieces.find((p) => p.id === `tilt:${cue.index}:burst`)!;
      expect(burst).toBeDefined();
      const heroIx = cue.words.findIndex((w) => w.role === "hero");
      const heroFaces = faces(pieces, cue.index).filter((p) => p.id.startsWith(`tilt:${cue.index}:w${heroIx}`));
      const t = cue.words[heroIx]!.startMs + 300;
      const boxes = heroFaces.map((f) => pieceBounds(f, t, fakeMeasure)!);
      const hero: Box = { x1: Math.min(...boxes.map((b) => b.x1)), x2: Math.max(...boxes.map((b) => b.x2)), y1: Math.min(...boxes.map((b) => b.y1)), y2: Math.max(...boxes.map((b) => b.y2)) };
      const pose = evaluatePiece(burst, cue.words[heroIx]!.startMs + 200);
      expect(Math.abs(pose.x - (hero.x1 + hero.x2) / 2)).toBeLessThan(60);
      expect(Math.abs(pose.y - (hero.y1 + hero.y2) / 2)).toBeLessThan(60);
      const peak = Math.max(...exportFrameTimes(burst.fromMs, burst.toMs, 60).map((x) => evaluatePiece(burst, x).o));
      expect(peak).toBeCloseTo(0.85, 2);
      expect(burst.toMs).toBeLessThanOrEqual(cue.words[heroIx]!.startMs + 520 + 1);
      expect(burst.fromMs).toBeGreaterThanOrEqual(cue.words[heroIx]!.startMs - 40 - 1);
      expect(burst.z).toBeLessThan(Math.min(...pieces.filter((p) => /d\d$/.test(p.id)).map((p) => p.z)));
      expect(burst.clip).toBeDefined();
    }
  });

  test("every cue of a long clip keeps its burst, sparkles and action dashes, whatever its role pattern", () => {
    const lines = Array.from({ length: 24 }, (_, i) => (i % 3 === 0 ? `plain${i}:b words:b here:m` : i % 3 === 1 ? `so:m big${i}:h@500` : `this:b is:b ${["fine", "ok", "fun"][i % 3]}:h@500`));
    const { cues, pieces } = build(lines);
    for (const cue of cues) {
      const own = pieces.filter((p) => p.id.startsWith(`tilt:${cue.index}:`));
      expect(own.some((p) => p.id.endsWith(":burst")), `burst ${cue.index}`).toBe(true);
      expect(own.filter((p) => p.id.includes(":spark")).length, `sparks ${cue.index}`).toBeGreaterThanOrEqual(1);
      expect(own.filter((p) => p.id.includes(":dash")).length, `dashes ${cue.index}`).toBeGreaterThanOrEqual(3);
      expect(own.length).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
    }
  });

  test("decorations never touch a word's ink on the frames they paint", () => {
    const { cues, pieces } = build(["it's:m time:h@600", "no:b one:b tells:h@560", "keep:b it:m loud:b"]);
    for (const cue of cues) {
      const words = faces(pieces, cue.index);
      const deco = pieces.filter((p) => /:(spark|dash)\d/.test(p.id) && p.id.startsWith(`tilt:${cue.index}:`));
      for (const piece of deco) {
        for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
          const box = pieceBounds(piece, t, fakeMeasure);
          if (!box) continue;
          for (const word of words) {
            const w = pieceBounds(word, t, fakeMeasure);
            if (!w) continue;
            const pad = 0.1 * (word.kind === "text" ? word.sizePx : 0);
            const hit = box.x1 < w.x2 - pad && w.x1 + pad < box.x2 && box.y1 < w.y2 - pad && w.y1 + pad < box.y2;
            expect(hit, `${piece.id} meets ${word.id} at ${t}`).toBe(false);
          }
        }
      }
    }
  });

  test("the block's tilt cycles by cue and rocks across a long hold, within a degree and a half", () => {
    const { cues, pieces } = build(["a:h@300", "b:h@300", "c:h@300", "d:h@300", "so:m hold:h@4200"]);
    const rz = (i: number) => evaluatePiece(pieces.find((p) => p.id === `tilt:${i}:w0l0`) ?? pieces.find((p) => p.id === `tilt:${i}:w0`)!, cues[i]!.words[0]!.startMs + 200).rz;
    expect(new Set([0, 1, 2, 3].map((i) => rz(i).toFixed(1))).size).toBeGreaterThanOrEqual(3);
    const hold = pieces.find((p) => /^tilt:4:w1l0$/.test(p.id))!;
    const start = cues[4]!.words[1]!.startMs;
    const values = exportFrameTimes(start + 300, start + 3800, 30).map((t) => evaluatePiece(hold, t).rz);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(1);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(2.9);
  });

  test("a shaped script stays one whole word, and a long word breaks across rows at a readable size", () => {
    const hindi = build(["यह:b बहुत:h@700 अच्छा:b है:m"], "hi");
    expect(hindi.pieces.some((p) => /^tilt:0:w\d+l\d+$/.test(p.id))).toBe(false);
    expect(faces(hindi.pieces, 0).map(text)).toEqual(hindi.cues[0]!.words.map((w) => w.text));
    const word = "pneumonoultramicroscopicsilicovolcanoconiosis";
    const long = build([`${word}:h@900`]);
    const parts = long.pieces.filter((p) => /^tilt:0:w0l\d+$/.test(p.id));
    expect(parts.map(text).join("").replace(/\s/g, "")).toBe(word.toUpperCase());
    for (const part of parts) expect(part.kind === "text" && part.sizePx).toBeGreaterThanOrEqual(80);
  });

  test("every edge demo stays inside the safe area at twice the size, portrait and landscape, within the piece budget", () => {
    for (const edge of ["urdu", "nine-words", "long-word", "no-hero", "one-word"] as const) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
        const { cues } = sceneEdgeDemo(edge);
        const pieces = tiltProgram.build(sceneInput(cues, { fps: 30, colours, anchor, scale: 2, canvas })).pieces;
        const safe: Box = { x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 };
        for (const cue of cues) {
          const own = pieces.filter((p) => p.id.startsWith(`tilt:${cue.index}:`));
          expect(own.length, `${edge} cue ${cue.index}`).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
          for (const piece of own) {
            for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 30)) {
              const box = pieceBounds(piece, t, fakeMeasure);
              if (!box) continue;
              expect(box.x1 >= safe.x1 && box.x2 <= safe.x2 && box.y1 >= safe.y1 && box.y2 <= safe.y2, `${piece.id} ${edge} ${canvas.width}x${canvas.height}`).toBe(true);
            }
          }
        }
      }
    }
  });

  test("words of one cue never overlap once settled", () => {
    const { cues, pieces } = build(["we:m didn't:b want:b", "all:b of:m them:h@480", "the:m remote:b doesn't:h@360 work.:b"]);
    for (const cue of cues) {
      const own = faces(pieces, cue.index);
      const t = cue.words.at(-1)!.endMs - 20;
      const live = own.flatMap((p) => {
        const box = pieceBounds(p, t, fakeMeasure);
        return box ? [{ p, box }] : [];
      });
      for (const [i, a] of live.entries()) {
        for (const b of live.slice(i + 1)) {
          const sameWord = a.p.id.split("l")[0] === b.p.id.split("l")[0];
          if (sameWord) continue;
          const x = Math.min(a.box.x2, b.box.x2) - Math.max(a.box.x1, b.box.x1);
          const y = Math.min(a.box.y2, b.box.y2) - Math.max(a.box.y1, b.box.y1);
          expect(x > 2 && y > 2, `${a.p.id} meets ${b.p.id}`).toBe(false);
        }
      }
    }
  });
});

describe("tilt on fast ordinary speech and awkward input", () => {
  test("the burst, sparkles and dashes still show on cues of 150 ms words with 60 ms gaps", () => {
    const run = fastRun(60);
    const pieces = tiltProgram.build(sceneInput(run, { fps: 30, colours, anchor })).pieces;
    const has = (cue: number, kind: string) => pieces.some((p) => p.id.startsWith(`tilt:${cue}:${kind}`) && exportFrameTimes(p.fromMs, p.toMs, 30).filter((t) => pieceBounds(p, t, fakeMeasure)).length >= 2);
    for (const kind of ["burst", "spark", "dash"]) {
      const shown = run.filter((cue) => has(cue.index, kind)).length;
      expect(shown, kind).toBeGreaterThanOrEqual(Math.floor(run.length * 0.7));
    }
  });

  test("an overshoot never shares a timestamp with its settle, and a short swing settles monotonically", () => {
    const { pieces } = build(["a@60 b@60 c@60 d:h@70"]);
    for (const p of pieces) {
      for (const key of ["sx", "sy", "ry"] as const) {
        const frames = p.track[key];
        if (!frames) continue;
        for (let i = 1; i < frames.length; i++) expect(frames[i]![0], `${p.id} ${key}`).toBeGreaterThan(frames[i - 1]![0]);
      }
    }
  });

  test("a brand colour that vanishes against the navy keyline falls back to the default palette", () => {
    const { cues } = demoCues({ lines: ["keep:b it:m wow:h@500"], options: { lead: 400 } });
    const pieces = tiltProgram.build(sceneInput(cues, { fps: 30, anchor, colours: { primary: "#14142A", highlight: "#101030", accent: "#0A0A2A", shadow: "#000000" } })).pieces;
    const face = pieces.find((p) => p.id === "tilt:0:w0")!;
    expect(face.kind === "text" && face.fill).toBe("#F4172B");
    const letters = pieces.filter((p) => /^tilt:0:w2l\d$/.test(p.id)).map((p) => evaluatePiece(p, p.fromMs + 400).colour);
    expect(letters).not.toContain("#101030");
    expect(letters).not.toContain("#0A0A2A");
  });

  test("a long word splits into the fewest rows, balanced, with no fragment left alone", () => {
    const { pieces } = build(["unbelievablyextraordinary:h@900"]);
    const parts = pieces.filter((p) => /^tilt:0:w0l\d+$/.test(p.id));
    const rows = new Map<number, string>();
    for (const p of parts) rows.set(Math.round(evaluatePiece(p, p.fromMs + 600).y / 10), (rows.get(Math.round(evaluatePiece(p, p.fromMs + 600).y / 10)) ?? "") + text(p));
    expect(parts.length).toBeGreaterThan(1);
    expect(rows.size).toBeGreaterThanOrEqual(2);
    const lengths = [...rows.values()].map((r) => r.length);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(0.6 * Math.max(...lengths));
    expect(parts.map(text).join("")).toBe("UNBELIEVABLYEXTRAORDINARY");
  });

  test("a cue opens on its first word's onset (no reserved lead), so the cue before it keeps its reading hold", () => {
    const { cues, pieces } = build(["keep:b it:m loud:b", "go:b big:h@500"]);
    const next = cues[1]!.words[0]!.startMs;
    const last = faces(pieces, 0).at(-1)!;
    expect(faces(pieces, 1)[0]!.fromMs).toBe(next);
    expect(last.toMs).toBeGreaterThanOrEqual(cues[0]!.words.at(-1)!.endMs + 100);
  });
});

describe("tilt review fixes", () => {
  test("depth is drawn once per shaped word or wrapped row, and letters only draw coloured faces", () => {
    const { pieces } = build(["so:m changer:h@640"]);
    const own = pieces.filter((p) => p.id.startsWith("tilt:0:w1"));
    expect(own.filter((p) => /^tilt:0:w1l\d$/.test(p.id)).length).toBe(7);
    expect(own.filter((p) => /d\d$/.test(p.id)).length).toBe(2);
    const wide = build(["unbelievablyextraordinaryhero:h@900"]);
    const depth = wide.pieces.filter((p) => /d\d$/.test(p.id)).length;
    const fragments = new Set(wide.pieces.filter((p) => /c\d+d\d$/.test(p.id)).map((p) => p.id.replace(/d\d$/, ""))).size;
    expect(depth).toBe(2 * fragments);
  });

  test("a long hero is decided before wrapping: 45 letters are fragments with one fill and one swing, inside the piece budget", () => {
    const word = "pneumonoultramicroscopicsilicovolcanoconiosis";
    const { cues, pieces } = build([`${word}:h@900`]);
    const own = pieces.filter((p) => p.id.startsWith("tilt:0:"));
    expect(own.length).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
    const faceRefs = own.filter((p) => /^tilt:0:w0l\d+$/.test(p.id));
    expect(faceRefs.length).toBeLessThanOrEqual(5);
    const t = cues[0]!.words[0]!.startMs + 70;
    expect(new Set(faceRefs.map((p) => evaluatePiece(p, t + 400).colour)).size).toBe(1);
    expect(new Set(faceRefs.map((p) => evaluatePiece(p, t).ry.toFixed(3))).size).toBe(1);
  });

  test("a brand pair whose blend would dip under 3:1 on the keyline switches hard, and every rendered colour keeps 3:1", () => {
    const { cues } = demoCues({ lines: ["so:m changer:h@640"], options: { lead: 400 } });
    const pieces = tiltProgram.build(sceneInput(cues, { fps: 30, anchor, colours: { primary: "#C70000", highlight: "#007300", accent: "#FF5CB6", shadow: "#000000" } })).pieces;
    const letters = pieces.filter((p) => /^tilt:0:w1l\d$/.test(p.id));
    const start = cues[0]!.words[1]!.startMs;
    for (const letter of letters) {
      for (let t = start; t <= start + 200; t += 8) {
        expect(captionColourContrast(evaluatePiece(letter, t).colour, "#11112B"), `${letter.id} at ${t}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("a landscape frame keeps ordinary cues to two rows before anything shrinks", () => {
    const canvas = { width: 1920, height: 1080 };
    const { cues } = demoCues({ lines: ["go:b hit:h@400 it:m", "यह:b बहुत:h@700 अच्छा:b है:m", "the:m remote:b doesn't:h@360 work.:b"], options: { lead: 400, gap: 40, cueGap: 140, tail: 800 } });
    const pieces = tiltProgram.build(sceneInput(cues, { fps: 30, colours, anchor, canvas })).pieces;
    for (const cue of cues) {
      const own = faces(pieces, cue.index);
      const t = cue.words.at(-1)!.endMs - 20;
      const ys = own.map((p) => evaluatePiece(p, t).y).sort((x, y) => x - y);
      const rows = ys.filter((y, k) => k === 0 || y - ys[k - 1]! > 140).length;
      expect(rows, `cue ${cue.index}`).toBeLessThanOrEqual(2);
    }
  });

  test("adjacent key words keep their keylines and depth apart through the whole swing", () => {
    const { cues, pieces } = build(["so:m nine:h@600 lakh:h@600"]);
    const both = faces(pieces, 0);
    const a = both.filter((p) => /^tilt:0:w1(l\d+)?$/.test(p.id)).at(-1)!;
    const b = both.find((p) => p.id === "tilt:0:w2" || p.id === "tilt:0:w2l0")!;
    const start = cues[0]!.words[1]!.startMs;
    const size = a.kind === "text" ? a.sizePx : 0;
    for (const t of exportFrameTimes(start, cues[0]!.words[2]!.endMs, 60)) {
      const boxA = pieceBounds(a, t, fakeMeasure);
      const boxB = pieceBounds(b, t, fakeMeasure);
      if (!boxA || !boxB) continue;
      // The boxes already hold each keyline; between them still fit the depth (0.074 em) and both ink rims (0.027 em each).
      expect(boxB.x1 - boxA.x2, `at ${t}`).toBeGreaterThanOrEqual(0.15 * size);
    }
  });

  test("on 70-120 ms words with no gap the burst, dashes and sparkles still paint on two frames, in a compact pose", () => {
    const run = staccatoRun(0).filter((cue) => cue.words.length >= 1);
    const pieces = tiltProgram.build(sceneInput(run, { fps: 30, colours, anchor })).pieces;
    const painted = (cue: number, kind: string) =>
      pieces.some((p) => p.id.startsWith(`tilt:${cue}:${kind}`) && exportFrameTimes(p.fromMs, p.toMs, 30).filter((t) => pieceBounds(p, t, fakeMeasure)).length >= 2);
    const bursts = run.filter((cue) => painted(cue.index, "burst")).length;
    const dashes = run.filter((cue) => painted(cue.index, "dash")).length;
    expect(bursts).toBeGreaterThanOrEqual(Math.ceil(run.length * 0.7));
    expect(dashes).toBeGreaterThanOrEqual(Math.ceil(run.length * 0.7));
    const burst = pieces.find((p) => p.id === "tilt:0:burst")!;
    expect(evaluatePiece(burst, burst.fromMs).sx).toBe(1);
  });

  test("on 16:9 a larger caption size keeps two rows and never gets smaller type than the default size", () => {
    const canvas = { width: 1920, height: 1080 };
    const { cues } = demoCues({ lines: ["यह:b बहुत:h@700 अच्छा:b है:m", "the:m remote:b doesn't:h@360 work.:b"], options: { lead: 400, gap: 40, cueGap: 140, tail: 800 } });
    const at = (scale: number) => tiltProgram.build(sceneInput(cues, { fps: 30, colours, anchor, canvas, scale })).pieces;
    for (const cue of cues) {
      const heroIndex = cue.words.findIndex((w) => w.role === "hero");
      const sizes = [1, 2].map((scale) => {
        const own = faces(at(scale), cue.index);
        const t = cue.words.at(-1)!.endMs - 20;
        const ys = own.map((p) => evaluatePiece(p, t).y).sort((x, y) => x - y);
        const rows = ys.filter((y, k) => k === 0 || y - ys[k - 1]! > 140).length;
        const hero = own.find((p) => p.id.startsWith(`tilt:${cue.index}:w${heroIndex}`));
        return { rows, hero: hero && hero.kind === "text" ? hero.sizePx : 0 };
      });
      expect(sizes[1]!.rows, `cue ${cue.index} at 2x`).toBeLessThanOrEqual(2);
      expect(sizes[1]!.hero, `cue ${cue.index}`).toBeGreaterThanOrEqual(sizes[0]!.hero * 0.95);
    }
  });
});
