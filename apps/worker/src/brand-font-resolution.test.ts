import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { captionFontFilePath, shapeCaptionRun } from "@narriflow/caption-fonts";
import {
  planClipComposition,
  compositionAssetRef,
} from "@narriflow/composition-plan";
import {
  editorDocumentSchema,
  captionPresetSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import {
  compileCompositionPlanCaptions,
  compileCompositionPlanVisualLayers,
} from "./composition-ffmpeg-adapter";
import {
  documentFontReferences,
  brandFontKey,
  prepareCaptionFontsDirectory,
  resolveRenderBrandFonts,
} from "./brand-font-resolution";
import { productionWorkerProcessModule } from "./worker-process";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "nf-brand-font-test-"));
  directories.push(path);
  return path;
}
const id = "10000000-0000-4000-8000-000000000003";

function document(fingerprint: string) {
  const fontAsset = { kind: "brand_font", id, fingerprint };
  return editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 2,
    captionPreset: captionPresetSchema.parse({
      fontAsset,
      fontSize: 64,
      animation: "glitch",
      backgroundColor: "#111111",
    }),
    transcriptSlice: [
      {
        index: 0,
        speaker: 0,
        speakerLabel: "Speaker",
        startSec: 0,
        endSec: 2,
        text: "Hello world",
        confidence: 1,
        words: [
          { word: "Hello", startSec: 0, endSec: 1, confidence: 1 },
          { word: "world", startSec: 1, endSec: 2, confidence: 1 },
        ],
      },
    ],
    studioEdits: studioEditsSchema.parse({
      textLayers: [
        { id: "title", text: "Uploaded text", fontName: "Arial", fontAsset },
      ],
      framing: { mode: "center" },
    }),
    brollUrl: null,
    deletedRanges: [],
  });
}
function plan(fingerprint: string) {
  const result = planClipComposition({
    document: document(fingerprint),
    source: { identity: "test", kind: "video", width: 320, height: 240 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: {
      automaticSpeakerLayout: true,
      automaticSpeakerEngineVersion: "shot-layout-v1",
    },
    targets: [{ id: "test", aspectRatio: "4:3", width: 320, height: 240 }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}
async function resolve(
  bytes: Uint8Array,
  format = "ttf",
  fingerprint = createHash("sha256").update(bytes).digest("hex"),
) {
  const temp = await directory();
  const doc = document(fingerprint);
  const fonts = await resolveRenderBrandFonts({
    references: documentFontReferences(doc),
    fonts: [{ id, fingerprint, format, storageKey: "private/font" }],
    directory: temp,
    download: async (_key, path) => {
      await writeFile(path, bytes);
    },
  });
  return { fonts, temp, fingerprint };
}

describe("uploaded font preview/export contract", () => {
  test("deduplicates a font shared by captions and text layers", () => {
    expect(documentFontReferences(document("a".repeat(64)))).toHaveLength(1);
  });
  test("missing objects, foreign references and changed bytes use built-in fallbacks", async () => {
    const temp = await directory();
    const references = documentFontReferences(document("a".repeat(64)));
    const fonts = await resolveRenderBrandFonts({
      references,
      fonts: [],
      directory: temp,
      download: async () => {
        throw new Error("must not fetch");
      },
    });
    expect(fonts.size).toBe(0);
    const unavailable = await resolveRenderBrandFonts({
      references,
      fonts: [{ ...references[0]!, storageKey: "missing", format: "ttf" }],
      directory: temp,
      download: async () => {
        throw new Error("Object missing");
      },
    });
    expect(unavailable.size).toBe(0);
    const corrupted = await resolve(
      new Uint8Array([1, 2, 3]),
      "ttf",
      "a".repeat(64),
    );
    expect(corrupted.fonts.size).toBe(0);
    const { ass } = compileCompositionPlanCaptions(
      plan("a".repeat(64)),
      "test",
      fonts,
    );
    expect(ass).toContain("Montserrat Black");
    const output = compileCompositionPlanVisualLayers({
      plan: plan("a".repeat(64)),
      targetId: "test",
      inputLabel: "[in]",
      outputLabel: "[out]",
      subtitlePath: join(temp, "captions.ass"),
    });
    expect(output.filterParts.join(";")).toContain("Arial");
  });
  test("attempt cancellation is never converted into a font fallback", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Attempt cancelled", "AbortError");
    const references = documentFontReferences(document("a".repeat(64)));
    await expect(resolveRenderBrandFonts({
      references, fonts: [{ ...references[0]!, storageKey: "font", format: "ttf" }],
      directory: await directory(), signal: controller.signal,
      download: async () => { controller.abort(reason); throw reason; },
    })).rejects.toBe(reason);
  });
  test("TTF files supply the exact face, metrics, shaping and drawtext path", async () => {
    const bytes = await readFile(captionFontFilePath("Anton-Regular.ttf"));
    const { fonts, fingerprint, temp } = await resolve(bytes);
    const font = fonts.get(brandFontKey({ id, fingerprint }))!;
    expect(font.face.assName).toBe("Anton Regular");
    expect(font.face.ascent).toBeCloseTo(1.4043, 4);
    expect(shapeCaptionRun(font.path, "Hello").advanceEm).toBeGreaterThan(0);
    const { ass } = compileCompositionPlanCaptions(
      plan(fingerprint),
      "test",
      fonts,
    );
    expect(ass).toContain("Style: Caption,Anton Regular,");
    expect(ass).toContain("\\fnAnton Regular");
    expect(ass).not.toMatch(/NaN|undefined|Infinity/);
    const fontsDirectory = await prepareCaptionFontsDirectory(
      temp,
      fonts,
      document(fingerprint).captionPreset.fontAsset,
    );
    expect(
      await readFile(join(fontsDirectory, "Montserrat-Black.ttf")),
    ).toEqual(await readFile(captionFontFilePath("Montserrat-Black.ttf")));
    // The pinned glyph fallback faces ride along, so an uploaded face never loses RTL/CJK/emoji coverage.
    for (const fallback of ["NotoSansArabic-Regular.ttf", "NotoSansSC-Regular.otf", "NotoEmoji-Regular.ttf"]) {
      expect((await readFile(join(fontsDirectory, fallback))).length).toBeGreaterThan(1000);
    }
    const paths = Object.fromEntries(
      [...fonts].map(([key, value]) => [
        compositionAssetRef("brand_font", key),
        value.path,
      ]),
    );
    const output = compileCompositionPlanVisualLayers({
      plan: plan(fingerprint),
      targetId: "test",
      inputLabel: "[in]",
      outputLabel: "[out]",
      resolvedFonts: paths,
      captionFontsDirectory: fontsDirectory,
      subtitlePath: join(temp, "captions.ass"),
    });
    expect(output.filterParts.join(";")).toContain(font.path);
    expect(output.filterParts.join(";")).toContain(fontsDirectory);
    expect(
      await prepareCaptionFontsDirectory(
        temp,
        fonts,
        document(fingerprint).captionPreset.fontAsset,
      ),
    ).toBe(fontsDirectory);
    await expect(
      readFile(join(fontsDirectory, "Anton-Regular.ttf")),
    ).rejects.toBeDefined();
  });
  test("local FFmpeg loads uploaded TTF, OTF and WOFF2 for both ASS and drawtext", async () => {
    const require = createRequire(import.meta.url);
    const nextRoot = join(
      require.resolve("next/package.json", {
        paths: [join(import.meta.dir, "../../web")],
      }),
      "..",
    );
    const files = [
      { path: captionFontFilePath("Anton-Regular.ttf"), format: "ttf" },
      {
        path: join(
          import.meta.dir,
          "__fixtures__/brand-fonts/SourceSerif4-Regular.otf",
        ),
        format: "otf",
      },
      {
        path: join(
          nextRoot,
          "dist/next-devtools/server/font/geist-latin.woff2",
        ),
        format: "woff2",
      },
    ];
    for (const file of files) {
      const { fonts, temp, fingerprint } = await resolve(
        await readFile(file.path),
        file.format,
      );
      const font = fonts.get(brandFontKey({ id, fingerprint }))!;
      expect(font).toBeDefined();
      const fontsDirectory = await prepareCaptionFontsDirectory(
        temp,
        fonts,
        document(fingerprint).captionPreset.fontAsset,
      );
      const assPath = join(temp, "captions.ass");
      const captions = compileCompositionPlanCaptions(plan(fingerprint), "test", fonts);
      await writeFile(assPath, captions.ass);
      // HarfBuzz reads sfnt only: a WOFF2 upload keeps its base line and reports the typed degradation.
      expect(captions.geometryUnavailable.length).toBe(file.format === "woff2" ? 1 : 0);
      const result = await productionWorkerProcessModule.execute({
        command: "ffmpeg",
        signal: new AbortController().signal,
        deadlineMs: 10000,
        args: [
          "-hide_banner",
          "-loglevel",
          "verbose",
          "-f",
          "lavfi",
          "-i",
          "color=black:s=320x240:d=0.1",
          "-vf",
          `ass='${assPath}':fontsdir='${fontsDirectory}',drawtext=fontfile='${font.path}':text='Font check':fontcolor=white:fontsize=24`,
          "-frames:v",
          "1",
          "-f",
          "null",
          "-",
        ],
      });
      expect(result.exitCode).toBe(0);
    }
  });
});
