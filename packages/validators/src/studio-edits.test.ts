import { describe, expect, test } from "bun:test";

import { studioEditsSchema } from "./studio-edits";

describe("studioEditsSchema (source audio + music fades)", () => {
  test("parse({}) defaults sourceAudio to unmuted 100 and music fades to 0", () => {
    const parsed = studioEditsSchema.parse({});
    expect(parsed.sourceAudio).toEqual({ volume: 100, muted: false });
    expect(parsed.music.fadeInSec).toBe(0);
    expect(parsed.music.fadeOutSec).toBe(0);
  });

  test("parse(undefined) applies the same defaults as parse({})", () => {
    const parsed = studioEditsSchema.parse(undefined);
    expect(parsed.sourceAudio).toEqual({ volume: 100, muted: false });
    expect(parsed.music.fadeInSec).toBe(0);
    expect(parsed.music.fadeOutSec).toBe(0);
  });

  test("legacy persisted JSON (no sourceAudio, no music fades) parses to full defaults", () => {
    // Shape stored before this change landed — no `sourceAudio` key at all,
    // and `music` missing `fadeInSec`/`fadeOutSec`.
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
