import { describe, expect, test } from "bun:test";
import { applyBrandColorsToScene, captionColourContrast as ratio, captionSceneMeta } from "@narriflow/validators";
import { describeSpeechConformance, fastRun, staccatoRun } from "./conformance-support";
import { demoCues } from "./demo";
import { exportFrameTimes } from "./frame-grid";
import { kf } from "./ease";
import { evaluatePiece, pieceBounds, type Piece } from "./scene";
import { liquidProgram } from "./templates/liquid";
import { fakeMeasure, sceneInput } from "./test-support";

describeSpeechConformance("liquid", liquidProgram, { anchorLineY: 1290 });

const build = (lines: string[]) => {
  const { cues } = demoCues({ lines, options: { lead: 400, gap: 30, cueGap: 140, tail: 800 } });
  return { cues, pieces: liquidProgram.build(sceneInput(cues, { fps: 30 })).pieces };
};

describe("liquid recurring beats", () => {
  test("every cue, with or without a key word, draws glass, a light sweep and a glint", () => {
    const { cues, pieces } = build(["the:m new:b update:b feels:b like:m glass:h@900", "every:b edge:b catches:b light:b", "just:m clear:b", "simple:h@900"]);
    for (const cue of cues) {
      const own = pieces.filter((piece) => piece.id.startsWith(`liquid:${cue.index}:`));
      for (const name of ["smoke", "spec", "under", "rimtop", "sweep", "glint"]) {
        expect(own.some((piece) => piece.id.startsWith(`liquid:${cue.index}:${name}`)), `cue ${cue.index} has no ${name}`).toBe(true);
      }
    }
  });

  test("the key word gets a thumb and every other cue does not", () => {
    const { pieces } = build(["the:m new:b glass:h@900", "every:b edge:b"]);
    expect(pieces.some((piece) => piece.id.startsWith("liquid:0:thumbfill"))).toBe(true);
    expect(pieces.some((piece) => piece.id.startsWith("liquid:1:thumb"))).toBe(false);
  });

  test("each word lands with a chromatic split that closes before its face is settled", () => {
    const { cues, pieces } = build(["new:b update:b feels:b glass:h@900"]);
    for (const [at] of cues[0]!.words.entries()) {
      const copy = pieces.find((piece) => piece.id === `liquid:0:w${at}ca`);
      expect(copy, `word ${at} has no split copy`).toBeDefined();
    }
  });
});

describe("liquid layout", () => {
  test("the glass opens word by word: the clip is narrow at the first word and full once the row is complete", () => {
    const { cues, pieces } = build(["the:m new:b update:b glass:h@900"]);
    const clip = pieces.find((piece) => piece.id === "liquid:0:smoke0")!.clip!;
    const first = cues[0]!.words[0]!;
    const last = cues[0]!.words.at(-1)!;
    const open = (t: number) => kf(t, clip.x2) - kf(t, clip.x1);
    expect(open(first.startMs + 30)).toBeLessThan(open(last.endMs) * 0.6);
    expect(open(last.endMs)).toBeGreaterThan(300);
    expect(clip.radius).toBeGreaterThan(40);
  });

  test("the key word's thumb sits inside its row's capsule", () => {
    const { cues, pieces } = build(["display:b glare:b बहुत:h@900"]);
    const bounds = (id: string, t: number) => pieceBounds(pieces.find((piece) => piece.id === id)!, t, fakeMeasure)!;
    const t = cues[0]!.endMs - 300;
    const capsule = bounds("liquid:0:smoke1", t);
    const thumb = bounds("liquid:0:thumbfill2", t);
    expect(thumb.y1).toBeGreaterThanOrEqual(capsule.y1);
    expect(thumb.y2).toBeLessThanOrEqual(capsule.y2);
    expect(thumb.x1).toBeGreaterThanOrEqual(capsule.x1 - 1);
    expect(thumb.x2).toBeLessThanOrEqual(capsule.x2 + 1);
  });
});

describe("liquid review fixes", () => {
  test("the glass backing is in place and reaches every word's box by that word's first painted frame, on tight handoffs", () => {
    for (const [name, make] of [["ordinary", fastRun], ["staccato", staccatoRun]] as const) {
      for (const gap of [0, 60]) {
        const cues = make(gap);
        const pieces = liquidProgram.build(sceneInput(cues, { fps: 30 })).pieces;
        for (const cue of cues) {
          const backings = pieces.filter((piece) => piece.id.startsWith(`liquid:${cue.index}:smoke`));
          for (const [at] of cue.words.entries()) {
            const face = pieces.find((piece) => piece.id === `liquid:${cue.index}:w${at}`)!;
            const t = exportFrameTimes(face.fromMs, face.toMs, 30).find((frame) => pieceBounds(face, frame, fakeMeasure))!;
            const ink = pieceBounds(face, t, fakeMeasure)!;
            const where = `${name} gap ${gap} cue ${cue.index} word ${at} at ${t}`;
            const row = backings.find((piece) => {
              const box = pieceBounds(piece, t, fakeMeasure);
              return box && box.y1 <= (ink.y1 + ink.y2) / 2 && box.y2 >= (ink.y1 + ink.y2) / 2;
            })!;
            expect(row, where).toBeDefined();
            expect(evaluatePiece(row, t).o, where).toBeGreaterThanOrEqual(0.8);
            const backing = pieceBounds(row, t, fakeMeasure)!;
            expect(backing.x1, where).toBeLessThanOrEqual(ink.x1 + 0.5);
            expect(backing.x2, where).toBeGreaterThanOrEqual(ink.x2 - 0.5);
          }
        }
      }
    }
  });

  test("the rim rides the moving contour: its trailing cap sits on the backing's right edge on every frame of the growth", () => {
    const { cues, pieces } = build(["the:m new:b update:b feels:b like:m glass:h@900"]);
    const lead = pieces.find((piece) => piece.id === "liquid:0:rimtrail0")!;
    const body = pieces.find((piece) => piece.id === "liquid:0:smoke0")!;
    for (const t of exportFrameTimes(cues[0]!.startMs, cues[0]!.endMs - 400, 30)) {
      const cap = pieceBounds(lead, t, fakeMeasure);
      const box = pieceBounds(body, t, fakeMeasure);
      if (!cap || !box) continue;
      expect(Math.abs(cap.x2 - box.x2), `rim cap off the edge at ${t}`).toBeLessThan(3);
    }
  });

  test("the sweep stays inside the pill it crosses", () => {
    const { cues, pieces } = build(["the:m new:b update:b feels:b like:m glass:h@900", "every:b edge:b catches:b light:b"]);
    for (const cue of cues) {
      const body = pieces.find((piece) => piece.id === `liquid:${cue.index}:smoke0`)!;
      const sweep = pieces.find((piece) => piece.id.startsWith(`liquid:${cue.index}:sweep0`));
      if (!sweep) continue;
      for (const t of exportFrameTimes(sweep.fromMs, sweep.toMs, 30)) {
        const box = pieceBounds(sweep, t, fakeMeasure);
        const pill = pieceBounds(body, t, fakeMeasure);
        if (!box || !pill) continue;
        expect(box.x1, `sweep left of the pill at ${t}`).toBeGreaterThanOrEqual(pill.x1 - 1);
        expect(box.x2, `sweep right of the pill at ${t}`).toBeLessThanOrEqual(pill.x2 + 1);
      }
    }
  });

  const textFill = (primary: string, highlight = "#5E9BFF") => {
    const { cues } = demoCues({ lines: ["the:m new:b glass:h@900"], options: { lead: 400, gap: 30, cueGap: 140, tail: 800 } });
    const pieces = liquidProgram.build(sceneInput(cues, { fps: 30, colours: { primary, highlight, accent: "#FF8BD0", shadow: "#000000" } })).pieces;
    const fill = (piece: Piece) => (piece.kind === "text" ? piece.fill : piece.fill?.colour);
    return { text: fill(pieces.find((piece) => piece.id === "liquid:0:w1")!)!, thumb: fill(pieces.find((piece) => piece.id.startsWith("liquid:0:thumbfill"))!)! };
  };
  test("a brand text colour the shared guard accepts is painted as given", () => {
    expect(textFill("#F2F2F2").text).toBe("#F2F2F2");
    expect(textFill("#FFFFFF").text).toBe("#FFFFFF");
    expect(captionSceneMeta("liquid").brand.primary?.readsOn).toEqual(["#7F8594", "#5D7BB1"]);
  });

  test("the brand guard refuses a text colour that cannot read on the glass it sits on, and takes one that can", () => {
    const preset = { primaryColor: "#FFFFFF", highlightColor: "#5E9BFF", accentColor: "#FF8BD0" };
    expect(applyBrandColorsToScene("liquid", preset, { primaryColor: "#707070", secondaryColor: "#E6F7FF" })).toEqual({ highlightColor: "#E6F7FF" });
    expect(applyBrandColorsToScene("liquid", preset, { primaryColor: "#B0B0B0", secondaryColor: "#E6F7FF" })).toEqual({ highlightColor: "#E6F7FF" });
    expect(applyBrandColorsToScene("liquid", preset, { primaryColor: "#F2F2F2", secondaryColor: "#E6F7FF" })).toEqual({ primaryColor: "#F2F2F2", highlightColor: "#E6F7FF" });
    expect(applyBrandColorsToScene("liquid", preset, { primaryColor: "#F0F0F0", secondaryColor: "#FFE600" })).toEqual({ primaryColor: "#F0F0F0", highlightColor: "#FFE600" });
  });

  test("the key word's thumb keeps its text at 3:1 or better over the body over the lightest ground, whatever the highlight", () => {
    const mix = (from: string, to: string, p: number) => `#${[0, 1, 2].map((at) => Math.round(Number.parseInt(from.slice(1 + 2 * at, 3 + 2 * at), 16) + (Number.parseInt(to.slice(1 + 2 * at, 3 + 2 * at), 16) - Number.parseInt(from.slice(1 + 2 * at, 3 + 2 * at), 16)) * p).toString(16).padStart(2, "0")).join("")}`;
    for (const highlight of ["#FFFFFF", "#FFE600", "#E6F7FF", "#5E9BFF", "#000000"]) {
      const { text, thumb } = textFill("#FFFFFF", highlight);
      expect(ratio(text, mix("#7F8594", thumb, 0.7)), highlight).toBeGreaterThanOrEqual(3);
    }
  });

  test("every glyph has a thin dark halo, which carries the contrast on the light glass", () => {
    const { cues, pieces } = build(["the:m new:b glass:h@900"]);
    for (const [at] of cues[0]!.words.entries()) {
      const face = pieces.find((piece) => piece.id === `liquid:0:w${at}`)!;
      expect(face.kind === "text" && face.stroke?.alpha, `word ${at}`).toBeGreaterThan(0.4);
    }
  });

  test("the shadow keeps the pill's rounded contour: same clip as the body, dropped, never a squashed capsule", () => {
    const { pieces } = build(["the:m new:b update:b glass:h@900"]);
    const shadow = pieces.find((piece) => piece.id === "liquid:0:shadow0")!;
    const body = pieces.find((piece) => piece.id === "liquid:0:smoke0")!;
    expect(shadow.clip).toEqual(body.clip);
    expect(shadow.track.sx).toEqual(body.track.sx);
    expect(shadow.track.y![0]![1]).toBeGreaterThan(body.track.y![0]![1]);
  });

  test("the sweep fades out at its edges: stacked bands of falling alpha", () => {
    const { pieces } = build(["the:m new:b update:b glass:h@900"]);
    const bands = pieces.filter((piece): piece is Extract<Piece, { kind: "shape" }> => /^liquid:0:sweep0-0[abc]$/.test(piece.id));
    expect(bands.map((band) => band.fill!.alpha)).toEqual([...bands.map((band) => band.fill!.alpha)].sort((a, b) => a! - b!));
    expect(bands.length).toBe(3);
  });

  test("the thumb's rim and highlights step back while it travels across other words and come up as it settles", () => {
    const { cues, pieces } = build(["the:m new:b update:b glass:h@900"]);
    const rim = pieces.find((piece) => piece.id === "liquid:0:thumbrim3")!;
    const fill = pieces.find((piece) => piece.id === "liquid:0:thumbfill3")!;
    const word = cues[0]!.words[3]!;
    const travelling = word.startMs - 90 + 150;
    expect(evaluatePiece(rim, travelling).o).toBeLessThan(0.3);
    expect(evaluatePiece(fill, travelling).o).toBeGreaterThan(0.9);
    expect(evaluatePiece(rim, word.startMs + 500).o).toBeGreaterThan(0.9);
  });

  test("a Latin word wider than a row breaks into readable pieces on their own rows instead of shrinking", () => {
    const word = "pneumonoultramicroscopicsilicovolcanoconiosis";
    const { pieces } = build([`${word}:h@900`]);
    const parts = pieces.filter((piece): piece is Extract<Piece, { kind: "text" }> => /^liquid:0:w0l\d+$/.test(piece.id));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => part.text).join("")).toBe(word);
    for (const part of parts) expect(part.sizePx).toBeGreaterThanOrEqual(80);
    const rows = new Set(parts.map((part) => Math.round(evaluatePiece(part, part.toMs - 100).y)));
    expect(rows.size).toBe(parts.length);
  });
});
