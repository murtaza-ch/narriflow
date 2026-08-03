import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCaptionPresetById } from "@narriflow/validators";
import type { CaptionPreset, TranscriptUtterance } from "@narriflow/validators";
import {
  buildAudiogramArgs,
  buildBrollVideoArgs,
  buildCropAndScaleFilter,
  buildFreeTierPostProcessArgs,
  buildMultiVideoArgs,
  buildSingleVideoArgs,
  downloadUrlToFile,
  escapeDrawtextText,
  generateAssFromSlice,
  generateSrtFromSlice,
  resolveRenderTimingForClip,
} from "./render-clips";

function makeUtterance(
  words: Array<[string, number, number]>,
): TranscriptUtterance {
  return {
    index: 0,
    speaker: 0,
    speakerLabel: "Speaker 1",
    startSec: words[0]![1],
    endSec: words[words.length - 1]![2],
    text: words.map(([w]) => w).join(" "),
    confidence: 0.95,
    words: words.map(([word, startSec, endSec]) => ({
      word,
      startSec,
      endSec,
      confidence: 0.95,
    })),
  };
}

function preset(id: string): CaptionPreset {
  const found = getCaptionPresetById(id);
  if (!found) throw new Error(`missing preset ${id}`);
  return found.preset;
}

function countDialogues(ass: string): number {
  return ass.split("\n").filter((line) => line.startsWith("Dialogue:")).length;
}

describe("resolveRenderTimingForClip", () => {
  test("does not cap caption-only renders to market clip duration", () => {
    const utterances: TranscriptUtterance[] = [
      {
        index: 0,
        speaker: 0,
        speakerLabel: "Speaker 1",
        startSec: 0,
        endSec: 300,
        text: "full length caption",
        confidence: 0.98,
        words: [
          {
            word: "full",
            startSec: 0,
            endSec: 100,
            confidence: 0.98,
          },
          {
            word: "length",
            startSec: 100,
            endSec: 200,
            confidence: 0.98,
          },
          {
            word: "caption",
            startSec: 200,
            endSec: 300,
            confidence: 0.98,
          },
        ],
      },
    ];

    const timing = resolveRenderTimingForClip({
      llmModel: "caption-only",
      startSec: 0,
      endSec: 300,
      utterances,
    });

    expect(timing.startSec).toBe(0);
    expect(timing.endSec).toBe(300);
    expect(timing.durationSec).toBe(300);
  });
});

describe("generateAssFromSlice (caption fidelity)", () => {
  const utterance = makeUtterance([
    ["Hello", 0, 0.5],
    ["there", 0.5, 1.0],
    ["world", 1.0, 1.5],
  ]);

  test("emits one word-synced event per word with the highlight color", () => {
    const ass = generateAssFromSlice([utterance], 0, "9:16", preset("karaoke"));
    // 3 words -> 3 active-word events (matches the preview's per-word highlight)
    expect(countDialogues(ass)).toBe(3);
    // #00FF88 -> ASS BGR &H0088FF00 wrapped around the active word
    expect(ass).toContain("\\1c&H0088FF00&");
    expect(ass).toContain("[Events]");
  });

  test("positions captions from the position enum default (bottom=88%)", () => {
    const ass = generateAssFromSlice([utterance], 0, "9:16", preset("karaoke"));
    // 9:16 => 1080x1920, x=50% => 540, y=88% => 1690
    expect(ass).toContain("\\pos(540,1690)");
    expect(ass).toContain("\\an5");
  });

  test("honors center position presets", () => {
    const ass = generateAssFromSlice([utterance], 0, "9:16", preset("matrix"));
    // matrix preset is position:center => y=50% => 960
    expect(ass).toContain("\\pos(540,960)");
  });

  test("renders a highlight box as a thick colored border on the active word", () => {
    const ass = generateAssFromSlice([utterance], 0, "9:16", preset("highlighter"));
    // highlighter highlightBoxColor #FF3CAC -> BGR &H00AC3CFF
    expect(ass).toContain("\\3c&H00AC3CFF&");
    expect(ass).toMatch(/\\bord\d/);
  });

  test("renders glow as a colored, blurred shadow", () => {
    const ass = generateAssFromSlice([utterance], 0, "9:16", preset("neon-dreams"));
    expect(ass).toContain("\\4c");
    expect(ass).toContain("\\blur");
  });

  test("scales position to each aspect ratio resolution", () => {
    const ass = generateAssFromSlice([utterance], 0, "16:9", preset("karaoke"));
    // 16:9 => 1920x1080, x=50% => 960, y=88% => 950
    expect(ass).toContain("\\pos(960,950)");
  });

  test("appends emojis to matched keywords only when enabled", () => {
    const u = makeUtterance([
      ["This", 0, 0.3],
      ["is", 0.3, 0.5],
      ["fire", 0.5, 1.0],
    ]);
    const off = generateAssFromSlice([u], 0, "9:16", preset("karaoke"));
    expect(off).not.toContain("🔥");

    const on = generateAssFromSlice([u], 0, "9:16", {
      ...preset("karaoke"),
      emojis: true,
    });
    expect(on).toContain("🔥");
  });
});

describe("generateSrtFromSlice (no-preset fallback)", () => {
  test("groups words into fixed cues of CAPTION_CHUNK_SIZE", () => {
    const utterance = makeUtterance([
      ["one", 0, 0.4],
      ["two", 0.4, 0.8],
      ["three", 0.8, 1.2],
      ["four", 1.2, 1.6],
    ]);
    const srt = generateSrtFromSlice([utterance], 0);
    // 4 words -> 2 cues (3 + 1)
    expect(srt).toContain("1\n");
    expect(srt).toContain("2\n");
    expect(srt).toContain("one two three");
    expect(srt).toContain("four");
  });
});

describe("buildCropAndScaleFilter (auto-reframe)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true };

  test("uses a static center crop without a reframe spec", () => {
    const f = buildCropAndScaleFilter(probe, "9:16");
    expect(f).toContain("crop=");
    expect(f).not.toContain("sendcmd");
    expect(f).toContain("scale=1080:1920");
  });

  test("drives crop x via sendcmd when reframing landscape -> portrait", () => {
    const f = buildCropAndScaleFilter(probe, "9:16", {
      scriptPath: "/tmp/r.txt",
      cropName: "crop@reframe",
    });
    expect(f).toContain("sendcmd=f='/tmp/r.txt'");
    expect(f).toContain("crop@reframe=w=608:h=1080");
    expect(f).toContain("scale=1080:1920");
  });

  test("does not reframe 16:9 from a 16:9 source (no horizontal crop)", () => {
    const f = buildCropAndScaleFilter(probe, "16:9", {
      scriptPath: "/tmp/r.txt",
      cropName: "crop@reframe",
    });
    expect(f).not.toContain("sendcmd");
  });
});

describe("buildBrollVideoArgs (B-roll cutaway)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true };

  test("overlays a single b-roll cutaway only during its window, keeps source audio", () => {
    const args = buildBrollVideoArgs({
      sourcePath: "/tmp/src.mp4",
      cutaways: [{ path: "/tmp/broll.mp4", window: { startSec: 8, endSec: 11.5 } }],
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 30,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      captionPreset: getCaptionPresetById("karaoke")!.preset,
    });
    const fi = args.indexOf("-filter_complex");
    const graph = args[fi + 1]!;
    // b-roll is input [1] and is cover-fit then overlaid within the window
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(graph).toContain("force_original_aspect_ratio=increase");
    expect(graph).toContain("overlay=0:0:enable='between(t,8,11.5)'");
    // source audio is routed through the boundary fade, not the b-roll's
    expect(graph).toContain("[0:a:0]afade=t=in");
    expect(args).toContain("[outa]");
  });

  test("throws when called with zero cutaways", () => {
    expect(() =>
      buildBrollVideoArgs({
        sourcePath: "/tmp/src.mp4",
        cutaways: [],
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 30,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
      }),
    ).toThrow();
  });

  test("chains multiple recurring cutaways through successive overlay stages", () => {
    const args = buildBrollVideoArgs({
      sourcePath: "/tmp/src.mp4",
      cutaways: [
        { path: "/tmp/broll-0.mp4", window: { startSec: 3, endSec: 6 } },
        { path: "/tmp/broll-1.mp4", window: { startSec: 12, endSec: 15 } },
        { path: "/tmp/broll-2.mp4", window: { startSec: 21, endSec: 24 } },
      ],
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 30,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
    });

    // source + 3 b-roll inputs
    expect(args.filter((a) => a === "-i")).toHaveLength(4);

    const fi = args.indexOf("-filter_complex");
    const graph = args[fi + 1]!;
    expect(graph).toContain("overlay=0:0:enable='between(t,3,6)'");
    expect(graph).toContain("overlay=0:0:enable='between(t,12,15)'");
    expect(graph).toContain("overlay=0:0:enable='between(t,21,24)'");
    // Each overlay stage feeds the next (chained, not independent/parallel).
    expect(graph).toContain("[stage1]");
    expect(graph).toContain("[stage2]");

    // Every b-roll input is trimmed to its own window's duration.
    const iIndexes: number[] = [];
    args.forEach((a, i) => {
      if (a === "-i") iIndexes.push(i);
    });
    expect(args[iIndexes[1]! - 2]).toBe("-t");
    expect(args[iIndexes[1]! - 1]).toBe("3.000");
    expect(args[iIndexes[2]! - 2]).toBe("-t");
    expect(args[iIndexes[2]! - 1]).toBe("3.000");
    expect(args[iIndexes[3]! - 2]).toBe("-t");
    expect(args[iIndexes[3]! - 1]).toBe("3.000");

    // Output-level -t still bounds the whole render to the clip's duration.
    const tIndexes = indexesOf(args, "-t");
    const outputTIndex = tIndexes[tIndexes.length - 1]!;
    expect(args[outputTIndex + 1]).toBe("30.000");
    expect(outputTIndex).toBeGreaterThan(fi);
  });

  test("shifts the logo/music input indices by the number of cutaways", () => {
    const args = buildBrollVideoArgs({
      sourcePath: "/tmp/src.mp4",
      cutaways: [
        { path: "/tmp/broll-0.mp4", window: { startSec: 3, endSec: 6 } },
        { path: "/tmp/broll-1.mp4", window: { startSec: 12, endSec: 15 } },
      ],
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 30,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      logo: {
        filePath: "/tmp/logo.png",
        position: "top-right",
        opacity: 100,
        scalePct: 12,
      },
      music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
    });

    const fi = args.indexOf("-filter_complex");
    const graph = args[fi + 1]!;
    // logo is input [3] (0=source, 1-2=broll, 3=logo), music is input [4]
    expect(graph).toContain("[3:v]");
    expect(graph).toContain("[4:a]");
  });
});

describe("buildFreeTierPostProcessArgs (free-tier watermark + 720p cap)", () => {
  const base = {
    inputPath: "/tmp/in.mp4",
    outputPath: "/tmp/out.mp4",
    watermarkText: "Made with Narriflow",
  };

  test("downscales by 2/3 and draws the escaped watermark text", () => {
    const args = buildFreeTierPostProcessArgs({
      ...base,
      watermarkText: "it's 10:30",
    });
    const vfIdx = args.indexOf("-vf");
    expect(vfIdx).toBeGreaterThan(-1);
    const filter = args[vfIdx + 1]!;
    // 2/3 downscale, rounded to even dimensions (1080x1920 -> 720x1280)
    expect(filter).toContain("scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2");
    // ' and : in the text are escaped for drawtext (two levels: option value
    // escaping, then filtergraph escaping — so ' becomes \\\' and : becomes \\:)
    expect(filter).toContain("drawtext=text=it\\\\\\'s 10\\\\:30");
    expect(filter).toContain("fontcolor=white@0.85");
    expect(filter).toContain("fontsize=h/28");
    expect(filter).toContain("x=w-tw-h/40");
  });

  test("copies audio and puts input/output paths in the right positions", () => {
    const args = buildFreeTierPostProcessArgs(base);
    const caIdx = args.indexOf("-c:a");
    expect(args[caIdx + 1]).toBe("copy");
    // input follows -i; output is the final arg
    expect(args[args.indexOf("-i") + 1]).toBe("/tmp/in.mp4");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
    // re-encode matches the render builders' encoder settings (default
    // veryfast/CRF21 — see WORKER_X264_PRESET / WORKER_X264_CRF)
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args[args.indexOf("-preset") + 1]).toBe("veryfast");
    expect(args[args.indexOf("-crf") + 1]).toBe("21");
  });

  test("includes fontfile only when a font file path is provided", () => {
    const without = buildFreeTierPostProcessArgs(base);
    expect(without.join(" ")).not.toContain("fontfile=");

    const withFont = buildFreeTierPostProcessArgs({
      ...base,
      fontFilePath: "/usr/share/fonts/x.ttf",
    });
    const vf = withFont[withFont.indexOf("-vf") + 1]!;
    expect(vf).toContain("fontfile=/usr/share/fonts/x.ttf");
  });

  test("escapeDrawtextText escapes backslash, quote, colon and percent", () => {
    // Two escaping levels (option value, then filtergraph): \ -> \\\\,
    // ' -> \\\', : -> \\:, % -> \\% .
    expect(escapeDrawtextText("a\\b'c:d%e")).toBe(
      "a\\\\\\\\b\\\\\\'c\\\\:d\\\\%e",
    );
  });
});

describe("buildAudiogramArgs (audio-only renders)", () => {
  test("builds an animated waveform over a background with the preset color", () => {
    const args = buildAudiogramArgs({
      sourcePath: "/tmp/a.mp3",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 30,
      aspectRatio: "9:16",
      clipDurationSec: 30,
      srtPath: null,
      captionPreset: getCaptionPresetById("karaoke")!.preset,
    });
    const filterIdx = args.indexOf("-filter_complex");
    expect(filterIdx).toBeGreaterThan(-1);
    const graph = args[filterIdx + 1]!;
    expect(graph).toContain("showwaves");
    expect(graph).toContain("overlay");
    // karaoke highlight #00FF88 -> 0x00FF88
    expect(graph).toContain("colors=0x00FF88");
    // maps the composited video + the fade-wrapped source audio
    expect(args).toContain("[outv]");
    expect(args).toContain("[outa]");
    expect(graph).toContain("afade=t=out");
  });
});

function indexesOf(args: string[], value: string): number[] {
  const result: number[] = [];
  args.forEach((arg, index) => {
    if (arg === value) result.push(index);
  });
  return result;
}

describe("output duration bound (FIX: over-long B-roll/inputs can no longer stretch the output)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true };

  test("buildSingleVideoArgs adds an explicit output -t in addition to the input -t", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 5,
      endSec: 25, // 20s clip
      aspectRatio: "9:16",
      probe,
      srtPath: null,
    });

    const tIndexes = indexesOf(args, "-t");
    // one input-level -t (trims input 0) + one output-level -t (bounds the file)
    expect(tIndexes).toHaveLength(2);
    expect(args[tIndexes[0]! + 1]).toBe("20");
    expect(args[tIndexes[1]! + 1]).toBe("20.000");
    // the output -t sits in the output-option section, after -filter_complex
    expect(tIndexes[1]!).toBeGreaterThan(args.indexOf("-filter_complex"));
  });

  test("buildBrollVideoArgs trims the b-roll input to its own cutaway window and still bounds total output duration", () => {
    // Regression check for the measured bug: a 20s clip with a much longer
    // b-roll asset (e.g. 25s) starting its cutaway at 5.6s used to produce a
    // ~30.6s output, because the untrimmed b-roll input (input [1]) ran past
    // the (correctly trimmed) 20s main input, and overlay's default
    // shortest=0 stretches the output to the longer of the two.
    const args = buildBrollVideoArgs({
      sourcePath: "/tmp/src.mp4",
      cutaways: [
        { path: "/tmp/broll.mp4", window: { startSec: 5.6, endSec: 9.1 } }, // a 3.5s cutaway window
      ],
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20, // 20s clip
      aspectRatio: "9:16",
      probe,
      srtPath: null,
    });

    const iIndexes = indexesOf(args, "-i");
    expect(iIndexes).toHaveLength(2); // source, then b-roll

    // The b-roll's own -t (immediately preceding its -i) is scoped to just
    // the 3.5s cutaway window — never the full length of whatever asset was
    // downloaded (previously untrimmed, however long the source file was).
    expect(args[iIndexes[1]! - 2]).toBe("-t");
    expect(args[iIndexes[1]! - 1]).toBe("3.500");

    // Output-level -t bounds the whole render to the clip's own 20s duration
    // regardless of the (now-trimmed) b-roll input.
    const tIndexes = indexesOf(args, "-t");
    const outputTIndex = tIndexes[tIndexes.length - 1]!;
    expect(args[outputTIndex + 1]).toBe("20.000");
    expect(outputTIndex).toBeGreaterThan(args.indexOf("-filter_complex"));
  });

  test("buildMultiVideoArgs bounds every output's duration independently", () => {
    const outputs = [
      {
        clipRenderId: "r1",
        clipId: "c1",
        clipIndex: 0,
        aspectRatio: "9:16" as const,
        outputPath: "/tmp/o1.mp4",
        storageKey: "k1",
      },
      {
        clipRenderId: "r2",
        clipId: "c1",
        clipIndex: 0,
        aspectRatio: "16:9" as const,
        outputPath: "/tmp/o2.mp4",
        storageKey: "k2",
      },
    ];
    const args = buildMultiVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputs,
      startSec: 0,
      endSec: 15,
      probe,
      srtPath: null,
    });

    const tValues = indexesOf(args, "-t").map((index) => args[index + 1]);
    // one input-level -t ("15") + one output-level -t ("15.000") per output
    expect(tValues).toEqual(["15", "15.000", "15.000"]);
  });

  test("buildAudiogramArgs adds an explicit -t alongside -shortest", () => {
    const args = buildAudiogramArgs({
      sourcePath: "/tmp/a.mp3",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 12,
      aspectRatio: "9:16",
      clipDurationSec: 12,
      srtPath: null,
    });

    const shortestIdx = args.indexOf("-shortest");
    expect(shortestIdx).toBeGreaterThan(-1);
    expect(args[shortestIdx + 1]).toBe("-t");
    expect(args[shortestIdx + 2]).toBe("12.000");
  });
});

describe("music mixing (FIX: no more quiet 6dB dialogue duck + startOffsetSec)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true };

  test("mixes at unity gain (normalize=0) and applies volume only to the music branch", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      music: { path: "/tmp/music.mp3", volume: 40, startOffsetSec: 12 },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;

    // amix must disable automatic 1/N normalization (previously missing —
    // ffmpeg's default silently dropped the dialogue ~6dB for a 2-input mix).
    expect(graph).toContain(
      "amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
    );
    // the music's own volume (40/100) is applied explicitly on its branch...
    expect(graph).toContain("volume=0.400");
    // ...and the dialogue (0:a) branch is never itself scaled down.
    expect(graph).not.toMatch(/\[0:a\][^;]*volume=/);
  });

  test("honors studioEdits.music.startOffsetSec by seeking into the (looped) music input", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      music: { path: "/tmp/music.mp3", volume: 40, startOffsetSec: 12 },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("atrim=start=12.000:duration=20.000");
  });

  test("defaults the offset to 0 when startOffsetSec is 0", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      music: { path: "/tmp/music.mp3", volume: 35, startOffsetSec: 0 },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("atrim=start=0.000:duration=10.000");
  });
});

describe("downloadUrlToFile (bounded, timed remote B-roll/music download)", () => {
  const PUBLIC_ADDRESS = "93.184.216.34";
  const publicResolver = async () => [
    { address: PUBLIC_ADDRESS, family: 4 as const },
  ];

  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "render-clips-download-test-"));
    filePath = join(tempDir, "asset.bin");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("streams a successful response to disk", async () => {
    const body = "hello broll asset";
    await downloadUrlToFile(
      "https://cdn.example/asset.mp4",
      filePath,
      "broll_download_failed",
      {
        resolver: publicResolver,
        fetchImpl: async () => new Response(body, { status: 200 }),
      },
    );
    expect(await readFile(filePath, "utf-8")).toBe(body);
  });

  test("rejects a declared Content-Length over the size cap", async () => {
    await expect(
      downloadUrlToFile(
        "https://cdn.example/huge.mp4",
        filePath,
        "broll_download_failed",
        {
          resolver: publicResolver,
          maxBytes: 10,
          fetchImpl: async () =>
            new Response(new Uint8Array(20), {
              status: 200,
              headers: { "content-length": "20" },
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "broll_download_failed" });
  });

  test("rejects an oversized streamed body with no length header (mid-stream)", async () => {
    await expect(
      downloadUrlToFile(
        "https://cdn.example/huge.mp4",
        filePath,
        "music_download_failed",
        {
          resolver: publicResolver,
          maxBytes: 10,
          fetchImpl: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array(6));
                  controller.enqueue(new Uint8Array(6)); // 12 bytes total > 10 cap
                  controller.close();
                },
              }),
              { status: 200 },
            ),
        },
      ),
    ).rejects.toMatchObject({ code: "music_download_failed" });
  });

  test("rejects a non-2xx status", async () => {
    await expect(
      downloadUrlToFile(
        "https://cdn.example/missing.mp4",
        filePath,
        "broll_download_failed",
        {
          resolver: publicResolver,
          fetchImpl: async () => new Response(null, { status: 404 }),
        },
      ),
    ).rejects.toMatchObject({ code: "broll_download_failed" });
  });

  test("rejects a redirect to a private/reserved address instead of following it (SSRF guard)", async () => {
    let secondFetchAttempted = false;
    await expect(
      downloadUrlToFile(
        "https://cdn.example/redirect",
        filePath,
        "broll_download_failed",
        {
          resolver: async (hostname: string) => [
            {
              address:
                hostname === "internal.example" ? "127.0.0.1" : PUBLIC_ADDRESS,
              family: 4 as const,
            },
          ],
          fetchImpl: async (input) => {
            if (input.toString().includes("internal.example")) {
              secondFetchAttempted = true;
              return new Response("secret", { status: 200 });
            }
            return new Response(null, {
              status: 302,
              headers: { location: "https://internal.example/secret" },
            });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "broll_download_failed" });
    expect(secondFetchAttempted).toBe(false);
  });

  test("enforces a bounded timeout instead of hanging on a stalled request", async () => {
    // Simulates a request that never resolves on its own (a stalled
    // connection) by only settling in response to the AbortSignal that
    // guardedFetch attaches — proving downloadUrlToFile passes a *short*,
    // bounded timeout through rather than the caller waiting forever (or for
    // the full 45s default meant for a legitimately slow-but-alive host).
    await expect(
      downloadUrlToFile(
        "https://cdn.example/slow",
        filePath,
        "broll_download_failed",
        {
          resolver: publicResolver,
          timeoutMs: 20,
          fetchImpl: (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  const timeoutError = new Error("The operation timed out.");
                  timeoutError.name = "TimeoutError";
                  reject(timeoutError);
                },
                { once: true },
              );
            }),
        },
      ),
    ).rejects.toMatchObject({ code: "broll_download_failed" });
  });
});

describe("ranged https source input (presigned URL reads)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true };
  const httpsSource =
    "https://r2.example.com/projects/p1/source.mp4?X-Amz-Signature=abc";

  test("buildSingleVideoArgs injects reconnect/rw_timeout input options before -ss, which stays before -i", () => {
    const args = buildSingleVideoArgs({
      sourcePath: httpsSource,
      outputPath: "/tmp/out.mp4",
      startSec: 5,
      endSec: 25,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
    });

    const reconnectIdx = args.indexOf("-reconnect");
    const rwTimeoutIdx = args.indexOf("-rw_timeout");
    const ssIdx = args.indexOf("-ss");
    const iIdx = args.indexOf("-i");

    expect(reconnectIdx).toBeGreaterThan(-1);
    expect(rwTimeoutIdx).toBeGreaterThan(-1);
    // Input options must precede the seek, and the seek must precede -i so
    // ffmpeg range-requests only the clip window instead of the whole object.
    expect(reconnectIdx).toBeLessThan(ssIdx);
    expect(rwTimeoutIdx).toBeLessThan(ssIdx);
    expect(ssIdx).toBeLessThan(iIdx);
    expect(args[iIdx + 1]).toBe(httpsSource);

    // Reconnect only on genuinely transient statuses.
    const onHttpErrorIdx = args.indexOf("-reconnect_on_http_error");
    expect(args[onHttpErrorIdx + 1]).toBe("429,500,502,503,504");
  });

  test("local source paths get no http input options", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 5,
      endSec: 25,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
    });

    expect(args).not.toContain("-reconnect");
    expect(args).not.toContain("-rw_timeout");
  });

  test("buildBrollVideoArgs binds http input options to input 0 only", () => {
    const args = buildBrollVideoArgs({
      sourcePath: httpsSource,
      cutaways: [
        { path: "/tmp/broll.mp4", window: { startSec: 5.6, endSec: 9.1 } },
      ],
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
    });

    const iIndexes = indexesOf(args, "-i");
    const reconnectIdx = args.indexOf("-reconnect");

    expect(reconnectIdx).toBeGreaterThan(-1);
    expect(reconnectIdx).toBeLessThan(iIndexes[0]!);
    // The local b-roll input must not inherit the http-only options.
    expect(indexesOf(args, "-reconnect")).toHaveLength(1);
  });
});

describe("boundary audio fade coverage", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true };

  test("buildSingleVideoArgs routes non-music audio through the fade chain", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 10,
      endSec: 40,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;

    expect(graph).toContain("[0:a:0]afade=t=in:st=0:d=0.040");
    expect(graph).toContain("afade=t=out:st=29.880:d=0.120");
    expect(args).toContain("[outa]");
    expect(args).not.toContain("0:a:0?");
  });

  test("buildMultiVideoArgs splits audio per output and fades each branch", () => {
    const args = buildMultiVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputs: [
        { aspectRatio: "9:16", outputPath: "/tmp/a.mp4", subtitlePath: null, reframe: null },
        { aspectRatio: "1:1", outputPath: "/tmp/b.mp4", subtitlePath: null, reframe: null },
      ] as never,
      startSec: 0,
      endSec: 20,
      probe,
      srtPath: null,
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;

    expect(graph).toContain("[0:a:0]asplit=2[aud0][aud1]");
    expect(graph).toContain("[aud0]afade=t=in");
    expect(graph).toContain("[aud1]afade=t=in");
    expect(args).toContain("[outa0]");
    expect(args).toContain("[outa1]");
  });
});
