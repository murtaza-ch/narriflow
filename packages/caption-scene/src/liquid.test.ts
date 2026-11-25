import { describe, expect, test } from "bun:test";
import { applyBrandColorsToScene, captionSceneMeta } from "@narriflow/validators";
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
      for (const name of ["smoke", "spec", "under", "rim", "sweep", "glint"]) {
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
  test("the glass backing is in place and covers the word on its first painted frame, on tight handoffs", () => {
    for (const [name, make] of [["ordinary", fastRun], ["staccato", staccatoRun]] as const) {
      for (const gap of [0, 60]) {
        const cues = make(gap);
        const pieces = liquidProgram.build(sceneInput(cues, { fps: 30 })).pieces;
        for (const cue of cues) {
          const face = pieces.find((piece) => piece.id === `liquid:${cue.index}:w0`)!;
          const t = exportFrameTimes(face.fromMs, face.toMs, 30).find((frame) => pieceBounds(face, frame, fakeMeasure))!;
          const smoke = pieces.find((piece) => piece.id === `liquid:${cue.index}:smoke0`)!;
          const where = `${name} gap ${gap} cue ${cue.index} at ${t}`;
          expect(evaluatePiece(smoke, t).o, where).toBeGreaterThanOrEqual(0.8);
          const backing = pieceBounds(smoke, t, fakeMeasure)!;
          const ink = pieceBounds(face, t, fakeMeasure)!;
          expect(backing, where).not.toBeNull();
          expect(backing.x1, where).toBeLessThanOrEqual(ink.x1 + 0.5);
          expect(backing.x2, where).toBeGreaterThanOrEqual(ink.x2 - 0.5);
        }
      }
    }
  });

  const textFill = (primary: string, highlight = "#5E9BFF") => {
    const { cues } = demoCues({ lines: ["the:m new:b glass:h@900"], options: { lead: 400, gap: 30, cueGap: 140, tail: 800 } });
    const pieces = liquidProgram.build(sceneInput(cues, { fps: 30, colours: { primary, highlight, accent: "#FF8BD0", shadow: "#000000" } })).pieces;
    const fill = (piece: Piece) => (piece.kind === "text" ? piece.fill : piece.fill?.colour);
    return { text: fill(pieces.find((piece) => piece.id === "liquid:0:w1")!)!, thumb: fill(pieces.find((piece) => piece.id.startsWith("liquid:0:thumbfill"))!)! };
  };
  const channel = (hex: string, at: number) => {
    const v = Number.parseInt(hex.slice(1 + 2 * at, 3 + 2 * at), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
  const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

  test("a brand text colour that cannot reach 4.5:1 on the glass falls back to white", () => {
    expect(textFill("#707070").text).toBe("#FFFFFF");
    expect(textFill("#F2F2F2").text).toBe("#F2F2F2");
    expect(captionSceneMeta("liquid").brand.primary?.readsOn).toEqual(["#545967", "#355284"]);
  });

  test("the brand guard refuses a text colour that cannot read on the glass it sits on, and takes one that can", () => {
    const preset = { primaryColor: "#FFFFFF", highlightColor: "#5E9BFF", accentColor: "#FF8BD0" };
    expect(applyBrandColorsToScene("liquid", preset, { primaryColor: "#707070", secondaryColor: "#E6F7FF" })).toEqual({ highlightColor: "#E6F7FF" });
    expect(applyBrandColorsToScene("liquid", preset, { primaryColor: "#F0F0F0", secondaryColor: "#FFE600" })).toEqual({ primaryColor: "#F0F0F0", highlightColor: "#FFE600" });
  });

  test("the key word's thumb stays dark enough for its text over the body over the lightest ground, whatever the highlight", () => {
    for (const highlight of ["#FFFFFF", "#FFE600", "#E6F7FF", "#5E9BFF", "#000000"]) {
      const { text, thumb } = textFill("#FFFFFF", highlight);
      const over = `#${[0, 1, 2].map((at) => Math.round(Number.parseInt("545967".slice(2 * at, 2 * at + 2), 16) + (Number.parseInt(thumb.slice(1 + 2 * at, 3 + 2 * at), 16) - Number.parseInt("545967".slice(2 * at, 2 * at + 2), 16)) * 0.9).toString(16).padStart(2, "0")).join("")}`;
      expect(ratio(text, over), highlight).toBeGreaterThanOrEqual(4.5);
    }
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
