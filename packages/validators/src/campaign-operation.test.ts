import { describe, expect, test } from "bun:test";

import {
  applyProjectBrandProfileSelectedSchema,
  applyStyleSelectedSchema,
  applyMotionSelectedSchema,
  campaignOperationActionSchema,
  previewCampaignEditorActionSchema,
} from "./campaign-operation";

const clipId = "10000000-0000-4000-8000-000000000001";

describe("applyMotionSelectedSchema", () => {
  test.each([
    "none",
    "fade",
    "fade-black",
    "dip-white",
    "cross-dissolve",
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
  ] as const)("accepts Studio transition %s without translating it", (type) => {
    const parsed = applyMotionSelectedSchema.parse({
      change: {
        scope: "clip_transition",
        transition: { type, durationSec: 0.4 },
      },
      clips: [{ clipId, expectedEditorRevision: 7 }],
    });

    expect(parsed.change).toEqual({
      scope: "clip_transition",
      transition: { type, durationSec: 0.4 },
    });
  });

  test.each([
    ["fade", "fade"],
    ["scale-in", "scale-out"],
    ["pan-left", "pan-right"],
    ["pan-right", "pan-left"],
    ["pan-up", "pan-down"],
    ["pan-down", "pan-up"],
    ["ken-burns-in", "ken-burns-out"],
    ["none", "none"],
  ] as const)("accepts the Studio media-motion pair %s / %s", (entrance, exit) => {
    expect(
      applyMotionSelectedSchema.parse({
        change: { scope: "manual_broll", motion: { entrance, exit } },
        clips: [{ clipId, expectedEditorRevision: 0 }],
      }).change,
    ).toEqual({ scope: "manual_broll", motion: { entrance, exit } });
  });

  test("rejects aliases, arbitrary patches, and duplicate clip items", () => {
    expect(
      applyMotionSelectedSchema.safeParse({
        change: {
          scope: "clip_transition",
          transition: { type: "dissolve", durationSec: 0.4 },
        },
        clips: [{ clipId, expectedEditorRevision: 1 }],
      }).success,
    ).toBe(false);
    expect(
      applyMotionSelectedSchema.safeParse({
        change: { scope: "manual_broll", motion: { entrance: "bounce", exit: "none" } },
        clips: [{ clipId, expectedEditorRevision: 1 }],
      }).success,
    ).toBe(false);
    expect(
      applyMotionSelectedSchema.safeParse({
        change: { scope: "clip_transition", transition: { type: "fade", durationSec: 0.4 } },
        clips: [
          { clipId, expectedEditorRevision: 1 },
          { clipId, expectedEditorRevision: 2 },
        ],
      }).success,
    ).toBe(false);
  });

  test("registers apply_motion in the durable action vocabulary", () => {
    expect(campaignOperationActionSchema.parse("apply_motion")).toBe("apply_motion");
  });
});

describe("selection-scoped campaign styling schemas", () => {
  const fingerprint = "a".repeat(64);

  test("accepts only a frozen project profile fingerprint and revision-fenced clips", () => {
    expect(
      applyProjectBrandProfileSelectedSchema.parse({
        profileFingerprint: fingerprint,
        styleFingerprint: null,
        clips: [{ clipId, expectedEditorRevision: 7 }],
      }),
    ).toEqual({
      profileFingerprint: fingerprint,
      styleFingerprint: null,
      clips: [{ clipId, expectedEditorRevision: 7 }],
    });
    expect(
      applyProjectBrandProfileSelectedSchema.safeParse({
        profileId: "20000000-0000-4000-8000-000000000002",
        profileFingerprint: fingerprint,
        styleFingerprint: null,
        clips: [{ clipId, expectedEditorRevision: 7 }],
      }).success,
    ).toBe(false);
  });

  test("accepts one member style fingerprint and rejects duplicate clips", () => {
    const templateId = "20000000-0000-4000-8000-000000000002";
    expect(
      applyStyleSelectedSchema.parse({
        templateId,
        templateFingerprint: fingerprint,
        clips: [{ clipId, expectedEditorRevision: 0 }],
      }),
    ).toEqual({
      templateId,
      templateFingerprint: fingerprint,
      clips: [{ clipId, expectedEditorRevision: 0 }],
    });
    expect(
      applyStyleSelectedSchema.safeParse({
        templateId,
        templateFingerprint: fingerprint,
        clips: [
          { clipId, expectedEditorRevision: 0 },
          { clipId, expectedEditorRevision: 1 },
        ],
      }).success,
    ).toBe(false);
  });

  test("registers both document styling actions", () => {
    expect(campaignOperationActionSchema.parse("apply_brand_profile")).toBe(
      "apply_brand_profile",
    );
    expect(campaignOperationActionSchema.parse("apply_style")).toBe(
      "apply_style",
    );
  });

  test("preflights only the three bounded editor-document action shapes", () => {
    expect(
      previewCampaignEditorActionSchema.safeParse({
        action: "apply_style",
        input: {
          templateId: "20000000-0000-4000-8000-000000000002",
          templateFingerprint: fingerprint,
          clips: [{ clipId, expectedEditorRevision: 1 }],
        },
      }).success,
    ).toBe(true);
    expect(
      previewCampaignEditorActionSchema.safeParse({
        action: "arbitrary_patch",
        input: { patch: [{ op: "replace", path: "/captionPreset" }] },
      }).success,
    ).toBe(false);
  });
});
