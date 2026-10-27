import { describe, expect, test } from "bun:test";
import { brandProfileSnapshotSchema, DEFAULT_CAPTION_PRESET } from "@narriflow/validators";
import {
  brandAudioSnapshot,
  buildBrandProfileSnapshot,
  resolveProfileStyleSelection,
} from "./brand-profile.service";

const profile = {
  id: "4d119c8d-acde-4d95-82a4-0e61210e61db",
  name: "Northstar",
  revision: 3,
  visualIdentity: { primaryColor: "#102A43" },
  voiceGuidance: { tone: ["warm"] },
  approvalRule: "approval_required",
};

const template = {
  id: "e521bff1-8f56-43da-9868-1adf1d42dc5d",
  captionPreset: DEFAULT_CAPTION_PRESET,
  logoStorageKey: "brands/logo.png",
  logoPosition: "bot-right",
  logoOpacity: 80,
  logoScalePct: 15,
  primaryColor: "#102A43",
  secondaryColor: "#F0B429",
  accentColor: null,
};

describe("Brand Profile project resolution", () => {
  test("freezes versioned identity and the selected style preset", () => {
    expect(buildBrandProfileSnapshot(profile, template, brandAudioSnapshot([]))).toMatchObject({
      version: 1,
      profileId: "4d119c8d-acde-4d95-82a4-0e61210e61db",
      profileRevision: 3,
      name: "Northstar",
      style: { templateId: "e521bff1-8f56-43da-9868-1adf1d42dc5d" },
    });
  });

  test("explicit profile selection requires the optional template to be a member", () => {
    expect(resolveProfileStyleSelection({ requestedTemplateId: null, defaultTemplateId: "e521bff1-8f56-43da-9868-1adf1d42dc5d", memberTemplateIds: ["e521bff1-8f56-43da-9868-1adf1d42dc5d"] })).toBe("e521bff1-8f56-43da-9868-1adf1d42dc5d");
    expect(() => resolveProfileStyleSelection({ requestedTemplateId: "other", defaultTemplateId: "e521bff1-8f56-43da-9868-1adf1d42dc5d", memberTemplateIds: ["e521bff1-8f56-43da-9868-1adf1d42dc5d"] })).toThrow();
  });
});

const track = (id: string, kind: "music" | "sfx", title: string, deletedAt: Date | null = null) => ({
  audio: { id, kind, title, durationSec: 12.5, deletedAt },
});
const MUSIC_A = "b2f1b0c4-7a33-4c25-9d54-1ef3a8c1a001";
const MUSIC_B = "b2f1b0c4-7a33-4c25-9d54-1ef3a8c1a002";
const SFX_A = "b2f1b0c4-7a33-4c25-9d54-1ef3a8c1a003";

describe("Brand Profile audio snapshot", () => {
  test("splits live tracks by kind in attachment order and drops deleted ones", () => {
    const audio = brandAudioSnapshot([
      track(MUSIC_A, "music", "Theme"),
      track(SFX_A, "sfx", "Whoosh"),
      track(MUSIC_B, "music", "Gone", new Date()),
    ]);
    expect(audio).toEqual({
      music: [{ assetId: MUSIC_A, title: "Theme", durationSec: 12.5 }],
      sfx: [{ assetId: SFX_A, title: "Whoosh", durationSec: 12.5 }],
    });
  });

  test("keeps titles inside the snapshot contract", () => {
    const audio = brandAudioSnapshot([
      track(MUSIC_A, "music", "  "),
      track(MUSIC_B, "music", "x".repeat(300)),
    ]);
    expect(audio.music.map((entry) => entry.title.length)).toEqual([8, 120]);
  });

  test("is frozen into the Project snapshot, which parses back; a profile with no audio freezes empty lists", () => {
    const audio = brandAudioSnapshot([track(MUSIC_A, "music", "Theme")]);
    const snapshot = buildBrandProfileSnapshot(profile, template, audio);
    expect(brandProfileSnapshotSchema.parse(snapshot).audio).toEqual(audio);
    const { audio: _omitted, ...withoutAudio } = snapshot;
    expect(brandProfileSnapshotSchema.safeParse(withoutAudio).success).toBe(false);
    expect(buildBrandProfileSnapshot(profile, template, brandAudioSnapshot([])).audio).toEqual({ music: [], sfx: [] });
  });
});
