import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { type Piece, type TextPiece, evaluatePiece, pieceBounds } from "./scene";
import { pathBounds } from "./shapes";
import { rainbowProgram } from "./templates/rainbow";
import { fakeMeasure, sceneInput } from "./test-support";

// Rainbow draws dozens of text copies per cue and the suite builds twelve cues six times per test.
setDefaultTimeout(180_000);

describeSpeechConformance("rainbow", rainbowProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFFFFF", highlight: "#FFE23F", accent: "#3A1E80", shadow: "#000000" };
const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };

const build = (lines: string[], language: string | null = null, extra: Parameters<typeof sceneInput>[1] = {}) => {
  const { cues } = demoCues({ lines, language: language ?? undefined, options: { lead: 400, gap: 30, cueGap: 140, tail: 800 } });
  return { cues, pieces: rainbowProgram.build(sceneInput(cues, { fps: 30, colours, anchor, ...extra })).pieces };
};

const faces = (pieces: Piece[], cue = 0) => pieces.filter((p): p is TextPiece => p.kind === "text" && new RegExp(`^rainbow:${cue}:w\\d+(l\\d+)?$`).test(p.id));
const bands = (pieces: Piece[], cue: number, word: number) => pieces.filter((p): p is TextPiece => p.kind === "text" && new RegExp(`^rainbow:${cue}:w${word}(l\\d+)?band`).test(p.id));
/** How far a rainbow copy sits from its face at rest, and at what angle (degrees below the horizontal). */
const reach = (copy: Piece, face: Piece, at: number) => {
  const a = evaluatePiece(copy, at);
  const f = evaluatePiece(face, at);
  const dx = a.x - f.x;
  const dy = a.y - f.y;
  return { length: Math.hypot(dx, dy), angle: (Math.atan2(dy, dx) * 180) / Math.PI, dx };
};

describe("rainbow", () => {
  test("the key word has six bands of one copy, a support word two, and every band's colour is the sample's", () => {
    const { pieces } = build(["start:b before:b you're:m ready:h@700"]);
    const hero = bands(pieces, 0, 3);
    expect(new Set(hero.map((p) => p.id.match(/band(\d)/)![1])).size).toBe(6);
    expect(hero).toHaveLength(6);
    expect(bands(pieces, 0, 0)).toHaveLength(2);
    expect(new Set(hero.map((p) => p.fill))).toEqual(new Set(["#FF6B93", "#FFA03C", "#FFD83B", "#4FDB97", "#43B5FF", "#9B79FF"]));
  });

  test("all depth is painted behind all faces, the key word's rainbow over the support words'", () => {
    const { pieces } = build(["start:b before:b you're:m ready:h@700"]);
    const faceZ = Math.min(...faces(pieces).map((p) => p.z));
    const depth = pieces.filter((p) => p.id.includes("band"));
    expect(Math.max(...depth.map((p) => p.z))).toBeLessThan(faceZ);
    expect(Math.min(...bands(pieces, 0, 3).map((p) => p.z))).toBeGreaterThan(Math.max(...bands(pieces, 0, 0).map((p) => p.z)));
  });

  test("the key word's rainbow runs at 38 degrees and at most 120 px, a support word's 32-48 px", () => {
    const { cues, pieces } = build(["it's:b okay:h@700"]);
    const rest = cues[0]!.endMs - 300;
    const heroFace = faces(pieces).find((p) => p.id.endsWith(":w1"))!;
    const outer = bands(pieces, 0, 1).filter((p) => p.id.includes("band5")).map((p) => reach(p, heroFace, rest));
    const far = Math.max(...outer.map((o) => o.length));
    expect(far).toBeGreaterThan(95);
    expect(far).toBeLessThanOrEqual(120.5);
    for (const o of outer) expect(o.angle).toBeCloseTo(38, 0);
    const supportFace = faces(pieces).find((p) => p.id.endsWith(":w0"))!;
    const support = Math.max(...bands(pieces, 0, 0).map((p) => reach(p, supportFace, rest).length));
    expect(support).toBeGreaterThanOrEqual(31);
    expect(support).toBeLessThanOrEqual(48.5);
  });

  test("a face has a violet edge of 0.055 em and is opaque, popping 80% to 104% to 100% from its spoken start", () => {
    const { cues, pieces } = build(["so:b it's:b okay:b"]);
    const face = faces(pieces).find((p) => p.id.endsWith(":w1"))!;
    expect(face.stroke!.colour).toBe("#3A1E80");
    expect(face.stroke!.widthPx / face.sizePx).toBeCloseTo(0.055, 3);
    const start = cues[0]!.words[1]!.startMs;
    const frames = exportFrameTimes(start, start + 300, 60);
    expect(evaluatePiece(face, frames[0]!).o).toBe(1);
    expect(evaluatePiece(face, frames[0]!).sx).toBeLessThan(0.9);
    const peak = Math.max(...frames.map((t) => evaluatePiece(face, t).sx));
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.06);
    expect(evaluatePiece(face, start + 300).sx).toBeCloseTo(1, 2);
  });

  test("the bands open from the face outward, band after band, in the pop's own time", () => {
    const { cues, pieces } = build(["it's:b okay:h@700"]);
    const start = cues[0]!.words[1]!.startMs;
    const face = faces(pieces).find((p) => p.id.endsWith(":w1"))!;
    const first = bands(pieces, 0, 1).find((p) => p.id.endsWith("band0c0"))!;
    const last = bands(pieces, 0, 1).find((p) => p.id.endsWith("band5c0"))!;
    expect(reach(last, face, start).length).toBeLessThan(4);
    const mid = start + 50;
    expect(reach(last, face, mid).length / Math.max(1, reach(last, face, start + 400).length)).toBeLessThan(0.97);
    expect(reach(first, face, start + 400).length).toBeGreaterThan(5);
  });

  test("two accents, a heart and a star of 40-56 px, sit in free space on every cue", () => {
    const { cues, pieces } = build(["start:b before:b you're:m ready:h@700", "keep:b it:m simple:b", "have:b fun:b"]);
    for (const cue of cues) {
      const at = cue.endMs - 300;
      const accents = pieces.filter((p) => p.kind === "shape" && p.id.startsWith(`rainbow:${cue.index}:accent`));
      expect(accents).toHaveLength(2);
      // The word's ink less a margin, as the real-measure occlusion test takes it: a tilted corner or a descender box is not a covered word.
      const words = faces(pieces, cue.index).map((p) => {
        const b = pieceBounds(p, at, fakeMeasure)!;
        const dx = (b.x2 - b.x1) * 0.06;
        const dy = (b.y2 - b.y1) * 0.18;
        return { x1: b.x1 + dx, x2: b.x2 - dx, y1: b.y1 + dy, y2: b.y2 - dy };
      });
      for (const accent of accents) {
        const box = pieceBounds(accent, at, fakeMeasure)!;
        const drawn = pathBounds(accent.kind === "shape" ? accent.path : []);
        expect(drawn.x2 - drawn.x1).toBeGreaterThanOrEqual(40);
        expect(drawn.x2 - drawn.x1).toBeLessThanOrEqual(56);
        for (const word of words) expect(box.x1 < word.x2 && word.x1 < box.x2 && box.y1 < word.y2 && word.y1 < box.y2, `${accent.id} covers a word`).toBe(false);
      }
    }
  });

  test("a glint runs along the key word's rainbow on every cue and again on a long hold", () => {
    const { pieces } = build(["it's:b okay:h@700", "keep:b it:m simple:b", "hold:h@4200"]);
    for (const cue of [0, 1, 2]) expect(pieces.some((p) => p.id.startsWith(`rainbow:${cue}:glint0`))).toBe(true);
    expect(pieces.some((p) => p.id.startsWith("rainbow:2:glint1"))).toBe(true);
    expect(pieces.some((p) => p.id.startsWith("rainbow:0:glint1"))).toBe(false);
  });

  test("a script that cannot be split into letters is one piece, and an Urdu cue's rainbow runs left", () => {
    const hi = build(["यह:b बहुत:h@700"], "hi").pieces;
    expect(faces(hi).map((p) => p.id)).toEqual(["rainbow:0:w0", "rainbow:0:w1"]);
    expect(bands(hi, 0, 1).every((p) => p.text === "बहुत")).toBe(true);
    const ur = build(["یہ:m بہت:b اچھا:h@600"], "ur");
    const face = faces(ur.pieces).find((p) => p.id.endsWith(":w2"))!;
    const copy = bands(ur.pieces, 0, 2).find((p) => p.id.endsWith("band5c0"))!;
    expect(reach(copy, face, ur.cues[0]!.endMs - 300).dx).toBeLessThan(-20);
  });

  test("a word wider than the column breaks across rows at a readable size", () => {
    const word = "pneumonoultramicroscopicsilicovolcanoconiosis";
    const { cues, pieces } = build([`${word}:b@900`]);
    const parts = faces(pieces).sort((a, b) => a.id.localeCompare(b.id));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.map((p) => p.text.toLowerCase()).join("")).toBe(word);
    for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(90);
    expect(new Set(parts.map((p) => Math.round(evaluatePiece(p, cues[0]!.endMs - 300).y))).size).toBe(parts.length);
  });

  test("a wide key word keeps its text size and gives up depth first", () => {
    const { cues, pieces } = build(["it's:m extraordinary:h@900"]);
    const face = faces(pieces).find((p) => p.id.endsWith(":w1"))!;
    expect(face.sizePx).toBeGreaterThanOrEqual(110);
    const far = Math.max(...bands(pieces, 0, 1).map((p) => reach(p, face, cues[0]!.endMs - 300).length));
    expect(far).toBeLessThan(115);
    expect(far).toBeGreaterThan(30);
  });

  test("a cue draws at most 150 pieces and stays inside the safe area, portrait and landscape", () => {
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      for (const edge of ["nine-words", "urdu", "long-word"] as const) {
        const { cues } = sceneEdgeDemo(edge);
        const pieces = rainbowProgram.build(sceneInput(cues, { fps: 30, colours, anchor, canvas })).pieces;
        for (const cue of cues) expect(pieces.filter((p) => p.id.startsWith(`rainbow:${cue.index}:`)).length).toBeLessThanOrEqual(150);
        for (const piece of pieces) {
          for (const t of exportFrameTimes(piece.fromMs, piece.toMs, 12)) {
            const box = pieceBounds(piece, t, fakeMeasure);
            if (!box) continue;
            expect(box.x1, `${piece.id} ${canvas.width}x${canvas.height} left`).toBeGreaterThanOrEqual(0.05 * canvas.width - 1);
            expect(box.x2, `${piece.id} right`).toBeLessThanOrEqual(0.95 * canvas.width + 1);
            expect(box.y1, `${piece.id} top`).toBeGreaterThanOrEqual(0.05 * canvas.height - 1);
            expect(box.y2, `${piece.id} bottom`).toBeLessThanOrEqual(0.95 * canvas.height + 1);
          }
        }
      }
    }
  });
});

describe("rainbow review items", () => {
  test("a long word breaks into the fewest balanced rows, never an orphan fragment", () => {
    const { pieces } = build(["unbelievable:b@900"]);
    const parts = faces(pieces).sort((a, b) => a.id.localeCompare(b.id));
    expect(parts.map((p) => p.text.toLowerCase()).join("")).toBe("unbelievable");
    const longest = Math.max(...parts.map((p) => p.text.length));
    const shortest = Math.min(...parts.map((p) => p.text.length));
    expect(shortest).toBeGreaterThanOrEqual(longest - 3);
    expect(parts.every((p) => !p.text.includes(" "))).toBe(true);
  });

  test("a brand face that does not read on the violet edge falls back to the preset's own colours", () => {
    const light = { ...colours, primary: "#7A4DCB", highlight: "#4A2A9A" };
    const { pieces } = build(["it's:b okay:h@700"], null, { colours: light });
    const [plain, hero] = [faces(pieces).find((p) => p.id.endsWith(":w0"))!, faces(pieces).find((p) => p.id.endsWith(":w1"))!];
    expect(plain.fill).toBe("#FFFFFF");
    expect(hero.fill).toBe("#FFE23F");
  });

  test("a short entrance settles monotonically: no overshoot on the same stamp as the settle", () => {
    const { cues, pieces } = build(["go:b@70 on:b@70 now:h@70"]);
    for (const face of faces(pieces)) {
      const start = cues[0]!.words[Number(face.id.split(":w")[1])]!.startMs;
      const scales = exportFrameTimes(start, start + 150, 60).map((t) => evaluatePiece(face, t).sx);
      for (let i = 1; i < scales.length; i++) expect(scales[i]!).toBeGreaterThanOrEqual(scales[i - 1]! - 1e-9);
    }
  });

  test("the glint and the accents paint on a short ordinary cue too", () => {
    const { pieces } = build(["to:m go:b@120 now:h@150", "ok:b@130"]);
    for (const cue of [0, 1]) {
      expect(pieces.some((p) => p.id.startsWith(`rainbow:${cue}:glint0`))).toBe(true);
      expect(pieces.filter((p) => p.id.startsWith(`rainbow:${cue}:accent`)).length).toBe(2);
    }
  });

  test("no decoration is visible past its cue's last painted face frame", () => {
    const { pieces } = build(["start:b before:b you're:m ready:h@700", "keep:b it:m simple:b"]);
    for (const cue of [0, 1]) {
      const own = pieces.filter((p) => p.id.startsWith(`rainbow:${cue}:`));
      const end = Math.max(...faces(pieces, cue).map((p) => p.toMs));
      expect(Math.max(...own.map((p) => p.toMs))).toBeLessThanOrEqual(end);
    }
  });
});

describe("rainbow review 2", () => {
  const exitOf = (pieces: Piece[], cue: number) => {
    const face = faces(pieces, cue)[0]!;
    return face.track.o && face.track.o.length > 2 ? face.track.o[1]![0] : face.toMs;
  };

  test("every glint burst ends before its cue's exit and inside its window, with or without a gap", () => {
    for (const lines of [["start:b before:b you're:m ready:h@700", "keep:b it:m simple:b", "to:m go:b@120 now:h@150", "ok:b@130"], ["so:m time:h@200 to:m go:b@90"]]) {
      const { cues, pieces } = build(lines);
      for (const cue of cues) {
        const end = exitOf(pieces, cue.index);
        const own = pieces.filter((p) => p.id.startsWith(`rainbow:${cue.index}:glint`));
        expect(own.length).toBeGreaterThan(0);
        for (const glint of own) {
          expect(glint.toMs, `${glint.id} runs past the exit at ${end}`).toBeLessThanOrEqual(end);
          expect(exportFrameTimes(glint.fromMs, glint.toMs, 30).length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  test("a long hold keeps glinting every 1.5 s until its exit", () => {
    const { cues, pieces } = build(["hold:h@7000"]);
    const glints = pieces.filter((p) => p.id.startsWith("rainbow:0:glint"));
    expect(glints.length).toBeGreaterThanOrEqual(4);
    const starts = glints.map((p) => p.fromMs).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBe(1500);
    expect(Math.max(...glints.map((p) => p.toMs))).toBeLessThanOrEqual(exitOf(pieces, 0));
    expect(cues[0]!.endMs).toBeGreaterThan(7000);
  });

  test("the 120 px cap holds through the pop's overshoot, on every 60 fps frame", () => {
    const { cues, pieces } = build(["so:b it's:b okay:h@700"]);
    const face = faces(pieces).find((p) => p.id.endsWith(":w2"))!;
    const start = cues[0]!.words[2]!.startMs;
    let widest = 0;
    for (const copy of bands(pieces, 0, 2)) for (const t of exportFrameTimes(start, cues[0]!.endMs, 60)) widest = Math.max(widest, reach(copy, face, t).length);
    expect(widest).toBeLessThanOrEqual(120.01);
    expect(widest).toBeGreaterThan(60);
  });

  test("landscape fits an ordinary cue in two rows, and the rainbow stops short of the row below", () => {
    const canvas = { width: 1920, height: 1080 };
    const { cues, pieces } = build(["before:b ready:h@700 now:b"], null, { canvas });
    const at = cues[0]!.endMs - 300;
    const y = (word: number) => evaluatePiece(faces(pieces).find((p) => p.id.endsWith(`:w${word}`))!, at).y;
    const x = (word: number) => evaluatePiece(faces(pieces).find((p) => p.id.endsWith(`:w${word}`))!, at).x;
    // BEFORE and ready share the first row (side by side), NOW is the second.
    expect(Math.abs(y(0) - y(1))).toBeLessThan(120);
    expect(Math.abs(x(0) - x(1))).toBeGreaterThan(200);
    expect(y(2) - Math.max(y(0), y(1))).toBeGreaterThan(100);
    // The first row's rainbow stops short of the middle of the row below.
    const ready = faces(pieces).find((p) => p.id.endsWith(":w1"))!;
    const far = Math.max(...bands(pieces, 0, 1).map((p) => evaluatePiece(p, at).y - evaluatePiece(ready, at).y));
    expect(far).toBeLessThan(y(2) - y(1));
  });

  test("a long word takes two rows when a two-row split fits the column, not three", () => {
    const { pieces } = build(["gewässerschutzbeauftragter:b@900"]);
    expect(faces(pieces).length).toBe(2);
    const wide = faces(pieces).map((p) => fakeMeasure(p.text, p.face, p.sizePx, p.letterSpacingEm).advance);
    for (const width of wide) expect(width).toBeLessThanOrEqual(830);
  });
});
