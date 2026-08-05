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
  resolveEffectiveFramingMode,
  resolveMusicFadeWindows,
  studioEditsSchema,
  studioSfxPlacementSchema,
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
  test("parse({}) defaults sourceAudio to unmuted 100 and music fades to 0", () => {
    const parsed = studioEditsSchema.parse({});
    expect(parsed.sourceAudio).toEqual({ volume: 100, muted: false });
    expect(parsed.music.fadeInSec).toBe(0);
    expect(parsed.music.fadeOutSec).toBe(0);
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
    expect(parsed.music.fadeInSec).toBe(0);
    expect(parsed.music.fadeOutSec).toBe(0);
    expect(parsed.logo).toEqual({
      enabled: true,
      position: null,
      opacity: null,
      scalePct: null,
    });
  });

  test("legacy persisted JSON (no sourceAudio, no music fades, no logo) parses to full defaults", () => {
    // Shape stored before this change landed — no `sourceAudio` key at all,
    // and `music` missing `fadeInSec`/`fadeOutSec`, no `logo` key at all.
    const legacy = {
      textLayers: [],
      transition: { type: "fade", durationSec: 0.5 },
      music: {
        url: "https://cdn.example/track.mp3",
        title: "Background bed",
        volume: 42,
        startOffsetSec: 8,
      },
    };

    const parsed = studioEditsSchema.parse(legacy);

    expect(parsed.sourceAudio).toEqual({ volume: 100, muted: false });
    expect(parsed.music.url).toBe("https://cdn.example/track.mp3");
    expect(parsed.music.volume).toBe(42);
    expect(parsed.music.startOffsetSec).toBe(8);
    expect(parsed.music.fadeInSec).toBe(0);
    expect(parsed.music.fadeOutSec).toBe(0);
    expect(parsed.transition).toEqual({ type: "fade", durationSec: 0.5 });
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

  test("legacy persisted JSON (no background key at all) parses to the off default", () => {
    const legacy = {
      textLayers: [],
      transition: { type: "none", durationSec: 0.4 },
    };
    const parsed = studioEditsSchema.parse(legacy);
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

  test("accepts explicit sourceAudio and music fade values within range", () => {
    const parsed = studioEditsSchema.parse({
      sourceAudio: { volume: 60, muted: true },
      music: {
        url: "https://cdn.example/track.mp3",
        title: null,
        volume: 50,
        startOffsetSec: 0,
        fadeInSec: 2,
        fadeOutSec: 3,
      },
    });

    expect(parsed.sourceAudio).toEqual({ volume: 60, muted: true });
    expect(parsed.music.fadeInSec).toBe(2);
    expect(parsed.music.fadeOutSec).toBe(3);
  });

  test("rejects out-of-range sourceAudio volume and music fade values", () => {
    expect(() =>
      studioEditsSchema.parse({ sourceAudio: { volume: 101, muted: false } }),
    ).toThrow();
    expect(() =>
      studioEditsSchema.parse({
        music: {
          url: null,
          title: null,
          volume: 35,
          startOffsetSec: 0,
          fadeInSec: 6,
        },
      }),
    ).toThrow();
  });

  test("parse({}) defaults framing to auto", () => {
    const parsed = studioEditsSchema.parse({});
    expect(parsed.framing).toEqual({ mode: "auto" });
  });

  test("legacy persisted JSON (no framing key at all) parses to the auto default — spurious-dirty guard", () => {
    // Same shape a document saved before this feature landed would have —
    // this must parse identically to a freshly-defaulted document so an
    // old clip doesn't appear dirty on load just because `framing` is new.
    const legacy = {
      textLayers: [],
      transition: { type: "none", durationSec: 0.4 },
      background: { mode: "off", color: null, imageUrl: null },
    };
    const parsed = studioEditsSchema.parse(legacy);
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

  test("legacy persisted JSON (no framing key at all) still parses to auto, unaffected by split's addition", () => {
    const legacy = {
      textLayers: [],
      transition: { type: "none", durationSec: 0.4 },
      background: { mode: "off", color: null, imageUrl: null },
    };
    const parsed = studioEditsSchema.parse(legacy);
    expect(parsed.framing).toEqual({ mode: "auto" });
  });

  test("accepts an explicit screen framing mode", () => {
    const parsed = studioEditsSchema.parse({ framing: { mode: "screen" } });
    expect(parsed.framing).toEqual({ mode: "screen" });
  });

  test("legacy persisted JSON (no framing key at all) still parses to auto, unaffected by screen's addition", () => {
    const legacy = {
      textLayers: [],
      transition: { type: "none", durationSec: 0.4 },
      background: { mode: "off", color: null, imageUrl: null },
    };
    const parsed = studioEditsSchema.parse(legacy);
    expect(parsed.framing).toEqual({ mode: "auto" });
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
        music: { url: null, title: null, volume: 35, startOffsetSec: 0, fadeInSec: 0, fadeOutSec: 0 },
      }),
    ).toThrow();
  });
});

describe("studioMusicSchema assetId/ducking + studioSfxPlacementSchema (Music/SFX library)", () => {
  test("parse({}) defaults music.assetId to null, ducking to false, and sfx to []", () => {
    const parsed = studioEditsSchema.parse({});
    expect(parsed.music.assetId).toBeNull();
    expect(parsed.music.ducking).toBe(false);
    expect(parsed.sfx).toEqual([]);
  });

  test("legacy persisted JSON (no assetId/ducking/sfx keys at all) parses to full defaults", () => {
    const legacy = {
      textLayers: [],
      transition: { type: "none", durationSec: 0.4 },
      music: {
        url: "https://cdn.example/track.mp3",
        title: "Background bed",
        volume: 42,
        startOffsetSec: 8,
        fadeInSec: 0,
        fadeOutSec: 0,
      },
    };
    const parsed = studioEditsSchema.parse(legacy);
    expect(parsed.music.assetId).toBeNull();
    expect(parsed.music.ducking).toBe(false);
    expect(parsed.music.url).toBe("https://cdn.example/track.mp3");
    expect(parsed.sfx).toEqual([]);
  });

  test("accepts an explicit assetId + ducking on music", () => {
    const parsed = studioEditsSchema.parse({
      music: {
        url: null,
        title: null,
        volume: 35,
        startOffsetSec: 0,
        fadeInSec: 0,
        fadeOutSec: 0,
        assetId: "3f3e3d3c-3b3a-4939-8837-363534333231",
        ducking: true,
      },
    });
    expect(parsed.music.assetId).toBe("3f3e3d3c-3b3a-4939-8837-363534333231");
    expect(parsed.music.ducking).toBe(true);
  });

  test("rejects a malformed music.assetId", () => {
    expect(() =>
      studioEditsSchema.parse({ music: { assetId: "not-a-uuid" } }),
    ).toThrow();
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
    const parsed = applyStudioEditsToAllSchema.parse({
      patch: { transition: { type: "dip-white", durationSec: 0.4 } },
    });
    expect(parsed.excludeClipId).toBeUndefined();
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
