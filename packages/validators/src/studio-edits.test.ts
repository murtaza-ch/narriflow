import { describe, expect, test } from "bun:test";

import {
  applyStudioEditsPatchSchema,
  applyStudioEditsToAllSchema,
  capDuckingWindows,
  computeSpeechWindows,
  DUCKING_DEFAULTS,
  duckingGainMultiplierAt,
  extractSpeechWordIntervals,
  MAX_DUCKING_WINDOWS,
  MUSIC_BLOCK_MIN_DURATION_SEC,
  STUDIO_EDIT_LIMITS,
  resolveEffectiveFramingMode,
  resolveMusicFadeWindows,
  studioEditsEqual,
  studioEditsSchema,
  studioMusicBlockSchema,
  studioMusicSchema,
  studioTransitionSchema,
  studioSfxPlacementSchema,
  withCaptionEmojis,
  type DuckingWindow,
} from "./studio-edits";
import type { TranscriptUtterance } from "./transcript";

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

describe("studioEditsSchema (source audio + music fades)", () => {
  test("accepts the complete canonical clip-transition vocabulary", () => {
    const types = [
      "none",
      "fade",
      "fade-black",
      "dip-white",
      "wipe-left",
      "wipe-right",
      "wipe-up",
      "wipe-down",
      "slide-left",
      "slide-right",
      "slide-up",
      "slide-down",
      "zoom-in",
      "zoom-out",
    ] as const;

    for (const type of types) {
      expect(studioTransitionSchema.parse({ type, durationSec: 0.4 })).toEqual({
        type,
        durationSec: 0.4,
      });
    }
    expect(() =>
      studioTransitionSchema.parse({ type: "spin", durationSec: 0.4 }),
    ).toThrow();
  });

  test("parse({}) defaults sourceAudio to unmuted 100 and an empty music lane", () => {
    const parsed = studioEditsSchema.parse({});
    expect(parsed.sourceAudio).toEqual({ volume: 100, muted: false });
    expect(parsed.music).toEqual({ blocks: [], ducking: false });
    expect(parsed.logo).toEqual({
      enabled: true,
      position: null,
      opacity: null,
      scalePct: null,
    });
  });

  test("parse(undefined) applies the same defaults as parse({})", () => {
    const parsed = studioEditsSchema.parse(undefined);
    expect(parsed.sourceAudio).toEqual({ volume: 100, muted: false });
    expect(parsed.music).toEqual({ blocks: [], ducking: false });
    expect(parsed.logo).toEqual({
      enabled: true,
      position: null,
      opacity: null,
      scalePct: null,
    });
  });


  test("parse({}) defaults background to off/null/null", () => {
    const parsed = studioEditsSchema.parse({});
    expect(parsed.background).toEqual({
      mode: "off",
      color: null,
      imageUrl: null,
    });
  });


  test("accepts explicit color/image background values", () => {
    const color = studioEditsSchema.parse({
      background: { mode: "color", color: "#112233", imageUrl: null },
    });
    expect(color.background).toEqual({
      mode: "color",
      color: "#112233",
      imageUrl: null,
    });

    const image = studioEditsSchema.parse({
      background: {
        mode: "image",
        color: null,
        imageUrl: "https://cdn.example/bg.png",
      },
    });
    expect(image.background).toEqual({
      mode: "image",
      color: null,
      imageUrl: "https://cdn.example/bg.png",
    });
  });

  test("rejects an invalid mode, malformed hex color, and malformed image URL", () => {
    expect(() =>
      studioEditsSchema.parse({ background: { mode: "solid" } }),
    ).toThrow();
    expect(() =>
      studioEditsSchema.parse({
        background: { mode: "color", color: "112233" },
      }),
    ).toThrow();
    expect(() =>
      studioEditsSchema.parse({
        background: { mode: "color", color: "#12345" },
      }),
    ).toThrow();
    expect(() =>
      studioEditsSchema.parse({
        background: { mode: "image", imageUrl: "not-a-url" },
      }),
    ).toThrow();
  });

  test("rejects non-http(s) image URL schemes", () => {
    expect(() =>
      studioEditsSchema.parse({
        background: { mode: "image", imageUrl: "file:///etc/passwd" },
      }),
    ).toThrow();
    expect(() =>
      studioEditsSchema.parse({
        background: { mode: "image", imageUrl: "ftp://cdn.example/bg.png" },
      }),
    ).toThrow();
    expect(() =>
      studioEditsSchema.parse({
        background: { mode: "image", imageUrl: "javascript:alert(1)" },
      }),
    ).toThrow();

    const https = studioEditsSchema.parse({
      background: { mode: "image", imageUrl: "https://cdn.example/bg.png" },
    });
    expect(https.background.imageUrl).toBe("https://cdn.example/bg.png");

    const http = studioEditsSchema.parse({
      background: { mode: "image", imageUrl: "http://cdn.example/bg.png" },
    });
    expect(http.background.imageUrl).toBe("http://cdn.example/bg.png");
  });

  test("accepts explicit logo overrides within range and rejects out-of-range ones", () => {
    const parsed = studioEditsSchema.parse({
      logo: { enabled: false, position: "top-left", opacity: 50, scalePct: 25 },
    });
    expect(parsed.logo).toEqual({
      enabled: false,
      position: "top-left",
      opacity: 50,
      scalePct: 25,
    });

    expect(() =>
      studioEditsSchema.parse({ logo: { opacity: 9 } }),
    ).toThrow();
    expect(() =>
      studioEditsSchema.parse({ logo: { scalePct: 41 } }),
    ).toThrow();
    expect(() =>
      studioEditsSchema.parse({ logo: { position: "not-a-position" } }),
    ).toThrow();
  });

  test("accepts explicit sourceAudio and music block fade values within range", () => {
    const parsed = studioEditsSchema.parse({
      sourceAudio: { volume: 60, muted: true },
      music: {
        blocks: [
          {
            id: "m1",
            url: "https://cdn.example/track.mp3",
            startSec: 0,
            volume: 50,
            fadeInSec: 2,
            fadeOutSec: 3,
          },
        ],
      },
    });

    expect(parsed.sourceAudio).toEqual({ volume: 60, muted: true });
    expect(parsed.music.blocks[0]).toMatchObject({
      volume: 50,
      fadeInSec: 2,
      fadeOutSec: 3,
      endSec: null,
      sourceStartSec: 0,
    });
  });

  test("rejects non-http(s) music URL schemes", () => {
    expect(() =>
      studioEditsSchema.parse({
        music: { blocks: [{ id: "m1", url: "file:///tmp/track.mp3", startSec: 0 }] },
      }),
    ).toThrow();
    expect(() =>
      studioEditsSchema.parse({
        music: { blocks: [{ id: "m1", url: "ftp://example.com/track.mp3", startSec: 0 }] },
      }),
    ).toThrow();
  });

  test("an old single-bed music object parses to an empty lane (no legacy reader)", () => {
    const parsed = studioEditsSchema.parse({
      music: { url: "https://cdn.example/track.mp3", volume: 40, ducking: true },
    });
    expect(parsed.music).toEqual({ blocks: [], ducking: true });
  });

  test("rejects out-of-range sourceAudio volume and music fade values", () => {
    expect(() =>
      studioEditsSchema.parse({ sourceAudio: { volume: 101, muted: false } }),
    ).toThrow();
    expect(() =>
      studioEditsSchema.parse({
        music: {
          blocks: [{ id: "m1", url: "https://cdn.example/a.mp3", startSec: 0, fadeInSec: 6 }],
        },
      }),
    ).toThrow();
  });

  test("parse({}) defaults framing to auto", () => {
    const parsed = studioEditsSchema.parse({});
    expect(parsed.framing).toEqual({ mode: "auto" });
  });


  test("accepts an explicit center framing mode", () => {
    const parsed = studioEditsSchema.parse({ framing: { mode: "center" } });
    expect(parsed.framing).toEqual({ mode: "center" });
  });

  test("accepts an explicit split framing mode", () => {
    const parsed = studioEditsSchema.parse({ framing: { mode: "split" } });
    expect(parsed.framing).toEqual({ mode: "split" });
  });


  test("accepts an explicit screen framing mode", () => {
    const parsed = studioEditsSchema.parse({ framing: { mode: "screen" } });
    expect(parsed.framing).toEqual({ mode: "screen" });
  });


  test("rejects an invalid framing mode (fit is not a framing value)", () => {
    expect(() =>
      studioEditsSchema.parse({ framing: { mode: "fit" } }),
    ).toThrow();
    expect(() =>
      studioEditsSchema.parse({ framing: { mode: "off" } }),
    ).toThrow();
  });
});

describe("resolveEffectiveFramingMode (Phase C-2 stage 1 — background/framing fold)", () => {
  test("defaults to auto when background is off and framing is unset", () => {
    const parsed = studioEditsSchema.parse({});
    expect(resolveEffectiveFramingMode(parsed)).toBe("auto");
  });

  test("resolves to center when background is off and framing.mode is center", () => {
    const parsed = studioEditsSchema.parse({ framing: { mode: "center" } });
    expect(resolveEffectiveFramingMode(parsed)).toBe("center");
  });

  test("resolves to split when background is off and framing.mode is split", () => {
    const parsed = studioEditsSchema.parse({ framing: { mode: "split" } });
    expect(resolveEffectiveFramingMode(parsed)).toBe("split");
  });

  test("resolves to screen when background is off and framing.mode is screen", () => {
    const parsed = studioEditsSchema.parse({ framing: { mode: "screen" } });
    expect(resolveEffectiveFramingMode(parsed)).toBe("screen");
  });

  test("background active always resolves to fit, regardless of framing.mode", () => {
    const withAuto = studioEditsSchema.parse({
      background: { mode: "color", color: "#112233", imageUrl: null },
      framing: { mode: "auto" },
    });
    expect(resolveEffectiveFramingMode(withAuto)).toBe("fit");

    const withCenter = studioEditsSchema.parse({
      background: { mode: "color", color: "#112233", imageUrl: null },
      framing: { mode: "center" },
    });
    expect(resolveEffectiveFramingMode(withCenter)).toBe("fit");

    const withImage = studioEditsSchema.parse({
      background: { mode: "image", color: null, imageUrl: "https://cdn.example/bg.png" },
      framing: { mode: "center" },
    });
    expect(resolveEffectiveFramingMode(withImage)).toBe("fit");

    const withSplit = studioEditsSchema.parse({
      background: { mode: "color", color: "#112233", imageUrl: null },
      framing: { mode: "split" },
    });
    expect(resolveEffectiveFramingMode(withSplit)).toBe("fit");

    const withScreen = studioEditsSchema.parse({
      background: { mode: "color", color: "#112233", imageUrl: null },
      framing: { mode: "screen" },
    });
    expect(resolveEffectiveFramingMode(withScreen)).toBe("fit");
  });
});

describe("resolveMusicFadeWindows", () => {
  test("passes through when fades fit the clip", () => {
    expect(resolveMusicFadeWindows(1, 2, 30)).toEqual({
      fadeInSec: 1,
      fadeOutSec: 2,
      fadeOutStartSec: 28,
    });
  });

  test("clamps a single oversized fade to the clip duration", () => {
    const windows = resolveMusicFadeWindows(5, 0, 3);
    expect(windows.fadeInSec).toBe(3);
    expect(windows.fadeOutSec).toBe(0);
    expect(windows.fadeOutStartSec).toBe(3);
  });

  test("scales overlapping fades proportionally so windows never overlap", () => {
    const windows = resolveMusicFadeWindows(4, 4, 4);
    expect(windows.fadeInSec).toBe(2);
    expect(windows.fadeOutSec).toBe(2);
    expect(windows.fadeOutStartSec).toBe(2);
    expect(windows.fadeInSec + windows.fadeOutSec).toBeLessThanOrEqual(4);
  });

  test("handles zero-duration clips without dividing by zero", () => {
    expect(resolveMusicFadeWindows(2, 2, 0)).toEqual({
      fadeInSec: 0,
      fadeOutSec: 0,
      fadeOutStartSec: 0,
    });
  });
});

describe("applyStudioEditsPatchSchema (vizard-parity Phase C — apply-to-all)", () => {
  test("accepts a transition-only patch", () => {
    const parsed = applyStudioEditsPatchSchema.parse({
      transition: { type: "fade-black", durationSec: 0.5 },
    });
    expect(parsed.transition).toEqual({ type: "fade-black", durationSec: 0.5 });
    expect(parsed.background).toBeUndefined();
  });

  test("accepts a background-only patch", () => {
    const parsed = applyStudioEditsPatchSchema.parse({
      background: { mode: "color", color: "#112233", imageUrl: null },
    });
    expect(parsed.background).toEqual({
      mode: "color",
      color: "#112233",
      imageUrl: null,
    });
    expect(parsed.transition).toBeUndefined();
    expect(parsed.framing).toBeUndefined();
  });

  test("accepts a framing-only patch", () => {
    const parsed = applyStudioEditsPatchSchema.parse({
      framing: { mode: "center" },
    });
    expect(parsed.framing).toEqual({ mode: "center" });
    expect(parsed.transition).toBeUndefined();
    expect(parsed.background).toBeUndefined();
  });

  test("accepts a split framing patch", () => {
    const parsed = applyStudioEditsPatchSchema.parse({
      framing: { mode: "split" },
    });
    expect(parsed.framing).toEqual({ mode: "split" });
    expect(parsed.transition).toBeUndefined();
    expect(parsed.background).toBeUndefined();
  });

  test("accepts a screen framing patch", () => {
    const parsed = applyStudioEditsPatchSchema.parse({
      framing: { mode: "screen" },
    });
    expect(parsed.framing).toEqual({ mode: "screen" });
    expect(parsed.transition).toBeUndefined();
    expect(parsed.background).toBeUndefined();
  });

  test("rejects a patch with two fields", () => {
    expect(() =>
      applyStudioEditsPatchSchema.parse({
        transition: { type: "fade", durationSec: 0.4 },
        background: { mode: "off", color: null, imageUrl: null },
      }),
    ).toThrow();
    expect(() =>
      applyStudioEditsPatchSchema.parse({
        background: { mode: "off", color: null, imageUrl: null },
        framing: { mode: "center" },
      }),
    ).toThrow();
  });

  test("rejects a patch with all three fields", () => {
    expect(() =>
      applyStudioEditsPatchSchema.parse({
        transition: { type: "fade", durationSec: 0.4 },
        background: { mode: "off", color: null, imageUrl: null },
        framing: { mode: "center" },
      }),
    ).toThrow();
  });

  test("rejects an empty patch", () => {
    expect(() => applyStudioEditsPatchSchema.parse({})).toThrow();
  });

  test("rejects an unknown field (strict)", () => {
    expect(() =>
      applyStudioEditsPatchSchema.parse({
        music: { blocks: [], ducking: false },
      }),
    ).toThrow();
  });
});

const MUSIC_ASSET_ID = "3f3e3d3c-3b3a-4939-8837-363534333231";

function block(
  id: string,
  startSec: number,
  endSec: number | null,
  extra: Record<string, unknown> = {},
) {
  return { id, url: "https://cdn.example/track.mp3", startSec, endSec, ...extra };
}

describe("studioMusicSchema (Music Blocks) + studioSfxPlacementSchema (Music/SFX library)", () => {
  test("parse({}) defaults music to no blocks and ducking off, and sfx to []", () => {
    const parsed = studioEditsSchema.parse({});
    expect(parsed.music.blocks).toEqual([]);
    expect(parsed.music.ducking).toBe(false);
    expect(parsed.sfx).toEqual([]);
  });

  test("a block defaults its title, in-point, volume and fades", () => {
    const parsed = studioMusicBlockSchema.parse({
      id: "m1",
      assetId: MUSIC_ASSET_ID,
      startSec: 1,
    });
    expect(parsed).toEqual({
      id: "m1",
      assetId: MUSIC_ASSET_ID,
      url: null,
      title: null,
      startSec: 1,
      endSec: null,
      sourceStartSec: 0,
      volume: 35,
      fadeInSec: 0,
      fadeOutSec: 0,
    });
  });

  test("accepts blocks in order plus clip-wide ducking", () => {
    const parsed = studioEditsSchema.parse({
      music: {
        blocks: [block("a", 0, 5, { assetId: MUSIC_ASSET_ID }), block("b", 5, null)],
        ducking: true,
      },
    });
    expect(parsed.music.blocks).toHaveLength(2);
    expect(parsed.music.blocks[0]!.assetId).toBe(MUSIC_ASSET_ID);
    expect(parsed.music.ducking).toBe(true);
  });

  test("rejects a malformed block assetId", () => {
    expect(() =>
      studioEditsSchema.parse({
        music: { blocks: [{ id: "a", assetId: "not-a-uuid", startSec: 0 }] },
      }),
    ).toThrow();
  });

  test("a block needs an assetId or a url", () => {
    expect(() => studioMusicBlockSchema.parse({ id: "a", startSec: 0 })).toThrow();
    expect(
      studioMusicBlockSchema.safeParse({ id: "a", url: null, assetId: null, startSec: 0 })
        .success,
    ).toBe(false);
  });

  test("endSec must be greater than startSec", () => {
    expect(() => studioMusicBlockSchema.parse(block("a", 5, 5))).toThrow();
    expect(() => studioMusicBlockSchema.parse(block("a", 5, 4))).toThrow();
    expect(studioMusicBlockSchema.parse(block("a", 5, 5.5)).endSec).toBe(5.5);
  });

  test("rejects negative or non-finite times and out-of-range volume", () => {
    expect(() => studioMusicBlockSchema.parse(block("a", -1, null))).toThrow();
    expect(() =>
      studioMusicBlockSchema.parse(block("a", 0, null, { sourceStartSec: -1 })),
    ).toThrow();
    expect(() =>
      studioMusicBlockSchema.parse(block("a", Number.POSITIVE_INFINITY, null)),
    ).toThrow();
    expect(() =>
      studioMusicBlockSchema.parse(block("a", 0, null, { volume: 101 })),
    ).toThrow();
  });

  test("blocks must be in timeline order and cannot overlap", () => {
    expect(() =>
      studioMusicSchema.parse({ blocks: [block("a", 5, 8), block("b", 0, 3)] }),
    ).toThrow();
    expect(() =>
      studioMusicSchema.parse({ blocks: [block("a", 0, 6), block("b", 5, 8)] }),
    ).toThrow();
    // Touching blocks are fine.
    expect(
      studioMusicSchema.parse({ blocks: [block("a", 0, 5), block("b", 5, 8)] }).blocks,
    ).toHaveLength(2);
  });

  test("only the last block may have a null endSec", () => {
    expect(() =>
      studioMusicSchema.parse({ blocks: [block("a", 0, null), block("b", 5, 8)] }),
    ).toThrow();
    expect(
      studioMusicSchema.parse({ blocks: [block("a", 0, 5), block("b", 5, null)] }).blocks,
    ).toHaveLength(2);
  });

  test("block ids must be unique", () => {
    expect(() =>
      studioMusicSchema.parse({ blocks: [block("a", 0, 2), block("a", 3, 5)] }),
    ).toThrow();
  });

  test("caps the lane at STUDIO_EDIT_LIMITS.musicBlocks", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        block(`m${index}`, index * 2, index * 2 + 1),
      );
    expect(
      studioMusicSchema.parse({ blocks: many(STUDIO_EDIT_LIMITS.musicBlocks) }).blocks,
    ).toHaveLength(STUDIO_EDIT_LIMITS.musicBlocks);
    expect(() =>
      studioMusicSchema.parse({ blocks: many(STUDIO_EDIT_LIMITS.musicBlocks + 1) }),
    ).toThrow();
  });

  test("exposes a positive minimum block length", () => {
    expect(MUSIC_BLOCK_MIN_DURATION_SEC).toBeGreaterThan(0);
  });

  describe("studioEditsEqual over music blocks", () => {
    const withBlocks = (blocks: unknown[], ducking = false) =>
      studioEditsSchema.parse({ music: { blocks, ducking } });

    test("equal for separately allocated identical lanes", () => {
      const left = withBlocks([block("a", 0, 5), block("b", 5, null)]);
      const right = withBlocks([block("a", 0, 5), block("b", 5, null)]);
      expect(studioEditsEqual(left, right)).toBe(true);
    });

    test("detects a change in every block field and in ducking", () => {
      const base = withBlocks([block("a", 0, 5, { assetId: MUSIC_ASSET_ID })]);
      const variants: Record<string, unknown>[] = [
        { id: "z" },
        { assetId: null },
        { url: "https://cdn.example/other.mp3" },
        { title: "Other" },
        { startSec: 1 },
        { endSec: 6 },
        { endSec: null },
        { sourceStartSec: 2 },
        { volume: 50 },
        { fadeInSec: 1 },
        { fadeOutSec: 1 },
      ];
      for (const variant of variants) {
        const other = withBlocks([block("a", 0, 5, { assetId: MUSIC_ASSET_ID, ...variant })]);
        expect(studioEditsEqual(base, other)).toBe(false);
      }
      expect(studioEditsEqual(base, withBlocks(base.music.blocks, true))).toBe(false);
    });

    test("detects an added or removed block", () => {
      const one = withBlocks([block("a", 0, 5)]);
      const two = withBlocks([block("a", 0, 5), block("b", 5, null)]);
      expect(studioEditsEqual(one, two)).toBe(false);
      expect(studioEditsEqual(two, withBlocks([]))).toBe(false);
    });
  });

  test("accepts a well-formed sfx placement with default volume/title", () => {
    const parsed = studioSfxPlacementSchema.parse({
      id: "sfx-1",
      assetId: "3f3e3d3c-3b3a-4939-8837-363534333231",
      startSec: 4.5,
    });
    expect(parsed).toEqual({
      id: "sfx-1",
      assetId: "3f3e3d3c-3b3a-4939-8837-363534333231",
      title: null,
      startSec: 4.5,
      volume: 80,
    });
  });

  test("rejects an sfx placement with a non-uuid assetId, negative startSec, or out-of-range volume", () => {
    expect(() =>
      studioSfxPlacementSchema.parse({
        id: "sfx-1",
        assetId: "not-a-uuid",
        startSec: 0,
      }),
    ).toThrow();
    expect(() =>
      studioSfxPlacementSchema.parse({
        id: "sfx-1",
        assetId: "3f3e3d3c-3b3a-4939-8837-363534333231",
        startSec: -1,
      }),
    ).toThrow();
    expect(() =>
      studioSfxPlacementSchema.parse({
        id: "sfx-1",
        assetId: "3f3e3d3c-3b3a-4939-8837-363534333231",
        startSec: 0,
        volume: 101,
      }),
    ).toThrow();
  });

  test("studioEditsSchema.sfx caps at 20 placements", () => {
    const sfx = Array.from({ length: 21 }, (_, index) => ({
      id: `sfx-${index}`,
      assetId: "3f3e3d3c-3b3a-4939-8837-363534333231",
      startSec: index,
    }));
    expect(() => studioEditsSchema.parse({ sfx })).toThrow();
    expect(() =>
      studioEditsSchema.parse({ sfx: sfx.slice(0, 20) }),
    ).not.toThrow();
  });
});

describe("computeSpeechWindows (auto-ducking v1)", () => {
  test("returns [] for no words", () => {
    expect(computeSpeechWindows([], 30)).toEqual([]);
  });

  test("returns [] for a non-positive clip duration", () => {
    expect(computeSpeechWindows([{ startSec: 1, endSec: 2 }], 0)).toEqual([]);
  });

  test("pads a single word by padSec on both sides", () => {
    const windows = computeSpeechWindows([{ startSec: 5, endSec: 6 }], 30);
    expect(windows).toEqual([
      { startSec: 5 - DUCKING_DEFAULTS.padSec, endSec: 6 + DUCKING_DEFAULTS.padSec },
    ]);
  });

  test("merges words closer together than mergeGapSec into one window", () => {
    // Gap between word 1's end (2) and word 2's start (2.2) is 0.2s, well
    // under the default 0.45s mergeGapSec once padding is applied.
    const windows = computeSpeechWindows(
      [
        { startSec: 1, endSec: 2 },
        { startSec: 2.2, endSec: 3 },
      ],
      30,
    );
    expect(windows.length).toBe(1);
    expect(windows[0].startSec).toBeCloseTo(1 - DUCKING_DEFAULTS.padSec, 5);
    expect(windows[0].endSec).toBeCloseTo(3 + DUCKING_DEFAULTS.padSec, 5);
  });

  test("keeps far-apart words as separate windows", () => {
    const windows = computeSpeechWindows(
      [
        { startSec: 1, endSec: 2 },
        { startSec: 10, endSec: 11 },
      ],
      30,
    );
    expect(windows.length).toBe(2);
  });

  test("clamps padding at 0 and at the clip duration", () => {
    const windows = computeSpeechWindows(
      [{ startSec: 0.05, endSec: 29.95 }],
      30,
    );
    expect(windows).toEqual([{ startSec: 0, endSec: 30 }]);
  });
});

describe("duckingGainMultiplierAt (auto-ducking v1)", () => {
  const window = { startSec: 10, endSec: 12 };

  test("returns 1 for empty windows", () => {
    expect(duckingGainMultiplierAt(10, [])).toBe(1);
  });

  test("returns 1 well outside any window", () => {
    expect(duckingGainMultiplierAt(0, [window])).toBe(1);
  });

  test("returns duckedGainFraction fully inside a window", () => {
    expect(duckingGainMultiplierAt(11, [window])).toBe(
      DUCKING_DEFAULTS.duckedGainFraction,
    );
    expect(duckingGainMultiplierAt(10, [window])).toBe(
      DUCKING_DEFAULTS.duckedGainFraction,
    );
    expect(duckingGainMultiplierAt(12, [window])).toBe(
      DUCKING_DEFAULTS.duckedGainFraction,
    );
  });

  test("ramps down across the attack window before the window starts", () => {
    const attackStart = window.startSec - DUCKING_DEFAULTS.attackSec;
    expect(duckingGainMultiplierAt(attackStart, [window])).toBeCloseTo(1, 5);
    const mid = attackStart + DUCKING_DEFAULTS.attackSec / 2;
    const midValue = duckingGainMultiplierAt(mid, [window]);
    expect(midValue).toBeGreaterThan(DUCKING_DEFAULTS.duckedGainFraction);
    expect(midValue).toBeLessThan(1);
  });

  test("ramps up across the release window after the window ends", () => {
    const releaseEnd = window.endSec + DUCKING_DEFAULTS.releaseSec;
    expect(duckingGainMultiplierAt(releaseEnd, [window])).toBeCloseTo(1, 5);
    const mid = window.endSec + DUCKING_DEFAULTS.releaseSec / 2;
    const midValue = duckingGainMultiplierAt(mid, [window]);
    expect(midValue).toBeGreaterThan(DUCKING_DEFAULTS.duckedGainFraction);
    expect(midValue).toBeLessThan(1);
  });

  test("adjacent windows take the minimum multiplier in overlapping ramp regions", () => {
    // Second window starts before the first window's release ramp finishes,
    // so at a point in the overlap the correct answer is the quieter
    // (lower) of the two candidate multipliers, not either one alone.
    const first = { startSec: 0, endSec: 2 };
    const second = { startSec: 2.2, endSec: 4 };
    const t = 2.1; // inside first's release ramp AND second's attack ramp
    const expected = Math.min(
      duckingGainMultiplierAt(t, [first]),
      duckingGainMultiplierAt(t, [second]),
    );
    expect(duckingGainMultiplierAt(t, [first, second])).toBeCloseTo(
      expected,
      10,
    );
    expect(duckingGainMultiplierAt(t, [first, second])).toBeLessThanOrEqual(
      expected + 1e-9,
    );
  });
});

// M1+M2 (vizard-parity.md "Music/SFX library"): moved from the worker-only
// ducking.test.ts — capDuckingWindows and extractSpeechWordIntervals are now
// shared by the worker's render-time volume automation AND the studio
// preview's live gain node, so their tests live where the shared code does.
describe("capDuckingWindows", () => {
  test("is a no-op at or under the cap", () => {
    const windows: DuckingWindow[] = [
      { startSec: 0, endSec: 1 },
      { startSec: 2, endSec: 3 },
    ];
    expect(capDuckingWindows(windows)).toEqual(windows);
    expect(capDuckingWindows(windows, 2)).toEqual(windows);
  });

  test("merges the smallest-gap pair repeatedly until at most maxWindows remain", () => {
    // 10 windows, each 0.5s long, spaced with a mix of gaps — smallest gaps
    // (0.1s) sit between windows 2-3 and 5-6.
    const windows: DuckingWindow[] = [
      { startSec: 0, endSec: 0.5 },
      { startSec: 1, endSec: 1.5 }, // gap to next: 0.1 (smallest)
      { startSec: 1.6, endSec: 2.1 },
      { startSec: 3, endSec: 3.5 },
      { startSec: 4.5, endSec: 5 }, // gap to next: 0.1 (smallest, tied)
      { startSec: 5.1, endSec: 5.6 },
      { startSec: 7, endSec: 7.5 },
      { startSec: 9, endSec: 9.5 },
    ];
    const capped = capDuckingWindows(windows, 6);
    expect(capped.length).toBe(6);
    // Every original window's span must still be covered by SOME merged
    // window — merging must never drop a speech moment.
    for (const original of windows) {
      const covered = capped.some(
        (merged) =>
          merged.startSec <= original.startSec &&
          merged.endSec >= original.endSec,
      );
      expect(covered).toBe(true);
    }
  });

  test("caps a large window count down to MAX_DUCKING_WINDOWS by default", () => {
    const windows: DuckingWindow[] = Array.from({ length: 60 }, (_, i) => ({
      startSec: i * 2,
      endSec: i * 2 + 0.3,
    }));
    const capped = capDuckingWindows(windows);
    expect(capped.length).toBe(MAX_DUCKING_WINDOWS);
  });
});

describe("extractSpeechWordIntervals", () => {
  test("no timeMap: subtracts clipStartSec directly (byte-identical to caption remap's uncut path)", () => {
    const utterances = [makeUtterance([["hello", 100, 100.5], ["world", 100.5, 101]])];
    const intervals = extractSpeechWordIntervals(utterances, 100, null);
    expect(intervals).toEqual([
      { startSec: 0, endSec: 0.5 },
      { startSec: 0.5, endSec: 1 },
    ]);
  });

  test("falls back to utterance-level interval when a transcript has no per-word timings", () => {
    const utterance: TranscriptUtterance = {
      index: 0,
      speaker: 0,
      speakerLabel: "Speaker 1",
      startSec: 100,
      endSec: 102,
      text: "hello world",
      confidence: 0.9,
      words: [],
    };
    const intervals = extractSpeechWordIntervals([utterance], 100, null);
    expect(intervals).toEqual([{ startSec: 0, endSec: 2 }]);
  });
});

// M1+M2 parity: both consumers (the worker's render-time volume automation
// and the studio preview's live gain node) are required to compose the SAME
// three functions in the SAME order — extract -> compute -> cap — with no
// consumer-specific fallback logic of its own. This fixture (word-less
// utterances) is the exact case that used to fork: the preview's old inline
// `utterances.flatMap(u => u.words)` produced zero intervals (and thus no
// ducking) for a word-less transcript, while the worker's copy of
// `extractSpeechWordIntervals` already had the utterance-level fallback and
// ducked normally. Composing the shared pipeline the same way from any call
// site must always produce identical windows.
describe("ducking pipeline parity (M1+M2 — extract -> compute -> cap shared by worker and preview)", () => {
  test("word-less utterances produce identical windows via the shared pipeline regardless of call site", () => {
    const utterances: TranscriptUtterance[] = [
      {
        index: 0,
        speaker: 0,
        speakerLabel: "Speaker 1",
        startSec: 2,
        endSec: 4,
        text: "hello world",
        confidence: 0.9,
        words: [],
      },
      {
        index: 1,
        speaker: 0,
        speakerLabel: "Speaker 1",
        startSec: 5,
        endSec: 7,
        text: "goodbye now",
        confidence: 0.9,
        words: [],
      },
    ];
    const clipStartSec = 0;
    const clipDurationSec = 10;

    const runPipeline = () =>
      capDuckingWindows(
        computeSpeechWindows(
          extractSpeechWordIntervals(utterances, clipStartSec, null),
          clipDurationSec,
        ),
      );

    const fromWorkerCallSite = runPipeline();
    const fromPreviewCallSite = runPipeline();

    expect(fromWorkerCallSite).toEqual(fromPreviewCallSite);
    // Sanity: word-less utterances actually produced non-empty ducking
    // windows (the bug this guards against: zero windows == no ducking).
    expect(fromWorkerCallSite.length).toBeGreaterThan(0);
  });
});

describe("applyStudioEditsToAllSchema (bulk apply request body)", () => {
  test("excludeClipId is optional", () => {
    const patch = { transition: { type: "dip-white" as const, durationSec: 0.4 } };
    const parsed = applyStudioEditsToAllSchema.parse({
      patch,
    });
    expect(parsed.excludeClipId).toBeUndefined();
    expect(parsed.patches).toEqual([patch]);
  });

  test("accepts one coherent grouped layout request", () => {
    const parsed = applyStudioEditsToAllSchema.parse({
      patches: [
        { background: { mode: "off", color: null, imageUrl: null } },
        { framing: { mode: "center" } },
      ],
    });
    expect(parsed.patches).toHaveLength(2);
  });

  test("rejects duplicate fields and mixed single/grouped requests", () => {
    expect(() =>
      applyStudioEditsToAllSchema.parse({
        patches: [
          { framing: { mode: "auto" } },
          { framing: { mode: "center" } },
        ],
      }),
    ).toThrow();
    expect(() =>
      applyStudioEditsToAllSchema.parse({
        patch: { framing: { mode: "auto" } },
        patches: [{ background: { mode: "off" } }],
      }),
    ).toThrow();
  });

  test("accepts a well-formed excludeClipId", () => {
    const parsed = applyStudioEditsToAllSchema.parse({
      patch: { background: { mode: "off", color: null, imageUrl: null } },
      excludeClipId: "3f3e3d3c-3b3a-4939-8837-363534333231",
    });
    expect(parsed.excludeClipId).toBe("3f3e3d3c-3b3a-4939-8837-363534333231");
  });

  test("rejects a non-uuid excludeClipId", () => {
    expect(() =>
      applyStudioEditsToAllSchema.parse({
        patch: { transition: { type: "none", durationSec: 0.4 } },
        excludeClipId: "not-a-uuid",
      }),
    ).toThrow();
  });
});

describe("studioEdits.captionEmphasis", () => {
  test("is absent by default and keeps overrides by Word Key", () => {
    expect(studioEditsSchema.parse({}).captionEmphasis).toBeUndefined();
    const parsed = studioEditsSchema.parse({ captionEmphasis: { "1200": "hero", "1500": "pair", "1800": "plain" } });
    expect(parsed.captionEmphasis).toEqual({ "1200": "hero", "1500": "pair", "1800": "plain" });
  });

  test("rejects unknown values, keys that are not whole milliseconds, and more than 2,000 entries", () => {
    expect(studioEditsSchema.safeParse({ captionEmphasis: { "1200": "big" } }).success).toBe(false);
    expect(studioEditsSchema.safeParse({ captionEmphasis: { "1.2": "hero" } }).success).toBe(false);
    expect(studioEditsSchema.safeParse({ captionEmphasis: { "-5": "hero" } }).success).toBe(false);
    const entries = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index), "plain"]));
    expect(studioEditsSchema.safeParse({ captionEmphasis: entries(2000) }).success).toBe(true);
    expect(studioEditsSchema.safeParse({ captionEmphasis: entries(2001) }).success).toBe(false);
  });

  test("studioEditsEqual compares it, treating absent and empty alike", () => {
    const base = studioEditsSchema.parse({});
    const hero = studioEditsSchema.parse({ captionEmphasis: { "1200": "hero" } });
    expect(studioEditsEqual(base, studioEditsSchema.parse({ captionEmphasis: {} }))).toBe(true);
    expect(studioEditsEqual(base, hero)).toBe(false);
    expect(studioEditsEqual(hero, studioEditsSchema.parse({ captionEmphasis: { "1200": "pair" } }))).toBe(false);
    expect(studioEditsEqual(hero, studioEditsSchema.parse({ captionEmphasis: { "1300": "hero" } }))).toBe(false);
    expect(studioEditsEqual(hero, studioEditsSchema.parse({ captionEmphasis: { "1200": "hero" } }))).toBe(true);
  });

  test("stays per clip: the apply-to-all patch cannot carry it", () => {
    expect(applyStudioEditsPatchSchema.safeParse({ captionEmphasis: { "1200": "hero" } }).success).toBe(false);
  });
});

describe("studioEdits.captionEmojis", () => {
  test("is absent by default and keeps emojis by Word Key", () => {
    expect(studioEditsSchema.parse({}).captionEmojis).toBeUndefined();
    const parsed = studioEditsSchema.parse({ captionEmojis: { "1200": { id: "fire" }, "1500": { id: "thumbs-up", tone: 2 } } });
    expect(parsed.captionEmojis).toEqual({ "1200": { id: "fire" }, "1500": { id: "thumbs-up", tone: 2 } });
    expect(studioEditsSchema.safeParse({ captionEmojis: { "1200": { id: "fire", tone: 9 } } }).success).toBe(false);
  });

  test("withCaptionEmojis sets and removes entries, stores empty as absent and refuses more than 500", () => {
    const base = studioEditsSchema.parse({});
    const one = withCaptionEmojis(base, { "1200": { id: "fire" } })!;
    expect(one.captionEmojis).toEqual({ "1200": { id: "fire" } });
    expect(base.captionEmojis).toBeUndefined();
    const cleared = withCaptionEmojis(one, { "1200": null })!;
    expect("captionEmojis" in cleared).toBe(false);
    const full = withCaptionEmojis(base, Object.fromEntries(Array.from({ length: 500 }, (_, index) => [String(index), { id: "fire" }])))!;
    expect(withCaptionEmojis(full, { "9000": { id: "fire" } })).toBeNull();
    expect(withCaptionEmojis(full, { "0": null, "9000": { id: "fire" } })).not.toBeNull();
  });

  test("studioEditsEqual compares id and tone, treating absent and empty alike", () => {
    const base = studioEditsSchema.parse({});
    const fire = studioEditsSchema.parse({ captionEmojis: { "1200": { id: "fire" } } });
    expect(studioEditsEqual(base, studioEditsSchema.parse({ captionEmojis: {} }))).toBe(true);
    expect(studioEditsEqual(base, fire)).toBe(false);
    expect(studioEditsEqual(fire, studioEditsSchema.parse({ captionEmojis: { "1200": { id: "fire" } } }))).toBe(true);
    expect(studioEditsEqual(fire, studioEditsSchema.parse({ captionEmojis: { "1200": { id: "rocket" } } }))).toBe(false);
    expect(studioEditsEqual(fire, studioEditsSchema.parse({ captionEmojis: { "1200": { id: "fire", tone: 1 } } }))).toBe(false);
    expect(studioEditsEqual(fire, studioEditsSchema.parse({ captionEmojis: { "1300": { id: "fire" } } }))).toBe(false);
  });

  test("stays per clip: the apply-to-all patch cannot carry it", () => {
    expect(applyStudioEditsPatchSchema.safeParse({ captionEmojis: { "1200": { id: "fire" } } }).success).toBe(false);
  });
});
