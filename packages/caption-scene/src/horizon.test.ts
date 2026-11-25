import { describe, expect, test } from "bun:test";
import { describeSpeechConformance, fastRun } from "./conformance-support";
import { demoCues, sceneEdgeDemo } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { captionColourContrast } from "@narriflow/validators";
import { type Box, type Piece, SCENE_PIECE_BUDGET, evaluatePiece, pieceBounds } from "./scene";
import { horizonProgram, horizonSparklePath } from "./templates/horizon";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("horizon", horizonProgram, { anchorLineY: 1290 });

const colours = { primary: "#F7EEFF", highlight: "#FF52D6", accent: "#7DF3FF", shadow: "#000000" };
const anchor = { xPct: 50, yPct: (1290 / 1920) * 100 };
const build = (lines: string[], language: string | null = null, fps = 30, overrides: Parameters<typeof sceneInput>[1] = {}, cueGap = 300) => {
  const { cues } = demoCues({ lines, language: language ?? undefined, options: { lead: 400, gap: 40, cueGap, tail: 800 } });
  return { cues, pieces: horizonProgram.build(sceneInput(cues, { fps, colours, anchor, ...overrides })).pieces };
};
const faceRe = (cue: number) => new RegExp(`^horizon:${cue}:w\\d+(l\\d+)?$`);
const faces = (pieces: readonly Piece[], cue: number) => pieces.filter((p) => faceRe(cue).test(p.id));
const own = (pieces: readonly Piece[], cue: number, tag: string) => pieces.filter((p) => p.id.startsWith(`horizon:${cue}:${tag}`));
const text = (piece: Piece) => (piece.kind === "text" ? piece.text : "");

describe("horizon", () => {
  test("every word is whole on its first painted frame: opaque, unclipped, no wipe, close to its rest place", () => {
    const { cues, pieces } = build(["future:h@900 is:m loading:b", "no:b brakes:b no:b limits:b"]);
    for (const cue of cues) {
      for (const [at, word] of cue.words.entries()) {
        const face = pieces.find((p) => p.id === `horizon:${cue.index}:w${at}`)!;
        expect(face.clip).toBeUndefined();
        const t = exportFrameTimes(word.startMs, word.endMs, 30)[0]!;
        const first = evaluatePiece(face, t);
        const rest = evaluatePiece(face, word.startMs + 400);
        expect(first.o).toBe(1);
        expect(Math.abs(first.x - rest.x)).toBeLessThanOrEqual(0.09 * (face.kind === "text" ? face.sizePx : 0) + 0.01);
        expect(pieceBounds(face, t, fakeMeasure)).not.toBeNull();
      }
    }
  });

  test("the key word is a banded chrome: the word's own pale edge with its extrusion under six clipped colour bands cut from its cap height", () => {
    const { pieces } = build(["so:m future:h@900"]);
    const face = pieces.find((p) => p.id === "horizon:0:w1")!;
    if (face.kind !== "text") throw new Error("text");
    const bands = [0, 1, 2, 3, 4, 5].map((k) => pieces.find((p) => p.id === `horizon:0:w1b${k}`)!);
    expect(bands.every((band) => band.clip)).toBe(true);
    for (const band of bands) expect(band.z).toBeGreaterThan(face.z);
    // The bands tile the cap height without a gap: each starts where the one above ended.
    const cuts = bands.map((band) => [band.clip!.y1[0]![1], band.clip!.y2[0]![1]] as const);
    for (let k = 1; k < cuts.length; k++) expect(cuts[k]![0]).toBeCloseTo(cuts[k - 1]![1], 3);
    expect(face.shadows?.length).toBe(1);
    expect(face.stroke!.widthPx).toBeGreaterThan(0.02 * face.sizePx);
  });

  test("the badge, its rim, bars and scan all sit behind every word, and no word is ever clipped by the aperture", () => {
    const { cues, pieces } = build(["future:h@900 is:m loading:b", "no:b brakes:b no:b limits:b no:b regrets"]);
    for (const cue of cues) {
      const lowestFace = Math.min(...faces(pieces, cue.index).map((p) => p.z));
      for (const tag of ["plate", "rimglow", "inner", "bars", "scan", "flash", "line"]) {
        for (const piece of own(pieces, cue.index, tag)) expect(piece.z, piece.id).toBeLessThan(lowestFace);
      }
      for (const face of faces(pieces, cue.index)) expect(face.clip).toBeUndefined();
    }
  });

  test("the plate opens out of an 8 px line in 90 ms with a cubic-out, and the rim flash is at most 20 % for two frames", () => {
    const { cues, pieces } = build(["future:h@900 is:m loading:b"]);
    const line = pieces.find((p) => p.id === "horizon:0:line")!;
    expect(line).toBeDefined();
    expect(exportFrameTimes(line.fromMs, line.toMs, 30).length).toBe(2);
    const plate = pieces.find((p) => p.id === "horizon:0:plate")!;
    const open = (t: number) => {
      const clip = evaluatePiece(plate, t).clip!;
      return clip.y2 - clip.y1;
    };
    const t1 = exportFrameTimes(plate.fromMs, plate.toMs, 30)[1]!;
    expect(open(plate.fromMs)).toBe(0);
    expect(open(t1 + 91)).toBeCloseTo(open(t1 + 400), 3);
    expect(open(t1 + 30)).toBeGreaterThan(0.5 * open(t1 + 400));
    const flash = pieces.find((p) => p.id === "horizon:0:flash0")!;
    expect(exportFrameTimes(flash.fromMs, flash.toMs, 30).length).toBe(2);
    expect(evaluatePiece(flash, flash.fromMs).o).toBeLessThanOrEqual(0.2);
    expect(cues[0]!.words[0]!.startMs).toBeGreaterThan(line.fromMs);
  });

  test("a cue that opens with no time before its first word shows the plate at once instead of blinking it shut", () => {
    const { cues, pieces } = build(["no:b brakes:b", "no:b limits:b"], null, 30, {}, 0);
    const plate = pieces.find((p) => p.id === "horizon:1:plate")!;
    const t = exportFrameTimes(cues[1]!.words[0]!.startMs, cues[1]!.words[0]!.endMs, 30)[0]!;
    expect(pieces.some((p) => p.id === "horizon:1:line")).toBe(false);
    expect(pieceBounds(plate, t, fakeMeasure)).not.toBeNull();
  });

  test("the plate collapses in the last 66 ms only, after the reading hold, while the words are still readable until it", () => {
    const { cues, pieces } = build(["future:h@900"], null, 30, {}, 300);
    const cue = cues[0]!;
    const plate = pieces.find((p) => p.id === "horizon:0:plate")!;
    const word = cue.words[0]!;
    const hold = word.endMs + 150;
    for (const t of exportFrameTimes(plate.fromMs, hold, 30)) {
      if (t < word.startMs + 90) continue;
      expect(pieceBounds(plate, t, fakeMeasure), `plate at ${t}`).not.toBeNull();
    }
    const frames = exportFrameTimes(plate.fromMs, plate.toMs, 30);
    const height = (t: number) => {
      const clip = evaluatePiece(plate, t).clip!;
      return clip.y2 - clip.y1;
    };
    // Closing starts no earlier than 66 ms (two frames) before the last frame and is shut by it.
    expect(height(frames.at(-1)!)).toBe(0);
    expect(height(frames.at(-4)!)).toBeGreaterThan(500);
  });

  test("the palette steps on each pause and cycles by a counter, never by cue index", () => {
    const { pieces } = build(["a:h@500", "b:h@500", "c:h@500", "d:h@500", "plain one", "plain two", "plain three"]);
    const edge = (cue: number) => {
      const piece = pieces.find((p) => p.id === `horizon:${cue}:rim0`)!;
      return piece.kind === "shape" ? piece.stroke!.colour : "";
    };
    expect(new Set([0, 1, 2].map(edge)).size).toBe(3);
    expect(edge(3)).toBe(edge(0));
    expect(edge(4)).toBe(edge(1));
    expect(edge(6)).toBe(edge(0));
  });

  test("back-to-back cues keep one palette and a pause takes the next, so fast speech does not strobe", () => {
    const rimOf = (pieces: readonly Piece[], cue: number) => {
      const piece = pieces.find((p) => p.id === `horizon:${cue}:rim0`)!;
      return piece.kind === "shape" ? piece.stroke!.colour : "";
    };
    for (const gap of [0, 60, 120]) {
      const { cues, pieces } = build(["so:m here:b is:h@300", "the:m thing:b", "nobody:b tells:b you", "this:h@300", "ok"], null, 30, {}, gap);
      expect(new Set(cues.map((cue) => rimOf(pieces, cue.index))).size, `gap ${gap}`).toBe(1);
    }
    const { cues, pieces } = build(["so:m here:b is:h@300", "the:m thing:b", "nobody:b tells:b you"], null, 30, {}, 160);
    expect(new Set(cues.map((cue) => rimOf(pieces, cue.index))).size).toBe(3);
    // A pause after a run starts a new palette; the run itself stays whole.
    const mixed = demoCues({ lines: ["one:b two:b", "three:b four:b", "five:b six:b"], options: { lead: 400, gap: 40, cueGap: 0, tail: 800 } }).cues;
    const shifted = [mixed[0]!, mixed[1]!, { ...mixed[2]!, startMs: mixed[2]!.startMs + 400, endMs: mixed[2]!.endMs + 400, words: mixed[2]!.words.map((w) => ({ ...w, startMs: w.startMs + 400, endMs: w.endMs + 400 })) }];
    const out = horizonProgram.build(sceneInput(shifted, { fps: 30, colours, anchor })).pieces;
    expect(rimOf(out, 0)).toBe(rimOf(out, 1));
    expect(rimOf(out, 2)).not.toBe(rimOf(out, 1));
  });

  test("a grey or deep-pink brand that only fails 3:1 against the plate as drawn (90 % over footage) falls back to the default face", () => {
    for (const grey of ["#636363", "#686868", "#696969", "#C2185B"]) {
      const { pieces } = build(["no:b brakes:b"], null, 30, { colours: { ...colours, primary: grey, highlight: grey, accent: grey } });
      const face = pieces.find((p) => p.id === "horizon:0:w0")!;
      expect(face.kind === "text" && face.fill, grey).toBe("#F7EEFF");
      const rim = pieces.find((p) => p.id === "horizon:0:rim0")!;
      expect(rim.kind === "shape" && rim.stroke!.colour, grey).not.toBe(grey);
    }
  });

  test("a plain word's glow never sits on its own face colour: near-white face and near-white highlight keep a glow that shows", () => {
    const { pieces } = build(["no:b brakes:b"], null, 30, { colours: { ...colours, primary: "#FFFFFF", highlight: "#FFF4FF" } });
    const glow = pieces.find((p) => p.id === "horizon:0:w0g")!;
    expect(glow.kind === "text" && glow.fill).not.toBe("#FFF4FF");
    expect(glow.kind === "text" && captionColourContrast("#FFFFFF", glow.fill)).toBeGreaterThanOrEqual(1.5);
  });

  test("labels stay at 42 px or more in portrait while the key word gives the height, and the key word stays at 111 px or more", () => {
    const { cues, pieces } = build([
      "our:b whole:b team:m week:b episode:h@900",
      "this:m is:m the:b longest:b episode:h@900",
      "welcome:b back:b to:m channel:b everyone:h@900",
      "everyone:h@900 thanks:b for:m watching:b",
      "inch:b display:h@700 glare:b",
      "so:m unbelievable:h@900 right:b",
    ]);
    for (const cue of cues) {
      const sizes = faces(pieces, cue.index).flatMap((p) => (p.kind === "text" ? [{ face: p.face, size: p.sizePx }] : []));
      for (const { face, size } of sizes) {
        if (face === "Orbitron Black") expect(size, `cue ${cue.index} label`).toBeGreaterThanOrEqual(0.9 * 46 - 0.01);
        else expect(size, `cue ${cue.index} key word`).toBeGreaterThanOrEqual(111 - 0.01);
      }
    }
  });

  test("on a tight hand-off the plate re-opens from most of the way over its first painted frames instead of cutting to full, and never blinks shut", () => {
    const { cues, pieces } = build(["no:b brakes:b no:b", "limits:b no:b regrets:b"], null, 30, {}, 0);
    const plate = pieces.find((p) => p.id === "horizon:1:plate")!;
    const frames = exportFrameTimes(cues[1]!.words[0]!.startMs, cues[1]!.words.at(-1)!.endMs + 150, 30);
    const open = (t: number) => {
      const clip = evaluatePiece(plate, t).clip!;
      return (clip.y2 - clip.y1) / 568;
    };
    expect(open(plate.fromMs)).toBeGreaterThan(0.6);
    expect(open(plate.fromMs)).toBeLessThan(0.8);
    expect(open(frames[3]!)).toBeCloseTo(1, 3);
    for (const t of frames) expect(pieceBounds(plate, t, fakeMeasure)).not.toBeNull();
    expect(open(frames[1]!)).toBeGreaterThan(open(frames[0]!));
  });

  test("no rule is drawn under the words (owner, 2026-11-26)", () => {
    for (const line of ["no:b brakes:b no:b limits:b no:b regrets:b", "press:b start:h@900"]) {
      expect(build([line]).pieces.some((p) => /:rule$/.test(p.id))).toBe(false);
    }
  });

  test("a long key word breaks into the fewest balanced rows at a readable size, with no stray letter", () => {
    for (const word of ["unbelievable", "contemporaneousness", "abdominohysterectomy"]) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
        const { pieces } = build([`${word}:h@900`], null, 30, { canvas });
        const parts = faces(pieces, 0);
        expect(parts.map(text).join(""), word).toBe(word.toUpperCase());
        if (parts.length > 1) {
          const lengths = parts.map((part) => text(part).length);
          expect(Math.min(...lengths), `${word} ${canvas.width}`).toBeGreaterThanOrEqual(Math.floor(0.55 * Math.max(...lengths)));
          expect(parts.length, word).toBeLessThanOrEqual(3);
        }
        for (const part of parts) expect(part.kind === "text" && part.sizePx).toBeGreaterThanOrEqual(canvas.width > canvas.height ? 80 : 110);
      }
    }
  });

  test("a shaped script is one whole word with no tracking, in every row", () => {
    const { pieces } = build(["यह:b बहुत:h@700 अच्छा:b है:m"], "hi");
    expect(faces(pieces, 0).map(text)).toEqual(["यह", "बहुत", "अच्छा", "है"]);
    for (const face of faces(pieces, 0)) expect(face.kind === "text" && face.letterSpacingEm).toBe(0);
  });

  test("support words wrap at word boundaries before a label shrinks", () => {
    const { pieces } = build(["we're:b going:b to:m need:b a:m lot:b more:b time:b here:h@600"]);
    const labels = faces(pieces, 0).filter((p) => p.kind === "text" && p.face === "Orbitron Black");
    expect(labels.length).toBe(8);
    const sizes = labels.map((p) => (p.kind === "text" ? p.sizePx : 0));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(0.7 * 46);
    const ys = new Set(labels.map((p) => Math.round(evaluatePiece(p, p.fromMs + 400).y / 4)));
    expect(ys.size).toBeGreaterThanOrEqual(2);
  });

  test("the scan bar, the skyline wave and the sparkles recur on ordinary fast speech, not only on long holds", () => {
    const run = fastRun(60);
    const pieces = horizonProgram.build(sceneInput(run, { fps: 30, colours, anchor })).pieces;
    const shown = (cue: number, tag: string) =>
      own(pieces, cue, tag).some((p) => exportFrameTimes(p.fromMs, p.toMs, 30).filter((t) => pieceBounds(p, t, fakeMeasure)).length >= 2);
    for (const tag of ["bars", "spark"]) {
      expect(run.filter((cue) => shown(cue.index, tag)).length, tag).toBeGreaterThanOrEqual(Math.floor(run.length * 0.85));
    }
    expect(run.filter((cue) => shown(cue.index, "scan")).length, "scan").toBeGreaterThanOrEqual(Math.floor(run.length * 0.5));
  });

  test("a long hold keeps the skyline breathing and sweeps the scan bar again, and ends both at rest", () => {
    const { cues, pieces } = build(["hold:h@5200"]);
    const end = cues[0]!.endMs - 160;
    expect(own(pieces, 0, "scan").length).toBeGreaterThanOrEqual(2);
    const bars = pieces.find((p) => p.id === "horizon:0:bars0")!;
    const values = exportFrameTimes(bars.fromMs, end, 30).map((t) => evaluatePiece(bars, t).sy);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.1);
    const holding = evaluatePiece(bars, end).sy;
    expect(evaluatePiece(bars, end + 100).sy).toBeCloseTo(holding, 6);
    for (const scan of own(pieces, 0, "scan")) expect(scan.toMs).toBeLessThanOrEqual(end + 1);
  });

  test("sparkles stay inside the safe area and never touch the badge's words", () => {
    const { cues, pieces } = build(["future:h@900 is:m loading:b", "no:b brakes:b no:b limits:b"]);
    expect(horizonSparklePath(10).filter((c) => c[0] === "C").length).toBe(4);
    for (const cue of cues) {
      const words = faces(pieces, cue.index);
      for (const spark of own(pieces, cue.index, "spark")) {
        for (const t of exportFrameTimes(spark.fromMs, spark.toMs, 30)) {
          const box = pieceBounds(spark, t, fakeMeasure);
          if (!box) continue;
          expect(box.x1).toBeGreaterThanOrEqual(0.05 * 1080 - 1);
          expect(box.x2).toBeLessThanOrEqual(0.95 * 1080 + 1);
          for (const word of words) {
            const w = pieceBounds(word, t, fakeMeasure);
            if (!w) continue;
            expect(box.x1 < w.x2 && w.x1 < box.x2 && box.y1 < w.y2 && w.y1 < box.y2, `${spark.id} meets ${word.id}`).toBe(false);
          }
        }
      }
    }
  });

  test("a brand colour that vanishes against the navy plate falls back to the style default", () => {
    const { pieces } = build(["no:b brakes:b"], null, 30, { colours: { primary: "#14102A", highlight: "#100A30", accent: "#0A0A2A", shadow: "#000000" } });
    const face = pieces.find((p) => p.id === "horizon:0:w0")!;
    expect(face.kind === "text" && face.fill).toBe("#F7EEFF");
    const rim = pieces.find((p) => p.id === "horizon:0:rim0")!;
    expect(rim.kind === "shape" && rim.stroke!.colour).not.toBe("#100A30");
  });

  test("a customised neon colour recolours the rim, bars and glow of every palette", () => {
    const { pieces } = build(["a:h@500", "b:h@500"], null, 30, { colours: { ...colours, highlight: "#35F0A0" } });
    const bars = (cue: number) => pieces.find((p) => p.id === `horizon:${cue}:bars0`)!;
    expect(bars(0).kind === "shape" && bars(0).fill!.colour).toBe("#35F0A0");
    expect(bars(1).kind === "shape" && bars(1).fill!.colour).toBe("#35F0A0");
  });

  test("on a landscape or square frame the badge is capped at a third of the frame's height", () => {
    for (const canvas of [{ width: 1920, height: 1080 }, { width: 1080, height: 1080 }]) {
      const { pieces } = build(["future:h@900"], null, 30, { canvas });
      const plate = pieces.find((p) => p.id === "horizon:0:plate")!;
      const box = pieceBounds(plate, plate.fromMs + 500, fakeMeasure)!;
      expect(box.y2 - box.y1, `${canvas.width}x${canvas.height}`).toBeLessThanOrEqual(0.34 * canvas.height + 1);
    }
  });

  test("every edge demo stays inside the safe area at twice the size, portrait and landscape, within the piece budget", () => {
    for (const edge of ["urdu", "nine-words", "long-word", "no-hero", "one-word"] as const) {
      for (const canvas of [{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]) {
        const { cues } = sceneEdgeDemo(edge);
        const pieces = horizonProgram.build(sceneInput(cues, { fps: 30, colours, anchor, scale: 2, canvas })).pieces;
        const safe: Box = { x1: 0.05 * canvas.width - 1, y1: 0.05 * canvas.height - 1, x2: 0.95 * canvas.width + 1, y2: 0.95 * canvas.height + 1 };
        for (const cue of cues) {
          const mine = pieces.filter((p) => p.id.startsWith(`horizon:${cue.index}:`));
          expect(mine.length, `${edge} cue ${cue.index}`).toBeLessThanOrEqual(SCENE_PIECE_BUDGET);
          for (const piece of mine) {
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
    const { cues, pieces } = build(["we:m didn't:b want:b", "all:b of:m them:h@480", "the:m remote:b doesn't:h@360 work.:b", "it's:b time:b to:m say:b goodbye:b"]);
    for (const cue of cues) {
      const mine = faces(pieces, cue.index);
      const t = cue.words.at(-1)!.endMs - 20;
      const live = mine.flatMap((p) => {
        const box = pieceBounds(p, t, fakeMeasure);
        return box ? [{ p, box }] : [];
      });
      for (const [i, a] of live.entries()) {
        for (const b of live.slice(i + 1)) {
          if (a.p.id.split("l")[0] === b.p.id.split("l")[0]) continue;
          const x = Math.min(a.box.x2, b.box.x2) - Math.max(a.box.x1, b.box.x1);
          const y = Math.min(a.box.y2, b.box.y2) - Math.max(a.box.y1, b.box.y1);
          expect(x > 2 && y > 2, `${a.p.id} meets ${b.p.id}`).toBe(false);
        }
      }
    }
  });
});
