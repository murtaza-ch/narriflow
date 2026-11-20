import { describe, expect, test } from "bun:test";
import { AUDIO_ART_COLORS, audioArt, hashAudioAssetId } from "./audio-art";

const IDS = Array.from({ length: 200 }, (_, index) => `0b1f6c2e-5a37-4d1c-9e${String(index).padStart(2, "0")}-3c6a1d9f${String(index * 7919).padStart(4, "0")}`);

describe("audioArt", () => {
  test("is deterministic for an id", () => {
    expect(audioArt(IDS[3] as string)).toEqual(audioArt(IDS[3] as string));
    expect(hashAudioAssetId("abc")).toBe(hashAudioAssetId("abc"));
  });

  test("uses only palette colors, never the same hue twice, and a CSS gradient", () => {
    for (const id of IDS) {
      const art = audioArt(id);
      expect(AUDIO_ART_COLORS).toContain(art.from);
      expect(AUDIO_ART_COLORS).toContain(art.to);
      expect(art.from).not.toBe(art.to);
      expect(art.background).toBe(`linear-gradient(${art.angle}deg, ${art.from}, ${art.to})`);
    }
  });

  test("spreads ids across many distinct covers", () => {
    const covers = new Set(IDS.map((id) => audioArt(id).background));
    expect(covers.size).toBeGreaterThan(20);
  });
});
