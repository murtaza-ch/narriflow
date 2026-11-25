import { describe, expect, test } from "bun:test";
import { captionColourContrast } from "@narriflow/validators";
import { describeSpeechConformance } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameAtOrAfter, exportFrameTimes } from "./frame-grid";
import { type Box, type Piece, SCENE_PIECE_BUDGET, type ShapePiece, type TextPiece, evaluatePiece, pieceBounds } from "./scene";
import { marqueeProgram } from "./templates/marquee";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("marquee", marqueeProgram, { anchorLineY: 1280 });

const colours = { primary: "#F5E0B6", highlight: "#D8382B", accent: "#2A7A6C", shadow: "#000000" };
const build = (lines: string[], opts: { gap?: number; cueGap?: number; language?: string; fps?: number; primary?: string; highlight?: string; accent?: string; canvas?: { width: number; height: number } } = {}) => {
  const { cues } = demoCues({ lines, language: opts.language, options: { lead: 400, gap: opts.gap ?? 30, cueGap: opts.cueGap ?? 140, tail: 800 } });
  const input = sceneInput(cues, { fps: opts.fps ?? 30, colours: { ...colours, ...(opts.primary ? { primary: opts.primary } : {}), ...(opts.highlight ? { highlight: opts.highlight } : {}), ...(opts.accent ? { accent: opts.accent } : {}) }, ...(opts.canvas ? { canvas: opts.canvas } : {}), anchor: { xPct: 50, yPct: (1280 / 1920) * 100 } });
  return { cues, pieces: marqueeProgram.build(input).pieces };
};
const mine = (pieces: Piece[], cue: number) => pieces.filter((piece) => piece.id.startsWith(`marquee:${cue}:`));
const faceRe = (cue: number) => new RegExp(`^marquee:${cue}:w\\d+(?:l\\d+)?$`);
const faces = (pieces: Piece[], cue: number) => mine(pieces, cue).filter((piece): piece is TextPiece => piece.kind === "text" && faceRe(cue).test(piece.id));
const named = (pieces: Piece[], cue: number, name: string) => mine(pieces, cue).filter((piece) => piece.id === `marquee:${cue}:${name}`);
const meets = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
const at = (piece: Piece, t: number) => evaluatePiece(piece, t);

describe("marquee", () => {
  test("the plate, rim, rays and bulbs are there on the first word, the disc waits for the key word", () => {
    const { cues, pieces } = build(["the:m good:b old:b days:h@600"]);
    const first = cues[0]!.words[0]!.startMs;
    const heroStart = cues[0]!.words[3]!.startMs;
    for (const name of ["plate", "rim-top", "rim-tl", "rays0t"]) {
      const piece = named(pieces, 0, name)[0]!;
      expect(piece, name).toBeDefined();
      expect(piece.fromMs).toBe(first);
      expect(pieceBounds(piece, exportFrameAtOrAfter(first + 120, 30), fakeMeasure), name).not.toBeNull();
    }
    const disc = named(pieces, 0, "disc")[0]!;
    expect(disc.fromMs).toBe(heroStart);
    expect(named(pieces, 0, "swoosh")[0]!.fromMs).toBeGreaterThanOrEqual(heroStart);
  });

  test("a cue with no key word opens plate and disc together on its first word", () => {
    const { cues, pieces } = build(["see:b you:m next:b time:b"]);
    const first = cues[0]!.words[0]!.startMs;
    expect(named(pieces, 0, "plate")[0]!.fromMs).toBe(first);
    expect(named(pieces, 0, "disc")[0]!.fromMs).toBe(first);
    expect(faces(pieces, 0)).toHaveLength(4);
  });

  test("the plate wipes open from the middle in at most three painted frames and ends fully open", () => {
    for (const fps of [24, 25, 30, 60]) {
      const { cues, pieces } = build(["legends:h@700"], { fps });
      const plate = named(pieces, 0, "plate")[0]!;
      const start = cues[0]!.words[0]!.startMs;
      const times = exportFrameTimes(start, start + 300, fps);
      const widths = times.map((t) => { const clip = at(plate, t).clip!; return clip.x2 - clip.x1; });
      expect(widths[0]!).toBeGreaterThan(0);
      for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeGreaterThanOrEqual(widths[i - 1]! - 1e-6);
      const full = widths.at(-1)!;
      expect(widths.findIndex((w) => w >= full - 0.5)).toBeLessThanOrEqual(2);
    }
  });

  test("the words before the key word arch over the disc, the words after it arch under it, each in reading order", () => {
    const { cues, pieces } = build(["so:b it:m is:b brave:h@500 and:b true:b"]);
    const t = cues[0]!.words.at(-1)!.endMs - 1;
    const centre = (piece: Piece) => { const b = pieceBounds(piece, t, fakeMeasure)!; return { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 }; };
    const hero = centre(faces(pieces, 0).find((piece) => piece.id === "marquee:0:w3")!);
    const lead = faces(pieces, 0).filter((piece) => /:w[012]l\d+$/.test(piece.id));
    const tail = faces(pieces, 0).filter((piece) => /:w[45]l\d+$/.test(piece.id));
    expect(lead.length).toBeGreaterThan(0);
    expect(tail.length).toBeGreaterThan(0);
    for (const piece of lead) expect(centre(piece).y).toBeLessThan(hero.y);
    for (const piece of tail) expect(centre(piece).y).toBeGreaterThan(hero.y);
    // Left to right along each arch: word 0 before 1 before 2, word 4 before 5.
    const mean = (list: Piece[], word: number) => { const own = list.filter((piece) => piece.id.includes(`:w${word}l`)); return own.reduce((sum, piece) => sum + centre(piece).x, 0) / own.length; };
    expect(mean(lead, 0)).toBeLessThan(mean(lead, 1));
    expect(mean(lead, 1)).toBeLessThan(mean(lead, 2));
    expect(mean(tail, 4)).toBeLessThan(mean(tail, 5));
  });

  test("arch letters sit on one ring: equal distance from its centre, turned with it", () => {
    const { cues, pieces } = build(["the:m good:b old:b days:h@500"]);
    const letters = faces(pieces, 0).filter((piece) => /:w[012]l\d+$/.test(piece.id));
    const t = cues[0]!.words.at(-1)!.endMs - 1;
    const poses = letters.map((piece) => at(piece, t));
    // Fit a circle through three letters and test the rest against it.
    const [a, b, c] = [poses[0]!, poses[Math.floor(poses.length / 2)]!, poses.at(-1)!];
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
    const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
    const radius = Math.hypot(a.x - ux, a.y - uy);
    for (const pose of poses) {
      expect(Math.abs(Math.hypot(pose.x - ux, pose.y - uy) - radius)).toBeLessThan(0.75);
      // The letter's turn is the angle of its radius from straight up.
      expect(Math.abs(pose.rz - (Math.atan2(pose.x - ux, -(pose.y - uy)) * 180) / Math.PI)).toBeLessThan(0.5);
    }
    expect(poses[0]!.rz).toBeLessThan(0);
    expect(poses.at(-1)!.rz).toBeGreaterThan(0);
  });

  test("an arch word swings in from the side the next word has not reached, on painted frames, and rests on the ring", () => {
    for (const fps of [24, 25, 30, 60]) {
      const { cues, pieces } = build(["the:m good:b old:b days:h@500"], { fps, cueGap: 140 });
      const word = cues[0]!.words[1]!;
      const letter = faces(pieces, 0).find((piece) => piece.id === "marquee:0:w1l0")!;
      const times = exportFrameTimes(word.startMs, word.startMs + 200, fps);
      const xs = times.map((t) => at(letter, t).x);
      expect(xs.length).toBeGreaterThan(2);
      // It starts right of its rest and moves left monotonically; a short word would settle without overshoot.
      expect(xs[0]!).toBeGreaterThan(xs.at(-1)! + 1);
      for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeLessThanOrEqual(xs[i - 1]! + 1e-6);
      for (const t of times) expect(at(letter, t).o).toBeGreaterThan(0.99);
    }
  });

  test("the key word pops from 80 % with one overshoot and settles tilted, extruded in navy with a navy outline", () => {
    const { cues, pieces } = build(["legends:h@700"]);
    const hero = faces(pieces, 0)[0]!;
    const start = cues[0]!.words[0]!.startMs;
    const scale = exportFrameTimes(start, start + 300, 30).map((t) => at(hero, t).sx);
    expect(scale[0]!).toBeLessThan(0.9);
    expect(Math.max(...scale)).toBeGreaterThan(1);
    expect(scale.at(-1)!).toBeCloseTo(1, 3);
    expect(at(hero, start + 600).rz).toBeCloseTo(-6, 3);
    expect(hero.fill).toBe("#F5E0B6");
    expect(hero.stroke?.colour).toBe("#222838");
    expect(hero.shadows).toHaveLength(2);
    expect(hero.shadows!.every((shadow) => shadow.colour === "#222838" && shadow.blur === 0)).toBe(true);
    // The extrusion is about 0.11 em long (27 px at 250 px): the sample's was 0.15 em.
    expect(Math.hypot(hero.shadows!.at(-1)!.dx, hero.shadows!.at(-1)!.dy) / hero.sizePx).toBeGreaterThan(0.1);
    expect(Math.hypot(hero.shadows!.at(-1)!.dx, hero.shadows!.at(-1)!.dy) / hero.sizePx).toBeLessThan(0.12);
  });

  test("nothing of a cue outlives its window: at a 60 ms gap the next cue's first frame is the first frame without the last", () => {
    const { cues, pieces } = build(["the:m good:b old:b days:h@300", "legends:h@400"], { cueGap: 60 });
    const nextStart = cues[1]!.words[0]!.startMs;
    for (const piece of mine(pieces, 0)) expect(piece.toMs, piece.id).toBeLessThanOrEqual(nextStart);
    // The hero of the first cue is readable through its spoken end.
    const hero = faces(pieces, 0).find((piece) => piece.id === "marquee:0:w3")!;
    const heroWord = cues[0]!.words[3]!;
    for (const t of exportFrameTimes(heroWord.startMs, heroWord.endMs, 30)) expect(at(hero, t).o).toBeGreaterThan(0.99);
  });

  test("a washed-out or near-navy brand colour falls back to the default face", () => {
    const { pieces } = build(["legends:h@600"], { primary: "#232A3B" });
    const hero = faces(pieces, 0)[0]!;
    expect(hero.fill).toBe("#F5E0B6");
    const ok = build(["legends:h@600"], { primary: "#FFFFFF" });
    expect(faces(ok.pieces, 0)[0]!.fill).toBe("#FFFFFF");
  });

  test("themes alternate on per-cue counters: key-word cues and plain cues count apart", () => {
    const { pieces } = build(["a:b legends:h@500", "see:b you:m", "more:b legends:h@500", "next:b time:b", "yes:h@400"], { cueGap: 200 });
    const plate = (cue: number) => (named(pieces, cue, "plate")[0] as ShapePiece).fill!.colour;
    expect(plate(0)).toBe("#2A7A6C");
    expect(plate(1)).toBe("#2A7A6C");
    expect(plate(2)).toBe("#D8382B");
    expect(plate(3)).toBe("#D8382B");
    expect(plate(4)).toBe("#2A7A6C");
  });

  test("a script that cannot be split into letters sets its support words whole in a straight row", () => {
    const { pieces } = build(["और:m अगर:b इसे:m सीधा:h@500"], { language: "hi" });
    const support = faces(pieces, 0).filter((piece) => !piece.id.endsWith(":w3"));
    expect(support).toHaveLength(3);
    for (const piece of support) {
      expect(piece.id).toMatch(/:w\d$/);
      expect(at(piece, 1500).rz).toBe(0);
    }
    const ys = new Set(support.map((piece) => Math.round(at(piece, 1500).y)));
    expect(ys.size).toBe(1);
  });

  test("a right to left cue reads right to left in its straight row and its key words", () => {
    const { pieces } = build(["مرحبا:b بكم:b في:b عالمنا:h@500"], { language: "ar" });
    const t = 1800;
    const x = (word: number) => at(faces(pieces, 0).find((piece) => piece.id === `marquee:0:w${word}`)!, t).x;
    expect(x(0)).toBeGreaterThan(x(1));
    expect(x(1)).toBeGreaterThan(x(2));
  });

  test("a long key word is broken into the fewest rows that keep half its size, with no space between fragments", () => {
    const { cues, pieces } = build(["so:m unbelievable:h@900"]);
    const parts = faces(pieces, 0).filter((piece) => piece.id.startsWith("marquee:0:w1l"));
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.map((piece) => piece.text).join("")).toBe(cues[0]!.words[1]!.text);
    expect(parts.every((piece) => !piece.text.includes(" "))).toBe(true);
    // Rows of one word share a size and stack without covering each other.
    expect(new Set(parts.map((piece) => Math.round(piece.sizePx))).size).toBe(1);
    const boxes = parts.map((piece) => pieceBounds(piece, 1800, fakeMeasure)!);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.y1).toBeGreaterThanOrEqual(boxes[i - 1]!.y1);
    expect(parts[0]!.sizePx).toBeGreaterThanOrEqual(0.5 * 250 * 0.99);
  });

  test("a long key word takes the smallest row count whose narrowest split fits at the size floor, then balances", () => {
    // 0.55 em per letter under the test measure: 780 px / (0.55 * 250 * 0.5) allows 11 letters in a row at the floor.
    const rowsOf = (word: string) => faces(build([`${word}:h@900`]).pieces, 0).length;
    expect(rowsOf("abcdefghijk")).toBe(1);
    expect(rowsOf("abcdefghijkl")).toBe(2);
    expect(rowsOf("abcdefghijklmnopqrstuv")).toBe(2);
    expect(rowsOf("abcdefghijklmnopqrstuvw")).toBe(3);
    const parts = faces(build(["contemporaneousness:h@900"]).pieces, 0).map((piece) => piece.text);
    expect(parts.join("")).toBe("contemporaneousness");
    const widths = parts.map((part) => part.length);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });

  test("a cue that would need four rows packs into three by shrinking first", () => {
    const rows = (lines: string[]) => new Set(faces(build(lines).pieces, 0).map((piece) => Math.round(at(piece, 3000).y))).size;
    expect(rows(["thought:b about:b these:b words:b today:b"])).toBeLessThanOrEqual(3);
  });

  test("a long run of support words shrinks, then flattens its ring, before it overflows; every letter stays inside the plate", () => {
    const { cues, pieces } = build(["we:m never:b really:b thought:b this:m would:b happen:h@600"]);
    const t = cues[0]!.words.at(-1)!.endMs - 1;
    const plate = pieceBounds(named(pieces, 0, "plate")[0]!, t, fakeMeasure)!;
    for (const piece of faces(pieces, 0)) {
      const box = pieceBounds(piece, t, fakeMeasure)!;
      expect(box.x1).toBeGreaterThanOrEqual(plate.x1);
      expect(box.x2).toBeLessThanOrEqual(plate.x2);
      expect(box.y1).toBeGreaterThanOrEqual(plate.y1);
      expect(box.y2).toBeLessThanOrEqual(plate.y2);
    }
  });

  test("no spoken word's ink is covered by another word of its cue, and decorations stay off the words", () => {
    const { pieces } = build(["it's:b time:b to:m say:b goodbye:h@420", "the:m remote:b doesn't:h@360 work.:b", "is:m it:m dead?:h@380", "to:m accidentally:b open:b them.:b"]);
    for (const cue of [0, 1, 2, 3]) {
      const live = faces(pieces, cue);
      for (const t of exportFrameTimes(Math.min(...live.map((p) => p.fromMs)), Math.max(...live.map((p) => p.toMs)), 30)) {
        const boxes = live.flatMap((piece) => { const b = pieceBounds(piece, t, fakeMeasure); return b && at(piece, t).o > 0.9 ? [{ piece, b }] : []; });
        for (const [i, a] of boxes.entries()) {
          for (const other of boxes.slice(i + 1)) {
            if (a.piece.id.split(":")[2]!.replace(/l\d+$/, "") === other.piece.id.split(":")[2]!.replace(/l\d+$/, "")) continue;
            const core = (box: Box): Box => ({ x1: box.x1 + 0.06 * (box.x2 - box.x1), x2: box.x2 - 0.06 * (box.x2 - box.x1), y1: box.y1 + 0.18 * (box.y2 - box.y1), y2: box.y2 - 0.18 * (box.y2 - box.y1) });
            expect(meets(core(a.b), core(other.b)), `${a.piece.id} / ${other.piece.id} at ${t}`).toBe(false);
          }
        }
        for (const star of mine(pieces, cue).filter((piece) => /star/.test(piece.id))) {
          const box = pieceBounds(star, t, fakeMeasure);
          if (!box) continue;
          for (const { piece, b } of boxes) expect(meets(box, b), `${star.id} over ${piece.id} at ${t}`).toBe(false);
        }
      }
    }
  });

  test("the marquee bulbs chase on a long hold, two phases swapping every 150 ms, and rest lit on a short cue", () => {
    const long = build(["legends:h@2400"]);
    const a = named(long.pieces, 0, "bulbs-top-a")[0]!;
    const b = named(long.pieces, 0, "bulbs-top-b")[0]!;
    const start = long.cues[0]!.words[0]!.startMs;
    const times = exportFrameTimes(start + 120, start + 1400, 30);
    const phases = times.map((t) => [at(a, t).o, at(b, t).o] as const);
    expect(phases.some(([x, y]) => x > 0.9 && y < 0.5)).toBe(true);
    expect(phases.some(([x, y]) => x < 0.5 && y > 0.9)).toBe(true);
    // A phase holds for at least four painted frames (no flicker).
    let run = 1;
    let first = true;
    for (let i = 1; i < phases.length - 1; i++) {
      if ((phases[i]![0] > 0.9) === (phases[i - 1]![0] > 0.9)) run++;
      else {
        if (!first) expect(run).toBeGreaterThanOrEqual(4);
        first = false;
        run = 1;
      }
    }
    const short = build(["go:h@80"], { cueGap: 0 });
    for (const piece of named(short.pieces, 0, "bulbs-top-a")) expect(at(piece, piece.fromMs).o).toBe(1);
  });

  test("the rays turn a few degrees every half second on a long hold and are one pose on a short cue; none outlives an exit", () => {
    const long = build(["legends:h@3200"]);
    // Four strips round the disc per pose (no bitmap of the whole plate), at most five poses.
    const top = mine(long.pieces, 0).filter((piece) => /rays\dt$/.test(piece.id));
    expect(top.length).toBeGreaterThan(2);
    expect(top.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < top.length; i++) expect(top[i]!.fromMs).toBe(top[i - 1]!.toMs);
    for (const strip of ["t", "b", "l", "r"]) expect(mine(long.pieces, 0).filter((piece) => new RegExp(`rays\\d${strip}$`).test(piece.id)).length).toBe(top.length);
    const short = build(["go:h@300"]);
    expect(mine(short.pieces, 0).filter((piece) => /rays\dt$/.test(piece.id))).toHaveLength(1);
  });

  test("the bare centre of the rays is drawn until the disc has popped, so words before the key word never sit over a hole", () => {
    const { cues, pieces } = build(["the:m good:b old:b days:h@600"]);
    const cores = mine(pieces, 0).filter((piece) => /rays\dc$/.test(piece.id));
    const hero = cues[0]!.words[3]!.startMs;
    expect(cores.length).toBeGreaterThan(0);
    const last = Math.max(...cores.map((piece) => piece.toMs));
    expect(last).toBeGreaterThanOrEqual(hero + 130);
    expect(last).toBeLessThanOrEqual(hero + 130 + 70);
    // The poses chain without a gap until then.
    for (let i = 1; i < cores.length; i++) expect(cores[i]!.fromMs).toBe(cores[i - 1]!.toMs);
    const plain = build(["legends:h@600"]);
    expect(Math.max(...mine(plain.pieces, 0).filter((piece) => /rays\dc$/.test(piece.id)).map((piece) => piece.toMs))).toBeLessThanOrEqual(plain.cues[0]!.words[0]!.startMs + 130 + 70);
  });

  test("the stars are in free space, twinkle again on a long hold and end on their last burst", () => {
    const { cues, pieces } = build(["the:m good:b old:b days:h@3600"]);
    const star = named(pieces, 0, "starA")[0]!;
    expect(star).toBeDefined();
    const start = star.fromMs;
    const times = exportFrameTimes(start, cues[0]!.endMs, 30);
    const scale = times.map((t) => at(star, t).sx);
    const dips = scale.filter((value, i) => value < 0.5 && (scale[i - 1] ?? 1) >= 0.5).length;
    expect(dips).toBeGreaterThanOrEqual(2);
    // After the last burst the scale rests at 1, so the exit can only fade it.
    expect(scale.at(-1)!).toBeCloseTo(1, 3);
    expect(named(pieces, 0, "starB")[0]).toBeDefined();
  });

  test("the whole cue fades together in the gap after the last word's reading hold, and is cut when two frames do not fit", () => {
    const { cues, pieces } = build(["legends:h@400", "next:h@400"], { cueGap: 300 });
    const word = cues[0]!.words[0]!;
    const hero = faces(pieces, 0)[0]!;
    const plate = named(pieces, 0, "plate")[0]!;
    const hold = word.endMs + 150;
    expect(at(hero, hold - 5).o).toBeCloseTo(1, 3);
    expect(at(plate, hold - 5).o).toBeCloseTo(1, 3);
    const fading = at(hero, cues[0]!.endMs - 20).o;
    expect(fading).toBeLessThan(1);
    const tight = build(["legends:h@400", "next:h@400"], { cueGap: 0 });
    const tightHero = faces(tight.pieces, 0)[0]!;
    expect(tightHero.track.o === undefined || at(tightHero, tight.cues[0]!.endMs - 20).o === 1).toBe(true);
  });

  test("the piece budget holds on the nine-word and long-word edge demos and every 16:9 cue", () => {
    for (const kind of ["nine-words", "long-word", "one-word", "no-hero", "urdu"] as const) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
        const pieces = marqueeProgram.build(sceneInput(sceneEdgeDemo(kind).cues, { canvas, anchor: { xPct: 50, yPct: (1280 / 1920) * 100 } })).pieces;
        const perCue = new Map<string, number>();
        for (const piece of pieces) perCue.set(piece.id.split(":")[1]!, (perCue.get(piece.id.split(":")[1]!) ?? 0) + 1 + (piece.shadows?.length ?? 0));
        for (const [cue, count] of perCue) expect(count, `${kind} cue ${cue} ${canvas.width}x${canvas.height}`).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
      }
    }
  });

  test("no cue-indexed table: a 60-cue run builds and keeps cycling themes and sides", () => {
    const lines = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? "say:b it:m loud:h@400" : i % 3 === 1 ? "a:b legends:h@300" : "see:b you:m next:b"));
    const { pieces } = build(lines, { cueGap: 100 });
    const plates = new Set(Array.from({ length: 60 }, (_, cue) => (named(pieces, cue, "plate")[0] as ShapePiece).fill!.colour));
    expect(plates.size).toBe(2);
    const sides = new Set(Array.from({ length: 20 }, (_, n) => { const star = named(pieces, n * 3 + (n % 2), "starA")[0]; return star ? Math.sign(at(star, star.fromMs + 100).x - 540) : 0; }));
    expect(sides.size).toBeGreaterThan(1);
  });
});

describe("marquee review fixes", () => {
  const fillOf = (piece: Piece) => (piece.kind === "text" ? piece.fill : (piece as ShapePiece).fill!.colour);

  test("a red, orange or pink brand colour never paints the key word on a disc or plate it cannot read against", () => {
    const primaries = ["#D8382B", "#E53935", "#FF5A3C", "#FF6FA8", "#2A7A6C", "#7FD6C2", "#FFFFFF", "#F5E0B6", "#222838", "#000000"];
    const others = [undefined, "#FFFFFF", "#D8382B", "#FF5A3C", "#101010"];
    for (const primary of primaries) {
      for (const highlight of others) {
        for (const accent of others) {
          // Two key-word cues (the second flips the theme: plate red, disc navy) and a plain cue.
          const { pieces } = build(["go:b legends:h@500", "so:b legends:h@500", "see:b you:m"], { primary, highlight, accent, cueGap: 300 });
          for (const cue of [0, 1, 2]) {
            const face = faces(pieces, cue)[0]!;
            const disc = fillOf(named(pieces, cue, "disc")[0]!);
            const plate = fillOf(named(pieces, cue, "plate")[0]!);
            const where = `${primary}/${highlight}/${accent} cue ${cue}`;
            expect(captionColourContrast(face.fill, disc), `face on disc, ${where}`).toBeGreaterThanOrEqual(3);
            expect(captionColourContrast(face.fill, plate), `face on plate, ${where}`).toBeGreaterThanOrEqual(3);
            if (face.stroke) expect(captionColourContrast(face.fill, face.stroke.colour), `face on outline, ${where}`).toBeGreaterThanOrEqual(3);
          }
        }
      }
    }
    // A red face on the default red disc goes back to the default face rather than painting red on red.
    for (const primary of ["#D8382B", "#FF5A3C"]) expect(faces(build(["legends:h@500"], { primary }).pieces, 0)[0]!.fill).toBe("#F5E0B6");
    // A face that reads is kept.
    expect(faces(build(["legends:h@500"], { primary: "#FFFFFF" }).pieces, 0)[0]!.fill).toBe("#FFFFFF");
  });

  const arcOf = (piece: ShapePiece) => {
    const first = piece.path[0] as readonly ["M", number, number];
    const last = piece.path.at(-1) as readonly ["C", number, number, number, number, number, number];
    const radius = Math.hypot(first[1], first[2]);
    const a0 = (Math.atan2(first[2], first[1]) * 180) / Math.PI;
    let a1 = (Math.atan2(last[6], last[5]) * 180) / Math.PI;
    while (a1 < a0) a1 += 360;
    const points = [];
    for (let a = a0; a <= a1 + 1e-6; a += 4) points.push({ x: radius * Math.cos((a * Math.PI) / 180), y: radius * Math.sin((a * Math.PI) / 180) });
    return points;
  };
  const arcCases = [
    "the:m good:b old:b days:h@600",
    "even:b still:b work:h@500",
    "so:b it:m is:b brave:h@500 and:b true:b",
    "work.:h@600",
    "everything:b brave:h@500",
    "सीधा:h@500",
    "और:m अगर:b इसे:m सीधा:h@400",
    "to:m accidentally:b open:b them.:b",
  ];

  test("the cream arc keeps 12 px clear of every word, is drawn from the end away from the key word, and is complete by the key word's spoken end", () => {
    for (const line of arcCases) {
      const { cues, pieces } = build([line], { language: /[\u0900-\u097F]/.test(line) ? "hi" : undefined });
      const arc = named(pieces, 0, "swoosh")[0] as ShapePiece | undefined;
      if (!arc) continue;
      const rest = cues[0]!.words.at(-1)!.endMs - 1;
      const pose = at(arc, rest);
      const stroke = arc.stroke!.widthPx;
      const words = faces(pieces, 0).map((piece) => pieceBounds(piece, rest, fakeMeasure)!);
      for (const point of arcOf(arc)) {
        const box: Box = { x1: pose.x + point.x - stroke / 2 - 10, x2: pose.x + point.x + stroke / 2 + 10, y1: pose.y + point.y - stroke / 2 - 10, y2: pose.y + point.y + stroke / 2 + 10 };
        for (const word of words) expect(meets(box, word), `${line}: arc point on a word`).toBe(false);
      }
      const hero = cues[0]!.words.find((word) => word.role === "hero");
      if (!hero) continue;
      // (Measured on points along the drawn arc; the revealed box is the path's control-point bounds, so 3 px of tolerance.)
      // Whole by the key word's spoken end whenever it has three painted frames to be drawn in.
      const last = exportFrameTimes(arc.fromMs, hero.endMs, 30).at(-1)!;
      const drawnAt = at(arc, last);
      const pts = arcOf(arc).map((point) => ({ x: drawnAt.x + point.x, y: drawnAt.y + point.y }));
      const whole: Box = { x1: Math.min(...pts.map((q) => q.x)), x2: Math.max(...pts.map((q) => q.x)), y1: Math.min(...pts.map((q) => q.y)), y2: Math.max(...pts.map((q) => q.y)) };
      const shown = pieceBounds(arc, last, fakeMeasure)!;
      expect(shown.x1, line).toBeLessThanOrEqual(whole.x1 + 3);
      expect(shown.x2, line).toBeGreaterThanOrEqual(whole.x2 - 3);
      expect(shown.y1, line).toBeLessThanOrEqual(whole.y1 + 3);
      expect(shown.y2, line).toBeGreaterThanOrEqual(whole.y2 - 3);
      // The first revealed stroke is the far end: it is farther from the key word than the arc's middle is.
      const frames = exportFrameTimes(arc.fromMs, hero.endMs, 30);
      if (frames.length >= 3) {
        const first = pieceBounds(arc, frames[1]!, fakeMeasure);
        const heroBox = faces(pieces, 0).filter((piece) => /:w\d+$/.test(piece.id) && cues[0]!.words[Number(piece.id.split(":w")[1])]!.role === "hero").map((piece) => pieceBounds(piece, rest, fakeMeasure)!)[0]!;
        const gap = (box: Box) => Math.hypot(Math.max(heroBox.x1 - (box.x1 + box.x2) / 2, 0, (box.x1 + box.x2) / 2 - heroBox.x2), Math.max(heroBox.y1 - (box.y1 + box.y2) / 2, 0, (box.y1 + box.y2) / 2 - heroBox.y2));
        if (first) expect(gap(first), line).toBeGreaterThanOrEqual(gap(whole) - 1);
      }
    }
  });

  test("a star never sits on the arc", () => {
    for (const line of arcCases) {
      const { cues, pieces } = build([line], { language: /[\u0900-\u097F]/.test(line) ? "hi" : undefined });
      const arc = named(pieces, 0, "swoosh")[0] as ShapePiece | undefined;
      if (!arc) continue;
      const rest = cues[0]!.words.at(-1)!.endMs - 1;
      const pose = at(arc, rest);
      for (const star of mine(pieces, 0).filter((piece) => /star/.test(piece.id))) {
        const box = pieceBounds(star, rest, fakeMeasure);
        if (!box) continue;
        for (const point of arcOf(arc)) {
          const dot: Box = { x1: pose.x + point.x - 4, x2: pose.x + point.x + 4, y1: pose.y + point.y - 4, y2: pose.y + point.y + 4 };
          expect(meets(box, dot), `${line}: ${star.id} on the arc`).toBe(false);
        }
      }
    }
  });

  test("a very short cue opens its plate on the first painted frame, and a five-frame cue in two", () => {
    for (const fps of [24, 25, 30, 60]) {
      const { cues, pieces } = build(["one:h@70", "two:h@70", "three:b four:h@120"], { cueGap: 0, fps });
      for (const cue of cues) {
        const plate = named(pieces, cue.index, "plate")[0];
        if (!plate) continue;
        const times = exportFrameTimes(plate.fromMs, plate.toMs, fps);
        const widths = times.map((t) => { const clip = at(plate, t).clip!; return clip.x2 - clip.x1; });
        const full = Math.max(...widths);
        const opened = widths.findIndex((w) => w >= full - 0.5);
        const limit = times.length <= 3 ? 0 : times.length <= 5 ? 1 : 2;
        expect(opened, `cue ${cue.index} at ${fps} fps (${times.length} frames)`).toBeLessThanOrEqual(limit);
      }
    }
  });

  test("the bulbs chase on an ordinary 540 ms cue and rest lit below about 300 ms", () => {
    const { cues, pieces } = build(["good:b old:b days:h@300"], { gap: 0, cueGap: 0 });
    const a = named(pieces, 0, "bulbs-top-a")[0]!;
    const b = named(pieces, 0, "bulbs-top-b")[0]!;
    const times = exportFrameTimes(a.fromMs, cues[0]!.words.at(-1)!.endMs, 30);
    const states = times.map((t) => `${at(a, t).o > 0.9 ? 1 : 0}${at(b, t).o > 0.9 ? 1 : 0}`);
    expect(new Set(states).size).toBeGreaterThanOrEqual(2);
    const short = build(["go:h@200", "go:h@200"], { cueGap: 0 });
    const lit = named(short.pieces, 0, "bulbs-top-a")[0]!;
    for (const t of exportFrameTimes(lit.fromMs, lit.toMs, 30)) expect(at(lit, t).o).toBe(1);
  });
});
