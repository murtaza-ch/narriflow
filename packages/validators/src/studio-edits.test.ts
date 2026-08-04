import { describe, expect, test } from "bun:test";

import { resolveMusicFadeWindows, studioEditsSchema } from "./studio-edits";

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
