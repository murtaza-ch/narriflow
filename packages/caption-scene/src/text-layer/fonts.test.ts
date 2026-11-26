import { describe, expect, test } from "bun:test";
import { type CaptionFontFace, DEFAULT_TITLE_STYLE, type StudioTextLayer, captionFontFace, studioTextLayerSchema } from "@narriflow/validators";
import { memoMeasure } from "../measure-memo";
import type { Measure, TextPiece, UploadedFace } from "../scene";
import { textLayerFaces } from "./fonts";
import { buildTextLayerScene, layoutTextLayer } from "./layout";

/** Title-text ticket 08: which face a layer draws in, shared by the Studio and the worker. */

const A = { kind: "brand_font" as const, id: "4d119c8d-acde-4d95-82a4-0e61210e61db", fingerprint: "a".repeat(64) };
const B = { kind: "brand_font" as const, id: "9d119c8d-acde-4d95-82a4-0e61210e61db", fingerprint: "b".repeat(64) };
const face = (assName: string, extra: Partial<CaptionFontFace> = {}): CaptionFontFace => ({ name: assName, file: "", assName, weight: 600, style: "normal", ascent: 1, descent: 0.3, capHeight: 0.66, ...extra });

const layer = (id: string, style: Partial<StudioTextLayer["style"]> = {}): StudioTextLayer =>
  studioTextLayerSchema.parse({ id, text: "Hello", style: { ...DEFAULT_TITLE_STYLE, bold: false, ...style } });
const resolver = (faces: Record<string, CaptionFontFace>) => (upload: UploadedFace) => faces[upload.id] ?? null;

describe("textLayerFaces", () => {
  test("no upload, or one the renderer lacks: the layer's family, as before", () => {
    const { faces, collisions } = textLayerFaces([layer("a", { font: "Montserrat", bold: true }), layer("b", { fontAsset: A })], resolver({}));
    expect(faces).toEqual([
      { face: "Montserrat", capHeight: captionFontFace("Montserrat").capHeight, fauxBold: false, shearDeg: 0 },
      { face: "Inter Regular", capHeight: captionFontFace("Inter Regular").capHeight, fauxBold: false, shearDeg: 0 },
    ]);
    expect(collisions).toEqual([]);
    expect(textLayerFaces([layer("b", { fontAsset: A })], null).faces[0]!.upload).toBeUndefined();
  });

  test("a resolved upload is a one-face family with the layer's face as its fallback", () => {
    const uploads = resolver({ [A.id]: face("Brand Sans"), [B.id]: face("Brand Slant", { style: "italic", capHeight: 0.7 }) });
    const [upright, slanted] = textLayerFaces([layer("a", { fontAsset: A, bold: true, italic: true }), layer("b", { font: "Montserrat", fontAsset: B, bold: true, italic: true })], uploads).faces;
    // Bold is an outline even on a heavy upload, italic a shear unless the file leans.
    expect(upright).toEqual({ face: "Inter", upload: { id: A.id, fingerprint: A.fingerprint }, capHeight: 0.66, fauxBold: true, shearDeg: 12 });
    expect(slanted).toEqual({ face: "Montserrat", upload: { id: B.id, fingerprint: B.fingerprint }, capHeight: 0.7, fauxBold: true, shearDeg: 0 });
  });

  test("two uploads sharing an internal name: the first in layer order wins", () => {
    const { faces, collisions } = textLayerFaces([layer("a", { fontAsset: A }), layer("b", { fontAsset: B }), layer("c", { fontAsset: A })], resolver({ [A.id]: face("Brand Sans"), [B.id]: face("BRAND SANS", { capHeight: 0.9 }) }));
    expect(faces.map((entry) => entry.upload?.id)).toEqual([A.id, A.id, A.id]);
    // The loser is laid out with the winner's metrics: that is the file both renderers draw.
    expect(faces[1]!.capHeight).toBe(0.66);
    expect(collisions).toEqual([{ layerId: "b", requested: { id: B.id, fingerprint: B.fingerprint }, name: "BRAND SANS", drawnAs: { kind: "upload", upload: { id: A.id, fingerprint: A.fingerprint } } }]);
  });

  test("an upload named like a vendored face draws as that face, wherever it sits", () => {
    const inter = captionFontFace("Inter");
    const { faces, collisions } = textLayerFaces([layer("a", { fontAsset: A, font: "Oswald" })], resolver({ [A.id]: face(inter.assName) }));
    expect(faces[0]).toEqual({ face: "Inter", capHeight: inter.capHeight, fauxBold: false, shearDeg: 0 });
    expect(collisions[0]!.drawnAs).toEqual({ kind: "catalog", face: "Inter" });
  });
});

describe("pieces and measurement", () => {
  const calls: unknown[][] = [];
  const measure: Measure = (...args) => {
    calls.push(args);
    return { advance: args[0].length * args[2] * (args[4] ? 0.6 : 0.5), inkTop: -0.7 * args[2], inkBottom: 0.2 * args[2], ascent: args[2], descent: 0.3 * args[2] };
  };
  const uploads = resolver({ [A.id]: face("Brand Sans") });

  test("an upload rides on its pieces and every measurement; a catalog layer's calls are unchanged", () => {
    calls.length = 0;
    const { scene } = buildTextLayerScene([{ layer: layer("a", { fontAsset: A }), window: { fromMs: 0, toMs: 1000 } }, { layer: layer("b"), window: { fromMs: 0, toMs: 1000 } }], { width: 1080, height: 1920 }, measure, uploads);
    const [uploaded, plain] = scene.pieces.filter((piece): piece is TextPiece => piece.kind === "text");
    expect(uploaded!.upload).toEqual({ id: A.id, fingerprint: A.fingerprint });
    expect(plain!.upload).toBeUndefined();
    expect(calls.filter((call) => call.length === 5).every((call) => (call[4] as UploadedFace).id === A.id)).toBe(true);
    expect(calls.filter((call) => call.length === 4).length).toBeGreaterThan(0);
  });

  test("the layout uses the drawn face's cap height", () => {
    const at = (capHeight: number) =>
      layoutTextLayer(layer("a", { fontAsset: A }), { width: 1080, height: 1920 }, measure, { fromMs: 0, toMs: 1000 }, 0, { face: "Inter Regular", upload: A, capHeight, fauxBold: false, shearDeg: 0 }).lines[0]!.baselineY;
    expect(at(0.8) - at(0.6)).toBeCloseTo(0.1 * 48, 6);
  });

  test("memoMeasure keys an upload apart and keeps a catalog face's call as it was", () => {
    calls.length = 0;
    const memo = memoMeasure(measure);
    memo("Hi", "Inter", 10, 0);
    memo("Hi", "Inter", 10, 0, A);
    memo("Hi", "Inter", 10, 0, A);
    memo("Hi", "Inter", 10, 0);
    expect(calls).toEqual([["Hi", "Inter", 10, 0], ["Hi", "Inter", 10, 0, A]]);
  });
});
