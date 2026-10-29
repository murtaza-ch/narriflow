import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compositionAssetRef, planClipComposition } from "@narriflow/composition-plan";
import {
  captionPresetSchema,
  editorDocumentSchema,
  studioEditsSchema,
} from "@narriflow/validators";
import {
  bindCompositionPlanAudioInputs,
  compileClipCompositionCommand,
  compileCompositionPlanAudioSchedule,
  hdrColorOf,
  type HdrColor,
} from "./composition-ffmpeg-adapter";
import { productionWorkerProcessModule, type WorkerMediaInspection } from "./worker-process";

// ---------------------------------------------------------------------------
// Which sources are HDR, and how they are read
// ---------------------------------------------------------------------------

type Video = NonNullable<WorkerMediaInspection["facts"]>["videos"][number];

function inspectionWith(video: Partial<Video> | null): WorkerMediaInspection {
  return {
    durationSec: 4, width: 90, height: 160, hasVideo: video !== null, hasAudio: false, hasVisualStream: true, fps: 30,
    ...(video ? { facts: { videos: [video] } as unknown as WorkerMediaInspection["facts"] } : {}),
  };
}
const pq = { colorTransfer: "smpte2084", colorPrimaries: "bt2020", colorSpace: "bt2020nc", colorRange: "tv" } as const;
const hlg = { ...pq, colorTransfer: "arib-std-b67" } as const;
const dolby = (fields: Record<string, unknown>) => ({
  profile: 8, level: 6, rpuPresent: true, enhancementLayerPresent: false, baseLayerPresent: true, baseLayerSignalCompatibilityId: 1, ...fields,
}) as Video["dolbyVision"];

describe("HDR source reading", () => {
  test("SDR, untagged and audio-only sources take no HDR path", () => {
    expect(hdrColorOf(inspectionWith({ colorTransfer: "bt709", colorPrimaries: "bt709", colorSpace: "bt709" }))).toBeNull();
    expect(hdrColorOf(inspectionWith({ colorTransfer: null, colorPrimaries: "bt2020" }))).toBeNull();
    expect(hdrColorOf(inspectionWith({ colorTransfer: "bt2020-10", colorPrimaries: "bt2020" }))).toBeNull();
    expect(hdrColorOf(inspectionWith(null))).toBeNull();
    expect(hdrColorOf({ ...inspectionWith(null), hasVideo: true })).toBeNull();
  });

  test("PQ without mastering or content light metadata assumes a 1000 cd/m2 peak", () => {
    expect(hdrColorOf(inspectionWith(pq))).toEqual({
      transfer: "smpte2084", primaries: "2020", matrix: "2020_ncl", range: "limited", peak: 10,
    });
  });

  test("PQ scales to MaxCLL, then to the mastering display, when they are plausible", () => {
    const mastering = (maxLuminance: number | null) => ({ masteringDisplay: { maxLuminance } as Video["masteringDisplay"] });
    const light = (maxContent: number | null) => ({ contentLight: { maxContent, maxAverage: 100 } as Video["contentLight"] });
    expect(hdrColorOf(inspectionWith({ ...pq, ...light(4000), ...mastering(1000) }))?.peak).toBe(40);
    expect(hdrColorOf(inspectionWith({ ...pq, ...mastering(1000) }))?.peak).toBe(10);
    expect(hdrColorOf(inspectionWith({ ...pq, ...mastering(4000) }))?.peak).toBe(40);
    for (const bad of [0, 40, 25_000, Number.NaN, null]) {
      expect(hdrColorOf(inspectionWith({ ...pq, ...light(bad), ...mastering(bad) }))?.peak).toBe(10);
    }
    expect(hdrColorOf(inspectionWith({ ...pq, ...light(0), ...mastering(600) }))?.peak).toBe(6);
  });

  test("HLG always runs at its nominal 1000 cd/m2 peak", () => {
    expect(hdrColorOf(inspectionWith({ ...hlg, masteringDisplay: { maxLuminance: 4000 } as Video["masteringDisplay"] }))).toMatchObject({
      transfer: "arib-std-b67", peak: 10,
    });
  });

  test("missing or unusual companion tags still convert, with documented assumptions", () => {
    expect(hdrColorOf(inspectionWith({ colorTransfer: "smpte2084" }))).toMatchObject({ primaries: "2020", matrix: "2020_ncl", range: "limited" });
    expect(hdrColorOf(inspectionWith({ ...pq, colorPrimaries: "film", colorSpace: "ycgco" }))).toMatchObject({ primaries: "2020", matrix: "2020_ncl" });
    expect(hdrColorOf(inspectionWith({ ...pq, colorPrimaries: "smpte432", colorSpace: "bt2020c", colorRange: "pc" })))
      .toMatchObject({ primaries: "smpte432", matrix: "2020_cl", range: "full" });
    expect(hdrColorOf(inspectionWith({ ...pq, colorPrimaries: "bt709", colorSpace: null }))).toMatchObject({ primaries: "709", matrix: "709" });
  });

  test("Dolby Vision converts through a supported base layer and fails explicitly otherwise", () => {
    for (const id of [1, 4, 6]) expect(hdrColorOf(inspectionWith({ ...pq, dolbyVision: dolby({ baseLayerSignalCompatibilityId: id }) }))).not.toBeNull();
    expect(hdrColorOf(inspectionWith({ ...pq, dolbyVision: dolby({ profile: 7, enhancementLayerPresent: true, baseLayerSignalCompatibilityId: 6 }) }))).not.toBeNull();
    // An SDR-compatible base layer keeps its own SDR tags and path.
    expect(hdrColorOf(inspectionWith({ colorTransfer: "bt709", colorPrimaries: "bt709", dolbyVision: dolby({ baseLayerSignalCompatibilityId: 2 }) }))).toBeNull();
    for (const unsupported of [{ profile: 5, baseLayerSignalCompatibilityId: 0 }, { baseLayerSignalCompatibilityId: 0 }, { baseLayerPresent: false, enhancementLayerPresent: true }]) {
      let failure: unknown;
      try { hdrColorOf(inspectionWith({ ...pq, dolbyVision: dolby(unsupported) })); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "hdr_dolby_vision_unsupported", disposition: "permanent" });
    }
  });
});

// ---------------------------------------------------------------------------
// Trusted references: the signal and display formulas, computed independently
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const PQ = { m1: 2610 / 16384, m2: (2523 / 4096) * 128, c1: 3424 / 4096, c2: (2413 / 4096) * 32, c3: (2392 / 4096) * 32 };
const pqEncode = (nits: number) => { const y = (nits / 10_000) ** PQ.m1; return ((PQ.c1 + PQ.c2 * y) / (1 + PQ.c3 * y)) ** PQ.m2; };
const pqNits = (signal: number) => { const p = signal ** (1 / PQ.m2); return 10_000 * (Math.max(p - PQ.c1, 0) / (PQ.c2 - PQ.c3 * p)) ** (1 / PQ.m1); };
const HLG = { a: 0.17883277, b: 0.28466892, c: 0.55991073 };
const hlgEncode = (scene: number) => (scene <= 1 / 12 ? Math.sqrt(3 * scene) : HLG.a * Math.log(12 * scene - HLG.b) + HLG.c);
const hlgScene = (signal: number) => (signal <= 0.5 ? (signal * signal) / 3 : (Math.exp((signal - HLG.c) / HLG.a) + HLG.b) / 12);
const lumaOf2020 = ([r, g, b]: Rgb) => 0.2627 * r + 0.678 * g + 0.0593 * b;
const M_709_TO_2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.088, 0.8956]];
const M_2020_TO_709 = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];
const multiply = (m: number[][], v: Rgb): Rgb => m.map((row) => row[0]! * v[0] + row[1]! * v[1] + row[2]! * v[2]) as Rgb;
const hable = (x: number) => (x * (x * 0.15 + 0.05) + 0.004) / (x * (x * 0.15 + 0.5) + 0.06) - 0.02 / 0.3;

/** Display light (cd/m2, BT.709 primaries) -> 10-bit limited BT.2020nc codes. */
function encodeHdrPatch(nits709: Rgb, transfer: HdrColor["transfer"]): [number, number, number] {
  const light = multiply(M_709_TO_2020, nits709);
  let signal: Rgb;
  if (transfer === "smpte2084") signal = light.map(pqEncode) as Rgb;
  else {
    // Inverse of the 1000 cd/m2 HLG system gamma (1.2), applied per channel as
    // ARIB STD-B67 and zimg do: scene = (display / Lw) ^ (1 / 1.2).
    signal = light.map((l) => hlgEncode((l / 1000) ** (1 / 1.2))) as Rgb;
  }
  const y = lumaOf2020(signal);
  const cb = (signal[2] - y) / 1.8814;
  const cr = (signal[0] - y) / 1.4746;
  return [Math.round(64 + 876 * y), Math.round(512 + 896 * cb), Math.round(512 + 896 * cr)];
}

/** What a correct tone-mapped BT.709 SDR frame holds for those source codes:
 *  linearize, BT.2020 -> BT.709 primaries, Hable(peak), BT.1886 encode,
 *  8-bit limited BT.709 YCbCr. */
function referenceSdr(codes: [number, number, number], transfer: HdrColor["transfer"], peak: number): [number, number, number] {
  const y = (codes[0] - 64) / 876, cb = (codes[1] - 512) / 896, cr = (codes[2] - 512) / 896;
  const r = y + 1.4746 * cr, b = y + 1.8814 * cb, g = (y - 0.2627 * r - 0.0593 * b) / 0.678;
  const signal = [r, g, b].map(clamp01) as Rgb;
  let linear: Rgb;
  if (transfer === "smpte2084") linear = signal.map((s) => pqNits(s) / 100) as Rgb;
  else {
    linear = signal.map((s) => (1000 * hlgScene(s) ** 1.2) / 100) as Rgb;
  }
  const rgb = multiply(M_2020_TO_709, linear).map((v) => Math.max(0, v)) as Rgb;
  const sig = Math.max(...rgb);
  const scale = sig > 0 ? hable(sig) / hable(peak) / sig : 0;
  const [er, eg, eb] = rgb.map((v) => clamp01(v * scale) ** (1 / 2.4)) as Rgb;
  const ey = 0.2126 * er + 0.7152 * eg + 0.0722 * eb;
  return [Math.round(16 + 219 * ey), Math.round(128 + 224 * ((eb - ey) / 1.8556)), Math.round(128 + 224 * ((er - ey) / 1.5748))];
}

const PATCHES: Array<{ name: string; nits: Rgb }> = [
  { name: "near-black", nits: [1, 1, 1] },
  { name: "shadow-gray", nits: [10, 10, 10] },
  { name: "reference-white", nits: [100, 100, 100] },
  { name: "highlight", nits: [300, 300, 300] },
  { name: "bright-highlight", nits: [800, 800, 800] },
  { name: "red", nits: [90, 8, 6] },
  { name: "green", nits: [8, 70, 10] },
  { name: "skin", nits: [60, 38, 28] },
];
const WIDTH = 90, HEIGHT = 160, BAND = HEIGHT / PATCHES.length;

// ---------------------------------------------------------------------------
// Real media
// ---------------------------------------------------------------------------

const signal = new AbortController().signal;
const run = (command: "ffmpeg" | "ffprobe", args: string[]) => productionWorkerProcessModule.execute({
  command, args: command === "ffmpeg" ? ["-hide_banner", "-loglevel", "error", "-y", ...args] : args,
  signal, deadlineMs: 120_000, captureStdout: true, maxStdoutBytes: 1024 * 1024,
});

/** A 90x160 clip of horizontal flat bands, one per patch, tagged like an
 *  HDR10 or HLG file: BT.2020, 10-bit limited, x265. */
async function hdrClip(directory: string, name: string, transfer: HdrColor["transfer"], seconds: number, extraX265 = "") {
  const frame = Buffer.alloc(WIDTH * HEIGHT * 1.5 * 2);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const lumaBytes = WIDTH * HEIGHT * 2, chromaBytes = (WIDTH / 2) * (HEIGHT / 2) * 2;
  PATCHES.forEach((patch, index) => {
    const [y, cb, cr] = encodeHdrPatch(patch.nits, transfer);
    for (let row = index * BAND; row < (index + 1) * BAND; row++) {
      for (let x = 0; x < WIDTH; x++) view.setUint16((row * WIDTH + x) * 2, y, true);
      if (row % 2 === 0) for (let x = 0; x < WIDTH / 2; x++) {
        const at = ((row / 2) * (WIDTH / 2) + x) * 2;
        view.setUint16(lumaBytes + at, cb, true);
        view.setUint16(lumaBytes + chromaBytes + at, cr, true);
      }
    }
  });
  const path = join(directory, `${name}.mp4`);
  const trc = transfer === "smpte2084" ? "smpte2084" : "arib-std-b67";
  const rawPath = join(directory, `${name}.yuv`);
  writeFileSync(rawPath, Buffer.concat(Array.from({ length: Math.round(seconds * 30) }, () => frame)));
  await run("ffmpeg", [
    "-f", "rawvideo", "-pix_fmt", "yuv420p10le", "-s", `${WIDTH}x${HEIGHT}`, "-r", "30", "-i", rawPath,
    "-c:v", "libx265", "-preset", "ultrafast", "-crf", "8",
    "-x265-params", `log-level=error:colorprim=bt2020:transfer=${trc}:colormatrix=bt2020nc:range=limited${extraX265}`,
    "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", path,
  ]);
  return path;
}

async function sdrClip(directory: string, seconds: number) {
  const path = join(directory, "sdr.mp4");
  await run("ffmpeg", ["-f", "lavfi", "-i", `color=c=gray:s=${WIDTH}x${HEIGHT}:r=30:d=${seconds}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    // Like nearly every camera, phone and platform download, the SDR source is tagged BT.709.
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", path]);
  return path;
}

const SCENE_ID = "8ab9d330-688f-4574-932c-27ac661245c1";
const SCENE_ASSET = { kind: "visual_asset" as const, id: "3b9bfb1a-9e16-4a0e-a6d1-111111111111", fingerprint: "a".repeat(64) };

async function render(input: { source: WorkerMediaInspection; sourcePath: string; outputPath: string; scene?: { path: string; hdr: HdrColor | null }; colorScene?: boolean }) {
  const ref = compositionAssetRef("visual_asset", `${SCENE_ASSET.id}:${SCENE_ASSET.fingerprint}`);
  const result = planClipComposition({
    document: editorDocumentSchema.parse({
      version: 1, clipStartSec: 0, clipEndSec: 3, captionPreset: captionPresetSchema.parse({ visible: false }), transcriptSlice: [],
      deletedRanges: [], studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }), brollUrl: null,
      sceneBlocks: input.colorScene ? [{
        schemaVersion: 1, id: SCENE_ID, anchorSec: 1, durationSec: 1,
        content: { kind: "color", color: "#112233" }, motion: { entrance: "none", exit: "none" }, templateSnapshot: null,
      }] : input.scene ? [{
        schemaVersion: 1, id: SCENE_ID, anchorSec: 1, durationSec: 1,
        content: { kind: "video", asset: SCENE_ASSET, sourceStartSec: 0, sourceEndSec: 1, fit: "cover", backgroundColor: "#000000", muted: true, volume: 100 },
        motion: { entrance: "none", exit: "none" }, templateSnapshot: null,
      }] : [],
    }),
    source: { identity: "source:hdr", kind: "video", width: input.source.width, height: input.source.height, hasAudio: false },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" }, ...(input.scene ? { sceneVisuals: { [SCENE_ID]: { state: "available", ref } } } : {}) },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: WIDTH, height: HEIGHT }],
  } as Parameters<typeof planClipComposition>[0]);
  if (result.status === "invalid") throw new Error(result.error.code);
  const args = compileClipCompositionCommand({
    sourcePath: input.sourcePath, outputPath: input.outputPath, startSec: 0, endSec: 3, source: input.source, plan: result.plan, targetId: "vertical",
    audio: bindCompositionPlanAudioInputs(compileCompositionPlanAudioSchedule(result.plan), {}),
    encoder: { preset: "ultrafast", crf: "8" },
    assets: {
      subtitlePath: null,
      ...(input.scene ? {
        scenes: { [ref]: { path: input.scene.path, kind: "video" as const, hasAudio: false } },
        ...(input.scene.hdr ? { hdr: { [ref]: input.scene.hdr } } : {}),
      } : {}),
    },
  });
  await run("ffmpeg", args);
  return args;
}

/** Y, Cb, Cr at the centre of every patch band at `timeSec`. */
async function patchCodes(path: string, timeSec: number): Promise<Array<[number, number, number]>> {
  const out = await run("ffmpeg", ["-ss", String(timeSec), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]);
  const data = out.stdout;
  const chroma = (WIDTH / 2) * (HEIGHT / 2);
  return PATCHES.map((_, index) => {
    const row = Math.floor((index + 0.5) * BAND);
    const at = row * WIDTH + WIDTH / 2;
    const chromaAt = Math.floor(row / 2) * (WIDTH / 2) + Math.floor(WIDTH / 4);
    return [data[at]!, data[WIDTH * HEIGHT + chromaAt]!, data[WIDTH * HEIGHT + chroma + chromaAt]!];
  });
}

async function videoFacts(path: string) {
  const probe = JSON.parse(new TextDecoder().decode((await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,pix_fmt,color_range,color_space,color_transfer,color_primaries:stream_side_data", "-of", "json", path,
  ])).stdout));
  return probe.streams[0] as Record<string, unknown>;
}

const LUMA_TOLERANCE = 4, CHROMA_TOLERANCE = 6;
function worstError(actual: Array<[number, number, number]>, expected: Array<[number, number, number]>) {
  return PATCHES.map((patch, index) => ({
    patch: patch.name,
    luma: Math.abs(actual[index]![0] - expected[index]![0]),
    chroma: Math.max(Math.abs(actual[index]![1] - expected[index]![1]), Math.abs(actual[index]![2] - expected[index]![2])),
  }));
}

describe("real HDR media renders as tone-mapped BT.709 SDR", () => {
  for (const transfer of ["smpte2084", "arib-std-b67"] as const) {
    test(`${transfer}: patches match the independent tone-map reference and tags are BT.709 yuv420p`, async () => {
      await productionWorkerProcessModule.withScratchDirectory("narriflow-hdr-", async (directory) => {
        const sourcePath = await hdrClip(directory, "hdr", transfer, 3);
        const source = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal, deadlineMs: 30_000 });
        const hdr = hdrColorOf(source)!;
        expect(hdr).toMatchObject({ transfer, peak: 10 });

        const outputPath = join(directory, "out.mp4");
        const args = await render({ source, sourcePath, outputPath });
        expect(args[args.indexOf("-filter_complex") + 1]).toContain(
          `zscale=tin=${transfer}:pin=2020:min=2020_ncl:rin=limited:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0:peak=10,zscale=t=bt709:m=bt709:p=bt709:r=limited:dither=ordered,format=yuv420p`,
        );

        const facts = await videoFacts(outputPath);
        expect(facts).toMatchObject({
          codec_name: "h264", pix_fmt: "yuv420p", color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709",
        });
        expect(JSON.stringify(facts.side_data_list ?? [])).not.toMatch(/mastering|content light/i);

        const actual = await patchCodes(outputPath, 0.5);
        const expected = PATCHES.map((patch) => referenceSdr(encodeHdrPatch(patch.nits, transfer), transfer, hdr.peak));
        for (const error of worstError(actual, expected)) {
          expect({ patch: error.patch, ok: error.luma <= LUMA_TOLERANCE }).toEqual({ patch: error.patch, ok: true });
          expect({ patch: error.patch, ok: error.chroma <= CHROMA_TOLERANCE }).toEqual({ patch: error.patch, ok: true });
        }
        // Highlights roll off instead of clipping together: every brighter gray stays brighter.
        const grays = actual.slice(0, 5).map((codes) => codes[0]);
        expect(grays.every((luma, index) => index === 0 || luma > grays[index - 1]!)).toBe(true);
        expect(grays[4]!).toBeLessThanOrEqual(235);
        // Real conversion, not a relabel: the same bytes with BT.709 tags only are far from the reference.
        const relabeled = join(directory, "relabeled.mp4");
        await run("ffmpeg", [
          "-i", sourcePath, "-vf", "format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
          "-c:v", "libx264", "-crf", "8", "-preset", "ultrafast", relabeled,
        ]);
        const relabelErrors = worstError(await patchCodes(relabeled, 0.5), expected);
        expect(Math.max(...relabelErrors.map((error) => error.luma))).toBeGreaterThan(LUMA_TOLERANCE * 2);
      });
    }, 120_000);
  }

  test("MaxCLL scales the PQ tone map: a 4000 cd/m2 file renders darker than the default", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-hdr-peak-", async (directory) => {
      const sourcePath = await hdrClip(directory, "hdr", "smpte2084", 3);
      const probed = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal, deadlineMs: 30_000 });
      const video = probed.facts!.videos[0]!;
      const source = { ...probed, facts: { ...probed.facts!, videos: [{ ...video, contentLight: { maxContent: 4000, maxAverage: 400 } }] } };
      const hdr = hdrColorOf(source)!;
      expect(hdr.peak).toBe(40);
      const outputPath = join(directory, "out.mp4");
      await render({ source, sourcePath, outputPath });
      const actual = await patchCodes(outputPath, 0.5);
      const expected = PATCHES.map((patch) => referenceSdr(encodeHdrPatch(patch.nits, "smpte2084"), "smpte2084", 40));
      for (const error of worstError(actual, expected)) {
        expect(error.luma).toBeLessThanOrEqual(LUMA_TOLERANCE);
        expect(error.chroma).toBeLessThanOrEqual(CHROMA_TOLERANCE);
      }
      const defaultExpected = PATCHES.map((patch) => referenceSdr(encodeHdrPatch(patch.nits, "smpte2084"), "smpte2084", 10));
      expect(actual[3]![0]).toBeLessThan(defaultExpected[3]![0] - 10);
      expect((await videoFacts(outputPath)).side_data_list ?? []).toEqual([]);
    });
  }, 120_000);

  test("an HDR inserted scene video is tone-mapped before it is fitted, beside an SDR source", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-hdr-scene-", async (directory) => {
      const sourcePath = await sdrClip(directory, 3);
      const source = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal, deadlineMs: 30_000 });
      const scenePath = await hdrClip(directory, "scene", "smpte2084", 1.5);
      const sceneInspection = await productionWorkerProcessModule.inspectMedia({ sourcePath: scenePath, signal, deadlineMs: 30_000 });
      const sceneHdr = hdrColorOf(sceneInspection)!;
      const outputPath = join(directory, "out.mp4");
      const args = await render({ source, sourcePath, outputPath, scene: { path: scenePath, hdr: sceneHdr } });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).toMatch(/\[1:v\]trim=start=0\.000:end=1\.000,setpts=PTS-STARTPTS,tpad=[^,]+,trim=duration=1\.000,zscale=tin=smpte2084/);
      expect(graph.split("zscale=tin=").length - 1).toBe(1);

      const facts = await videoFacts(outputPath);
      expect(facts).toMatchObject({ pix_fmt: "yuv420p", color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709" });
      const expected = PATCHES.map((patch) => referenceSdr(encodeHdrPatch(patch.nits, "smpte2084"), "smpte2084", sceneHdr.peak));
      for (const error of worstError(await patchCodes(outputPath, 1.5), expected)) {
        expect(error.luma).toBeLessThanOrEqual(LUMA_TOLERANCE);
        expect(error.chroma).toBeLessThanOrEqual(CHROMA_TOLERANCE);
      }
      // The SDR source before the scene is untouched gray, not converted.
      const [gray] = await patchCodes(outputPath, 0.4);
      expect(Math.abs(gray![0] - 126)).toBeLessThanOrEqual(3);
    });
  }, 120_000);
});

describe("HDR source beside a generated scene", () => {
  test("the tone-mapped frames survive concat with an untagged color scene", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-hdr-color-scene-", async (directory) => {
      const sourcePath = await hdrClip(directory, "hdr", "smpte2084", 3);
      const source = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal, deadlineMs: 30_000 });
      const outputPath = join(directory, "out.mp4");
      await render({ source, sourcePath, outputPath, colorScene: true });
      expect(await videoFacts(outputPath)).toMatchObject({ pix_fmt: "yuv420p", color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709" });
      const expected = PATCHES.map((patch) => referenceSdr(encodeHdrPatch(patch.nits, "smpte2084"), "smpte2084", 10));
      for (const t of [0.4, 2.5]) {
        for (const error of worstError(await patchCodes(outputPath, t), expected)) {
          expect(error.luma).toBeLessThanOrEqual(LUMA_TOLERANCE);
          expect(error.chroma).toBeLessThanOrEqual(CHROMA_TOLERANCE);
        }
      }
    });
  }, 120_000);
});

describe("SDR sources keep their exact path", () => {
  test("an SDR source's graph and args contain no HDR filters", async () => {
    await productionWorkerProcessModule.withScratchDirectory("narriflow-hdr-sdr-", async (directory) => {
      const sourcePath = await sdrClip(directory, 3);
      const source = await productionWorkerProcessModule.inspectMedia({ sourcePath, signal, deadlineMs: 30_000 });
      expect(hdrColorOf(source)).toBeNull();
      const args = await render({ source, sourcePath, outputPath: join(directory, "out.mp4") });
      expect(args.join(" ")).not.toMatch(/zscale|tonemap|composition_sdr_source/);
    });
  }, 60_000);
});

describe("deployment health", () => {
  test("the host FFmpeg has the HDR filters and the pinned image requires them", async () => {
    const listing = new TextDecoder().decode((await run("ffmpeg", ["-filters"])).stdout);
    expect(listing).toMatch(/\bzscale\b/);
    expect(listing).toMatch(/\btonemap\b/);
    const lock = JSON.parse(readFileSync(join(import.meta.dir, "..", "runtime-lock.json"), "utf8"));
    const required: string[] = lock.platforms["linux-x64"].ffmpeg.requiredFilters;
    expect(required).toContain("zscale");
    expect(required).toContain("tonemap");
    expect(Object.keys(lock.platforms["linux-x64"].ffmpeg.libraries)).toContain("libzimg2");
  });
});
