import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRenderConfig } from "../render-config";
import {
  computeSpeechWindows,
  getCaptionPresetById,
  studioEditsSchema,
} from "@narriflow/validators";
import type {
  CaptionPreset,
  ClipLayoutAnalysis,
  TranscriptUtterance,
} from "@narriflow/validators";
import {
  buildAudiogramArgs,
  buildBrollVideoArgs,
  buildCropAndScaleFilter,
  buildFitAndBackgroundFilter,
  buildFreeTierPostProcessArgs,
  buildMultiVideoArgs,
  buildSingleVideoArgs,
  buildTransitionFilter,
  clipRenderAttemptStorageKey,
  applySpeakerLayoutOverridesToSegments,
  decidePipUsage,
  decideScreenFallback,
  decideSplitFallback,
  downloadUrlToFile,
  escapeDrawtextText,
  framingForcesPerOutputRender,
  generateAssFromSlice,
  generateSrtFromSlice,
  layoutAnalysisMatchesWindow,
  resolveBackgroundPlanForDownloadedImage,
  resolveClipLogoOverlay,
  remapSceneCutsForCutPlan,
  resolvePipAnalysis,
  resolveRenderTimingForClip,
  shouldRunAutoReframeDetection,
} from "./render-clips";
import type { PipDetectionResult } from "./render-clips";
import { buildClipCutPlan } from "./cut-plan";
import { SCREEN_BOTTOM_CROP_NAME } from "./screen-layout";
import type { SplitLayoutSegment } from "./two-up";

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

  test("punctuation off strips trailing punctuation from cue text", () => {
    const u = makeUtterance([
      ["Hello,", 0, 0.5],
      ["world.", 0.5, 1.0],
    ]);
    // karaoke's textTransform is "uppercase", so the punctuation-on baseline
    // also uppercases the raw token — assert against that, not the raw case.
    const withPunct = generateAssFromSlice([u], 0, "9:16", preset("karaoke"));
    expect(withPunct).toContain("HELLO,");
    expect(withPunct).toContain("WORLD.");

    const noPunct = generateAssFromSlice([u], 0, "9:16", {
      ...preset("karaoke"),
      punctuation: false,
    });
    expect(noPunct).not.toContain("HELLO,");
    expect(noPunct).not.toContain("WORLD.");
    expect(noPunct).toContain("HELLO");
    expect(noPunct).toContain("WORLD");
  });

  test("punctuation off drops a pure-punctuation token's dialogue event instead of emitting blank text", () => {
    const u = makeUtterance([
      ["Wait", 0, 0.3],
      ["...", 0.3, 0.5],
      ["really", 0.5, 1.0],
    ]);
    const ass = generateAssFromSlice([u], 0, "9:16", {
      ...preset("karaoke"),
      punctuation: false,
    });
    // Strip the leading `{\an5...}` position override, then any inline
    // per-word highlight-color override codes, leaving just the plain
    // visible cue text — no dialogue line should collapse to nothing.
    const bodies = ass
      .split("\n")
      .filter((l) => l.startsWith("Dialogue:"))
      .map((l) => l.replace(/^[^{]*\{[^}]*\}/, ""))
      .map((l) => l.replace(/\{[^}]*\}/g, ""))
      .map((l) => l.trim());
    expect(bodies).toHaveLength(3);
    expect(bodies.every((b) => b.length > 0)).toBe(true);
    expect(bodies.every((b) => b === "WAIT REALLY")).toBe(true);
  });

  test("emoji lookup is unaffected by the punctuation setting (emojiForWord already normalizes)", () => {
    const u = makeUtterance([
      ["This", 0, 0.3],
      ["is", 0.3, 0.5],
      ["fire!", 0.5, 1.0],
    ]);
    const withPunct = generateAssFromSlice([u], 0, "9:16", {
      ...preset("karaoke"),
      emojis: true,
    });
    const withoutPunct = generateAssFromSlice([u], 0, "9:16", {
      ...preset("karaoke"),
      emojis: true,
      punctuation: false,
    });
    expect(withPunct).toContain("🔥");
    expect(withoutPunct).toContain("🔥");
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

  test("punctuation off (5th param) strips trailing punctuation from cue text", () => {
    const utterance = makeUtterance([
      ["Hello,", 0, 0.4],
      ["world.", 0.4, 0.8],
    ]);
    const withPunct = generateSrtFromSlice([utterance], 0, undefined, null, true);
    expect(withPunct).toContain("Hello, world.");

    const noPunct = generateSrtFromSlice([utterance], 0, undefined, null, false);
    // The SRT timestamp line itself uses "," (e.g. "00:00:00,000") — only the
    // cue TEXT line (the last of the 3-line cue block) should be punctuation-free.
    const textLine = noPunct.trim().split("\n")[2]!;
    expect(textLine).toBe("Hello world");
  });

  test("punctuation off drops a cue whose every word is pure punctuation", () => {
    const utterance = makeUtterance([
      ["...", 0, 0.4],
      ["!!", 0.4, 0.8],
    ]);
    const srt = generateSrtFromSlice([utterance], 0, undefined, null, false);
    expect(srt).toBe("");
  });
});

describe("buildCropAndScaleFilter (auto-reframe)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };

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

describe("shouldRunAutoReframeDetection (vizard-parity Phase C-2 stage 1 — framing modes)", () => {
  test("auto mode (the default) runs detection", () => {
    expect(shouldRunAutoReframeDetection(studioEditsSchema.parse({}))).toBe(true);
    expect(
      shouldRunAutoReframeDetection(
        studioEditsSchema.parse({ framing: { mode: "auto" } }),
      ),
    ).toBe(true);
  });

  test("center mode skips detection entirely", () => {
    expect(
      shouldRunAutoReframeDetection(
        studioEditsSchema.parse({ framing: { mode: "center" } }),
      ),
    ).toBe(false);
  });

  test("split mode (split packet B) skips the SINGLE-face gate — it runs its own multi-face detection separately", () => {
    expect(
      shouldRunAutoReframeDetection(
        studioEditsSchema.parse({ framing: { mode: "split" } }),
      ),
    ).toBe(false);
  });

  test("fit (background active) skips detection regardless of framing.mode", () => {
    const withAuto = studioEditsSchema.parse({
      background: { mode: "color", color: "#112233", imageUrl: null },
      framing: { mode: "auto" },
    });
    expect(shouldRunAutoReframeDetection(withAuto)).toBe(false);

    const withCenter = studioEditsSchema.parse({
      background: { mode: "color", color: "#112233", imageUrl: null },
      framing: { mode: "center" },
    });
    expect(shouldRunAutoReframeDetection(withCenter)).toBe(false);
  });
});

describe("framingForcesPerOutputRender (split packet B — batch-encoder gate)", () => {
  test("true for split mode", () => {
    expect(
      framingForcesPerOutputRender(studioEditsSchema.parse({ framing: { mode: "split" } })),
    ).toBe(true);
  });

  test("false for auto/center — those already route through buildMultiVideoArgs fine", () => {
    expect(
      framingForcesPerOutputRender(studioEditsSchema.parse({ framing: { mode: "auto" } })),
    ).toBe(false);
    expect(
      framingForcesPerOutputRender(studioEditsSchema.parse({ framing: { mode: "center" } })),
    ).toBe(false);
  });

  test("false when background wins as 'fit' even though framing.mode is 'split'", () => {
    // resolveEffectiveFramingMode: background !== "off" always wins as "fit",
    // so the effective mode here is "fit", not "split" — backgroundPlan
    // (not this function) is what forces the per-output path in that case.
    const withBackground = studioEditsSchema.parse({
      background: { mode: "color", color: "#112233", imageUrl: null },
      framing: { mode: "split" },
    });
    expect(framingForcesPerOutputRender(withBackground)).toBe(false);
  });

  // L1 (adversarial review): the WORKER_SPLIT=0 kill switch must route split
  // through the SAME batch path "auto"/"center" use, not force the
  // per-output path just to immediately fall back inside it on every render.
  test("false for split mode when WORKER_SPLIT=0, even though the effective mode is still 'split'", () => {
    expect(
      framingForcesPerOutputRender(
        studioEditsSchema.parse({ framing: { mode: "split" } }),
        parseRenderConfig({ WORKER_SPLIT: "0" }),
      ),
    ).toBe(false);
  });

  // Screen packet B: "screen" gets the exact same per-output-forcing
  // treatment as "split", gated by its own WORKER_SCREEN_LAYOUT kill switch.
  test("true for screen mode", () => {
    expect(
      framingForcesPerOutputRender(studioEditsSchema.parse({ framing: { mode: "screen" } })),
    ).toBe(true);
  });

  test("false when background wins as 'fit' even though framing.mode is 'screen'", () => {
    const withBackground = studioEditsSchema.parse({
      background: { mode: "color", color: "#112233", imageUrl: null },
      framing: { mode: "screen" },
    });
    expect(framingForcesPerOutputRender(withBackground)).toBe(false);
  });

  test("false for screen mode when WORKER_SCREEN_LAYOUT=0 (fully reverts routing, mirrors split's kill switch)", () => {
    expect(
      framingForcesPerOutputRender(
        studioEditsSchema.parse({ framing: { mode: "screen" } }),
        parseRenderConfig({ WORKER_SCREEN_LAYOUT: "0" }),
      ),
    ).toBe(false);
  });

  // Cross-check: each kill switch only ever affects its own mode.
  test("WORKER_SCREEN_LAYOUT=0 does not affect split, and WORKER_SPLIT=0 does not affect screen", () => {
    expect(
      framingForcesPerOutputRender(
        studioEditsSchema.parse({ framing: { mode: "split" } }),
        parseRenderConfig({ WORKER_SCREEN_LAYOUT: "0" }),
      ),
    ).toBe(true);
    expect(
      framingForcesPerOutputRender(
        studioEditsSchema.parse({ framing: { mode: "screen" } }),
        parseRenderConfig({ WORKER_SPLIT: "0" }),
      ),
    ).toBe(true);
  });
});

describe("decideScreenFallback (screen packet B — fallback-decision matrix)", () => {
  test("B-roll wins the fallback, same v1 policy as split", () => {
    expect(decideScreenFallback({ hasBrollPlan: true })).toBe("broll_conflict");
  });

  test("no B-roll: no fallback (an undetected face is NOT a fallback reason — it degrades to a static-center bottom tile instead)", () => {
    expect(decideScreenFallback({ hasBrollPlan: false })).toBeNull();
  });
});

describe("decidePipUsage (M6 — the PiP decision matrix, ordered, full coverage)", () => {
  const rect = { x: 0.8, y: 0.8, w: 0.15, h: 0.15 };
  // A "fully passing" base — each test below flips exactly ONE field to
  // isolate that gate, proving the ORDER (first blocking reason wins) as
  // well as each individual gate.
  const passingBase = {
    pipDetectEnabled: true,
    segmentExtracted: true,
    detection: { movingPxFrac: 0.1, insufficientSamples: false },
    selectedRect: rect,
    faceConfirmed: true,
  };

  test("everything passes: ok, useRect true", () => {
    expect(decidePipUsage(passingBase)).toEqual({ useRect: true, reason: "ok" });
  });

  test("1. disabled wins over every other failing gate", () => {
    expect(
      decidePipUsage({
        ...passingBase,
        pipDetectEnabled: false,
        segmentExtracted: false,
        detection: null,
        selectedRect: null,
        faceConfirmed: false,
      }),
    ).toEqual({ useRect: false, reason: "disabled" });
  });

  test("2. segment_extract_failed (when enabled but no segment)", () => {
    expect(
      decidePipUsage({ ...passingBase, segmentExtracted: false, detection: null }),
    ).toEqual({ useRect: false, reason: "segment_extract_failed" });
  });

  test("3. detection_unavailable (segment extracted, but pip_detect.py failed/unavailable)", () => {
    expect(decidePipUsage({ ...passingBase, detection: null })).toEqual({
      useRect: false,
      reason: "detection_unavailable",
    });
  });

  test("4. insufficient_samples (M4/L4 — insufficientSamples flag)", () => {
    expect(
      decidePipUsage({
        ...passingBase,
        detection: { movingPxFrac: null, insufficientSamples: true },
      }),
    ).toEqual({ useRect: false, reason: "insufficient_samples" });
  });

  test("4b. insufficient_samples also fires on a null movingPxFrac even if the flag were somehow false", () => {
    expect(
      decidePipUsage({
        ...passingBase,
        detection: { movingPxFrac: null, insufficientSamples: false },
      }),
    ).toEqual({ useRect: false, reason: "insufficient_samples" });
  });

  test("5. not_screencast_like (classifyScreencast rejects the motion profile)", () => {
    expect(
      decidePipUsage({
        ...passingBase,
        detection: { movingPxFrac: 0.9, insufficientSamples: false },
      }),
    ).toEqual({ useRect: false, reason: "not_screencast_like" });
  });

  test("5b. screencastThreshold override is respected", () => {
    expect(
      decidePipUsage({
        ...passingBase,
        detection: { movingPxFrac: 0.4, insufficientSamples: false },
        screencastThreshold: 0.3,
      }),
    ).toEqual({ useRect: false, reason: "not_screencast_like" });
    expect(
      decidePipUsage({
        ...passingBase,
        detection: { movingPxFrac: 0.4, insufficientSamples: false },
        screencastThreshold: 0.5,
      }),
    ).toEqual({ useRect: true, reason: "ok" });
  });

  test("6. no_candidate (selectPipRect found nothing)", () => {
    expect(decidePipUsage({ ...passingBase, selectedRect: null })).toEqual({
      useRect: false,
      reason: "no_candidate",
    });
  });

  test("7. face_not_in_rect (H2 — the guard against motion-only false positives)", () => {
    expect(decidePipUsage({ ...passingBase, faceConfirmed: false })).toEqual({
      useRect: false,
      reason: "face_not_in_rect",
    });
  });

  test("8. pip_too_small (M3 — only checked when `fit` is provided)", () => {
    expect(
      decidePipUsage({ ...passingBase, fit: { fittedCropWidth: 100, tileWidth: 1000 } }),
    ).toEqual({ useRect: false, reason: "pip_too_small" });
    expect(
      decidePipUsage({ ...passingBase, fit: { fittedCropWidth: 500, tileWidth: 1000 } }),
    ).toEqual({ useRect: true, reason: "ok" });
  });

  test("omitting `fit` entirely skips the pip_too_small gate (clip-level check)", () => {
    expect(decidePipUsage({ ...passingBase, fit: null })).toEqual({
      useRect: true,
      reason: "ok",
    });
  });

});

// M2 (adversarial review): `resolvePipAnalysis` is the extracted read-
// before-detect/write-after-detect wiring — `detect`/`persist` are fake
// spies here so these tests never touch `pip_detect.py` or a database.
// Replaces the old "persisted-vs-fresh equivalence" test above (deleted):
// that test only proved `decidePipUsage` doesn't care about its caller's
// shape, which was true by construction (it takes plain values) and never
// exercised any of `resolvePipAnalysis`'s actual read/write branching.
describe("resolvePipAnalysis (M2 — PiP persistence read/write wiring, DI'd detect/persist)", () => {
  const rect = { x: 0.8, y: 0.8, w: 0.15, h: 0.15 };
  const qualifyingCandidate = {
    x: 0.79,
    y: 0.78,
    w: 0.2,
    h: 0.2,
    areaFrac: 0.04,
    fillFrac: 0.9,
    cornerAdjacent: true,
    medianDiffMean: 4.6,
  };

  function makeSpies(overrides?: {
    detectResult?: PipDetectionResult | null;
    persistShouldThrow?: boolean;
  }) {
    const detectCalls: unknown[] = [];
    const persistCalls: ClipLayoutAnalysis[] = [];
    const detect = async (params: unknown) => {
      detectCalls.push(params);
      return overrides?.detectResult ?? null;
    };
    const persist = async (envelope: ClipLayoutAnalysis) => {
      persistCalls.push(envelope);
      if (overrides?.persistShouldThrow) throw new Error("persist failed");
    };
    return { detect, persist, detectCalls, persistCalls };
  }

  const persistedEnvelope: ClipLayoutAnalysis = {
    version: 1,
    analyzedAtISO: "2026-08-06T09:00:00.000Z",
    sourceStartSec: 12.5,
    sourceDurationSec: 30,
    clipStartSec: 12.5,
    clipEndSec: 42.5,
    movingPxFrac: 0.04,
    insufficientSamples: false,
    pipRect: rect,
    pipUsable: true,
  };

  test("persisted-hit skips detect() entirely", async () => {
    const { detect, persist, detectCalls, persistCalls } = makeSpies();
    const result = await resolvePipAnalysis({
      persisted: persistedEnvelope,
      pipDetectEnabled: true,
      detectInput: { path: "/tmp/seg.mp4", startSec: 0 },
      startSec: 12.5,
      durationSec: 30,
      rawClipStartSec: 12.5,
      rawClipEndSec: 42.5,
      detect,
      persist,
    });
    expect(detectCalls.length).toBe(0);
    expect(persistCalls.length).toBe(0);
    expect(result).toEqual({
      detectionResult: { movingPxFrac: 0.04, insufficientSamples: false },
      selectedRect: rect,
      candidateCount: null,
      analysisSource: "persisted",
    });
  });

  test("analyzed-negative (selectedRect null) still persists, with pipUsable: false", async () => {
    const { detect, persist, detectCalls, persistCalls } = makeSpies({
      detectResult: { movingPxFrac: 0.03, insufficientSamples: false, candidates: [] },
    });
    const result = await resolvePipAnalysis({
      persisted: null,
      pipDetectEnabled: true,
      detectInput: { path: "/tmp/seg.mp4", startSec: 0 },
      startSec: 12.5,
      durationSec: 30,
      rawClipStartSec: 12.5,
      rawClipEndSec: 42.5,
      detect,
      persist,
    });
    expect(detectCalls.length).toBe(1);
    expect(result.selectedRect).toBeNull();
    expect(result.analysisSource).toBe("fresh");
    expect(persistCalls.length).toBe(1);
    expect(persistCalls[0]).toMatchObject({
      pipRect: null,
      pipUsable: false,
      sourceStartSec: 12.5,
      sourceDurationSec: 30,
    });
  });

  test("fresh detection WITH a qualifying candidate does NOT persist (deferred to the caller, which alone knows this render's pipUsable via decidePipUsage)", async () => {
    const { detect, persist, persistCalls } = makeSpies({
      detectResult: {
        movingPxFrac: 0.15,
        insufficientSamples: false,
        candidates: [qualifyingCandidate],
      },
    });
    const result = await resolvePipAnalysis({
      persisted: null,
      pipDetectEnabled: true,
      detectInput: { path: "/tmp/seg.mp4", startSec: 0 },
      startSec: 12.5,
      durationSec: 30,
      rawClipStartSec: 12.5,
      rawClipEndSec: 42.5,
      detect,
      persist,
    });
    expect(result.selectedRect).not.toBeNull();
    expect(result.analysisSource).toBe("fresh");
    expect(persistCalls.length).toBe(0);
  });

  test("WORKER_PIP_DETECT=0 (pipDetectEnabled: false) calls neither detect() nor persist()", async () => {
    const { detect, persist, detectCalls, persistCalls } = makeSpies({
      detectResult: { movingPxFrac: 0.15, insufficientSamples: false, candidates: [qualifyingCandidate] },
    });
    const result = await resolvePipAnalysis({
      persisted: null,
      pipDetectEnabled: false,
      detectInput: { path: "/tmp/seg.mp4", startSec: 0 },
      startSec: 12.5,
      durationSec: 30,
      rawClipStartSec: 12.5,
      rawClipEndSec: 42.5,
      detect,
      persist,
    });
    expect(detectCalls.length).toBe(0);
    expect(persistCalls.length).toBe(0);
    expect(result).toEqual({
      detectionResult: null,
      selectedRect: null,
      candidateCount: null,
      analysisSource: null,
    });
  });

  test("no detectInput (segment extraction failed) calls neither, even when detection is enabled", async () => {
    const { detect, persist, detectCalls, persistCalls } = makeSpies();
    const result = await resolvePipAnalysis({
      persisted: null,
      pipDetectEnabled: true,
      detectInput: null,
      startSec: 12.5,
      durationSec: 30,
      rawClipStartSec: 12.5,
      rawClipEndSec: 42.5,
      detect,
      persist,
    });
    expect(detectCalls.length).toBe(0);
    expect(persistCalls.length).toBe(0);
    expect(result.analysisSource).toBeNull();
  });

  test("persist() throwing logs-and-continues — resolvePipAnalysis still returns normally", async () => {
    const { detect, persist, persistCalls } = makeSpies({
      detectResult: { movingPxFrac: 0.03, insufficientSamples: false, candidates: [] },
      persistShouldThrow: true,
    });
    let result: Awaited<ReturnType<typeof resolvePipAnalysis>> | undefined;
    let thrown: unknown;
    try {
      result = await resolvePipAnalysis({
        persisted: null,
        pipDetectEnabled: true,
        detectInput: { path: "/tmp/seg.mp4", startSec: 0 },
        startSec: 12.5,
        durationSec: 30,
        rawClipStartSec: 12.5,
        rawClipEndSec: 42.5,
        detect,
        persist,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeUndefined();
    expect(persistCalls.length).toBe(1);
    expect(result).toEqual({
      detectionResult: { movingPxFrac: 0.03, insufficientSamples: false },
      selectedRect: null,
      candidateCount: 0,
      analysisSource: "fresh",
    });
  });
});

describe("layoutAnalysisMatchesWindow (PiP persistence packet B — window-match semantics)", () => {
  const analysis: Pick<ClipLayoutAnalysis, "sourceStartSec" | "sourceDurationSec"> = {
    sourceStartSec: 12.5,
    sourceDurationSec: 30,
  };

  test("exact match", () => {
    expect(layoutAnalysisMatchesWindow(analysis, 12.5, 30)).toBe(true);
  });

  test("within the default epsilon (0.05s) on both start and duration", () => {
    expect(layoutAnalysisMatchesWindow(analysis, 12.53, 29.97)).toBe(true);
  });

  test("exactly at the epsilon boundary still matches (<=, not <) — integer diffs to avoid float rounding at the assertion", () => {
    const wholeNumberWindow = { sourceStartSec: 100, sourceDurationSec: 200 };
    expect(layoutAnalysisMatchesWindow(wholeNumberWindow, 101, 200, 1)).toBe(true);
    expect(layoutAnalysisMatchesWindow(wholeNumberWindow, 100, 201, 1)).toBe(true);
  });

  test("just past the epsilon boundary on startSec does not match", () => {
    expect(layoutAnalysisMatchesWindow(analysis, 12.56, 30)).toBe(false);
  });

  test("just past the epsilon boundary on durationSec does not match", () => {
    expect(layoutAnalysisMatchesWindow(analysis, 12.5, 30.06)).toBe(false);
  });

  test("a real trim (startSec moved well beyond epsilon) invalidates the match", () => {
    expect(layoutAnalysisMatchesWindow(analysis, 20, 22.5)).toBe(false);
  });

  test("a custom epsilon widens or narrows the tolerance", () => {
    expect(layoutAnalysisMatchesWindow(analysis, 12.6, 30, 0.2)).toBe(true);
    expect(layoutAnalysisMatchesWindow(analysis, 12.51, 30, 0)).toBe(false);
  });
});

describe("applySpeakerLayoutOverridesToSegments", () => {
  const segments: SplitLayoutSegment[] = [
    {
      startSec: 0,
      endSec: 5,
      layout: "two-up",
      topCxNorm: 0.25,
      bottomCxNorm: 0.75,
    },
  ];

  test("maps the matching aspect's independent layer frames and crops into the render plan", () => {
    const result = applySpeakerLayoutOverridesToSegments(
      segments,
      [
        {
          id: "scene-1",
          aspectRatio: "9:16",
          startSec: 0,
          endSec: 5,
          layout: "two-up",
          layers: [
            {
              role: "top",
              frameX: 0.1,
              frameY: 0.05,
              frameWidth: 0.8,
              frameHeight: 0.4,
              rotationDeg: 3,
              cropCxNorm: 0.3,
              cropCyNorm: 0.45,
              cropZoom: 1.4,
            },
            {
              role: "bottom",
              frameX: 0,
              frameY: 0.5,
              frameWidth: 1,
              frameHeight: 0.5,
              rotationDeg: 0,
              cropCxNorm: 0.7,
              cropCyNorm: 0.55,
              cropZoom: 1.2,
            },
          ],
        },
      ],
      "9:16",
    );

    expect(result).not.toBe(segments);
    expect(result[0]).toMatchObject({
      topCxNorm: 0.3,
      topCyNorm: 0.45,
      topZoom: 1.4,
      topFrame: { x: 0.1, y: 0.05, width: 0.8, height: 0.4, rotationDeg: 3 },
      bottomCxNorm: 0.7,
      bottomCyNorm: 0.55,
      bottomZoom: 1.2,
    });
  });

  test("keeps the fast-path plan reference when no override matches the output aspect", () => {
    const result = applySpeakerLayoutOverridesToSegments(
      segments,
      [
        {
          id: "scene-1",
          aspectRatio: "9:16",
          startSec: 0,
          endSec: 5,
          layout: "two-up",
          layers: [
            {
              role: "top",
              frameX: 0,
              frameY: 0,
              frameWidth: 1,
              frameHeight: 0.5,
              rotationDeg: 0,
              cropCxNorm: 0.25,
              cropCyNorm: 0.5,
              cropZoom: 1,
            },
            {
              role: "bottom",
              frameX: 0,
              frameY: 0.5,
              frameWidth: 1,
              frameHeight: 0.5,
              rotationDeg: 0,
              cropCxNorm: 0.75,
              cropCyNorm: 0.5,
              cropZoom: 1,
            },
          ],
        },
      ],
      "1:1",
    );
    expect(result).toBe(segments);
  });
});

describe("decideSplitFallback (split packet B — fallback-decision matrix)", () => {
  test("B-roll always wins the fallback, regardless of detection/plan state", () => {
    expect(
      decideSplitFallback({
        hasBrollPlan: true,
        detectionAvailable: true,
        plan: { segments: [{ startSec: 0, endSec: 1, layout: "single", cxNorm: 0.5 }], clusterCount: 2, cappedFromSegmentCount: null },
      }),
    ).toBe("broll_conflict");
  });

  test("detection unavailable (no python/opencv/model, or extraction failed)", () => {
    expect(
      decideSplitFallback({ hasBrollPlan: false, detectionAvailable: false, plan: null }),
    ).toBe("detection_unavailable");
  });

  test("detection ran but fewer than 2 clusters were found", () => {
    expect(
      decideSplitFallback({
        hasBrollPlan: false,
        detectionAvailable: true,
        plan: { segments: [], clusterCount: 1, cappedFromSegmentCount: null },
      }),
    ).toBe("insufficient_clusters");
  });

  test("2+ clusters but the plan still produced zero renderable segments", () => {
    expect(
      decideSplitFallback({
        hasBrollPlan: false,
        detectionAvailable: true,
        plan: { segments: [], clusterCount: 2, cappedFromSegmentCount: null },
      }),
    ).toBe("empty_plan");
  });

  test("a real plan with at least one two-up segment needs no fallback", () => {
    expect(
      decideSplitFallback({
        hasBrollPlan: false,
        detectionAvailable: true,
        plan: {
          segments: [
            { startSec: 0, endSec: 1, layout: "two-up", topCxNorm: 0.3, bottomCxNorm: 0.7 },
          ],
          clusterCount: 2,
          cappedFromSegmentCount: null,
        },
      }),
    ).toBeNull();
  });

  // M4 (adversarial review): a plan can have 2+ clusters and non-empty
  // segments yet STILL have nothing to render as a real 2-up if every
  // segment collapsed to "single" (e.g. the two clusters were never on
  // screen at the same time) — the spike's conclusion was that this should
  // route through the existing single-shot auto-reframe path instead of
  // stretching a single-face crop into a pointless top/bottom-identical
  // stack.
  test("a plan with zero two-up segments (all 'single') falls back — no_two_up_segments", () => {
    expect(
      decideSplitFallback({
        hasBrollPlan: false,
        detectionAvailable: true,
        plan: {
          segments: [
            { startSec: 0, endSec: 1, layout: "single", cxNorm: 0.5 },
            { startSec: 1, endSec: 2, layout: "single", cxNorm: 0.4 },
          ],
          clusterCount: 2,
          cappedFromSegmentCount: null,
        },
      }),
    ).toBe("no_two_up_segments");
  });
});

describe("buildTransitionFilter (vizard-parity Phase C — apply-to-all + fade-black)", () => {
  function transition(type: "none" | "fade" | "fade-black" | "dip-white", durationSec = 0.4) {
    return studioEditsSchema.parse({ transition: { type, durationSec } }).transition;
  }

  test("none produces no filter", () => {
    expect(buildTransitionFilter(transition("none"), 10)).toBeNull();
  });

  test("undefined transition produces no filter", () => {
    expect(buildTransitionFilter(undefined, 10)).toBeNull();
  });

  test("fade omits an explicit color (ffmpeg's fade default is black)", () => {
    const f = buildTransitionFilter(transition("fade"), 10)!;
    expect(f).not.toContain(":color=");
    expect(f).toContain("fade=t=in:st=0:d=0.400");
    expect(f).toContain("fade=t=out:st=9.600:d=0.400");
  });

  test("fade-black explicitly dips to black", () => {
    const f = buildTransitionFilter(transition("fade-black"), 10)!;
    expect(f).toContain("fade=t=in:st=0:d=0.400:color=black");
    expect(f).toContain("fade=t=out:st=9.600:d=0.400:color=black");
  });

  test("dip-white explicitly dips to white", () => {
    const f = buildTransitionFilter(transition("dip-white"), 10)!;
    expect(f).toContain("fade=t=in:st=0:d=0.400:color=white");
    expect(f).toContain("fade=t=out:st=9.600:d=0.400:color=white");
  });

  test("clamps duration to half the clip length", () => {
    const f = buildTransitionFilter(transition("fade-black", 2), 1)!;
    expect(f).toContain("fade=t=in:st=0:d=0.500:color=black");
    expect(f).toContain("fade=t=out:st=0.500:d=0.500:color=black");
  });
});

describe("buildFitAndBackgroundFilter (canvas background, vizard-parity Phase C item 2)", () => {
  test("color mode: scale-to-fit then pad with the hex color, no crop", () => {
    const parts = buildFitAndBackgroundFilter({
      aspectRatio: "9:16",
      background: { mode: "color", color: "#112233", imagePath: null },
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(
      "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2," +
        "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x112233,format=yuv420p[outv]",
    );
    expect(parts[0]).not.toContain("crop=");
  });

  test("color mode with no color set falls back to black", () => {
    const parts = buildFitAndBackgroundFilter({
      aspectRatio: "9:16",
      background: { mode: "color", color: null, imagePath: null },
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
    });
    expect(parts[0]).toContain("color=0x000000");
  });

  test("image mode: cover-fit the background image, scale-to-fit the video, overlay centered", () => {
    const parts = buildFitAndBackgroundFilter({
      aspectRatio: "9:16",
      background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
      imageInputIndex: 1,
      fps: 60,
    });
    expect(parts).toEqual([
      "[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=60[bgimg]",
      "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2[bgfitv]",
      "[bgimg][bgfitv]overlay=(W-w)/2:(H-h)/2,format=yuv420p[outv]",
    ]);
  });

  // Regression test for the HIGH finding: overlay's output inherits the MAIN
  // (first) framesync input's rate, and the still image is that main input —
  // without an explicit `fps=` on the [bgimg] chain the image2 demuxer's
  // default of 25fps silently overrides the real source rate. This asserts
  // the fps token is present regardless of the exact numeric value, so it
  // fails loudly if the filter is ever refactored to drop it again.
  test("image mode always pins the [bgimg] chain's fps, regardless of source rate", () => {
    for (const fps of [23.976, 24, 25, 29.97, 30, 50, 60]) {
      const parts = buildFitAndBackgroundFilter({
        aspectRatio: "9:16",
        background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
        videoInputLabel: "[0:v]",
        outputLabel: "[outv]",
        imageInputIndex: 1,
        fps,
      });
      expect(parts[0]).toContain(`,fps=${fps}[bgimg]`);
    }
  });

  test("image mode falls back to DEFAULT_BACKGROUND_FPS (30) when fps is omitted or non-positive", () => {
    const omitted = buildFitAndBackgroundFilter({
      aspectRatio: "9:16",
      background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
      imageInputIndex: 1,
    });
    expect(omitted[0]).toContain(",fps=30[bgimg]");

    const zero = buildFitAndBackgroundFilter({
      aspectRatio: "9:16",
      background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
      imageInputIndex: 1,
      fps: 0,
    });
    expect(zero[0]).toContain(",fps=30[bgimg]");
  });

  test("color mode never emits an fps token (overlay is never invoked)", () => {
    const parts = buildFitAndBackgroundFilter({
      aspectRatio: "9:16",
      background: { mode: "color", color: "#112233", imagePath: null },
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
      fps: 60,
    });
    expect(parts[0]).not.toContain("fps=");
  });

  test("image mode without a downloaded image (null imagePath) falls back to the color pad", () => {
    const parts = buildFitAndBackgroundFilter({
      aspectRatio: "9:16",
      background: { mode: "image", color: "#112233", imagePath: null },
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
      imageInputIndex: null,
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("pad=1080:1920");
    expect(parts[0]).toContain("color=0x112233");
  });

  test("trailingChain (text layers + captions) folds into the final part for both modes", () => {
    const color = buildFitAndBackgroundFilter({
      aspectRatio: "9:16",
      background: { mode: "color", color: "#112233", imagePath: null },
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
      trailingChain: "drawtext=text='hi',ass='/tmp/c.ass'",
    });
    expect(color[0]).toBe(
      "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2," +
        "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x112233,format=yuv420p," +
        "drawtext=text='hi',ass='/tmp/c.ass'[outv]",
    );

    const image = buildFitAndBackgroundFilter({
      aspectRatio: "9:16",
      background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
      videoInputLabel: "[0:v]",
      outputLabel: "[outv]",
      imageInputIndex: 1,
      trailingChain: "drawtext=text='hi'",
    });
    expect(image[2]).toBe(
      "[bgimg][bgfitv]overlay=(W-w)/2:(H-h)/2,format=yuv420p,drawtext=text='hi'[outv]",
    );
  });
});

describe("resolveBackgroundPlanForDownloadedImage (HIGH: non-decodable background image degrades to color)", () => {
  test("decodable: true keeps image mode and the downloaded path", () => {
    const plan = resolveBackgroundPlanForDownloadedImage({
      decodable: true,
      color: "#112233",
      imagePath: "/tmp/background-clip1.bin",
    });
    expect(plan).toEqual({
      mode: "image",
      color: "#112233",
      imagePath: "/tmp/background-clip1.bin",
    });
  });

  test("decodable: false (e.g. a 200-OK HTML page instead of an image) degrades to the color fallback", () => {
    const plan = resolveBackgroundPlanForDownloadedImage({
      decodable: false,
      color: "#112233",
      imagePath: "/tmp/background-clip1.bin",
    });
    expect(plan).toEqual({
      mode: "color",
      color: "#112233",
      imagePath: null,
    });
  });

  test("decodable: false still preserves the color (including the black default) rather than dropping it", () => {
    const plan = resolveBackgroundPlanForDownloadedImage({
      decodable: false,
      color: "#000000",
      imagePath: "/tmp/background-clip1.bin",
    });
    expect(plan.color).toBe("#000000");
    expect(plan.imagePath).toBeNull();
  });
});

describe("buildSingleVideoArgs with a canvas background active", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };

  test("color mode replaces crop+scale with fit+pad and adds no extra input", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      background: { mode: "color", color: "#112233", imagePath: null },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("pad=1080:1920");
    expect(graph).toContain("color=0x112233");
    expect(graph).not.toContain("crop=");
    expect(args.filter((a) => a === "-i")).toHaveLength(1); // source only
  });

  test("image mode adds the background image as its own -i before the logo input", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      logo: {
        filePath: "/tmp/logo.png",
        position: "bot-right",
        opacity: 80,
        scalePct: 15,
      },
      background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
    });
    const iIndexes = args
      .map((a, i) => (a === "-i" ? i : -1))
      .filter((i) => i >= 0);
    expect(iIndexes).toHaveLength(3); // source, background image, logo
    expect(args[iIndexes[0]! + 1]).toBe("/tmp/src.mp4");
    expect(args[iIndexes[1]! + 1]).toBe("/tmp/bg.png");
    expect(args[iIndexes[2]! + 1]).toBe("/tmp/logo.png");

    const graph = args[args.indexOf("-filter_complex") + 1]!;
    // fps=30 pinned from probe.fps (Opus review Finding 1 — overlay's output
    // otherwise inherits the still image's demuxer-default 25fps).
    expect(graph).toContain(
      "[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30[bgimg]",
    );
    // logo overlays [outvbase] (the composed fit+background frame) exactly
    // as it does for the crop-to-fill path — input index shifted to 2 since
    // the background image now occupies input 1.
    expect(graph).toContain("[outvbase][brandlogo]overlay=");
    expect(graph).toContain("[2:v]scale=");
  });

  test("pins the [bgimg] chain's fps to the probed source rate (not the default)", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe: { ...probe, fps: 59.94 },
      srtPath: null,
      background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain(",fps=59.94[bgimg]");
  });

  test("music input index shifts correctly when a background image input is present", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      logo: {
        filePath: "/tmp/logo.png",
        position: "bot-right",
        opacity: 80,
        scalePct: 15,
      },
      music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
      background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
    });
    const iIndexes = args
      .map((a, i) => (a === "-i" ? i : -1))
      .filter((i) => i >= 0);
    // 0=source, 1=background image, 2=logo, 3=music
    expect(iIndexes).toHaveLength(4);
    expect(args[iIndexes[1]! + 1]).toBe("/tmp/bg.png");
    expect(args[iIndexes[2]! + 1]).toBe("/tmp/logo.png");
    expect(args[iIndexes[3]! + 1]).toBe("/tmp/music.mp3");

    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[3:a]atrim=");
  });

  test("reframe is ignored (no crop@reframe) when a background is active", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      background: { mode: "color", color: "#112233", imagePath: null },
      reframe: { scriptPath: "/tmp/r.txt", cropName: "crop@reframe" },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("crop@reframe");
    expect(graph).not.toContain("sendcmd");
    expect(graph).toContain("pad=1080:1920");
  });

  test("without a background, the graph is unchanged (crop+scale, no extra input)", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("crop=");
    expect(graph).not.toContain("pad=");
    expect(args.filter((a) => a === "-i")).toHaveLength(1);
  });
});

describe("buildSingleVideoArgs with a split plan active (split packet B)", () => {
  const probe = { width: 640, height: 360, hasVideo: true, hasAudio: true, fps: 30 };

  test("replaces crop+scale with the segment-concat split filtergraph, reading [0:v] (uncut)", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      split: {
        segments: [
          { startSec: 0, endSec: 5, layout: "two-up", topCxNorm: 0.4, bottomCxNorm: 0.7 },
          { startSec: 5, endSec: 10, layout: "single", cxNorm: 0.5 },
        ],
      },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:v]split=2[split_seg0_src][split_seg1_src]");
    expect(graph).toContain(
      "trim=start=0.000:end=5.000,setpts=PTS-STARTPTS[split_seg0_t]",
    );
    expect(graph).toContain("vstack=inputs=2,format=yuv420p,setsar=1[split_seg0_out]");
    expect(graph).toContain(
      "trim=start=5.000:end=10.000,setpts=PTS-STARTPTS[split_seg1_t]",
    );
    expect(graph).toContain("[split_seg1_t]crop=");
    expect(graph).toContain("[split_seg0_out][split_seg1_out]concat=n=2:v=1:a=0");
    expect(graph).not.toMatch(/\[0:v\]crop=/); // the plain crop-and-scale fallback never runs
  });

  test("folds captions in as the concat's trailing chain, same [outv] contract", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: "/tmp/x.srt",
      split: { segments: [{ startSec: 0, endSec: 10, layout: "single", cxNorm: 0.5 }] },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("concat=n=1:v=1:a=0,format=yuv420p,subtitles=");
    expect(args).toContain("-map");
    expect(args[args.indexOf("-map") + 1]).toBe("[outv]");
  });

  test("applies AFTER cut-concat: reads [vcat], not [0:v], when the clip has real cuts", () => {
    const cutPlan = buildClipCutPlan([{ startSec: 3, endSec: 4 }], { startSec: 0, endSec: 10 });
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      cutPlan,
      split: { segments: [{ startSec: 0, endSec: 9, layout: "single", cxNorm: 0.5 }] },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[vcat]split=1[split_seg0_src]");
  });

  test("an empty split.segments array falls through to the plain crop-and-scale path", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      split: { segments: [] },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:v]crop=");
    expect(graph).not.toContain("split_seg");
  });

  test("background (fit mode) wins over split when both are somehow present", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      background: { mode: "color", color: "#112233", imagePath: null },
      split: { segments: [{ startSec: 0, endSec: 10, layout: "single", cxNorm: 0.5 }] },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("pad=1080:1920");
    expect(graph).not.toContain("split_seg");
  });

  test("byte-identical to before this feature: omitting `split` (or passing it as null/undefined) never changes the graph", () => {
    const baseParams = {
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16" as const,
      probe,
      srtPath: null,
    };
    const omitted = buildSingleVideoArgs(baseParams);
    const withNull = buildSingleVideoArgs({ ...baseParams, split: null });
    const withUndefined = buildSingleVideoArgs({ ...baseParams, split: undefined });
    expect(withNull).toEqual(omitted);
    expect(withUndefined).toEqual(omitted);
  });
});

describe("buildSingleVideoArgs with a screen layout active (screen packet B)", () => {
  const probe = { width: 640, height: 360, hasVideo: true, hasAudio: true, fps: 30 };

  test("replaces crop+scale with the top-fit/bottom-speaker screen filtergraph, reading [0:v] (uncut)", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      screen: { bottom: { cx: 0.5 } },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:v]split=2[screen_top_src][screen_bot_src]");
    expect(graph).toContain("pad=1080:960:(ow-iw)/2:(oh-ih)/2:color=black");
    expect(graph).toContain("[screen_bot_src]crop=");
    expect(graph).toContain("vstack=inputs=2,format=yuv420p,setsar=1[outv]");
    expect(graph).not.toMatch(/\[0:v\]crop=/); // the plain crop-and-scale fallback never runs
  });

  test("sendcmd-driven bottom tile (face detected) targets SCREEN_BOTTOM_CROP_NAME", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      screen: {
        bottom: {
          cx: 0.5,
          reframe: { scriptPath: "/tmp/screen-bottom.txt", cropName: SCREEN_BOTTOM_CROP_NAME },
        },
      },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("sendcmd=f='/tmp/screen-bottom.txt'");
    expect(graph).toContain(`${SCREEN_BOTTOM_CROP_NAME}=w=`);
  });

  test("static-center bottom tile (no face detected) has no sendcmd stage", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      screen: { bottom: { cx: 0.5 } },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("sendcmd");
  });

  test("folds captions in as the vstack's trailing chain, same [outv] contract", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: "/tmp/x.srt",
      screen: { bottom: { cx: 0.5 } },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("vstack=inputs=2,format=yuv420p,setsar=1,subtitles=");
    expect(args).toContain("-map");
    expect(args[args.indexOf("-map") + 1]).toBe("[outv]");
  });

  test("applies AFTER cut-concat: reads [vcat], not [0:v], when the clip has real cuts", () => {
    const cutPlan = buildClipCutPlan([{ startSec: 3, endSec: 4 }], { startSec: 0, endSec: 10 });
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      cutPlan,
      screen: { bottom: { cx: 0.5 } },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[vcat]split=2[screen_top_src][screen_bot_src]");
  });

  // M8 (adversarial review): the cut-plan/[vcat] input-label variant above
  // only ever exercised the `bottom.cx` (static-center) branch — this
  // covers the SAME `[vcat]` input-label swap but for the `bottom.pipRect`
  // branch specifically, since that branch reads its own crop straight off
  // `screen_bot_src` rather than through `cropXForCenter`/sendcmd and could
  // plausibly regress independently of the other two bottom-tile modes.
  test("pipRect bottom tile also reads [vcat] (not [0:v]) after cut-concat", () => {
    const cutPlan = buildClipCutPlan([{ startSec: 3, endSec: 4 }], { startSec: 0, endSec: 10 });
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      cutPlan,
      screen: { bottom: { cx: 0.5, pipRect: { x: 480, y: 40, w: 200, h: 180 } } },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[vcat]split=2[screen_top_src][screen_bot_src]");
    expect(graph).toContain("[screen_bot_src]crop=200:180:480:40");
    expect(graph).not.toContain("sendcmd");
  });

  test("background (fit mode) wins over screen when both are somehow present", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      background: { mode: "color", color: "#112233", imagePath: null },
      screen: { bottom: { cx: 0.5 } },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("pad=1080:1920"); // full-canvas fit pad, not the tile pad
    expect(graph).not.toContain("screen_top_src");
  });

  test("split wins over screen when both are somehow present (mutually exclusive in practice, but split is checked first)", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      split: { segments: [{ startSec: 0, endSec: 10, layout: "single", cxNorm: 0.5 }] },
      screen: { bottom: { cx: 0.5 } },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("split_seg");
    expect(graph).not.toContain("screen_top_src");
  });

  test("byte-identical to before this feature: omitting `screen` (or passing it as null/undefined) never changes the graph", () => {
    const baseParams = {
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16" as const,
      probe,
      srtPath: null,
    };
    const omitted = buildSingleVideoArgs(baseParams);
    const withNull = buildSingleVideoArgs({ ...baseParams, screen: null });
    const withUndefined = buildSingleVideoArgs({ ...baseParams, screen: undefined });
    expect(withNull).toEqual(omitted);
    expect(withUndefined).toEqual(omitted);
  });
});

// C1 (adversarial review) — SAR/pixel-format mismatch, real ffmpeg execution.
//
// Every other test in this file (and in two-up.test.ts) asserts on the
// GENERATED FILTER STRING, never runs it. That's exactly why C1 slipped
// through: a mixed two-up+single plan produces a `concat` whose inputs
// disagree on SAR (each branch type rounds its own crop rect differently
// before `scale`) — ffmpeg hard-rejects that with error -22 at RUN time, a
// failure mode no string-matching assertion can ever observe. This is the
// one test in the split-render suite that actually shells out to a real
// ffmpeg binary and checks the process's own exit code/output, specifically
// to catch this class of bug (and any regression that reintroduces it).
//
// Skipped cleanly (not failed) when ffmpeg isn't on PATH — probed once at
// module load via `ffmpeg -version` so every test in the block shares one
// probe instead of shelling out per test.
const FFMPEG_AVAILABLE = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const FFPROBE_AVAILABLE = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

describe("C1 ffmpeg smoke test — mixed two-up + single split plan actually renders", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "render-clips-c1-smoke-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test.skipIf(!FFMPEG_AVAILABLE || !FFPROBE_AVAILABLE)(
    "1920x1080 source, mixed two-up+single 9:16 plan: concat succeeds (exit 0), duration and resolution match",
    async () => {
      const sourcePath = join(tempDir, "source.mp4");
      const outputPath = join(tempDir, "output.mp4");

      // Synthetic 1920x1080 4s source — reviewer matrix's first failing case
      // (1920x1080 -> 9:16). `testsrc` (not a flat color) so a broken crop
      // geometry would also be visually obvious under manual inspection,
      // though this test only checks exit code + probed duration/resolution.
      const generate = spawnSync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=1920x1080:rate=25:duration=4",
        "-pix_fmt",
        "yuv420p",
        sourcePath,
      ]);
      expect(generate.status).toBe(0);

      // A MIXED plan — a "two-up" segment (0-2s) followed by a "single"
      // segment (2-4s) — is exactly the shape that hits the C1 mismatch:
      // buildTwoUpFilterChain's vstack output and buildSingleSegmentFilter's
      // scale output round their crop rects differently for the same 9:16
      // target, so without `setsar=1` on both, ffmpeg's `concat` between
      // segment 0's output and segment 1's output fails at run time.
      const segments: SplitLayoutSegment[] = [
        { startSec: 0, endSec: 2, layout: "two-up", topCxNorm: 0.35, bottomCxNorm: 0.7 },
        { startSec: 2, endSec: 4, layout: "single", cxNorm: 0.5 },
      ];

      const args = buildSingleVideoArgs({
        sourcePath,
        outputPath,
        startSec: 0,
        endSec: 4,
        aspectRatio: "9:16",
        probe: { width: 1920, height: 1080, hasVideo: true, hasAudio: false, fps: 25 },
        srtPath: null,
        split: { segments },
      });

      const render = spawnSync("ffmpeg", args, { encoding: "utf-8" });
      // The actual assertion this test exists for: before the C1 fix, this
      // fails with ffmpeg's SAR-mismatch error (concat: "Input link ...
      // parameters ... do not match"), exit code != 0. After the fix, the
      // mixed plan concatenates and encodes cleanly.
      expect(render.status).toBe(0);
      if (render.status !== 0) {
        // Surface ffmpeg's own stderr in the failure message — invaluable
        // when this regresses, since the default assertion above only shows
        // "1 !== null".
        throw new Error(`ffmpeg failed (status ${render.status}):\n${render.stderr}`);
      }

      const probe = spawnSync("ffprobe", [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-select_streams",
        "v:0",
        outputPath,
      ]);
      expect(probe.status).toBe(0);
      const probed = JSON.parse(probe.stdout.toString()) as {
        format?: { duration?: string };
        streams?: Array<{ width?: number; height?: number }>;
      };

      const duration = Number(probed.format?.duration);
      const stream = probed.streams?.[0];
      // Real, measured output values (recorded for the report — not just
      // "truthy"): the `-t 4.000` bound on `buildSingleVideoArgs`'s own
      // output caps duration at/just under 4s; resolution is the 9:16
      // target (1080x1920) regardless of which segment type produced it.
      expect(duration).toBeGreaterThan(3.5);
      expect(duration).toBeLessThanOrEqual(4.05);
      expect(stream?.width).toBe(1080);
      expect(stream?.height).toBe(1920);
    },
    30_000,
  );
});

describe("export treatment: resolution + watermark (vizard-parity Phase C export options)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };
  const SCALE_FRAGMENT = "scale=trunc(iw*2/3/2)*2:trunc(ih*2/3/2)*2";
  const WATERMARK_FRAGMENT = "drawtext=text=Made with Narriflow";

  /** The `;`-delimited filter-graph section whose output pad is `label`
   *  (e.g. "[outvfree]") — lets assertions check what feeds a given stage
   *  without depending on the drawtext option list's exact contents. */
  function stageEndingIn(graph: string, label: string): string {
    const stage = graph.split(";").find((section) => section.endsWith(label));
    if (!stage) throw new Error(`no filter-graph stage ends in ${label}`);
    return stage;
  }

  /** Every `-map` target that isn't an audio pad (`[outaN]`/`[outa]`) —
   *  robust to `-map` calls interleaving video and audio per output. */
  function videoMapTargets(args: string[]): string[] {
    return indexesOf(args, "-map")
      .map((i) => args[i + 1]!)
      .filter((label) => !label.startsWith("[outa"));
  }

  describe("buildSingleVideoArgs", () => {
    test("720p row adds the 2/3 downscale, 1080p row doesn't", () => {
      const at720p = buildSingleVideoArgs({
        sourcePath: "/tmp/src.mp4",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 10,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
        resolution: "720p",
      });
      const at1080p = buildSingleVideoArgs({
        sourcePath: "/tmp/src.mp4",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 10,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
        resolution: "1080p",
      });
      const graph720 = at720p[at720p.indexOf("-filter_complex") + 1]!;
      const graph1080 = at1080p[at1080p.indexOf("-filter_complex") + 1]!;
      expect(graph720).toContain(SCALE_FRAGMENT);
      expect(graph720).toContain("[outvfree]");
      expect(at720p).toContain("[outvfree]"); // mapped as the final output
      expect(graph1080).not.toContain(SCALE_FRAGMENT);
      expect(graph1080).not.toContain("[outvfree]");
    });

    test("omitting resolution behaves like 1080p (no downscale)", () => {
      const args = buildSingleVideoArgs({
        sourcePath: "/tmp/src.mp4",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 10,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).not.toContain(SCALE_FRAGMENT);
      expect(graph).not.toContain("drawtext=");
    });

    test("watermark is present iff entitlement is absent, independent of resolution", () => {
      const noWatermark1080 = buildSingleVideoArgs({
        sourcePath: "/tmp/src.mp4",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 10,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
        resolution: "1080p",
        watermark: false,
      });
      const watermarked1080 = buildSingleVideoArgs({
        sourcePath: "/tmp/src.mp4",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 10,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
        resolution: "1080p",
        watermark: true,
      });
      const graphNoWatermark = noWatermark1080[
        noWatermark1080.indexOf("-filter_complex") + 1
      ]!;
      const graphWatermarked = watermarked1080[
        watermarked1080.indexOf("-filter_complex") + 1
      ]!;
      expect(graphNoWatermark).not.toContain("drawtext=");
      // A paid user on 1080p still gets no watermark and no downscale.
      expect(graphNoWatermark).not.toContain(SCALE_FRAGMENT);
      expect(graphWatermarked).toContain(WATERMARK_FRAGMENT);
      // Watermark alone (1080p) never triggers the 720p downscale.
      expect(graphWatermarked).not.toContain(SCALE_FRAGMENT);
    });

    test("720p + watermark combine into a single trailing filter stage", () => {
      const args = buildSingleVideoArgs({
        sourcePath: "/tmp/src.mp4",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 10,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
        resolution: "720p",
        watermark: true,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      // Exactly one [outvfree] stage carries both fragments, comma-joined —
      // scale before drawtext (a filter chain is order-dependent: drawtext
      // computing font size off `h` must see the already-downscaled frame).
      const stage = graph
        .split(";")
        .find((section) => section.endsWith("[outvfree]"))!;
      expect(stage).toContain(`${SCALE_FRAGMENT},${WATERMARK_FRAGMENT}`);
      expect(args).toContain("[outvfree]");
    });

    test("combined with a canvas background and a fade transition, the map target is still [outvfree]", () => {
      const studioEdits = studioEditsSchema.parse({
        transition: { type: "fade", durationSec: 0.4 },
      });
      const args = buildSingleVideoArgs({
        sourcePath: "/tmp/src.mp4",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 10,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
        background: { mode: "color", color: "#112233", imagePath: null },
        studioEdits,
        resolution: "720p",
        watermark: true,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).toContain("pad=1080:1920"); // background still applied
      expect(graph).toContain("fade=t=in"); // transition still applied
      const stage = stageEndingIn(graph, "[outvfree]");
      expect(stage).toContain(SCALE_FRAGMENT);
      expect(stage).toContain(WATERMARK_FRAGMENT);
      expect(args[args.indexOf("-map") + 1]).toBe("[outvfree]");
    });
  });

  describe("buildBrollVideoArgs", () => {
    test("composes the automatic speaker layout before B-roll cutaways", () => {
      const args = buildBrollVideoArgs({
        sourcePath: "/tmp/src.mp4",
        cutaways: [{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } }],
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 10,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
        split: {
          segments: [
            {
              startSec: 0,
              endSec: 10,
              layout: "two-up",
              topCxNorm: 0.3,
              bottomCxNorm: 0.7,
            },
          ],
        },
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).toContain("vstack=inputs=2");
      expect(graph).toContain("[stage0][broll0]overlay=0:0:enable='between(t,2,5)'[stage1]");
      expect(graph.indexOf("vstack=inputs=2")).toBeLessThan(graph.indexOf("overlay=0:0"));
    });

    test("720p + watermark fold in after the b-roll overlay chain", () => {
      const args = buildBrollVideoArgs({
        sourcePath: "/tmp/src.mp4",
        cutaways: [{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } }],
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 20,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
        resolution: "720p",
        watermark: true,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).toContain("overlay=0:0:enable='between(t,2,5)'");
      const stage = stageEndingIn(graph, "[outvfree]");
      expect(stage).toContain(SCALE_FRAGMENT);
      expect(stage).toContain(WATERMARK_FRAGMENT);
      expect(args[args.indexOf("-map") + 1]).toBe("[outvfree]");
    });

    test("neither flag set: no [outvfree] stage, maps the plain composited output", () => {
      const args = buildBrollVideoArgs({
        sourcePath: "/tmp/src.mp4",
        cutaways: [{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } }],
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 20,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).not.toContain("[outvfree]");
      // No logo/watermark stage renames the label, so the map target is
      // whatever the single overlay stage produced ("[stage1]" here — b-roll
      // has no logo in this fixture, so the composed frame is never renamed
      // to "[outv]" the way buildSingleVideoArgs's plain path is).
      const mapTarget = args[args.indexOf("-map") + 1]!;
      expect(mapTarget).toBe("[stage1]");
      expect(graph).toContain(`overlay=0:0:enable='between(t,2,5)'${mapTarget}`);
    });
  });

  describe("buildMultiVideoArgs", () => {
    test("per-output resolution is independent; watermark is uniform across outputs", () => {
      const args = buildMultiVideoArgs({
        sourcePath: "/tmp/src.mp4",
        outputs: [
          {
            clipRenderId: "r0",
            clipId: "c0",
            clipIndex: 0,
            aspectRatio: "9:16",
            outputPath: "/tmp/out0.mp4",
            storageKey: "k0",
            resolution: "720p",
          },
          {
            clipRenderId: "r1",
            clipId: "c0",
            clipIndex: 0,
            aspectRatio: "1:1",
            outputPath: "/tmp/out1.mp4",
            storageKey: "k1",
            resolution: "1080p",
          },
        ],
        startSec: 0,
        endSec: 10,
        probe,
        srtPath: null,
        watermark: true,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      const stage0 = graph
        .split(";")
        .find((section) => section.endsWith("[outvfree0]"))!;
      const stage1 = graph
        .split(";")
        .find((section) => section.endsWith("[outvfree1]"))!;
      expect(stage0).toContain(`${SCALE_FRAGMENT},${WATERMARK_FRAGMENT}`);
      // output 1 is 1080p: watermark only, no downscale.
      expect(stage1).not.toContain(SCALE_FRAGMENT);
      expect(stage1).toContain(WATERMARK_FRAGMENT);

      expect(videoMapTargets(args)).toEqual(["[outvfree0]", "[outvfree1]"]);
    });

    test("no watermark and both outputs at 1080p: no [outvfree] stages at all", () => {
      const args = buildMultiVideoArgs({
        sourcePath: "/tmp/src.mp4",
        outputs: [
          {
            clipRenderId: "r0",
            clipId: "c0",
            clipIndex: 0,
            aspectRatio: "9:16",
            outputPath: "/tmp/out0.mp4",
            storageKey: "k0",
            resolution: "1080p",
          },
          {
            clipRenderId: "r1",
            clipId: "c0",
            clipIndex: 0,
            aspectRatio: "1:1",
            outputPath: "/tmp/out1.mp4",
            storageKey: "k1",
            resolution: "1080p",
          },
        ],
        startSec: 0,
        endSec: 10,
        probe,
        srtPath: null,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).not.toContain("[outvfree");
      expect(videoMapTargets(args)).toEqual(["[outv0]", "[outv1]"]);
    });
  });

  describe("buildAudiogramArgs", () => {
    test("720p + watermark fold in after the waveform/caption chain", () => {
      const args = buildAudiogramArgs({
        sourcePath: "/tmp/a.mp3",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 10,
        aspectRatio: "9:16",
        clipDurationSec: 10,
        srtPath: null,
        resolution: "720p",
        watermark: true,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).toContain("showwaves=");
      const stage = stageEndingIn(graph, "[outvfree]");
      expect(stage).toContain(SCALE_FRAGMENT);
      expect(stage).toContain(WATERMARK_FRAGMENT);
      expect(args[args.indexOf("-map") + 1]).toBe("[outvfree]");
    });

    test("neither flag set: no [outvfree] stage, maps the plain output", () => {
      const args = buildAudiogramArgs({
        sourcePath: "/tmp/a.mp3",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 10,
        aspectRatio: "9:16",
        clipDurationSec: 10,
        srtPath: null,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).not.toContain("[outvfree]");
      expect(args[args.indexOf("-map") + 1]).toBe("[outv]");
    });
  });
});

describe("buildBrollVideoArgs with a canvas background active", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };

  test("cutaway input indices shift by 1 when a background image occupies input 1", () => {
    const args = buildBrollVideoArgs({
      sourcePath: "/tmp/src.mp4",
      cutaways: [{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } }],
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
    });
    const iIndexes = args
      .map((a, i) => (a === "-i" ? i : -1))
      .filter((i) => i >= 0);
    expect(iIndexes).toHaveLength(3); // source, background image, b-roll
    expect(args[iIndexes[1]! + 1]).toBe("/tmp/bg.png");
    expect(args[iIndexes[2]! + 1]).toBe("/tmp/broll.mp4");

    const graph = args[args.indexOf("-filter_complex") + 1]!;
    // [stage0] is the composed fit+background frame; the cutaway (now input
    // [2]) overlays on top of it exactly as it would over a crop-to-fill base.
    expect(graph).toContain("[bgimg][bgfitv]overlay=(W-w)/2:(H-h)/2,format=yuv420p[stage0]");
    expect(graph).toContain("[2:v]scale=1080:1920:force_original_aspect_ratio=increase");
    // fps pinned from probe.fps on the [bgimg] chain specifically.
    expect(graph).toContain(",fps=30[bgimg]");
  });

  test("music input index [N:a] shifts correctly with a background image AND cutaways present", () => {
    const args = buildBrollVideoArgs({
      sourcePath: "/tmp/src.mp4",
      cutaways: [
        { path: "/tmp/broll-0.mp4", window: { startSec: 2, endSec: 5 } },
        { path: "/tmp/broll-1.mp4", window: { startSec: 8, endSec: 11 } },
      ],
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      background: { mode: "image", color: "#112233", imagePath: "/tmp/bg.png" },
      logo: {
        filePath: "/tmp/logo.png",
        position: "top-right",
        opacity: 100,
        scalePct: 12,
      },
      music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
    });
    const iIndexes = args
      .map((a, i) => (a === "-i" ? i : -1))
      .filter((i) => i >= 0);
    // 0=source, 1=background image, 2-3=b-roll, 4=logo, 5=music
    expect(iIndexes).toHaveLength(6);
    expect(args[iIndexes[1]! + 1]).toBe("/tmp/bg.png");
    expect(args[iIndexes[2]! + 1]).toBe("/tmp/broll-0.mp4");
    expect(args[iIndexes[3]! + 1]).toBe("/tmp/broll-1.mp4");
    expect(args[iIndexes[4]! + 1]).toBe("/tmp/logo.png");
    expect(args[iIndexes[5]! + 1]).toBe("/tmp/music.mp3");

    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[5:a]atrim=");
  });

  test("reframe is ignored (no crop@reframe) when a background is active", () => {
    const args = buildBrollVideoArgs({
      sourcePath: "/tmp/src.mp4",
      cutaways: [{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } }],
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      background: { mode: "color", color: "#112233", imagePath: null },
      reframe: { scriptPath: "/tmp/r.txt", cropName: "crop@reframe" },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("crop@reframe");
    expect(graph).not.toContain("sendcmd");
    expect(graph).toContain("pad=1080:1920");
  });
});

describe("buildBrollVideoArgs (B-roll cutaway)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };

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

describe("resolveClipLogoOverlay (per-clip logo override merge — vizard-parity Phase A step 6)", () => {
  const baseLogo = {
    filePath: "/tmp/logo.png",
    position: "bot-right" as const,
    opacity: 80,
    scalePct: 15,
  };

  test("null base (no logo asset at all) always yields null, regardless of overrides", () => {
    expect(
      resolveClipLogoOverlay(null, {
        enabled: true,
        position: "top-left",
        opacity: 50,
        scalePct: 25,
      }),
    ).toBeNull();
  });

  test("no override object (legacy studioEdits) inherits the base/snapshot fully", () => {
    expect(resolveClipLogoOverlay(baseLogo, undefined)).toEqual(baseLogo);
  });

  test("all-null override fields (the schema default) inherit the base/snapshot values", () => {
    const overrides = studioEditsSchema.parse({}).logo;
    expect(resolveClipLogoOverlay(baseLogo, overrides)).toEqual(baseLogo);
  });

  test("non-null override fields (position/opacity/scale) win over the base", () => {
    const overrides = studioEditsSchema.parse({
      logo: { enabled: true, position: "top-left", opacity: 50, scalePct: 25 },
    }).logo;
    expect(resolveClipLogoOverlay(baseLogo, overrides)).toEqual({
      filePath: "/tmp/logo.png",
      position: "top-left",
      opacity: 50,
      scalePct: 25,
    });
  });

  test("enabled: false yields null (no overlay at all) even with other overrides set", () => {
    const overrides = studioEditsSchema.parse({
      logo: { enabled: false, position: "top-left", opacity: 50, scalePct: 25 },
    }).logo;
    expect(resolveClipLogoOverlay(baseLogo, overrides)).toBeNull();
  });
});

describe("buildSingleVideoArgs logo filter graph (override parity with the studio preview)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };
  // 9:16 target width is 1080 (see buildCropAndScaleFilter's "scale=1080:1920").
  const baseLogo = {
    filePath: "/tmp/logo.png",
    position: "bot-right" as const,
    opacity: 80,
    scalePct: 15,
  };

  test("burns in the overridden position/opacity/scale", () => {
    const overrides = studioEditsSchema.parse({
      logo: { enabled: true, position: "top-left", opacity: 50, scalePct: 25 },
    }).logo;
    const logo = resolveClipLogoOverlay(baseLogo, overrides);

    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      logo,
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("scale=270:-1"); // 25% of 1080
    expect(graph).toContain("colorchannelmixer=aa=0.500");
    expect(graph).toContain("overlay=24:24"); // top-left: x=y=LOGO_MARGIN_PX
    expect(args.filter((a) => a === "-i")).toHaveLength(2); // source + logo
  });

  test("null override fields inherit the snapshot's bot-right/80%/15% defaults", () => {
    const overrides = studioEditsSchema.parse({}).logo; // all-null override
    const logo = resolveClipLogoOverlay(baseLogo, overrides);

    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      logo,
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("scale=162:-1"); // 15% of 1080
    expect(graph).toContain("colorchannelmixer=aa=0.800");
    expect(graph).toContain("overlay=W-w-24:H-h-24"); // bot-right
  });

  test("enabled: false skips the logo filter entirely (no colorchannelmixer, no extra -i)", () => {
    const overrides = studioEditsSchema.parse({
      logo: { enabled: false, position: null, opacity: null, scalePct: null },
    }).logo;
    const logo = resolveClipLogoOverlay(baseLogo, overrides);
    expect(logo).toBeNull();

    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      logo,
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("colorchannelmixer");
    expect(args.filter((a) => a === "-i")).toHaveLength(1); // source only
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

describe("subtitle visibility toggle (vizard-parity Phase C) — captionPreset.visible === false gates every render path", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };
  const captionPresetVisible = getCaptionPresetById("karaoke")!.preset;
  const captionPresetHidden = { ...captionPresetVisible, visible: false };

  test("buildSingleVideoArgs: visible=true burns the ASS filter, visible=false omits it entirely", () => {
    const shown = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: "/tmp/clip.ass",
      captionPreset: captionPresetVisible,
    });
    expect(shown[shown.indexOf("-filter_complex") + 1]).toContain("ass=");

    const hidden = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: "/tmp/clip.ass",
      captionPreset: captionPresetHidden,
    });
    expect(hidden[hidden.indexOf("-filter_complex") + 1]).not.toContain("ass=");
  });

  test("buildBrollVideoArgs: visible=false omits the ASS filter but keeps the cutaway overlay", () => {
    const hidden = buildBrollVideoArgs({
      sourcePath: "/tmp/src.mp4",
      cutaways: [{ path: "/tmp/broll.mp4", window: { startSec: 1, endSec: 3 } }],
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: "/tmp/clip.ass",
      captionPreset: captionPresetHidden,
    });
    const graph = hidden[hidden.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("ass=");
    expect(graph).toContain("overlay=0:0:enable=");
  });

  test("buildAudiogramArgs: visible=false omits the ASS filter but keeps the waveform", () => {
    const hidden = buildAudiogramArgs({
      sourcePath: "/tmp/a.mp3",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 30,
      aspectRatio: "9:16",
      clipDurationSec: 30,
      srtPath: "/tmp/clip.ass",
      captionPreset: captionPresetHidden,
    });
    const graph = hidden[hidden.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("ass=");
    expect(graph).toContain("showwaves");
  });

  test("buildMultiVideoArgs: visible=false omits the ASS filter for every output", () => {
    const hidden = buildMultiVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputs: [
        { clipRenderId: "r1", clipId: "c1", clipIndex: 0, aspectRatio: "9:16", outputPath: "/tmp/out-916.mp4", storageKey: "k1", subtitlePath: "/tmp/clip-916.ass" },
        { clipRenderId: "r2", clipId: "c1", clipIndex: 0, aspectRatio: "16:9", outputPath: "/tmp/out-169.mp4", storageKey: "k2", subtitlePath: "/tmp/clip-169.ass" },
      ],
      startSec: 0,
      endSec: 10,
      probe,
      srtPath: null,
      captionPreset: captionPresetHidden,
    });
    const graph = hidden[hidden.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("ass=");
  });
});

function indexesOf(args: string[], value: string): number[] {
  const result: number[] = [];
  args.forEach((arg, index) => {
    if (arg === value) result.push(index);
  });
  return result;
}

// General assertion helper (multi-model review fix #1): ffmpeg does NOT fan
// a named filter pad out to multiple consumers implicitly — only `[0:a]`/
// `[0:v]` style raw input-stream refs get that behavior. Feeding a pad like
// `[acat]` into two filters without an explicit `asplit`/`split` silently
// rebinds the second consumer to the raw uncut input, which is exactly how
// the audiogram double-consumption bug leaked deleted audio into exports.
// This counts how many times `label` appears as a LEADING (input) pad
// reference across every filter spec in a `-filter_complex` graph — output
// pad references (which always trail the filter's own text) are excluded by
// construction, since the leading-bracket-run regex stops at the first
// non-bracket character.
function countLabelConsumptions(graph: string, label: string): number {
  const specs = graph.split(";");
  let count = 0;
  for (const spec of specs) {
    const leadingRun = spec.match(/^(\[[^\]]+\])+/);
    if (!leadingRun) continue;
    const leadingLabels = leadingRun[0].match(/\[[^\]]+\]/g) ?? [];
    count += leadingLabels.filter((candidate) => candidate === label).length;
  }
  return count;
}

/** Asserts `label` (e.g. `"[acat]"`) is consumed as a filter input EXACTLY
 *  once across the whole graph — the general form of the fix #1 regression
 *  check, reusable for any builder's cut-concat output labels. */
function expectLabelConsumedOnce(graph: string, label: string) {
  expect(countLabelConsumptions(graph, label)).toBe(1);
}

describe("output duration bound (FIX: over-long B-roll/inputs can no longer stretch the output)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };

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
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };

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

describe("SFX one-shot mixing (vizard-parity.md Music/SFX library)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };

  test("adelay ms rounding: startSec=1.2345 rounds to 1235ms, all=1 delays every channel", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      sfx: [{ path: "/tmp/sfx.mp3", startSec: 1.2345, volume: 80 }],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("adelay=1235:all=1");
  });

  test("volume mapping: 0-100 scale maps to a 0-1 volume= fragment", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      sfx: [{ path: "/tmp/sfx.mp3", startSec: 0, volume: 42 }],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("adelay=0:all=1,volume=0.420");
  });

  test("truncates the SFX branch at the clip's own end via atrim=duration", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 15,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      sfx: [{ path: "/tmp/sfx.mp3", startSec: 10, volume: 80 }],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain(
      "adelay=10000:all=1,volume=0.800,apad,atrim=duration=15.000",
    );
  });

  test("SFX with no music: dialogue + one SFX branch mix at inputs=2", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      sfx: [{ path: "/tmp/sfx.mp3", startSec: 2, volume: 80 }],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:a]");
    expect(graph).toContain("[1:a]adelay=2000");
    expect(graph).toContain("[maina][sfx0a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0");
    // Mixed audio (music or sfx) always maps -shortest, same as the music path.
    expect(args).toContain("-shortest");
  });

  test("SFX with music: dialogue + music + SFX mix at inputs=3, music branch still gets its own volume/fade", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      music: { path: "/tmp/music.mp3", volume: 30, startOffsetSec: 0 },
      sfx: [{ path: "/tmp/sfx.mp3", startSec: 2, volume: 80 }],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    // music is input 1, sfx is input 2 (source=0, no bg/logo).
    expect(graph).toContain("[1:a]atrim=start=0.000");
    expect(graph).toContain("[2:a]adelay=2000");
    expect(graph).toContain(
      "[maina][musica][sfx0a]amix=inputs=3:duration=first:dropout_transition=0:normalize=0",
    );
  });

  test("SFX with muted source audio: dialogue branch still participates in the mix at volume=0", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      studioEdits: studioEditsSchema.parse({ sourceAudio: { volume: 100, muted: true } }),
      sfx: [{ path: "/tmp/sfx.mp3", startSec: 1, volume: 80 }],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:a]atrim=duration=10.000,asetpts=PTS-STARTPTS,volume=0.000[maina]");
    expect(graph).toContain("amix=inputs=2");
  });

  test("SFX with absent source audio: mix contains only the SFX branch(es), no dialogue, and the SFX branch still fills the full clip duration", () => {
    const noAudioProbe = { ...probe, hasAudio: false };
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe: noAudioProbe,
      srtPath: null,
      sfx: [{ path: "/tmp/sfx.mp3", startSec: 1, volume: 80 }],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    // Single branch (no dialogue, no music): no amix at all, just the SFX
    // branch feeding straight into the fixed click-guard fade chain.
    expect(graph).not.toContain("amix=");
    expect(graph).toContain("[sfx0a]afade=t=in");
    expect(args).toContain("-shortest");
    // H1 fix: `apad` before `atrim=duration=10.000` guarantees the SOLE
    // branch driving `-shortest` is exactly the clip's own duration, not
    // whatever's left of a short SFX file after `adelay` — without `apad`,
    // this branch (and the whole encode via `-shortest`) truncated to
    // ~1s + the SFX file's own length instead of the full 10s clip.
    expect(graph).toContain("volume=0.800,apad,atrim=duration=10.000");
  });

  test("every SFX branch pads with apad before its atrim=duration bound (H1: atrim alone is a max, not a pad)", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      sfx: [
        { path: "/tmp/sfx-a.mp3", startSec: 1, volume: 80 },
        { path: "/tmp/sfx-b.mp3", startSec: 3, volume: 50 },
      ],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    const sfxBranches = graph
      .split(";")
      .filter((part) => /^\[\d+:a\]adelay=/.test(part));
    expect(sfxBranches.length).toBe(2);
    for (const branch of sfxBranches) {
      expect(branch).toMatch(/,apad,atrim=duration=\d+\.\d{3}/);
    }
  });

  test("skip-beyond-duration: a placement whose startSec >= clipDurationSec is dropped from the mix", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      sfx: [
        { path: "/tmp/sfx-early.mp3", startSec: 2, volume: 80 },
        { path: "/tmp/sfx-late.mp3", startSec: 10, volume: 80 }, // >= clip duration
      ],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    // Both inputs still get pushed (harmless unused input for the dropped
    // one — see buildAudioMixFilter's doc comment), but only the first is
    // referenced in the mix.
    expect(graph).toContain("[sfx0a]");
    expect(graph).not.toContain("[sfx1a]");
    expect(graph).toContain("amix=inputs=2"); // dialogue + the one surviving sfx branch
  });

  test("input index bookkeeping: background image + logo + music + 2 SFX placements all coexist", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      logo: { filePath: "/tmp/logo.png", position: "top-right", opacity: 100, scalePct: 12 },
      background: { mode: "image", color: "#000000", imagePath: "/tmp/bg.png" },
      music: { path: "/tmp/music.mp3", volume: 30, startOffsetSec: 0 },
      sfx: [
        { path: "/tmp/sfx-a.mp3", startSec: 1, volume: 80 },
        { path: "/tmp/sfx-b.mp3", startSec: 3, volume: 80 },
      ],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    // 0=source, 1=bg image, 2=logo, 3=music, 4-5=sfx.
    expect(graph).toContain("[3:a]atrim=start=0.000");
    expect(graph).toContain("[4:a]adelay=1000");
    expect(graph).toContain("[5:a]adelay=3000");
    expect(graph).toContain("amix=inputs=4");
  });
});

describe("buildBrollVideoArgs SFX input index bookkeeping", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };

  test("SFX input indexes continue after music, following the existing cutaway/logo/music order", () => {
    const args = buildBrollVideoArgs({
      sourcePath: "/tmp/src.mp4",
      cutaways: [{ path: "/tmp/broll-0.mp4", window: { startSec: 3, endSec: 6 } }],
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      logo: { filePath: "/tmp/logo.png", position: "top-right", opacity: 100, scalePct: 12 },
      music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
      sfx: [{ path: "/tmp/sfx.mp3", startSec: 1, volume: 80 }],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    // 0=source, 1=broll cutaway, 2=logo, 3=music, 4=sfx.
    expect(graph).toContain("[3:a]atrim=start=0.000");
    expect(graph).toContain("[4:a]adelay=1000");
    expect(graph).toContain("amix=inputs=3"); // dialogue + music + sfx
  });

  test("SFX-only (no music) still uses the correct base index after cutaways/logo", () => {
    const args = buildBrollVideoArgs({
      sourcePath: "/tmp/src.mp4",
      cutaways: [{ path: "/tmp/broll-0.mp4", window: { startSec: 3, endSec: 6 } }],
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      logo: { filePath: "/tmp/logo.png", position: "top-right", opacity: 100, scalePct: 12 },
      sfx: [{ path: "/tmp/sfx.mp3", startSec: 1, volume: 80 }],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    // 0=source, 1=broll cutaway, 2=logo, 3=sfx (no music consumes a slot).
    expect(graph).toContain("[3:a]adelay=1000");
    expect(graph).toContain("amix=inputs=2"); // dialogue + sfx
  });
});

describe("buildAudiogramArgs music + SFX + ducking", () => {
  test("SFX-only (no music): waveform still reads dialogue, output mixes dialogue+sfx", () => {
    const args = buildAudiogramArgs({
      sourcePath: "/tmp/src.mp3",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      clipDurationSec: 10,
      srtPath: null,
      sfx: [{ path: "/tmp/sfx.mp3", startSec: 2, volume: 80 }],
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    // Waveform reads straight off [0:a] (no music/no cut => no explicit split).
    expect(graph).toContain("[0:a]showwaves");
    // SFX is input 1 (music absent), mixed with dialogue into [outa].
    expect(graph).toContain("[1:a]adelay=2000");
    expect(graph).toContain("amix=inputs=2");
  });

  test("music + ducking: the music branch carries a volume=<expr>:eval=frame stage after its fade suffix", () => {
    const utterances = [makeUtterance([["hello", 1, 1.5], ["world", 1.5, 2]])];
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe: { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 },
      srtPath: null,
      music: {
        path: "/tmp/music.mp3",
        volume: 40,
        startOffsetSec: 0,
        duckingWindows: computeSpeechWindows(
          utterances[0]!.words.map((w) => ({ startSec: w.startSec, endSec: w.endSec })),
          10,
        ),
      },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("volume=0.400");
    expect(graph).toMatch(/volume='if\(between\(t,/);
    expect(graph).toContain("':eval=frame");
  });

  test("music without ducking (duckingWindows omitted): no volume=<expr> automation stage, byte-identical to before", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe: { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 },
      srtPath: null,
      music: { path: "/tmp/music.mp3", volume: 40, startOffsetSec: 0 },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("eval=frame");
  });

  test("music with ducking but an empty transcript (duckingWindows: []): no-op, filter omitted", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe: { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 },
      srtPath: null,
      music: { path: "/tmp/music.mp3", volume: 40, startOffsetSec: 0, duckingWindows: [] },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("eval=frame");
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
    ).rejects.toMatchObject({
      code: "broll_download_failed",
      disposition: "permanent",
    });
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
    ).rejects.toMatchObject({
      code: "music_download_failed",
      disposition: "permanent",
    });
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
    ).rejects.toMatchObject({
      code: "broll_download_failed",
      disposition: "permanent",
    });
  });

  test("keeps a server-side HTTP failure retryable", async () => {
    await expect(
      downloadUrlToFile(
        "https://cdn.example/unavailable.mp4",
        filePath,
        "broll_download_failed",
        {
          resolver: publicResolver,
          fetchImpl: async () => new Response(null, { status: 503 }),
        },
      ),
    ).rejects.toMatchObject({
      code: "broll_download_failed",
      disposition: "retryable",
    });
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
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };
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
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };

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

describe("source audio gain/mute + music fades (vizard-parity Phase A step 5)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };

  test("unity source volume (100, unmuted) skips the gain filter entirely — unchanged filter graph", () => {
    const studioEdits = studioEditsSchema.parse({});
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 30,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      studioEdits,
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:a:0]afade=t=in:st=0:d=0.040");
    expect(graph).not.toContain("volume=");
  });

  test("sub-100 source volume applies a volume= gain before the fade chain (buildSingleVideoArgs, no music)", () => {
    const studioEdits = studioEditsSchema.parse({
      sourceAudio: { volume: 60, muted: false },
    });
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 30,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      studioEdits,
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:a:0]volume=0.600,afade=t=in:st=0:d=0.040");
  });

  test("muted source audio produces volume=0.000 (silent track, graph shape unchanged) — buildBrollVideoArgs, no music", () => {
    const studioEdits = studioEditsSchema.parse({
      sourceAudio: { volume: 100, muted: true },
    });
    const args = buildBrollVideoArgs({
      sourcePath: "/tmp/src.mp4",
      cutaways: [{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } }],
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      studioEdits,
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:a:0]volume=0.000,afade=t=in:st=0:d=0.040");
    expect(args).toContain("[outa]");
    expect(args).not.toContain("-an");
  });

  test("muted source audio applies volume=0 on the dialogue branch before amix when music is also present", () => {
    const studioEdits = studioEditsSchema.parse({
      sourceAudio: { volume: 100, muted: true },
    });
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      studioEdits,
      music: { path: "/tmp/music.mp3", volume: 40, startOffsetSec: 0 },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain(
      "[0:a]atrim=duration=20.000,asetpts=PTS-STARTPTS,volume=0.000[maina]",
    );
    // music branch is unaffected by the dialogue mute — still at its own volume
    expect(graph).toContain("volume=0.400");
    expect(graph).toContain(
      "amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
    );
  });

  test("music fadeInSec/fadeOutSec apply afade on the music branch at the right times, additive to the fixed click-guard on the final mix", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 20,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      music: {
        path: "/tmp/music.mp3",
        volume: 40,
        startOffsetSec: 0,
        fadeInSec: 2,
        fadeOutSec: 3,
      },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;

    // user fade-in/out land on the music branch itself, before [musica]...
    expect(graph).toContain(
      "volume=0.400,afade=t=in:st=0:d=2.000,afade=t=out:st=17.000:d=3.000[musica]",
    );
    // ...and the fixed 40ms/120ms click-guard still runs on the final mixed
    // track, unchanged and in addition to the user's own fades.
    expect(graph).toContain(
      "amix=inputs=2:duration=first:dropout_transition=0:normalize=0,afade=t=in:st=0:d=0.040,afade=t=out:st=19.880:d=0.120[outa]",
    );
  });

  test("music fadeInSec/fadeOutSec clamp to the clip duration when longer than the clip", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 3,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      music: {
        path: "/tmp/music.mp3",
        volume: 35,
        startOffsetSec: 0,
        fadeInSec: 5,
        fadeOutSec: 5,
      },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    // Both fades clamp to the 3s clip duration (5s each requested), and
    // since clamped fadeIn + clamped fadeOut (3+3=6s) still exceeds the 3s
    // duration, resolveMusicFadeWindows scales both down proportionally
    // (0.5x) so fade-in ends before fade-out begins, rather than the two
    // fully overlapping over the same seconds.
    expect(graph).toContain("afade=t=in:st=0:d=1.500");
    expect(graph).toContain("afade=t=out:st=1.500:d=1.500");
  });

  test("music fadeInSec/fadeOutSec overlap case: 4s fade-in + 4s fade-out on a 4s clip scale down to 2s+2s windows", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/src.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 4,
      aspectRatio: "9:16",
      probe,
      srtPath: null,
      music: {
        path: "/tmp/music.mp3",
        volume: 35,
        startOffsetSec: 0,
        fadeInSec: 4,
        fadeOutSec: 4,
      },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("afade=t=in:st=0:d=2.000");
    expect(graph).toContain("afade=t=out:st=2.000:d=2.000");
  });

  test("no-source-audio + music fades: music-only clip still gets the user fades plus the fixed click-guard, no amix", () => {
    const args = buildSingleVideoArgs({
      sourcePath: "/tmp/silent-source.mp4",
      outputPath: "/tmp/out.mp4",
      startSec: 0,
      endSec: 10,
      aspectRatio: "9:16",
      probe: { width: 1920, height: 1080, hasVideo: true, hasAudio: false, fps: 30 },
      srtPath: null,
      music: {
        path: "/tmp/music.mp3",
        volume: 50,
        startOffsetSec: 0,
        fadeInSec: 1,
        fadeOutSec: 1,
      },
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("afade=t=in:st=0:d=1.000,afade=t=out:st=9.000:d=1.000[musica]");
    expect(graph).toContain("[musica]afade=t=in:st=0:d=0.040,afade=t=out:st=9.880:d=0.120[outa]");
    expect(graph).not.toContain("amix");
    expect(args).toContain("[outa]");
  });
});

describe("clipRenderAttemptStorageKey", () => {
  test("is attempt-unique: two encode attempts for the same clip+aspect never collide", () => {
    const first = clipRenderAttemptStorageKey("proj-1", "clip-1", "9x16", "attempt-a");
    const second = clipRenderAttemptStorageKey("proj-1", "clip-1", "9x16", "attempt-b");
    expect(first).not.toBe(second);
  });

  test("stays scoped under the clip's own renders prefix", () => {
    const key = clipRenderAttemptStorageKey("proj-1", "clip-1", "9x16", "attempt-a");
    expect(key.startsWith("projects/proj-1/renders/clip-1/")).toBe(true);
    expect(key.endsWith(".mp4")).toBe(true);
  });

  test("is deterministic for the same inputs (pure function, no hidden randomness)", () => {
    const a = clipRenderAttemptStorageKey("proj-1", "clip-1", "9x16", "attempt-a");
    const b = clipRenderAttemptStorageKey("proj-1", "clip-1", "9x16", "attempt-a");
    expect(a).toBe(b);
  });
});

describe("cut-concat rendering (vizard-parity Phase B step 7 — deletedRanges)", () => {
  const probe = { width: 1920, height: 1080, hasVideo: true, hasAudio: true, fps: 30 };
  // 30s clip window, one mid-clip deletion [10,15) -> two kept segments
  // [0,10) and [15,30), 25s edited duration.
  const window = { startSec: 0, endSec: 30 };
  const cutPlan = buildClipCutPlan([{ startSec: 10, endSec: 15 }], window);

  test("buildClipCutPlan sanity for the fixture used below", () => {
    expect(cutPlan.isUncut).toBe(false);
    expect(cutPlan.isEmpty).toBe(false);
    expect(cutPlan.editedDurationSec).toBe(25);
    expect(cutPlan.segments).toEqual([
      { sourceStartSec: 0, sourceEndSec: 10, editedStartSec: 0 },
      { sourceStartSec: 15, sourceEndSec: 30, editedStartSec: 10 },
    ]);
  });

  describe("buildSingleVideoArgs", () => {
    test("no deletions: passing an explicit uncut cutPlan is byte-identical to omitting cutPlan entirely", () => {
      const uncutPlan = buildClipCutPlan([], window);
      const base = {
        sourcePath: "/tmp/src.mp4",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 30,
        aspectRatio: "9:16" as const,
        probe,
        srtPath: null,
      };
      const withPlan = buildSingleVideoArgs({ ...base, cutPlan: uncutPlan });
      const withoutPlan = buildSingleVideoArgs(base);
      expect(withPlan).toEqual(withoutPlan);
    });

    test("two kept segments: emits per-segment trim/atrim + setpts/asetpts, then concat, before crop/scale", () => {
      const args = buildSingleVideoArgs({
        sourcePath: "/tmp/src.mp4",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 30,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
        cutPlan,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;

      expect(graph).toContain(
        "[0:v]trim=start=0.000:end=10.000,setpts=PTS-STARTPTS[vseg0]",
      );
      expect(graph).toContain(
        "[0:a:0]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS[aseg0]",
      );
      expect(graph).toContain(
        "[0:v]trim=start=15.000:end=30.000,setpts=PTS-STARTPTS[vseg1]",
      );
      expect(graph).toContain(
        "[0:a:0]atrim=start=15.000:end=30.000,asetpts=PTS-STARTPTS[aseg1]",
      );
      expect(graph).toContain(
        "[vseg0][aseg0][vseg1][aseg1]concat=n=2:v=1:a=1[vcat][acat]",
      );
      // Downstream crop/scale reads the concatenated video, not the raw input.
      expect(graph).toContain("[vcat]crop=");
      // Dialogue fade reads the concatenated audio.
      expect(graph).toContain("[acat]afade=t=in:st=0:d=0.040");
      // Concat filters land before the crop stage in the graph.
      expect(graph.indexOf("concat=n=2")).toBeLessThan(graph.indexOf("[vcat]crop="));
      // Fix #1 regression check: every cut-concat output label is consumed
      // as a filter input exactly once (no implicit fan-out).
      expectLabelConsumedOnce(graph, "[vcat]");
      expectLabelConsumedOnce(graph, "[acat]");

      // Output duration bound uses the edited (25s) duration, not the raw
      // 30s clip window.
      const tIndexes = indexesOf(args, "-t");
      const outputTIndex = tIndexes[tIndexes.length - 1]!;
      expect(args[outputTIndex + 1]).toBe("25.000");
      // The input-level -t is unchanged: still reads the whole [0,30) window
      // as one input (cut-concat trims it downstream, not at the demuxer).
      expect(args[tIndexes[0]! + 1]).toBe("30");
    });

    test("music duration uses the edited (post-cut) duration, not the raw clip window", () => {
      const args = buildSingleVideoArgs({
        sourcePath: "/tmp/src.mp4",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 30,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
        music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
        cutPlan,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).toContain("atrim=start=0.000:duration=25.000");
      // dialogue branch reads the concatenated audio, not [0:a]
      expect(graph).toContain("[acat]atrim=duration=25.000,asetpts=PTS-STARTPTS[maina]");
      // buildSingleVideoArgs' [acat] feeds ONLY the dialogue branch here (the
      // video path reads [vcat] separately) — still worth pinning as a
      // regression check alongside the audiogram fix.
      expectLabelConsumedOnce(graph, "[acat]");
      expectLabelConsumedOnce(graph, "[vcat]");
    });

    test("single kept segment (deletion at the very start) skips concat and uses acopy for audio, copy for video", () => {
      const startOnlyPlan = buildClipCutPlan([{ startSec: 0, endSec: 5 }], window);
      expect(startOnlyPlan.segments).toHaveLength(1);
      const args = buildSingleVideoArgs({
        sourcePath: "/tmp/src.mp4",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 30,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
        cutPlan: startOnlyPlan,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).toContain(
        "[0:v]trim=start=5.000:end=30.000,setpts=PTS-STARTPTS[vseg0]",
      );
      expect(graph).toContain("[vseg0]copy[vcat]");
      expect(graph).toContain(
        "[0:a:0]atrim=start=5.000:end=30.000,asetpts=PTS-STARTPTS[aseg0]",
      );
      expect(graph).toContain("[aseg0]acopy[acat]");
      expect(graph).not.toContain("concat=");
    });

    test("all-deleted guard: throws instead of building args for an empty cut plan", () => {
      const emptyPlan = buildClipCutPlan([{ startSec: 0, endSec: 30 }], window);
      expect(emptyPlan.isEmpty).toBe(true);
      expect(() =>
        buildSingleVideoArgs({
          sourcePath: "/tmp/src.mp4",
          outputPath: "/tmp/out.mp4",
          startSec: 0,
          endSec: 30,
          aspectRatio: "9:16",
          probe,
          srtPath: null,
          cutPlan: emptyPlan,
        }),
      ).toThrow();
    });
  });

  describe("buildBrollVideoArgs", () => {
    test("cut-concat runs before the b-roll overlay chain", () => {
      const args = buildBrollVideoArgs({
        sourcePath: "/tmp/src.mp4",
        cutaways: [{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } }],
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 30,
        aspectRatio: "9:16",
        probe,
        srtPath: null,
        cutPlan,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).toContain(
        "[vseg0][aseg0][vseg1][aseg1]concat=n=2:v=1:a=1[vcat][acat]",
      );
      expect(graph).toContain("[vcat]crop=");
      expect(graph).toContain("[acat]afade=t=in:st=0:d=0.040");
      expectLabelConsumedOnce(graph, "[vcat]");
      expectLabelConsumedOnce(graph, "[acat]");

      const tIndexes = indexesOf(args, "-t");
      // last -t is the output bound (belt-and-suspenders) -> edited duration
      const outputTIndex = tIndexes[tIndexes.length - 1]!;
      expect(args[outputTIndex + 1]).toBe("25.000");
    });

    test("all-deleted guard: throws for an empty cut plan even with a valid cutaway", () => {
      const emptyPlan = buildClipCutPlan([{ startSec: 0, endSec: 30 }], window);
      expect(() =>
        buildBrollVideoArgs({
          sourcePath: "/tmp/src.mp4",
          cutaways: [{ path: "/tmp/broll.mp4", window: { startSec: 2, endSec: 5 } }],
          outputPath: "/tmp/out.mp4",
          startSec: 0,
          endSec: 30,
          aspectRatio: "9:16",
          probe,
          srtPath: null,
          cutPlan: emptyPlan,
        }),
      ).toThrow();
    });
  });

  describe("buildAudiogramArgs", () => {
    test("cut-concat is audio-only (no video stream to trim/concat)", () => {
      const args = buildAudiogramArgs({
        sourcePath: "/tmp/a.mp3",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 30,
        aspectRatio: "9:16",
        clipDurationSec: cutPlan.editedDurationSec,
        srtPath: null,
        cutPlan,
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).toContain(
        "[0:a]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS[aseg0]",
      );
      expect(graph).toContain(
        "[0:a]atrim=start=15.000:end=30.000,asetpts=PTS-STARTPTS[aseg1]",
      );
      expect(graph).toContain("[aseg0][aseg1]concat=n=2:v=0:a=1[acat]");
      expect(graph).not.toContain("vseg");
      expect(graph).toContain("[acat]asplit=2[wavesrc][fadesrc]");
      expectLabelConsumedOnce(graph, "[acat]");

      const shortestIdx = args.indexOf("-shortest");
      expect(args[shortestIdx + 2]).toBe("25.000");
    });

    test("FIX #1 regression: with music AND a cut, [acat] is split (not double-consumed) so the exported dialogue never silently rebinds to raw uncut [0:a]", () => {
      const args = buildAudiogramArgs({
        sourcePath: "/tmp/a.mp3",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 30,
        aspectRatio: "9:16",
        clipDurationSec: cutPlan.editedDurationSec,
        srtPath: null,
        cutPlan,
        music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
      });
      const graph = args[args.indexOf("-filter_complex") + 1]!;

      // The cut-concat stage still produces [acat] from the two kept segments.
      expect(graph).toContain("[aseg0][aseg1]concat=n=2:v=0:a=1[acat]");
      // [acat] is explicitly split before being fanned to showwaves + the
      // dialogue/music mix — this is the actual fix.
      expect(graph).toContain("[acat]asplit=2[wavesrc][dlgsrc]");
      expect(graph).toContain(
        "[wavesrc]showwaves=s=1080x806:mode=cline:colors=0x00FF88:rate=25[wave]",
      );
      // The music mix's dialogue branch reads the SPLIT pad, not [acat]
      // directly and not raw [0:a] — this is what stops deleted audio from
      // leaking back in.
      expect(graph).toContain(
        "[dlgsrc]atrim=duration=25.000,asetpts=PTS-STARTPTS[maina]",
      );
      expect(graph).not.toContain("[0:a]atrim=duration=25.000");

      // General regression check: every emitted pad this graph produces is
      // consumed as a filter input exactly once (nothing is dropped or
      // double-fed).
      expectLabelConsumedOnce(graph, "[acat]");
      expectLabelConsumedOnce(graph, "[wavesrc]");
      expectLabelConsumedOnce(graph, "[dlgsrc]");
    });

    test("no cut, music present: [0:a] is read directly by both showwaves and the dialogue mix (raw input streams DO fan out implicitly) — byte-identical to before the fix", () => {
      const uncutPlan = buildClipCutPlan([], window);
      const args = buildAudiogramArgs({
        sourcePath: "/tmp/a.mp3",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 30,
        aspectRatio: "9:16",
        clipDurationSec: 30,
        srtPath: null,
        cutPlan: uncutPlan,
        music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
      });
      const withoutPlanArgs = buildAudiogramArgs({
        sourcePath: "/tmp/a.mp3",
        outputPath: "/tmp/out.mp4",
        startSec: 0,
        endSec: 30,
        aspectRatio: "9:16",
        clipDurationSec: 30,
        srtPath: null,
        music: { path: "/tmp/music.mp3", volume: 50, startOffsetSec: 0 },
      });
      expect(args).toEqual(withoutPlanArgs);
      const graph = args[args.indexOf("-filter_complex") + 1]!;
      expect(graph).not.toContain("asplit");
      expect(graph).toContain("[0:a]showwaves=");
      expect(graph).toContain("[0:a]atrim=duration=30.000");
    });

    test("all-deleted guard: throws for an empty cut plan", () => {
      const emptyPlan = buildClipCutPlan([{ startSec: 0, endSec: 30 }], window);
      expect(() =>
        buildAudiogramArgs({
          sourcePath: "/tmp/a.mp3",
          outputPath: "/tmp/out.mp4",
          startSec: 0,
          endSec: 30,
          aspectRatio: "9:16",
          clipDurationSec: 0,
          srtPath: null,
          cutPlan: emptyPlan,
        }),
      ).toThrow();
    });
  });

  describe("caption cue retiming across a cut", () => {
    const utterance = makeUtterance([
      ["before", 4, 5],
      ["gone", 11, 12], // fully inside the deleted [10,15) range
      ["after", 20, 21],
    ]);

    test("generateSrtFromSlice drops the fully-deleted word and shifts the later word left onto the edited timeline", () => {
      const srt = generateSrtFromSlice([utterance], 0, undefined, cutPlan.map);
      expect(srt).toContain("before after");
      expect(srt).not.toContain("gone");
      // toEdited(4) = 4 (first kept segment, untouched); toEdited(21) =
      // editedStart(10) + (21 - 15) = 16.
      expect(srt).toContain("00:00:04,000 --> 00:00:16,000");
    });

    test("generateAssFromSlice drops the fully-deleted word and retimes the survivors", () => {
      const ass = generateAssFromSlice(
        [utterance],
        0,
        "9:16",
        preset("karaoke"),
        cutPlan.map,
      );
      // 2 surviving words -> 2 word-active events (the deleted word emits none).
      expect(countDialogues(ass)).toBe(2);
      expect(ass).not.toContain("gone");
      // "before" active window starts at toEdited(4)=4.00s -> centiseconds 4:00.
      expect(ass).toContain("0:00:04.00");
      // "after" active window starts at toEdited(20) = 10 + (20-15) = 15.00s.
      expect(ass).toContain("0:00:15.00");
    });

    test("without a timeMap, behavior is unchanged (byte-identical to pre-cut-concat output)", () => {
      const withoutMap = generateSrtFromSlice([utterance], 0);
      expect(withoutMap).toContain("gone");
      expect(withoutMap).toContain("before gone after");
    });
  });
});

describe("remapSceneCutsForCutPlan (layout-engine wiring)", () => {
  test("uncut plan: normalizes (sort + ms dedupe) but keeps values clip-relative", () => {
    const plan = buildClipCutPlan([], { startSec: 100, endSec: 160 });
    expect(remapSceneCutsForCutPlan([12.0004, 5, 12.0001], plan, 100)).toEqual([
      5, 12,
    ]);
  });

  test("cut plan: drops cuts inside deleted ranges, remaps the rest, and adds kept-segment joins", () => {
    // Window 100..160, delete 120..130: edited timeline is 0..50 with a
    // join at edited 20.
    const plan = buildClipCutPlan([{ startSec: 120, endSec: 130 }], {
      startSec: 100,
      endSec: 160,
    });
    const out = remapSceneCutsForCutPlan([10, 25, 40], plan, 100);
    // 10 -> edited 10; 25 (inside the cut) dropped; 40 -> edited 30; the
    // concat join at edited 20 is itself a scene cut.
    expect(out).toEqual([10, 20, 30]);
  });
});
