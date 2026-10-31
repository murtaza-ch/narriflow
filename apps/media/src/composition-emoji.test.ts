import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planClipComposition } from "@narriflow/composition-plan";
import { CAPTION_FONTS_DIRECTORY, captionEmojiPose } from "@narriflow/caption-fonts";
import { captionPresetSchema, editorDocumentSchema, studioEditsSchema } from "@narriflow/validators";
import { CAPTION_RENDER_DIAGNOSTIC_PATTERN, classifyCaptionRenderDiagnostics } from "./caption-glyphs";
import { compileCompositionPlanCaptions, compileCompositionPlanVisualLayers } from "./composition-ffmpeg-adapter";
import { productionWorkerProcessModule } from "./worker-process";

const WIDTH = 540;
const HEIGHT = 960;
const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** White text, no highlight colour: on this black frame only colour emoji have saturated pixels. */
const GREY_CAPTIONS = { primaryColor: "#FFFFFF", highlightColor: "#FFFFFF", outlineColor: "#000000", shadowColor: "#000000" };

function planFor(words: string[], preset: Record<string, unknown> = {}) {
  const spans = words.map((word, index) => ({ word, startSec: 0.2 + index * 0.6, endSec: 0.7 + index * 0.6, confidence: 1 }));
  const document = editorDocumentSchema.parse({
    version: 1,
    clipStartSec: 0,
    clipEndSec: 0.4 + words.length * 0.6,
    captionPreset: captionPresetSchema.parse({ wordsPerCue: 2, emojis: true, ...GREY_CAPTIONS, ...preset }),
    transcriptSlice: [
      { index: 0, speaker: 0, speakerLabel: "Speaker", startSec: 0.2, endSec: spans.at(-1)!.endSec, text: words.join(" "), confidence: 1, words: spans },
    ],
    studioEdits: studioEditsSchema.parse({ framing: { mode: "center" } }),
    brollUrl: null,
    deletedRanges: [],
  });
  const result = planClipComposition({
    document,
    source: { identity: "emoji", kind: "video", width: 1280, height: 720 },
    evidence: { automaticLayout: { state: "missing" } },
    assets: { backgroundImage: { state: "missing" } },
    capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: "shot-layout-v1" },
    targets: [{ id: "vertical", aspectRatio: "9:16", width: WIDTH, height: HEIGHT }],
  });
  if (result.status === "invalid") throw new Error(result.error.code);
  return result.plan;
}

/** Burns the captions of `plan` onto black through the production caption stage and returns stderr lines and RGB frames. */
async function burn(plan: ReturnType<typeof planFor>, times: number[], pattern: RegExp = CAPTION_RENDER_DIAGNOSTIC_PATTERN) {
  const directory = await mkdtemp(join(tmpdir(), "nf-emoji-test-"));
  scratch.push(directory);
  const track = compileCompositionPlanCaptions(plan, "vertical");
  const subtitlePath = join(directory, "captions.ass");
  await writeFile(subtitlePath, track.ass, "utf8");
  const visual = compileCompositionPlanVisualLayers({
    plan,
    targetId: "vertical",
    inputLabel: "[composition_base]",
    outputLabel: "[outv]",
    subtitlePath,
    captionFontsDirectory: CAPTION_FONTS_DIRECTORY,
    captionEmoji: track.emoji,
  });
  const frames: Buffer[] = [];
  let stderrLines: readonly string[] = [];
  for (const time of times) {
    const result = await productionWorkerProcessModule.execute({
      command: "ffmpeg",
      signal: new AbortController().signal,
      deadlineMs: 60_000,
      captureStdout: true,
      maxStdoutBytes: WIDTH * HEIGHT * 3 + 1024,
      stderrLinePattern: pattern,
      args: [
        "-hide_banner",
        "-nostdin",
        "-f", "lavfi", "-i", `color=black:s=${WIDTH}x${HEIGHT}:r=25:d=${plan.editedDurationSec}`,
        "-filter_complex", `[0:v]null[composition_base];${visual.filterParts.join(";")}`,
        "-map", "[outv]",
        "-ss", String(time),
        "-frames:v", "1",
        "-pix_fmt", "rgb24",
        "-f", "rawvideo",
        "-",
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(WIDTH * HEIGHT * 3);
    frames.push(result.stdout);
    stderrLines = [...stderrLines, ...(result.stderrLines ?? [])];
  }
  return { track, frames, stderrLines, filterParts: visual.filterParts };
}

/** Pixels whose channels differ by more than a grey caption could: only colour emoji have them on this black frame. */
function saturated(frame: Buffer, region?: { x: number; y: number; width: number; height: number }): number {
  let count = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (region && (x < region.x || x >= region.x + region.width || y < region.y || y >= region.y + region.height)) continue;
      const offset = (y * WIDTH + x) * 3;
      const r = frame[offset]!, g = frame[offset + 1]!, b = frame[offset + 2]!;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) count++;
    }
  }
  return count;
}

describe("exported emoji and glyph fallback (real FFmpeg)", () => {
  test("the active word's emoji is composited from the atlas at its window, in the planned box", async () => {
    const plan = planFor(["money", "fire", "plain", "words"]);
    const { track, frames, stderrLines, filterParts } = await burn(plan, [0.35, 0.95, 1.55]);
    expect(track.emoji.map((emoji) => emoji.key)).toEqual(["1f4b0", "1f525"]);
    const [money, fire] = track.emoji;
    const box = (emoji: NonNullable<typeof money>) => ({
      x: Math.floor(emoji.centerX - emoji.widthPx / 2) - 1,
      y: Math.floor(emoji.centerY - emoji.heightPx / 2) - 1,
      width: Math.ceil(emoji.widthPx) + 2,
      height: Math.ceil(emoji.heightPx) + 2,
    });
    // During "money" the picture is in its box and nowhere else; during "fire" the other emoji is; then none.
    expect(saturated(frames[0]!, box(money!))).toBeGreaterThan(300);
    expect(saturated(frames[0]!)).toBe(saturated(frames[0]!, box(money!)));
    expect(saturated(frames[1]!, box(fire!))).toBeGreaterThan(300);
    expect(saturated(frames[1]!)).toBe(saturated(frames[1]!, box(fire!)));
    expect(saturated(frames[2]!)).toBe(0);
    // movie reads the atlas by path: the caption stage needs no extra ffmpeg input.
    expect(filterParts.join(";")).toContain("movie=filename=");
    // libass found every glyph in the pinned faces: nothing for the host to decide.
    const diagnostics = classifyCaptionRenderDiagnostics(stderrLines);
    expect(diagnostics.missingGlyphs).toEqual([]);
    expect(diagnostics.hostFallbacks).toEqual([]);
  }, 120_000);

  test("a tilted cue turns its emoji with the line", async () => {
    const plan = planFor(["money", "plain", "words", "again"], { animation: "bounce" });
    const { track, frames, stderrLines } = await burn(plan, [0.5]);
    const [money] = track.emoji;
    expect(Math.abs(money!.rotationDeg)).toBeGreaterThan(0);
    const radius = Math.hypot(money!.widthPx, money!.heightPx) / 2 + 2;
    expect(saturated(frames[0]!, { x: Math.floor(money!.centerX - radius), y: Math.floor(money!.centerY - radius), width: Math.ceil(radius * 2), height: Math.ceil(radius * 2) })).toBeGreaterThan(300);
    expect(classifyCaptionRenderDiagnostics(stderrLines).missingGlyphs).toEqual([]);
  }, 120_000);

  test("RTL, CJK and monochrome emoji text draw real glyphs from the pinned faces", async () => {
    const plan = planFor(["مرحبا", "بكم", "你好", "こんにちは", "안녕", "★✓"], { emojis: false });
    const { frames, stderrLines } = await burn(plan, [0.45, 1.65, 2.85], /fontselect|Glyph 0x|failed to find|Error opening/);
    const lit = (frame: Buffer) => {
      let count = 0;
      for (let index = 0; index < frame.length; index += 3) if (frame[index]! > 200) count++;
      return count;
    };
    // White caption pixels exist in every cue; a .notdef box would also be white, so libass must report nothing missing.
    for (const frame of frames) expect(lit(frame)).toBeGreaterThan(500);
    const diagnostics = classifyCaptionRenderDiagnostics(stderrLines);
    expect(diagnostics.missingGlyphs).toEqual([]);
    expect(diagnostics.hostFallbacks).toEqual([]);
    expect(stderrLines.join("\n")).toMatch(/Noto Sans Arabic Regular.*-> NotoSansArabic-Regular/);
    expect(stderrLines.join("\n")).toMatch(/Noto Sans SC.*-> NotoSansSC-Regular/);
    expect(stderrLines.join("\n")).not.toMatch(/\/System\/Library|\/usr\/share\/fonts/);
  }, 120_000);

  test("libass still reports a glyph it cannot find, even though ffmpeg exits zero", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nf-emoji-test-"));
    scratch.push(directory);
    const assPath = join(directory, "missing.ass");
    await writeFile(
      assPath,
      [
        "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${WIDTH}`, `PlayResY: ${HEIGHT}`, "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Caption,Montserrat Black,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        "Dialogue: 0,0:00:00.00,0:00:01.00,Caption,,0,0,0,,{\\pos(270,480)}\u{13000}",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = await productionWorkerProcessModule.execute({
      command: "ffmpeg",
      signal: new AbortController().signal,
      deadlineMs: 30_000,
      stderrLinePattern: CAPTION_RENDER_DIAGNOSTIC_PATTERN,
      args: ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", `color=black:s=${WIDTH}x${HEIGHT}:d=0.2`, "-vf", `ass='${assPath}':fontsdir='${CAPTION_FONTS_DIRECTORY}'`, "-frames:v", "1", "-f", "null", "-"],
    });
    expect(result.exitCode).toBe(0);
    expect(classifyCaptionRenderDiagnostics(result.stderrLines ?? []).missingGlyphs.length).toBeGreaterThan(0);
  }, 60_000);

  test("a character no pinned face has is left out and the clip still burns, with no libass error", async () => {
    const plan = planFor(["hello", "a\u{13000}b"], { emojis: false });
    const { track, frames, stderrLines } = await burn(plan, [0.45, 1.05]);
    expect(track.omitted).toEqual([{ codePoint: "U+13000", cueIndex: 0 }]);
    expect(track.ass).not.toContain("\u{13000}");
    for (const frame of frames) {
      let lit = 0;
      for (let index = 0; index < frame.length; index += 3) if (frame[index]! > 200) lit++;
      expect(lit).toBeGreaterThan(300);
    }
    expect(classifyCaptionRenderDiagnostics(stderrLines).missingGlyphs).toEqual([]);
  }, 60_000);

  test("a flag plan emoji is skipped without failing the burn", async () => {
    const plan = structuredClone(planFor(["money", "plain"]));
    for (const layer of plan.targets[0]!.visualLayers) if (layer.kind === "caption") (layer as { words: unknown }).words = layer.words.map((word, index) => ({ ...word, emoji: index === 0 ? "🇵🇰" : null }));
    const { track, frames } = await burn(plan, [0.35]);
    expect(track.emoji).toEqual([]);
    expect(track.emojiSkipped).toEqual([{ emoji: "🇵🇰", cueIndex: 0 }]);
    expect(saturated(frames[0]!)).toBe(0);
  }, 60_000);

  test("the emoji pops in and fades out on the shared curve", async () => {
    const plan = planFor(["money", "fire", "plain", "words"]);
    // Video frames are every 40 ms; the money window is 0.2 to 0.8 s.
    const times = [0.2, 0.24, 0.28, 0.32, 0.4, 0.6, 0.72, 0.76, 0.8];
    const { track, frames } = await burn(plan, times);
    const [money] = track.emoji;
    const windowSec = money!.endSec - money!.startSec;
    // Ink of the emoji (the box above the caption line): proportional to alpha times area.
    const ink = frames.map((frame) => {
      let sum = 0;
      for (let y = Math.floor(money!.centerY - 45); y < money!.centerY + 45; y++) {
        for (let x = Math.floor(money!.centerX - 45); x < money!.centerX + 45; x++) {
          const offset = (y * WIDTH + x) * 3;
          sum += frame[offset]! + frame[offset + 1]! + frame[offset + 2]!;
        }
      }
      return sum;
    });
    const steady = ink[4]!;
    expect(steady).toBeGreaterThan(0);
    expect(ink[5]).toBe(steady);
    times.forEach((time, index) => {
      const pose = captionEmojiPose(time - money!.startSec, windowSec);
      // The export samples the curve every 1/120 s (the latest sample at or before a video frame), hence the tolerance.
      expect(Math.abs(ink[index]! / steady - pose.alpha * pose.scale ** 2)).toBeLessThan(0.1);
    });
    // Nothing before the window starts its first step, the overshoot exceeds the final size, and the end is gone.
    expect(ink[0]).toBe(0);
    expect(ink[2]!).toBeGreaterThan(ink[1]!);
    expect(ink[7]!).toBeLessThan(steady);
    expect(ink[8]).toBe(0);
  }, 120_000);

  test("the emoji motion adds no input slot and escapes its expressions for the filtergraph", () => {
    const plan = planFor(["money", "plain"]);
    const track = compileCompositionPlanCaptions(plan, "vertical");
    const visual = compileCompositionPlanVisualLayers({
      plan,
      targetId: "vertical",
      inputLabel: "[composition_base]",
      outputLabel: "[outv]",
      subtitlePath: "/tmp/captions.ass",
      captionEmoji: track.emoji,
    });
    const graph = visual.filterParts.join(";");
    expect(graph).toContain("eval=frame");
    expect(graph).toContain("fade=t=in:");
    expect(graph).toContain("fade=t=out:");
    expect(graph).not.toMatch(/\[0-9]+:v\]/);
  });
});
