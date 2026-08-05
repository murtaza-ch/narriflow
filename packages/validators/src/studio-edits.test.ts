import { describe, expect, test } from "bun:test";

import {
  applyStudioEditsPatchSchema,
  applyStudioEditsToAllSchema,
  resolveMusicFadeWindows,
  studioEditsSchema,
} from "./studio-edits";

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
  });

  test("rejects a patch with both fields", () => {
    expect(() =>
      applyStudioEditsPatchSchema.parse({
        transition: { type: "fade", durationSec: 0.4 },
        background: { mode: "off", color: null, imageUrl: null },
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
