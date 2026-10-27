import { describe, expect, test } from "bun:test";
import { studioEditsSchema } from "@narriflow/validators";
import { seedBrandMusic } from "./clip.service";

const MUSIC_A = "b2f1b0c4-7a33-4c25-9d54-1ef3a8c1a001";
const MUSIC_B = "b2f1b0c4-7a33-4c25-9d54-1ef3a8c1a002";
const SFX_A = "b2f1b0c4-7a33-4c25-9d54-1ef3a8c1a003";

const snapshot = (audio: unknown) => ({
  version: 1,
  profileId: "4d119c8d-acde-4d95-82a4-0e61210e61db",
  profileRevision: 2,
  name: "Northstar",
  identity: {},
  voice: {},
  approvalRule: "none",
  style: null,
  audio,
});
const withMusic = snapshot({
  music: [
    { assetId: MUSIC_A, title: "Theme", durationSec: 90 },
    { assetId: MUSIC_B, title: "Second", durationSec: 60 },
  ],
  sfx: [{ assetId: SFX_A, title: "Whoosh", durationSec: 1 }],
});

describe("seedBrandMusic", () => {
  const blank = () => studioEditsSchema.parse(undefined);

  test("seeds the profile's first music track with the Studio's own defaults", () => {
    const seeded = seedBrandMusic(blank(), withMusic);
    expect(seeded.music).toEqual({ ...blank().music, assetId: MUSIC_A, title: "Theme", url: null });
    expect(studioEditsSchema.parse(seeded)).toEqual(seeded);
    expect(seeded.sfx).toEqual([]);
  });

  test("never replaces a clip's own music", () => {
    const chosen = { ...blank(), music: { ...blank().music, assetId: MUSIC_B, title: "Mine" } };
    expect(seedBrandMusic(chosen, withMusic)).toBe(chosen);
    const pasted = { ...blank(), music: { ...blank().music, url: "https://example.test/song.mp3" } };
    expect(seedBrandMusic(pasted, withMusic)).toBe(pasted);
  });

  test("leaves clips alone without brand music", () => {
    const edits = blank();
    expect(seedBrandMusic(edits, null)).toBe(edits);
    expect(seedBrandMusic(edits, snapshot({ music: [], sfx: [{ assetId: SFX_A, title: "Whoosh", durationSec: 1 }] }))).toBe(edits);
    expect(seedBrandMusic(edits, { not: "a snapshot" })).toBe(edits);
  });
});
