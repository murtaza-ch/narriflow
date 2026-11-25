import { describe, expect, test } from "bun:test";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { evaluatePiece, pieceBounds } from "./scene";
import { glintProgram } from "./templates/glint";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("glint", glintProgram, { anchorLineY: 1290 });

const colours = { primary: "#FFD320", highlight: "#FF2F8B", accent: "#FFFFFF", shadow: "#000000" };

const build = (lines: string[], options: Record<string, number> = {}, language?: string, fps = 30) => {
  const { cues } = demoCues({ lines, language, options: { lead: 400, gap: 30, cueGap: 140, tail: 800, ...options } });
  return { cues, pieces: glintProgram.build(sceneInput(cues, { fps, colours })).pieces };
};
const faceOf = (id: RegExp, pieces: ReturnType<typeof build>["pieces"]) => pieces.filter((piece) => id.test(piece.id));

describe("glint", () => {
  test("every word lands readable in its own colour on its first painted frame, never before it is spoken", () => {
    const { cues, pieces } = build(["stop:b scrolling:b and:m listen:h@600"]);
    for (const [w, word] of cues[0]!.words.entries()) {
      const faces = faceOf(new RegExp(`^glint:0:w${w}(l\\d+)?$`), pieces);
      expect(faces.length).toBeGreaterThan(0);
      for (const face of faces) {
        expect(face.fromMs).toBeGreaterThanOrEqual(word.startMs);
        const pose = evaluatePiece(face, face.fromMs);
        expect(pose.o).toBe(1);
        expect(pose.sx).toBeGreaterThanOrEqual(0.88);
        expect(["#FFD320", "#FF2F8B"]).toContain(pose.colour);
      }
    }
  });

  test("rows alternate yellow and pink and the key word's row is pink", () => {
    const { cues, pieces } = build(["stop:b scrolling:b and:m listen:h@600", "it's:m free:b and:m easy:b"]);
    for (const cue of cues) {
      const at = cue.words.at(-1)!.startMs + 200;
      const rowsOf = cue.words.map((_, w) => {
        const face = pieces.find((piece) => new RegExp(`^glint:${cue.index}:w${w}(l0)?$`).test(piece.id))!;
        const box = pieceBounds(face, at, fakeMeasure)!;
        return { colour: evaluatePiece(face, at).colour, y: (box.y1 + box.y2) / 2, h: box.y2 - box.y1 };
      });
      // Words on the same row share a colour; a new row (its centre below the last one's bottom) takes the other.
      for (let w = 1; w < rowsOf.length; w++) {
        const prev = rowsOf[w - 1]!;
        const now = rowsOf[w]!;
        if (now.y > prev.y + 0.6 * prev.h) expect(now.colour, `cue ${cue.index} word ${w}`).not.toBe(prev.colour);
        else expect(now.colour, `cue ${cue.index} word ${w}`).toBe(prev.colour);
      }
    }
    const hero = pieces.find((piece) => piece.id === "glint:0:w3l0")!;
    expect(evaluatePiece(hero, cues[0]!.words[3]!.startMs + 200).colour).toBe("#FF2F8B");
  });

  test("the bounce is one short overshoot: 88% to 105% to 100% inside 115 ms", () => {
    const { pieces } = build(["just:b start:b today:h@600"]);
    const face = pieces.find((piece) => piece.id === "glint:0:w0")!;
    const scales = exportFrameTimes(face.fromMs, face.fromMs + 140, 60).map((t) => evaluatePiece(face, t).sx);
    expect(scales[0]).toBeCloseTo(0.88, 2);
    expect(Math.max(...scales)).toBeGreaterThan(1.03);
    expect(Math.max(...scales)).toBeLessThan(1.07);
    expect(scales.at(-1)).toBeCloseTo(1, 2);
    expect(scales.indexOf(Math.max(...scales))).toBeLessThan(scales.length - 1);
  });

  test("a key word is whole on its first painted frame: every letter is there at the word's start, at small alternating resting angles", () => {
    const { cues, pieces } = build(["just:b start:b today:h@600"]);
    const letters = faceOf(/^glint:0:w2l\d$/, pieces);
    expect(letters).toHaveLength(5);
    const start = cues[0]!.words[2]!.startMs;
    for (const letter of letters) {
      expect(letter.fromMs).toBeGreaterThanOrEqual(start);
      expect(letter.fromMs).toBe(letters[0]!.fromMs);
      expect(evaluatePiece(letter, letter.fromMs).o).toBe(1);
    }
    const angles = letters.map((piece) => evaluatePiece(piece, piece.toMs - 300).rz);
    expect(new Set(angles.map((a) => Math.round(a * 10))).size).toBeGreaterThan(2);
    // The letters' bounces are staggered inside the word, so they do not move as one block.
    const scales = letters.map((piece) => evaluatePiece(piece, piece.fromMs + 60).sx);
    expect(new Set(scales.map((v) => v.toFixed(3))).size).toBeGreaterThan(1);
  });

  test("a short key word's letters finish inside its own time, a 13-letter key word and a Hindi word land whole", () => {
    const { cues, pieces } = build(["go:b now:h@100"]);
    const letters = faceOf(/^glint:0:w1l\d$/, pieces);
    expect(Math.max(...letters.map((piece) => piece.fromMs))).toBeLessThan(cues[0]!.words[1]!.endMs);
    const long = build(["it's:m organisations:h@900"]);
    expect(faceOf(/^glint:0:w1l\d+$/, long.pieces)).toHaveLength(0);
    expect(long.pieces.some((piece) => piece.id === "glint:0:w1")).toBe(true);
    const hindi = build(["यह:b बहुत:h@700"], {}, "hi");
    expect(faceOf(/^glint:0:w1l\d+$/, hindi.pieces)).toHaveLength(0);
    expect(hindi.pieces.some((piece) => piece.id === "glint:0:w1")).toBe(true);
  });

  test("depth is painted far to near on one pivot, so it turns and scales with the face", () => {
    const { pieces } = build(["just:b start:b today:h@600"]);
    const stack = ["glint:0:w0b", "glint:0:w0e", "glint:0:w0"].map((id) => pieces.find((piece) => piece.id === id)!);
    expect(stack.every(Boolean)).toBe(true);
    expect(stack.map((piece) => piece.z)).toEqual([...stack.map((piece) => piece.z)].sort((a, b) => a - b));
    for (const piece of stack) expect(piece.track).toEqual(stack[2]!.track);
    const offsets = stack.map((piece) => piece.origin!.dx);
    expect(offsets[0]).toBeLessThan(offsets[1]!);
    expect(offsets[1]).toBeLessThan(offsets[2]!);
  });

  test("a brand colour gets a derived depth colour, the sample's colours keep the sample's", () => {
    const { cues } = demoCues({ lines: ["just:b start:b"], options: { lead: 400 } });
    const brand = glintProgram.build(sceneInput(cues, { fps: 30, colours: { ...colours, primary: "#22CC88" } })).pieces;
    const own = evaluatePiece(brand.find((piece) => piece.id === "glint:0:w0e")!, 5000).colour;
    expect(own).not.toBe("#D2570B");
    expect(own).not.toBe("#22CC88");
    const sample = build(["just:b start:b"]).pieces;
    expect(evaluatePiece(sample.find((piece) => piece.id === "glint:0:w0e")!, 5000).colour).toBe("#D2570B");
  });

  test("the light pass is a clipped white copy: a narrow band, white for about 35-55 ms at any point", () => {
    const { pieces } = build(["just:b start:b today:h@600"]);
    const sheen = pieces.find((piece) => piece.id === "glint:0:w0h")!;
    expect(sheen.kind === "text" && sheen.fill).toBe("#FFFFFF");
    expect(sheen.clip).toBeDefined();
    const box = pieceBounds({ ...sheen, clip: undefined }, sheen.fromMs + 200, fakeMeasure)!;
    let lit = 0;
    let first = 0;
    for (let t = sheen.fromMs; t < sheen.fromMs + 330; t++) {
      const x = (box.x1 + box.x2) / 2;
      const clip = evaluatePiece(sheen, t).clip!;
      if (clip.x1 <= x && x <= clip.x2) {
        lit++;
        first ||= t;
      }
    }
    expect(lit).toBeGreaterThanOrEqual(30);
    expect(lit).toBeLessThanOrEqual(60);
    expect(first).toBeLessThan(sheen.fromMs + 300);
  });

  test("every cue twinkles twice in small shapes, off the other words, and a long hold re-passes the light and twinkles again", () => {
    const { cues, pieces } = build(["so:m here:b is:h@500 it:b", "no:h@400 way:b", "wait:h@4200"]);
    for (const cue of cues) {
      const twinkles = pieces.filter((piece) => piece.id.startsWith(`glint:${cue.index}:tw`));
      expect(twinkles.length, `cue ${cue.index}`).toBeGreaterThanOrEqual(2);
      for (const piece of twinkles) {
        const box = pieceBounds(piece, piece.fromMs + 90, fakeMeasure)!;
        expect(box.x2 - box.x1).toBeLessThanOrEqual(100);
      }
    }
    const count = (cue: number) => pieces.filter((piece) => piece.id.startsWith(`glint:${cue}:tw`)).length;
    expect(count(2)).toBeGreaterThan(count(1));
    const sheens = pieces.filter((piece) => /^glint:2:w0l0h\d*$/.test(piece.id));
    expect(sheens.length).toBeGreaterThan(2);
    for (const sheen of sheens) expect(sheen.toMs - sheen.fromMs).toBeLessThanOrEqual(260);
  });

  test("the cue leaves as one unit over its last 70 ms: every piece fades together, none is left for the next cue", () => {
    const { cues, pieces } = build(["just:b start:b", "make:b it:m"], { cueGap: 900, tail: 900 });
    const own = pieces.filter((piece) => piece.id.startsWith("glint:0:") && !piece.id.includes(":tw"));
    const end = Math.max(...own.map((piece) => piece.toMs));
    expect(end).toBeLessThanOrEqual(cues[0]!.endMs);
    const t = end - 30;
    const opacities = own.map((piece) => evaluatePiece(piece, t).o);
    expect(Math.max(...opacities) - Math.min(...opacities)).toBeLessThan(0.001);
    expect(opacities[0]).toBeLessThan(1);
    expect(evaluatePiece(own[0]!, end - 120).o).toBe(1);
  });

  test("rows keep their painted depth off the next row's lettering", () => {
    const { cues, pieces } = build(["stop:b scrolling:b and:m listen:h@600", "does:b the:m remote:b even:b still:h@360"]);
    for (const cue of cues) {
      const rest = cue.words.at(-1)!.startMs + 200;
      const boxOf = (w: number, suffix = "") =>
        pieces
          .filter((piece) => new RegExp(`^glint:${cue.index}:w${w}(l\\d+)?${suffix}$`).test(piece.id))
          .map((piece) => ({ box: pieceBounds(piece, rest, fakeMeasure)!, size: piece.kind === "text" ? piece.sizePx : 0 }));
      for (let w = 0; w + 1 < cue.words.length; w++) {
        const here = boxOf(w);
        const next = boxOf(w + 1);
        const hereBottom = Math.max(...here.map((item) => item.box.y2));
        const hereCentre = (Math.min(...here.map((item) => item.box.y1)) + hereBottom) / 2;
        const nextTop = Math.min(...next.map((item) => item.box.y1));
        if (nextTop < hereCentre) continue; // the same row
        const depthBottom = Math.max(...boxOf(w, "b").concat(boxOf(w, "e")).map((item) => item.box.y2 - 0.07 * item.size));
        expect(depthBottom, `cue ${cue.index} word ${w}`).toBeLessThanOrEqual(nextTop + 30);
      }
    }
  });

  test("a word wider than the column breaks across rows at a readable size", () => {
    const word = "pneumonoultramicroscopicsilicovolcanoconiosis";
    const { pieces } = build([`${word}:h@900`]);
    const parts = pieces.filter((piece) => /^glint:0:w0l\d$/.test(piece.id));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.map((piece) => (piece.kind === "text" ? piece.text : "")).join("")).toBe(word.toUpperCase());
    for (const piece of parts) expect(piece.kind === "text" && piece.sizePx).toBeGreaterThanOrEqual(80);
  });

  test("a long word splits into the fewest rows and the rows come out even, never a stray last letter", () => {
    const word = "unbelievablyextraordinarily";
    const { pieces } = build([`${word}:h@900`]);
    const parts = pieces.filter((piece) => /^glint:0:w0l\d$/.test(piece.id));
    const text = parts.map((piece) => (piece.kind === "text" ? piece.text : ""));
    expect(text.join("")).toBe(word.toUpperCase());
    expect(text.every((part) => part.length >= 0.6 * Math.max(...text.map((t) => t.length)))).toBe(true);
    expect(text.every((part) => !part.includes(" "))).toBe(true);
  });

  test("a short cue still twinkles, inside its own window, and no twinkle outlives the cue or starts before its key word", () => {
    const { cues, pieces } = build(["no:h@120 way:b", "ok:m fine:h@160", "yes:h@110"], { cueGap: 60, gap: 20, tail: 0 });
    for (const cue of cues) {
      const twinkles = pieces.filter((piece) => piece.id.startsWith(`glint:${cue.index}:tw`));
      const key = cue.words.find((word) => word.role === "hero") ?? cue.words.at(-1)!;
      expect(twinkles.length, `cue ${cue.index}`).toBeGreaterThanOrEqual(1);
      for (const piece of twinkles) {
        expect(piece.fromMs).toBeGreaterThanOrEqual(key.startMs);
        expect(piece.toMs).toBeLessThanOrEqual(cue.words.at(-1)!.endMs + 200);
      }
    }
  });

  test("the light pass is a thin strip along the top edge of the face, not a fill, and every cue has one even when it is short", () => {
    const { cues, pieces } = build(["just:b start:b today:h@600", "no:h@120 way:b", "ok:m fine:h@160"], { cueGap: 60, gap: 20, tail: 0 });
    for (const cue of cues) {
      const sheens = pieces.filter((piece) => new RegExp(`^glint:${cue.index}:w\\d(l\\d+)?h\\d*$`).test(piece.id));
      expect(sheens.length, `cue ${cue.index}`).toBeGreaterThan(0);
    }
    const sheen = pieces.find((piece) => piece.id === "glint:0:w0h")!;
    const face = pieces.find((piece) => piece.id === "glint:0:w0")!;
    const faceBox = pieceBounds(face, sheen.fromMs + 120, fakeMeasure)!;
    for (let t = sheen.fromMs; t < sheen.toMs; t += 20) {
      const clip = evaluatePiece(sheen, t).clip!;
      expect(clip.y2 - clip.y1, `t ${t}`).toBeLessThan(0.55 * (faceBox.y2 - faceBox.y1));
      expect(clip.y1, `t ${t}`).toBeLessThan(faceBox.y1 + 0.35 * (faceBox.y2 - faceBox.y1));
    }
  });

  test("twinkles are 18-28 px across, and none is alive in the cue's exit", () => {
    const { cues, pieces } = build(["so:m here:b is:h@500 it:b", "no:h@400 way:b"]);
    const cueEnd = Math.max(...pieces.filter((piece) => piece.id.startsWith("glint:0:w")).map((piece) => piece.toMs));
    const twinkles = pieces.filter((piece) => piece.id.startsWith("glint:0:tw"));
    expect(twinkles.length).toBeGreaterThanOrEqual(2);
    for (const piece of twinkles) {
      // Tip to tip plus the outline: the bounds helper returns the turned box and adds a miter spike at every point, neither is drawn.
      const at = piece.fromMs + 0.35 * 300;
      const box = pieceBounds({ ...piece, stroke: undefined }, at, fakeMeasure)!;
      const turn = (evaluatePiece(piece, at).rz * Math.PI) / 180;
      const across = (box.x2 - box.x1) / (Math.abs(Math.cos(turn)) + Math.abs(Math.sin(turn))) + (piece.stroke?.widthPx ?? 0);
      expect(across).toBeGreaterThanOrEqual(18);
      expect(across).toBeLessThanOrEqual(28);
      expect(piece.toMs).toBeLessThanOrEqual(cueEnd - 60);
    }
    expect(cues.length).toBe(2);
  });

  test("a colour the scene receives that cannot read against the dark outline falls back to the style's own", () => {
    const { cues } = demoCues({ lines: ["stop:b scrolling:b and:m listen:h@600"], options: { lead: 400, gap: 30, cueGap: 140, tail: 800 } });
    const run = (own: Partial<typeof colours>) => glintProgram.build(sceneInput(cues, { fps: 30, colours: { ...colours, ...own } })).pieces;
    const faceColours = (pieces: ReturnType<typeof run>) => new Set(pieces.filter((piece) => /^glint:0:w\d(l\d+)?$/.test(piece.id)).map((piece) => evaluatePiece(piece, piece.fromMs + 300).colour));
    expect([...faceColours(run({ primary: "#1A0F26", highlight: "#241033" }))].sort()).toEqual(["#FF2F8B", "#FFD320"]);
    expect([...faceColours(run({ primary: "#3CE0FF", highlight: "#FFA500" }))].sort()).toEqual(["#3CE0FF", "#FFA500"]);
    const sheens = (pieces: ReturnType<typeof run>) => pieces.filter((piece) => /^glint:0:w\d(l\d+)?h\d*$/.test(piece.id)).map((piece) => (piece.kind === "text" ? piece.fill : ""));
    expect(new Set(sheens(run({ accent: "#0B0614" })))).toEqual(new Set(["#FFFFFF"]));
  });

  test("ordinary phrases pack into three rows or fewer, portrait and landscape, before they stack four", () => {
    const lines = ["stop:b scrolling:b and:m listen:h@600", "does:b the:m remote:b even:b still:h@360", "it's:m free:b and:m easy:b", "we:m can:m move:h@300"];
    for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
      const { cues } = demoCues({ lines, options: { lead: 400, gap: 30, cueGap: 140, tail: 800 } });
      const pieces = glintProgram.build(sceneInput(cues, { fps: 30, colours, canvas })).pieces;
      for (const cue of cues) {
        const at = cue.words.at(-1)!.startMs + 200;
        const centres = cue.words
          .map((_, w) => pieces.find((piece) => new RegExp(`^glint:${cue.index}:w${w}(l0)?$`).test(piece.id))!)
          .map((piece) => {
            const box = pieceBounds(piece, at, fakeMeasure)!;
            return { y: (box.y1 + box.y2) / 2, h: box.y2 - box.y1 };
          });
        const sorted = [...centres].sort((a, b) => a.y - b.y);
        let rows = 1;
        for (let k = 1; k < sorted.length; k++) if (sorted[k]!.y > sorted[k - 1]!.y + 0.6 * sorted[k - 1]!.h) rows++;
        expect(rows, `${canvas.width}x${canvas.height} cue ${cue.index}`).toBeLessThanOrEqual(3);
      }
    }
  });

  test("a long word breaks into even rows at the fitted size, not the floor, and keeps its letters in order with no space", () => {
    const word = "contemporaneousness";
    const { pieces } = build([`${word}:h@900`]);
    const parts = pieces.filter((piece) => /^glint:0:w0l\d$/.test(piece.id));
    const text = parts.map((piece) => (piece.kind === "text" ? piece.text : ""));
    expect(text.join("")).toBe(word.toUpperCase());
    expect(text.some((part) => /\s/.test(part))).toBe(false);
    const sizes = new Set(parts.map((piece) => (piece.kind === "text" ? piece.sizePx : 0)));
    expect(sizes.size).toBe(1);
    expect([...sizes][0]!).toBeGreaterThan(142 * 0.82 + 8);
  });

  test("fragments of a broken word never share a row, even in the 16:9 overlapping-speaker lane at twice the size", () => {
    const src = demoCues({
      lines: ["contemporaneousness:h@520 creativity:b@380 great:b@250", "we:m@190 move:h@500 quickly:b@360", "next:b@245 scene:h@340"],
      options: { lead: 400, gap: 30, cueGap: 50, tail: 380 },
    }).cues;
    const shifts = [0, -940, -860];
    const cues = src.map((cue, i) => ({
      ...cue,
      speaker: i === 1 ? 1 : 0,
      startMs: cue.startMs + shifts[i]!,
      endMs: cue.endMs + shifts[i]!,
      words: cue.words.map((word) => ({ ...word, startMs: word.startMs + shifts[i]!, endMs: word.endMs + shifts[i]! })),
    }));
    for (const canvas of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }]) {
      const pieces = glintProgram.build(sceneInput(cues, { fps: 30, colours, scale: 2, canvas })).pieces;
      for (const cue of cues) {
        const at = cue.words.at(-1)!.endMs - 40;
        const fragments = pieces.filter((piece) => new RegExp(`^glint:${cue.index}:w\\d+l\\d+$`).test(piece.id) && piece.kind === "text" && piece.id.endsWith(piece.id.match(/w\d+l\d+$/)![0]));
        const byWord = new Map<string, typeof fragments>();
        for (const piece of fragments) byWord.set(piece.id.match(/w\d+/)![0], [...(byWord.get(piece.id.match(/w\d+/)![0]) ?? []), piece]);
        for (const [word, parts] of byWord) {
          const broken = parts.filter((piece) => /l\d+$/.test(piece.id) && piece.kind === "text" && piece.text.length > 1);
          if (broken.length < 2 || broken.length !== parts.length) continue; // a hero word's single letters are not fragments
          const ys = broken.map((piece) => evaluatePiece(piece, at).y);
          const heights = broken.map((piece) => (piece.kind === "text" ? piece.sizePx : 0));
          for (let a = 0; a < ys.length; a++) for (let b = a + 1; b < ys.length; b++) expect(Math.abs(ys[a]! - ys[b]!), `${canvas.width}x${canvas.height} cue ${cue.index} ${word}`).toBeGreaterThan(0.9 * Math.min(heights[a]!, heights[b]!));
        }
      }
    }
  });

  test("sparkles keep a white fill wider than their dark outline", () => {
    const { pieces } = build(["so:m here:b is:h@500 it:b"]);
    const sparks = pieces.filter((piece) => piece.id.startsWith("glint:0:tw") && piece.kind === "shape");
    expect(sparks.length).toBeGreaterThan(0);
    for (const piece of sparks) {
      if (piece.kind !== "shape") continue;
      const points = piece.path.filter((cmd) => cmd[0] === "L");
      if (points.length < 4) continue; // a heart
      // The waist is the star's arm width: the outline may take at most a quarter of it.
      const waist = Math.abs((points[0] as ["L", number, number])[1] * 2);
      expect(piece.stroke!.widthPx).toBeLessThanOrEqual(0.25 * waist);
    }
  });

  test("a key word on a 70-80 ms cue still gets a light pass on every letter, a static top-edge strip", () => {
    const { cues, pieces } = build(["go:b now:h@75"], { cueGap: 40, tail: 0 });
    const letters = pieces.filter((piece) => /^glint:0:w1l\d$/.test(piece.id));
    expect(letters).toHaveLength(3);
    for (const letter of letters) {
      const sheen = pieces.find((piece) => piece.id === `${letter.id}h`);
      expect(sheen, letter.id).toBeDefined();
      expect(sheen!.toMs - sheen!.fromMs).toBeGreaterThanOrEqual(1000 / 30);
      const box = pieceBounds({ ...letter, clip: undefined }, sheen!.fromMs + 5, fakeMeasure)!;
      const clip = evaluatePiece(sheen!, sheen!.fromMs + 5).clip!;
      expect(clip.x1).toBeLessThanOrEqual(box.x1 + 4);
      expect(clip.x2).toBeGreaterThanOrEqual(box.x2 - 4);
      expect(clip.y2 - clip.y1).toBeLessThan(0.55 * (box.y2 - box.y1));
    }
    expect(cues[0]!.words[1]!.endMs - cues[0]!.words[1]!.startMs).toBeLessThanOrEqual(90);
  });

  test("a cue stays inside the safe area at twice the size, portrait and landscape, and under the piece budget", () => {
    for (const edge of ["urdu", "nine-words", "long-word"] as const) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
        const { cues } = sceneEdgeDemo(edge);
        const pieces = glintProgram.build(sceneInput(cues, { fps: 30, colours, scale: 2, canvas })).pieces;
        for (const cue of cues) {
          const own = pieces.filter((piece) => piece.id.startsWith(`glint:${cue.index}:`));
          expect(own.length, `${edge} cue ${cue.index}`).toBeLessThanOrEqual(150);
        }
      }
    }
  });
});
