import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import { TEXT_LAYER_SAMPLE_UPLOAD, buildTextLayerScene } from "@narriflow/caption-scene";
import type { CompositionTextVisualLayer } from "@narriflow/composition-plan";
import { DEFAULT_TITLE_STYLE, type StudioTextLayer, captionFontFace, studioTextLayerSchema } from "@narriflow/validators";
import { inkBounds, renderAssRaw } from "../scripts/caption-scene-probe";
import { brandFontRenderer } from "./brand-font-parser";
import { prepareTextFontsDirectory, type RenderBrandFont } from "./brand-font-resolution";
import { CaptionGlyphPlanner, catalogCaptionFace } from "./caption-glyphs";
import { SceneMeasurer } from "./caption-scene-ass";
import { renderTextLayerTrack } from "./text-layer-ass";

/**
 * Title-text ticket 08 on the worker: an uploaded brand font in a Text Layer is measured and drawn
 * from its own file, name collisions follow the shared rule, and the space after a typed emoji is
 * planned in the line's face (it was planned in the emoji face, about an em wide).
 */

const ROOT = new URL("../../../", import.meta.url).pathname;
const hasLibass = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout?.includes(" ass ") ?? false;
const CANVAS = { width: 1080, height: 1920 };
const BYTES = readFileSync(join(ROOT, TEXT_LAYER_SAMPLE_UPLOAD.file));
const work = mkdtempSync(join(tmpdir(), "text-layer-fonts-"));
const fontPath = join(work, "brand-font.ttf");
copyFileSync(join(ROOT, TEXT_LAYER_SAMPLE_UPLOAD.file), fontPath);

const UPLOAD = { kind: "brand_font" as const, id: TEXT_LAYER_SAMPLE_UPLOAD.id, fingerprint: TEXT_LAYER_SAMPLE_UPLOAD.fingerprint };
const key = (upload: { id: string; fingerprint: string }) => `${upload.id}:${upload.fingerprint}`;
const font: RenderBrandFont = { ...brandFontRenderer(BYTES), path: fontPath };
const FONTS = new Map([[key(UPLOAD), font]]);

const make = (id: string, text: string, style: Partial<StudioTextLayer["style"]> = {}, place: Partial<StudioTextLayer> = {}): StudioTextLayer =>
  studioTextLayerSchema.parse({ id, role: "title", text, positionY: 30, widthPct: 100, ...place, style: { ...DEFAULT_TITLE_STYLE, color: "#FFFFFF", background: null, stroke: null, bold: false, ...style } });

const planLayer = (layer: StudioTextLayer): CompositionTextVisualLayer => ({
  id: `layer:text:${layer.id}:t`,
  kind: "text",
  activeRange: { startSec: 0, endSec: 1 },
  anchor: { xPct: layer.positionX, yPct: layer.positionY },
  destination: { x: 0, y: 0, ...CANVAS },
  rotationDeg: 0,
  opacity: 1,
  zIndex: 30,
  value: layer,
});

const layout = (layers: readonly StudioTextLayer[], fonts = FONTS) => {
  const measurer = new SceneMeasurer({ notices: new Map(), omitted: new Map() }, new Set(), null, true, fonts);
  return buildTextLayerScene(layers.map((layer) => ({ layer, window: { fromMs: 0, toMs: 1000 } })), CANVAS, measurer.measure, (upload) => fonts.get(key(upload))?.face ?? null);
};

describe("the sample upload", () => {
  test("is the file the samples name: fingerprint and parsed face", () => {
    expect(createHash("sha256").update(BYTES).digest("hex")).toBe(TEXT_LAYER_SAMPLE_UPLOAD.fingerprint);
    expect(font.face).toEqual(TEXT_LAYER_SAMPLE_UPLOAD.face);
  });
});

describe("a Text Layer in an uploaded font", () => {
  const text = "Quick brown foxes jump";

  test("is measured and written in the upload, with the layer's family as its fallback", () => {
    const track = renderTextLayerTrack({ layers: [planLayer(make("a", text, { fontAsset: UPLOAD }))], canvas: CANVAS, fonts: FONTS });
    expect(track.ass).toContain("\\fnGeist SemiBold");
    expect(track.uploads).toEqual([{ id: UPLOAD.id, fingerprint: UPLOAD.fingerprint }]);
    const uploaded = layout([make("a", text, { fontAsset: UPLOAD })]).layouts[0]!.lines[0]!;
    const family = layout([make("a", text)]).layouts[0]!.lines[0]!;
    // Geist SemiBold is wider than Inter Regular: a different file was measured.
    expect(uploaded.x2 - uploaded.x1).toBeGreaterThan(family.x2 - family.x1 + 20);
  });

  test("an upload the render could not resolve draws its font family", () => {
    const track = renderTextLayerTrack({ layers: [planLayer(make("a", text, { fontAsset: UPLOAD }))], canvas: CANVAS });
    expect(track.ass).not.toContain("Geist");
    expect(track.ass).toContain(`\\fn${captionFontFace("Inter Regular").assName}`);
    expect(track.uploads).toEqual([]);
    expect(renderTextLayerTrack({ layers: [planLayer(make("a", text))], canvas: CANVAS }).ass).toBe(track.ass);
  });

  test("bold is an outline and italic a shear (an upload is a family of one face)", () => {
    const piece = layout([make("a", text, { fontAsset: UPLOAD, bold: true, italic: true })]).scene.pieces.find((candidate) => candidate.kind === "text")!;
    expect(piece.kind === "text" && piece.upload).toEqual({ id: UPLOAD.id, fingerprint: UPLOAD.fingerprint });
    expect(piece.kind === "text" && piece.stroke?.widthPx).toBeGreaterThan(0);
    expect(piece.track.skx).toEqual([[0, -12]]);
  });

  test("the fonts directory holds the vendored faces and the drawn uploads, and only them", async () => {
    expect(await prepareTextFontsDirectory(work, FONTS, [])).toBe(CAPTION_FONTS_DIRECTORY);
    expect(await prepareTextFontsDirectory(work, new Map(), [UPLOAD])).toBe(CAPTION_FONTS_DIRECTORY);
    const directory = await prepareTextFontsDirectory(work, FONTS, [UPLOAD]);
    const files = readdirSync(directory);
    expect(files.filter((file) => file.startsWith("uploaded-"))).toEqual([`uploaded-${UPLOAD.id}-${UPLOAD.fingerprint}.ttf`]);
    expect(files).toContain("Inter-Regular.ttf");
    expect(files).toContain("NotoEmoji-Regular.ttf");
  });
});

describe("internal name collisions", () => {
  // A second upload of the same file under another id: the same internal name, other bytes as far as the worker knows.
  const SECOND = { kind: "brand_font" as const, id: "6f0c3c8e-7b3a-4d0e-9a51-08b7e3f2a6c2", fingerprint: "b".repeat(64) };
  const secondPath = join(work, "second.ttf");
  copyFileSync(fontPath, secondPath);
  const both = new Map([...FONTS, [key(SECOND), { ...font, path: secondPath }]]);

  test("two uploads with one name: the first in layer order wins, in measurement and in the directory", () => {
    const layers = [make("a", "First", { fontAsset: UPLOAD }, { positionY: 20 }), make("b", "Second", { fontAsset: SECOND }, { positionY: 60 })];
    const track = renderTextLayerTrack({ layers: layers.map(planLayer), canvas: CANVAS, fonts: both });
    expect(track.uploads).toEqual([{ id: UPLOAD.id, fingerprint: UPLOAD.fingerprint }]);
    expect(track.collisions).toEqual([{ layerId: "b", requested: { id: SECOND.id, fingerprint: SECOND.fingerprint }, name: "Geist SemiBold", drawnAs: { kind: "upload", upload: { id: UPLOAD.id, fingerprint: UPLOAD.fingerprint } } }]);
    const pieces = layout(layers, both).scene.pieces.filter((piece) => piece.kind === "text");
    expect(pieces.map((piece) => piece.kind === "text" && piece.upload?.id)).toEqual([UPLOAD.id, UPLOAD.id]);
  });

  test("an upload named like a vendored face draws as the vendored face", () => {
    const inter = captionFontFace("Inter");
    const named = new Map([[key(UPLOAD), { ...font, face: { ...font.face, assName: inter.assName.toUpperCase() } }]]);
    const track = renderTextLayerTrack({ layers: [planLayer(make("a", "Hello", { fontAsset: UPLOAD }))], canvas: CANVAS, fonts: named });
    expect(track.uploads).toEqual([]);
    expect(track.collisions[0]?.drawnAs).toEqual({ kind: "catalog", face: "Inter" });
    expect(track.ass).toContain(`\\fn${inter.assName}`);
  });
});

describe("the space after a typed emoji", () => {
  const report = () => ({ notices: new Map(), omitted: new Map() });
  const advance = (text: string) => new SceneMeasurer(report(), new Set(), null, true).measure(text, "Inter", 100, 0).advance;

  test("is planned in the line's face in a Text Layer", () => {
    const planned = new SceneMeasurer(report(), new Set(), null, true).metrics("Big news 🎉 today 🔥", "Inter", 0).clusters;
    const faces = planned.map((cluster) => `${cluster.text}:${cluster.parts.map((part) => part.face.role).join("+")}`);
    expect(faces).toContain("🎉:monochrome-emoji");
    expect(faces.filter((face) => face.startsWith(" :"))).toEqual([" :requested", " :requested", " :requested", " :requested"]);
    // Digits after an emoji too: "🎉2026" draws 2026 in Inter, as the browser does.
    const digits = new SceneMeasurer(report(), new Set(), null, true).metrics("🎉2026", "Inter", 0).clusters;
    expect(digits.slice(1).every((cluster) => cluster.parts[0]!.face.role === "requested")).toBe(true);
    // The line is as wide as its two halves: the space costs an Inter space.
    expect(Math.abs(advance("Big news 🎉 today") - (advance("Big news 🎉") + advance(" today")))).toBeLessThan(0.5);
  });

  test("captions keep their planning (the picture face keeps neutrals; unchanged by this ticket)", () => {
    const planner = new CaptionGlyphPlanner(catalogCaptionFace(captionFontFace("Inter"), "requested"), null, report(), 0);
    expect(planner.plan("🎉 1").map((cluster) => cluster.parts[0]!.face.role)).toEqual(["monochrome-emoji", "monochrome-emoji", "monochrome-emoji"]);
  });
});

describe.skipIf(!hasLibass)("against real libass", () => {
  const inkOf = (layer: StudioTextLayer, fonts: Map<string, RenderBrandFont>, directory: string) => {
    const track = renderTextLayerTrack({ layers: [planLayer(layer)], canvas: CANVAS, fonts });
    return inkBounds(renderAssRaw({ ass: track.ass, width: CANVAS.width, height: CANVAS.height, tMs: 0, background: "black", fontsDir: directory }), 60);
  };

  test("libass draws the upload: its ink fills the measured advance, and differs from the family's", async () => {
    const directory = await prepareTextFontsDirectory(work, FONTS, [UPLOAD]);
    const layer = make("a", "Quick brown foxes jump", { fontAsset: UPLOAD, fontSize: 72 });
    const line = layout([layer]).layouts[0]!.lines[0]!;
    const ink = inkOf(layer, FONTS, directory)!;
    expect(Math.abs(ink.x1 - line.x1)).toBeLessThan(6);
    expect(Math.abs(ink.x2 + 1 - line.x2)).toBeLessThan(6);
    const family = inkOf(make("a", "Quick brown foxes jump", { fontSize: 72 }), FONTS, directory)!;
    expect(ink.x2 - ink.x1).toBeGreaterThan(family.x2 - family.x1 + 20);
  });

  test("a line with an emoji inside fits its ink: no em-wide gap after the emoji", () => {
    // Ends on a letter: an emoji's own side bearing at the line's end is not what this checks.
    const layer = make("e", "Big news 🎉 today", { fontSize: 48, bold: true });
    const line = layout([layer]).layouts[0]!.lines[0]!;
    const ink = inkOf(layer, new Map(), CAPTION_FONTS_DIRECTORY)!;
    expect(Math.abs(ink.x1 - line.x1)).toBeLessThan(6);
    expect(Math.abs(ink.x2 + 1 - line.x2)).toBeLessThan(6);
  });
});
